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

test('Muting a LoRA keeps its slot and weight but drops it from the payload', async () => {
    const { isLoraEnabled, loraGenerationPayload, toggleLoraEnabled, toggleLoraSelection } =
        await import('../src/lib/loraSelection.js');

    const style = { id: 'style.safetensors', name: 'style.safetensors', displayName: 'Style' };
    const detail = { id: 'detail.safetensors', name: 'detail.safetensors', displayName: 'Detail' };
    let selection = toggleLoraSelection(toggleLoraSelection([], style), detail);
    selection = selection.map((item) => (item.id === style.id ? { ...item, strength: 0.65 } : item));

    const muted = toggleLoraEnabled(selection, style.id);

    // The row stays put, keeps its tuned weight, and is simply not sent.
    assert.equal(muted.length, 2);
    assert.equal(muted[0].strength, 0.65);
    assert.equal(isLoraEnabled(muted[0]), false);
    assert.deepEqual(loraGenerationPayload(muted), [{ id: 'detail.safetensors', strength: 1 }]);

    // Toggling back restores it with the same weight.
    const restored = toggleLoraEnabled(muted, style.id);
    assert.equal(isLoraEnabled(restored[0]), true);
    assert.deepEqual(loraGenerationPayload(restored)[0], { id: 'style.safetensors', strength: 0.65 });
});

test('Selections saved before muting existed stay enabled', async () => {
    const { isLoraEnabled, loraGenerationPayload } = await import('../src/lib/loraSelection.js');
    const legacy = [{ id: 'old.safetensors', name: 'old.safetensors', strength: 0.8 }];

    assert.equal(isLoraEnabled(legacy[0]), true);
    assert.deepEqual(loraGenerationPayload(legacy), [{ id: 'old.safetensors', strength: 0.8 }]);
});

test('The muted flag survives a persistence round-trip in both studios', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { normalizeImagePreferences } = await import('../src/studios/image/imagePrefs.js');
    const selections = [
        { id: 'on.safetensors', name: 'on.safetensors', strength: 1 },
        { id: 'off.safetensors', name: 'off.safetensors', strength: 0.5, enabled: false },
    ];

    const image = normalizeImagePreferences({ modelId: 'krea', loraSelections: { 'local:krea': selections } });
    assert.deepEqual(image.loraSelections['local:krea'].map((l) => l.enabled), [true, false]);

    // videoLogic.jsx cannot be imported by node:test (JSX), so assert its
    // normalizer carries the same flag through the saved selection shape.
    const videoLogic = fs.readFileSync(path.join(__dirname, '../src/studios/video/videoLogic.jsx'), 'utf8');
    assert.match(videoLogic, /enabled: selection\.enabled !== false/);
});

test('an update-and-replace keeps the slot, weight and mute state under the new id', async () => {
    const { replaceLoraInSelection } = await import('../src/lib/loraSelection.js');
    const selection = [
        { id: 'look-v1.safetensors', name: 'look-v1.safetensors', displayName: 'Look', strength: 0.65, enabled: false },
        { id: 'other.safetensors', name: 'other.safetensors', strength: 1, enabled: true },
    ];

    const swapped = replaceLoraInSelection(selection, 'look-v1.safetensors', {
        id: 'look-v2.safetensors',
        name: 'look-v2.safetensors',
        displayName: 'Look',
        previewUrl: '/preview/v2',
    });

    assert.equal(swapped[0].id, 'look-v2.safetensors');
    assert.equal(swapped[0].strength, 0.65); // tuned weight survives the update
    assert.equal(swapped[0].enabled, false); // so does the mute
    assert.equal(swapped[0].previewUrl, '/preview/v2');
    assert.deepEqual(swapped[1], selection[1]); // untouched
});

test('replacing leaves the selection alone when the LoRA was not selected or the file kept its name', async () => {
    const { replaceLoraInSelection } = await import('../src/lib/loraSelection.js');
    const selection = [{ id: 'look.safetensors', name: 'look.safetensors', strength: 1, enabled: true }];

    // Not selected → nothing to carry over.
    assert.equal(replaceLoraInSelection(selection, 'absent.safetensors', { id: 'new.safetensors' }), selection);
    // Same filename → the file was updated in place, the id still points at it.
    assert.equal(replaceLoraInSelection(selection, 'look.safetensors', { id: 'look.safetensors' }), selection);
    // No replacement id → refuse to corrupt the slot.
    assert.equal(replaceLoraInSelection(selection, 'look.safetensors', { id: '' }), selection);
});

test('update availability merges onto the catalog by installed id', async () => {
    const { mergeLoraUpdates } = await import('../src/lib/loraSelection.js');
    const loras = [{ id: 'a.safetensors' }, { id: 'b.safetensors' }];
    const update = { latestVersionId: '999', url: 'https://civitai.com/models/1?modelVersionId=999' };

    const merged = mergeLoraUpdates(loras, { 'b.safetensors': update });

    assert.equal(merged[0].update, undefined);
    assert.deepEqual(merged[1].update, update);
    assert.deepEqual(mergeLoraUpdates(loras, null), loras); // no updates → unchanged shape
});

test('version labels add the v only for bare numbers and never invent one', async () => {
    const { loraVersionLabel } = await import('../src/lib/loraSelection.js');

    assert.equal(loraVersionLabel({ versionName: '2.0' }), 'v2.0');
    assert.equal(loraVersionLabel({ versionName: 'v1.2' }), 'v1.2');
    // Descriptive Civitai names stay as written — "vSDXL - Pruned" would be nonsense.
    assert.equal(loraVersionLabel({ versionName: 'SDXL - Pruned' }), 'SDXL - Pruned');
    // Hand-placed files have no Civitai version, so they get no label at all.
    assert.equal(loraVersionLabel({ versionName: '' }), '');
    assert.equal(loraVersionLabel({}), '');
    assert.equal(loraVersionLabel(null), '');
});

test('a newer version for a different base model is not offered as an update', async () => {
    const { mergeLoraUpdates, isLoraUpdateCandidate } = await import('../src/lib/loraSelection.js');
    // Real case: Civitai model 2173844 publishes one version per base, so its newest
    // version is the Krea 2 adapter — not an update for the installed ZImageTurbo file.
    const installed = { id: 'Z-Image-fac1al.safetensors', baseModel: 'ZImageTurbo' };
    const kreaSibling = { latestVersionId: '3074632', latestVersionName: 'Krea 2 v1.0', latestBaseModel: 'Krea 2' };
    const realUpdate = { latestVersionId: '2526600', latestVersionName: 'v2', latestBaseModel: 'ZImageTurbo' };

    assert.equal(isLoraUpdateCandidate(installed, kreaSibling), false);
    assert.equal(isLoraUpdateCandidate(installed, realUpdate), true);
    // ZImageBase is a different base, not a loose prefix match for ZImageTurbo.
    assert.equal(isLoraUpdateCandidate(installed, { latestVersionId: '9', latestBaseModel: 'ZImageBase' }), false);
    // Civitai's inconsistent spellings of the same family still match.
    assert.equal(isLoraUpdateCandidate({ baseModel: 'Flux.1 D' }, { latestVersionId: '9', latestBaseModel: 'Flux.1 Dev' }), true);
    // Unknown base on either side: defer to the gateway rather than hiding an update.
    assert.equal(isLoraUpdateCandidate({ baseModel: '' }, { latestVersionId: '9', latestBaseModel: 'Krea 2' }), true);

    const merged = mergeLoraUpdates([installed], { 'Z-Image-fac1al.safetensors': kreaSibling });
    assert.equal(merged[0].update, undefined); // no Update button for a sibling build
});

test('a sibling option is never offered as an update', async () => {
    const { isLoraUpdateCandidate, mergeLoraUpdates } = await import('../src/lib/loraSelection.js');
    // Real case: Civitai model 2535622 ships "Soft Enhance" and "Crisp Enhance" as
    // two versions of the same base. Offering Crisp as an update to Soft replaced
    // an installed file with the other option.
    const soft = { id: 'LTX2.3_Soft_Enhance.safetensors', baseModel: 'LTXV 2.3' };
    const crisp = {
        currentVersionId: '2849706', currentVersionName: 'Soft Enhance',
        latestVersionId: '2849716', latestVersionName: 'Crisp Enhance', latestBaseModel: 'LTXV 2.3',
    };

    assert.equal(isLoraUpdateCandidate(soft, crisp), false);
    assert.deepEqual(mergeLoraUpdates([soft], { [soft.id]: crisp })[0].update, undefined);

    // A newer build of the same option still updates.
    assert.equal(isLoraUpdateCandidate(soft, {
        currentVersionId: '2849706', currentVersionName: 'Soft Enhance',
        latestVersionId: '2900000', latestVersionName: 'Soft Enhance v2', latestBaseModel: 'LTXV 2.3',
    }), true);

    // Real revisions from the installed library keep working.
    for (const [current, latest] of [['v1.0', 'v1.1'], ['V4.1 Exp, pre', 'v4.3_EXP'], ['2vector', '3vector'], ['small breast-flat chest', 'V2.1']]) {
        assert.equal(isLoraUpdateCandidate({ baseModel: 'Krea 2' }, {
            currentVersionId: '1', currentVersionName: current,
            latestVersionId: '2', latestVersionName: latest, latestBaseModel: 'Krea 2',
        }), true, `${current} -> ${latest}`);
    }

    // Names missing on either side: fall back to the gateway's judgement.
    assert.equal(isLoraUpdateCandidate({ baseModel: 'Krea 2' }, { latestVersionId: '2', latestBaseModel: 'Krea 2' }), true);
});

test('a saved LoRA group keeps identity and tuning, and re-resolves against the live catalog', async () => {
    const { loraGroupFromSelection, loraSelectionFromGroup } = await import('../src/lib/loraSelection.js');

    const selection = [
        { id: 'anime.safetensors', name: 'anime.safetensors', displayName: 'Anime', previewUrl: '/api/p/old.png', strength: 0.75, enabled: true },
        { id: 'detail.safetensors', name: 'detail.safetensors', displayName: 'Detail', previewUrl: '', strength: 1.4, enabled: false },
    ];
    const group = loraGroupFromSelection(selection, { baseModelId: 'krea2', baseLabel: 'Krea 2' });
    assert.equal(group.baseLabel, 'Krea 2');
    assert.deepEqual(group.loras.map(l => [l.id, l.strength, l.enabled]), [
        ['anime.safetensors', 0.75, true],
        ['detail.safetensors', 1.4, false],
    ]);
    // Catalog metadata is NOT trusted from the saved copy — an update-and-replace
    // rewrites the preview and display name, so the live entry wins.
    assert.equal(group.loras[0].previewUrl, undefined);

    const catalog = [
        { id: 'anime.safetensors', name: 'anime.safetensors', displayName: 'Anime v3', previewUrl: '/api/p/new.png' },
        { id: 'detail.safetensors', name: 'detail.safetensors', displayName: 'Detail' },
    ];
    const { selection: restored, missing } = loraSelectionFromGroup(group, catalog);
    assert.deepEqual(missing, []);
    assert.equal(restored[0].displayName, 'Anime v3');
    assert.equal(restored[0].previewUrl, '/api/p/new.png');
    assert.equal(restored[0].strength, 0.75);
    assert.equal(restored[1].enabled, false, 'a muted LoRA must come back muted');
});

test('a group naming LoRAs that are not installed reports them instead of silently shrinking', async () => {
    const { loraSelectionFromGroup } = await import('../src/lib/loraSelection.js');

    const group = { loras: [
        { id: 'present.safetensors', displayName: 'Present', strength: 1, enabled: true },
        { id: 'gone.safetensors', displayName: 'Gone', strength: 1, enabled: true },
    ] };
    const { selection, missing } = loraSelectionFromGroup(group, [{ id: 'present.safetensors', name: 'present.safetensors' }]);

    assert.deepEqual(selection.map(l => l.id), ['present.safetensors']);
    assert.deepEqual(missing, ['Gone']);
});
