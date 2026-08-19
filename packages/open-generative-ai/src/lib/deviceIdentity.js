// This browser's own E2E identity — the key that makes a generation *this
// device's* generation.
//
// The owner vault (e2eVault.js) is ONE identity shared by every browser that
// knows the passphrase: it is stored server-side wrapped by that passphrase, so
// unlocking anywhere reconstructs the same private key. That is the right shape
// for "the owner can read their library from any machine", and the wrong shape
// for "this clip belongs to the device that made it".
//
// So each browser also generates a keypair here that NEVER leaves it:
//   - the private key is non-extractable, so not even this code can export it,
//   - it lives in IndexedDB (per origin, per browser profile), never on the server,
//   - only its PUBLIC half is ever sent, presented as X-E2E-Requester-Pub.
//
// Generated media is sealed to this public key AND to the owner vault, so the
// generating device can always open its own work and the owner keeps a recovery
// path. A different device — or an agent — gets neither by accident: it has to
// be sealed in deliberately.

const DB_NAME = 'hivemind-device-identity';
const STORE = 'keys';
const RECORD_KEY = 'e2e-device-v1';

const subtle = globalThis.crypto?.subtle;

let cached = null; // { keyPair, spki }
let pending = null;

function toB64url(buffer) {
    let binary = '';
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
    const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
            reject(new Error('IndexedDB unavailable'));
            return;
        }
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    });
}

function transact(db, mode, run) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
}

async function loadStoredKeyPair() {
    const db = await openDatabase();
    try {
        const record = await transact(db, 'readonly', (store) => store.get(RECORD_KEY));
        // A CryptoKey survives structured clone with its non-extractable flag
        // intact — that is what lets the private half be persisted without ever
        // existing as bytes anywhere.
        return record?.privateKey && record?.publicKey ? record : null;
    } finally {
        db.close();
    }
}

async function storeKeyPair(keyPair) {
    const db = await openDatabase();
    try {
        await transact(db, 'readwrite', (store) => store.put(
            { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey },
            RECORD_KEY,
        ));
    } finally {
        db.close();
    }
}

async function bootstrap() {
    if (!subtle) throw new Error('WebCrypto unavailable');
    let keyPair = await loadStoredKeyPair();
    if (!keyPair) {
        keyPair = await subtle.generateKey(
            // 2048 to match the owner vault and the gateway's SPKI validator.
            { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
            false, // non-extractable: the private key can never be read back out
            ['encrypt', 'decrypt'],
        );
        await storeKeyPair(keyPair);
    }
    const spki = toB64url(await subtle.exportKey('spki', keyPair.publicKey));
    return { keyPair, spki };
}

/** This device's identity, created on first use. Null if the browser can't. */
export async function deviceIdentity() {
    if (cached) return cached;
    if (!pending) {
        pending = bootstrap()
            .then((identity) => { cached = identity; return identity; })
            .catch(() => null)
            .finally(() => { pending = null; });
    }
    return pending;
}

/** base64url SPKI to present as X-E2E-Requester-Pub, or '' if unavailable. */
export async function deviceRequesterPub() {
    const identity = await deviceIdentity();
    return identity?.spki || '';
}

/** Header bag for a request that should be attributed to THIS device. */
export async function deviceRequesterHeaders() {
    const pub = await deviceRequesterPub();
    return pub ? { 'X-E2E-Requester-Pub': pub } : {};
}

/**
 * Open an envelope sealed to this device. Throws if it was sealed to anyone
 * else — the caller falls back to the owner vault, which is the recovery path.
 */
export async function decryptWithDevice(ciphertextB64, wrappedDekB64) {
    const identity = await deviceIdentity();
    if (!identity) throw new Error('No device identity');
    const dekRaw = await subtle.decrypt({ name: 'RSA-OAEP' }, identity.keyPair.privateKey, fromB64url(wrappedDekB64));
    const dek = await subtle.importKey('raw', dekRaw.slice(12), { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const iv = new Uint8Array(dekRaw.slice(0, 12));
    return subtle.decrypt({ name: 'AES-GCM', iv }, dek, fromB64url(ciphertextB64));
}

export const __test = { toB64url, fromB64url, reset: () => { cached = null; pending = null; } };
