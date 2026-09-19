// Character Sheet (Civitai multi-view port): the mode + preset are settings,
// so they persist through normalizeImagePreferences and travel with a
// duplicated tab like the couple-mode fields do.
const test = require('node:test');
const assert = require('node:assert/strict');

test('character sheet mode and preset survive preference normalization', async () => {
    const { normalizeImagePreferences } = await import('../src/studios/image/imagePrefs.js');
    const prefs = normalizeImagePreferences({
        modelId: 'seedream45',
        characterSheetMode: true,
        characterSheetPreset: 'standard',
        modelSettings: {
            'local:comfy-bigloves-klein3-edit': {
                characterSheetMode: true,
                characterSheetPreset: 'full',
            },
        },
    });
    assert.equal(prefs.characterSheetMode, true);
    assert.equal(prefs.characterSheetPreset, 'standard');
    assert.equal(prefs.modelSettings['local:comfy-bigloves-klein3-edit'].characterSheetMode, true);
    assert.equal(prefs.modelSettings['local:comfy-bigloves-klein3-edit'].characterSheetPreset, 'full');
});

test('an unknown character sheet preset falls back to turnaround, mode defaults off', async () => {
    const { normalizeImagePreferences } = await import('../src/studios/image/imagePrefs.js');
    const prefs = normalizeImagePreferences({ modelId: 'seedream45', characterSheetPreset: 'everything' });
    assert.equal(prefs.characterSheetMode, false);
    assert.equal(prefs.characterSheetPreset, 'turnaround');
});

test('character sheet settings travel with a duplicated image tab', async () => {
    const { IMAGE_TAB_FIELDS } = await import('../src/lib/studioTabs.js');
    assert.ok(IMAGE_TAB_FIELDS.includes('characterSheetMode'));
    assert.ok(IMAGE_TAB_FIELDS.includes('characterSheetPreset'));
});
