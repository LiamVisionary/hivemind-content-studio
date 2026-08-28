// Stage 1 — the concept: many directions, one winner, one contract.
//
// The expensive mistake in character work is not a bad render, it is a good
// render of the wrong pair. Sheets, a location and a board all get built on top
// of whichever relationship was locked, so a direction chosen from one idea
// costs a whole production to unwind. Asking for eight at once and throwing
// seven away is the cheap version of that decision.
//
// What survives the stage is a CONTRACT: one sentence saying what the pair does
// under pressure, plus a per-character list of the things that must never drift.
// Every later stage quotes it, which is what keeps the sheet, the board and the
// motion script describing the same characters.
//
// Pure: no React, no network. The producer (a local LLM) is asked through
// lib/localProducer.js; this module only shapes the ask and cleans the answer.
import { bestGrid } from './sheetLayout.js';

/** One cell of a contact sheet: a full-body pair, so portrait. */
const CONTACT_CELL = '3:4';

/** Feelings the pair's relationship can carry. Free text is allowed too —
 *  these are the ones worth one press. */
export const TONES = Object.freeze([
  { id: 'cute', label: 'Cute' },
  { id: 'serious', label: 'Serious' },
  { id: 'melancholy', label: 'Melancholy' },
  { id: 'funny', label: 'Funny' },
  { id: 'strange', label: 'Strange' },
]);

/** How the shortlist is argued about. Named so the comparison is on the same
 *  five axes every time instead of on whichever one the last idea flattered. */
export const SHORTLIST_CRITERIA = Object.freeze([
  { id: 'recognizable', label: 'Recognizable', hint: 'Would you know them again from the silhouette alone?' },
  { id: 'clarity', label: 'Emotional clarity', hint: 'Does the feeling read before any context does?' },
  { id: 'repeatable', label: 'Repeatable', hint: 'Is there a second, third and tenth story in this pair?' },
  { id: 'silhouette', label: 'Silhouette', hint: 'Two shapes that stay distinct at thumbnail size.' },
  { id: 'simplicity', label: 'Production simplicity', hint: 'How many hard things does one clip have to get right?' },
]);

const text = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');

/** The brief the producer answers. Written as fields rather than a paragraph so
 *  a half-filled brief still asks a complete question. */
export function conceptBrief({ pitch = '', person = '', companion = '', tone = '', world = '', count = 8, avoid = '' } = {}) {
  const lines = [
    // The one line the director actually wrote, first. The fields below stay
    // even when it is filled: a pitch says "a night bus driver and a moth at
    // 2am" and the fields say which half is which, which is what stops a
    // producer answering with eight moths.
    text(pitch) ? `Brief: ${text(pitch)}` : '',
    `Human: ${text(person) || 'your choice — pick something specific'}`,
    `Companion: ${text(companion) || 'your choice — an animal or creature'}`,
    `The relationship should feel: ${text(tone) || 'your choice'}`,
    `World: ${text(world) || 'your choice — somewhere with weather and depth'}`,
    `How many concepts: ${conceptCount(count)}`,
  ];
  if (text(avoid)) lines.push(`Must never appear: ${text(avoid)}`);
  return lines.filter(Boolean).join('\n');
}

/** 3–12. A list shorter than three is not a comparison; longer than a dozen is
 *  not read. */
export function conceptCount(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(12, Math.max(3, n)) : 8;
}

const CONCEPT_FIELDS = ['pair', 'hook', 'friction', 'reward', 'signature'];

/**
 * Clean one producer answer into concepts the UI can render.
 *
 * A local model at 8B will occasionally return eleven concepts when asked for
 * eight, drop a field, or answer the count question inside `pair`. None of that
 * is worth a retry — an entry keeps whatever fields it has, and one with no
 * usable text at all is dropped rather than shown as an empty card.
 */
export function normalizeConcepts(raw, { count = 8 } = {}) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.concepts) ? raw.concepts : [];
  return rows
    .map((row, index) => {
      const concept = { id: text(row?.id) || String.fromCharCode(65 + index), title: text(row?.title) };
      for (const field of CONCEPT_FIELDS) concept[field] = text(row?.[field]);
      return concept;
    })
    .filter((concept) => CONCEPT_FIELDS.some((field) => concept[field]))
    .slice(0, conceptCount(count));
}

/** One line of the shape every later stage quotes. Blank parts stay as visible
 *  blanks rather than being smoothed over: an unfinished contract that reads as
 *  finished is how a stand-in reaches a render. */
export function contractSentence({ pressure = '', who = '', goal = '', other = '', behavior = '', reward = '' } = {}) {
  const slot = (value, fallback) => text(value) || fallback;
  return `When ${slot(pressure, '___')} happens, ${slot(who, '___')} tries to ${slot(goal, '___')}, `
    + `while ${slot(other, '___')} responds by ${slot(behavior, '___')} — turning it into ${slot(reward, '___')}.`;
}

/** Which parts of the contract are still blank, in the order they are asked for. */
export function contractBlanks(contract = {}) {
  return ['pressure', 'who', 'goal', 'other', 'behavior', 'reward'].filter((field) => !text(contract[field]));
}

/**
 * The canvas a contact sheet of `count` directions is drawn on.
 *
 * Cells are portrait because what is being compared is a full-body pair, and a
 * grid of them only reads as a comparison if every cell is the same shape the
 * figures are. The canvas follows the grid rather than being fixed square —
 * four directions across a square canvas gives four slivers.
 */
export function contactSheetLayout(count) {
  return bestGrid(count, { cell: CONTACT_CELL, partialRows: true });
}

/**
 * The prompt for one image showing the shortlist side by side.
 *
 * Deliberately labelled and deliberately rough: this is a decision aid, not an
 * asset. Asking for finished art here invites the model to make one direction
 * look better than it is, which is exactly the judgement the stage exists to
 * protect.
 */
export function contactSheetPrompt(concepts, { style = '', world = '' } = {}) {
  const rows = (Array.isArray(concepts) ? concepts : []).filter(Boolean);
  if (!rows.length) return '';
  const layout = contactSheetLayout(rows.length);
  const cells = rows.map((concept, index) => (
    `${index + 1} — ${concept.pair || concept.title || 'a pair'}`
    + (concept.signature ? `; signature detail: ${concept.signature}` : '')
  ));
  return [
    `One contact sheet: ${rows.length} numbered cells in a ${layout.cols}-across grid on a single ${layout.canvas} canvas, thin borders.`,
    'Each cell is a different character-pair direction, drawn as a quick full-body comparison, not as finished art.',
    world ? `Shared world: ${text(world)}.` : '',
    style ? `Style: ${text(style)}.` : '',
    'Make the directions clearly different from each other in silhouette, proportion and palette.',
    'No decorative typography beyond the cell numbers, no repeated poses, no borders around the sheet.',
    '',
    ...cells,
  ].filter(Boolean).join('\n');
}
