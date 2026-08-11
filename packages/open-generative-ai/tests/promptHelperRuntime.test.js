import test from 'node:test';
import assert from 'node:assert/strict';

import {
    blockedReason,
    canSelect,
    externalHold,
    formatBytes,
    modelStatus,
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
    const pick = (data) => {
        const live = data.loaded?.[0]?.modelId;
        if (live) return live;
        return sortModels(data.models).find((m) => canSelect(m, { unloadOthers: true }))?.id || '';
    };
    assert.equal(pick({ models, loaded: [] }), 'scout.gguf');
    // A model already in RAM still wins — it costs nothing to use.
    assert.equal(pick({ models, loaded: [{ modelId: 'huge.gguf' }] }), 'huge.gguf');
    // Nothing usable at all stays empty rather than selecting the unusable.
    assert.equal(pick({ models: [models[0]], loaded: [] }), '');
});
