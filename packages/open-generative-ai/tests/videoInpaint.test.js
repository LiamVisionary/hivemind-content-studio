// Head replacement's arithmetic. The dialog shows these numbers before anything
// is uploaded, so they have to match the rule the MCP will apply on arrival —
// a clip the dialog calls 2.3s and the gateway then trims to 1.6s is a lie the
// user only discovers after paying for the render.
const test = require('node:test');
const assert = require('node:assert/strict');

test('a clip is trimmed DOWN onto H3\'s 17n+5 lattice, never padded up', async () => {
    const { usableInpaintSeconds, gridFramesAtMost } = await import('../src/lib/videoInpaint.js');
    // The lattice itself: 5, 22, 39, 56, 73, 90, 107 …
    assert.equal(gridFramesAtMost(5), 5);
    assert.equal(gridFramesAtMost(21), 5);
    assert.equal(gridFramesAtMost(22), 22);
    assert.equal(gridFramesAtMost(60), 56);
    assert.equal(gridFramesAtMost(107), 107);
    // 2.5s is 60 frames, which is not a lattice point — 56 is, and 73 would mean
    // inventing 13 frames of footage to paint over.
    const usable = usableInpaintSeconds(2.5);
    assert.equal(usable.frames, 56);
    assert.ok(Math.abs(usable.seconds - 56 / 24) < 1e-9);
    assert.equal(usable.trimmed, true);
    assert.equal(usable.tooShort, false);
});

test('a clip below the first lattice point has no legal length at all', async () => {
    const { usableInpaintSeconds } = await import('../src/lib/videoInpaint.js');
    const usable = usableInpaintSeconds(0.1); // 2 frames
    assert.equal(usable.frames, 0);
    assert.equal(usable.seconds, 0);
    assert.equal(usable.tooShort, true);
});

test('a clip that lands exactly on the lattice is not reported as trimmed', async () => {
    const { usableInpaintSeconds } = await import('../src/lib/videoInpaint.js');
    const usable = usableInpaintSeconds(107 / 24);
    assert.equal(usable.frames, 107);
    assert.equal(usable.trimmed, false);
});

test('the coverage check samples both ends, where a static region actually fails', async () => {
    const { coverageTimestamps } = await import('../src/lib/videoInpaint.js');
    const stamps = coverageTimestamps({ seconds: 4 }, 6);
    assert.equal(stamps.length, 6);
    assert.equal(stamps[0], 0);
    // A hair inside the end: seeking exactly to the duration lands past the last
    // frame on some decoders and returns nothing.
    assert.ok(stamps[5] < 4 && stamps[5] > 3.9, `last stamp ${stamps[5]}`);
    // Monotonic, so the strip reads left to right as time.
    for (let i = 1; i < stamps.length; i += 1) assert.ok(stamps[i] > stamps[i - 1]);
});

test('a zero-length clip still yields one timestamp rather than dividing by zero', async () => {
    const { coverageTimestamps } = await import('../src/lib/videoInpaint.js');
    assert.deepEqual(coverageTimestamps({ seconds: 0 }, 6), [0]);
});

test('only dials that differ from the workflow default are sent', async () => {
    const { inpaintDials, INPAINT_DEFAULTS } = await import('../src/lib/videoInpaint.js');
    // Everything left alone: nothing to send, so the registered graph stays the
    // one place each default is written down.
    assert.deepEqual(inpaintDials({ maskSource: 'manual', ...{
        sam3Prompt: INPAINT_DEFAULTS.sam3Prompt,
        sam3Threshold: INPAINT_DEFAULTS.sam3Threshold,
        cropMode: INPAINT_DEFAULTS.cropMode,
        cropScale: INPAINT_DEFAULTS.cropScale,
        cropMegapixels: INPAINT_DEFAULTS.cropMegapixels,
        maskExpand: INPAINT_DEFAULTS.maskExpand,
    } }), {});
    const changed = inpaintDials({
        maskSource: 'manual',
        cropMode: 'combined',
        cropScale: 2.5,
        cropMegapixels: INPAINT_DEFAULTS.cropMegapixels,
        maskExpand: 60,
    });
    assert.deepEqual(changed, { crop_mode: 'combined', crop_scale: 2.5, mask_expand: 60 });
});

test('SAM3 dials are only sent on the SAM3 branch', async () => {
    const { inpaintDials } = await import('../src/lib/videoInpaint.js');
    // Painted mask: a tracking phrase alongside it would look like it applied.
    const painted = inpaintDials({ maskSource: 'manual', sam3Prompt: 'the whole man', sam3Threshold: 0.2 });
    assert.deepEqual(painted, {});
    const tracked = inpaintDials({ maskSource: 'sam3', sam3Prompt: 'the whole man', sam3Threshold: 0.2 });
    assert.deepEqual(tracked, { sam3_prompt: 'the whole man', sam3_detection_threshold: 0.2 });
});

test('an empty canvas is not a mask', async () => {
    const { maskCoversFrames } = await import('../src/lib/videoInpaint.js');
    assert.equal(maskCoversFrames(null), false);
    assert.equal(maskCoversFrames({ width: 0, height: 0 }), false);
    // A canvas whose every pixel is transparent — what Clear, and erasing the
    // last stroke, both leave behind.
    const empty = {
        width: 2,
        height: 2,
        getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(2 * 2 * 4) }) }),
    };
    assert.equal(maskCoversFrames(empty), false);
    const painted = {
        width: 1,
        height: 1,
        getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }) }),
    };
    assert.equal(maskCoversFrames(painted), true);
});
