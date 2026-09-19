// Pure geometry for the before/after compare viewer: contain-fit, anchored zoom,
// and pan clamping. Both images share ONE transform built from this state —
// that shared transform is what keeps them synchronized under zoom and pan.
//
// Adapted from Mix-Studio (BlackMixture/Mix-Studio, GPL-3.0) public/app.js
// compare-viewer math. See THIRD_PARTY_NOTICES.md.

export const COMPARE_ZOOM_MIN = 1;
export const COMPARE_ZOOM_MAX = 6;
export const WHEEL_ZOOM_IN = 1.16;
export const WHEEL_ZOOM_OUT = 0.86;

export function clampZoom(zoom) {
  const value = Number(zoom);
  if (!Number.isFinite(value)) return COMPARE_ZOOM_MIN;
  return Math.min(COMPARE_ZOOM_MAX, Math.max(COMPARE_ZOOM_MIN, value));
}

// Contain-fit natural dims inside the stage (never upscale past natural size
// decisions here — zoom handles magnification).
export function fitSize(naturalWidth, naturalHeight, stageWidth, stageHeight) {
  const nw = Math.max(1, Number(naturalWidth) || 1);
  const nh = Math.max(1, Number(naturalHeight) || 1);
  const sw = Math.max(1, Number(stageWidth) || 1);
  const sh = Math.max(1, Number(stageHeight) || 1);
  const scale = Math.min(sw / nw, sh / nh);
  return { width: nw * scale, height: nh * scale };
}

// Keep the scaled image covering the stage center: pan may not push the fitted
// image fully off either axis. When the zoomed image is smaller than the stage
// on an axis, that axis snaps back to 0.
export function clampPan(pan, fit, zoom, stage) {
  const maxX = Math.max(0, (fit.width * zoom - stage.width) / 2);
  const maxY = Math.max(0, (fit.height * zoom - stage.height) / 2);
  // `+ 0` folds the -0 that Math.max(-0, …) can produce back into plain 0.
  return {
    x: Math.min(maxX, Math.max(-maxX, Number(pan?.x) || 0)) + 0,
    y: Math.min(maxY, Math.max(-maxY, Number(pan?.y) || 0)) + 0,
  };
}

// Zoom while keeping the point under the pointer stationary. `anchor` is the
// pointer offset from the stage CENTER. Derivation: the anchor's image-space
// point must project to the same stage point before and after, which gives
// pan' = anchor - (anchor - pan) * (zoom'/zoom).
export function zoomAroundAnchor(pan, zoom, nextZoom, anchor) {
  const ratio = nextZoom / (zoom || 1);
  return {
    x: (anchor?.x || 0) - ((anchor?.x || 0) - (Number(pan?.x) || 0)) * ratio,
    y: (anchor?.y || 0) - ((anchor?.y || 0) - (Number(pan?.y) || 0)) * ratio,
  };
}

// 1:1 pixel zoom — how far to magnify so one image pixel is one screen pixel.
export function actualSizeZoom(naturalWidth, fittedWidth) {
  const nw = Number(naturalWidth) || 1;
  const fw = Math.max(1, Number(fittedWidth) || 1);
  return clampZoom(nw / fw);
}

export function clampSplit(split) {
  const value = Number(split);
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, value));
}
