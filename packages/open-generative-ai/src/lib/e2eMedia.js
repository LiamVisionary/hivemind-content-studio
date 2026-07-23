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
        if (!(await ensureVaultReady())) return url; // locked; can't decrypt now
        const envelope = await response.json();
        const bytes = await decryptMedia(envelope.ciphertext, envelope.wrapped_dek);
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: envelope.media_type || 'application/octet-stream' }));
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
