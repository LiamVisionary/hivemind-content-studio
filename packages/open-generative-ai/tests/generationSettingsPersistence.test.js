const test = require('node:test');
const assert = require('node:assert/strict');

test('lip sync preferences retain input mode, model, and resolution', async () => {
    // The SHIPPED normalizer. This used to import the retired vanilla studio's
    // copy, which meant the rule the app actually runs was never exercised.
    const { normalizeLipSyncPreferences } = await import('../src/lib/studioPreferences.js');

    assert.deepEqual(normalizeLipSyncPreferences({
        inputMode: 'video',
        modelId: ' sync-model ',
        resolution: ' 720p ',
    }), {
        inputMode: 'video',
        modelId: 'sync-model',
        resolution: '720p',
    });
    assert.equal(normalizeLipSyncPreferences({ inputMode: 'image', modelId: '' }), null);
});
