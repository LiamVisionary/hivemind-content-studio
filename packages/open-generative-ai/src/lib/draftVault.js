// What a person has TYPED but not yet sent, kept so a reload does not throw it
// away — and kept where only this browser can read it back.
//
// Why this exists next to the two stores that already persist things:
//
//   sessionStorage (studioTabs.js) is plaintext. It is the right home for the
//   tab strip — ids, which tab was in front, the model each one is set to —
//   and the wrong home for prompt text, which is why prompt text used to be
//   STRIPPED on the way in and therefore came back empty on every reload.
//
//   The owner vault (e2eVault.js) is ciphertext the SERVER stores, unlocked by
//   the owner's passphrase. That is right for a library meant to follow the
//   owner between machines, and more reach than an unsent draft wants: the
//   draft never needs to leave the browser that is typing it.
//
// So drafts get their own key, and the key never exists as bytes anywhere:
//   - AES-GCM-256, generated with extractable=false, so neither this module,
//     nor devtools, nor an extension, nor anything reading the profile off
//     disk can export it — it can only be USED, by script on this origin,
//     which is the same boundary the device identity key already relies on;
//   - it lives in IndexedDB (per origin, per browser profile) and is never
//     sent anywhere — no request carries it, the server is never told it
//     exists;
//   - the ciphertext it produces sits in localStorage, so a draft survives
//     quitting the browser, and a second device gets nothing.
//
// The consequence worth stating plainly: a browser that cannot hold the key
// (IndexedDB blocked, WebCrypto missing) persists NOTHING here. Drafts are
// dropped rather than written in the clear — the point of the store is the
// confidentiality, not the convenience.

const DB_NAME = 'hivemind-draft-vault';
const STORE = 'keys';
const RECORD_KEY = 'draft-key-v1';
const BLOB_KEY = 'hivemind.drafts.v1';

// A draft is text someone typed; these bounds are about a store that cannot
// grow without limit, not about what a prompt is allowed to be. Oldest entries
// go first, so the tab someone is actually working in is the last to be cut.
const MAX_ENTRIES = 64;
const MAX_BLOB_CHARS = 1_500_000; // ~1.5 MB of the ~5 MB localStorage budget

// Short, because the last thing written before the page goes is whatever the
// debounce has already flushed: an encrypt cannot be awaited from `pagehide`.
// 300 ms is the window of typing a crash can cost, and it is the reason the
// strip ALSO keeps persisting on its own slower beat.
const SAVE_DEBOUNCE_MS = 300;

const subtle = globalThis.crypto?.subtle;

let cache = null;        // { [scope]: { value, updatedAt, seq } } once hydrated
let hydratePromise = null;
let keyPromise = null;
let saveTimer = null;
// Ties on the clock are the norm, not the exception: one save walks every open
// tab, so a whole strip is written inside the same millisecond. Without a
// tiebreaker "drop the oldest" would pick arbitrarily among them. Seeded from
// the highest number already in the store so a reload keeps counting up.
let seq = 0;

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

/**
 * This browser's draft key, minted on first use and never re-minted.
 *
 * A CryptoKey survives structured clone with its non-extractable flag intact,
 * which is what lets the key be PERSISTED without ever existing as bytes — the
 * same property deviceIdentity.js depends on for the device private key.
 */
async function draftKey() {
    if (!subtle) throw new Error('WebCrypto unavailable');
    const db = await openDatabase();
    try {
        const existing = await transact(db, 'readonly', (store) => store.get(RECORD_KEY));
        if (existing?.key) return existing.key;
        const key = await subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            false, // non-extractable: the key can never be read back out, by anyone
            ['encrypt', 'decrypt'],
        );
        await transact(db, 'readwrite', (store) => store.put({ key }, RECORD_KEY));
        return key;
    } finally {
        db.close();
    }
}

/**
 * The key, or null when this browser cannot hold one.
 *
 * A failure RESOLVES to null rather than rejecting: the result is cached for
 * the life of the page (a browser without IndexedDB will not grow one
 * mid-session), and a stored rejected promise nobody is awaiting yet is an
 * unhandled rejection every time the store is touched.
 */
function ensureKey() {
    if (!keyPromise) keyPromise = draftKey().catch(() => null);
    return keyPromise;
}

// Same envelope as the owner vault's blobs, for the same reason: the version
// tag is what lets a future format change be recognised instead of guessed at.
async function encryptJson(value) {
    const key = await ensureKey();
    if (!key) throw new Error('No draft key');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return `v1.${toB64url(iv)}.${toB64url(ciphertext)}`;
}

async function decryptJson(blob) {
    const key = await ensureKey();
    if (!key) throw new Error('No draft key');
    const [version, ivPart, ciphertextPart] = String(blob).split('.');
    if (version !== 'v1') throw new Error('Unknown draft blob version');
    const plaintext = await subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64url(ivPart) }, key, fromB64url(ciphertextPart),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
}

function readStoredBlob() {
    try { return localStorage.getItem(BLOB_KEY) || ''; } catch { return ''; }
}

function discardStoredBlob() {
    try { localStorage.removeItem(BLOB_KEY); } catch { /* storage unavailable */ }
}

/** True when there is something to decrypt — lets a cold start skip the wait. */
export function hasStoredDrafts() {
    return Boolean(readStoredBlob());
}

async function hydrate() {
    const blob = readStoredBlob();
    if (!blob) return {};
    // No key at all is NOT the same as a blob that will not open. A browser
    // with IndexedDB switched off has no key today and may have one tomorrow,
    // so its drafts are left alone; only bytes that a real key could not
    // decrypt (cleared site data, a new profile) are thrown away, because
    // those will never open again and would otherwise be carried forever.
    if (!(await ensureKey())) return {};
    try {
        const parsed = await decryptJson(blob);
        if (!parsed || typeof parsed !== 'object') return {};
        seq = Object.values(parsed).reduce((high, entry) => Math.max(high, Number(entry?.seq) || 0), 0);
        return parsed;
    } catch {
        discardStoredBlob();
        return {};
    }
}

/**
 * Decrypt the store into memory. Must be awaited once before the first
 * readDraft — the studios read their boot state synchronously while rendering,
 * so the plaintext has to be in hand before React mounts (see main.jsx).
 */
export function hydrateDrafts() {
    if (cache) return Promise.resolve(cache);
    if (!hydratePromise) {
        hydratePromise = hydrate().then((state) => {
            cache = state;
            return cache;
        });
    }
    return hydratePromise;
}

function prune(state) {
    const entries = Object.entries(state);
    if (entries.length <= MAX_ENTRIES) return state;
    // Oldest first, so what gets dropped is what was touched longest ago.
    const keep = entries
        .sort((a, b) => (Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
            || (Number(b[1]?.seq || 0) - Number(a[1]?.seq || 0)))
        .slice(0, MAX_ENTRIES);
    return Object.fromEntries(keep);
}

function persistNow() {
    if (!cache) return;
    const snapshot = prune(cache);
    cache = snapshot;
    void (async () => {
        try {
            const blob = await encryptJson(snapshot);
            // A blob that cannot fit is not worth half-writing; dropping the
            // oldest entry and retrying would loop on one oversized draft.
            if (blob.length > MAX_BLOB_CHARS) return;
            localStorage.setItem(BLOB_KEY, blob);
        } catch {
            // No key (IndexedDB blocked) or no room. Nothing is written — and
            // in particular nothing is written in the clear.
        }
    })();
}

function schedulePersist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, SAVE_DEBOUNCE_MS);
}

/** The draft for one scope (`"<studio>:<tabId>"`), or null. Sync: post-hydrate. */
export function readDraft(scope) {
    const entry = cache?.[String(scope)];
    return entry && typeof entry === 'object' && 'value' in entry ? entry.value : null;
}

/**
 * Record a draft. `null`/`undefined`/`{}` removes it, so a tab whose text has
 * been cleared stops being remembered rather than keeping its last words.
 */
export function writeDraft(scope, value) {
    if (!cache) cache = {};
    const key = String(scope);
    const empty = value == null
        || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
    if (empty) {
        if (!(key in cache)) return;
        delete cache[key];
    } else {
        seq += 1;
        cache[key] = { value, updatedAt: Date.now(), seq };
    }
    schedulePersist();
}

/** Drop the drafts of scopes that are no longer open, e.g. a closed tab. */
export function dropDrafts(predicate) {
    if (!cache) return;
    let changed = false;
    for (const key of Object.keys(cache)) {
        if (predicate(key)) continue;
        delete cache[key];
        changed = true;
    }
    if (changed) schedulePersist();
}

/**
 * Forget every draft AND the key that could read them.
 *
 * Dropping the key is what makes this a real erase: the ciphertext may survive
 * in a backup or a disk image, and without the key it is noise to everyone,
 * this browser included.
 */
export async function forgetDrafts() {
    cache = {};
    hydratePromise = null;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    discardStoredBlob();
    keyPromise = null;
    try {
        const db = await openDatabase();
        try { await transact(db, 'readwrite', (store) => store.delete(RECORD_KEY)); } finally { db.close(); }
    } catch { /* nothing held the key; the blob is gone either way */ }
}

export const __test = {
    reset: () => {
        cache = null;
        hydratePromise = null;
        keyPromise = null;
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    },
    flush: () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } persistNow(); },
    BLOB_KEY,
    MAX_ENTRIES,
};
