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
import { identityLines } from './characterSheet.js';
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
 * Everything the Video studio needs, in one object.
 *
 * `script` is the prose the motion stage already renders, and rides along
 * unchanged: it is what a model with no reference lane gets, and what the
 * composer shows if the references cannot be attached. `template` is the same
 * content as structure, used when the target IS H3's reference format.
 */
export function storyHandoff(story, { script = '' } = {}) {
  const subjects = storySubjects(story);
  const cast = [...subjects, ...storyScenes(story)];
  const label = subjectLabeller(subjects);
  return {
    format: 'story-production',
    script: String(script || ''),
    cast,
    seconds: seconds(story?.motion?.seconds),
    aspect: text(story?.aspect),
    template: {
      summary: label(text(story?.promise) || text(story?.title)),
      style: storyStyleLine(story, subjects),
      beats: storyBeats(story, label),
      ...storySound(story),
    },
    // What the toast should be able to say without recounting the cast.
    counts: {
      subjects: cast.filter((member) => member.kind !== 'scene').length,
      scenes: cast.filter((member) => member.kind === 'scene').length,
      pictures: cast.reduce((sum, member) => sum + (member.data?.images || []).length, 0),
    },
  };
}
