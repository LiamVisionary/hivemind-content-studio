// Head replacement: the arithmetic and the vocabulary, kept out of the dialog.
//
// The dialog is a canvas and a scrub bar; everything it has to be RIGHT about
// lives here, so the numbers it shows and the numbers the gateway is sent can
// never disagree. The frame-lattice maths in particular is a restatement of the
// MCP's own rule (packages/media-gateway/bin/media-studio-mcp.mjs), and it is
// restated deliberately: the dialog has to say "2.3 seconds of this clip" before
// anything is uploaded, and the only alternative is a round trip to be told.

// H3 samples on a 17n+5 frame lattice at 24 fps. Both numbers are the model's,
// not ours, and the workflow's frame_grid carries the same pair.
export const INPAINT_FPS = 24;
const GRID_MODULUS = 17;
const GRID_OFFSET = 5;

export const INPAINT_DEFAULTS = Object.freeze({
  maskSource: 'manual',
  sam3Prompt: 'head',
  sam3Threshold: 0.5,
  cropMode: 'tracked',
  cropScale: 1.75,
  cropMegapixels: 0.8,
  maskExpand: 30,
});

export const CROP_MODES = Object.freeze([
  {
    id: 'combined',
    label: 'Static',
    hint: 'One window around everywhere the subject goes. Steadiest, and the largest.',
  },
  {
    id: 'tracked',
    label: 'Follows',
    hint: 'A fixed-size window that moves only when the subject would leave it.',
  },
  {
    id: 'zoomed',
    label: 'Follows + zooms',
    hint: 'The window follows the subject’s size too. Tightest, and the most motion.',
  },
]);

/** The largest lattice point that does not exceed `frames`, or 0 below the first. */
export function gridFramesAtMost(frames) {
  const count = Math.floor(Number(frames) || 0);
  if (count < GRID_OFFSET) return 0;
  return GRID_OFFSET + Math.floor((count - GRID_OFFSET) / GRID_MODULUS) * GRID_MODULUS;
}

/**
 * How much of a clip can actually be inpainted.
 *
 * Snapped DOWN, never up: a length off the lattice is refused by the model
 * rather than rounded, and padding up to the next point would mean inventing
 * footage to paint over. `trimmed` is what lets the dialog say so rather than
 * quietly delivering a shorter clip than the one on screen.
 */
export function usableInpaintSeconds(durationSeconds) {
  const available = Math.floor(Math.max(0, Number(durationSeconds) || 0) * INPAINT_FPS);
  const frames = gridFramesAtMost(available);
  return {
    frames,
    seconds: frames / INPAINT_FPS,
    trimmed: frames > 0 && frames < available,
    // Below the first lattice point there is no legal length at all.
    tooShort: frames === 0,
  };
}

/**
 * When to sample frames for the coverage check.
 *
 * Both ends included: the first and last frames are exactly where a subject is
 * most likely to be outside a region painted somewhere in the middle, so a strip
 * that sampled only the interior would miss the failure it exists to catch.
 */
export function coverageTimestamps(usable, count) {
  const seconds = Math.max(0, Number(usable?.seconds ?? usable) || 0);
  const tiles = Math.max(2, Math.floor(Number(count) || 0));
  if (!seconds) return [0];
  // A hair inside the end: seeking exactly to the duration lands past the last
  // frame on some decoders and returns nothing.
  const last = Math.max(0, seconds - 1 / INPAINT_FPS);
  return Array.from({ length: tiles }, (_, index) => (last * index) / (tiles - 1));
}

export function describeCoverage(count, seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  return `${count} frames across ${total.toFixed(1)}s — the head must stay inside the region in every one`;
}

/** Whether a mask canvas still has anything painted on it. */
export function maskCoversFrames(canvas) {
  if (!canvas?.width || !canvas?.height) return false;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // Alpha only: the strokes are white, so any opaque pixel is painted mask.
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 8) return true;
  }
  return false;
}

/**
 * The dials to SEND — only the ones that differ from the workflow's own default.
 *
 * An unset dial is omitted rather than restated, so the registered graph stays
 * the single place each default is written down. Two copies of a default is one
 * copy to forget when it changes, and the copy that loses is always the one the
 * lane actually reads.
 */
export function inpaintDials(settings = {}) {
  const dials = {};
  const put = (key, value, fallback) => {
    if (value === undefined || value === null || value === '') return;
    if (Number.isFinite(fallback) ? Number(value) === fallback : value === fallback) return;
    dials[key] = Number.isFinite(fallback) ? Number(value) : value;
  };
  // SAM3's dials only mean anything on the SAM3 branch; sending them alongside a
  // painted mask would look like they applied.
  if (settings.maskSource === 'sam3') {
    put('sam3_prompt', String(settings.sam3Prompt || '').trim(), INPAINT_DEFAULTS.sam3Prompt);
    put('sam3_detection_threshold', settings.sam3Threshold, INPAINT_DEFAULTS.sam3Threshold);
  }
  put('crop_mode', settings.cropMode, INPAINT_DEFAULTS.cropMode);
  put('crop_scale', settings.cropScale, INPAINT_DEFAULTS.cropScale);
  put('crop_megapixels', settings.cropMegapixels, INPAINT_DEFAULTS.cropMegapixels);
  put('mask_expand', settings.maskExpand, INPAINT_DEFAULTS.maskExpand);
  return dials;
}
