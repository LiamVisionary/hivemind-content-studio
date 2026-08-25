// Pulling the key frames out of a sprite animation.
//
// "Key frame" here means what an animator means, not what a codec means: the
// distinct POSES in the cycle. Sampling evenly is the obvious thing and it is
// wrong for exactly the clips this feature produces — an idle loop spends most
// of its length holding still, so twelve evenly spaced samples hand back nine
// copies of the same pose and miss the blink entirely.
//
// So: sample densely, fingerprint each frame, then keep the frames that are
// most different from the ones already kept. The fingerprint is the same
// coarse luma grid src/lib/contactSheet.js uses to lay out a vision-model
// contact sheet — it is cheap, it survives the compression a generated clip
// carries, and it is already proven on this kind of footage.
//
// Everything happens on a decoded <video> in the browser. The clip is one the
// user is already watching; it is never uploaded to pull frames out of it.

// How many candidates to fingerprint per frame we intend to keep. Four is
// enough that a fast gesture inside a slow loop has its own sample, without
// making a 15s clip decode a hundred times.
export const DEFAULT_OVERSAMPLE = 4;
export const DEFAULT_FRAME_COUNT = 8;
// Sprite sheets are square-cell grids; a cell wider than this is a poster, not
// a sprite. Frames are captured at the clip's own size and downscaled later.
const SIGNATURE_GRID = 8;

/** Evenly spaced sample times, skipping the very first and last frames — both
 *  are routinely a black or blended frame in a generated clip, which would
 *  spend two samples on nothing. */
export function sampleTimes(duration, count) {
  if (!Number.isFinite(duration) || duration <= 0 || count < 1) return [];
  const usable = Math.max(duration - 0.06, 0);
  return Array.from({ length: count }, (_, index) => (
    Math.min(usable, (usable * (index + 0.5)) / count)
  ));
}

/** Sum of absolute differences between two coarse luma grids. Unnormalised on
 *  purpose: it is only ever compared against other distances from the same
 *  clip, and a ratio would flatten the difference between "blinked" and
 *  "turned around". */
export function signatureDistance(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return Infinity;
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index] - right[index]);
  return total;
}

/**
 * Choose `count` frames that differ most from each other, then put them back
 * in time order.
 *
 * Farthest-point selection: start from the sample nearest the middle of the
 * clip (the pose most likely to be the character's rest state, and never the
 * fade at either end), then repeatedly take whichever remaining sample is
 * furthest from everything already chosen. Returning them in TIME order at the
 * end matters — a sprite sheet is read left to right as an animation, so a
 * sheet ordered by novelty would play as a scramble.
 *
 * @param {Array<{time:number, signature:number[]}>} samples
 * @param {number} count
 * @returns {number[]} indexes into `samples`, ascending by time
 */
export function pickDistinctFrames(samples, count = DEFAULT_FRAME_COUNT) {
  const total = Array.isArray(samples) ? samples.length : 0;
  if (!total || count < 1) return [];
  // No early return when count >= total: asking for as many frames as were
  // sampled must still drop the duplicates, or a held pose fills the sheet.
  const chosen = [Math.floor(total / 2)];
  // Distance from each sample to the NEAREST chosen one, maintained
  // incrementally so the selection stays O(count x total).
  const nearest = samples.map((sample) => signatureDistance(sample.signature, samples[chosen[0]].signature));
  nearest[chosen[0]] = -1;

  while (chosen.length < count) {
    let best = -1;
    let bestDistance = -1;
    for (let index = 0; index < total; index += 1) {
      if (nearest[index] > bestDistance) {
        bestDistance = nearest[index];
        best = index;
      }
    }
    // Every remaining sample is a duplicate of one already taken. Padding the
    // sheet with copies would be worse than a shorter sheet.
    if (best < 0 || bestDistance <= 0) break;
    chosen.push(best);
    nearest[best] = -1;
    for (let index = 0; index < total; index += 1) {
      if (nearest[index] < 0) continue;
      const distance = signatureDistance(samples[index].signature, samples[best].signature);
      if (distance < nearest[index]) nearest[index] = distance;
    }
  }
  return chosen.sort((left, right) => left - right);
}

/** Coarse luma grid of a canvas region — the fingerprint pickDistinctFrames
 *  compares. Steps across the pixels rather than reading all of them: a sprite
 *  pose changes at the scale of a limb, not a pixel. */
export function cellSignature(context, x, y, width, height, grid = SIGNATURE_GRID) {
  const data = context.getImageData(x, y, width, height).data;
  const cellW = Math.max(1, Math.floor(width / grid));
  const cellH = Math.max(1, Math.floor(height / grid));
  const buckets = new Array(grid * grid).fill(0);
  for (let row = 0; row < grid; row += 1) {
    for (let col = 0; col < grid; col += 1) {
      let sum = 0;
      let count = 0;
      for (let sy = row * cellH; sy < (row + 1) * cellH; sy += 2) {
        for (let sx = col * cellW; sx < (col + 1) * cellW; sx += 2) {
          const i = (((y + sy) * width) + (x + sx)) * 4;
          sum += (data[i] * 0.3) + (data[i + 1] * 0.59) + (data[i + 2] * 0.11);
          count += 1;
        }
      }
      buckets[(row * grid) + col] = count ? Math.round(sum / count) : 0;
    }
  }
  return buckets;
}

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.onloadedmetadata = () => resolve(video);
    video.onerror = () => reject(new Error('Could not decode that clip.'));
    video.src = url;
  });
}

function seekTo(video, time) {
  return new Promise((resolve, reject) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    setTimeout(() => reject(new Error('Timed out seeking the clip.')), 8000);
    video.currentTime = time;
  });
}

/**
 * Decode a clip and hand back its key frames as canvases, in time order.
 * @param {string} url an in-app media URL the browser can already play
 * @param {{count?:number, oversample?:number, onProgress?:(done:number,total:number)=>void, signal?:AbortSignal}} options
 * @returns {Promise<{frames: Array<{time:number, canvas:HTMLCanvasElement}>, width:number, height:number, duration:number}>}
 */
export async function extractKeyFrames(url, {
  count = DEFAULT_FRAME_COUNT,
  oversample = DEFAULT_OVERSAMPLE,
  onProgress = null,
  signal = null,
} = {}) {
  const video = await loadVideo(url);
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error('That clip has no picture to sample.');

  const candidateCount = Math.max(count, Math.min(96, Math.round(count * Math.max(1, oversample))));
  const times = sampleTimes(video.duration, candidateCount);
  const samples = [];
  for (let index = 0; index < times.length; index += 1) {
    if (signal?.aborted) throw new Error('Cancelled');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    // eslint-disable-next-line no-await-in-loop -- one decoder, one seek at a time
    await seekTo(video, times[index]);
    context.drawImage(video, 0, 0, width, height);
    samples.push({ time: times[index], canvas, signature: cellSignature(context, 0, 0, width, height) });
    onProgress?.(index + 1, times.length);
  }
  const kept = pickDistinctFrames(samples, count);
  return {
    frames: kept.map((index) => ({ time: samples[index].time, canvas: samples[index].canvas })),
    width,
    height,
    duration: video.duration,
  };
}
