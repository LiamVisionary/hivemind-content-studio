// Client-side decrypt layer for E2E-sealed media (phase 2).
//
// The gateway serves sealed media as an envelope with an `X-E2E-Media: 1`
// header (see media_seal.py / app.py send_output_file). This helper fetches a
// media URL, and if it is an E2E envelope, decrypts it in-page with the vault
// private key and returns a blob URL the browser can render. For anything else
// (legacy plaintext, non-media, vault locked, any error) it returns the original
// URL untouched — it is strictly fail-open, so it can never break existing display.

import { decryptMedia } from './e2eVault.js';
import { decryptWithDevice, deviceRequesterHeaders, deviceRequesterPub } from './deviceIdentity.js';
import { ensureVaultReady } from './vaultSession.js';

/**
 * Open a sealed envelope with whichever key this tab holds that fits.
 *
 * Order matters only for speed, not for correctness: an envelope opens for
 * exactly one of these keys, and asking the wrong one costs a failed RSA
 * unwrap. Device first, because the common case is a tile the device made.
 */
async function openEnvelope(envelope, { deviceReady, vaultReady }) {
    let firstError;
    if (deviceReady) {
        try {
            return await decryptWithDevice(envelope.ciphertext, envelope.wrapped_dek);
        } catch (error) {
            firstError = error; // sealed to the vault, or to someone else entirely
        }
    }
    if (vaultReady) return decryptMedia(envelope.ciphertext, envelope.wrapped_dek);
    throw firstError || new Error('No key for this envelope');
}

// The decrypted-media cache: original url -> { src, bytes }.
//
// Every entry is plaintext pixels held in this renderer, so it is a memory
// budget, not a lookup table. Map iteration order is insertion order and every
// read re-inserts, which makes the first entry the least recently used one.
//
// Nothing is evicted while a mounted component still shows it: `holders` counts
// the useMediaSrc/MediaThumb effects that retained a URL, and revoking an object
// URL out from under a live <img> would blank the picture. So the budget is a
// ceiling on what is kept for LATER, and a session that genuinely has 300 MB of
// media on screen at once goes over it rather than breaking the view.
const blobCache = new Map();
const holders = new Map(); // original url -> mounted consumers holding it
let cachedBytes = 0;

// 256 MB. Large enough that scrolling back over a session's own work is still
// instant, small enough that the renderer does not fight the local model for
// unified memory on a 16 GB Mac.
export const DEFAULT_MEDIA_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;
let cacheBudgetBytes = DEFAULT_MEDIA_CACHE_BUDGET_BYTES;

/** Change the ceiling. Tests use it; so would a settings key. */
export function setResolvedMediaBudget(bytes) {
    const next = Number(bytes);
    cacheBudgetBytes = Number.isFinite(next) && next >= 0 ? next : DEFAULT_MEDIA_CACHE_BUDGET_BYTES;
    evictOverBudget();
    return cacheBudgetBytes;
}

/** What the cache holds right now — bytes, entries, retained URLs, the ceiling. */
export function resolvedMediaCacheStats() {
    return { bytes: cachedBytes, entries: blobCache.size, held: holders.size, budget: cacheBudgetBytes };
}

function dropCacheEntry(url) {
    const entry = blobCache.get(url);
    if (!entry) return;
    blobCache.delete(url);
    cachedBytes = Math.max(0, cachedBytes - entry.bytes);
    URL.revokeObjectURL(entry.src);
}

function evictOverBudget() {
    if (cachedBytes <= cacheBudgetBytes) return;
    for (const url of [...blobCache.keys()]) {
        if (cachedBytes <= cacheBudgetBytes) return;
        if (holders.get(url)) continue; // on screen — never yank it
        dropCacheEntry(url);
    }
}

function rememberResolved(url, src, bytes) {
    dropCacheEntry(url); // replacing: the old object URL is nobody's now
    const size = Math.max(0, Number(bytes) || 0);
    blobCache.set(url, { src, bytes: size });
    cachedBytes += size;
    evictOverBudget();
}

/**
 * Say that a mounted component is showing `url`, so eviction leaves it alone.
 *
 * Paired with releaseResolvedMedia in the same effect's cleanup. Retaining a URL
 * that is not cached yet is normal and correct: the retain happens before the
 * decrypt finishes, which is exactly the window in which a burst of new media
 * could otherwise evict the entry the moment it lands.
 */
export function retainResolvedMedia(url) {
    if (!url || typeof url !== 'string') return;
    holders.set(url, (holders.get(url) || 0) + 1);
}

export function releaseResolvedMedia(url) {
    if (!url || typeof url !== 'string') return;
    const next = (holders.get(url) || 0) - 1;
    if (next > 0) holders.set(url, next);
    else holders.delete(url);
    // The last consumer unmounting is the moment a long scroll frees anything at
    // all, so this is where the budget is re-checked.
    evictOverBudget();
}

// Sealed media this tab could NOT open, and why:
//   'locked'        — the vault has no key here (fresh tab, owner cookie still
//                     valid so the lock screen never stashed the passphrase)
//   'undecryptable' — there is a key and the envelope refuses it (an
//                     agent-sealed rental output, a re-created vault)
// resolveMediaSrc stays fail-open and still hands back the ORIGINAL url for
// both, so this side channel is the only way a caller can tell "plaintext media"
// apart from "ciphertext I must not render or save". Without it an <img>/<video>
// gets envelope JSON and dies quietly, and a download writes 2 MB of
// {"ciphertext":…} under a .mp4 name.
const sealFailures = new Map(); // original url -> reason
const sealFailureListeners = new Set();

function noteSealFailure(url, reason) {
    // Every successful plaintext resolve clears; only a real change is announced.
    if ((sealFailures.get(url) || null) === (reason || null)) return;
    if (reason) sealFailures.set(url, reason); else sealFailures.delete(url);
    // Display code holds a sync check; a listener that throws must not stop the rest.
    for (const listener of sealFailureListeners) {
        try { listener(url, reason || null); } catch { /* a bad subscriber is its own problem */ }
    }
}

/** Why `url` could not be decrypted this session: 'locked', 'undecryptable', or null. */
export function mediaSealFailure(url) {
    return sealFailures.get(String(url || '')) || null;
}

/** True when `url` is a verified E2E envelope this tab cannot open (either reason). */
export function isMediaVaultLocked(url) {
    return mediaSealFailure(url) !== null;
}

/** Notified as (url, reason|null) whenever a URL's seal state changes. */
export function subscribeMediaSealFailures(listener) {
    sealFailureListeners.add(listener);
    return () => sealFailureListeners.delete(listener);
}

// The one place that decides "these bytes are still sealed". The custom header is
// authoritative when readable; Content-Type is the fallback that survives
// cross-origin (the gateway sets no Expose-Headers) and is what a data: URL
// carrying an inlined envelope announces about itself.
export function isSealedEnvelopeResponse(response) {
    const headers = response?.headers;
    if (!headers?.get) return false;
    if (headers.get('X-E2E-Media') === '1') return true;
    return (headers.get('Content-Type') || '').includes('hivemind.e2e');
}

// Suggested download filename per media URL, registered by whoever knows which
// MODEL produced the output (see downloadNames.js). A blob: URL carries no
// filename of its own, so right-click "Save image as…" and the native <video>
// download control fall back to a UUID — unless the object URL is backed by a
// File, whose name the browser then offers. Registering here is what lets those
// browser-native paths produce the same name as our own download button.
const downloadNames = new Map(); // original url -> filename

export function registerMediaDownloadName(url, name) {
    if (url && name) downloadNames.set(String(url), String(name));
}

export function mediaDownloadNameFor(url) {
    return downloadNames.get(String(url || '')) || '';
}

export function isProbablyMediaUrl(url) {
    return typeof url === 'string' && /\/(image|video)\//.test(url);
}

export async function resolveMediaSrc(url) {
    if (!url || typeof url !== 'string') return url;
    const hit = peekResolvedMediaSrc(url);
    if (hit) return hit;
    let response;
    try {
        // Same URL, different envelope per key: presenting this device's key is
        // what gets back the copy sealed to THIS browser. Without it the server
        // can only offer the owner's copy, which a device-sealed clip may not
        // have if the owner vault was never a recipient.
        response = await fetch(url, {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: await deviceRequesterHeaders(),
        });
    } catch {
        return url; // network/CORS — let the element try normally
    }
    if (!response.ok) {
        // An error page says nothing about whether the media is sealed, so any
        // recorded seal failure stands.
        try { response.body?.cancel(); } catch { /* already consumed */ }
        return url;
    }
    if (!isSealedEnvelopeResponse(response)) {
        // Legacy plaintext or non-media: don't buffer it here (videos must stream).
        try { response.body?.cancel(); } catch { /* already consumed */ }
        noteSealFailure(url, null); // provably not an envelope
        return url;
    }
    const vaultReady = await ensureVaultReady();
    const deviceReady = Boolean(await deviceRequesterPub());
    if (!vaultReady && !deviceReady) {
        // Verified envelope, no key of any kind in this tab. Still fail-open, but
        // flagged, so display code can say "locked" instead of pointing an
        // element at JSON.
        try { response.body?.cancel(); } catch { /* already consumed */ }
        noteSealFailure(url, 'locked');
        return url;
    }
    try {
        const envelope = await response.json();
        // This device first, the owner vault second. A clip generated here opens
        // with the key that never left this browser; anything else falls back to
        // the vault, which is the cross-device and recovery path.
        const bytes = await openEnvelope(envelope, { deviceReady, vaultReady });
        const type = envelope.media_type || 'application/octet-stream';
        const name = mediaDownloadNameFor(url);
        // A File IS a Blob, so this changes nothing about rendering — it only gives
        // the object URL a filename for the browser's own download paths.
        const payload = name ? new File([bytes], name, { type }) : new Blob([bytes], { type });
        const blobUrl = URL.createObjectURL(payload);
        noteSealFailure(url, null); // a later unlock opened it after all
        rememberResolved(url, blobUrl, payload.size);
        return blobUrl;
    } catch {
        // We hold a key and it did not open this envelope: sealed to someone else
        // (an agent-sealed rental output), or the payload is damaged. Either way
        // the bytes behind this URL are ciphertext.
        noteSealFailure(url, 'undecryptable');
        return url; // still fail open — never worse than today
    }
}

// Synchronous cache probe so display code can skip loading theater (e.g. the
// unlock animation) for media that is already decrypted this session.
export function peekResolvedMediaSrc(url) {
    const entry = blobCache.get(url);
    if (!entry) return null;
    // Re-insert: Map order is insertion order, so a read is what makes this the
    // most recently used entry instead of the next one evicted.
    blobCache.delete(url);
    blobCache.set(url, entry);
    return entry.src;
}

// Hand the cache bytes the caller already holds in the clear, for a URL that
// will serve them sealed. A generation that was just promoted to a reference
// has its pixels in this tab RIGHT NOW; fetching the new URL only to decrypt the
// same image again is wasted work at best — and, when the vault key is not in
// this tab, it is a broken <img> pointed at ciphertext while the picture that
// produced it sits in memory. Only data: and blob: sources are accepted: they
// are the two shapes that are provably plaintext.
export function primeResolvedMedia(url, src) {
    if (!url || typeof url !== 'string') return false;
    if (typeof src !== 'string' || !/^(data|blob):/i.test(src)) return false;
    // A data: URL is bytes this cache now holds; a blob: URL was minted
    // elsewhere and its bytes are already accounted for by whoever made it.
    rememberResolved(url, src, src.startsWith('data:') ? src.length : 0);
    noteSealFailure(url, null);
    return true;
}

export function revokeResolvedMedia(url) {
    dropCacheEntry(url);
}

/**
 * Forget every "this tab cannot open it" verdict, keeping the decrypted blobs.
 *
 * An in-app unlock (VaultUnlockModal) changes the answer for every URL that was
 * recorded as sealed — but the verdicts are cached for the page load, which is
 * why unlocking used to need a reload to make sealed tiles resolve. Clearing
 * only the failures leaves already-decrypted media on screen untouched;
 * subscribers are notified per URL, so the tiles re-resolve in place.
 */
export function clearMediaSealFailures() {
    for (const url of [...sealFailures.keys()]) noteSealFailure(url, null);
}

export function clearResolvedMediaCache() {
    for (const entry of blobCache.values()) URL.revokeObjectURL(entry.src);
    blobCache.clear();
    cachedBytes = 0;
    for (const url of [...sealFailures.keys()]) noteSealFailure(url, null);
}
