// Stage 5 — the motion script: the only thing the references cannot say.
//
// The references already carry who and where. Everything spent restating them
// is budget not spent on what the clip is actually about: what happens, when,
// what moves because of what, why the camera moved, and what it sounds like.
//
// Two failures this module is shaped against:
//
//   The animated poster. A beautiful still where the subject blinks and the
//   camera drifts. The cure is not more adjectives, it is a motion inventory
//   with a named force and a response at each depth.
//
//   The mushy beat. Three actions inside one three-second window, so none of
//   them reads. One dominant verb per beat, one emotional result.
//
// Pure: builds text, counts characters, and says what it would cut. The model
// -driven compression lives behind the producer; this is the half that can be
// tested and the half that runs when nothing is loaded.
import { CAMERA_MOTIVATION_TEST } from './board.js';

/** Depths that have to move separately, and what usually moves at each. */
export const MOTION_LAYERS = Object.freeze([
  { id: 'subject', label: 'Character', hint: 'Breath, gaze, a blink, an ear, a weight shift. State, not fidgeting.' },
  { id: 'cloth', label: 'Cloth and hair', hint: 'Draft, gravity, contact, and the settle afterwards.' },
  { id: 'contact', label: 'Contact object', hint: 'The thing being touched, lifted, poured, opened.' },
  { id: 'foreground', label: 'Foreground', hint: 'Something between the lens and the subject, moving faster.' },
  { id: 'midground', label: 'Midground', hint: 'Signage, a curtain, a plant, a passer-by.' },
  { id: 'background', label: 'Background atmosphere', hint: 'Rain layers, haze, distant traffic, cloud.' },
  { id: 'light', label: 'Light and reflection', hint: 'A reflection travelling, a practical flickering, cloud shadow.' },
]);

/** Sound as physical proof that the world is inhabited. */
export const AUDIO_LAYERS = Object.freeze([
  { id: 'action', label: 'Primary action', hint: 'The contact the picture shows — footsteps, a latch, paper, water.' },
  { id: 'character', label: 'Character', hint: 'Breath, a collar tag, fabric, a purr, a coo.' },
  { id: 'environment', label: 'Environment', hint: 'Room tone, weather, traffic, birds — the world past the frame.' },
  { id: 'voice', label: 'Voice', hint: 'One short line, a sigh, a laugh. Specificity, not exposition.' },
]);

export const MUSIC_RULES = Object.freeze([
  { id: 'none', label: 'No music', clause: 'No music.' },
  { id: 'sparse', label: 'Music only under the reward', clause: 'No music until the final beat; keep it under the diegetic sound.' },
  { id: 'scored', label: 'Scored throughout', clause: 'Music throughout, mixed under the diegetic sound.' },
]);

const text = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const second = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0;
};

export function blankBeat(from = 0, to = 5) {
  return { from, to, action: '', emotion: '' };
}

/**
 * Beats laid across the clip, one per equal slice.
 *
 * Three is the default because it is the smallest number that can carry a
 * change: something starts, something turns, something is left behind. Two
 * beats is a before and an after with no turn in between.
 */
export function defaultBeats(seconds = 15, count = 3) {
  const total = Math.max(1, second(seconds));
  const n = Math.max(1, Math.round(Number(count) || 3));
  const step = total / n;
  return Array.from({ length: n }, (_, index) => blankBeat(
    Math.round(index * step * 10) / 10,
    Math.round((index + 1) * step * 10) / 10,
  ));
}

/**
 * The sentence that makes the world breathe: one force, and what each depth
 * does about it.
 *
 * Cause first on purpose. "Rain, cloth, a sign and haze all move" is a list of
 * wiggles; naming the force and hanging the responses off it is a physics the
 * model can stay consistent with.
 *
 * The responses are joined with semicolons after a colon rather than read as a
 * list of objects ("wind moves A, B and C"), because a layer is written as a
 * noun phrase about half the time and as a whole clause the other half. Fitting
 * "the work coat shifts when the arm moves" into "wind moves ___" produces
 * "wind moves the work coat shifts when the arm moves" — which is what the
 * producer's own answers did on 2026-08-24. This form is grammatical for both.
 */
export function worldBreathesSentence({ force = '', layers = {} } = {}) {
  const named = text(force);
  const responses = MOTION_LAYERS
    .map((layer) => text(layers?.[layer.id]))
    .filter(Boolean)
    .map((value) => value.replace(/[.;\s]+$/, ''));
  if (!named && !responses.length) return '';
  if (!responses.length) return `Keep the world alive throughout: ${named} runs through the whole shot.`;
  const list = responses.join('; ');
  return named
    ? `Keep the world alive throughout — everything here is a response to ${named}: ${list}.`
    : `Keep the world alive throughout: ${list}.`;
}

/** "0–5s: …" with the emotional result attached to the action that caused it. */
function beatLine(beat) {
  const action = text(beat?.action);
  if (!action) return '';
  const emotion = text(beat?.emotion);
  const body = emotion ? `${action.replace(/[.\s]+$/, '')} — ${emotion}` : action;
  return `${second(beat?.from)}-${second(beat?.to)}s: ${body.replace(/[.\s]*$/, '')}.`;
}

/**
 * The whole script.
 *
 * The opening line states that the references are direction and not a shot
 * list, because a model handed a board and no such line tries to reproduce the
 * board and produces four static frames with cuts between them.
 */
export function motionScript({
  seconds = 15, beats = [], force = '', layers = {},
  camera = '', audio = '', music = 'none', negatives = '', continuation = '',
} = {}) {
  const timed = (Array.isArray(beats) ? beats : []).map(beatLine).filter(Boolean);
  if (!timed.length) return '';
  const rule = MUSIC_RULES.find((entry) => entry.id === music) || MUSIC_RULES[0];
  const world = worldBreathesSentence({ force, layers });
  return [
    `Animate this as one continuous cinematic ${second(seconds)}-second shot.`,
    'The attached references define who the characters are, where this is, and the visual style; treat the storyboard as direction, not a rigid shot list.',
    text(continuation) ? `This continues the previous shot: open on ${text(continuation)}.` : null,
    world || null,
    '',
    ...timed,
    '',
    text(camera) ? `Camera: ${text(camera)}. No aimless zoom.` : 'Camera: motivated moves only. No aimless zoom.',
    text(audio) ? `Audio: ${text(audio)}. ${rule.clause}` : `Audio: sound from the visible actions and the place. ${rule.clause}`,
    text(negatives) ? `Avoid: ${text(negatives)}.` : null,
  ].filter((line) => line !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Phrases that cost characters and change nothing.
 *
 * Every one of these is either a quality incantation with no directorial
 * meaning, or a camera word that describes drift rather than a decision. They
 * are removed by `tighten`, and shown to the user before they are, because a
 * compressor that silently edits your prompt is not a tool you can trust.
 */
export const EMPTY_PHRASES = Object.freeze([
  'masterpiece', 'best quality', 'highly detailed', 'ultra detailed', 'ultra realistic',
  'hyper realistic', 'photorealistic', 'award winning', 'award-winning', 'trending on artstation',
  '8k', '4k', 'uhd', 'high resolution', 'stunning', 'breathtaking', 'beautiful lighting',
  'perfect composition', 'cinematic lighting', 'professional', 'epic', 'very detailed',
  'slow zoom', 'slowly zooms', 'gentle zoom', 'subtle zoom',
]);

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Which empty phrases are actually in this draft. */
export function emptyPhrasesIn(script) {
  const body = String(script || '');
  return EMPTY_PHRASES.filter((phrase) => new RegExp(`\\b${escape(phrase)}\\b`, 'i').test(body));
}

/**
 * The deterministic half of compression: remove what provably says nothing,
 * and tidy the punctuation it leaves behind.
 *
 * It does NOT remove appearance or location description. Deciding that a
 * sentence is already carried by a reference needs to look at the reference,
 * which is a job for the producer, not for a regex.
 */
export function tighten(script) {
  let body = String(script || '');
  for (const phrase of EMPTY_PHRASES) {
    // The article goes with it. Deleting the noun out of "a masterpiece, wind
    // lifts the coat" and leaving the "a" behind is a worse sentence than the
    // one it replaced.
    body = body.replace(new RegExp(`(?:\\b(?:a|an|the)\\s+)?\\b${escape(phrase)}\\b`, 'gi'), '');
  }
  return body
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/,(\s*,)+/g, ',')
    .replace(/,\s*\./g, '.')
    .replace(/\.\s*\./g, '.')
    .split('\n')
    .map((line) => line.replace(/^\s*[,;]\s*/, '').replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Where a draft stands against a character budget, and what to do about it. */
export function budgetReport(script, { limit = 0 } = {}) {
  const body = String(script || '');
  const chars = body.length;
  const cap = Number(limit) || 0;
  const tightened = tighten(body);
  const savings = chars - tightened.length;
  return {
    chars,
    limit: cap,
    over: cap > 0 ? Math.max(0, chars - cap) : 0,
    fits: cap <= 0 || chars <= cap,
    tightenedChars: tightened.length,
    savings,
    emptyPhrases: emptyPhrasesIn(body),
  };
}

/** Things the script is missing that the clip will visibly lack. */
export function scriptWarnings({ seconds = 15, beats = [], force = '', layers = {}, audio = '', camera = '' } = {}) {
  const rows = (Array.isArray(beats) ? beats : []).filter((beat) => text(beat?.action));
  const warnings = [];
  if (!rows.length) return ['No timed action yet — the clip has nothing to do.'];
  const total = second(seconds);
  const last = Math.max(...rows.map((beat) => second(beat.to)));
  if (last > total) warnings.push(`A beat runs to ${last}s but the clip is ${total}s long. Anything past the end never happens.`);
  const covered = rows.reduce((sum, beat) => sum + Math.max(0, second(beat.to) - second(beat.from)), 0);
  if (covered < total * 0.8) {
    warnings.push(`Only ${covered}s of ${total}s is scripted. Unscripted time is time the model fills by itself.`);
  }
  for (const beat of rows) {
    const span = second(beat.to) - second(beat.from);
    const verbs = text(beat.action).split(/\b(?:then|and then|after that|before|while)\b/i).length;
    // Roughly one action per three seconds is the density that still reads.
    // Past that the beat is a summary of a scene, and the model renders the
    // average of it.
    if (span > 0 && verbs > 1 + (span / 3)) {
      warnings.push(`${second(beat.from)}-${second(beat.to)}s packs ${verbs} actions into ${span}s. One dominant verb per beat.`);
    }
  }
  if (!rows.some((beat) => text(beat.emotion))) {
    warnings.push('No beat carries an emotional change. Without a turn the clip is a list of attractive shots.');
  }
  const moving = MOTION_LAYERS.filter((layer) => text(layers?.[layer.id])).length;
  if (!text(force)) warnings.push('No force named. "Everything moves a bit" is what an animated poster looks like.');
  if (moving < 3) warnings.push(`Only ${moving} ${moving === 1 ? 'depth moves' : 'depths move'}. Give the subject, something it touches, and something behind it each a response.`);
  if (!text(camera)) warnings.push(`No camera plan. ${CAMERA_MOTIVATION_TEST}`);
  if (!text(audio)) warnings.push('No audio. Sound from the visible actions is what makes a generated world feel inhabited.');
  return warnings;
}

/**
 * Split a long story into generations that each have one job.
 *
 * Thirty seconds asked for in one go is thirty seconds of continuity pressure
 * on a model that has to hold identity, action, camera and sound at once.
 * Two fifteens, each with a single emotional job and a stated handoff state,
 * come back better and fail more cheaply.
 */
export function segmentPlan({ totalSeconds = 30, perGeneration = 15, jobs = [] } = {}) {
  const total = Math.max(1, second(totalSeconds));
  const each = Math.max(1, second(perGeneration));
  const count = Math.max(1, Math.ceil(total / each));
  const defaults = ['setup and the emotional turn', 'the reward and the afterglow'];
  return Array.from({ length: count }, (_, index) => {
    const from = Math.round(index * each * 10) / 10;
    const to = Math.min(total, Math.round((index + 1) * each * 10) / 10);
    return {
      index: index + 1,
      from,
      to,
      seconds: Math.round((to - from) * 10) / 10,
      job: text(jobs?.[index]) || defaults[index] || `part ${index + 1}`,
      // The whole reason to split: the next generation has to be able to start
      // where this one stopped. A boundary with no stated state is where
      // continuity breaks.
      boundary: index + 1 < count
        ? 'End on a stable pose, gaze, prop state and framing the next generation can open on.'
        : '',
    };
  });
}
