// Regional prompt composition — adapted from Mix-Studio's regional workflow
// helpers (BlackMixture/Mix-Studio, GPL-3.0). Their graph assertions are
// dropped: we ship the centroid→language half, which needs no custom node.
const test = require('node:test');
const assert = require('node:assert/strict');

test('centroid decides placement, and thirds keep near-center boxes centered', async () => {
    const { positionPhrase } = await import('../src/lib/regionPrompt.js');
    const at = (x, y, w = 0.2, h = 0.2) => positionPhrase({ x, y, w, h });
    assert.equal(at(0.05, 0.05), 'positioned in the top left of the frame');
    assert.equal(at(0.75, 0.75), 'positioned in the bottom right of the frame');
    assert.equal(at(0.4, 0.4), 'positioned in the center of the frame');
    assert.equal(at(0.75, 0.4), 'positioned on the right side of the frame');
    assert.equal(at(0.4, 0.05), 'positioned in the top center of the frame');
    // A box that only just crosses the third still reads as centered, so a
    // one-pixel drag never flips the caption.
    assert.equal(at(0.35, 0.35, 0.2, 0.2), 'positioned in the center of the frame');
});

test('boxes that dominate an axis get span language instead of a corner', async () => {
    const { positionPhrase } = await import('../src/lib/regionPrompt.js');
    assert.equal(positionPhrase({ x: 0, y: 0, w: 1, h: 1 }), 'filling the entire frame');
    assert.equal(
        positionPhrase({ x: 0, y: 0.7, w: 1, h: 0.3 }),
        'spanning the full width across the bottom of the frame',
    );
    assert.equal(
        positionPhrase({ x: 0.7, y: 0, w: 0.3, h: 1 }),
        'occupying the full right half of the frame',
    );
    assert.equal(
        positionPhrase({ x: 0.4, y: 0, w: 0.2, h: 1 }),
        'occupying the full middle column of the frame',
    );
});

test('a description that places itself is never given a second placement', async () => {
    const { regionDescription } = await import('../src/lib/regionPrompt.js');
    assert.equal(
        regionDescription({ description: 'a wolf on the left', x: 0.7, y: 0.7, w: 0.2, h: 0.2 }),
        'a wolf on the left',
        'the users own spatial words win — two placements would contradict',
    );
    assert.equal(
        regionDescription({ description: 'a wolf', x: 0.7, y: 0.7, w: 0.2, h: 0.2 }),
        'a wolf, positioned in the bottom right of the frame',
    );
});

test('regions are clamped into the frame and empty ones are dropped', async () => {
    const { normalizeRegions, MIN_REGION_SIZE } = await import('../src/lib/regionPrompt.js');
    const [region] = normalizeRegions([{ description: 'a lantern', x: 0.9, y: 0.9, w: 0.5, h: 0.5 }]);
    assert.equal(region.x + region.w, 1, 'a box is pulled back to the edge, not left hanging outside');
    assert.equal(region.y + region.h, 1);

    const tiny = normalizeRegions([{ description: 'a speck', x: 0.5, y: 0.5, w: 0, h: 0 }]);
    assert.equal(tiny[0].w, MIN_REGION_SIZE);

    // A box with nothing written in it would emit a bare position phrase.
    assert.deepEqual(normalizeRegions([{ description: '   ', x: 0.1, y: 0.1 }]), []);
    assert.deepEqual(normalizeRegions([{ description: 'off', enabled: false }]), []);
    assert.deepEqual(normalizeRegions(['nope', null, 42]), []);
    assert.deepEqual(normalizeRegions(undefined), []);
});

test('regions are capped and colored from the palette in draw order', async () => {
    const { normalizeRegions, MAX_REGIONS, REGION_COLORS } = await import('../src/lib/regionPrompt.js');
    const many = normalizeRegions(
        Array.from({ length: 12 }, (_, i) => ({ description: `thing ${i}`, x: 0.1, y: 0.1 })),
    );
    assert.equal(many.length, MAX_REGIONS);
    assert.equal(many[0].color, REGION_COLORS[0]);
    assert.equal(many[1].color, REGION_COLORS[1]);
    // An explicit color survives; ids are stable enough for React keys.
    const [kept] = normalizeRegions([{ description: 'x', color: '#ff0000', id: 'mine' }]);
    assert.equal(kept.color, '#ff0000');
    assert.equal(kept.id, 'mine');
});

test('composing joins the scene with one placed sentence per region', async () => {
    const { composeRegionalPrompt } = await import('../src/lib/regionPrompt.js');
    const prompt = composeRegionalPrompt('a rainy neon street.', [
        { description: 'a detective in a long coat', x: 0.05, y: 0.3, w: 0.3, h: 0.6 },
        { description: 'a ramen cart', x: 0.68, y: 0.5, w: 0.28, h: 0.4 },
    ]);
    assert.equal(
        prompt,
        'a rainy neon street. a detective in a long coat, positioned on the left side of the frame. '
        + 'a ramen cart, positioned in the bottom right of the frame',
    );
});

test('composing twice says everything once — restored generations keep their boxes', async () => {
    const { composeRegionalPrompt } = await import('../src/lib/regionPrompt.js');
    const regions = [
        { description: 'a detective in a long coat', x: 0.05, y: 0.3, w: 0.3, h: 0.6 },
        { description: 'a ramen cart', x: 0.68, y: 0.5, w: 0.28, h: 0.4 },
    ];
    const once = composeRegionalPrompt('a rainy neon street.', regions);
    assert.equal(composeRegionalPrompt(once, regions), once, 'a restored prompt must not re-append its own regions');
    // A box edited after the restore still lands.
    const edited = composeRegionalPrompt(once, [...regions, { description: 'a stray cat', x: 0.45, y: 0.8, w: 0.1, h: 0.15 }]);
    assert.equal(edited, `${once}. a stray cat, positioned in the bottom center of the frame`);
});

test('the composer is invisible until a region is actually drawn', async () => {
    const { composeRegionalPrompt } = await import('../src/lib/regionPrompt.js');
    assert.equal(composeRegionalPrompt('a quiet harbour at dawn.', []), 'a quiet harbour at dawn.');
    assert.equal(composeRegionalPrompt('a quiet harbour at dawn.', undefined), 'a quiet harbour at dawn.');
    // Trailing punctuation is only touched when there is something to join to.
    assert.equal(composeRegionalPrompt('  spaced  ', []), 'spaced');
    // Regions alone still compose — the scene prompt is optional.
    assert.equal(
        composeRegionalPrompt('', [{ description: 'a red door', x: 0.4, y: 0.4, w: 0.2, h: 0.2 }]),
        'a red door, positioned in the center of the frame',
    );
});

test('hasActiveRegions answers what the UI badge and the generate path both ask', async () => {
    const { hasActiveRegions } = await import('../src/lib/regionPrompt.js');
    assert.equal(hasActiveRegions([{ description: 'a wolf' }]), true);
    assert.equal(hasActiveRegions([{ description: '' }]), false);
    assert.equal(hasActiveRegions([]), false);
});
