// Phase-2 Mix-Studio ports: the Style Preset phrase composer (fixes the dead
// dropdown) and the Strength Hunt LoRA-axis selection helpers.
const test = require('node:test');
const assert = require('node:assert/strict');

test('style presets append a phrase idempotently and respect None', async () => {
    const { applyStylePreset, STYLE_PRESETS, STYLE_PRESET_PHRASES } = await import('../src/studios/image/imagePrefs.js');
    // Every non-None preset has a phrase — a preset without one is dead again.
    for (const name of STYLE_PRESETS.filter((n) => n !== 'None')) {
        assert.ok(STYLE_PRESET_PHRASES[name], `${name} has a phrase`);
    }
    assert.equal(applyStylePreset('a red fox', 'None'), 'a red fox');
    assert.equal(applyStylePreset('a red fox', 'Unknown Style'), 'a red fox');

    const once = applyStylePreset('a red fox', 'Cinematic');
    assert.match(once, /^a red fox, cinematic composition/);
    // Applying again must not stack the phrase.
    assert.equal(applyStylePreset(once, 'Cinematic'), once);
    // Empty prompt gets the phrase alone (image-guided edits with no text).
    assert.equal(applyStylePreset('', 'Anime'), (await import('../src/studios/image/imagePrefs.js')).STYLE_PRESET_PHRASES['Anime']);
});

test('strength hunt toggling caps at two axes and never queues a third', async () => {
    const { toggleLoraHunt, huntLoraIds } = await import('../src/lib/loraSelection.js');
    const selection = [
        { id: 'a.safetensors', strength: 0.8, enabled: true },
        { id: 'b.safetensors', strength: 1.2, enabled: true },
        { id: 'c.safetensors', strength: 0.5, enabled: true },
    ];
    let next = toggleLoraHunt(selection, 'a.safetensors');
    next = toggleLoraHunt(next, 'b.safetensors');
    next = toggleLoraHunt(next, 'c.safetensors'); // refused: already two armed
    assert.deepEqual(huntLoraIds(next), ['a.safetensors', 'b.safetensors']);
    // Toggling one off frees the slot.
    next = toggleLoraHunt(next, 'a.safetensors');
    next = toggleLoraHunt(next, 'c.safetensors');
    assert.deepEqual(huntLoraIds(next), ['b.safetensors', 'c.safetensors']);
});

test('hunt ids exclude muted and zero-strength LoRAs', async () => {
    const { huntLoraIds } = await import('../src/lib/loraSelection.js');
    assert.deepEqual(huntLoraIds([
        { id: 'muted.safetensors', strength: 1, enabled: false, hunt: true },
        { id: 'zero.safetensors', strength: 0, enabled: true, hunt: true },
        { id: 'live.safetensors', strength: 0.7, enabled: true, hunt: true },
    ]), ['live.safetensors']);
});

test('the hunt flag never leaks into the generation LoRA payload', async () => {
    const { loraGenerationPayload } = await import('../src/lib/loraSelection.js');
    const payload = loraGenerationPayload([
        { id: 'a.safetensors', strength: 0.8, enabled: true, hunt: true },
    ]);
    assert.deepEqual(payload, [{ id: 'a.safetensors', strength: 0.8 }]);
});
