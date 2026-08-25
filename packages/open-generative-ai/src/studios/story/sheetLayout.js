// The geometry of a sheet that holds more than one picture.
//
// Any grid sheet has two ratios and they are not free of each other: the CANVAS
// the image model is asked for, and the ratio of one cell inside it. Pick them
// separately and you can ask for something no drawing satisfies — four 9:16
// panels in a 2x2 grid on a 16:9 canvas has 16:9 cells, so a model that obeys
// the grid has to squash every vertical composition sideways to fit. That is
// exactly the stretched storyboard reported on 2026-08-24: the prompt said 9:16
// panels, the request said a 16:9 canvas, and the panels came back wide.
//
// So both come from here. The canvas is chosen to fit the cells, and the cell
// ratio written into the prompt is the one that canvas actually yields — never
// the one we wished for. When they cannot be made to agree, `exact` is false and
// the prompt says which ratio to compose for, rather than silently contradicting
// itself.

/** Canvas ratios every image model in the studio's picker accepts. Deliberately
 *  the intersection rather than the union: a sheet that comes back square
 *  because the provider ignored "21:9" is the same bug from the other side. */
export const SHEET_CANVASES = Object.freeze(['1:1', '4:3', '3:4', '16:9', '9:16']);

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** "9:16" → [9, 16]. Accepts `x` and `/` as separators, since the studio's own
 *  aspect strings and a hand-typed one are not always the same shape. */
export function ratioParts(value, fallback = [1, 1]) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$/i.exec(String(value ?? ''));
  if (!match) return fallback;
  let width = Number(match[1]);
  let height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) return fallback;
  // Ratios are compared and multiplied as integers so the panel ratio can be
  // reduced back to something readable ("9:16", not "0.5625:1").
  while (!Number.isInteger(width) || !Number.isInteger(height)) {
    width *= 10;
    height *= 10;
  }
  const divisor = gcd(width, height) || 1;
  return [width / divisor, height / divisor];
}

/** The ratio as a number: width ÷ height. */
export function ratioValue(value, fallback = 1) {
  const [width, height] = ratioParts(value, [0, 0]);
  return height > 0 ? width / height : fallback;
}

/** Two ratios' distance from each other, symmetrical in scale — 2:1 is as far
 *  from 1:1 as 1:2 is, which a plain subtraction does not say. */
export const ratioDistance = (a, b) => Math.abs(Math.log(a / b));

/** The supported canvas closest to `target`. */
export function nearestCanvas(target, canvases = SHEET_CANVASES) {
  const wanted = Number(target) > 0 ? Number(target) : 1;
  let best = canvases[0];
  let bestDistance = Infinity;
  for (const candidate of canvases) {
    const distance = ratioDistance(wanted, ratioValue(candidate));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * One grid, priced.
 *
 * `canvas` is what the image request asks for; `panel` is what one cell of that
 * canvas is actually shaped like, reduced to a readable ratio. `exact` says
 * whether the panels come out at the ratio that was asked for — the only case
 * where the prompt may state the requested ratio as fact.
 */
export function sheetLayout({ cell = '1:1', cols = 1, rows = 1, canvases = SHEET_CANVASES } = {}) {
  const columns = Math.max(1, Math.round(Number(cols) || 1));
  const lines = Math.max(1, Math.round(Number(rows) || 1));
  const [cellW, cellH] = ratioParts(cell);
  const wanted = cellW / cellH;
  const canvas = nearestCanvas(wanted * (columns / lines), canvases);
  const [canvasW, canvasH] = ratioParts(canvas);
  // A cell of a cols×rows grid is (W/cols) by (H/rows).
  const panelW = canvasW * lines;
  const panelH = canvasH * columns;
  const divisor = gcd(panelW, panelH) || 1;
  const panel = `${panelW / divisor}:${panelH / divisor}`;
  return {
    cols: columns,
    rows: lines,
    grid: `${columns}x${lines}`,
    canvas,
    panel,
    // 4% — a cell that is a couple of percent off reads as the ratio it claims
    // to be; the failure this guards against is a half-turn, not a rounding.
    exact: ratioDistance(ratioValue(panel), wanted) < 0.04,
  };
}

/** Every grid that could hold `count` cells. Exact factor pairs only, unless a
 *  part-filled last row is acceptable — a board of four panels with two empty
 *  cells is a mistake, a contact sheet of five directions is not. */
function arrangements(count, { partialRows = false } = {}) {
  const total = Math.max(1, Math.round(Number(count) || 1));
  const grids = [];
  for (let cols = 1; cols <= total; cols += 1) {
    if (partialRows) {
      grids.push({ cols, rows: Math.ceil(total / cols) });
    } else if (total % cols === 0) {
      grids.push({ cols, rows: total / cols });
    }
  }
  return grids;
}

/**
 * The best grid for `count` cells of `cell` ratio.
 *
 * Scored on how close one cell comes out to the ratio that was asked for, plus a
 * small penalty per empty cell so a grid with a hole in it only wins when it is
 * genuinely better shaped. Ties go to the squarer grid, because a 1x4 strip of
 * panels is a worse sheet than a 2x2 block at the same fit.
 */
export function bestGrid(count, { cell = '1:1', partialRows = false, canvases = SHEET_CANVASES } = {}) {
  const total = Math.max(1, Math.round(Number(count) || 1));
  const wanted = ratioValue(cell);
  let best = null;
  let bestScore = Infinity;
  for (const grid of arrangements(total, { partialRows })) {
    const layout = sheetLayout({ ...grid, cell, canvases });
    const waste = grid.cols * grid.rows - total;
    const score = ratioDistance(ratioValue(layout.panel), wanted)
      + waste * 0.05
      + Math.abs(grid.cols - grid.rows) * 0.001;
    if (score < bestScore) {
      best = layout;
      bestScore = score;
    }
  }
  return best || sheetLayout({ cell, cols: 1, rows: total, canvases });
}
