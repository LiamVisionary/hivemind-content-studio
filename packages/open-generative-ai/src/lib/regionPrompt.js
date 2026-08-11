// Region boxes → spatial language. Draw a box, say what belongs in it, and the
// composer turns each box's CENTROID into a placement phrase attached to that
// region's description.
//
// The donor's own comment is why this needs no custom node: their regional node
// only masks LoRA/reference deltas, so for description-only regions it is the
// spatial LANGUAGE in the caption — not the box — that actually pins placement.
// That half is pure text, so it works against every image model we serve rather
// than one node's model family. Krea2RegionalMultiLoRAV3 (per-region LoRA and
// reference masking) is not installed on this stack; if it ever is, these same
// normalized regions are the input it wants.
//
// Our couple mode stays the simple path: two characters, one hard H/V split,
// enforced line-per-character. Regions are the freeform one.
//
// Adapted from Mix-Studio (BlackMixture/Mix-Studio, GPL-3.0)
// lib/regional-workflows.js — normalizeRegions / positionPhrase / elementDesc.
// See THIRD_PARTY_NOTICES.md.

export const REGION_COLORS = Object.freeze([
  '#46B4E6', '#E68246', '#82E646', '#E646B4', '#E6E646', '#46E6C8',
]);

// Donor caps nothing here, but a caption naming a dozen boxes stops steering
// anything. Six is the palette, and past that the phrases fight each other.
export const MAX_REGIONS = 6;

// The smallest box worth a sentence — also the donor's floor.
export const MIN_REGION_SIZE = 0.03;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function cleanText(value) {
  return String(value || '').trim();
}

/** Normalized (0-1) boxes, clamped to stay inside the frame. A region with
 *  nothing written in it describes nothing, so it is dropped rather than
 *  emitting a bare position phrase. */
export function normalizeRegions(input) {
  const source = Array.isArray(input) ? input : [];
  const out = [];
  for (const [index, region] of source.entries()) {
    if (out.length >= MAX_REGIONS) break;
    if (!region || typeof region !== 'object') continue;
    if (region.enabled === false) continue;
    const description = cleanText(region.description ?? region.desc ?? region.prompt);
    if (!description) continue;

    const x = clampNumber(region.x, 0, 1, 0.1);
    const y = clampNumber(region.y, 0, 1, 0.1);
    let w = clampNumber(region.w ?? region.width, MIN_REGION_SIZE, 1, 0.35);
    let h = clampNumber(region.h ?? region.height, MIN_REGION_SIZE, 1, 0.5);
    if (x + w > 1) w = Math.max(MIN_REGION_SIZE, 1 - x);
    if (y + h > 1) h = Math.max(MIN_REGION_SIZE, 1 - y);

    out.push({
      id: cleanText(region.id) || `region-${index + 1}`,
      description,
      x,
      y,
      w,
      h,
      enabled: true,
      color: cleanText(region.color) || REGION_COLORS[out.length % REGION_COLORS.length],
    });
  }
  return out;
}

const SPATIAL_WORDS = /\b(left|right|top|bottom|upper|lower|center|centre|middle|foreground|background|corner|above|below|beside|behind|front)\b/i;

/** Centroid → placement language. Thirds, not halves: a box has to lean
 *  decisively before it earns "left" or "right", so anything near the middle
 *  reads as centered instead of flipping on a pixel. */
export function positionPhrase(region) {
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  const hSpot = cx < 0.38 ? 'left' : cx > 0.62 ? 'right' : 'center';
  const vSpot = cy < 0.38 ? 'top' : cy > 0.62 ? 'bottom' : 'middle';
  if (region.w > 0.85 && region.h > 0.85) return 'filling the entire frame';
  if (region.w > 0.85) return `spanning the full width across the ${vSpot === 'middle' ? 'center' : vSpot} of the frame`;
  if (region.h > 0.85) return `occupying the full ${hSpot === 'center' ? 'middle column' : `${hSpot} half`} of the frame`;
  if (vSpot === 'middle' && hSpot === 'center') return 'positioned in the center of the frame';
  if (vSpot === 'middle') return `positioned on the ${hSpot} side of the frame`;
  if (hSpot === 'center') return `positioned in the ${vSpot} center of the frame`;
  return `positioned in the ${vSpot} ${hSpot} of the frame`;
}

/** A description that already places itself is left alone — "a wolf on the left"
 *  must not become "a wolf on the left, positioned in the middle left of the
 *  frame", which is how you get two contradictory placements in one caption. */
export function regionDescription(region) {
  const description = cleanText(region.description) || 'subject';
  if (SPATIAL_WORDS.test(description)) return description;
  return `${description}, ${positionPhrase(region)}`;
}

export function hasActiveRegions(input) {
  return normalizeRegions(input).length > 0;
}

/** The scene prompt first, then one placed sentence per region. Returns the
 *  base prompt untouched when nothing is drawn, so the composer is invisible
 *  until the user actually uses it.
 *
 *  Idempotent, like the style-preset and camera-motion composers: a sentence
 *  already present in the base is not added again. Restoring a past generation
 *  hands back BOTH its composed prompt and its boxes, and without this the next
 *  Generate would say everything twice. */
export function composeRegionalPrompt(basePrompt, regions) {
  const base = cleanText(basePrompt);
  const active = normalizeRegions(regions);
  if (!active.length) return base;
  const haystack = base.toLowerCase();
  const parts = base ? [base] : [];
  for (const region of active) {
    const sentence = regionDescription(region);
    if (haystack.includes(sentence.toLowerCase())) continue;
    parts.push(sentence);
  }
  return parts.map((part) => part.replace(/[\s.,;:]+$/, '')).join('. ');
}
