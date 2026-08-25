// Cutting the background out of one animation frame.
//
// SAM3 is asked for the sprite BY NAME rather than for "the salient object",
// because a sprite clip routinely has something else moving in it — the
// butterfly the dragon is watching — and a matting net keeps whatever is most
// conspicuous. Naming the subject keeps the character and drops the scene.
//
// The round-trip is one frame at a time on purpose. A warm SAM3 run is ~20s and
// the first of a session loads a 3.45 GB checkpoint, so a twelve-frame sheet is
// minutes of work; batching it into a single request would only hide that wait
// somewhere the user cannot watch it or stop it.

// The mask comes back white-on-black. These are where that greyscale becomes
// alpha: below `cutoff` is background, above `solid` is sprite, and the ramp
// between keeps the mask's own antialiasing so the cut-out has an edge rather
// than a staircase.
export const DEFAULT_CUTOFF = 40;
export const DEFAULT_SOLID = 200;

/**
 * Alpha for one mask pixel. Pure so the ramp is testable without a canvas.
 * @param {number} luma 0-255 from the mask
 */
export function maskAlpha(luma, { cutoff = DEFAULT_CUTOFF, solid = DEFAULT_SOLID } = {}) {
  const low = Math.min(cutoff, solid);
  const high = Math.max(cutoff, solid);
  if (luma <= low) return 0;
  if (luma >= high) return 255;
  if (high === low) return luma >= high ? 255 : 0;
  return Math.round(((luma - low) / (high - low)) * 255);
}

/**
 * Write a mask into a frame's alpha channel, in place.
 *
 * Both buffers are plain {data, width, height} so this runs — and is tested —
 * without a DOM. The mask is expected to already be the frame's size; the
 * caller scales it when SAM3 hands back a different resolution.
 */
export function applyMaskToPixels(frame, mask, options = {}) {
  const { data, width, height } = frame;
  for (let index = 0; index < width * height; index += 1) {
    const at = index * 4;
    // The mask is greyscale, so any channel is the value; red avoids a
    // multiply per pixel over a million-pixel frame.
    data[at + 3] = maskAlpha(mask.data[at], options);
  }
  return frame;
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not read the mask.'));
    image.src = source;
  });
}

/** Ask the studio to cut one frame out. Returns a NEW canvas with alpha;
 *  the source frame is left intact so a failed matte can be retried against
 *  the original rather than against a half-erased copy. */
export async function matteFrame(frameCanvas, { subject = '', points = [], confidence = null, signal = null } = {}) {
  const response = await fetch('/api/sprite/matte', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      image_base64: frameCanvas.toDataURL('image/png'),
      subject,
      points,
      ...(confidence == null ? {} : { confidence }),
    }),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.detail || ''; } catch { detail = ''; }
    throw new Error(detail || 'Background removal failed.');
  }
  const { mask_base64: maskUrl } = await response.json();
  const mask = await loadImage(maskUrl);

  const width = frameCanvas.width;
  const height = frameCanvas.height;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const context = out.getContext('2d', { willReadFrequently: true });
  context.drawImage(frameCanvas, 0, 0);
  const framePixels = context.getImageData(0, 0, width, height);

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
  // Scaled to the frame: the graph's own canvas need not match the clip's, and
  // a mask read at the wrong size shears the cut-out diagonally.
  maskContext.drawImage(mask, 0, 0, width, height);

  applyMaskToPixels(framePixels, maskContext.getImageData(0, 0, width, height));
  context.putImageData(framePixels, 0, 0);
  return out;
}

/**
 * Matte a whole set of frames, one at a time, reporting progress.
 *
 * Stops at the first failure and hands back what it managed, WITH the reason:
 * four minutes into a twelve-frame sheet, a partial sheet the user can look at
 * beats a bare error that throws the finished frames away. The caller decides
 * whether eight of twelve cells is worth packing.
 *
 * @returns {Promise<{frames: HTMLCanvasElement[], error: string}>}
 */
export async function matteFrames(frames, { subject = '', onProgress = null, signal = null } = {}) {
  const matted = [];
  for (let index = 0; index < frames.length; index += 1) {
    if (signal?.aborted) return { frames: matted, error: '' };
    try {
      // eslint-disable-next-line no-await-in-loop -- one SAM3 run at a time, by design
      matted.push(await matteFrame(frames[index], { subject, signal }));
    } catch (error) {
      return { frames: matted, error: String(error?.message || error) };
    }
    onProgress?.(index + 1, frames.length);
  }
  return { frames: matted, error: '' };
}
