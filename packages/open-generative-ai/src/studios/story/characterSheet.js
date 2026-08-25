// Stage 2 — the character sheet: the identity contract every later generation
// is measured against.
//
// A sheet is not concept art. Its whole job is to be BORING enough to be
// reference: front, exact side, back, neutral posture, even light, nothing
// hidden behind a prop or a dramatic angle. The moment a sheet is drawn as a
// poster it stops answering the only question later stages ask of it — is this
// the same character?
//
// The locks are ranked because they fail in that order. A drifting silhouette
// is visible at thumbnail size and ruins a clip; a drifting freckle is not. So
// the prompt states them in priority order and the audit reads them back in the
// same order.

/** What must hold across every view, hardest-to-forgive first. */
export const IDENTITY_LOCKS = Object.freeze([
  { id: 'silhouette', label: 'Silhouette', hint: 'Body proportions, head-to-body ratio, hair mass, ears, tail, outer contour.' },
  { id: 'face', label: 'Face', hint: 'Eye shape, nose, mouth, apparent age, the resting expression.' },
  { id: 'pattern', label: 'Pattern', hint: 'Fur markings, hairline, scars, freckles, colour placement, fabric blocks.' },
  { id: 'signature', label: 'Signature', hint: 'The one accessory or accent still readable at thumbnail size.' },
  { id: 'behavior', label: 'Behaviour', hint: 'Default posture, repeated gesture, the role they play in the pair.' },
]);

/** Backgrounds that stay reference-friendly. A busy background makes the sheet
 *  unusable as a reference and unmattable as a cut-out. */
export const SHEET_BACKGROUNDS = Object.freeze([
  { id: 'neutral', label: 'Neutral grey', clause: 'a plain flat neutral grey background' },
  { id: 'palette', label: 'Project palette', clause: 'a plain flat background in the project palette' },
  { id: 'white', label: 'White', clause: 'a plain white background' },
]);

export function blankCharacter(name = '') {
  return {
    id: `c${Math.random().toString(36).slice(2, 8)}`,
    name,
    role: '',
    species: '',
    silhouette: '',
    face: '',
    pattern: '',
    signature: '',
    behavior: '',
    never: '',
    sheetUrl: '',
  };
}

const text = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const clause = (label, value) => (text(value) ? `${label}: ${text(value)}.` : '');

/** Everything the character is described by, in lock order. Used both in the
 *  sheet prompt and, later, as the identity line a board or a repair quotes. */
export function identityLines(character = {}) {
  return [
    clause('Who they are', [text(character.name), text(character.role), text(character.species)].filter(Boolean).join(', ')),
    clause('Silhouette', character.silhouette),
    clause('Face', character.face),
    clause('Pattern and colour placement', character.pattern),
    clause('Signature detail', character.signature),
    clause('Default posture and behaviour', character.behavior),
  ].filter(Boolean);
}

/**
 * The reference sheet prompt: three views on one canvas, locked to each other.
 *
 * The negative half matters as much as the positive half. Left to itself an
 * image model answers "character sheet" with an action pose, a prop, a dramatic
 * rim light and a name in a decorative typeface — four things that each make the
 * sheet worse at being a reference.
 */
export function characterSheetPrompt(character = {}, { style = '', background = 'neutral' } = {}) {
  const lines = identityLines(character);
  if (!lines.length) return '';
  const bg = SHEET_BACKGROUNDS.find((entry) => entry.id === background) || SHEET_BACKGROUNDS[0];
  const named = text(character.name) || 'the character';
  return [
    `One clean production reference sheet on ${bg.clause}.`,
    `Show ${named} in three full-body views on the same canvas: front, exact side profile, and back.`,
    ...lines,
    'Keep proportions, apparent age, silhouette, clothing construction, markings and the signature detail identical in all three views.',
    style ? `Style: ${text(style)}.` : '',
    'Neutral standing posture, even soft light, no dramatic perspective, no action pose, no extra props, no background scenery.',
    'Small view labels only — no title, no decorative typography, no borders, no collage.',
    'This is a reference sheet, not a poster.',
  ].filter(Boolean).join('\n');
}

/**
 * The audit run against a finished sheet before it is allowed to be a reference.
 *
 * Every item is a thing that has actually come back wrong from an image model
 * asked for three views at once: the strap swapping shoulders between front and
 * back, the collar tag appearing in one view only, a fifth finger, a second
 * scarf, a character who is visibly ten years older from behind.
 */
export const SHEET_AUDIT = Object.freeze([
  { id: 'face', label: 'Same face and apparent age in all three views' },
  { id: 'proportions', label: 'Same proportions and head-to-body ratio' },
  { id: 'silhouette', label: 'Same outer contour — hair mass, ears, tail, coat volume' },
  { id: 'pattern', label: 'Markings and colour placement land in the same places' },
  { id: 'sides', label: 'Accessories stay on the same side front-to-back' },
  { id: 'collar', label: 'Collar, tag, strap or badge present in every view that should show it' },
  { id: 'construction', label: 'Clothing is built the same way — seams, layers, closures' },
  { id: 'counts', label: 'Right number of limbs, fingers, ears and props' },
]);

/**
 * The one test worth running before any of the others: cover the detail and see
 * whether the three views still read as one character.
 */
export const SILHOUETTE_TEST = 'Cover the details. Do the three silhouettes still look like the same character?';

/** The never-change list, as a line the board and motion stages can quote
 *  verbatim. Falls back to the locks that were filled in, because an empty
 *  never-change list is how identity drift gets permission. */
export function neverChangeLine(character = {}) {
  const explicit = text(character.never);
  if (explicit) return explicit;
  const locked = [character.silhouette, character.face, character.pattern, character.signature]
    .map(text).filter(Boolean);
  return locked.join('; ');
}

/** Characters with nothing locked at all — the ones a board would invent. */
export function unlockedCharacters(characters = []) {
  return (Array.isArray(characters) ? characters : []).filter(
    (character) => !identityLines(character).length,
  );
}
