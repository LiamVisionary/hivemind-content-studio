// The shape of one production, and how a saved one comes back.
//
// Pure and JSX-free so the node:test suite can import it — the studio itself
// cannot be loaded there, and the restore below is exactly the code that has to
// keep working across every future field this shape grows.
import { boardFormat, defaultPanels } from './board.js';
import { defaultBeats } from './motionScript.js';
import { blankLocation } from './location.js';

/**
 * Is `task` the ask that is currently running?
 *
 * A predicate rather than an inline `busy === task`, because both sides are
 * strings that are EMPTY in their resting state — nothing running is `busy:
 * ''`, and a row that is not the one asking passes `task: ''`. A bare
 * `busy !== task` bail therefore let every idle row through, and the concept
 * cards each grew a permanent "Working…" with a Cancel next to it.
 */
export const producerIsRunning = (busy, task) => Boolean(task) && busy === task;

/** Everything a fresh production starts as. Kept in one object so the whole
 *  session is one thing to persist, restore and clear. */
export function blankStory() {
  return {
    brief: { person: '', companion: '', tone: 'cute', world: '', count: 8, avoid: '' },
    style: '',
    aspect: '9:16',
    concepts: [],
    shortlist: [],
    ranking: null,
    contactSheetUrl: '',
    lockedId: '',
    title: '',
    promise: '',
    contract: { pressure: '', who: '', goal: '', other: '', behavior: '', reward: '' },
    characters: [],
    sheetBackground: 'neutral',
    locationOptions: [],
    location: blankLocation(),
    board: { format: 'four', arc: '', panels: defaultPanels('four'), sheetUrl: '' },
    motion: {
      seconds: 15, force: '', layers: {}, beats: defaultBeats(15, 3),
      camera: '', audio: '', music: 'none', negatives: '', limit: 0, override: '',
    },
    qa: { verdicts: {}, caption: {} },
    segments: { total: 15, per: 15 },
  };
}

/**
 * A saved production, merged onto today's defaults.
 *
 * A shallow spread is not enough: a story stored before a field existed
 * replaces its whole sub-object, so `board.panels` or `motion.beats` come back
 * undefined and the first render throws on `.map`. Every nested object the UI
 * indexes into is merged one level down, which is exactly as deep as this
 * shape goes.
 */
export function restoreStory(saved) {
  const base = blankStory();
  if (!saved || typeof saved !== 'object') return base;
  const merged = { ...base, ...saved };
  for (const key of ['brief', 'contract', 'location', 'board', 'motion', 'qa', 'segments']) {
    merged[key] = { ...base[key], ...(saved[key] && typeof saved[key] === 'object' ? saved[key] : {}) };
  }
  merged.motion.layers = { ...(merged.motion.layers || {}) };
  merged.qa.verdicts = { ...(merged.qa.verdicts || {}) };
  merged.qa.caption = { ...(merged.qa.caption || {}) };
  // Lists the UI maps over. A saved value that is not a list is a corrupt
  // restore, and rendering the defaults beats a blank studio.
  // The panel count belongs to the FORMAT, not to the save: a board stored with
  // `format: 'sixteen'` and no panels would otherwise restore as sixteen in the
  // label and four on the page. The saved panels are merged onto the right-sized
  // scaffold positionally, so whatever was written survives where it fits.
  const scaffold = defaultPanels(merged.board.format);
  const savedPanels = Array.isArray(merged.board.panels) ? merged.board.panels : [];
  if (savedPanels.length !== boardFormat(merged.board.format).panels) {
    merged.board.panels = scaffold.map((panel, index) => (
      savedPanels[index] && typeof savedPanels[index] === 'object'
        ? { ...panel, ...savedPanels[index], n: index + 1 }
        : panel
    ));
  }
  if (!Array.isArray(merged.motion.beats) || !merged.motion.beats.length) merged.motion.beats = defaultBeats(merged.motion.seconds, 3);
  if (!Array.isArray(merged.location.motion)) merged.location.motion = [];
  for (const key of ['concepts', 'shortlist', 'characters', 'locationOptions']) {
    if (!Array.isArray(merged[key])) merged[key] = [];
  }
  return merged;
}
