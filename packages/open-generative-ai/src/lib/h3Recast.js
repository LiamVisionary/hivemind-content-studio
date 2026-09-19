// Recast — putting YOUR cast into somebody else's clip.
//
// Attaching a motion clip today writes the manner contract: "attribute_transfer
// — only its manner of movement carries". That is the right promise for
// borrowing a gesture style into a shot you wrote yourself, and it is the wrong
// one for the job people actually bring a clip for, which is: *re-perform this
// scene, cut for cut, with my characters in it.*
//
// The two differ in what the clip is allowed to give:
//
//   motion reference   the performer's manner. The shot is yours.
//   recast             the shot — its cuts, staging, framing, timing and the
//                      performers' expressions and actions. The people and the
//                      art style are yours.
//
// Recast is the harder contract and it fails in a specific, repeatable way: the
// clip wins. Its art style comes through, its performers come through, and the
// character pictures are read as frames to copy rather than as a design guide.
// Three clauses are what hold it, and all three are easy to leave out —
//
//   1. the pictures are a CHARACTER-DESIGN guide, not frames and not poses;
//   2. the art style comes from the pictures, explicitly NOT from the clip;
//   3. every shot in the source is described. A clip whose shots are not
//      written out is re-performed from the model's guess at them, and the
//      guess is where the source's own cast leaks back in.
//
// (1) and (2) are one-liners this module writes. (3) is work only the author
// can do, which is why the dialog is a shot list against the clip's own
// storyboard rather than a single prompt box: the tutorial this was built from
// ("describe each scene in the reference video") is describing a UI that did
// not exist.
//
// Two more things the same source measured and this module encodes: a recast
// holds for about ten seconds and frays past twelve (RECAST_SECONDS), and the
// cast has to be told to sit in the scene's own light rather than arrive lit
// from their reference sheets.
//
// WHAT THIS MODULE IS NOT. It does not write who anyone is. subject_definitions
// and retention_analysis belong to the cast compiler (castPrompt.js), which
// gets a `recast` flag rather than a second author — see recastCastOptions().
// This writes the CREATIVE half and hands it to the weave as a template, the
// same door the Story studio uses. Shot text is serialized by h3Shots.shotText,
// so a recast shot and a Shot Builder shot are the same sentence.
//
// Pure: no React, no storage, no network.
import { newShot, parseShotBlocks, shotText, timecode } from './h3Shots.js';
import { blankCamera } from './h3Camera.js';

/**
 * How long a recast holds.
 *
 * Reported by the MiniMax H3 reference-replacement writeup this flow was built
 * from: reliable around ten seconds, twelve at the outside, per clip. It is
 * about the clip being re-performed, not about H3's own ceiling — the model
 * will render longer, and the recast is what degrades: identity drifts back
 * toward the source's performers and the later shots lose their staging.
 *
 * Advisory. Nothing here shortens a run; the dialog says so and offers.
 */
export const RECAST_SECONDS = Object.freeze({ best: 10, max: 12 });

/** A shot of the SOURCE clip, as the author describes it. */
export function blankRecastShot() {
  return {
    id: '',
    // Where this shot begins in the finished clip. Shot 1 is always 0.
    at: 0,
    // How the previous shot gives way to this one — h3Shots' own verbs.
    transition: 'the shot cuts to',
    // What the cut lands on: "a close-up of their hands", "the back of her
    // head". Empty is allowed; the serializer falls back to "a new view",
    // which is worth avoiding and the dialog says so.
    framing: '',
    // What happens in it.
    action: '',
  };
}

let counter = 0;
export const newRecastShot = (at = 0) => ({ ...blankRecastShot(), id: `recast-${(counter += 1).toString(36)}`, at });

/** The whole plan, held by the studio so it survives the dialog closing. */
export function blankRecast() {
  return {
    shots: [newRecastShot(0)],
    // Where the scene happens — carried into the blend sentence, because the
    // cast has to be lit by THIS room and not by their reference sheets.
    setting: '',
    // Off by default only in the sense that an empty plan writes nothing at
    // all; armed, these are what a recast is and both start on.
    styleLock: true,
    blend: true,
    // Height/scale/proportion consistency. A separate switch because it is the
    // one clause that fights a deliberate size difference (a giant, a child).
    proportions: true,
  };
}

const text = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const sentence = (value) => {
  const trimmed = text(value);
  if (!trimmed) return '';
  const capped = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
};

/** "<Picture 1>, <Picture 2> and <Picture 3>" — the model's own labels, in order. */
export function joinLabels(labels = []) {
  const list = labels.filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** Whether there is anything to compile — an untouched plan writes nothing. */
export function recastIsBlank(plan = {}) {
  const shots = Array.isArray(plan.shots) ? plan.shots : [];
  return !text(plan.setting) && shots.every((shot) => !text(shot?.action) && !text(shot?.framing));
}

/** How many of the plan's shots are actually written. The dialog's readout. */
export function recastShotsWritten(plan = {}) {
  return (Array.isArray(plan.shots) ? plan.shots : []).filter((shot) => text(shot?.action)).length;
}

/**
 * The sentence that says where the art style comes from, and where it does
 * NOT. The single most load-bearing line in a recast: without it the source
 * clip's rendering wins over the pictures almost every time.
 */
export function styleLockSentence({ pictures = [], videos = [] } = {}) {
  const from = joinLabels(pictures);
  const against = joinLabels(videos);
  if (!from) return '';
  const lock = `Use the exact art style of ${from} only.`;
  return against ? `${lock} Do not match or copy the art style of ${against}.` : lock;
}

/** Recognised by this, so loading a saved prompt or Start fresh turns the chip off. */
const STYLE_LOCK_MARK = /\bUse the exact art style of <Picture \d+>/;
const RECAST_TAG = '[reference generation]';

/** True when the prompt in the box is one this flow wrote. */
export function isRecastPrompt(prompt) {
  const source = String(prompt || '');
  return STYLE_LOCK_MARK.test(source) || source.includes(RECAST_TAG);
}

/**
 * The blend clause. The cast arrives lit by whatever lit their reference
 * sheets, and drops into the source's room carrying that light with them — the
 * giveaway that two pictures were pasted into somebody else's shot. Asking for
 * it explicitly is what fixes it, and the "without changing their appearances"
 * half is what stops the request from being read as permission to restyle them.
 */
export function blendSentence({ subjects = [], setting = '' } = {}) {
  const who = joinLabels(subjects);
  if (!who) return '';
  const where = text(setting);
  const scene = where ? 'the setting' : 'the scene';
  // One subject takes the singular verb. "Ensure <Subject 1> blend into…" is
  // the kind of broken agreement that reads as noise to a model being asked to
  // follow the sentence precisely.
  const many = subjects.length > 1;
  return `${where ? `${sentence(where)} ` : ''}Ensure ${who} ${many ? 'blend' : 'blends'} into the lighting, `
    + `color and shadow of ${scene} without changing ${many ? 'their appearances' : 'their appearance'}.`;
}

/**
 * Height, scale and proportion. H3 renders each shot with a good deal of
 * independence, and a cast assembled from separate reference sheets has no
 * agreed scale between them — so the same two characters come back a head apart
 * in one shot and level in the next.
 */
export function proportionSentence({ subjects = [] } = {}) {
  if (!subjects.length) return '';
  const who = subjects.length > 1 ? joinLabels(subjects) : subjects[0];
  return `Maintain consistent height, scale and body proportions for ${who} across every shot, `
    + 'as established by the reference pictures.';
}

/**
 * The closing restatement — each subject named with the handful of features
 * that make them themselves.
 *
 * It repeats what subject_definitions already said, on purpose: the definition
 * is read once at the top and the last shots are where identity drifts. The
 * traits come from the cast member's own look, so there is one place to edit
 * them and this cannot fall out of step with the definition above it.
 */
export function recognitionSentence(subjects = []) {
  // A known character is recognised by being NAMED — H3 already holds what it
  // looks like, and a written look about SpongeBob is neither needed nor
  // something anyone should be asked for. A persona is recognised by its look;
  // with none written there is nothing true to say, so nothing is said.
  const clauses = subjects.map((entry) => {
    const look = text(entry?.look);
    if (look) return `${entry.subject} as ${look.replace(/\.$/, '')}`;
    if (entry?.kind === 'character' && text(entry?.name)) return `${entry.subject} as ${text(entry.name)}`;
    return '';
  }).filter(Boolean);
  if (!clauses.length) return '';
  return `Keep ${joinLabels(clauses)} clearly recognizable throughout, drawn only in the style of `
    + 'their reference pictures.';
}

/**
 * The summary, with the contract tag the reference guide uses and the
 * style exclusion said a second time — the summary is read as the brief for
 * the whole clip, so the exclusion has to survive there as well as in the
 * description.
 */
export function recastSummary({ plan = {}, subjects = [], pictures = [], videos = [] } = {}) {
  const who = joinLabels(subjects.map((entry) => entry.subject));
  const clip = joinLabels(videos);
  const opening = text(plan.summary)
    || (text(plan.setting) ? `${text(plan.setting).replace(/\.$/, '')}` : '')
    || 'The scene from the reference clip';
  const parts = [`${RECAST_TAG} ${sentence(`${opening}${who ? `, re-performed by ${who}` : ''}`)}`];
  if (clip) {
    parts.push(
      `Use ${clip} as a guide for the characters' expressions, actions, staging and camera cuts only.`,
    );
    if (plan.styleLock !== false && pictures.length) {
      parts.push(`Do NOT copy the art style of ${clip}; use the art style of the reference pictures only.`);
    }
  }
  return parts.join(' ');
}

/**
 * The plan's shots as h3Shots shot objects, so they serialize through the same
 * writer the Shot Builder uses. A recast shot carries no beats, no dialogue and
 * no camera rig — it is a cut, what it lands on, and what happens — which is
 * exactly the subset shotText renders when the rest is blank.
 */
export function recastShotsAsTimeline(plan = {}) {
  const shots = Array.isArray(plan.shots) ? plan.shots : [];
  return shots.map((shot, index) => ({
    ...newShot(),
    cutSec: index === 0 ? 0 : Number(shot?.at) || 0,
    transition: shot?.transition || 'the shot cuts to',
    cutTo: text(shot?.framing),
    action: text(shot?.action),
    camera: blankCamera(),
  }));
}

/** The description half: style lock, the room, the scale rule, the shots, the restatement. */
export function recastDescription({ plan = {}, subjects = [], pictures = [], videos = [] } = {}) {
  const subjectLabels = subjects.map((entry) => entry.subject).filter(Boolean);
  const blocks = [];
  if (plan.styleLock !== false) {
    const lock = styleLockSentence({ pictures, videos });
    if (lock) blocks.push(lock);
  }
  if (plan.blend !== false) {
    const blend = blendSentence({ subjects: subjectLabels, setting: plan.setting });
    if (blend) blocks.push(blend);
  } else if (text(plan.setting)) {
    blocks.push(sentence(plan.setting));
  }
  if (plan.proportions !== false) {
    const scale = proportionSentence({ subjects: subjectLabels });
    if (scale) blocks.push(scale);
  }

  const timeline = recastShotsAsTimeline(plan);
  const written = timeline.map((shot, index) => shotText(shot, index)).filter(Boolean);
  if (written.length) blocks.push(written.join('\n'));

  const recognition = recognitionSentence(subjects);
  if (recognition) blocks.push(recognition);
  return blocks.join('\n\n');
}

/**
 * What the weave is handed. `summary` and `detailed_description` only: who
 * everyone is comes from the cast, and the soundscape and music stay the
 * author's — a recast that silently replaced a written soundscape with
 * boilerplate is the 2026-08-23 failure in a new coat.
 */
export function recastTemplate({ plan = {}, subjects = [], pictures = [], videos = [] } = {}) {
  return {
    summary: recastSummary({ plan, subjects, pictures, videos }),
    detailed_description: recastDescription({ plan, subjects, pictures, videos }),
  };
}

/**
 * The cast compiler's options for a recast. One place, so the dialog's preview
 * and the applied prompt cannot disagree about which contract is in force.
 */
export const recastCastOptions = () => ({ recast: true });

/**
 * What is not right yet, as codes — the wording belongs to the panel.
 *
 * Ordered by what actually breaks a recast: no clip at all, then the shots
 * nobody described, then the pictures that decide the art style, then length.
 */
export function recastWarnings({
  plan = {}, durationSeconds = 0, pictures = [], videos = [], subjects = [],
} = {}) {
  const found = [];
  if (!videos.length) found.push({ code: 'no-clip' });
  if (!pictures.length) found.push({ code: 'no-pictures' });
  const shots = Array.isArray(plan.shots) ? plan.shots : [];
  const blank = shots
    .map((shot, index) => (text(shot?.action) ? 0 : index + 1))
    .filter(Boolean);
  if (blank.length) found.push({ code: 'blank-shot', shots: blank });
  if (!text(plan.setting)) found.push({ code: 'no-setting' });
  // Only a persona can be missing a look; a known character is named.
  const missingLook = subjects
    .filter((entry) => entry?.kind !== 'character' && !text(entry?.look))
    .map((entry) => entry.subject);
  if (missingLook.length) found.push({ code: 'no-look', subjects: missingLook });
  // A member carrying its own render style contradicts the style lock: the
  // definition says "rendered as photoreal live-action, not illustrated" while
  // the description says take the style from the pictures. Drawn character
  // sheets lose that argument, which is exactly the case a recast is usually
  // for. Not fixed from here — a member's style is the cast's to set, and a
  // panel that silently rewrote it would be hiding the thing it just warned
  // about — so the warning names where the switch is.
  if (plan.styleLock !== false) {
    const styled = subjects.filter((entry) => text(entry?.style)).map((entry) => entry.subject);
    if (styled.length) found.push({ code: 'style-clash', subjects: styled });
  }
  const seconds = Number(durationSeconds) || 0;
  if (seconds > RECAST_SECONDS.max) found.push({ code: 'too-long', seconds, limit: RECAST_SECONDS.max });
  else if (seconds > RECAST_SECONDS.best) found.push({ code: 'long', seconds, best: RECAST_SECONDS.best });
  // A cut past the end of the run is a shot that never plays. fitShotTimeline
  // re-times the prompt on the way out, but the plan is what the author reads.
  const overrun = shots
    .map((shot, index) => ((index > 0 && seconds && (Number(shot?.at) || 0) >= seconds) ? index + 1 : 0))
    .filter(Boolean);
  if (overrun.length) found.push({ code: 'cut-past-end', shots: overrun, seconds });
  return found;
}

/**
 * Seed the plan from a prompt that already holds one, so reopening the dialog
 * shows what is in the box rather than a blank list beside a written prompt.
 * Reads the shot blocks through h3Shots' own parser — the reverse of the
 * serializer above, so a round trip keeps the cuts and what they land on.
 */
export function recastFromPrompt(prompt) {
  const blocks = parseShotBlocks(prompt);
  if (!blocks.length) return null;
  const plan = blankRecast();
  plan.shots = blocks.map((block, index) => ({
    ...newRecastShot(index === 0 ? 0 : block.cutSec),
    transition: block.transition,
    framing: block.cutTo,
    action: block.text,
  }));
  return plan;
}

/** "00:02.500" — the stamp the shot line will carry, for the dialog's readout. */
export const recastTimecode = (seconds) => timecode(seconds);
