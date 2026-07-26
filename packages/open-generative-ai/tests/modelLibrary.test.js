const test = require('node:test');
const assert = require('node:assert/strict');

const asset = (overrides = {}) => ({
    id: 'loras/Example.safetensors',
    kind: 'lora',
    name: 'Example.safetensors',
    displayName: 'Example LoRA',
    folder: 'loras',
    baseModel: 'Krea 2',
    creator: 'someone',
    tags: [],
    triggerWords: [],
    sizeBytes: 1024 * 1024,
    dateAdded: '2026-07-01T00:00:00Z',
    versionId: '111',
    civitaiModelId: '222',
    ...overrides,
});

test('assets filter by kind, base model, and everything a name can hide behind', async () => {
    const { filterAssets } = await import('../src/lib/modelLibrary.js');
    const assets = [
        asset(),
        asset({ id: 'checkpoints/Big.safetensors', kind: 'checkpoint', displayName: 'Big Love', baseModel: 'Flux.2 Klein 9B' }),
        asset({ id: 'loras/Anima.safetensors', displayName: 'Anima style', baseModel: 'Anima', triggerWords: ['monkey d. luffy'] }),
    ];

    assert.equal(filterAssets(assets, { kind: 'checkpoint' }).length, 1);
    assert.equal(filterAssets(assets, { baseModel: 'Anima' }).length, 1);
    // A trigger word is often the only thing you remember about a LoRA.
    assert.deepEqual(filterAssets(assets, { query: 'luffy' }).map((item) => item.displayName), ['Anima style']);
    // Filenames are searchable too — downloads are known by their file.
    assert.deepEqual(filterAssets(assets, { query: 'big.safetensors' }).map((item) => item.kind), ['checkpoint']);
    assert.equal(filterAssets(assets, { query: 'nothing here' }).length, 0);
});

test('sorts are stable on name and fall back to it', async () => {
    const { sortAssets } = await import('../src/lib/modelLibrary.js');
    const assets = [
        asset({ displayName: 'beta', sizeBytes: 10, dateAdded: '2026-01-01T00:00:00Z' }),
        asset({ displayName: 'Alpha', sizeBytes: 30, dateAdded: '2026-03-01T00:00:00Z' }),
        asset({ displayName: 'gamma', sizeBytes: 20, dateAdded: '2026-02-01T00:00:00Z' }),
    ];

    assert.deepEqual(sortAssets(assets, 'name').map((a) => a.displayName), ['Alpha', 'beta', 'gamma']);
    assert.deepEqual(sortAssets(assets, 'size').map((a) => a.displayName), ['Alpha', 'gamma', 'beta']);
    assert.deepEqual(sortAssets(assets, 'recent').map((a) => a.displayName), ['Alpha', 'gamma', 'beta']);
});

test('the library summary counts by kind and totals the bytes on disk', async () => {
    const { librarySummary, formatBytes } = await import('../src/lib/modelLibrary.js');
    const summary = librarySummary([
        asset({ sizeBytes: 1024 }),
        asset({ kind: 'checkpoint', sizeBytes: 2048 }),
        asset({ kind: 'other', sizeBytes: 0 }),
    ]);

    assert.equal(summary.total, 3);
    assert.equal(summary.byKind.lora, 1);
    assert.equal(summary.byKind.checkpoint, 1);
    assert.equal(summary.byKind.embedding, 0);
    assert.equal(summary.totalBytes, 3072);
    assert.equal(formatBytes(3072), '3.0 KB');
    assert.equal(formatBytes(0), '0 B');
});

test('a Civitai link is version-pinned, and absent when the sidecar has no model id', async () => {
    const { civitaiAssetUrl } = await import('../src/lib/modelLibrary.js');
    assert.equal(civitaiAssetUrl(asset()), 'https://civitai.com/models/222?modelVersionId=111');
    assert.equal(civitaiAssetUrl(asset({ versionId: '' })), 'https://civitai.com/models/222');
    assert.equal(civitaiAssetUrl(asset({ civitaiModelId: '' })), '');
});

test('search params only carry an explicit rating choice', async () => {
    const { civitaiSearchParams, DEFAULT_CIVITAI_FILTERS } = await import('../src/lib/modelLibrary.js');

    const any = civitaiSearchParams('  krea  ', DEFAULT_CIVITAI_FILTERS);
    assert.equal(any.query, 'krea');
    assert.equal(any.primaryFileOnly, true);
    assert.equal('nsfw' in any, false);

    const safe = civitaiSearchParams('', { ...DEFAULT_CIVITAI_FILTERS, nsfw: 'false' });
    assert.equal(safe.nsfw, 'false');
    // An empty query means "browse", not "search for nothing".
    assert.equal('query' in safe, false);
});

test('installed detection matches on either the version or the file id', async () => {
    const { isCivitaiResultInstalled } = await import('../src/lib/modelLibrary.js');
    const installed = { versionIds: new Set(['9']), fileIds: new Set(['7']) };

    assert.equal(isCivitaiResultInstalled({ versionId: '9', fileId: '1' }, installed), true);
    assert.equal(isCivitaiResultInstalled({ versionId: '2', fileId: '7' }, installed), true);
    assert.equal(isCivitaiResultInstalled({ versionId: '2', fileId: '1' }, installed), false);
    // Arrays work as well as sets, so a caller need not pre-build them.
    assert.equal(isCivitaiResultInstalled({ versionId: '9' }, { versionIds: ['9'], fileIds: [] }), true);
});

test('model capability chips report only what the catalog carries', async () => {
    const { modelCapabilityChips, sortModels } = await import('../src/lib/modelLibrary.js');

    assert.deepEqual(
        modelCapabilityChips({ defaultWidth: 1024, defaultHeight: 1024, defaultSteps: 8, supportsLoras: true }),
        ['1024²', '8 steps', 'LoRAs'],
    );
    // No steps recorded -> no "0 steps" chip.
    assert.deepEqual(modelCapabilityChips({ defaultWidth: 1024, defaultHeight: 1344 }), ['1024×1344']);
    assert.deepEqual(modelCapabilityChips(null), []);

    assert.deepEqual(
        sortModels([{ name: 'b' }, { name: 'a' }, { name: 'z', featured: true }]).map((m) => m.name),
        ['z', 'a', 'b'],
    );
});
