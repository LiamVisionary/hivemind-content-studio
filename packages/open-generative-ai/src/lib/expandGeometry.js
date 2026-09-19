// Canvas-expansion targets: the source keeps (about) its pixel size and the
// canvas grows along one axis to reach the requested aspect. Constants follow
// Mix-Studio's outpaint plan (BlackMixture/Mix-Studio, GPL-3.0): /16 snapping
// and a total-pixel budget that bounds sampling cost.

export const EXPAND_MAX_PIXELS = 2_200_000;

const snap16 = (value) => Math.max(64, Math.floor(value / 16) * 16);

export function parseAspect(aspect) {
  const [w, h] = String(aspect || '').split(':').map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return w / h;
}

// Target canvas for expanding source (w×h) to `aspect`. Returns {width, height}
// or null when the target would not meaningfully grow the canvas (the gateway
// refuses non-growing targets, so the picker filters those aspects out).
export function computeExpandTarget(sourceWidth, sourceHeight, aspect, { maxPixels = EXPAND_MAX_PIXELS } = {}) {
  const sw = Number(sourceWidth), sh = Number(sourceHeight);
  const ratio = parseAspect(aspect);
  if (!ratio || !Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0) return null;
  let width, height;
  if (ratio >= sw / sh) {
    width = sh * ratio;
    height = sh;
  } else {
    width = sw;
    height = sw / ratio;
  }
  const pixels = width * height;
  if (pixels > maxPixels) {
    const scale = Math.sqrt(maxPixels / pixels);
    width *= scale;
    height *= scale;
  }
  width = snap16(width);
  height = snap16(height);
  // Growth check against the snapped source footprint: expanding a 1000px-wide
  // image by 16px is a border, not an outpaint.
  const grewX = width >= snap16(sw) + 32;
  const grewY = height >= snap16(sh) + 32;
  if (!grewX && !grewY) return null;
  return { width, height };
}
