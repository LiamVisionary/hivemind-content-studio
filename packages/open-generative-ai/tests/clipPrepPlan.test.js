// Clip prep planner — src/lib/clipPrepPlan.js. Everything here
// runs without WebCodecs: planClip decides the numbers, prepareClip only
// executes them, so the arithmetic that decides what a reference costs is
// checked here rather than on a GPU.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/lib/clipPrepPlan.js');

const SOURCE = { duration: 12, width: 1920, height: 1080, frameRate: 60 };

test('every quality preset is described and preserves aspect ratio by cap', async () => {
    const { CLIP_QUALITY_PRESETS, qualityPreset } = await load();
    assert.ok(CLIP_QUALITY_PRESETS.length >= 4);
    for (const preset of CLIP_QUALITY_PRESETS) {
        assert.ok(preset.id && preset.label, `${preset.id} labelled`);
        assert.equal(qualityPreset(preset.id), preset, `${preset.id} resolves by id`);
        if (preset.maxEdge != null) assert.ok(preset.maxEdge > 0);
        if (preset.frameRate != null) assert.ok(preset.frameRate > 0);
    }
    // An unknown id must not throw — a restored generation can name a preset
    // that has since been renamed, and it should degrade to the source.
    assert.equal(qualityPreset('nope').id, 'source');
    assert.equal(qualityPreset(undefined).id, 'source');
});

test('output dimensions are always even and never upscaled', async () => {
    const { resolveTargetSize, qualityPreset } = await load();

    const reference = resolveTargetSize({ width: 1920, height: 1080 }, qualityPreset('reference'));
    assert.equal(reference.width % 2, 0);
    assert.equal(reference.height % 2, 0);
    assert.equal(Math.max(reference.width, reference.height), 640);
    assert.equal(reference.scaled, true);
    // 640/1920 * 1080 = 360 exactly; the ratio must survive the even rounding.
    assert.equal(reference.height, 360);

    // A source already under the cap is left alone rather than blown up.
    const small = resolveTargetSize({ width: 320, height: 240 }, qualityPreset('reference'));
    assert.deepEqual(small, { width: 320, height: 240, scaled: false });

    // Odd rasters round DOWN to even — rounding up invents a column.
    const odd = resolveTargetSize({ width: 641, height: 481 }, qualityPreset('source'));
    assert.equal(odd.width, 640);
    assert.equal(odd.height, 480);
});

test('crop is clamped into the source raster from any entry point', async () => {
    const { clampCrop } = await load();
    const source = { width: 1920, height: 1080 };

    // No crop means the whole frame.
    assert.deepEqual(clampCrop(null, source), { left: 0, top: 0, width: 1920, height: 1080 });

    // A rectangle dragged past the right/bottom edge is pulled back inside
    // instead of asking the encoder for pixels that do not exist.
    const overflowing = clampCrop({ left: 1800, top: 1000, width: 400, height: 400 }, source);
    assert.equal(overflowing.left + overflowing.width <= 1920, true);
    assert.equal(overflowing.top + overflowing.height <= 1080, true);

    // Negatives clamp to the origin.
    const negative = clampCrop({ left: -50, top: -50, width: 100, height: 100 }, source);
    assert.equal(negative.left, 0);
    assert.equal(negative.top, 0);

    // Crop dimensions are even for the same 4:2:0 reason as the output size.
    const odd = clampCrop({ left: 0, top: 0, width: 101, height: 99 }, source);
    assert.equal(odd.width % 2, 0);
    assert.equal(odd.height % 2, 0);
});

test('centered aspect crop fits inside the frame and stays centered', async () => {
    const { centeredCrop, CROP_ASPECTS } = await load();
    const source = { width: 1920, height: 1080 };

    for (const aspect of CROP_ASPECTS) {
        const crop = centeredCrop(source, aspect.ratio);
        assert.ok(crop.left >= 0 && crop.top >= 0, `${aspect.id} origin inside`);
        assert.ok(crop.left + crop.width <= source.width, `${aspect.id} fits horizontally`);
        assert.ok(crop.top + crop.height <= source.height, `${aspect.id} fits vertically`);
        assert.equal(crop.width % 2, 0, `${aspect.id} even width`);
        assert.equal(crop.height % 2, 0, `${aspect.id} even height`);
        // Centered: the margins on opposite sides differ by at most the 2px the
        // even-rounding can shave off one side.
        assert.ok(Math.abs((source.width - crop.width - crop.left) - crop.left) <= 2, `${aspect.id} centered x`);
        assert.ok(Math.abs((source.height - crop.height - crop.top) - crop.top) <= 2, `${aspect.id} centered y`);
    }

    // 9:16 out of 1080p is limited by height: 1080 tall, 607→606 wide.
    const vertical = centeredCrop(source, 9 / 16);
    assert.equal(vertical.height, 1080);
    assert.equal(vertical.width, 606);

    // Full frame is the whole raster, untouched.
    assert.deepEqual(centeredCrop(source, null), { left: 0, top: 0, width: 1920, height: 1080 });

    // A ratio the frame already is stays full-width rather than shaving a pixel.
    assert.equal(centeredCrop(source, 16 / 9).width, 1920);

    // Nonsense ratios degrade to the full frame instead of producing NaN.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.deepEqual(centeredCrop(source, bad), { left: 0, top: 0, width: 1920, height: 1080 });
    }
});

test('trim normalizes backwards, overlong and zero-length selections', async () => {
    const { normalizeTrim } = await load();

    assert.deepEqual(normalizeTrim({ start: 2, end: 5 }, 12), { start: 2, end: 5, seconds: 3 });

    // Omitted end means "to the end", which is what a fresh dialog sends.
    assert.equal(normalizeTrim({ start: 4 }, 12).end, 12);

    // Past the duration clamps rather than producing a file that stops early.
    assert.equal(normalizeTrim({ start: 0, end: 99 }, 12).end, 12);

    // Handles dragged past each other swap instead of throwing.
    const backwards = normalizeTrim({ start: 8, end: 3 }, 12);
    assert.equal(backwards.start, 3);
    assert.equal(backwards.end, 8);

    // A zero-length selection would encode a file with no frames.
    assert.ok(normalizeTrim({ start: 5, end: 5 }, 12).seconds > 0);

    // A source with no duration yet (still probing) must not produce NaN.
    assert.deepEqual(normalizeTrim({ start: 1, end: 2 }, 0), { start: 0, end: 0, seconds: 0 });
});

test('a plan that changes nothing is marked lossless', async () => {
    const { planClip } = await load();

    const untouched = planClip(SOURCE, { quality: 'source' });
    assert.equal(untouched.lossless, true, 'no trim, no crop, no scale, no fps change');

    // Any single change forfeits it.
    assert.equal(planClip(SOURCE, { quality: 'source', trim: { start: 1 } }).lossless, false);
    assert.equal(planClip(SOURCE, { quality: 'reference' }).lossless, false);
    assert.equal(planClip(SOURCE, { quality: 'source', dropAudio: true }).lossless, false);
    assert.equal(
        planClip(SOURCE, { quality: 'source', crop: { left: 0, top: 0, width: 1280, height: 720 } }).lossless,
        false,
    );
});

test('frame rate is never raised above the source', async () => {
    const { planClip } = await load();

    // 60fps source, 16fps preset — the cap applies.
    assert.equal(planClip(SOURCE, { quality: 'reference' }).frameRate, 16);

    // An 8fps source under a 16fps preset keeps its own rate: duplicating
    // frames adds bytes and no motion information.
    const slow = planClip({ ...SOURCE, frameRate: 8 }, { quality: 'reference' });
    assert.equal(slow.frameRate, null);

    // An unknown source rate must not silently upscale either.
    const unknown = planClip({ ...SOURCE, frameRate: 0 }, { quality: 'reference' });
    assert.equal(unknown.frameRate, 16, 'with no measurement the cap still applies');
});

test('crop then scale compose in that order', async () => {
    const { planClip } = await load();
    // Crop to a 960x1080 portrait slice of a 1080p frame, then cap the long
    // edge at 640: the cap must apply to the CROPPED raster, not the source.
    const plan = planClip(SOURCE, {
        quality: 'reference',
        crop: { left: 480, top: 0, width: 960, height: 1080 },
    });
    assert.equal(plan.cropped, true);
    assert.equal(plan.scaled, true);
    assert.equal(Math.max(plan.width, plan.height), 640);
    // 960:1080 is 8:9; at a 640 long edge that is 568x640 after even rounding.
    assert.equal(plan.height, 640);
    assert.equal(plan.width, 568);
});

test('reference budget reports which side is actually binding', async () => {
    const { planClip, referenceBudget } = await load();

    // A 3s reference against a 5s shot: the reference is the constraint.
    const short = referenceBudget(planClip(SOURCE, { trim: { start: 0, end: 3 } }), 5);
    assert.equal(short.bindingSeconds, 3);
    assert.equal(short.limitedByReference, true);

    // A 12s reference against a 5s shot: trimming further buys nothing, because
    // the budget is spent on min(reference, clip).
    const long = referenceBudget(planClip(SOURCE, { trim: { start: 0, end: 12 } }), 5);
    assert.equal(long.bindingSeconds, 5);
    assert.equal(long.limitedByReference, false);

    // Pixel cost tracks the planned raster, not the source.
    const compact = referenceBudget(planClip(SOURCE, { quality: 'compact' }), 5);
    const source = referenceBudget(planClip(SOURCE, { quality: 'source' }), 5);
    assert.ok(compact.pixelsPerFrame < source.pixelsPerFrame);
});

test('storyboard timestamps stay strictly inside the trimmed range', async () => {
    const { storyboardTimestamps, normalizeTrim } = await load();
    const trim = normalizeTrim({ start: 2, end: 10 }, 12);

    const six = storyboardTimestamps(trim, 6);
    assert.equal(six.length, 6);
    // Never ON the out-point: on a hard cut that frame belongs to the next shot.
    for (const at of six) {
        assert.ok(at > trim.start, `${at} after the in-point`);
        assert.ok(at < trim.end, `${at} before the out-point`);
    }
    // Monotonic, evenly spaced.
    for (let i = 1; i < six.length; i += 1) assert.ok(six[i] > six[i - 1]);

    // One tile takes the midpoint rather than the start.
    assert.deepEqual(storyboardTimestamps(trim, 1), [6]);

    // Counts are bounded on both ends rather than trusted.
    assert.equal(storyboardTimestamps(trim, 0).length, 1);
    assert.equal(storyboardTimestamps(trim, 999).length, 24);
});
