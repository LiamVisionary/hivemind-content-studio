// Resolution tiers for reference-driven edits (BigLove Klein 3 today).
//
// An edit takes its SHAPE from the reference image — the gateway reshapes the
// canvas onto the source's aspect so the edit never distorts it — so the studio
// cannot offer a short side or an aspect the way a text-to-image workflow does.
// What it CAN offer is the pixel budget: how much canvas the edit gets, which is
// what actually trades speed against detail. Each tier is named by the short side
// of the model's own 2:3 trained bucket, so 1024 is exactly its native 1024x1536.
//
// Mirrors snap_biglove_klein3_resolution() in packages/media-gateway/app.py
// (bucket 1024x1536, budget clamped to 512x512 … 1152x1728) — keep the two in
// step; the server clamps whatever arrives, this is what the panel promises.

export const EDIT_BUCKET_ASPECT = 1.5;
export const EDIT_NATIVE_SHORT_SIDE = 1024;
export const EDIT_SHORT_SIDES = [1152, 1024, 896, 768, 640, 512];
export const EDIT_MIN_PIXELS = 512 * 512;
export const EDIT_MAX_PIXELS = 1152 * 1728;

const snap32 = (value) => Math.max(32, Math.round(value / 32) * 32);

// The tier a stored short side belongs to. Anything off-list (a text-to-image
// resolution carried over by the shared Resolution control, an out-of-range
// persisted value) lands on the nearest offered tier rather than rendering a
// select with no selected option.
export function nearestEditShortSide(shortSide) {
  const requested = Number(shortSide);
  if (!Number.isFinite(requested) || requested <= 0) return EDIT_NATIVE_SHORT_SIDE;
  return EDIT_SHORT_SIDES.reduce(
    (best, size) => (Math.abs(size - requested) < Math.abs(best - requested) ? size : best),
    EDIT_NATIVE_SHORT_SIDE,
  );
}

// The pixel budget for a tier, as the bucket-shaped canvas that carries it.
// width/height are what the studio sends: the server keeps their product and
// swaps in the reference's aspect.
export function editBudgetForShortSide(shortSide) {
  const base = nearestEditShortSide(shortSide);
  const width = snap32(base);
  const height = snap32(base * EDIT_BUCKET_ASPECT);
  const pixels = width * height;
  return {
    shortSide: base,
    width,
    height,
    pixels,
    megapixels: pixels / 1e6,
    native: base === EDIT_NATIVE_SHORT_SIDE,
  };
}

// What the edit will actually render for a given reference — the server's
// _reshape_dims_to_image_aspect(): same pixel budget, the source's aspect
// (clamped at 3:1 either way so a degenerate strip cannot blow up one side).
// Returns null when the reference has not been measured yet.
export function editOutputDimensions(budget, referenceWidth, referenceHeight) {
  const pixels = Number(budget?.pixels);
  const refW = Number(referenceWidth);
  const refH = Number(referenceHeight);
  if (!Number.isFinite(pixels) || pixels <= 0) return null;
  if (!Number.isFinite(refW) || !Number.isFinite(refH) || refW <= 0 || refH <= 0) return null;
  const aspect = Math.max(1 / 3, Math.min(3, refW / refH));
  const width = Math.sqrt(pixels * aspect);
  return { width: snap32(width), height: snap32(width / aspect) };
}
