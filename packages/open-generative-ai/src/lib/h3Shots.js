// Shots, beats and spoken lines — the timeline INSIDE one H3 generation.
//
// A chain (chainPrompt.js) joins separate generations. This is the other axis:
// H3 was trained to hold several shots inside a single clip, marked with
// [Shot N] and cut at a stated timecode, with action beats stamped in seconds
// and speech wrapped in <d> tags carrying a language and a speaker id. Written
// by hand that grammar is easy to get subtly wrong — a cut past the end of the
// clip, a speaker id that skips, a carried-over line with nothing to carry into
// — and the model answers a malformed timeline by ignoring the timeline.
//
// So this module owns the grammar and h3PromptCheck.js owns the objections. It
// is pure: no React, no vault, no network. The serialized text IS the contract,
// which is why the tests read it literally.
//
// Grammar surveyed from MiniMax's H3 prompting guide and the community H3
// Prompt Composer (BMB12d3/minimax-h3-prompt-composer); the shot/beat/dialogue
// shapes below are re-implemented for this studio's data model.
import { blankCamera, cameraSentences } from './h3Camera.js';

/** How one shot gives way to the next. H3 reads the verb literally. */
export const SHOT_TRANSITIONS = Object.freeze([
  ['the shot cuts to', 'Cut'],
  ['the shot cross-dissolves to', 'Cross dissolve'],
  ['the shot fades to', 'Fade'],
  ['the shot wipes to', 'Wipe'],
]);

const TRANSITION_VERBS = new Set(SHOT_TRANSITIONS.map(([verb]) => verb));

/** mm:ss.mmm — the stamp format H3's own examples use for a cut. */
export function timecode(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) * 1000) || 0);
  const mm = String(Math.floor(total / 60000)).padStart(2, '0');
  const ss = String(Math.floor((total % 60000) / 1000)).padStart(2, '0');
  const mmm = String(total % 1000).padStart(3, '0');
  return `${mm}:${ss}.${mmm}`;
}

const seconds2 = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
};

const text = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const sentence = (value) => {
  const trimmed = text(value);
  if (!trimmed) return '';
  const capped = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
};

// Lowercase a sentence so it can follow "From 2.00 to 4.50 seconds into the
// shot, ". Reference tags and proper nouns keep their capital — <Subject 1>
// lowercased would stop being a tag at all.
const lower = (value) => {
  const trimmed = text(value);
  if (!trimmed || trimmed.startsWith('<') || /^[A-Z]{2,}/.test(trimmed)) return trimmed;
  const [first] = trimmed.split(/\s/);
  // A capitalised word that is not a sentence opener is probably a name.
  if (/^[A-Z][a-z]+$/.test(first) && !COMMON_OPENERS.has(first)) return trimmed;
  return trimmed[0].toLowerCase() + trimmed.slice(1);
};

const COMMON_OPENERS = new Set([
  'A', 'An', 'The', 'She', 'He', 'They', 'It', 'Her', 'His', 'Their', 'Its',
  'One', 'Two', 'Both', 'Another', 'This', 'That', 'These', 'Those',
  'Camera', 'Dolly', 'Push', 'Pull', 'Pan', 'Truck', 'Tilt', 'Crane', 'Orbit',
  'Wide', 'Medium', 'Close', 'Tight', 'Low', 'High', 'Overhead', 'Inside',
  'Outside', 'Behind', 'Across', 'In', 'At', 'On', 'From', 'Through', 'Over',
  'Under', 'Slow', 'Fast', 'Static', 'Handheld',
]);

/** A spoken line. `lang` is the tag H3 reads for pronunciation and accent. */
export function blankDialogue() {
  return {
    id: '', speaker: '', voice: '', lang: 'English', verb: 'says',
    delivery: '', line: '', afterAction: '',
    beatId: '',            // stamped inside a timed beat rather than after the action
    voiceover: false, offscreen: false,
    // '' | 'out' (runs on into the next shot) | 'in' (arrives from the previous)
    carry: '',
    cutoff: false,         // the clip ends mid-word, on purpose
  };
}

/** A stamped slice of the shot: "From 2.00 to 4.50 seconds into the shot, …" */
export function blankBeat() {
  return { id: '', startSec: 0, endSec: 0, action: '' };
}

/** One shot. `cutSec` is ignored on the first shot, which always starts at 0. */
export function blankShot() {
  return {
    id: '',
    cutSec: 0,
    transition: 'the shot cuts to',
    // What the cut lands on, in the author's words. Without it the shot marker
    // has to fall back to "a new view", which tells the model nothing.
    cutTo: '',
    openingState: '',
    action: '',
    beats: [],
    dialogue: [],
    sound: '',
    camera: blankCamera(),
  };
}

let counter = 0;
/** Ids for React keys and beat↔dialogue links. Not persisted meaning, just identity. */
export function nextId(prefix = 'id') {
  counter += 1;
  return `${prefix}-${counter.toString(36)}`;
}

export const newShot = () => ({ ...blankShot(), id: nextId('shot') });
export const newBeat = (startSec = 0, endSec = 0) => ({ ...blankBeat(), id: nextId('beat'), startSec, endSec });
export const newDialogue = (speaker = '') => ({ ...blankDialogue(), id: nextId('dlg'), speaker });

/**
 * Speaker ids, numbered in the order voices are first HEARD — which is what H3
 * expects and what a hand-written prompt most often gets wrong, because people
 * number by who matters rather than by who speaks first.
 *
 * Returns a Map from the speaker's own text (a name, or a <Subject N> tag) to
 * "S1", "S2", … A line with no speaker gets no id and no prefix.
 */
export function speakerIds(shots = []) {
  const ids = new Map();
  let next = 1;
  for (const shot of shots) {
    for (const line of orderedDialogue(shot)) {
      const who = text(line.speaker);
      if (!who || !text(line.line)) continue;
      if (!ids.has(who)) { ids.set(who, `S${next}`); next += 1; }
    }
  }
  return ids;
}

// Beat-linked lines speak when their beat does, so they come first in stamped
// order; everything else follows in the order it was written.
function orderedDialogue(shot) {
  const all = Array.isArray(shot?.dialogue) ? shot.dialogue : [];
  const beats = sortedBeats(shot);
  const linked = [];
  const seen = new Set();
  for (const beat of beats) {
    for (const line of all) {
      if (line.beatId && line.beatId === beat.id && !seen.has(line)) { seen.add(line); linked.push(line); }
    }
  }
  return [...linked, ...all.filter((line) => !seen.has(line))];
}

function sortedBeats(shot) {
  return (Array.isArray(shot?.beats) ? shot.beats : [])
    .slice()
    .sort((a, b) => Number(a.startSec || 0) - Number(b.startSec || 0));
}

/**
 * One spoken line in H3's dialogue grammar:
 *
 *   (S1) says in a low whisper: <d>[English] I'm not opening it.</d>
 *
 * The language tag is required — an untagged line gets read in whatever accent
 * the model guesses. <scenetrans> marks a line that runs across the cut and
 * <cutoff> a line the clip ends on mid-word; both are H3's own tags.
 */
export function dialogueLine(line, sid = '') {
  const spoken = text(line?.line);
  if (!spoken) return '';
  const who = text(line?.speaker);
  const id = sid ? `(${sid})` : '';
  const name = who && sid ? `${who} ${id}` : (who || id);
  const verb = text(line?.verb) || 'says';
  const delivery = text(line?.delivery);
  const voice = text(line?.voice);
  const lang = text(line?.lang) || 'English';

  const manner = [
    line?.voiceover ? 'in voiceover' : '',
    line?.offscreen ? 'from off-screen' : '',
    voice ? `in the voice of ${voice}` : '',
    delivery,
  ].filter(Boolean).join(', ');

  const head = [name, verb, manner].filter(Boolean).join(' ');
  const carry = line?.carry === true ? 'out' : text(line?.carry);
  const open = carry === 'in' ? ' <scenetrans>' : '';
  const close = carry === 'out' ? ' <scenetrans>' : '';
  const cutoff = line?.cutoff ? ' <cutoff>' : '';
  return `${head}: <d>[${lang}]${open} ${spoken}${close}${cutoff}</d>`;
}

/**
 * One shot as H3 reads it. Order is the contract: the marker and its cut, then
 * the camera's opening frame, the opening state, the action, the stamped beats
 * with any speech inside them, the move where its timing puts it, the loose
 * speech, the ending frame, the optics, and the shot's own sound.
 */
export function shotText(shot, index, { ids = new Map(), subject = '<Subject 1>', secondary = '' } = {}) {
  const parts = [];
  const camera = cameraSentences(shot?.camera, { subject, secondary });
  const timing = String(shot?.camera?.timing || 'after_opening_action');

  let head = `[Shot ${index + 1}]`;
  if (index > 0) {
    const verb = TRANSITION_VERBS.has(shot?.transition) ? shot.transition : 'the shot cuts to';
    const landing = text(shot?.cutTo) || (camera.framing ? lower(camera.framing.replace(/\.$/, '')) : 'a new view');
    head += ` At ${timecode(shot?.cutSec)}, ${verb} ${landing.replace(/\.$/, '')}.`;
  } else if (camera.framing) {
    parts.push(camera.framing);
  }
  // On a later shot the framing already rode in on the cut, so it is not
  // repeated — except when the author wrote their own landing, in which case
  // the builder's framing sentence is still news.
  if (index > 0 && camera.framing && text(shot?.cutTo)) parts.push(camera.framing);

  if (camera.position) parts.push(camera.position);
  if (camera.move && ['throughout_shot', 'during_opening_action'].includes(timing)) parts.push(camera.move);
  if (shot?.openingState) parts.push(sentence(shot.openingState));
  if (shot?.action) parts.push(sentence(shot.action));

  const beats = sortedBeats(shot);
  const dialogue = Array.isArray(shot?.dialogue) ? shot.dialogue : [];
  const spokenInBeats = new Set();

  for (const beat of beats) {
    const linked = dialogue.filter((line) => line.beatId && line.beatId === beat.id && text(line.line));
    const lead = Number(beat.startSec || 0) <= 0.0001
      ? `For the first ${seconds2(beat.endSec)} seconds, `
      : `From ${seconds2(beat.startSec)} to ${seconds2(beat.endSec)} seconds into the shot, `;
    const action = text(beat.action);
    if (action && !linked.length) parts.push(sentence(`${lead}${lower(action)}`));
    linked.forEach((line, at) => {
      spokenInBeats.add(line);
      const core = dialogueLine(line, ids.get(text(line.speaker)) || '');
      if (action && at === 0) parts.push(`${lead}${lower(action)}; during this action, ${lower(core)}`);
      else parts.push(`${lead}${lower(core)}`);
      if (text(line.afterAction)) parts.push(sentence(line.afterAction));
    });
  }

  if (camera.move && timing === 'during_dialogue') parts.push(camera.move);
  for (const line of dialogue) {
    if (spokenInBeats.has(line) || !text(line.line)) continue;
    parts.push(dialogueLine(line, ids.get(text(line.speaker)) || ''));
    if (text(line.afterAction)) parts.push(sentence(line.afterAction));
  }

  if (camera.move && ['after_opening_action', 'after_dialogue'].includes(timing)) parts.push(camera.move);
  if (camera.endFrame) parts.push(camera.endFrame);
  if (camera.optics) parts.push(camera.optics);
  if (text(shot?.sound)) parts.push(sentence(shot.sound));

  return `${head} ${parts.filter(Boolean).join(' ')}`.replace(/\s+/g, ' ').trim();
}

/**
 * Which H3 shape a run is in, derived from what is actually attached rather
 * than from a mode dropdown nobody would keep in sync:
 *
 *   reference — any reference row is filled: the six-section format
 *   flf       — a first AND a last frame
 *   first     — a first frame only
 *   last      — a last frame only
 *   text      — nothing attached
 *
 * The names are ours; the H3 guide calls these Ref2VA, FL2VA, I2VA, L2VA, T2VA.
 */
export function h3Mode({ firstFrame = '', lastFrame = '', images = [], videos = [], audios = [] } = {}) {
  if (images.length || videos.length || audios.length) return 'reference';
  if (firstFrame && lastFrame) return 'flf';
  if (firstFrame) return 'first';
  if (lastFrame) return 'last';
  return 'text';
}

export const H3_MODE_LABELS = Object.freeze({
  reference: 'Ref2VA', flf: 'FL2VA', first: 'I2VA', last: 'L2VA', text: 'T2VA',
});

/**
 * The alignment sentence a frame-anchored run opens with. H3 needs to be told
 * WHERE in the target video an attached frame lands; without it a last frame is
 * treated as one more reference picture and the clip does not converge on it.
 */
export function alignmentHeader(mode, { shotCount = 1, durationSeconds = 0 } = {}) {
  const last = Math.max(1, Number(shotCount) || 1);
  const end = (Number(durationSeconds) || 0).toFixed(2);
  if (mode === 'first') {
    return 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
  }
  if (mode === 'flf') {
    return `How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 0.00-second mark of the target video; <Picture 2> (from [Shot ${last}]) aligns with the ${end}-second mark of the target video.`;
  }
  if (mode === 'last') {
    return `How the reference pictures align with the target video — <Picture 1> (from [Shot ${last}]) aligns with the ${end}-second mark of the target video.`;
  }
  return '';
}

/**
 * The whole prompt. Reference mode gets H3's six sections; the frame-anchored
 * and text modes get the three-field form they were trained on, opened by the
 * alignment sentence when there is one.
 *
 * `subjects` and `retention` are lines the cast compiler already produced
 * (castPrompt.js) — this module never invents who anyone is, it only places
 * what it was handed.
 */
export function composeH3Prompt({
  mode = 'text',
  shots = [],
  style = '',
  summary = '',
  subjects = [],
  retention = [],
  soundscape = '',
  music = '',
  durationSeconds = 0,
  subject = '<Subject 1>',
  secondary = '',
} = {}) {
  const ids = speakerIds(shots);
  const body = shots.map((shot, index) => shotText(shot, index, { ids, subject, secondary })).join('\n');
  const heard = text(soundscape) || '[describe what is heard — H3 renders the audio too]';
  const scored = text(music) || 'N/A';

  if (mode !== 'reference') {
    const header = alignmentHeader(mode, { shotCount: shots.length, durationSeconds });
    const opening = text(style) ? `${sentence(style)} ` : '';
    const core = [
      `integrated_multimodal_description: ${opening}${body}`,
      '',
      `overall_soundscape: ${heard}`,
      '',
      `non_diegetic_music: ${scored}`,
    ].join('\n');
    return header ? `${header}\n\n${core}` : core;
  }

  const preamble = text(style) ? `${sentence(style)}\n` : '';
  return [
    'subject_definitions:',
    subjects.length ? subjects.join('\n') : '<Subject 1> is [hair, face, build, wardrobe — write it out].',
    '',
    'summary:',
    text(summary) || autoSummary(shots, durationSeconds),
    '',
    'retention_analysis:',
    retention.length ? retention.join('\n') : '—',
    '',
    'detailed_description:',
    `${preamble}${body}`,
    '',
    'overall_soundscape:',
    heard,
    '',
    'non_diegetic_music:',
    scored,
  ].join('\n');
}

// A summary the author has not written yet, built from what the shots already
// say — so the section is never empty, which H3 reads as "no scene".
function autoSummary(shots = [], durationSeconds = 0) {
  const first = shots.find((shot) => text(shot?.action) || text(shot?.openingState));
  const opening = first ? text(first.action) || text(first.openingState) : '';
  const count = shots.length;
  const length = Number(durationSeconds) > 0 ? ` over ${(Number(durationSeconds)).toFixed(2)} seconds` : '';
  const shape = count > 1 ? `${count} shots` : 'one continuous shot';
  return sentence(opening ? `${opening.replace(/\.$/, '')}, in ${shape}${length}` : `A scene in ${shape}${length}`);
}

/**
 * The [Shot N] blocks of a prompt as WRITTEN — the reverse direction of
 * shotText, kept deliberately shallow. Each block keeps its cut stamp ("At
 * mm:ss.mmm, the shot cuts to …"), its transition verb and what the cut lands
 * on; everything else in the block stays as prose in `text` (beats, dialogue
 * and camera sentences are not taken apart — re-serializing them as prose
 * reproduces them). Returns [] when the prompt has no shot markers.
 *
 * The builder uses this to seed its timeline from a prompt that already has
 * shots (a starter, a saved prompt), instead of opening on one blank shot and
 * offering to replace three written ones with it.
 */
export function parseShotBlocks(prompt) {
  const source = String(prompt || '');
  const hits = [...source.matchAll(/\[Shot\s+(\d+)\]/gi)];
  if (!hits.length) return [];
  const SECTION = /\n\s*(?:overall_soundscape|non_diegetic_music|retention_analysis|subject_definitions|summary|detailed_description)\s*:/i;
  const VERBS = /^(the shot (?:cuts|cross-dissolves|fades|wipes) to)\s+/i;
  return hits.map((hit, i) => {
    const start = hit.index + hit[0].length;
    const end = i + 1 < hits.length ? hits[i + 1].index : source.length;
    let body = source.slice(start, end).split(SECTION)[0].trim();
    let cutSec = 0;
    let transition = 'the shot cuts to';
    let cutTo = '';
    const stamp = body.match(/^At\s+(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?,\s*/i);
    if (stamp) {
      cutSec = Number(stamp[1]) * 60 + Number(stamp[2]) + (stamp[3] ? Number(stamp[3].padEnd(3, '0')) / 1000 : 0);
      body = body.slice(stamp[0].length);
      const verb = body.match(VERBS);
      if (verb) {
        transition = verb[1].toLowerCase();
        body = body.slice(verb[0].length);
        const landing = body.match(/^([^.]*)\.?\s*/);
        if (landing) {
          cutTo = landing[1].trim();
          body = body.slice(landing[0].length);
        }
      }
    }
    return { index: Number(hit[1]), cutSec, transition, cutTo, text: body.trim() };
  });
}

/** Builder shots seeded from the prompt's own [Shot N] blocks (see above). */
export function timelineShotsFromPrompt(prompt) {
  return parseShotBlocks(prompt).map((block, at) => {
    const shot = newShot();
    shot.cutSec = at === 0 ? 0 : block.cutSec;
    shot.transition = block.transition;
    shot.cutTo = block.cutTo;
    shot.action = block.text;
    return shot;
  });
}

/** Total time the timeline claims, for checks and for the builder's readout. */
export function timelineEndSec(shots = [], durationSeconds = 0) {
  const cuts = shots.slice(1).map((shot) => Number(shot?.cutSec) || 0);
  const beats = shots.flatMap((shot) => (shot?.beats || []).map((beat) => Number(beat?.endSec) || 0));
  return Math.max(Number(durationSeconds) || 0, ...cuts, ...beats, 0);
}
