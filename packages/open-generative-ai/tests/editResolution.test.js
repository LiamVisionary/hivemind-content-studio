// Resolution tiers for reference-driven edits — the studio half of
// snap_biglove_klein3_resolution() / _reshape_dims_to_image_aspect().
const test = require('node:test');
const assert = require('node:assert/strict');

test('no stored resolution means the model’s native canvas', async () => {
    const { editBudgetForShortSide } = await import('../src/lib/editResolution.js');
    for (const stored of [0, undefined, null, NaN, -1]) {
        const budget = editBudgetForShortSide(stored);
        assert.deepEqual([budget.width, budget.height], [1024, 1536]);
        assert.equal(budget.native, true);
    }
});

test('every tier is on the sampling grid and inside the supported range', async () => {
    const {
        EDIT_SHORT_SIDES, EDIT_MIN_PIXELS, EDIT_MAX_PIXELS, editBudgetForShortSide,
    } = await import('../src/lib/editResolution.js');
    const seen = new Set();
    for (const size of EDIT_SHORT_SIDES) {
        const budget = editBudgetForShortSide(size);
        assert.equal(budget.width % 32, 0);
        assert.equal(budget.height % 32, 0);
        assert.ok(budget.pixels >= EDIT_MIN_PIXELS, `${size} under the floor`);
        assert.ok(budget.pixels <= EDIT_MAX_PIXELS, `${size} over the ceiling`);
        // The select labels tiers by megapixels — two tiers rounding to the same
        // label would render as duplicate options.
        const label = budget.megapixels.toFixed(1);
        assert.ok(!seen.has(label), `duplicate tier label ${label} MP`);
        seen.add(label);
    }
});

test('a resolution carried over from text-to-image snaps to an offered tier', async () => {
    const { EDIT_SHORT_SIDES, editBudgetForShortSide } = await import('../src/lib/editResolution.js');
    // 1280 is a text-to-image short side; the edit select must still have a
    // selected option, and the payload must match what it shows.
    assert.equal(editBudgetForShortSide(1280).shortSide, 1152);
    assert.equal(editBudgetForShortSide(700).shortSide, 640);
    assert.ok(EDIT_SHORT_SIDES.includes(editBudgetForShortSide(9999).shortSide));
});

test('the output keeps the budget and takes the reference’s aspect', async () => {
    const { editBudgetForShortSide, editOutputDimensions } = await import('../src/lib/editResolution.js');
    const budget = editBudgetForShortSide(1024);
    const square = editOutputDimensions(budget, 2000, 2000);
    assert.ok(Math.abs(square.width - square.height) <= 32);
    assert.ok(Math.abs(square.width * square.height - budget.pixels) / budget.pixels < 0.05);

    const wide = editOutputDimensions(budget, 1920, 1080);
    assert.ok(wide.width > wide.height);
    assert.ok(Math.abs(wide.width / wide.height - 16 / 9) < 0.06);
    assert.ok(Math.abs(wide.width * wide.height - budget.pixels) / budget.pixels < 0.05);

    for (const dims of [square, wide]) {
        assert.equal(dims.width % 32, 0);
        assert.equal(dims.height % 32, 0);
    }
});

test('a degenerate reference is clamped at 3:1 instead of exploding one side', async () => {
    const { editBudgetForShortSide, editOutputDimensions } = await import('../src/lib/editResolution.js');
    const budget = editBudgetForShortSide(1024);
    const strip = editOutputDimensions(budget, 8000, 200);
    assert.ok(strip.width / strip.height <= 3.05);
});

test('an unmeasured reference yields no prediction rather than NaN', async () => {
    const { editBudgetForShortSide, editOutputDimensions } = await import('../src/lib/editResolution.js');
    const budget = editBudgetForShortSide(1024);
    assert.equal(editOutputDimensions(budget, undefined, undefined), null);
    assert.equal(editOutputDimensions(budget, 0, 0), null);
    assert.equal(editOutputDimensions(null, 1024, 1024), null);
});
