// Turntable — a MiniMax clip used as a CAPTURE rather than as a performance.
//
// The recipe is not ours. It is the one the community worked out for turning a
// MiniMax generation into a photogrammetry capture: freeze the subject like a
// statue, orbit the camera around it in one unbroken shot, and — the part
// everybody forgets — pin the SAME picture as both the start and the end frame,
// so the sweep closes the loop instead of drifting into a different subject on
// the far side. Extract the frames, run COLMAP with SIMPLE_PINHOLE, hand the
// reconstruction to a Gaussian-splat trainer.
//
// Written by hand it is four sentences that have to be exactly right, a frame
// slot that has to be filled twice with one picture, and a frame extraction
// nobody wants to do by hand. So this module owns the recipe and the studio
// owns one dial.
//
// THE ANGLE CONVENTION, because two representations have to agree.
// An angle is measured around the subject, in degrees, 0° = the camera is
// directly in front of the subject's face, INCREASING CLOCKWISE AS SEEN FROM
// ABOVE — which walks the camera toward the subject's RIGHT side. That is why
// 90° is the right profile and 270° is the left one. The dial draws this and
// the prose names it, out of the SAME numbers, so a dial that says
// "three-quarter, subject's right" cannot disagree with a prompt that says
// something else.
//
// Effect-free on purpose: no React, no vault, no network. The composed text and
// the angle arithmetic are the parts that have to be provable, and the tests
// read them straight.
import { CAMERA_FRAMINGS, CAMERA_LENSES, CAMERA_VIEWPOINTS } from './h3Camera.js';

/* ---------------- the vocabulary ---------------- */

const pairs = (list) => Object.freeze(list.map((row) => Object.freeze(row)));

/** How far around the subject the camera travels. */
export const TURNTABLE_ARCS = pairs([
  [360, 'Full 360°'],
  [270, 'Three-quarter turn'],
  [180, 'Half turn'],
  [120, 'Wide arc'],
  [90, 'Quarter turn'],
  [45, 'Short arc'],
]);

/** Which way round. Clockwise is seen from above — the camera walks toward the
 *  subject's right, which is the direction the angle numbers increase in. */
export const TURNTABLE_DIRECTIONS = pairs([
  ['cw', 'Clockwise'],
  ['ccw', 'Counter-clockwise'],
]);

/**
 * The eight positions on the dial, as the angle AND as the viewpoint the shot
 * vocabulary already has a name for. One list, so a preset chip, the dial's
 * tick and the composed sentence are three readings of one fact.
 *
 * `viewpoint` is a CAMERA_VIEWPOINTS id; the labels come from there rather than
 * being retyped, so renaming a viewpoint renames it here too.
 */
export const TURNTABLE_POSITIONS = pairs([
  [0, 'front'],
  [45, 'front_3q_right'],
  [90, 'right_profile'],
  [135, 'rear_3q_right'],
  [180, 'behind'],
  [225, 'rear_3q_left'],
  [270, 'left_profile'],
  [315, 'front_3q_left'],
]);

const VIEWPOINT_LABEL = new Map(CAMERA_VIEWPOINTS.map(([id, label]) => [id, label]));

/** How high the lens rides while it orbits. A turntable holds ONE elevation —
 *  a rig that climbs while it turns is a different (and much harder) capture. */
export const TURNTABLE_ELEVATIONS = pairs([
  ['eye_level', 'Eye level'],
  ['slightly_low', 'Slightly low'],
  ['low', 'Low — looking up'],
  ['slightly_high', 'Slightly high'],
  ['high', 'High — looking down'],
  ['three_quarter_high', 'Raised three-quarter'],
]);

const ELEVATION_CLAUSE = {
  eye_level: 'at eye level',
  slightly_low: 'slightly below eye level, looking gently upward',
  low: 'low, looking upward',
  slightly_high: 'slightly above eye level, looking gently downward',
  high: 'high, looking downward',
  three_quarter_high: 'raised to a three-quarter height, looking gently downward',
};

/** How fast it goes round. H3's own speed qualifiers, spelled the way the model
 *  was trained to read them (h3Camera.js CAMERA_SPEEDS). */
export const TURNTABLE_SPEEDS = pairs([
  ['', 'Even'],
  ['at slow speed', 'Slow'],
  ['at fast speed', 'Fast'],
]);

/** What the frozen thing IS. Only ever a noun phrase — it is dropped into the
 *  middle of the sentences below. */
export const TURNTABLE_SUBJECTS = pairs([
  ['the character', 'Character'],
  ['the subject', 'Subject'],
  ['the product', 'Product'],
  ['the object', 'Object'],
  ['the vehicle', 'Vehicle'],
  ['the building', 'Building'],
]);

export { CAMERA_FRAMINGS, CAMERA_LENSES };

/* ---------------- the rig ---------------- */

/** Every field present, so React inputs stay controlled and the serializer
 *  never has to guard for undefined. */
export function blankTurntable() {
  return {
    subject: 'the character',
    arc: 360,
    direction: 'cw',
    startAngle: 0,
    elevation: 'eye_level',
    framing: 'medium_wide',
    lens: 'natural',
    speed: '',
    // Off, the capture keeps the freeze and the orbit but stops insisting the
    // light is nailed down — which is what you want when the turntable is being
    // used as a look-around rather than as a reconstruction.
    lockLighting: true,
  };
}

const ARC_VALUES = new Set(TURNTABLE_ARCS.map(([value]) => value));
const DIRECTIONS = new Set(TURNTABLE_DIRECTIONS.map(([value]) => value));
const ELEVATIONS = new Set(TURNTABLE_ELEVATIONS.map(([value]) => value));
const SPEEDS = new Set(TURNTABLE_SPEEDS.map(([value]) => value));
const FRAMINGS = new Set(CAMERA_FRAMINGS.map(([value]) => value));
const LENSES = new Set(CAMERA_LENSES.map(([value]) => value));

/** 0 ≤ angle < 360, for any finite input including negatives. */
export function normalizeAngle(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return ((n % 360) + 360) % 360;
}

/**
 * Every field falls back to its default, so a partially corrupt blob — a rig
 * restored from an older settings snapshot, say — still yields a complete and
 * valid capture rather than a half-applied one. Bounded by the option banks
 * above: nothing else can reach the prompt through here.
 */
export function normalizeTurntable(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const blank = blankTurntable();
  const arc = Number(source.arc);
  return {
    subject: String(source.subject || '').trim() || blank.subject,
    arc: ARC_VALUES.has(arc) ? arc : blank.arc,
    direction: DIRECTIONS.has(source.direction) ? source.direction : blank.direction,
    startAngle: normalizeAngle(source.startAngle),
    elevation: ELEVATIONS.has(source.elevation) ? source.elevation : blank.elevation,
    framing: FRAMINGS.has(source.framing) ? source.framing : blank.framing,
    lens: LENSES.has(source.lens) ? source.lens : blank.lens,
    speed: SPEEDS.has(source.speed) ? source.speed : blank.speed,
    lockLighting: source.lockLighting !== false,
  };
}

/* ---------------- angles ---------------- */

/** The nearest named position to an angle, as `[degrees, viewpointId]`. */
export function nearestPosition(angle) {
  const a = normalizeAngle(angle);
  let best = TURNTABLE_POSITIONS[0];
  let bestGap = 360;
  for (const row of TURNTABLE_POSITIONS) {
    const gap = Math.min(Math.abs(a - row[0]), 360 - Math.abs(a - row[0]));
    if (gap < bestGap) { bestGap = gap; best = row; }
  }
  return best;
}

/** What the camera is looking at, in words, at a given angle. */
export function angleLabel(angle) {
  const [, viewpoint] = nearestPosition(angle);
  return VIEWPOINT_LABEL.get(viewpoint) || 'Unspecified';
}

/** Where the camera is, `fraction` of the way through the shot (0 → 1). */
export function turntableAngleAt(rig, fraction) {
  const r = normalizeTurntable(rig);
  const t = Math.min(1, Math.max(0, Number(fraction) || 0));
  const travelled = r.arc * t * (r.direction === 'ccw' ? -1 : 1);
  return normalizeAngle(r.startAngle + travelled);
}

/**
 * The inverse: how far through the shot the camera passes `angle`, or null when
 * the sweep never reaches it. A 90° arc leaves three quarters of the circle
 * unseen, and answering "0.0" for an angle that was never captured is how a
 * grabbed frame ends up being of the wrong side of someone's head.
 */
export function turntableFractionFor(rig, angle) {
  const r = normalizeTurntable(rig);
  const delta = normalizeAngle(
    r.direction === 'ccw' ? r.startAngle - normalizeAngle(angle) : normalizeAngle(angle) - r.startAngle,
  );
  // A full turn sweeps everything; 360 and 0 are the same angle, so the wrap
  // has to resolve to the END of the shot rather than to its start.
  if (r.arc >= 360) return delta === 0 ? 0 : delta / 360;
  if (delta > r.arc) return null;
  return r.arc === 0 ? 0 : delta / r.arc;
}

/** The timestamp in a rendered clip that shows `angle`, or null if unswept. */
export function turntableTimeFor(rig, angle, durationSeconds) {
  const fraction = turntableFractionFor(rig, angle);
  if (fraction === null) return null;
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  // The last frame is at duration - one frame, not at duration: seeking to the
  // exact end of a clip parks on a blank or on whatever the decoder had last.
  return Math.min(duration - 0.04, fraction * duration);
}

/**
 * Evenly spaced sample times across the whole clip, for the photogrammetry
 * export.
 *
 * Deliberately NOT contactSheet.js's sampleTimes: that one skips the first and
 * last frames because a fade would waste two of six cells in a thumbnail. Here
 * the ends are the most valuable frames in the file — they are the two views
 * that overlap each other and close the loop — so they are kept, and the
 * spacing is uniform so every frame is the same angular step from its
 * neighbour. Uniform angular spacing is what COLMAP's matcher wants.
 */
export function orbitSampleTimes(durationSeconds, count) {
  const duration = Number(durationSeconds);
  const n = Math.floor(Number(count));
  if (!Number.isFinite(duration) || duration <= 0 || !(n >= 2)) return [];
  const last = Math.max(0, duration - 0.04);
  return Array.from({ length: n }, (_, index) => (last * index) / (n - 1));
}

/** Degrees between consecutive exported frames — the number a photogrammetry
 *  user actually reasons about. Under about 5° is comfortable overlap. */
export function degreesPerFrame(rig, count) {
  const r = normalizeTurntable(rig);
  const n = Math.floor(Number(count));
  if (!(n >= 2)) return 0;
  return r.arc / (n - 1);
}

/* ---------------- the prompt block ---------------- */

// The block is found by ANCHORS rather than by an exact match, so a capture the
// user has edited by hand still comes out cleanly when it is re-armed or
// cleared. The opening anchor is mid-sentence (the subject noun comes before
// it and varies), so stripping walks BACK to the start of that sentence; the
// closing one ends the block, so it walks FORWARD to the end of its own.
//
// Both anchors are load-bearing sentences of the recipe rather than optional
// decoration — the freeze and the no-cuts line are the two instructions that
// make the difference between a capture and a performance — so neither can be
// switched off, and the anchors are therefore always present.
export const TURNTABLE_OPENING = 'remains completely frozen in place';
export const TURNTABLE_CLOSING = 'no cuts';

const FRAMING_CLAUSE = {
  extreme_close_up: 'an extreme close-up',
  close_up: 'a close-up',
  medium_close_up: 'a medium close-up',
  medium: 'a medium shot',
  medium_wide: 'a medium-wide shot',
  wide: 'a wide full shot',
  extreme_wide: 'an extreme-wide frame',
  insert: 'an insert close-up',
  two_shot: 'a two-shot',
  over_shoulder: 'an over-the-shoulder frame',
};

const LENS_CLAUSE = {
  wide: 'A wide-angle lens is used.',
  natural: 'A natural-perspective lens keeps familiar proportions, without wide-angle distortion or telephoto compression.',
  telephoto: 'A moderate telephoto lens compresses the apparent depth of the background.',
  macro: 'A macro lens resolves fine detail at very close range.',
};

// The camera's starting side, said as a position rather than as a viewpoint id.
const START_CLAUSE = {
  front: 'directly in front of',
  front_3q_right: 'at a front three-quarter angle favouring the right side of',
  right_profile: 'on the right profile of',
  rear_3q_right: 'at a rear three-quarter angle favouring the right side of',
  behind: 'directly behind',
  rear_3q_left: 'at a rear three-quarter angle favouring the left side of',
  left_profile: 'on the left profile of',
  front_3q_left: 'at a front three-quarter angle favouring the left side of',
};

/**
 * The capture as prose — four sentences in the order the model reads them:
 * what is frozen, what the camera does, what must not change, and what must not
 * happen. The negation sentence is last on purpose; H3 weights a trailing
 * constraint more heavily than one buried mid-paragraph.
 */
export function turntableSentence(rig) {
  const r = normalizeTurntable(rig);
  const subject = r.subject;
  const [, startViewpoint] = nearestPosition(r.startAngle);
  const direction = r.direction === 'ccw' ? 'counter-clockwise' : 'clockwise';
  const speed = r.speed ? ` ${r.speed}` : '';
  const framing = FRAMING_CLAUSE[r.framing] || '';

  const freeze = `${subject[0].toUpperCase()}${subject.slice(1)} ${TURNTABLE_OPENING}, perfectly still like a statue.`;

  const orbit = [
    `The camera smoothly orbits ${r.arc} degrees ${direction}${speed} around ${subject} in one continuous shot`,
    `, starting ${START_CLAUSE[startViewpoint] || 'directly in front of'} ${subject}`,
    `, held ${ELEVATION_CLAUSE[r.elevation] || ELEVATION_CLAUSE.eye_level}`,
    framing ? `, holding ${framing} throughout` : '',
    '.',
  ].join('');

  const hold = r.lockLighting
    ? `The lighting, the background and the distance to ${subject} stay exactly constant for the whole orbit.`
    : `The distance to ${subject} stays constant for the whole orbit.`;

  // TURNTABLE_CLOSING already carries its own 'no' — it is the anchor phrase,
  // not a bare noun — so this line must not add a second one.
  const negate = `No ${r.subject === 'the character' ? 'character' : 'subject'} movement, no pose change, ${TURNTABLE_CLOSING}.`;

  const lens = LENS_CLAUSE[r.lens] || '';
  return [freeze, orbit, hold, lens, negate].filter(Boolean).join(' ');
}

/** Where the block starts in `prompt`, and where it ends — or null. */
function blockRange(prompt) {
  const source = String(prompt || '');
  const anchor = source.indexOf(TURNTABLE_OPENING);
  if (anchor < 0) return null;
  const close = source.indexOf(TURNTABLE_CLOSING, anchor);
  if (close < 0) return null;
  // Back to the start of the freeze sentence: the character after the previous
  // terminator, or the head of the prompt.
  let start = 0;
  for (let i = anchor; i > 0; i -= 1) {
    if ('.!?\n'.includes(source[i - 1])) { start = i; break; }
  }
  // Forward to the end of the negation sentence.
  let end = close + TURNTABLE_CLOSING.length;
  while (end < source.length && !'.!?\n'.includes(source[end])) end += 1;
  if (end < source.length && '.!?'.includes(source[end])) end += 1;
  return { start, end };
}

/**
 * Whether the capture is armed is a property of the PROMPT, not of a flag
 * beside it. "Start fresh", loading a saved prompt, or restoring a
 * generation's settings all replace the prompt without knowing about the
 * turntable; reading the block back is what keeps the chip from claiming a
 * capture the composer no longer holds. (Same contract as cameraRig.js.)
 */
export function hasTurntable(prompt) {
  return blockRange(prompt) !== null;
}

/** Cut a previously applied capture out, along with the whitespace that joined
 *  it to the text around it. */
export function stripTurntable(prompt) {
  const source = String(prompt || '');
  const range = blockRange(source);
  if (!range) return source.trim();
  const head = source.slice(0, range.start).replace(/[ \t]+$/, '');
  const tail = source.slice(range.end).replace(/^[ \t]+/, '');
  return `${head}${head && tail ? ' ' : ''}${tail}`.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Arm (or re-arm, or clear) the capture on a prompt. Passing a null rig strips.
 * Re-arming strips first, so five tweaks of the dial leave ONE capture block,
 * never a stack of them.
 */
export function applyTurntable(prompt, rig) {
  const base = stripTurntable(prompt);
  if (!rig) return base;
  const block = turntableSentence(rig);
  if (!base) return block;
  return `${base}${/[.!?\n]$/.test(base) ? ' ' : '. '}${block}`;
}

/* ---------------- which MiniMax lane is this, and can it close the loop ---- */

/**
 * Is the selected model a MiniMax one, by WHOEVER runs it — this Mac, a rented
 * box, the hosted credit lane, or the provider's own API?
 *
 * Deliberately NOT videoTasks.js's isMinimaxFamilyModel, and the difference
 * matters. That one answers a GRAPH question ("does this run through the local
 * MiniMax H3 workflow, so do the H3 graph's controls apply") and refuses to
 * read the cloud catalog's `family` field, because that is a separate namespace
 * that happens to collide. This one answers a VENDOR question ("did MiniMax
 * train the weights behind this row"), which is the right question for a
 * capture recipe that is a property of the model's behaviour rather than of any
 * one graph. Reading them the other way round is how a remote provider's model
 * would inherit the local graph's controls.
 */
export function isMinimaxVendorModel(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const provider = String(entry.provider || '').toLowerCase();
  if (provider === 'minimax') return true;
  const haystack = [
    entry.modelFamily, entry.workflowFamily, entry.family, entry.modelId, entry.id,
  ].map((value) => String(value || '').toLowerCase()).join(' ');
  return /minimax|hailuo/.test(haystack);
}

/**
 * Can this lane pin the same picture at both ends, and if not, what is the way
 * out? Never a bare "no": a capture that cannot close its loop is still worth
 * rendering, and the lanes that can are worth naming.
 *
 * `canPin` is passed in rather than derived here on purpose. The studio already
 * decides whether an end frame is offered at all — one rule that weighs the
 * local registry's `end_image_*` slot, the cloud row's `lastImageField`, the
 * LTX three-slot picker and an attached source clip together — and a second
 * copy of that rule living in here is exactly how the panel would end up
 * promising a pin the composer has no slot for.
 */
export function turntableLoopReadiness({ canPin = false, hasStartFrame = false } = {}) {
  // The missing PICTURE is reported first, and the order is load-bearing rather
  // than cosmetic. Several models only grow an end-frame slot once a start
  // frame puts them on their image-to-video lane — a cloud MiniMax row is
  // exactly this — so with no picture attached, `canPin` is false on a lane
  // that pins perfectly well. Leading with the lane there produced the one
  // sentence a panel must never say: "pick Hailuo 02 Standard", read while
  // standing on Hailuo 02 Standard. Attaching the picture is the true next step
  // either way, and if the lane still has no slot afterwards, it is then said
  // plainly and truly.
  if (!hasStartFrame) {
    return {
      canPin,
      ready: false,
      reason: 'Nothing to orbit yet — and with no picture, nothing to pin at either end.',
      fix: 'Attach the picture you want to orbit as the start frame. Arming then pins the same picture as the end frame, which is what closes the loop.',
    };
  }
  if (!canPin) {
    return {
      canPin: false,
      ready: false,
      reason: 'This lane takes no end frame, so the orbit is free to drift — the far side may not match the near one.',
      fix: 'Pick a lane with a Start / End pair (MiniMax H3, or Hailuo 02 Standard / Pro) to close the loop.',
    };
  }
  return { canPin: true, ready: true, reason: '', fix: '' };
}

/* ---------------- the handoff to COLMAP ---------------- */

/** Frame counts the export offers. A 360° sweep at 72 frames is one frame every
 *  5°, which is the coarse end of comfortable for a matcher. */
export const TURNTABLE_FRAME_COUNTS = Object.freeze([36, 72, 120, 180]);

/** Longest edge of an exported frame. COLMAP gains nothing from 4K here and
 *  feature extraction gets much slower, so the export is capped by default. */
export const TURNTABLE_EXPORT_WIDTHS = Object.freeze([1024, 1600, 2048, 0]);

/** Zero-padded so a plain alphabetical listing is also the orbit order — which
 *  is what COLMAP's sequential matcher assumes. */
export function frameFileName(index, total) {
  const width = Math.max(4, String(Math.max(1, total)).length);
  return `frames/frame_${String(index + 1).padStart(width, '0')}.jpg`;
}

/**
 * The README that ships inside the export.
 *
 * It exists because the recipe's failure modes are all silent: the wrong camera
 * model reconstructs into a warped bowl, an un-frozen subject reconstructs into
 * a smear, and neither says so — COLMAP just returns a worse model. Writing the
 * settings next to the frames they were cut from is the only place a person
 * will still have them a week later.
 */
export function colmapRecipe({ rig, frameCount = 0, durationSeconds = 0, modelName = '', loopClosed = false } = {}) {
  const r = normalizeTurntable(rig);
  const step = degreesPerFrame(r, frameCount);
  // `null` is the only thing dropped, so the blank lines that give the file its
  // shape survive — filtering out every empty string would collapse it into one
  // unreadable block.
  const lines = [
    '# Turntable capture',
    '',
    `Frames: ${frameCount}, evenly spaced across ${Number(durationSeconds).toFixed(2)}s`,
    `Orbit: ${r.arc}° ${r.direction === 'ccw' ? 'counter-clockwise' : 'clockwise'}, starting at ${normalizeAngle(r.startAngle)}° (${angleLabel(r.startAngle)})`,
    `Step: one frame every ${step.toFixed(2)}°`,
    `Elevation: ${(TURNTABLE_ELEVATIONS.find(([id]) => id === r.elevation) || [])[1] || r.elevation}`,
    modelName ? `Model: ${modelName}` : null,
    `Loop: ${loopClosed
      ? 'closed — the same picture was pinned as the start and the end frame'
      : 'OPEN — the start and end frames were not pinned to one picture, so the two ends may not agree'}`,
    '',
    '## COLMAP',
    '',
    '1. New database, then import this `frames/` folder.',
    '2. Processing -> Feature Extraction. Set the camera model to SIMPLE_PINHOLE',
    '   before extracting. One physical camera took every frame, so leave the',
    '   shared-intrinsics option ON — per-image intrinsics is the usual cause of',
    '   a reconstruction that curves away from the subject.',
    '3. Processing -> Feature Matching. Sequential matching suits an orbit; the',
    '   file names are zero-padded so alphabetical order is orbit order. Turn on',
    '   loop detection if the sweep is a full 360.',
    '4. Reconstruction -> Start Reconstruction.',
    '5. File -> Export Model. That folder is what a splat trainer reads.',
    '',
    '## Gaussian splatting',
    '',
    'Point Postshot, Brush, or any COLMAP-compatible trainer at the exported',
    'model plus this `frames/` folder.',
    '',
    '## If the reconstruction is poor',
    '',
    '- Registered image count far below the frame count: the subject moved. Raise',
    '  the freeze wording and render again.',
    '- A warped or bowl-shaped model: the camera model was not SIMPLE_PINHOLE, or',
    '  intrinsics were not shared.',
    '- The two ends of the orbit disagree: the start and end frames were not the',
    '  same picture.',
  ];
  return `${lines.filter((line) => line !== null).join('\n')}\n`;
}
