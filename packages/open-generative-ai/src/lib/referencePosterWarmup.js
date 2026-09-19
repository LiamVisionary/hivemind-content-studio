// Give every saved reference a poster, once, in the background.
//
// A poster is built server-side at upload, but references sealed before that
// existed can never get one that way — the host has no vault key, so it cannot
// read them. Only the browser can, and the first version of this leaned on that
// lazily: a tile decrypted its own original, drew a thumbnail, and handed it
// back. Which means the person who opens the panel pays for it, every time,
// until every tile has been looked at.
//
// So: after the panel has been opened once, quietly walk the references that
// have no poster and give them one. Strictly one at a time with a gap between,
// because this is housekeeping and must never compete with what the user is
// actually doing. Self-limiting — a reference that gets a poster is not
// revisited, and a failure is not retried this session.
//
// Effects are injected rather than imported so this is drivable in a test:
// nothing here touches the network, the DOM, or a clock directly.

export const WARMUP_GAP_MS = 300;

/** References this pass should handle: no poster yet, and something to show. */
export function referencesNeedingPosters(references = []) {
    return references.filter((entry) => (
        entry
        && entry.uploadedUrl
        && !entry.posterUrl
        // A voice clip has no frame to draw; the panel shows it a mic and a
        // scrub control instead.
        && entry.kind !== 'audio'
    ));
}

/**
 * @param {object[]} references  entries from fetchHivemindReferences
 * @param {object}   effects
 *   capture(url, kind) -> Promise<dataUrl|null>   decrypt + reduce to a thumbnail
 *   publish(url, dataUrl) -> Promise<posterUrl|null>  hand it back to be sealed
 *   onPoster(url, posterUrl)                      tell the panel it can stop decrypting
 *   pause(ms) -> Promise                          the gap between items
 *   shouldStop() -> boolean                       page hidden, panel unmounted
 * @returns {Promise<{published: number, failed: number, stopped: boolean}>}
 */
export async function warmReferencePosters(references, effects = {}) {
    const { capture, publish, onPoster, pause, shouldStop, gapMs = WARMUP_GAP_MS } = effects;
    const pending = referencesNeedingPosters(references);
    let published = 0;
    let failed = 0;
    for (const entry of pending) {
        if (shouldStop?.()) return { published, failed, stopped: true };
        try {
            const dataUrl = await capture(entry.uploadedUrl, entry.kind === 'video' ? 'video' : 'image');
            if (!dataUrl) {
                failed += 1;
            } else {
                const posterUrl = await publish(entry.uploadedUrl, dataUrl);
                if (posterUrl) {
                    published += 1;
                    onPoster?.(entry.uploadedUrl, posterUrl);
                } else {
                    failed += 1;
                }
            }
        } catch {
            // One unreadable reference must not end the pass for the rest.
            failed += 1;
        }
        // Yield between items even after a failure, so a run of broken
        // references cannot spin the main thread.
        if (pending.length > 1) await pause?.(gapMs);
    }
    return { published, failed, stopped: false };
}
