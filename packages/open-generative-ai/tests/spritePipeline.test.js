// The sprite pipeline's pure logic: which frames are key frames, how they pack
// into a sheet, and how the prompts come out. Every test is named after the
// thing that goes wrong when the rule is missing.
import assert from 'node:assert/strict';
import test from 'node:test';

const loadFrames = () => import('../src/studios/sprite/spriteFrames.js');
const loadSheet = () => import('../src/studios/sprite/spriteSheet.js');
const loadMatte = () => import('../src/studios/sprite/spriteMatte.js');
const loadPrompt = () => import('../src/studios/sprite/spritePrompt.js');

const sig = (value) => [value, value, value, value];
const sample = (time, value) => ({ time, signature: sig(value) });

/* ---------------- key frames: distinct poses, not even slices ---------------- */

test('an idle loop that holds still does not yield a sheet of identical poses', async () => {
  const { pickDistinctFrames } = await loadFrames();
  // Eight samples, six of which are the same held pose: evenly spaced picking
  // would return four copies of it and drop the blink entirely.
  const samples = [
    sample(0.0, 10), sample(0.5, 10), sample(1.0, 10), sample(1.5, 90),
    sample(2.0, 10), sample(2.5, 10), sample(3.0, 50), sample(3.5, 10),
  ];

  const picked = pickDistinctFrames(samples, 3).map((index) => samples[index].signature[0]);

  assert.deepEqual([...picked].sort((a, b) => a - b), [10, 50, 90]);
});

test('key frames come back in TIME order so the sheet plays as an animation', async () => {
  const { pickDistinctFrames } = await loadFrames();
  const samples = [sample(0, 90), sample(1, 10), sample(2, 50), sample(3, 30)];

  const picked = pickDistinctFrames(samples, 4);

  assert.deepEqual(picked, [0, 1, 2, 3]);
});

test('a clip with fewer distinct poses than asked for stops rather than padding duplicates', async () => {
  const { pickDistinctFrames } = await loadFrames();
  const samples = [sample(0, 10), sample(1, 10), sample(2, 10), sample(3, 90)];

  const picked = pickDistinctFrames(samples, 4);

  // Two real poses exist. Returning four cells, two of them copies, would look
  // like the extractor working when it found nothing to extract.
  assert.equal(picked.length, 2);
});

test('asking for more frames than were sampled returns every sample', async () => {
  const { pickDistinctFrames } = await loadFrames();
  const samples = [sample(0, 10), sample(1, 50)];

  assert.deepEqual(pickDistinctFrames(samples, 8), [0, 1]);
});

test('sampling skips the very first and last frames of the clip', async () => {
  const { sampleTimes } = await loadFrames();

  const times = sampleTimes(4, 4);

  assert.ok(times[0] > 0, 'a generated clip routinely opens on a blended frame');
  assert.ok(times[times.length - 1] < 4);
});

test('an empty or zero-length clip yields no samples instead of throwing', async () => {
  const { sampleTimes, pickDistinctFrames } = await loadFrames();

  assert.deepEqual(sampleTimes(0, 6), []);
  assert.deepEqual(pickDistinctFrames([], 6), []);
});

/* ---------------- sheet: one shared origin ---------------- */

const imageData = (width, height, alphaAt) => ({
  width,
  height,
  data: Uint8ClampedArray.from(
    Array.from({ length: width * height }, (_, index) => {
      const x = index % width;
      const y = Math.floor(index / width);
      return [255, 255, 255, alphaAt(x, y)];
    }).flat(),
  ),
});

test('alpha bounds ignore the matte fringe instead of growing every cell', async () => {
  const { alphaBounds } = await loadSheet();
  // A 2x2 solid block with a 1px halo of alpha 4 around it — exactly what a
  // mask's antialiased edge leaves behind.
  const frame = imageData(6, 6, (x, y) => {
    const solid = x >= 2 && x <= 3 && y >= 2 && y <= 3;
    const halo = x >= 1 && x <= 4 && y >= 1 && y <= 4;
    return solid ? 255 : (halo ? 4 : 0);
  });

  assert.deepEqual(alphaBounds(frame), { left: 2, top: 2, right: 3, bottom: 3 });
});

test('a frame the matte kept nothing from reports no bounds rather than a full-frame box', async () => {
  const { alphaBounds } = await loadSheet();

  assert.equal(alphaBounds(imageData(4, 4, () => 0)), null);
});

test('bounds are UNIONED across the cycle so the sprite does not jitter cell to cell', async () => {
  const { unionBounds } = await loadSheet();
  // Tail tucked in on one frame, stretched out on the next. Trimming each to
  // its own box would re-centre the character between them.
  const tucked = { left: 4, top: 4, right: 9, bottom: 9 };
  const stretched = { left: 1, top: 4, right: 9, bottom: 12 };

  assert.deepEqual(unionBounds([tucked, stretched]), { left: 1, top: 4, right: 9, bottom: 12 });
});

test('an empty matte in the middle of a cycle does not collapse the shared cell', async () => {
  const { unionBounds } = await loadSheet();

  assert.deepEqual(unionBounds([{ left: 2, top: 2, right: 8, bottom: 8 }, null]), { left: 2, top: 2, right: 8, bottom: 8 });
  assert.equal(unionBounds([null, null]), null);
});

test('padding never runs off the edge of the frame', async () => {
  const { padBounds } = await loadSheet();

  assert.deepEqual(padBounds({ left: 0, top: 0, right: 9, bottom: 9 }, 4, 10, 10), { left: 0, top: 0, right: 9, bottom: 9 });
});

test('a short cycle packs as a strip and a long one wraps to a grid', async () => {
  const { sheetGrid } = await loadSheet();

  assert.deepEqual(sheetGrid(6), { columns: 6, rows: 1 });
  assert.deepEqual(sheetGrid(12), { columns: 4, rows: 3 });
  assert.deepEqual(sheetGrid(12, { columns: 6 }), { columns: 6, rows: 2 });
  assert.deepEqual(sheetGrid(0), { columns: 0, rows: 0 });
});

test('the atlas places every frame at its own cell rect', async () => {
  const { buildAtlas } = await loadSheet();

  const atlas = buildAtlas({ name: 'dragon', frameWidth: 64, frameHeight: 48, columns: 3, rows: 2, frameCount: 5, frameRate: 8 });

  assert.equal(atlas.frames.length, 5);
  assert.deepEqual(atlas.frames[4], { index: 4, name: 'dragon_04', x: 64, y: 48, width: 64, height: 48 });
  // The cycle's playback rate, not the source clip's — the frames are poses.
  assert.equal(atlas.frame_rate, 8);
});

/* ---------------- matte ramp ---------------- */

test('the mask becomes alpha through a ramp, not a staircase', async () => {
  const { maskAlpha } = await loadMatte();

  assert.equal(maskAlpha(0), 0);
  assert.equal(maskAlpha(40), 0);
  assert.equal(maskAlpha(255), 255);
  const mid = maskAlpha(120);
  assert.ok(mid > 0 && mid < 255, 'the mask edge carries the antialiasing the cut-out needs');
});

test('a degenerate cutoff/solid pair still produces a binary alpha, not NaN', async () => {
  const { maskAlpha } = await loadMatte();

  assert.equal(maskAlpha(200, { cutoff: 128, solid: 128 }), 255);
  assert.equal(maskAlpha(100, { cutoff: 128, solid: 128 }), 0);
});

test('applying a mask writes only alpha and leaves the sprite colours alone', async () => {
  const { applyMaskToPixels } = await loadMatte();
  const frame = { width: 2, height: 1, data: Uint8ClampedArray.from([200, 100, 50, 255, 200, 100, 50, 255]) };
  const mask = { width: 2, height: 1, data: Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255]) };

  applyMaskToPixels(frame, mask);

  assert.deepEqual([...frame.data], [200, 100, 50, 255, 200, 100, 50, 0]);
});

/* ---------------- prompts ---------------- */

test('the H3 prompt keeps the three-field shape the working run used', async () => {
  const { spriteAnimationPrompt, SPRITE_EXAMPLE } = await loadPrompt();

  const prompt = spriteAnimationPrompt(SPRITE_EXAMPLE);

  assert.ok(prompt.startsWith('integrated_multimodal_description: [Shot 1] 16bit retro 2D Game Sprite Animation,'));
  assert.ok(prompt.includes('\n\noverall_soundscape: Dragon movements sounds.'));
  assert.ok(prompt.includes('\n\nnon_diegetic_music: N/A'));
  assert.ok(prompt.includes('[0s] - Sitting idle animation:'));
});

test('the animation prompt pins the camera, because a drifting camera ruins the cycle', async () => {
  const { spriteAnimationPrompt } = await loadPrompt();

  const prompt = spriteAnimationPrompt({ subject: 'A small robot.', action: 'walk' });

  assert.match(prompt, /camera never moves/i);
});

test('a preset action carries the secondary motion that keeps frames from being identical', async () => {
  const { spriteAnimationPrompt } = await loadPrompt();

  const prompt = spriteAnimationPrompt({ subject: 'A small robot.', action: 'idle' });

  assert.match(prompt, /blinking/i);
});

test('prompts never double the full stop after a description that already ends in one', async () => {
  const { spriteImagePrompt } = await loadPrompt();

  const prompt = spriteImagePrompt({ subject: 'A pink dragon.', style: '16bit', background: 'chroma' });

  assert.ok(!prompt.includes('..'), prompt);
});

test('an empty subject produces no image prompt rather than a prompt for nothing', async () => {
  const { spriteImagePrompt } = await loadPrompt();

  assert.equal(spriteImagePrompt({ subject: '   ' }), '');
});

test('the matte subject is the noun phrase, not the whole wardrobe paragraph', async () => {
  const { matteSubjectFrom, SPRITE_EXAMPLE } = await loadPrompt();

  assert.equal(matteSubjectFrom(SPRITE_EXAMPLE.subject), 'A cute round spherical dragon');
  assert.equal(matteSubjectFrom(''), '');
});

test('"keep as generated" adds no background clause', async () => {
  const { spriteImagePrompt } = await loadPrompt();

  const prompt = spriteImagePrompt({ subject: 'A pink dragon', background: 'scene' });

  assert.ok(!/uniform (chroma-green|white) background/.test(prompt));
});
