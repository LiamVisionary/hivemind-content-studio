// Compare-viewer geometry (fit / anchored zoom / pan clamp), adapted from
// Mix-Studio's compare viewer behavior (BlackMixture/Mix-Studio, GPL-3.0).
const test = require('node:test');
const assert = require('node:assert/strict');

test('fitSize contains the image inside the stage preserving aspect', async () => {
    const { fitSize } = await import('../src/lib/compareMath.js');
    // Wide image in a square stage: width binds.
    assert.deepEqual(fitSize(2000, 1000, 800, 800), { width: 800, height: 400 });
    // Tall image: height binds.
    assert.deepEqual(fitSize(1000, 2000, 800, 800), { width: 400, height: 800 });
    // Degenerate inputs never divide by zero.
    const degenerate = fitSize(0, 0, 0, 0);
    assert.ok(degenerate.width >= 0 && degenerate.height >= 0);
});

test('clampPan keeps the zoomed image over the stage and snaps small axes to center', async () => {
    const { clampPan } = await import('../src/lib/compareMath.js');
    const fit = { width: 800, height: 400 };
    const stage = { width: 800, height: 800 };
    // At zoom 1 the image matches stage width: no x pan allowed; y smaller than
    // stage: snaps to 0.
    assert.deepEqual(clampPan({ x: 250, y: -300 }, fit, 1, stage), { x: 0, y: 0 });
    // At zoom 3 the image is 2400x1200: x may travel ±800, y ±200.
    assert.deepEqual(clampPan({ x: 5000, y: -5000 }, fit, 3, stage), { x: 800, y: -200 });
});

test('zoomAroundAnchor keeps the anchored point stationary', async () => {
    const { zoomAroundAnchor } = await import('../src/lib/compareMath.js');
    // Anchor at stage center never moves the pan.
    assert.deepEqual(zoomAroundAnchor({ x: 0, y: 0 }, 1, 2, { x: 0, y: 0 }), { x: 0, y: 0 });
    // Doubling zoom with the anchor 100px right of center pulls the image left
    // so the anchored image point stays under the pointer.
    const moved = zoomAroundAnchor({ x: 0, y: 0 }, 1, 2, { x: 100, y: 0 });
    assert.deepEqual(moved, { x: -100, y: 0 });
    // Invariant: the image-space point under the anchor is unchanged.
    // imagePoint = (anchor - pan) / zoom before and after.
    const before = (100 - 0) / 1;
    const after = (100 - moved.x) / 2;
    assert.equal(before, after);
});

test('actualSizeZoom and clamps stay within the supported range', async () => {
    const { actualSizeZoom, clampZoom, clampSplit, COMPARE_ZOOM_MAX } = await import('../src/lib/compareMath.js');
    assert.equal(actualSizeZoom(3200, 800), 4);
    assert.equal(actualSizeZoom(80000, 800), COMPARE_ZOOM_MAX);
    assert.equal(clampZoom(0.2), 1);
    assert.equal(clampZoom('nope'), 1);
    assert.equal(clampSplit(140), 100);
    assert.equal(clampSplit(-3), 0);
});
