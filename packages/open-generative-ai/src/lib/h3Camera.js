// The camera, as choices rather than as prose.
//
// A shot's camera is five separate decisions that H3 reads in a fixed order —
// where the frame sits, where the camera sits, what it does, where it ends up,
// and what the glass does — and the model obeys them far better stated as
// separate sentences in that order than folded into one adjective pile. So this
// module holds the vocabulary and turns a plain object into those sentences.
//
// It is deliberately effect-free and knows nothing about React, references, or
// the studio: the sentence for a given set of choices is the part that has to be
// provable, and the tests read it straight.
//
// Vocabulary and clause order follow MiniMax's own camera-instruction grammar
// (the amplitude/speed qualifiers are H3's, not ours) as surveyed in the
// community H3 Prompt Composer. The MOVES come from cameraMotion.js so the
// studio has one camera-move vocabulary, not two.
import { CAMERA_MOTIONS, cameraMotionById } from './cameraMotion.js';

const pairs = (list) => Object.freeze(list.map((row) => Object.freeze(row)));

/** How much of the subject the frame holds. '' = let the action describe it. */
export const CAMERA_FRAMINGS = pairs([
  ['', 'Framing described in the action'],
  ['extreme_close_up', 'Extreme close-up'],
  ['close_up', 'Close-up'],
  ['medium_close_up', 'Medium close-up'],
  ['medium', 'Medium shot'],
  ['medium_wide', 'Medium-wide / three-quarter'],
  ['wide', 'Wide / full shot'],
  ['extreme_wide', 'Extreme-wide / establishing'],
  ['insert', 'Insert / detail'],
  ['two_shot', 'Two-shot'],
  ['over_shoulder', 'Over-the-shoulder'],
]);

/** What a tight frame is tight ON. Only read for close/insert framings. */
export const CAMERA_FOCUS_AREAS = pairs([
  ['', 'Whole subject'],
  ['face', 'Face and head'],
  ['eyes', 'Eyes'],
  ['hands', 'Hands'],
  ['feet', 'Feet'],
  ['full_body', 'Full body'],
]);

/** Which side of the subject the lens is on. */
export const CAMERA_VIEWPOINTS = pairs([
  ['', 'Unspecified'],
  ['front', 'Directly in front'],
  ['front_3q_left', 'Front three-quarter — subject’s left'],
  ['front_3q_right', 'Front three-quarter — subject’s right'],
  ['left_profile', 'Left profile'],
  ['right_profile', 'Right profile'],
  ['rear_3q_left', 'Rear three-quarter — subject’s left'],
  ['rear_3q_right', 'Rear three-quarter — subject’s right'],
  ['behind', 'Directly behind'],
  ['pov', 'Point of view'],
]);

/** How high the lens is, and which way it tips. */
export const CAMERA_ANGLES = pairs([
  ['', 'Unspecified'],
  ['eye_level', 'Eye level'],
  ['slightly_low', 'Slightly low'],
  ['low', 'Low angle'],
  ['ground', 'Ground level'],
  ['slightly_high', 'Slightly high'],
  ['high', 'High angle'],
  ['overhead', 'Overhead / top-down'],
  ['waist_level', 'Waist height'],
  ['chest_level', 'Chest height'],
]);

/** Where the subject sits inside the frame. */
export const CAMERA_COMPOSITIONS = pairs([
  ['', 'Unspecified'],
  ['centered', 'Centered'],
  ['left_third', 'Left third'],
  ['right_third', 'Right third'],
  ['negative_left', 'Negative space on the left'],
  ['negative_right', 'Negative space on the right'],
  ['balanced_two', 'Balanced two-shot'],
  ['symmetrical', 'Symmetrical'],
  ['dirty_single', 'Dirty single'],
]);

// H3's own movement qualifiers. They are the model's words, so they are spelled
// exactly as the model was trained to read them.
export const CAMERA_AMPLITUDES = pairs([
  ['', 'Normal range'],
  ['with small amplitude', 'Subtle / short move'],
  ['with large amplitude', 'Pronounced / long move'],
]);
export const CAMERA_SPEEDS = pairs([
  ['', 'Normal speed'],
  ['at slow speed', 'Slow'],
  ['at fast speed', 'Fast'],
]);

/** WHEN in the shot the move happens — the difference between a move that
 *  underlines a line and one that steps on it. */
export const CAMERA_TIMINGS = pairs([
  ['after_opening_action', 'After the opening action'],
  ['during_opening_action', 'During the opening action'],
  ['during_dialogue', 'During the dialogue'],
  ['after_dialogue', 'After the dialogue'],
  ['throughout_shot', 'Throughout the shot'],
]);

/** How the operator holds it — applies to a moving OR a held camera. */
export const CAMERA_STABILITY = pairs([
  ['', 'Unspecified'],
  ['locked', 'Locked off'],
  ['smooth', 'Smooth dolly / gimbal'],
  ['subtle_handheld', 'Subtle handheld'],
  ['strong_handheld', 'Strong handheld'],
  ['documentary', 'Loose documentary'],
  ['floating', 'Floating drift'],
]);

export const CAMERA_LENSES = pairs([
  ['', 'Automatic'],
  ['wide', 'Wide-angle'],
  ['natural', 'Natural perspective'],
  ['telephoto', 'Telephoto compression'],
  ['macro', 'Macro / detail'],
]);

export const CAMERA_DEPTH = pairs([
  ['', 'Automatic'],
  ['deep', 'Deep focus'],
  ['moderate', 'Moderate depth of field'],
  ['shallow', 'Shallow depth of field'],
  ['extreme_shallow', 'Extremely shallow'],
]);

export const CAMERA_FOCUS_BEHAVIOUR = pairs([
  ['', 'Automatic'],
  ['hold', 'Hold focus on the framing target'],
  ['rack', 'Rack focus between two targets'],
  ['enter', 'Let the target come into focus'],
  ['both', 'Keep both subjects in focus'],
]);

/** A camera with nothing chosen — every field present so React inputs stay
 *  controlled and the serializer never has to guard for undefined. */
export function blankCamera() {
  return {
    framing: '', focusArea: '', viewpoint: '', angle: '', composition: '',
    moveId: '', amplitude: '', speed: '', timing: 'after_opening_action',
    stability: '', lens: '', depth: '', focusBehaviour: '',
    focusFrom: '', focusTo: '',
    // Where the move LANDS. Only framing is offered, because an endpoint that
    // re-specifies everything reads to the model as a second shot.
    endFraming: '', endFocusArea: '', endNote: '',
    // Free text that replaces the generated move sentence outright.
    custom: '',
  };
}

const has = (camera) => Boolean(camera && typeof camera === 'object');
const value = (camera, key) => String((has(camera) ? camera[key] : '') || '').trim();

/** True when any choice at all has been made — what the chip counts. */
export function cameraIsSet(camera) {
  if (!has(camera)) return false;
  const blank = blankCamera();
  return Object.keys(blank).some((key) => String(camera[key] || '') !== String(blank[key] || ''));
}

const sentence = (text) => {
  const trimmed = String(text || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const capped = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
};
// Lowercasing a generated clause so it can follow "After the opening action, ".
// Only the first word, and only when it is not a reference tag or an acronym.
const lower = (text) => {
  const trimmed = String(text || '').trim();
  if (!trimmed || /^[<A-Z]{2,}/.test(trimmed) || trimmed.startsWith('<')) return trimmed;
  return trimmed[0].toLowerCase() + trimmed.slice(1);
};

const FOCUS_AREA_NOUN = {
  face: 'face and head', eyes: 'eyes', hands: 'hands', feet: 'feet', full_body: 'full body',
};

// What a tight frame is on: the chosen detail, else the subject itself. A
// close-up of a person with no detail chosen means their face — saying so is
// what stops H3 answering with a close-up of their hands.
function detailOf(camera, subject, { humanlike = true } = {}) {
  const area = value(camera, 'focusArea') || value(camera, 'endFocusArea');
  if (FOCUS_AREA_NOUN[area]) return `${subject}'s ${FOCUS_AREA_NOUN[area]}`;
  if (humanlike && value(camera, 'framing') === 'close_up') return `${subject}'s face and head`;
  return subject;
}

// The frame as a full clause ("a medium shot frames X from the waist up") for
// the opening, or as a bare noun phrase ("a medium shot of X") for an ending —
// "The move ends on …" already supplies the verb, so a second one reads broken.
function framingCore(framing, camera, subject, secondary, { humanlike = true, ending = false } = {}) {
  const detail = detailOf(
    ending ? { focusArea: value(camera, 'endFocusArea') || value(camera, 'focusArea'), framing } : camera,
    subject,
    { humanlike },
  );
  const pair = secondary ? `${subject} and ${secondary}` : subject;
  const two = Boolean(secondary);
  if (ending) {
    switch (framing) {
      case 'extreme_close_up': return `an extreme close-up of ${detail}`;
      case 'close_up': return two ? `a close two-shot of ${pair}` : `a close-up of ${detail}`;
      case 'medium_close_up': return two ? `a medium-close two-shot of ${pair}` : `a medium close-up of ${subject}`;
      case 'medium': return two ? `a medium two-shot of ${pair}` : `a medium shot of ${subject}`;
      case 'medium_wide': return two ? `a medium-wide two-shot of ${pair}` : `a medium-wide shot of ${subject}`;
      case 'wide': return two ? `a wide two-shot of ${pair}` : `a wide full shot of ${subject}`;
      case 'extreme_wide': return two ? `an extreme-wide frame with ${pair}` : `an extreme-wide frame with ${subject}`;
      case 'insert': return `an insert close-up of ${detail}`;
      case 'two_shot': return `a two-shot of ${subject} and ${secondary || 'the second subject'}`;
      case 'over_shoulder': return `an over-the-shoulder frame on ${subject} past ${secondary || 'the foreground subject'}`;
      default: return `the ending framing on ${subject}`;
    }
  }
  switch (framing) {
    case 'extreme_close_up': return `an extreme close-up isolates ${detail}`;
    case 'close_up': return two ? `a close two-shot frames ${pair} tightly` : `a close-up frames ${detail}`;
    case 'medium_close_up': return two ? `a medium-close two-shot frames ${pair} from the upper chest up` : `a medium close-up frames ${subject} from the upper chest up`;
    case 'medium': return two ? `a medium two-shot frames ${pair} from the waist up` : `a medium shot frames ${subject} from the waist up`;
    case 'medium_wide': return two ? `a medium-wide two-shot frames ${pair} from the knees up` : `a medium-wide shot frames ${subject} from the knees up`;
    case 'wide': return two ? `a wide two-shot shows ${pair} in full with the immediate environment` : `a wide shot shows ${subject} in full with the immediate environment`;
    case 'extreme_wide': return two ? `an extreme-wide establishing shot places ${pair} small within the environment` : `an extreme-wide establishing shot places ${subject} small within the environment`;
    case 'insert': return `an insert close-up isolates ${detail}`;
    case 'two_shot': return `a two-shot frames ${subject} and ${secondary || 'the second subject'}`;
    case 'over_shoulder': return `an over-the-shoulder shot frames ${subject} past ${secondary || 'the foreground subject'}`;
    default: return '';
  }
}

function viewpointClause(viewpoint, subject) {
  return ({
    front: `directly in front of ${subject}`,
    front_3q_left: `at a front three-quarter angle favouring ${subject}'s left side`,
    front_3q_right: `at a front three-quarter angle favouring ${subject}'s right side`,
    left_profile: `viewing ${subject} in left profile`,
    right_profile: `viewing ${subject} in right profile`,
    rear_3q_left: `at a rear three-quarter angle favouring ${subject}'s left side`,
    rear_3q_right: `at a rear three-quarter angle favouring ${subject}'s right side`,
    behind: `directly behind ${subject}`,
  })[viewpoint] || '';
}

function compositionClause(composition, subject, secondary) {
  return ({
    centered: `${subject} is centred in the frame`,
    left_third: `${subject} sits on the left third of the frame`,
    right_third: `${subject} sits on the right third of the frame`,
    negative_left: `${subject} sits to the right with negative space on the left`,
    negative_right: `${subject} sits to the left with negative space on the right`,
    balanced_two: `${subject} and ${secondary || 'the second subject'} share a balanced two-subject composition`,
    symmetrical: 'the composition is symmetrical',
    dirty_single: `${secondary || 'the foreground subject'} forms a soft foreground edge`,
  })[composition] || '';
}

const ANGLE_SENTENCE = {
  eye_level: 'The camera is at eye level.',
  slightly_low: 'The camera is slightly below eye level, looking gently upward.',
  low: 'The camera is low, looking upward.',
  ground: 'The camera is near ground level, looking steeply upward.',
  slightly_high: 'The camera is slightly above eye level, looking gently downward.',
  high: 'The camera is high, looking downward.',
  overhead: 'The camera is overhead, looking straight down.',
  waist_level: 'The camera is at waist height, looking level.',
  chest_level: 'The camera is at chest height, looking level.',
};

const STABILITY_MOVING = {
  locked: 'rigid, shake-free stabilisation',
  smooth: 'smooth stabilised movement',
  subtle_handheld: 'subtle handheld movement',
  strong_handheld: 'pronounced handheld shake',
  documentary: 'loose documentary-style handheld movement',
  floating: 'a gentle floating drift',
};
const STABILITY_HELD = {
  locked: 'The camera holds a locked-off static composition with no shake.',
  smooth: 'The camera holds a steady, smoothly stabilised composition.',
  subtle_handheld: 'The camera holds the composition with subtle handheld movement.',
  strong_handheld: 'The camera holds the composition with pronounced handheld shake.',
  documentary: 'The camera holds the composition with loose documentary-style handheld movement.',
  floating: 'The camera gently drifts while holding the composition.',
};

const TIMING_LEAD = {
  during_opening_action: 'During the opening action',
  during_dialogue: 'During the dialogue',
  after_dialogue: 'After the dialogue',
  throughout_shot: 'Throughout the shot',
  after_opening_action: '',
};

/**
 * The move itself. Built from the shared CAMERA_MOTIONS clause so "Dolly in"
 * means the same thing here as it does on the Motion chip, with H3's amplitude
 * and speed qualifiers inserted where the model expects them — after the verb,
 * before the target.
 */
function movePhrase(camera, subject) {
  const custom = value(camera, 'custom');
  if (custom) return custom.replace(/[.\s]+$/, '');
  const motion = cameraMotionById(value(camera, 'moveId'));
  if (!motion) return '';
  const qualifiers = [value(camera, 'amplitude'), value(camera, 'speed')].filter(Boolean).join(' ');
  // `moves` is the third-person form — "dollies forward toward the subject" —
  // because here the camera is the subject of the sentence, not the reader. The
  // generic "the subject" placeholder becomes whoever this shot is about.
  let clause = String(motion.moves || motion.clause).replace(/\bthe subject\b/g, subject);
  if (qualifiers) {
    // Qualifiers belong on the verb. Insert before the first preposition so
    // "dolly forward toward X" becomes "dolly forward slowly toward X" rather
    // than trailing off the end of the sentence.
    const at = clause.search(/\s(?:toward|towards|away from|on|around|beside|behind|to the|from)\b/);
    clause = at > 0 ? `${clause.slice(0, at)} ${qualifiers}${clause.slice(at)}` : `${clause} ${qualifiers}`;
  }
  return `the camera ${clause}`;
}

/**
 * Every camera sentence this shot contributes, in the order H3 reads them.
 * Returned as named parts rather than one string so the shot serializer can put
 * the move where its timing says it goes — after the action, or before it.
 */
export function cameraSentences(camera, { subject = '<Subject 1>', secondary = '', humanlike = true } = {}) {
  const out = { framing: '', position: '', move: '', endFrame: '', optics: '' };
  if (!has(camera)) return out;

  const who = String(subject || '<Subject 1>').trim() || '<Subject 1>';
  const other = String(secondary || '').trim();

  const framing = value(camera, 'framing');
  if (framing) {
    let core = framingCore(framing, camera, who, other, { humanlike });
    const view = value(camera, 'viewpoint');
    const viewClause = view !== 'pov' ? viewpointClause(view, who) : '';
    if (viewClause) core += `, with the camera ${viewClause}`;
    const comp = compositionClause(value(camera, 'composition'), who, other);
    if (comp) core += `; ${comp}`;
    out.framing = sentence(core);
  }

  const position = [];
  if (value(camera, 'viewpoint') === 'pov') position.push(`The shot is seen from ${who}'s point of view.`);
  const angle = ANGLE_SENTENCE[value(camera, 'angle')];
  if (angle) position.push(angle);
  out.position = position.join(' ');

  const stability = value(camera, 'stability');
  const raw = movePhrase(camera, who);
  if (raw) {
    let move = raw;
    if (stability && STABILITY_MOVING[stability]) move += `, with ${STABILITY_MOVING[stability]}`;
    const lead = TIMING_LEAD[value(camera, 'timing') || 'after_opening_action'];
    out.move = sentence(lead ? `${lead}, ${lower(move)}` : move);
  } else if (stability && STABILITY_HELD[stability]) {
    // No move chosen, but the operator was specified: that IS the instruction.
    out.move = STABILITY_HELD[stability];
  }

  const endFraming = value(camera, 'endFraming');
  const endNote = value(camera, 'endNote');
  if (endFraming || endNote) {
    const when = raw ? 'The move ends' : 'The shot ends';
    const parts = [];
    if (endFraming) parts.push(sentence(`${when} on ${framingCore(endFraming, camera, who, other, { humanlike, ending: true })}`));
    if (endNote) parts.push(sentence(endFraming ? endNote : `${when} ${lower(endNote)}`));
    out.endFrame = parts.join(' ');
  }

  const optics = [];
  const lens = ({
    wide: 'A wide-angle lens emphasises spatial depth and the separation between foreground and background.',
    natural: 'A natural-perspective lens keeps familiar proportions, without wide-angle distortion or telephoto compression.',
    telephoto: 'A moderate telephoto lens compresses the apparent depth of the background behind the subject.',
    macro: 'A macro lens resolves fine detail at very close range.',
  })[value(camera, 'lens')];
  if (lens) optics.push(lens);
  const depth = ({
    deep: 'Deep focus keeps the foreground, the subjects and the environment all clearly resolved.',
    moderate: 'A moderate depth of field keeps the subject sharp while the environment stays readable.',
    shallow: 'A shallow depth of field isolates the subject against a softly blurred background.',
    extreme_shallow: 'An extremely shallow depth of field holds a narrow plane of focus while everything around it falls away.',
  })[value(camera, 'depth')];
  if (depth) optics.push(depth);
  const behaviour = value(camera, 'focusBehaviour');
  if (behaviour === 'hold') optics.push(`Focus stays locked on ${who} throughout the shot.`);
  else if (behaviour === 'rack') optics.push(sentence(`Focus racks from ${value(camera, 'focusFrom') || 'the opening target'} to ${value(camera, 'focusTo') || 'the ending target'}`));
  else if (behaviour === 'enter') optics.push(sentence(`${value(camera, 'focusTo') || who} moves into clear focus during the shot`));
  else if (behaviour === 'both') optics.push('Both principal subjects stay in focus throughout the shot.');
  out.optics = optics.join(' ');

  return out;
}

/** The whole camera as one block of prose — used for the builder's preview. */
export function cameraInstruction(camera, options = {}) {
  const parts = cameraSentences(camera, options);
  return [parts.framing, parts.position, parts.move, parts.endFrame, parts.optics]
    .filter(Boolean).join(' ').trim();
}

/** The moves the builder offers, grouped the way the Motion chip groups them. */
export const CAMERA_MOVE_OPTIONS = Object.freeze([
  ['', 'Hold — no camera move'],
  ...CAMERA_MOTIONS.map((motion) => [motion.id, motion.label]),
]);
