// Stage 5 → the Video studio: the production handed over as STRUCTURE.
//
// The six staged decisions already answered, separately, every question H3's
// reference format asks: who the subjects are (the character sheets), where
// this is (the location plate), how it is staged (the storyboard), what happens
// and when (the beats), what it sounds like, and how long it runs. Flattening
// all of that into one paragraph and posting the paragraph — which is what this
// handoff used to do — threw away the part the target format wanted most, and
// then attached none of the pictures the paragraph referred to. The video
// studio opened with prose about references that were not there.
//
// So the handoff carries the pieces. The Video studio's weave (lib/promptWeave)
// stays the only thing that compiles them: this module decides WHAT is handed
// over, never what the prompt looks like, because a second prompt compiler is
// exactly the thing that weave exists to have replaced.
//
// Pure and JSX-free so the node:test suite can prove the mapping.
import { sceneMember } from '../../lib/promptWeave.js';
import { deliveryPlan, grammarFor } from '../../lib/videoDelivery.js';
import { identityLines } from './characterSheet.js';
import { characterPhrase, writeStoryFor } from './grammars.js';
import { MUSIC_RULES, worldBreathesSentence } from './motionScript.js';

const text = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const seconds = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0;
};

/**
 * The people, as cast members.
 *
 * Only characters whose sheet was actually drawn: the sheet IS the reference,
 * and a member with no picture would take a <Subject N> and contribute nothing
 * to look at. Each carries its own identity lines as the appearance, because
 * H3 holds identity from those words as much as from the picture — which is
 * the whole reason the sheet stage writes them down.
 */
export function storySubjects(story) {
  return (story?.characters || [])
    .filter((character) => character?.sheetUrl)
    .map((character, index) => ({
      key: `story:subject:${character.id || index}`,
      kind: 'persona',
      name: text(character.name),
      // Kept in the cast even before anything else is attached — this member IS
      // the sheet, not something derived from loose rows.
      explicit: true,
      // The production's own style covers everyone in it. Empty is a real
      // answer and writes no style line: better silence than the persona
      // default asserting real human skin and hair over a cartoon dog.
      style: text(story?.style),
      // A story cast is not necessarily human, and the species is the honest
      // noun for it. "the character shown in <Picture 1>" when none was given.
      noun: text(character.species) || 'character',
      data: {
        v: 1,
        gender: '',
        // The compiler closes the definition with its own full stop and the
        // identity lines already end in one — "stands square.." otherwise.
        look: identityLines(character).join(' ').replace(/\.+$/, ''),
        images: [character.sheetUrl],
        videos: [],
        audios: [],
      },
    }));
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rewrite the cast's own names as the subject labels they now hold.
 *
 * The story stages are written in prose about named characters, because that is
 * how a person writes a story. H3 binds a subject to its pictures through the
 * <Subject N> label, so a description saying "the moth drops onto the ticket"
 * defines a subject the shot never addresses — the Prompt Check says so out
 * loud, and the model decides for itself who fills the slot.
 *
 * Longest name first: with a cast of "Mira" and "Mira's mother", replacing the
 * short one first leaves "<Subject 1>'s mother" standing where the second
 * subject should be. Nothing here touches dialogue, because a story beat has
 * none — words that get SAID are never rewritten.
 */
export function subjectLabeller(subjects = []) {
  const named = subjects
    .map((member, index) => ({ name: text(member.name), label: `<Subject ${index + 1}>` }))
    .filter((entry) => entry.name)
    .sort((a, b) => b.name.length - a.name.length);
  if (!named.length) return (value) => String(value || '');
  return (value) => named.reduce(
    (body, entry) => body.replace(new RegExp(`\\b${escapeRegExp(entry.name)}\\b`, 'gi'), entry.label),
    String(value || ''),
  );
}

/**
 * The place and the board, as scene members.
 *
 * Both are pictures the model must be told about and neither is a person. They
 * go LAST so <Picture 1> is a subject — the numbering is order-of-supply, and a
 * prompt whose first picture is a storyboard reads worse to a human reviewing it.
 */
export function storyScenes(story) {
  const members = [];
  const place = text(story?.location?.place);
  if (story?.location?.plateUrl) {
    members.push(sceneMember({
      key: 'story:place',
      name: place,
      images: [story.location.plateUrl],
      retention: 'attribute_transfer',
      carries: `the empty ${place || 'location'} plate for this clip: its architecture, materials, palette, `
        + 'light and layout, with no one in it',
    }));
  }
  if (story?.board?.sheetUrl) {
    members.push(sceneMember({
      key: 'story:board',
      name: '',
      images: [story.board.sheetUrl],
      retention: 'weak_reference',
      carries: 'the storyboard for this clip: the order of the action and roughly where things sit in frame',
    }));
  }
  return members;
}

/** The whole cast: subjects first, then the places they are in. */
export const storyCast = (story) => [...storySubjects(story), ...storyScenes(story)];

/**
 * The opening lines of the description — everything true of the WHOLE take
 * rather than of one beat.
 *
 * It deliberately no longer says "treat the storyboard as direction, not a
 * rigid shot list": with the board attached as a scene reference, that promise
 * is written in H3's own grammar as its weak_reference retention line, and
 * saying it twice in two vocabularies is budget spent on nothing.
 */
export function storyStyleLine(story, subjects = []) {
  const motion = story?.motion || {};
  const length = seconds(motion.seconds);
  const style = text(story?.style);
  const labels = subjects.map((_, index) => `<Subject ${index + 1}>`);
  const cast = labels.length > 1
    ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]} are the only characters in it.`
    : (labels.length === 1 ? `${labels[0]} is the only character in it.` : '');
  return [
    `One continuous cinematic ${length}-second shot${style ? `, ${style}` : ''}.`,
    // Every subject addressed at least once, guaranteed. A subject that is
    // defined and then never named is a slot the model fills with whoever it
    // likes — and beats written in pronouns ("his hand reaches past it") name
    // nobody at all.
    cast || null,
    worldBreathesSentence({ force: motion.force, layers: motion.layers }) || null,
    text(motion.camera) ? `Camera: ${text(motion.camera)}. No aimless zoom.` : 'Camera: motivated moves only. No aimless zoom.',
    text(motion.negatives) ? `Avoid: ${text(motion.negatives)}.` : null,
  ].filter(Boolean).join('\n');
}

/** Story beats -> compiler beats. A span with one thing happening in it. */
export function storyBeats(story, label = (value) => String(value || '')) {
  return (story?.motion?.beats || [])
    .filter((beat) => text(beat?.action))
    .map((beat) => {
      const action = label(text(beat.action)).replace(/[.\s]+$/, '');
      const emotion = label(text(beat.emotion));
      return {
        seconds: Math.max(0, seconds(beat.to) - seconds(beat.from)),
        action: `${emotion ? `${action} — ${emotion}` : action}.`,
      };
    });
}

/** What the clip sounds like, split H3's way: diegetic here, score separately. */
export function storySound(story) {
  const motion = story?.motion || {};
  const rule = MUSIC_RULES.find((entry) => entry.id === motion.music) || MUSIC_RULES[0];
  return {
    overall_soundscape: text(motion.audio),
    non_diegetic_music: rule.id === 'none' ? 'none' : rule.clause,
  };
}

/**
 * One line saying what would actually travel to a target — for a Send-to menu.
 *
 * Built from the HANDOFF rather than from a count, because how many pictures
 * survive the trip is a property of the production and the target together: a
 * storyboard is a scene reference to H3 and nothing at all to LTX's ingredients
 * lane, so "4 pictures" is the wrong answer to both.
 */
export function describeHandoff(handoff) {
  const { pictures = 0, available = 0, unattached = 0 } = handoff?.counts || {};
  const kind = handoff?.grammar === 'ltx-ingredients'
    ? 'ingredient references'
    : 'reference pictures';
  const trimmed = handoff?.seconds < handoff?.askedSeconds
    ? `, trimmed to ${handoff.seconds}s`
    : '';
  if (!available) return `${'the script only'}${trimmed}`;
  if (!pictures) return `${`no picture lane — ${available} would not travel`}${trimmed}`;
  const some = unattached
    ? `${pictures} of ${available} as ${kind}`
    : `${pictures} as ${kind}`;
  return `${some}${trimmed}`;
}

/**
 * The pictures this story has, as LTX ingredient views.
 *
 * LTX's ingredients lane stitches reference views into one sheet and lets each
 * view carry its own caption, which is exactly the shape a character sheet and
 * its identity lines already are. Characters first, then the place — the
 * stitched sheet reads in supply order the same way H3's pictures do.
 */
export function storyIngredients(story, { max = 12 } = {}) {
  const views = drawn(story).map((character) => ({
    url: character.sheetUrl,
    description: characterPhrase(character) || text(character.name),
  }));
  if (story?.location?.plateUrl) {
    views.push({
      url: story.location.plateUrl,
      description: `The setting, with no one in it: ${text(story.location.place) || 'the location'}`,
    });
  }
  return views.slice(0, max);
}

const drawn = (story) => (story?.characters || []).filter((character) => character?.sheetUrl);

/**
 * Everything the Video studio needs, in one object — shaped for THIS target.
 *
 * `plan` comes from lib/videoDelivery.js and is the only thing that decides
 * what travels: the same production goes to H3's reference lane as a cast plus
 * a structured template, to LTX as stitched ingredient views plus a paragraph,
 * and to a model with no picture lane as its own prose with nothing attached
 * and an honest count of what could not come. Omitted, the plan is the one that
 * promises least, because a handoff that assumes a lane it does not have is the
 * bug this whole module exists to fix.
 *
 * `script` is the prose the motion stage already renders and rides along
 * unchanged: it is the last-resort text if even the written prompt cannot be
 * used, and it is what the user saw on the Story page.
 */
export function storyHandoff(story, { script = '', plan = null, modelId = '' } = {}) {
  const target = plan || deliveryPlan(null);
  const subjects = storySubjects(story);
  const scenes = storyScenes(story);
  const available = drawn(story).length
    + (story?.location?.plateUrl ? 1 : 0)
    + (story?.board?.sheetUrl ? 1 : 0);
  const kind = target.pictures?.kind || '';
  const cast = kind === 'reference' ? [...subjects, ...scenes] : [];
  const ingredients = kind === 'ingredients' ? storyIngredients(story, { max: target.pictures.max }) : [];
  const attached = kind === 'reference'
    ? Math.min(cast.reduce((sum, member) => sum + (member.data?.images || []).length, 0), target.pictures.max)
    : ingredients.length;
  const grammar = grammarFor(target, { pictures: attached }).id;
  const label = subjectLabeller(subjects);
  // The reference grammar is compiled by the weave from the cast and the
  // template — never here. Every other grammar is written out.
  const written = grammar === 'h3-reference'
    ? { prompt: '', negativePrompt: '' }
    : writeStoryFor(grammar, story);
  const asked = seconds(story?.motion?.seconds);
  const runtime = target.maxSeconds ? Math.min(asked, target.maxSeconds) : asked;
  return {
    format: 'story-production',
    grammar,
    // The model the story was WRITTEN for. Carried so the target lands on it
    // rather than on whatever it would otherwise have booted into — a plan and
    // a model that disagree is a prompt in the wrong grammar with the wrong
    // things attached.
    modelId: String(modelId || ''),
    script: String(script || ''),
    prompt: written.prompt,
    // Only where the target reads one. H3 documents that "no X" does not work,
    // and Seedance takes its prohibitions inside the prompt instead.
    negativePrompt: target.negatives ? written.negativePrompt : '',
    cast,
    ingredients,
    seconds: runtime,
    // What was asked for, so a clamp can be said out loud rather than noticed
    // later as a beat that never rendered.
    askedSeconds: asked,
    aspect: text(story?.aspect),
    template: kind === 'reference' ? {
      summary: label(text(story?.promise) || text(story?.title)),
      style: storyStyleLine(story, subjects),
      beats: storyBeats(story, label),
      ...storySound(story),
    } : null,
    // What the toast should be able to say without recounting anything.
    counts: {
      subjects: subjects.length,
      scenes: scenes.length,
      available,
      pictures: attached,
      unattached: Math.max(0, available - attached),
    },
  };
}
