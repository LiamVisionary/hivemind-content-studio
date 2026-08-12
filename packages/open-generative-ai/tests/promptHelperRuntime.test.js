import test from 'node:test';
import assert from 'node:assert/strict';

import {
    blockedReason,
    canSelect,
    externalHold,
    formatBytes,
    lastUsedModelId,
    modelStatus,
    preferredModelId,
    rememberModelId,
    sortModels,
} from '../src/lib/promptHelperRuntime.js';

const model = (fit, extra = {}) => ({ id: `m-${fit}`, fit, estimatedLoadBytes: 21 * 1024 ** 3, ...extra });

test('a model that fits is always selectable', () => {
    assert.equal(canSelect(model('fits'), { unloadOthers: false }), true);
    assert.equal(canSelect(model('fits'), { unloadOthers: true }), true);
});

test('an already-loaded model stays selectable', () => {
    assert.equal(canSelect(model('loaded'), { unloadOthers: false }), true);
});

test('a model needing room is selectable only when unloading others is on', () => {
    assert.equal(canSelect(model('needs_unload'), { unloadOthers: false }), false);
    assert.equal(canSelect(model('needs_unload'), { unloadOthers: true }), true);
});

test('a model too big for the machine is never selectable', () => {
    // The whole point of the guard: no toggle should be able to talk the user
    // into a load that cannot fit even with everything unloaded.
    assert.equal(canSelect(model('insufficient'), { unloadOthers: true }), false);
    assert.equal(canSelect(model('insufficient'), { unloadOthers: false }), false);
});

test('blocked models explain themselves, selectable ones stay quiet', () => {
    assert.equal(blockedReason(model('fits')), '');
    assert.match(blockedReason(model('needs_unload'), { unloadOthers: false }), /Unload others first/);
    assert.match(blockedReason(model('insufficient')), /more than this machine can free/);
});

test('an estimate is marked approximate until a real load measures it', () => {
    assert.equal(modelStatus(model('fits', { measured: false })), '~21.0 GB in RAM');
    assert.equal(modelStatus(model('fits', { measured: true })), '21.0 GB in RAM');
    assert.equal(modelStatus(model('loaded')), 'Loaded');
});

test('formatBytes switches units and survives junk', () => {
    assert.equal(formatBytes(0), '0 GB');
    assert.equal(formatBytes(null), '0 GB');
    assert.equal(formatBytes(512 * 1024 ** 2), '512 MB');
    assert.equal(formatBytes(7.38 * 1024 ** 3), '7.4 GB');
});

test('memory held outside the studio is reported so the RAM figure adds up', () => {
    assert.equal(externalHold({ external: [] }), null);
    assert.deepEqual(externalHold({ external: [{ id: 'qwen3.6-27b' }] }), { count: 1, names: ['qwen3.6-27b'] });
});

test('loaded models sort first, then largest', () => {
    const rows = sortModels([
        { id: 'small', fit: 'fits', sizeBytes: 5 },
        { id: 'big', fit: 'fits', sizeBytes: 50 },
        { id: 'live', fit: 'loaded', sizeBytes: 1 },
    ]);
    assert.deepEqual(rows.map((r) => r.id), ['live', 'big', 'small']);
});

test('a model is preselected when nothing is loaded', () => {
    // The dialog only auto-selected a model already in RAM. After a page
    // reload — or a stack restart that killed the server — nothing is loaded,
    // so nothing was selected, and every action returned silently: "Apply
    // change does nothing". The fallback is the first model that fits.
    const models = [
        { id: 'huge.gguf', name: 'Huge', fit: 'insufficient', estimatedLoadBytes: 9e10 },
        { id: 'scout.gguf', name: 'Swarm Scout 12B', fit: 'fits', estimatedLoadBytes: 1e10 },
    ];
    assert.equal(preferredModelId(models), 'scout.gguf');
    // A model already in RAM wins over the top row — it costs nothing to use.
    const withLive = [...models, { id: 'live.gguf', name: 'Live', fit: 'loaded', estimatedLoadBytes: 2e10 }];
    assert.equal(preferredModelId(withLive, { loadedId: 'live.gguf' }), 'live.gguf');
    // Nothing usable at all stays empty rather than selecting the unusable.
    assert.equal(preferredModelId([models[0]]), '');
});

test('the last used model wins the preselection', () => {
    const models = [
        { id: 'big.gguf', name: 'Big', fit: 'fits', sizeBytes: 5e10, estimatedLoadBytes: 5e10 },
        { id: 'scout.gguf', name: 'Scout', fit: 'fits', sizeBytes: 1e10, estimatedLoadBytes: 1e10 },
        { id: 'huge.gguf', name: 'Huge', fit: 'insufficient', estimatedLoadBytes: 9e10 },
    ];
    // Over the sort order — the picker is largest-first, which is why a fresh
    // page kept re-offering a model the owner had already passed over.
    assert.equal(preferredModelId(models, { lastUsedId: 'scout.gguf' }), 'scout.gguf');
    // And over whatever happens to be in RAM: the owner chose this one.
    assert.equal(
        preferredModelId(models, { lastUsedId: 'scout.gguf', loadedId: 'big.gguf' }),
        'scout.gguf',
    );
    // A remembered model that is gone from disk, or too big to load now, gives
    // way rather than leaving the dialog pointed at something unusable.
    assert.equal(preferredModelId(models, { lastUsedId: 'deleted.gguf', loadedId: 'big.gguf' }), 'big.gguf');
    assert.equal(preferredModelId(models, { lastUsedId: 'huge.gguf' }), 'big.gguf');
});

test('the remembered id survives a browser with no localStorage', () => {
    // node:test has no localStorage; the helpers must degrade to "nothing
    // remembered" instead of throwing on the way into the picker.
    assert.equal(lastUsedModelId(), '');
    assert.doesNotThrow(() => rememberModelId('scout.gguf'));
});
