// H3 restyle presets (Mix-Studio Style Transfer port) — idempotent application.
const test = require('node:test');
const assert = require('node:assert/strict');

test('all six donor presets exist with full prompts', async () => {
    const { H3_RESTYLE_PRESETS } = await import('../src/lib/h3RestylePresets.js');
    assert.equal(H3_RESTYLE_PRESETS.length, 6);
    for (const preset of H3_RESTYLE_PRESETS) {
        assert.ok(preset.id && preset.label && preset.hint, `${preset.id} labeled`);
        assert.ok(preset.prompt.length > 80, `${preset.id} carries the full donor prompt`);
    }
});

test('switching styles replaces the phrase instead of stacking', async () => {
    const { applyRestylePrompt } = await import('../src/lib/h3RestylePresets.js');
    const first = applyRestylePrompt('A courier waits on the platform.', null, 'anime-2d');
    assert.match(first.prompt, /Visual style: polished hand-drawn 2D anime/);
    const second = applyRestylePrompt(first.prompt, first.id, 'stop-motion');
    assert.doesNotMatch(second.prompt, /hand-drawn 2D anime/);
    assert.match(second.prompt, /Visual style: premium handcrafted stop-motion/);
    // Clearing strips entirely and reports a null id.
    const cleared = applyRestylePrompt(second.prompt, second.id, null);
    assert.doesNotMatch(cleared.prompt, /Visual style:/);
    assert.equal(cleared.id, null);
    assert.match(cleared.prompt, /^A courier waits on the platform/);
});
