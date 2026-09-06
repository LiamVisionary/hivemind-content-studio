// Recover sealed media with a private key this browser is handed -- the
// browser-side twin of scripts/recover_sealed_media.py.
//
// Why it exists: for two weeks a generation's ONLY recipient could be a browser
// or agent key that has since been lost, so the owner's vault -- the durable
// identity -- cannot open it. If that key ever turns up (an old machine, a
// backup), this opens every clip it fits and re-seals the bytes to the vault,
// entirely in the page. The server receives a new envelope, never plaintext.
//
// Boundaries, deliberately:
//   - probing STOPS at the DEK unwrap, one RSA operation before any media
//     exists, so a key that does not fit reveals nothing about the clip;
//   - the pasted key lives in a non-extractable CryptoKey for the duration of
//     one dialog and is never stored;
//   - only clips the key actually opens are touched, and the server keeps the
//     previous envelope beside the new one.
const subtle = globalThis.crypto?.subtle;

export function toB64url(bytes) {
    let s = '';
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text) {
    const padded = String(text || '').replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(text || '').length % 4)) % 4);
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function pemBody(pem, label) {
    const m = String(pem || '').match(new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`));
    return m ? m[1].replace(/\s+/g, '') : '';
}

/**
 * Import a PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----") as a non-extractable
 * RSA-OAEP-SHA256 decrypt key. This is the form the studio's agent key is
 * written in. A PKCS#1 "RSA PRIVATE KEY" is refused with a message that says
 * how to convert it, rather than guessed at.
 */
export async function importPrivateKeyPem(pem) {
    if (!subtle) throw new Error('WebCrypto unavailable');
    if (pemBody(pem, 'RSA PRIVATE KEY')) {
        throw new Error('This is a PKCS#1 key. Convert it first: openssl pkcs8 -topk8 -nocrypt -in key.pem');
    }
    const body = pemBody(pem, 'PRIVATE KEY');
    if (!body) throw new Error('Not a PEM private key (expected -----BEGIN PRIVATE KEY-----)');
    const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    return subtle.importKey('pkcs8', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
}

/** Fingerprint of the key's PUBLIC half, exactly as the gateway names it. */
export async function keyFingerprint(privateKey, pem) {
    // WebCrypto cannot derive the public key from a non-extractable private
    // key, so read the public half straight out of the PKCS#8 DER: it carries
    // the modulus and exponent. Simplest robust route: re-import extractable
    // once, export JWK, rebuild SPKI via a JWK->SPKI import of the public part.
    const body = pemBody(pem, 'PRIVATE KEY');
    const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    const extractable = await subtle.importKey('pkcs8', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['decrypt']);
    const jwk = await subtle.exportKey('jwk', extractable);
    const pub = await subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RSA-OAEP-256', ext: true },
        { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
    const spki = toB64url(await subtle.exportKey('spki', pub));
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(spki));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** Does this key unwrap the envelope's DEK? Stops there. */
export async function keyOpens(envelope, privateKey) {
    try {
        const raw = await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, fromB64url(envelope.wrapped_dek));
        return raw.byteLength === 44; // iv(12) || dek(32)
    } catch {
        return false;
    }
}

/**
 * Open with `privateKey`, re-seal to `vaultSpkiB64url`. Same wire format the
 * gateway and e2eVault.decryptMedia use: iv||dek wrapped with RSA-OAEP-SHA256,
 * payload AES-GCM under a fresh key. Returns the new envelope, never bytes.
 */
export async function reseal(envelope, privateKey, vaultSpkiB64url) {
    const raw = await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, fromB64url(envelope.wrapped_dek));
    const oldIv = new Uint8Array(raw.slice(0, 12));
    const oldDek = await subtle.importKey('raw', raw.slice(12), { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: oldIv }, oldDek, fromB64url(envelope.ciphertext));

    const vaultPub = await subtle.importKey('spki', fromB64url(vaultSpkiB64url), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const dekBytes = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const dek = await subtle.importKey('raw', dekBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, dek, plain);
    const joined = new Uint8Array(44); joined.set(iv, 0); joined.set(dekBytes, 12);
    const wrapped = await subtle.encrypt({ name: 'RSA-OAEP' }, vaultPub, joined);
    return { v: 1, media_type: envelope.media_type || 'application/octet-stream',
             wrapped_dek: toB64url(wrapped), ciphertext: toB64url(ciphertext) };
}

/**
 * Walk `items` ({ id, url }), fetch each envelope with `fetchEnvelope(url)`
 * (null when the URL is not a sealed envelope), and report which the key
 * opens. Nothing is decrypted here beyond the DEK.
 */
export async function scanForKey(items, privateKey, fetchEnvelope, onProgress = () => {}) {
    const opens = [], refuses = [], skipped = [];
    let n = 0;
    for (const item of items) {
        const envelope = await fetchEnvelope(item.url).catch(() => null);
        if (!envelope) skipped.push(item);
        else if (await keyOpens(envelope, privateKey)) opens.push({ ...item, envelope });
        else refuses.push(item);
        onProgress({ done: ++n, total: items.length, opens: opens.length });
    }
    return { opens, refuses, skipped };
}
