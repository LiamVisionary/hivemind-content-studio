// Stage 4 — the storyboard: direction for the render, not a contract with it.
//
// A board hands the video model pacing, angle variety and the emotional shape
// of the clip. It does not hand it a shot list it will trace. Expecting literal
// panel-by-panel reproduction is the single most common way this stage
// disappoints, and the fix is never a longer board — it is fewer beats, or one
// isolated frame for the beat that has to be exact.
//
// Three densities, and they are genuinely different tools:
//   four      — depth. Four moments with room for performance between them.
//   sixteen   — coverage. A new visual beat every few seconds.
//   precision — control. The exact start and end state of one hard action.
//
// The camera vocabulary here is about WHY a shot exists. The technical one —
// framing, viewpoint, lens, move — already lives in lib/h3Camera.js and
// lib/cameraMotion.js and is not restated.
//
// The sheet's own geometry is not decided here. `sheetLayout.js` owns it,
// because the canvas the image model is asked for and the panel ratio this
// prompt states have to be the same decision — asking for 9:16 panels on a 16:9
// canvas is how a board comes back stretched.
import { bestGrid } from './sheetLayout.js';

/** Why a shot is the shot it is, and the way each one is usually misused. */
export const SHOT_REASONS = Object.freeze([
  { id: 'macro', label: 'Macro', use: 'A tactile hook, or the object that is about to be at risk.', trap: 'Detail with no context and no later reveal.' },
  { id: 'close', label: 'Close-up', use: 'A decision, an affection, a micro-expression.', trap: 'Using it for every beat, so nothing is emphasised.' },
  { id: 'low', label: 'Low / creature POV', use: 'Scale, curiosity, the animal’s side of the relationship.', trap: 'Making a gentle scene suddenly heroic.' },
  { id: 'overhead', label: 'Overhead / POV', use: 'Touch, a work surface, the physical relationship between two bodies.', trap: 'Reading as surveillance rather than intimacy.' },
  { id: 'wide', label: 'Wide', use: 'Belonging, loneliness, geography, the final release.', trap: 'Opening wide before the viewer cares who they are looking at.' },
  { id: 'pullback', label: 'Pull-back', use: 'Reveal that they are together, or how big the world is.', trap: 'An automatic drift-out that reveals nothing new.' },
]);

/** The one question a camera move has to answer before it earns its place. */
export const CAMERA_MOTIVATION_TEST = 'The camera moves because the viewer now needs to discover ___.';

/** Panel jobs for a four-panel board — the beats a small emotional movie needs. */
const FOUR_JOBS = [
  { job: 'Hook', asks: 'What can be understood before any context?' },
  { job: 'Setup', asks: 'What are they trying to do, and what is in the way?' },
  { job: 'Turn', asks: 'Where does the feeling change?' },
  { job: 'Reward', asks: 'What final image is worth saving?' },
];

/** Row jobs for a sixteen-panel board. Sixteen panels is four acts of four,
 *  not sixteen versions of the same medium shot. */
const SIXTEEN_ROWS = [
  { job: 'Hook and world', asks: 'Stop the scroll, then say where we are and what they want.' },
  { job: 'Escalation', asks: 'The same pressure, harder, and looking different each time.' },
  { job: 'Consequence and turn', asks: 'Something changes, and the quiet beat that lands it.' },
  { job: 'Payoff and afterglow', asks: 'The reward, the signature detail, the final memory or loop.' },
];

export const BOARD_FORMATS = Object.freeze([
  {
    id: 'four', label: '4 panels', panels: 4,
    best: 'Cinematic continuity — one emotional change with room to perform it.',
  },
  {
    id: 'sixteen', label: '16 panels', panels: 16,
    best: 'Fast coverage — montage, a transformation, a day passing.',
  },
  {
    id: 'precision', label: '1–2 frames', panels: 2,
    best: 'One exact action: the start state and the end state, nothing else.',
  },
]);

export const boardFormat = (id) => BOARD_FORMATS.find((entry) => entry.id === id) || BOARD_FORMATS[0];

/**
 * How this board is laid out on one canvas, for the panels' own ratio.
 *
 * The single answer to two questions that used to be answered separately: what
 * canvas to ask the image model for, and what ratio to tell it the panels are.
 * A 2x2 of 9:16 panels is a 9:16 sheet — it was being asked for as 16:9, which
 * is a landscape canvas with landscape cells, and every vertical composition
 * came back squashed to fit one.
 */
export function boardLayout(formatId = 'four', aspect = '9:16') {
  return bestGrid(boardFormat(formatId).panels, { cell: aspect });
}

/**
 * Which density this story wants, with the reason attached.
 *
 * Four is the default because it is the one that is right most often, and
 * because the failure of using four when sixteen was wanted (a slightly slow
 * clip) is much cheaper than the reverse (sixteen crowded beats, none of which
 * has room to land).
 */
export function recommendBoard({ beats = 0, seconds = 15, criticalAction = false, montage = false } = {}) {
  if (criticalAction) {
    return { id: 'precision', why: 'One beat has to be exact — isolate it instead of asking a whole board to carry it.' };
  }
  const count = Number(beats) || 0;
  const perBeat = count > 0 ? Number(seconds) / count : Number(seconds);
  if (montage || count >= 10) {
    return { id: 'sixteen', why: `${count || 'Many'} beats in ${seconds}s is coverage, not performance — give each one a panel.` };
  }
  if (perBeat < 2.5 && count > 0) {
    return { id: 'sixteen', why: `${count} beats leaves ${perBeat.toFixed(1)}s each. That is montage pacing.` };
  }
  return { id: 'four', why: `${seconds}s across ${count || 'a few'} beats has room to act — spend it on performance, not on panel count.` };
}

export function blankPanel(index = 0, formatId = 'four') {
  const scaffold = formatId === 'sixteen'
    ? SIXTEEN_ROWS[Math.floor(index / 4)] || { job: '', asks: '' }
    : FOUR_JOBS[index] || { job: '', asks: '' };
  return {
    n: index + 1,
    job: formatId === 'precision' ? (index === 0 ? 'Exact starting state' : 'Exact ending state') : scaffold.job,
    asks: formatId === 'precision' ? 'Only the handoff between these two states is prompted.' : scaffold.asks,
    verb: '',
    shot: '',
    reason: '',
    motion: '',
  };
}

export function defaultPanels(formatId = 'four') {
  const format = boardFormat(formatId);
  return Array.from({ length: format.panels }, (_, index) => blankPanel(index, format.id));
}

const text = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');

/** One panel as a line of the board prompt. */
function panelLine(panel, { format }) {
  const shot = SHOT_REASONS.find((entry) => entry.id === panel.shot);
  const parts = [
    text(panel.verb) || text(panel.job) || `panel ${panel.n}`,
    shot ? `${shot.label.toLowerCase()}` : '',
    text(panel.reason) ? `to show ${text(panel.reason)}` : '',
    text(panel.motion) ? `with ${text(panel.motion)} moving` : '',
  ].filter(Boolean);
  const label = format.id === 'precision' ? text(panel.job) : `${panel.n} — ${text(panel.job) || 'beat'}`;
  return `${label}: ${parts.join('; ')}.`;
}

/**
 * The storyboard sheet prompt.
 *
 * The continuity lock quotes the never-change lists rather than re-describing
 * the characters: the sheets are attached, and re-describing them here is how
 * the two descriptions end up disagreeing.
 */
export function boardPrompt({
  format = 'four', panels = [], title = '', promise = '', arc = '',
  style = '', aspect = '9:16', locks = [], location = '',
} = {}) {
  const chosen = boardFormat(format);
  const rows = (Array.isArray(panels) ? panels : []).filter(Boolean);
  if (!rows.length) return '';
  const layout = boardLayout(chosen.id, aspect);
  const placement = layout.cols === 1 ? 'stacked one above the other'
    : layout.rows === 1 ? 'side by side'
      : `in a ${layout.grid} grid`;
  const cellWord = chosen.id === 'precision' ? 'frame' : 'panel';
  // The grid and the canvas are stated; the CELL ratio is not. A cell is the
  // canvas divided by the grid, so it needs no instruction — and any ratio
  // written here can be contradicted twice over: once by the grid, and again by
  // a provider that serves "9:16" as its own nearest size (OpenAI's is 2:3).
  // A number that might be wrong is worse than no number: the model resolves the
  // disagreement by stretching, which is the bug this replaced.
  const head = chosen.id === 'precision'
    ? `Two reference frames ${placement} on one ${layout.canvas} canvas, labelled 1 and 2, each filling its half.`
    : `One storyboard sheet: ${chosen.panels} numbered panels ${placement} on a single ${layout.canvas} canvas, thin borders, each panel filling its cell.`;
  // The one case worth a sentence: a grid whose cells cannot be the clip's shape
  // at all. Then say what the shot is FOR, so the composition survives the crop.
  const fit = layout.exact ? '' :
    `Each ${cellWord} is about ${layout.panel} while the clip is ${aspect} — compose each shot for the clip and leave the rest of the ${cellWord} as room, rather than stretching anything to fill it.`;
  return [
    head,
    fit,
    text(title) ? `Title: ${text(title)}.` : '',
    text(promise) ? `Story promise: ${text(promise)}` : '',
    text(arc) ? `Emotional arc: ${text(arc)}, carried by composition and performance.` : '',
    'The attached reference sheets lock the characters and the attached plate locks the location — do not redesign either.',
    locks.length ? `Must not drift: ${locks.map(text).filter(Boolean).join('; ')}.` : '',
    text(location) ? `All panels take place in: ${text(location)}.` : '',
    style ? `Style: ${text(style)}.` : '',
    '',
    ...rows.map((panel) => panelLine(panel, { format: chosen })),
    '',
    chosen.id === 'precision'
      ? 'Both frames share the same camera position and lighting — only the action differs.'
      : 'Every panel is a different moment with a different composition and camera distance. Never repeat a framing.',
    'No decorative typography beyond the panel numbers, no title card, no page border.',
  ].filter(Boolean).join('\n');
}

/**
 * The squint test, as code.
 *
 * A board where every panel is the same distance from the same subject reads as
 * four copies, and a video model given four copies has been told the story does
 * not move. Reported rather than blocked — a deliberate repeat (child then
 * adult, before then after) is a real technique.
 */
export function boardWarnings(panels = [], formatId = 'four') {
  const rows = (Array.isArray(panels) ? panels : []).filter(Boolean);
  const warnings = [];
  if (formatId === 'precision') {
    if (rows.length > 2) warnings.push('Precision mode is one or two frames. More than that is a board, not a handoff.');
    return warnings;
  }
  const shots = rows.map((panel) => text(panel.shot)).filter(Boolean);
  if (shots.length >= 2 && new Set(shots).size === 1) {
    warnings.push('Every panel uses the same shot. Squint at it: four identical shapes read as one held frame.');
  }
  const verbs = rows.map((panel) => text(panel.verb).toLowerCase()).filter(Boolean);
  const repeated = verbs.filter((verb, index) => verbs.indexOf(verb) !== index);
  if (repeated.length) {
    warnings.push(`The same action appears in more than one panel (${[...new Set(repeated)].join(', ')}). Each panel needs its own dominant verb.`);
  }
  const missing = rows.filter((panel) => !text(panel.verb)).length;
  if (missing) warnings.push(`${missing} panel${missing === 1 ? ' has' : 's have'} no dominant action yet.`);
  const noReason = rows.filter((panel) => text(panel.shot) && !text(panel.reason)).length;
  if (noReason) warnings.push(`${noReason} shot${noReason === 1 ? '' : 's'} still ${noReason === 1 ? 'has' : 'have'} no reason. ${CAMERA_MOTIVATION_TEST}`);
  return warnings;
}
