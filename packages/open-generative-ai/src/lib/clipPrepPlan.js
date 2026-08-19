// Clip prep — the pure planner.
//
// Deliberately free of mediabunny: this module decides the NUMBERS (what to
// trim to, how to crop, what raster and frame rate to land on, what the
// reference will cost), and clipPrep.js executes them. Splitting them is not
// tidiness — mediabunny is heavy, and the studio chunk must not carry it until
// a clip is actually transformed, the same reason clipJoiner.js is imported
// dynamically. It also means every rule below is testable without WebCodecs.
//
// Why compress at all: H3's reference budget is spent on min(reference, clip)
// length, so a shorter, smaller reference frees the full generation range. A
// 12-second 1080p60 phone clip dropped straight into motion_context_* costs the
// whole budget and buys nothing — the model is reading MANNER of movement, not
// detail.

// Video codecs sample chroma at half resolution (4:2:0), so both dimensions
// must be even or the encoder either rejects the size or silently pads it.
// Round DOWN: growing a dimension to reach the target invents pixels, and a
// reference clip is never improved by an extra column of edge-replicated ones.
export function even(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

// The same rounding for an OFFSET, where zero is a legitimate value — a crop
// flush to the left edge starts at 0, not at the 2px floor a dimension needs.
export function evenOffset(value) {
  return Math.max(0, Math.floor(value / 2) * 2);
}

// The presets the reference lane actually wants. `maxEdge` caps the long side —
// aspect ratio is always preserved, because H3 reads a reference's motion and a
// stretched one teaches it stretched motion.
export const CLIP_QUALITY_PRESETS = [
  { id: 'source', label: 'Source', maxEdge: null, frameRate: null },
  { id: 'reference', label: 'Reference', maxEdge: 640, frameRate: 16 },
  { id: 'compact', label: 'Compact', maxEdge: 480, frameRate: 12 },
  { id: 'tiny', label: 'Tiny', maxEdge: 320, frameRate: 8 },
];

export function qualityPreset(id) {
  return CLIP_QUALITY_PRESETS.find((preset) => preset.id === id) || CLIP_QUALITY_PRESETS[0];
}

// Clamp a crop rectangle into the source raster. A crop arrives from a drag on
// a preview whose displayed size is not the coded size, so it can land a pixel
// or two outside; clamping here rather than trusting the caller keeps every
// entry point (drag, restored settings, an agent's numbers) on one rule.
export function clampCrop(crop, source) {
  const sourceWidth = Math.max(2, Math.floor(source?.width || 0));
  const sourceHeight = Math.max(2, Math.floor(source?.height || 0));
  if (!crop) return { left: 0, top: 0, width: sourceWidth, height: sourceHeight };

  // Offsets are rounded to even for the same 4:2:0 reason as the dimensions:
  // an odd origin puts the crop half a chroma sample off its luma grid.
  const left = Math.min(evenOffset(crop.left || 0), sourceWidth - 2);
  const top = Math.min(evenOffset(crop.top || 0), sourceHeight - 2);
  const width = even(Math.min(Math.max(2, Math.floor(crop.width || sourceWidth)), sourceWidth - left));
  const height = even(Math.min(Math.max(2, Math.floor(crop.height || sourceHeight)), sourceHeight - top));
  return { left, top, width, height };
}

// The crop shapes reference prep actually reaches for. Free-dragging a
// rectangle is the general case, but the common one is "this landscape phone
// clip needs to be a vertical reference" — and a centered aspect crop does that
// in one click without teaching H3 a letterboxed frame.
export const CROP_ASPECTS = [
  { id: 'source', label: 'Full frame', ratio: null },
  { id: 'square', label: '1:1', ratio: 1 },
  { id: 'vertical', label: '9:16', ratio: 9 / 16 },
  { id: 'portrait', label: '4:5', ratio: 4 / 5 },
  { id: 'wide', label: '16:9', ratio: 16 / 9 },
];

// The largest rectangle of the given ratio that fits inside the source,
// centered. A null ratio means the whole frame.
export function centeredCrop(source, ratio) {
  const width = Math.max(2, Math.floor(source?.width || 0));
  const height = Math.max(2, Math.floor(source?.height || 0));
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) {
    return { left: 0, top: 0, width: even(width), height: even(height) };
  }
  // Fit by whichever edge runs out first, so the crop never leaves the frame.
  const byWidth = width / ratio <= height;
  const cropWidth = even(byWidth ? width : height * ratio);
  const cropHeight = even(byWidth ? width / ratio : height);
  return {
    left: evenOffset((width - cropWidth) / 2),
    top: evenOffset((height - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  };
}

// Trim bounds, normalized against the real duration. An `end` past the clip is
// the common case (a slider dragged to the rail on a clip whose container
// duration rounds down), and it is not an error — it means "to the end".
export function normalizeTrim(trim, durationSeconds) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  if (!duration) return { start: 0, end: 0, seconds: 0 };

  let start = Math.min(Math.max(0, Number(trim?.start) || 0), duration);
  let end = trim?.end == null ? duration : Math.min(Math.max(0, Number(trim.end) || 0), duration);
  // A backwards range is a dragged-past-itself handle, not a reason to throw.
  if (end < start) [start, end] = [end, start];
  // A zero-length selection would produce a file with no frames; hold one frame
  // at 24fps rather than emitting something no decoder will open.
  if (end - start < 1 / 24) end = Math.min(duration, start + 1 / 24);
  return { start, end, seconds: end - start };
}

// The output raster, after cropping, capped to the preset's long edge.
export function resolveTargetSize(cropped, preset) {
  const width = Math.max(2, Math.floor(cropped?.width || 0));
  const height = Math.max(2, Math.floor(cropped?.height || 0));
  const maxEdge = preset?.maxEdge;
  if (!maxEdge || Math.max(width, height) <= maxEdge) {
    return { width: even(width), height: even(height), scaled: false };
  }
  const ratio = maxEdge / Math.max(width, height);
  return { width: even(width * ratio), height: even(height * ratio), scaled: true };
}

// One plan from one spec, so the dialog, a restored generation and an agent all
// compute the same numbers from the same inputs.
export function planClip(source, spec = {}) {
  const preset = qualityPreset(spec.quality || 'source');
  const trim = normalizeTrim(spec.trim, source?.duration);
  const crop = clampCrop(spec.crop, source);
  const size = resolveTargetSize(crop, preset);
  const sourceRate = Number(source?.frameRate) || 0;
  // Never raise the frame rate: duplicating frames to hit 16fps on an 8fps
  // source adds bytes and no motion information.
  const frameRate = preset.frameRate && (!sourceRate || preset.frameRate < sourceRate)
    ? preset.frameRate
    : null;
  const cropped = crop.width !== source?.width || crop.height !== source?.height;

  return {
    preset: preset.id,
    trim,
    crop,
    cropped,
    width: size.width,
    height: size.height,
    scaled: size.scaled,
    frameRate,
    dropAudio: spec.dropAudio === true,
    // A plan that changes nothing should not re-encode: passing the source
    // through Conversion would cost a generation of quality for no reason.
    lossless: !cropped && !size.scaled && !frameRate
      && trim.start === 0 && Math.abs(trim.seconds - (source?.duration || 0)) < 1e-3
      && spec.dropAudio !== true,
  };
}

// What the plan buys, in the terms the reference lane is actually rationed in.
// The budget is spent on min(reference, clip) length, so a reference already
// shorter than the shot is free and the readout should say so rather than
// implying more trimming helps.
export function referenceBudget(plan, clipSeconds) {
  const shot = Math.max(0, Number(clipSeconds) || 0);
  const reference = plan?.trim?.seconds || 0;
  const binding = shot > 0 ? Math.min(reference, shot) : reference;
  return {
    referenceSeconds: reference,
    clipSeconds: shot,
    bindingSeconds: binding,
    // Below the shot length the reference has stopped being the constraint.
    limitedByReference: shot > 0 && reference < shot,
    pixelsPerFrame: (plan?.width || 0) * (plan?.height || 0),
  };
}

// Evenly spaced storyboard timestamps across a trimmed range.
//
// Deliberately NOT scene-cut detection. QuickClip ships auto-detection and its
// own author calls the results iffy; an even sweep is predictable, explains
// itself, and never silently misses the moment someone trimmed to. Detection
// can arrive later as an opt-in on top of these.
export function storyboardTimestamps(trim, count) {
  const frames = Math.max(1, Math.min(24, Math.floor(count) || 1));
  const { start, seconds } = trim || {};
  const span = Math.max(0, Number(seconds) || 0);
  const from = Math.max(0, Number(start) || 0);
  if (frames === 1) return [from + span / 2];
  // Inset by half a step at each end: a tile exactly on the out-point lands on
  // the first frame of the NEXT shot on a hard cut.
  const step = span / frames;
  return Array.from({ length: frames }, (_, index) => from + step * (index + 0.5));
}
