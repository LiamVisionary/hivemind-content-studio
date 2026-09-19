// Turn a video into one image the prompt helper's vision model can read.
//
// A GGUF vision projector sees stills, not motion. Handing it a single frame
// of a source clip tells it nothing about what MOVES, which is the only thing
// a video prompt is really about. Laying evenly spaced frames out in reading
// order gives the model the shape of the action in one image — the same trick
// the ComfyUI H3 Prompt Writer uses, and the reason its previews show exactly
// what the model was shown.
//
// Everything happens in the browser on a decoded <video>: the clip itself is
// never uploaded, and the sheet goes to a llama-server on this machine.

export const DEFAULT_FRAME_COUNT = 6;
// Wide enough to read faces and gestures, small enough that six of them stay
// well inside the vision encoder's budget (measured: one image ~258 tokens).
const CELL_WIDTH = 384;

export function sheetLayout(count) {
    const columns = count <= 3 ? count : Math.ceil(Math.sqrt(count));
    return { columns, rows: Math.ceil(count / columns) };
}

/** Evenly spaced sample times, avoiding the very first and last frames —
 *  both are routinely black or a fade, which would waste two of six cells. */
export function sampleTimes(duration, count = DEFAULT_FRAME_COUNT) {
    if (!Number.isFinite(duration) || duration <= 0 || count < 1) return [];
    const usable = Math.max(duration - 0.06, 0);
    return Array.from({ length: count }, (_, index) => (
        Math.min(usable, (usable * (index + 0.5)) / count)
    ));
}

/** A coarse structural fingerprint of one drawn cell, cheap enough per frame. */
export function cellSignature(context, x, y, width, height) {
    const step = 8;
    const data = context.getImageData(x, y, width, height).data;
    const cellW = Math.max(1, Math.floor(width / step));
    const cellH = Math.max(1, Math.floor(height / step));
    const buckets = new Array(step * step).fill(0);
    for (let row = 0; row < step; row += 1) {
        for (let col = 0; col < step; col += 1) {
            let sum = 0;
            let count = 0;
            for (let sy = row * cellH; sy < (row + 1) * cellH; sy += 4) {
                for (let sx = col * cellW; sx < (col + 1) * cellW; sx += 4) {
                    const i = ((sy * width) + sx) * 4;
                    sum += (data[i] * 0.3) + (data[i + 1] * 0.59) + (data[i + 2] * 0.11);
                    count += 1;
                }
            }
            buckets[(row * step) + col] = count ? Math.round(sum / count / 8) : 0;
        }
    }
    return buckets.join(',');
}

function loadVideo(url) {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        video.crossOrigin = 'anonymous';
        video.onloadedmetadata = () => resolve(video);
        video.onerror = () => reject(new Error('could not decode that video'));
        video.src = url;
    });
}

function seekTo(video, time) {
    return new Promise((resolve, reject) => {
        const done = () => { video.removeEventListener('seeked', done); resolve(); };
        video.addEventListener('seeked', done);
        setTimeout(() => reject(new Error('timed out seeking the video')), 8000);
        video.currentTime = time;
    });
}

/**
 * Render `count` frames of `url` into a single JPEG data URL.
 * Returns null when the video cannot be decoded — the caller falls back to
 * writing from the idea alone rather than failing the whole request.
 */
export async function videoContactSheet(url, { count = DEFAULT_FRAME_COUNT } = {}) {
    if (!url) return null;
    let video;
    try {
        video = await loadVideo(url);
        const times = sampleTimes(video.duration, count);
        if (!times.length) return null;
        const { columns, rows } = sheetLayout(times.length);
        const aspect = (video.videoHeight || 9) / (video.videoWidth || 16);
        const cellHeight = Math.round(CELL_WIDTH * aspect);
        const canvas = document.createElement('canvas');
        canvas.width = CELL_WIDTH * columns;
        canvas.height = cellHeight * rows;
        const context = canvas.getContext('2d');
        context.fillStyle = '#000';
        context.fillRect(0, 0, canvas.width, canvas.height);
        const signatures = [];
        for (const [index, time] of times.entries()) {
            await seekTo(video, time);
            const x = (index % columns) * CELL_WIDTH;
            const y = Math.floor(index / columns) * cellHeight;
            context.drawImage(video, x, y, CELL_WIDTH, cellHeight);
            signatures.push(cellSignature(context, x, y, CELL_WIDTH, cellHeight));
        }
        // Some containers cannot be seeked in a browser — a MediaRecorder webm
        // has no seek index, so every seek lands on frame one and the "sheet"
        // is six copies of the opening frame. That is worse than no sheet: it
        // reads as motion the clip does not have.
        if (signatures.every((sig) => sig === signatures[0])) return null;
        return canvas.toDataURL('image/jpeg', 0.82);
    } catch {
        return null;
    } finally {
        if (video) { video.removeAttribute('src'); video.load?.(); }
    }
}
