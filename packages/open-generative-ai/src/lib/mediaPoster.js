// Thumbnails for sealed media, decoded in the browser.
//
// Two jobs, both about NOT drawing a 36px tile from a multi-megabyte original:
//
//  - A sealed clip decrypts to a blob URL, and a <video> given one shows nothing
//    until it has actually decoded a frame (`preload="metadata"` fetches
//    duration and dimensions, not pixels). So saved motion references rendered
//    as identical film icons.
//  - A sealed picture renders fine, but only after the whole original has been
//    fetched and decrypted — 3.6 MB to fill 36 pixels.
//
// Either way the output is a small data URL, which the panel then hands back to
// the server so the next session skips all of this (see the poster backfill).
//
// Frame 0 is deliberately NOT used: video often opens on black (a fade-in, a
// slate, a screen recording's first compositor frame), so a poster taken at 0s
// is a black square as uninformative as the icon it replaces. Seeking a little
// way in lands on real content.

const POSTER_SECONDS = 0.35;
const POSTER_WIDTH = 160;
// Decoding is not free and a strip re-renders constantly, so each source is
// decoded once per session. Keyed by the RESOLVED (decrypted blob) url.
const cache = new Map();
const inFlight = new Map();

export function peekMediaPoster(src) {
    return src ? cache.get(src) || null : null;
}

/**
 * Decode one frame of `src` and return it as a data URL, or null when the clip
 * cannot be decoded (an unsupported codec, a stripped blob, a tainted canvas).
 * Never rejects: a thumbnail is a nicety, and the caller falls back to an icon.
 */
export function captureVideoPoster(src, { seconds = POSTER_SECONDS, width = POSTER_WIDTH } = {}) {
    if (!src) return Promise.resolve(null);
    const cached = cache.get(src);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = inFlight.get(src);
    if (pending) return pending;

    const task = new Promise((resolve) => {
        const video = document.createElement('video');
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            video.removeAttribute('src');
            try { video.load(); } catch { /* detaching is best-effort */ }
            cache.set(src, value);
            inFlight.delete(src);
            resolve(value);
        };
        // A clip that never fires `seeked` (a codec the browser half-supports)
        // would otherwise leave the tile spinning forever.
        const timer = setTimeout(() => finish(null), 8000);

        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.crossOrigin = 'anonymous';
        video.addEventListener('error', () => finish(null));
        video.addEventListener('loadeddata', () => {
            // Clamp into the clip: seeking past the end never fires `seeked`.
            const duration = Number(video.duration);
            const target = Number.isFinite(duration) && duration > 0
                ? Math.min(seconds, duration / 2)
                : seconds;
            try { video.currentTime = target; } catch { finish(null); }
        });
        video.addEventListener('seeked', () => {
            try {
                const sourceWidth = video.videoWidth;
                const sourceHeight = video.videoHeight;
                if (!sourceWidth || !sourceHeight) return finish(null);
                const canvas = document.createElement('canvas');
                canvas.width = Math.min(width, sourceWidth);
                canvas.height = Math.round(canvas.width * (sourceHeight / sourceWidth));
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                return finish(canvas.toDataURL('image/jpeg', 0.72));
            } catch {
                // Most likely a tainted canvas — the frame stays on screen in the
                // <video> element, it just cannot be read out.
                return finish(null);
            }
        });
        video.src = src;
    });

    inFlight.set(src, task);
    return task;
}

/**
 * Downscale an already-decodable image source to a poster-sized JPEG.
 *
 * The image path has no seek to worry about, but it has the same problem: the
 * tile is drawn from the full original, so every render of a saved-reference
 * list pays for the whole picture. Same cache, same never-rejects contract.
 */
export function captureImagePoster(src, { width = POSTER_WIDTH } = {}) {
    if (!src) return Promise.resolve(null);
    const cached = cache.get(src);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = inFlight.get(src);
    if (pending) return pending;

    const task = new Promise((resolve) => {
        const image = new Image();
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cache.set(src, value);
            inFlight.delete(src);
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), 8000);
        image.crossOrigin = 'anonymous';
        image.onerror = () => finish(null);
        image.onload = () => {
            try {
                if (!image.naturalWidth || !image.naturalHeight) return finish(null);
                const canvas = document.createElement('canvas');
                canvas.width = Math.min(width, image.naturalWidth);
                canvas.height = Math.round(canvas.width * (image.naturalHeight / image.naturalWidth));
                canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
                return finish(canvas.toDataURL('image/jpeg', 0.72));
            } catch {
                return finish(null); // most likely a tainted canvas
            }
        };
        image.src = src;
    });

    inFlight.set(src, task);
    return task;
}

// Test seam: the cache is process-wide by design (one decode per source per
// session), which makes it leak between test cases.
export function clearMediaPosterCache() {
    cache.clear();
    inFlight.clear();
}
