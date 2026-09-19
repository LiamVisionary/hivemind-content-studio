// "Circle a spot": draw a circle on a location picture to choose WHERE the clip
// takes place, and the model reads the mark.
//
// The mechanism is the plainest one there is, and it is the reason this works at
// all: the circle is drawn INTO the picture that is sent. H3 sees a photograph
// of a harbour with a red ring around one jetty, and the ring is as legible to
// it as the jetty. Nothing about it is a coordinate the node understands — there
// is no such input — so the only way to point at part of a reference is to mark
// the pixels and then say, in the prompt, what the mark means.
//
// Which is the other half, and the half that is easy to forget: a burned-in
// circle with a silent prompt is WORSE than no circle, because an unexplained
// red ring is just something in the picture, and what the model does with
// something in the picture is draw it. So every spot carries its own sentences
// (spotDefinitionSentence / spotRetentionLine / spotPlacementClause), the cast
// compiler writes them for any scene reference in `spot` mode, and Prompt Check
// refuses to let a circled picture reach a run that never mentions it.
//
// Geometry is stored NORMALIZED — the ellipse's bounding box as fractions of
// the picture — so the same spot re-renders at any resolution, survives a
// reload in the encrypted draft, and can be re-opened and nudged rather than
// redrawn. The circled picture is a second upload; the original is kept as
// `source`, which is what makes "remove the circle" free and exact.
import { regionThirds } from './regionPrompt.js';

/**
 * The mark's colour.
 *
 * Red is first because red is what has been shown to work, and because it is
 * the one colour almost nothing in a landscape photograph or a map already is.
 * The others exist for the pictures where it IS: a red-brick street, a Mars
 * plate, a map whose roads are drawn in red. The `word` is what the prompt
 * calls it, so the sentence and the pixels can never disagree.
 */
export const SPOT_COLORS = Object.freeze([
  { id: 'red', word: 'red', label: () => 'Red', hex: '#FF1F1F' },
  { id: 'yellow', word: 'yellow', label: () => 'Yellow', hex: '#FFE81F' },
  { id: 'cyan', word: 'cyan', label: () => 'Cyan', hex: '#1FE8FF' },
  { id: 'magenta', word: 'magenta', label: () => 'Magenta', hex: '#FF1FD0' },
]);

export const spotColor = (id) => SPOT_COLORS.find((entry) => entry.id === id) || SPOT_COLORS[0];

/**
 * What kind of picture is being circled, which decides one sentence.
 *
 * A map or an aerial view has to be TRANSLATED — the clip is shot on the
 * ground, in that place, not looking down at it — and saying so is the
 * difference between a street and a satellite photo with people painted on it.
 * A ground-level photograph needs no such instruction, and giving it one invites
 * the model to invent an aerial it was never shown.
 */
export const SPOT_VIEWS = Object.freeze([
  { id: 'photo', label: () => 'A photo', hint: () => 'Shot from the ground already — the circle just picks the part of it.' },
  { id: 'map', label: () => 'A map or aerial', hint: () => 'Looking down. The circled area is turned into a ground-level scene; no frame of the clip is a map.' },
]);

const isView = (id) => SPOT_VIEWS.some((entry) => entry.id === id);

// Smaller than this and there is nothing inside the ring to identify — and at
// H3's 768px short-edge reference canvas a 2% circle is about fifteen pixels
// across, which is not a place, it is a dot.
export const MIN_SPOT = 0.04;

const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));

/**
 * A spot as it is stored: `{ x, y, w, h }` fractions of the picture (the
 * ellipse's bounding box), the colour, the kind of view, and the URL of the
 * picture BEFORE the circle was drawn on it.
 *
 * Returns null for anything that is not a usable circle, so "is there a spot"
 * is one truthiness check everywhere rather than four field tests.
 */
export function normalizeSpot(spot) {
  if (!spot || typeof spot !== 'object') return null;
  const x = clamp01(spot.x);
  const y = clamp01(spot.y);
  // Clamped against the origin as well as against 1: a circle dragged off the
  // right edge keeps its left edge where the user put it and simply ends at the
  // picture's, rather than silently shrinking from both sides.
  const w = Math.min(clamp01(spot.w), 1 - x);
  const h = Math.min(clamp01(spot.h), 1 - y);
  if (w < MIN_SPOT || h < MIN_SPOT) return null;
  return {
    x,
    y,
    w,
    h,
    color: spotColor(spot.color).id,
    view: isView(spot.view) ? spot.view : 'photo',
    source: String(spot.source || ''),
  };
}

/**
 * Where to stroke the ellipse on a canvas of this size, and how thick.
 *
 * The thickness is the part that matters and the part that is easy to get
 * wrong. H3 stages a reference picture at a 768px short edge, so a hairline
 * drawn at a phone photo's native 4032px is under two pixels by the time the
 * model sees it — a circle that survives the editor's preview and not the
 * encode. A fraction of the short edge holds at every resolution; the floor
 * catches small pictures, where the same fraction would be invisible.
 */
export function spotGeometry(spot, width, height) {
  const normalized = normalizeSpot(spot);
  if (!normalized || !(width > 0) || !(height > 0)) return null;
  const short = Math.min(width, height);
  return {
    cx: (normalized.x + normalized.w / 2) * width,
    cy: (normalized.y + normalized.h / 2) * height,
    rx: (normalized.w / 2) * width,
    ry: (normalized.h / 2) * height,
    lineWidth: Math.max(3, Math.round(short * 0.012)),
    color: spotColor(normalized.color).hex,
  };
}

/** Stroke one spot onto a 2D context already holding the picture. */
export function drawSpot(ctx, spot, width, height) {
  const geometry = spotGeometry(spot, width, height);
  if (!ctx || !geometry) return false;
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = geometry.color;
  ctx.lineWidth = geometry.lineWidth;
  // The ring is drawn INSIDE the box the user dragged: a thick stroke centred
  // on the boundary of a circle at the picture's edge would be clipped in half.
  ctx.ellipse(
    geometry.cx,
    geometry.cy,
    Math.max(1, geometry.rx - geometry.lineWidth / 2),
    Math.max(1, geometry.ry - geometry.lineWidth / 2),
    0,
    0,
    Math.PI * 2,
  );
  ctx.stroke();
  ctx.restore();
  return true;
}

// Above this the extra pixels buy nothing — H3 stages reference pictures at a
// 768px short edge — and cost a multi-megabyte upload and a slow re-encode of
// every phone photograph. Never upscales.
const MAX_EDGE = 2048;

const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('That picture could not be read.'));
  image.src = src;
});

/**
 * The picture with the circle drawn on it, as a File ready to upload.
 *
 * Browser-only (canvas); the geometry and the language above are pure, which is
 * where the rules are proven. `src` must be a blob/object URL the page already
 * decrypted — a sealed reference URL would taint the canvas and `toBlob` would
 * throw, so callers pass what useMediaSrc resolved.
 */
export async function renderSpotFile(src, spot, { name = 'circled-spot' } = {}) {
  const normalized = normalizeSpot(spot);
  if (!normalized) throw new Error('Nothing is circled yet.');
  const image = await loadImage(src);
  const natural = { w: image.naturalWidth || image.width, h: image.naturalHeight || image.height };
  if (!natural.w || !natural.h) throw new Error('That picture could not be read.');
  const scale = Math.min(1, MAX_EDGE / Math.max(natural.w, natural.h));
  const width = Math.max(1, Math.round(natural.w * scale));
  const height = Math.max(1, Math.round(natural.h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // A picture with transparency composited straight to JPEG comes back with a
  // black sky. White is the honest ground for a plate or a plan.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  drawSpot(ctx, normalized, width, height);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error('The circled picture could not be encoded.'))),
      'image/jpeg',
      0.94,
    );
  });
  return new File([blob], `${String(name || 'circled-spot').replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
}

/* ── what the prompt is told ────────────────────────────────────────────── */

/** "top left" / "center" / "bottom right" — the same thirds the region boxes use. */
export function spotPlaceWords(spot) {
  const normalized = normalizeSpot(spot);
  if (!normalized) return '';
  const { h, v } = regionThirds(normalized);
  if (h === 'center' && v === 'middle') return 'center';
  if (v === 'middle') return h;
  if (h === 'center') return `${v} center`;
  return `${v} ${h}`;
}

/** "red circle, top left" — the row's own words for what is on the picture. */
export function describeSpot(spot) {
  const normalized = normalizeSpot(spot);
  if (!normalized) return '';
  return `${spotColor(normalized.color).word} circle, ${spotPlaceWords(normalized)}`;
}

/**
 * subject_definitions, for a picture carrying a circle.
 *
 * Three things, in the order they matter: the circle CHOOSES the location, the
 * circled area is to be read as a place you stand in, and the ring itself is an
 * annotation that must never be drawn. The third is not decoration — it is the
 * whole difference between a scene and a scene with a red ring hanging in it.
 *
 * The position is written out alongside the colour so the instruction survives
 * even when the mark does not: a picture squeezed to a 768px canvas and then
 * through a VAE can lose a thin ring, and "the upper left of <Picture 3>" still
 * points at the same place when it does.
 */
export function spotDefinitionSentence({ labels = [], spot, name = '' } = {}) {
  const normalized = normalizeSpot(spot);
  const label = labels[0];
  if (!normalized || !label) return '';
  const color = spotColor(normalized.color).word;
  const where = spotPlaceWords(normalized);
  const named = String(name || '').trim();
  const lines = [
    `${label} is a location guide: the place marked by the ${color} circle drawn on it, `
    + `in the ${where} of the picture${named ? ` — ${named}` : ''}. `
    + 'The circled area chooses where this clip is set.',
  ];
  lines.push(normalized.view === 'map'
    ? `${label} is seen from above, so the circled area is to be rendered as a believable ground-level scene in that `
      + 'same place, keeping its surroundings. No frame of this clip is a map, a plan view or an aerial shot.'
    : `Stay in the circled part of ${label} and keep the surrounding location consistent with it.`);
  lines.push(`The ${color} circle is an annotation marking the area and must NEVER appear in the video — `
    + `no ring, outline, highlight or marker of any kind is drawn in any frame. ${label} holds no subject and is not a person.`);
  return lines.join(' ');
}

/** retention_analysis, for the same picture. */
export function spotRetentionLine({ label, spot } = {}) {
  const normalized = normalizeSpot(spot);
  if (!normalized || !label) return '';
  const color = spotColor(normalized.color).word;
  return `${label}: attribute_transfer — read it as a POSITIONAL instruction. The ${color} circle identifies where `
    + 'the clip takes place and nothing more; the place around it — its architecture, materials, palette and light — '
    + `carries${normalized.view === 'map' ? ', translated from above into a ground-level view of the same place' : ''}. `
    + `Its exact framing is not copied, nobody in it is a subject, and the ${color} circle itself does not carry into `
    + 'a single frame.';
}

/**
 * The clause the auto-written summary gets, so the shot is set where the circle
 * is. Lowercase and unpunctuated: the summary decides whether it opens a
 * sentence or continues one, and a clause that arrives already capitalised can
 * only be used one of those two ways.
 */
export function spotPlacementClause({ label, spot } = {}) {
  const normalized = normalizeSpot(spot);
  if (!normalized || !label) return '';
  return `set in the area circled in ${label}, seen from the ground`;
}

/**
 * Does this prompt actually tell the model about the circle?
 *
 * Deliberately generous: the label named anywhere, or the word "circle" in any
 * sentence, counts. The failure this guards is total silence — a picture with a
 * ring burned into it reaching a run whose prompt never mentions it, where the
 * ring is just another object in the reference and gets painted into the clip.
 */
export function promptNamesSpot(prompt, label) {
  const text = String(prompt || '');
  if (!text.trim() || !label) return false;
  return text.includes(label) || /\bcircle[ds]?\b/i.test(text);
}
