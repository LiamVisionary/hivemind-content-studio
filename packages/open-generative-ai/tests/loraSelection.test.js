const test = require('node:test');
const assert = require('node:assert/strict');

test('LoRA selection defaults to weight one and toggles off cleanly', async () => {
    const { toggleLoraSelection } = await import('../src/lib/loraSelection.js');
    const lora = { id: 'styles/look.safetensors', name: 'look.safetensors', displayName: 'Look' };
    const selected = toggleLoraSelection([], lora);

    assert.equal(selected.length, 1);
    assert.equal(selected[0].strength, 1);
    assert.deepEqual(toggleLoraSelection(selected, lora), []);
});

test('LoRA weights remain adjustable, include zero, and serialize minimally', async () => {
    const { loraGenerationPayload, updateLoraStrength } = await import('../src/lib/loraSelection.js');
    const selection = [{ id: 'look.safetensors', name: 'look.safetensors', strength: 1 }];
    const zeroed = updateLoraStrength(selection, 'look.safetensors', '0');

    assert.equal(zeroed[0].strength, 0);
    assert.deepEqual(loraGenerationPayload(zeroed), [{ id: 'look.safetensors', strength: 0 }]);
});
