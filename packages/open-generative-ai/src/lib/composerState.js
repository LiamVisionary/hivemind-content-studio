import { isHivemindStudioEnabled } from './hivemindStudio.js';
import { decryptJson, encryptJson } from './e2eVault.js';
import { ensureVaultReady, getVaultBlob, putVaultBlob } from './vaultSession.js';

// End-to-end encrypted composer persistence for the embedded Hivemind studio.
//
// In hivemindStudio mode the draft (prompt text, reference selection, upload
// grid, section preferences) is encrypted IN THE BROWSER with the owner vault
// key and stored as opaque ciphertext through /api/vault/blob — the server can
// never read it. Outside studio mode (standalone app) the same API falls back
// to localStorage so behavior is unchanged.

const VAULT_NAMESPACE = 'composer';
const VAULT_KEY = 'state';
const LOCAL_FALLBACK_KEY = 'opengen_composer_state';
const LEGACY_UPLOADS_KEY = 'muapi_uploads';
const SAVE_DEBOUNCE_MS = 600;

let cache = null;
let hydratePromise = null;
let saveTimer = null;

function readLocalFallback() {
    try {
        const parsed = JSON.parse(localStorage.getItem(LOCAL_FALLBACK_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function migrateLegacyUploads(state) {
    // One-time move of the plaintext upload grid out of browser storage.
    try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_UPLOADS_KEY) || '[]');
        if (Array.isArray(legacy) && legacy.length && !Array.isArray(state.uploads)) {
            state.uploads = legacy;
        }
        localStorage.removeItem(LEGACY_UPLOADS_KEY);
    } catch { /* legacy value unreadable; drop it */ }
    return state;
}

async function hydrateFromVault() {
    const ready = await ensureVaultReady();
    if (!ready) return {}; // browser not unlocked; persist stays off until it is
    try {
        const ciphertext = await getVaultBlob(VAULT_NAMESPACE, VAULT_KEY);
        const state = ciphertext ? await decryptJson(ciphertext) : {};
        return migrateLegacyUploads(state && typeof state === 'object' ? state : {});
    } catch {
        return {};
    }
}

export function hydrateComposerState() {
    if (cache) return Promise.resolve(cache);
    if (hydratePromise) return hydratePromise;
    if (!isHivemindStudioEnabled()) {
        cache = readLocalFallback();
        return Promise.resolve(cache);
    }
    hydratePromise = hydrateFromVault().then((state) => {
        cache = state;
        return cache;
    });
    return hydratePromise;
}

export function getComposerSection(section) {
    const value = cache?.[section];
    return value && typeof value === 'object' ? value : {};
}

function persistNow() {
    if (!cache) return;
    if (!isHivemindStudioEnabled()) {
        try { localStorage.setItem(LOCAL_FALLBACK_KEY, JSON.stringify(cache)); } catch { /* quota */ }
        return;
    }
    const snapshot = cache;
    void (async () => {
        try {
            if (!(await ensureVaultReady())) return; // locked; a later edit retries
            const ciphertext = await encryptJson(snapshot);
            await putVaultBlob(VAULT_NAMESPACE, VAULT_KEY, ciphertext);
        } catch { /* offline/locked; the next edit retries */ }
    })();
}

export function updateComposerSection(section, patch) {
    if (!cache) cache = {};
    cache[section] = { ...getComposerSection(section), ...patch };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, SAVE_DEBOUNCE_MS);
}

export function getComposerUploads() {
    return Array.isArray(cache?.uploads) ? cache.uploads : [];
}

export function setComposerUploads(uploads) {
    if (!cache) cache = {};
    cache.uploads = Array.isArray(uploads) ? uploads : [];
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, SAVE_DEBOUNCE_MS);
}

export function clearComposerStateCache() {
    cache = null;
    hydratePromise = null;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}
