// Client-side decrypt layer for E2E-sealed media (phase 2).
//
// The gateway serves sealed media as an envelope with an `X-E2E-Media: 1`
// header (see media_seal.py / app.py send_output_file). This helper fetches a
// media URL, and if it is an E2E envelope, decrypts it in-page with the vault
// private key and returns a blob URL the browser can render. For anything else
// (legacy plaintext, non-media, vault locked, any error) it returns the original
// URL untouched — it is strictly fail-open, so it can never break existing display.

import { decryptMedia } from './e2eVault.js';
import { ensureVaultReady } from './vaultSession.js';

const blobCache = new Map(); // original url -> object URL

// URLs verified to be E2E envelopes that could NOT decrypt because this tab has
// no vault key (e.g. a fresh tab whose owner cookie is still valid, so the lock
// screen never stashed the passphrase). resolveMediaSrc stays fail-open and still
// returns the original URL for these; this side-channel lets display code say
// "vault locked — unlock to view" instead of pointing an <img>/<video> at
// envelope JSON and failing silently.
const vaultLockedUrls = new Set();

export function isMediaVaultLocked(url) {
    return vaultLockedUrls.has(String(url || ''));
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
    if (blobCache.has(url)) return blobCache.get(url);
    let response;
    try {
        response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    } catch {
        return url; // network/CORS — let the element try normally
    }
    // Detect E2E by the custom header when readable, else by Content-Type — the
    // latter is always exposed cross-origin (the media comes from the gateway on
    // a different origin, where custom headers are hidden without Expose-Headers).
    const contentType = response.headers.get('Content-Type') || '';
    const isE2E = response.headers.get('X-E2E-Media') === '1' || contentType.includes('hivemind.e2e');
    if (!response.ok || !isE2E) {
        // Legacy plaintext or non-media: don't buffer it here (videos must stream).
        try { response.body?.cancel(); } catch { /* already consumed */ }
        return url;
    }
    try {
        if (!(await ensureVaultReady())) {
            vaultLockedUrls.add(url); // verified envelope, no key in this tab
            try { response.body?.cancel(); } catch { /* already consumed */ }
            return url; // fail open; display code may show an unlock affordance
        }
        const envelope = await response.json();
        const bytes = await decryptMedia(envelope.ciphertext, envelope.wrapped_dek);
        const type = envelope.media_type || 'application/octet-stream';
        const name = mediaDownloadNameFor(url);
        // A File IS a Blob, so this changes nothing about rendering — it only gives
        // the object URL a filename for the browser's own download paths.
        const payload = name ? new File([bytes], name, { type }) : new Blob([bytes], { type });
        const blobUrl = URL.createObjectURL(payload);
        vaultLockedUrls.delete(url); // a later unlock resolved it after all
        blobCache.set(url, blobUrl);
        return blobUrl;
    } catch {
        return url; // fail open — never worse than today
    }
}

// Synchronous cache probe so display code can skip loading theater (e.g. the
// unlock animation) for media that is already decrypted this session.
export function peekResolvedMediaSrc(url) {
    return blobCache.get(url) ?? null;
}

export function revokeResolvedMedia(url) {
    const blobUrl = blobCache.get(url);
    if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobCache.delete(url);
    }
}

export function clearResolvedMediaCache() {
    for (const blobUrl of blobCache.values()) URL.revokeObjectURL(blobUrl);
    blobCache.clear();
}
