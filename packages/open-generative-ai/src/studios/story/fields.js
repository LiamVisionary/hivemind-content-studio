// Every field the producer can fill, and what it is allowed to know while
// filling it.
//
// One registry, because two things have to agree about a field and they are
// written in different languages: the studio renders its label and hint, and
// the producer is told what belongs in it. A hint that drifts from the
// guidance is a model confidently filling a box with the wrong kind of thing.
// So the JSX reads its labels from here too — there is no second copy.
//
// The other half of this module is CONTEXT. "Fill this in from what I have
// already written" only works if what has already been written is gathered
// from the whole production rather than the section in view: a location's
// weather should follow the emotional turn, a caption's hook should follow the
// signature detail six stages upstream. `storyContext()` is that gather, minus
// whatever is being filled — a field is not evidence for itself.
import { IDENTITY_LOCKS } from './characterSheet.js';
import { MOTION_LAYERS } from './motionScript.js';
import { SHOT_REASONS } from './board.js';
import { CAPTION_BEATS } from './qa.js';
import { TONES } from './concept.js';

/** Read `a.b[0].c` off an object. Returns '' rather than throwing on a path
 *  that does not exist yet — a character removed while a fill was in flight. */
export function readPath(root, path) {
  let node = root;
  for (const step of String(path || '').split('.')) {
    for (const part of step.split('[')) {
      if (node == null) return '';
      const key = part.endsWith(']') ? Number(part.slice(0, -1)) : part;
      node = node[key];
    }
  }
  return node == null ? '' : node;
}

/** A copy of `root` with `path` set to `value`. Copies only the nodes along the
 *  path, so React sees new objects exactly where something changed. */
export function writePath(root, path, value) {
  const steps = [];
  for (const step of String(path || '').split('.')) {
    for (const part of step.split('[')) {
      steps.push(part.endsWith(']') ? Number(part.slice(0, -1)) : part);
    }
  }
  if (!steps.length) return root;
  const clone = (node) => (Array.isArray(node) ? [...node] : { ...(node || {}) });
  const next = clone(root);
  let node = next;
  for (let i = 0; i < steps.length - 1; i += 1) {
    node[steps[i]] = clone(node[steps[i]]);
    node = node[steps[i]];
  }
  node[steps[steps.length - 1]] = value;
  return next;
}

const field = (id, label, hint, extra = {}) => ({ id, label, hint, kind: 'line', ...extra });

// Guidance is written for the model, in the imperative, and stays short: it is
// repeated into every fill request and the budget belongs to the answer.
const CONCEPT_FIELDS = [
  field('brief.pitch', 'The brief',
    'The whole idea in one or two sentences: a pair, a place, and the feeling. Not a list of fields.',
    { kind: 'text' }),
  field('brief.person', 'Human', 'The person in the pair. A specific role and situation, not a name.'),
  field('brief.companion', 'Companion', 'The animal or creature. Say its size and what makes its silhouette its own.'),
  field('brief.world', 'World', 'Where this lives. Somewhere with weather, depth and something that can move.'),
  field('brief.avoid', 'Must never appear', 'What the whole production must not contain. Said once here.'),
  field('style', 'Visual style', 'One line of art direction used in every image prompt. Medium, palette, finish.', { kind: 'text' }),
  field('title', 'Title', 'Two or three words. A name, not a description.'),
  field('promise', 'Story promise', 'One sentence the whole clip has to keep.', { kind: 'text' }),
];

const CONTRACT_FIELDS = [
  field('contract.pressure', 'When this happens', 'The ordinary pressure that starts it. Small and recurring, not a catastrophe.'),
  field('contract.who', 'This character', 'Which of the pair is under the pressure.'),
  field('contract.goal', 'Tries to', 'What they are trying to get done. A plain verb phrase.'),
  field('contract.other', 'While this one', 'The other half of the pair.'),
  field('contract.behavior', 'Responds by', 'The behaviour only this character would perform. This is the whole story.'),
  field('contract.reward', 'Turning it into', 'What the moment becomes. The feeling the viewer leaves with.'),
];

const LOCATION_FIELDS = [
  field('location.place', 'Place', 'The location itself, named concretely enough to draw.'),
  field('location.time', 'Time', 'Time of day. The light has to come from somewhere.'),
  field('location.weather', 'Weather', 'Weather and air. This is where most of the motion comes from.'),
  field('location.palette', 'Palette', 'The two or three colours the plate lives in.'),
  field('location.accent', 'Single accent', 'One colour allowed to be loud, and where it sits.'),
  field('location.lights', 'Practical lights', 'The light sources visible in frame.'),
  field('location.depth', 'Foreground → midground → background', 'What sits at each depth. A plate with no stated depth comes back flat.', { kind: 'text' }),
  field('location.forbid', 'Must not appear', 'What must be absent. The plate is empty of people and animals by default.'),
];

const MOTION_FIELDS = [
  field('motion.force', 'The force', 'The single cause everything else responds to. Name it physically.'),
  ...MOTION_LAYERS.map((layer) => field(
    `motion.layers.${layer.id}`, layer.label,
    `What this depth does in response to the force. ${layer.hint}`, { kind: 'text' },
  )),
  field('motion.camera', 'Camera', 'Two to four motivated angle changes, in order. Say what each one reveals.', { kind: 'text' }),
  field('motion.audio', 'Audio', 'Sounds made by things visible in the shot, and the room beyond it.', { kind: 'text' }),
  field('motion.negatives', 'Avoid', 'What must not appear or happen in the clip.'),
];

/**
 * The fillable fields of one section, expanded against the production.
 *
 * Characters, panels and beats are lists the director grows, so their fields
 * cannot be a static table — the registry describes one row and this stamps it
 * out per index, with the row's own name in the label so a fill button in a
 * six-panel board says which panel it belongs to.
 */
export function fieldsFor(sectionId, story = {}) {
  switch (sectionId) {
    case 'concept':
      return [...CONCEPT_FIELDS, ...CONTRACT_FIELDS];
    case 'characters':
      return (story.characters || []).flatMap((character, index) => {
        const who = character?.name || `character ${index + 1}`;
        return [
          field(`characters[${index}].name`, 'Name', `A name for ${who}. Short and sayable.`),
          field(`characters[${index}].role`, 'Role', `What ${who} does, and roughly how old they are.`),
          field(`characters[${index}].species`, 'Species', `What ${who} is — human, or which animal.`),
          ...IDENTITY_LOCKS.map((lock) => field(
            `characters[${index}].${lock.id}`, lock.label,
            `${lock.label} for ${who}. ${lock.hint}`, { kind: 'text' },
          )),
          field(`characters[${index}].never`, 'Never change',
            `The things about ${who} that must not drift between generations.`, { kind: 'text' }),
        ];
      });
    case 'location':
      return LOCATION_FIELDS;
    case 'board':
      return [
        field('board.arc', 'Emotional arc', 'From what feeling to what feeling, in a few words.'),
        ...(story.board?.panels || []).flatMap((panel, index) => {
          const n = panel?.n ?? index + 1;
          return [
            field(`board.panels[${index}].verb`, `Panel ${n} — dominant action`,
              `The one thing that happens in panel ${n} (${panel?.job || 'a beat'}). One dominant verb, different from every other panel.`,
              { kind: 'text' }),
            field(`board.panels[${index}].shot`, `Panel ${n} — shot`,
              `Which shot panel ${n} needs. Answer with exactly one of these ids.`,
              { options: SHOT_REASONS.map((entry) => entry.id) }),
            field(`board.panels[${index}].reason`, `Panel ${n} — camera reason`,
              `Finish "the viewer now needs to discover ___" for panel ${n}.`),
            field(`board.panels[${index}].motion`, `Panel ${n} — what moves`,
              `One thing moving in panel ${n}.`),
          ];
        }),
      ];
    case 'motion':
      return [
        ...MOTION_FIELDS,
        ...(story.motion?.beats || []).flatMap((beat, index) => [
          field(`motion.beats[${index}].action`, `${beat?.from ?? 0}–${beat?.to ?? 0}s — action`,
            `The ONE dominant action between ${beat?.from ?? 0}s and ${beat?.to ?? 0}s. No "then".`,
            { kind: 'text' }),
          field(`motion.beats[${index}].emotion`, `${beat?.from ?? 0}–${beat?.to ?? 0}s — what it changes`,
            `The emotional result of that action. What is different afterwards.`, { kind: 'text' }),
        ]),
      ];
    case 'ship':
      return CAPTION_BEATS.map((beat) => field(
        `qa.caption.${beat.id}`, beat.label, `${beat.asks} Write the caption line itself, not a description of it.`,
        { kind: 'text' },
      ));
    default:
      return [];
  }
}

/** The one field with this id, or null. Searched across every section so a
 *  single-field fill does not have to know which stage it came from. */
export function fieldById(id, story = {}) {
  for (const section of ['concept', 'characters', 'location', 'board', 'motion', 'ship']) {
    const found = fieldsFor(section, story).find((entry) => entry.id === id);
    if (found) return found;
  }
  return null;
}

const filled = (value) => String(value ?? '').trim().length > 0;

/** The fields of a section that are still empty — what a section fill asks for. */
export function blankFieldsIn(sectionId, story = {}) {
  return fieldsFor(sectionId, story).filter((entry) => !filled(readPath(story, entry.id)));
}

/**
 * Everything the director has written, gathered for the producer.
 *
 * Two rules. It is the WHOLE production, not the section in view — a caption's
 * hook is better for knowing the signature detail six stages upstream. And it
 * omits the fields being filled, because a field offered as evidence for
 * itself is how a model returns what is already there.
 *
 * Empty values are dropped rather than sent as "": a wall of blank keys reads
 * to a small model as a form to complete, and it completes all of them.
 */
export function storyContext(story = {}, { omit = [] } = {}) {
  const skip = new Set(omit);
  const context = {};
  const put = (path, value) => {
    if (skip.has(path) || !filled(value)) return;
    context[path] = String(value).trim();
  };
  for (const section of ['concept', 'characters', 'location', 'board', 'motion', 'ship']) {
    for (const entry of fieldsFor(section, story)) put(entry.id, readPath(story, entry.id));
  }
  // Facts that are not fields but change what a good answer is.
  const tone = TONES.find((entry) => entry.id === story.brief?.tone);
  if (tone) context['brief.tone'] = tone.label;
  if (story.brief?.count) context['brief.count'] = String(story.brief.count);
  if (story.aspect) context.aspect = String(story.aspect);
  if (story.motion?.seconds) context['motion.seconds'] = `${story.motion.seconds}s`;
  if (story.board?.format) context['board.format'] = String(story.board.format);
  const locked = (story.concepts || []).find((concept) => concept.id === story.lockedId);
  if (locked) {
    context['concept.locked'] = [locked.title, locked.pair, locked.hook, locked.friction, locked.reward, locked.signature]
      .map((part) => String(part || '').trim()).filter(Boolean).join(' · ');
  }
  return context;
}

/** Sections in production order — the order a fill gathers context in, and the
 *  order the studio's stages are in. */
export const FILLABLE_SECTIONS = Object.freeze(['concept', 'characters', 'location', 'board', 'motion', 'ship']);

/** Every fillable field of the production, in stage order. */
export function allFields(story = {}) {
  return FILLABLE_SECTIONS.flatMap((section) => fieldsFor(section, story));
}

/** id → spec, built once per render rather than re-scanning every section for
 *  every one of forty fields. */
export function fieldMap(story = {}) {
  return new Map(allFields(story).map((entry) => [entry.id, entry]));
}

/**
 * The ask itself, as lines rather than as JSON.
 *
 * A small local model follows a short labelled list far better than a nested
 * request object, and the ids have to come back verbatim as keys — so they are
 * the first thing on each line, where they are hardest to paraphrase.
 */
export function fillBrief(entries) {
  const rows = (Array.isArray(entries) ? entries : []).filter(Boolean);
  if (!rows.length) return '';
  const lines = rows.map((entry) => {
    const options = entry.options?.length ? ` Answer with exactly one of: ${entry.options.join(', ')}.` : '';
    return `- ${entry.id} (${entry.label}): ${entry.hint}${options}`;
  });
  return [
    rows.length === 1 ? 'Write this one field:' : `Write these ${rows.length} fields:`,
    ...lines,
    '',
    'Return every id above as a key, spelled exactly as written here.',
  ].join('\n');
}

/**
 * One section's blanks, split into asks a local model can finish.
 *
 * A section fill is not one question. The motion stage alone asks for the force,
 * seven depths, camera, audio, negatives and two fields per beat — seventeen
 * answers, most of them a sentence or more. Asked in one object that overruns
 * the model's room, and a cut-off object is not partly right, it is unparseable:
 * the reported failure was minutes of waiting and every box still empty.
 *
 * Split by WEIGHT rather than by count, because the fields are not the same
 * size — a one-line "Palette" and a paragraph of "Background atmosphere" do not
 * cost the same. Answers land per chunk, so a fill that dies half way through
 * has still written half the section, and pressing Fill again asks only for what
 * is still blank.
 */
export function fillChunks(entries, limit = 6) {
  const rows = (Array.isArray(entries) ? entries : []).filter(Boolean);
  const chunks = [];
  let current = [];
  let weight = 0;
  for (const entry of rows) {
    const cost = entry.kind === 'text' ? 2 : 1;
    if (current.length && weight + cost > limit) {
      chunks.push(current);
      current = [];
      weight = 0;
    }
    current.push(entry);
    weight += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * The values from one fill answer that may actually be written.
 *
 * Filtered against what was ASKED for, not merely against what came back: a
 * model that answers with a field nobody requested would otherwise write into a
 * path the studio does not have, and one that answers an options field with
 * prose would put that prose into a select.
 */
export function acceptedValues(entries, values) {
  const accepted = {};
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    const value = String(values?.[entry.id] ?? '').trim();
    if (!value) continue;
    if (entry.options && !entry.options.includes(value)) continue;
    accepted[entry.id] = value;
  }
  return accepted;
}
