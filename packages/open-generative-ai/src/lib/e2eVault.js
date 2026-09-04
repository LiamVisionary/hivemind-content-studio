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

// ── re-wrapping (change password, forgotten password, new recovery key) ──────
//
// All three move ONE wrap of an unchanged master key. That is what makes them
// cheap and what makes them safe: nothing already sealed has to be re-encrypted,
// and every other way into this vault — the recovery copy, each passkey's PRF
// wrap, this browser's device wrap — keeps working, because each of them wraps
// the same master key and the master key is not what changes.

/** The master key, extractable, from whichever secret the caller can prove. */
async function masterKeyFrom(identity, current) {
    if (current?.recoveryKey) {
        const recoveryKey = await importRecoveryKey(decodeRecovery(current.recoveryKey));
        return unwrapMasterKey(recoveryKey, identity.wrapped_mk_recovery);
    }
    if (current?.passphrase) return extractableMasterKey(identity, current.passphrase);
    throw new Error('No current secret to re-wrap from');
}

/**
 * Seal the master key under a NEW passphrase: a fresh salt, a fresh pass key.
 *
 * `current` is `{ passphrase }` (changing a password you still know) or
 * `{ recoveryKey }` (you forgot it). Returns the three fields the server needs
 * to store, or null when the current secret is wrong — a GCM tag mismatch, with
 * no server round trip and so no oracle.
 */
export async function rewrapForPassphrase(identity, current, newPassphrase) {
    if (!subtle) throw new Error('WebCrypto unavailable');
    if (!newPassphrase) throw new Error('A new passphrase is required');
    let mk;
    try {
        mk = await masterKeyFrom(identity, current);
    } catch {
        return null;
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const passKey = await deriveWrappingKey(newPassphrase, salt);
    return { kdf: KDF, salt: toB64url(salt), wrapped_mk_pass: await wrapMasterKey(passKey, mk) };
}

/**
 * Mint a new recovery key and seal the master key under it.
 *
 * The old recovery key stops working the moment the returned wrap is stored,
 * which is the point: a key that was printed, photographed or lost should be
 * revocable without re-encrypting a library.
 */
export async function rewrapForRecovery(identity, current) {
    if (!subtle) throw new Error('WebCrypto unavailable');
    let mk;
    try {
        mk = await masterKeyFrom(identity, current);
    } catch {
        return null;
    }
    const recoveryBytes = crypto.getRandomValues(new Uint8Array(20));
    const wrapped = await wrapMasterKey(await importRecoveryKey(recoveryBytes), mk);
    return { recoveryKey: encodeRecovery(recoveryBytes), wrapped_mk_recovery: wrapped };
}

/**
 * Prove possession of this vault by DECRYPTING a server-issued nonce.
 *
 * Not by signing it: the vault keypair is RSA-OAEP with encrypt/decrypt usages
 * only, and WebCrypto refuses to sign with such a key. The server holds the
 * public half, seals 32 random bytes to it, and believes whoever hands the
 * plaintext back — which is only a browser that has already unwrapped the
 * private key, and so has already opened the vault.
 */
export async function decryptChallengeNonce(sealedNonce) {
    if (!subtle) throw new Error('WebCrypto unavailable');
    if (!unlocked || !privateKey) throw new Error('Vault is locked');
    const plain = await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, fromB64url(sealedNonce));
    return toB64url(plain);
}

// ── passkey unlock ───────────────────────────────────────────────────────────
//
// A passkey signs a challenge; it does not hand over a secret. So proving WHO
// you are and being able to DECRYPT are two different problems, and only one of
// them is solved by the assertion. Two ways to close the gap, in preference
// order:
//
//   1. The WebAuthn PRF extension. The authenticator derives a stable 32-byte
//      secret from (credential, salt) and never reveals the seed. We stretch it
//      into an AES key and wrap the master key with it, so Face ID genuinely
//      decrypts. Requires Safari 18+/Chrome 116+ and an authenticator that
//      supports it — hence the fallback.
//   2. A device wrap. After ONE password unlock, the master key is wrapped to
//      this browser's non-extractable device key (deviceIdentity.js) and kept
//      in IndexedDB. A later passkey assertion authorises using it. Honest
//      framing: here the biometric guards the door, not the key — anyone who
//      can run script in an unlocked OS profile could unwrap it. It is strictly
//      better than a passphrase in sessionStorage and strictly worse than PRF.
//
// The password and recovery code remain the only paths that work on a device
// that has never been unlocked before.

import { deviceIdentity } from './deviceIdentity.js';

const DEVICE_DB = 'hivemind-device-identity';
const DEVICE_STORE = 'keys';
const deviceWrapKey = (accountId) => `vault-mk-wrap-v1:${accountId}`;

// HKDF rather than using the PRF bytes directly: the extension's output is a
// MAC over our salt, not a uniformly-random AES key, and binding the label here
// means the same secret used for anything else later cannot collide with this.
async function keyFromPrfSecret(prfSecret) {
    const base = await subtle.importKey('raw', prfSecret, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(0),
            info: new TextEncoder().encode('hivemind-content-studio/vault-prf/v1'),
        },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['wrapKey', 'unwrapKey'],
    );
}

// Enrolment needs an EXTRACTABLE master key to wrap, and the session handle is
// deliberately not one — `completeUnlock` re-imports it non-extractable so a
// bug elsewhere cannot export it. So enrolling re-derives from the passphrase
// instead of the module keeping a wrappable copy alive for its whole lifetime.
// That is not merely a workaround: adding a new way to unlock the vault SHOULD
// require proving you can already unlock it.
async function extractableMasterKey(identity, passphrase) {
    const passKey = await deriveWrappingKey(passphrase, fromB64url(identity.salt));
    return unwrapMasterKey(passKey, identity.wrapped_mk_pass);
}

/**
 * Wrap the master key under a passkey's PRF secret, for the server to store.
 * Returns null when the passphrase is wrong.
 */
export async function wrapMasterKeyForPrf(identity, passphrase, prfSecret) {
    if (!subtle) throw new Error('WebCrypto unavailable');
    let mk;
    try {
        mk = await extractableMasterKey(identity, passphrase);
    } catch {
        return null;
    }
    return wrapMasterKey(await keyFromPrfSecret(prfSecret), mk);
}

/** Unlock from a passkey's PRF secret. False when this key is not enrolled. */
export async function unlockWithPrf(identity, credentialId, prfSecret) {
    if (!subtle) throw new Error('WebCrypto unavailable');
    let wraps;
    try {
        wraps = JSON.parse(identity.wrapped_mk_prf || '{}');
    } catch {
        return false;
    }
    const blob = wraps[credentialId];
    if (!blob) return false;
    let mk;
    try {
        mk = await unwrapMasterKey(await keyFromPrfSecret(prfSecret), blob);
    } catch {
        return false;
    }
    await completeUnlock(identity, mk);
    return true;
}

// ── device wrap (fallback when the authenticator has no PRF) ─────────────────

function openDeviceDb() {
    return new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
        const request = indexedDB.open(DEVICE_DB, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(DEVICE_STORE)) {
                request.result.createObjectStore(DEVICE_STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function deviceRecord(mode, key, value) {
    return openDeviceDb().then((db) => new Promise((resolve, reject) => {
        const transaction = db.transaction(DEVICE_STORE, mode);
        const store = transaction.objectStore(DEVICE_STORE);
        const request = mode === 'readwrite' ? store.put(value, key) : store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }));
}

/**
 * Keep an unlockable copy of the master key on THIS browser.
 *
 * Sealed to the device's own non-extractable RSA key, so the stored blob is
 * useless if copied off the machine — but usable by script in this origin,
 * which is the limitation the module comment above states plainly.
 */
export async function rememberOnThisDevice(identity, passphrase, accountId) {
    if (!subtle) throw new Error('WebCrypto unavailable');
    let mk;
    try {
        mk = await extractableMasterKey(identity, passphrase);
    } catch {
        return false;
    }
    // Null in a browser with no IndexedDB (private windows, some embedded
    // webviews). There is simply nowhere to remember it, which is a "no" rather
    // than a crash — the password path still works.
    const identityKeys = await deviceIdentity();
    if (!identityKeys?.keyPair) return false;
    const raw = await subtle.exportKey('raw', mk);
    const sealed = await subtle.encrypt({ name: 'RSA-OAEP' }, identityKeys.keyPair.publicKey, raw);
    await deviceRecord('readwrite', deviceWrapKey(accountId), toB64url(sealed));
    return true;
}

/**
 * The master key inside this browser's device wrap, extractable.
 *
 * Null means there is nothing to work with — no wrap stored, or no device key
 * in this browser right now (a private window, IndexedDB unavailable). A THROW
 * means the wrap is there and cannot be opened, which is a different thing:
 * callers act on the two differently, so do not collapse them.
 */
async function masterKeyFromDeviceWrap(accountId) {
    let stored;
    try {
        stored = await deviceRecord('readonly', deviceWrapKey(accountId));
    } catch {
        return null;
    }
    if (!stored) return null;
    const identityKeys = await deviceIdentity();
    if (!identityKeys?.keyPair) return null;
    const raw = await subtle.decrypt({ name: 'RSA-OAEP' }, identityKeys.keyPair.privateKey, fromB64url(stored));
    return subtle.importKey(
        'raw', raw, { name: 'AES-GCM', length: 256 }, true,
        ['encrypt', 'decrypt', 'unwrapKey'],
    );
}

/**
 * Unlock from this browser's remembered copy. False when there is none.
 *
 * A wrap that is PRESENT but unusable is deleted rather than kept: it was
 * sealed to a device key this browser no longer has, or it holds the master key
 * of a superseded identity. Nothing else ever clears it, so keeping it means
 * failing the same way on every reload — with a valid session, a healthy vault,
 * and no way to tell why. Dropping it costs one password unlock, which then
 * writes a fresh wrap.
 */
export async function unlockWithDevice(identity, accountId) {
    if (!subtle) throw new Error('WebCrypto unavailable');
    let mk;
    try {
        mk = await masterKeyFromDeviceWrap(accountId);
    } catch {
        await forgetThisDevice(accountId).catch(() => false);
        return false;
    }
    if (!mk) return false;
    try {
        await completeUnlock(identity, mk);
        return true;
    } catch {
        // Opened, but it does not fit this identity — equally dead.
        await forgetThisDevice(accountId).catch(() => false);
        return false;
    }
}

/**
 * Wrap the master key for a passkey's PRF secret using the device wrap as the
 * source, for a session unlocked WITHOUT the passphrase.
 *
 * wrapMasterKeyForPrf re-derives the key from the passphrase, which a device
 * unlock has not got. Without this path a passkey sign-in can never enrol PRF:
 * it rides the weaker device wrap forever and the stronger unlock it is
 * entitled to is never written.
 */
export async function wrapMasterKeyForPrfWithDevice(accountId, prfSecret) {
    if (!subtle) throw new Error('WebCrypto unavailable');
    let mk;
    try {
        mk = await masterKeyFromDeviceWrap(accountId);
    } catch {
        return null;
    }
    if (!mk) return null;
    return wrapMasterKey(await keyFromPrfSecret(prfSecret), mk);
}

/** Drop this browser's remembered copy (sign out of the device, not the account). */
export async function forgetThisDevice(accountId) {
    const db = await openDeviceDb();
    return new Promise((resolve) => {
        const transaction = db.transaction(DEVICE_STORE, 'readwrite');
        transaction.objectStore(DEVICE_STORE).delete(deviceWrapKey(accountId));
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => resolve(false);
    });
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
