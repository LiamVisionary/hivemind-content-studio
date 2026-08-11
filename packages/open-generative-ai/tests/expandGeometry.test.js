// Canvas-expansion target math (Mix-Studio outpaint-plan port).
const test = require('node:test');
const assert = require('node:assert/strict');

test('growing a square to widescreen keeps the source height', async () => {
    const { computeExpandTarget } = await import('../src/lib/expandGeometry.js');
    const target = computeExpandTarget(1024, 1024, '21:9');
    assert.ok(target);
    // Both dims /16, wider than the source, height near the source's.
    assert.equal(target.width % 16, 0);
    assert.equal(target.height % 16, 0);
    assert.ok(target.width > 1024);
    assert.ok(Math.abs(target.height - 1024) <= 128); // pixel budget may shave it
    assert.ok(target.width / target.height > 2 && target.width / target.height < 2.55);
});

test('growing to a taller aspect keeps the source width', async () => {
    const { computeExpandTarget } = await import('../src/lib/expandGeometry.js');
    const target = computeExpandTarget(1024, 576, '9:16');
    assert.ok(target);
    assert.ok(target.height > 576);
    assert.ok(target.width <= 1024);
});

test('a matching aspect returns null — nothing to expand into', async () => {
    const { computeExpandTarget } = await import('../src/lib/expandGeometry.js');
    assert.equal(computeExpandTarget(1024, 1024, '1:1'), null);
    // Near-identical ratios collapse to a sliver after snapping: also null.
    assert.equal(computeExpandTarget(1600, 1200, '4:3'), null);
});

test('the pixel budget bounds huge targets while preserving the aspect', async () => {
    const { computeExpandTarget, EXPAND_MAX_PIXELS } = await import('../src/lib/expandGeometry.js');
    const target = computeExpandTarget(2048, 2048, '21:9');
    assert.ok(target);
    assert.ok(target.width * target.height <= EXPAND_MAX_PIXELS);
});

test('invalid inputs return null instead of NaN dimensions', async () => {
    const { computeExpandTarget, parseAspect } = await import('../src/lib/expandGeometry.js');
    assert.equal(computeExpandTarget(0, 0, '16:9'), null);
    assert.equal(computeExpandTarget(1024, 1024, 'wide'), null);
    assert.equal(parseAspect('16:9'), 16 / 9);
    assert.equal(parseAspect('junk'), null);
});
