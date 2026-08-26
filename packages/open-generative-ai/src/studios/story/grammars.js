// The same production, written the way each target wants to read it.
//
// A prompt is written FOR a model, not for an idea — the studio already says so
// where the starters live (lib/defaultPrompts.js), and it is the reason every
// starter appears once per family. The Story studio holds one production and
// can be sent to any of them, so this is where the one production becomes each
// family's own text. What differs is not decoration:
//
//   H3          renders its own stereo audio, so the script has to say what is
//               heard, and it is trained on a sectioned rewrite. Prohibitions
//               are documented NOT to work.
//   LTX 2.3     one flowing paragraph, style and camera first, no timestamps
//               and no quoted dialogue; prohibitions belong in negative_prompt,
//               and the native distilled path does not even read it, so an
//               unwanted thing named in the positive prompt is a thing asked
//               for (registry prompt_contract).
//   10Eros      the same but as a scene script — subject, action, camera,
//               lighting, affirmatively, in one block.
//   Seedance    labelled uppercase blocks with a TIMELINE, and it DOES take
//               prohibitions in the prompt. Not portable from H3, on purpose.
//
// Every writer takes the same story and returns the same shape, so the handoff
// never branches on which one ran.
import { motionElements } from './location.js';
import { MUSIC_RULES, motionScript, worldBreathesSentence } from './motionScript.js';

const text = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const sec = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0;
};
const clean = (value) => text(value).replace(/[.\s]+$/, '');
// A clause written to stand on its own inside a paragraph. The story's fields
// are phrases ("his hand reaches past it"), and a paragraph of them left
// lower-cased after a full stop reads as one run-on sentence the model parses
// as a single action.
const sentence = (value) => {
  const body = clean(value);
  return body ? `${body.charAt(0).toUpperCase()}${body.slice(1)}.` : '';
};

/** MM:SS.mmm — the anchor notation H3's own guide uses for a point in a clip. */
function timecode(seconds) {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(Math.floor(ms / 60000), 2)}:${pad(Math.floor((ms % 60000) / 1000), 2)}.${pad(ms % 1000, 3)}`;
}

/** The characters that actually have a drawn sheet, in cast order. */
export const drawnCharacters = (story) => (story?.characters || []).filter((row) => row?.sheetUrl);

/**
 * One character as PROSE: who they are and what must not drift.
 *
 * Deliberately not identityLines(), which is the labelled form the sheet prompt
 * and H3's subject_definitions want ("Silhouette: …. Face: …."). Dropped into a
 * paragraph for LTX or a SUBJECT block for Seedance, those labels are read as
 * text to render — and "Who they are: the moth, the companion, moth" is not a
 * sentence anybody would write about a character.
 */
export function characterPhrase(character) {
  const name = clean(character?.name);
  const role = clean(character?.role);
  const species = clean(character?.species);
  const traits = [character?.silhouette, character?.face, character?.pattern, character?.signature]
    .map(clean).filter(Boolean).join(', ');
  const behaviour = clean(character?.behavior);
  // "the moth, the companion, a moth" — the species is only worth saying when
  // the name and role have not already said it.
  const said = `${name} ${role}`.toLowerCase();
  const noun = species && !said.includes(species.toLowerCase()) ? `a ${species}` : '';
  const head = [name, role, noun].filter(Boolean).join(', ');
  if (!head && !traits) return '';
  const body = [head || 'a character', traits && `— ${traits} —`].filter(Boolean).join(' ').replace(/ —$/, '');
  return [body.replace(/—\s*$/, '').trim(), behaviour].filter(Boolean).join('; ');
}

/** Where this is, as prose rather than as a plate prompt. */
export function placePhrase(story) {
  const location = story?.location || {};
  const moving = motionElements(location);
  return [
    clean(location.place),
    clean([text(location.time), text(location.weather)].filter(Boolean).join(', ')),
    clean(location.depth),
    clean(location.lights) && `lit by ${clean(location.lights)}`,
    clean(location.palette),
    moving.length ? `${moving.join(', ')} all present and able to move` : '',
  ].filter(Boolean).join('; ');
}

/** The beats as timed lines, each with the emotional result attached. */
export function beatLines(story, { anchor = 'range' } = {}) {
  const beats = (story?.motion?.beats || []).filter((beat) => text(beat?.action));
  let at = 0;
  return beats.map((beat, index) => {
    const body = clean(beat.emotion) ? `${clean(beat.action)} — ${clean(beat.emotion)}` : clean(beat.action);
    const from = sec(beat.from);
    const to = sec(beat.to);
    at = to;
    if (anchor === 'shots') return index === 0 ? `[Shot 1] ${body}.` : `[Shot ${index + 1}] At ${timecode(from)}, ${body}.`;
    if (anchor === 'none') return `${body}.`;
    return `${from}-${to}s: ${body}.`;
  });
}

/** What is heard, and what the score does. Only H3 renders either. */
export function soundLines(story) {
  const motion = story?.motion || {};
  const rule = MUSIC_RULES.find((entry) => entry.id === motion.music) || MUSIC_RULES[0];
  return {
    soundscape: clean(motion.audio),
    music: rule.id === 'none' ? 'none' : rule.clause,
  };
}

/** Things the clip must not do, as the target's own vocabulary allows. */
export const negativeLine = (story) => clean(story?.motion?.negatives);

/* ---------------- one writer per grammar ---------------- */

/**
 * H3 text mode: the three-field form.
 *
 * Every character is described IN the description, because nothing is
 * attached — this is the grammar for an H3 run with no pictures, and a name
 * with no description is a stranger.
 */
function writeH3Text(story) {
  const motion = story?.motion || {};
  const { soundscape, music } = soundLines(story);
  const cast = drawnCharacters(story).length ? drawnCharacters(story) : (story?.characters || []);
  const opening = [
    `One continuous cinematic ${sec(motion.seconds)}-second shot${clean(story?.style) ? `, ${clean(story.style)}` : ''}.`,
    cast.map(characterPhrase).filter(Boolean).map(sentence).join(' '),
    placePhrase(story) ? sentence(`The whole shot is at ${placePhrase(story)}`) : '',
    worldBreathesSentence({ force: motion.force, layers: motion.layers }),
    clean(motion.camera) ? `Camera: ${clean(motion.camera)}. No aimless zoom.` : '',
  ].filter(Boolean).join(' ');
  const description = [opening, ...beatLines(story, { anchor: 'shots' })].filter(Boolean).join('\n');
  return {
    prompt: [
      `integrated_multimodal_description: ${description}`,
      `overall_soundscape: ${soundscape || 'Room tone from the place itself. No speech and no music.'}`,
      `non_diegetic_music: ${music}`,
    ].join('\n\n'),
    negativePrompt: '',
  };
}

/**
 * LTX 2.3: one flowing paragraph.
 *
 * Style and camera open it, the characters are described where they first
 * appear, the beats become sentences in order, and nothing is timestamped —
 * LTX has no shot grammar and a "[Shot 2] At 00:05" reads as literal on-screen
 * text. Prohibitions leave the prompt entirely: on the native distilled
 * extension path a negative is not merely ignored, it is read as a request.
 *
 * `named` is for the ingredients lane, where the sheet carries the look and
 * repeating it in the paragraph makes the two descriptions compete.
 */
function writeLtxParagraph(story, { named = false } = {}) {
  const motion = story?.motion || {};
  const cast = drawnCharacters(story).length ? drawnCharacters(story) : (story?.characters || []);
  const who = named
    ? cast.map((row) => clean(row.name) || 'the character').filter(Boolean)
    : cast.map(characterPhrase).filter(Boolean);
  // Named: one sentence binding the paragraph to the sheet. Otherwise each
  // character is its own sentence — joined into one, the second onwards stayed
  // lower-cased after a full stop and read as a continuation of the first.
  const intro = named && who.length
    ? sentence(`${who.join(' and ')} from the reference sheet`)
    : who.map(sentence).join(' ');
  const body = [
    sentence(clean(story?.style)),
    clean(motion.camera) ? sentence(`The camera runs ${clean(motion.camera)}`) : '',
    intro || '',
    placePhrase(story) ? sentence(`The whole shot is at ${placePhrase(story)}`) : '',
    worldBreathesSentence({ force: motion.force, layers: motion.layers }),
    ...beatLines(story, { anchor: 'none' }).map(sentence),
  ].filter(Boolean).join(' ');
  return { prompt: body.replace(/\s+/g, ' ').trim(), negativePrompt: negativeLine(story) };
}

/** 10Eros: the same content as a scene script, affirmative, in one block. */
function writeLtxSceneScript(story) {
  const motion = story?.motion || {};
  const cast = drawnCharacters(story).length ? drawnCharacters(story) : (story?.characters || []);
  return {
    prompt: [
      cast.map(characterPhrase).filter(Boolean).map(sentence).join(' '),
      placePhrase(story) ? sentence(`At ${placePhrase(story)}`) : '',
      beatLines(story, { anchor: 'none' }).map(sentence).join(' '),
      clean(motion.camera) ? sentence(`Camera: ${clean(motion.camera)}`) : '',
      sentence(clean(story?.style)),
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
    negativePrompt: negativeLine(story),
  };
}

/**
 * Seedance: labelled uppercase blocks.
 *
 * The one family here that takes prohibitions in the prompt itself, which is
 * why the negatives come back INSIDE the text rather than beside it — style is
 * not portable between models, and applying H3's "no X does not work" rule here
 * would throw away a control that does.
 */
function writeSeedanceBlocks(story) {
  const motion = story?.motion || {};
  const { soundscape } = soundLines(story);
  const cast = drawnCharacters(story).length ? drawnCharacters(story) : (story?.characters || []);
  const negatives = negativeLine(story);
  const blocks = [
    ['SUBJECT', cast.map(characterPhrase).filter(Boolean).map(sentence).join('\n')],
    ['SETTING', sentence(placePhrase(story))],
    ['VISUAL STYLE', sentence(clean(story?.style))],
    ['TIMELINE', beatLines(story, { anchor: 'range' }).join('\n')],
    ['CAMERA', clean(motion.camera) ? `${sentence(motion.camera)} No aimless zoom.` : ''],
    ['AUDIO', sentence(soundscape)],
    ['GOAL', sentence(clean(story?.promise))],
  ].filter(([, body]) => body);
  const head = `Create a ${sec(motion.seconds)}-second continuous shot. `
    + 'Keep every character\'s face, build, markings and wardrobe identical throughout.';
  const tail = negatives ? `\n\nNo ${negatives.replace(/^no\s+/i, '')}.` : '';
  return {
    prompt: `${head}\n\n${blocks.map(([name, body]) => `${name}:\n${body}`).join('\n\n')}${tail}`,
    negativePrompt: '',
  };
}

/** The writers, by grammar id. */
const WRITERS = {
  'h3-text': (story) => writeH3Text(story),
  'ltx-paragraph': (story) => writeLtxParagraph(story),
  'ltx-ingredients': (story) => writeLtxParagraph(story, { named: true }),
  'ltx-scene-script': (story) => writeLtxSceneScript(story),
  'seedance-blocks': (story) => writeSeedanceBlocks(story),
};

/**
 * The story, in one grammar.
 *
 * `h3-reference` is deliberately absent: that grammar is compiled by the weave
 * from the cast and the structured template, and a second compiler for it is
 * exactly what lib/promptWeave.js exists to have replaced. It returns the
 * fallback prose, which is what the composer shows if the references cannot be
 * attached after all.
 */
export function writeStoryFor(grammarId, story) {
  const writer = WRITERS[grammarId];
  if (writer) return writer(story);
  return { prompt: motionScript(story?.motion || {}), negativePrompt: '' };
}
