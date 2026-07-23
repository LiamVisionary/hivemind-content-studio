// Client-side end-to-end encryption vault (WebCrypto).
//
// The passphrase-derived master key (MK) and the RSA private key live ONLY in
// this module's memory after unlock, never on the server. The server stores only
// the salt, MK sealed under the passphrase and under a recovery key, the RSA
// public key, and the RSA private key sealed under MK. See docs/E2E_ENCRYPTION_DESIGN.md.

const subtle = (globalThis.crypto && globalThis.crypto.subtle) || null;
const PBKDF2_ITERATIONS = 600_000;
const KDF = `PBKDF2-SHA256-${PBKDF2_ITERATIONS}`;

// ── in-memory session (cleared on lock) ──────────────────────────────────────
let masterKey = null;      // CryptoKey (AES-GCM 256), non-extractable after unlock
let privateKey = null;     // CryptoKey (RSA-OAEP private), non-extractable
let unlocked = false;

export function isVaultUnlocked() {
    return unlocked;
}

export function lockVault() {
    masterKey = null;
    privateKey = null;
    unlocked = false;
}

// ── encoding helpers ─────────────────────────────────────────────────────────
function toB64url(bytes) {
    let binary = '';
    const view = new Uint8Array(bytes);
    for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
    const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '==='.slice((padded.length + 3) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
}

const RECOVERY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC4648 base32
function encodeRecovery(bytes) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += RECOVERY_ALPHABET[(value << (5 - bits)) & 31];
    return out.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

function decodeRecovery(text) {
    const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const char of clean) {
        const idx = RECOVERY_ALPHABET.indexOf(char);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return new Uint8Array(out);
}

// ── low-level crypto ─────────────────────────────────────────────────────────
async function deriveWrappingKey(passphrase, saltBytes) {
    const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
        { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['wrapKey', 'unwrapKey'],
    );
}

async function importRecoveryKey(recoveryBytes) {
    // The recovery key's raw bytes are hashed into a stable AES-GCM key.
    const digest = await subtle.digest('SHA-256', recoveryBytes);
    return subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

async function wrapMasterKey(wrappingKey, keyToWrap) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await subtle.wrapKey('raw', keyToWrap, wrappingKey, { name: 'AES-GCM', iv });
    return `${toB64url(iv)}.${toB64url(wrapped)}`;
}

async function unwrapMasterKey(wrappingKey, blob) {
    const [ivPart, ctPart] = String(blob).split('.');
    // Extractable + unwrapKey usage so we can both re-import a hardened session
    // handle and unwrap the RSA private key from it.
    return subtle.unwrapKey(
        'raw', fromB64url(ctPart), wrappingKey, { name: 'AES-GCM', iv: fromB64url(ivPart) },
        { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'unwrapKey'],
    );
}

// ── setup / unlock ───────────────────────────────────────────────────────────
export async function createVaultIdentity(passphrase) {
    if (!subtle) throw new Error('WebCrypto unavailable');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const recoveryBytes = crypto.getRandomValues(new Uint8Array(20));
    const mk = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
    const keyPair = await subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);

    const passKey = await deriveWrappingKey(passphrase, salt);
    const recoveryKey = await importRecoveryKey(recoveryBytes);
    const publicSpki = await subtle.exportKey('spki', keyPair.publicKey);
    const wrappedPriv = await (async () => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const wrapped = await subtle.wrapKey('pkcs8', keyPair.privateKey, mk, { name: 'AES-GCM', iv });
        return `${toB64url(iv)}.${toB64url(wrapped)}`;
    })();

    const identity = {
        kdf: KDF,
        salt: toB64url(salt),
        wrapped_mk_pass: await wrapMasterKey(passKey, mk),
        wrapped_mk_recovery: await wrapMasterKey(recoveryKey, mk),
        public_key: toB64url(publicSpki),
        wrapped_private_key: wrappedPriv,
    };
    // Hold the session open immediately after setup.
    masterKey = await reimportForUse(mk);
    privateKey = keyPair.privateKey;
    unlocked = true;
    return { identity, recoveryKey: encodeRecovery(recoveryBytes) };
}

async function reimportForUse(extractableMk) {
    const raw = await subtle.exportKey('raw', extractableMk);
    return subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function loadPrivateKey(identity, mk) {
    const [ivPart, ctPart] = String(identity.wrapped_private_key).split('.');
    // mk here must allow unwrapKey; re-derive a wrapping-capable handle.
    const rawMk = await subtle.exportKey('raw', mk);
    const mkUnwrap = await subtle.importKey('raw', rawMk, { name: 'AES-GCM', length: 256 }, false, ['unwrapKey']);
    return subtle.unwrapKey(
        'pkcs8', fromB64url(ctPart), mkUnwrap, { name: 'AES-GCM', iv: fromB64url(ivPart) },
        { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt'],
    );
}

async function completeUnlock(identity, mkExtractable) {
    privateKey = await loadPrivateKey(identity, mkExtractable);
    masterKey = await reimportForUse(mkExtractable);
    unlocked = true;
}

export async function unlockWithPassphrase(identity, passphrase) {
    if (!subtle) throw new Error('WebCrypto unavailable');
    const passKey = await deriveWrappingKey(passphrase, fromB64url(identity.salt));
    let mk;
    try {
        mk = await unwrapMasterKey(passKey, identity.wrapped_mk_pass);
    } catch {
        return false; // wrong passphrase — GCM tag mismatch, no server oracle
    }
    await completeUnlock(identity, mk);
    return true;
}

export async function unlockWithRecoveryKey(identity, recoveryKeyText) {
    if (!subtle) throw new Error('WebCrypto unavailable');
    const recoveryKey = await importRecoveryKey(decodeRecovery(recoveryKeyText));
    let mk;
    try {
        mk = await unwrapMasterKey(recoveryKey, identity.wrapped_mk_recovery);
    } catch {
        return false;
    }
    await completeUnlock(identity, mk);
    return true;
}

// ── blob encryption (client-authored data) ───────────────────────────────────
export async function encryptJson(value) {
    if (!unlocked) throw new Error('Vault is locked');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, masterKey, plaintext);
    return `v1.${toB64url(iv)}.${toB64url(ct)}`;
}

export async function decryptJson(blob) {
    if (!unlocked) throw new Error('Vault is locked');
    const [version, ivPart, ctPart] = String(blob).split('.');
    if (version !== 'v1') throw new Error('Unknown vault blob version');
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(ivPart) }, masterKey, fromB64url(ctPart));
    return JSON.parse(new TextDecoder().decode(pt));
}

// ── media decryption (phase 2: server seals a DEK to our public key) ──────────
export async function decryptMedia(ciphertextB64, wrappedDekB64) {
    if (!unlocked) throw new Error('Vault is locked');
    const dekRaw = await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, fromB64url(wrappedDekB64));
    const dek = await subtle.importKey('raw', dekRaw.slice(12), { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const iv = new Uint8Array(dekRaw.slice(0, 12));
    return subtle.decrypt({ name: 'AES-GCM', iv }, dek, fromB64url(ciphertextB64));
}

export const __test = { toB64url, fromB64url, encodeRecovery, decodeRecovery, KDF };
