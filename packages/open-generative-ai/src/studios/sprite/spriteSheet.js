// Packing matted frames into a sprite sheet.
//
// The one rule that separates a usable sheet from a pile of cut-outs: every
// cell shares ONE origin. Trimming each frame to its own bounding box is the
// tempting thing — it wastes the least space — and it makes the character
// jitter, because a frame where the tail is tucked in gets a tighter box and
// the engine re-centres it. So the bounds are UNIONED across the whole cycle
// and each frame is drawn at its own offset inside that shared cell. The sprite
// then sits still and only the parts that move, move.
//
// Sheets are built on a canvas in the browser: the frames were decoded here and
// matted through a mask that came back inline, so nothing about the sprite has
// to be written down anywhere to produce the sheet.

// A pixel this faint is matte fringe, not sprite. Bounds computed at alpha > 0
// pick up the mask's antialiased halo and every cell grows by a few pixels of
// nothing.
export const DEFAULT_ALPHA_THRESHOLD = 8;
// Breathing room around the union box so a cell's edge pixels are not clipped
// by an engine that samples half a texel outside the rect.
export const DEFAULT_PADDING = 2;

/**
 * The bounding box of everything non-transparent in one frame.
 * @returns {{left:number, top:number, right:number, bottom:number}|null} null
 *   when the frame is entirely transparent — a matte that found nothing.
 */
export function alphaBounds(imageData, { threshold = DEFAULT_ALPHA_THRESHOLD } = {}) {
  const { data, width, height } = imageData;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(((y * width) + x) * 4) + 3] <= threshold) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { left, top, right, bottom };
}

/** One box that contains every frame's box. Null entries (empty mattes) are
 *  skipped rather than collapsing the union to nothing. */
export function unionBounds(boxes) {
  const real = (boxes || []).filter(Boolean);
  if (!real.length) return null;
  return real.reduce((acc, box) => ({
    left: Math.min(acc.left, box.left),
    top: Math.min(acc.top, box.top),
    right: Math.max(acc.right, box.right),
    bottom: Math.max(acc.bottom, box.bottom),
  }));
}

/** Grow a box by `padding` without leaving the frame. */
export function padBounds(box, padding, width, height) {
  if (!box) return null;
  const pad = Math.max(0, Math.round(padding));
  return {
    left: Math.max(0, box.left - pad),
    top: Math.max(0, box.top - pad),
    right: Math.min(width - 1, box.right + pad),
    bottom: Math.min(height - 1, box.bottom + pad),
  };
}

export function boundsSize(box) {
  return box ? { width: (box.right - box.left) + 1, height: (box.bottom - box.top) + 1 } : { width: 0, height: 0 };
}

/**
 * Grid shape for `count` cells.
 *
 * A short cycle goes in one strip: that is what an engine's "horizontal sprite
 * sheet" import expects, and it is how an animator reads it. Past eight cells a
 * strip becomes a texture too wide to be kind to anything, so it wraps to the
 * squarest grid that holds them.
 */
export function sheetGrid(count, { columns = 0, maxStrip = 8 } = {}) {
  const total = Math.max(0, Math.round(count));
  if (!total) return { columns: 0, rows: 0 };
  const fixed = Math.max(0, Math.round(columns));
  const cols = fixed || (total <= maxStrip ? total : Math.ceil(Math.sqrt(total)));
  return { columns: cols, rows: Math.ceil(total / cols) };
}

/**
 * The sidecar an engine reads. Deliberately the plain shape shared by the
 * hand-rolled importers people actually write — a flat frames array with
 * pixel rects — rather than one engine's proprietary atlas format.
 */
export function buildAtlas({
  name = 'sprite',
  frameWidth,
  frameHeight,
  columns,
  rows,
  frameCount,
  frameRate = 12,
  sourceDuration = 0,
} = {}) {
  const total = Math.max(0, Math.round(frameCount));
  return {
    name,
    format: 'hivemind-sprite-sheet/1',
    frame_width: frameWidth,
    frame_height: frameHeight,
    columns,
    rows,
    frame_count: total,
    // Playback rate for the CYCLE, not the source clip's rate: the frames are
    // the distinct poses, so playing them at the clip's fps would run the
    // animation many times too fast.
    frame_rate: frameRate,
    source_duration_seconds: Number(sourceDuration) || 0,
    frames: Array.from({ length: total }, (_, index) => ({
      index,
      name: `${name}_${String(index).padStart(2, '0')}`,
      x: (index % columns) * frameWidth,
      y: Math.floor(index / columns) * frameHeight,
      width: frameWidth,
      height: frameHeight,
    })),
  };
}

/**
 * Draw matted frames into one sheet canvas.
 * @param {Array<HTMLCanvasElement>} frames RGBA canvases, all the same size
 * @param {{columns?:number, padding?:number, threshold?:number, name?:string, frameRate?:number, sourceDuration?:number, cellSize?:number}} options
 * @returns {{canvas:HTMLCanvasElement, atlas:object, bounds:object|null}}
 */
export function packSpriteSheet(frames, {
  columns = 0,
  padding = DEFAULT_PADDING,
  threshold = DEFAULT_ALPHA_THRESHOLD,
  name = 'sprite',
  frameRate = 12,
  sourceDuration = 0,
  cellSize = 0,
} = {}) {
  if (!frames?.length) throw new Error('There are no frames to pack.');
  const width = frames[0].width;
  const height = frames[0].height;
  const boxes = frames.map((frame) => alphaBounds(
    frame.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height),
    { threshold },
  ));
  // Nothing survived the matte on any frame. Packing a sheet of empty cells
  // would look like a bug in the packer rather than in the cut-out.
  const shared = padBounds(unionBounds(boxes), padding, width, height);
  if (!shared) throw new Error('Every frame came back empty — the background removal kept nothing.');

  const source = boundsSize(shared);
  // An optional square cell: engines that index a sheet by a fixed tile need
  // one, and it also stops a tall sprite producing a 40x300 texture.
  const scale = cellSize > 0 ? Math.min(cellSize / source.width, cellSize / source.height) : 1;
  const cellW = cellSize > 0 ? cellSize : source.width;
  const cellH = cellSize > 0 ? cellSize : source.height;
  const drawW = Math.max(1, Math.round(source.width * scale));
  const drawH = Math.max(1, Math.round(source.height * scale));
  const offsetX = Math.round((cellW - drawW) / 2);
  const offsetY = Math.round((cellH - drawH) / 2);

  const grid = sheetGrid(frames.length, { columns });
  const canvas = document.createElement('canvas');
  canvas.width = grid.columns * cellW;
  canvas.height = grid.rows * cellH;
  const context = canvas.getContext('2d');
  // Nearest-neighbour: a sprite's whole point is hard pixels, and smoothing a
  // downscale is how a crisp cut-out turns into a blurred one.
  context.imageSmoothingEnabled = false;
  frames.forEach((frame, index) => {
    const column = index % grid.columns;
    const row = Math.floor(index / grid.columns);
    context.drawImage(
      frame,
      shared.left, shared.top, source.width, source.height,
      (column * cellW) + offsetX, (row * cellH) + offsetY, drawW, drawH,
    );
  });

  return {
    canvas,
    bounds: shared,
    atlas: buildAtlas({
      name,
      frameWidth: cellW,
      frameHeight: cellH,
      columns: grid.columns,
      rows: grid.rows,
      frameCount: frames.length,
      frameRate,
      sourceDuration,
    }),
  };
}
