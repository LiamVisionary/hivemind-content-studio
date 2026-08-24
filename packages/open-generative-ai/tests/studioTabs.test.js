import test from 'node:test';
import assert from 'node:assert/strict';

import {
    IMAGE_TAB_FIELDS, VIDEO_TAB_FIELDS,
    addTab, closeTab, cloneTabValue, consumeSeed, insertTabAfter,
    loadTabState, newTabState, readTabState, saveTabState, selectTab, snapshotTabFields,
    studioInstanceId, studioLaneId,
} from '../src/lib/studioTabs.js';

// The persistence helpers talk to sessionStorage; node has none.
function installSessionStorage() {
    const store = new Map();
    globalThis.sessionStorage = {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => { store.set(key, String(value)); },
        removeItem: (key) => { store.delete(key); },
    };
    return store;
}

/* ---------------- tab list ---------------- */

test('a studio opens with exactly one tab, and that tab restores persisted settings', () => {
    const state = newTabState();
    assert.equal(state.tabs.length, 1);
    // No seed is the signal for "boot from persisted preferences". Every tab
    // opened by hand carries one; a tab restored after a reload does not, which is
    // why StudioTabs tells the studio which tab is PRIMARY rather than letting it
    // infer that from the seed.
    assert.equal(state.tabs[0].seed, null);
    assert.equal(state.activeId, state.tabs[0].id);
});

test('scheduler lanes queue one tab without coupling other tabs or studios', () => {
    assert.equal(studioLaneId('image', 'window-a', 1), studioLaneId('image', 'window-a', 1));
    assert.notEqual(studioLaneId('image', 'window-a', 1), studioLaneId('image', 'window-a', 2));
    assert.notEqual(studioLaneId('image', 'window-a', 1), studioLaneId('video', 'window-a', 1));
    assert.notEqual(studioLaneId('image', 'window-a', 1), studioLaneId('image', 'window-b', 1));
});

test('a new tab is seeded fresh and becomes active', () => {
    const state = addTab(newTabState(), { boot: 'fresh' });
    assert.equal(state.tabs.length, 2);
    assert.deepEqual(state.tabs[1].seed, { boot: 'fresh' });
    assert.equal(state.activeId, state.tabs[1].id);
});

test('a duplicate lands directly after its source, not at the end of the strip', () => {
    let state = addTab(newTabState(), { boot: 'fresh' });   // tabs: 1, 2
    state = addTab(state, { boot: 'fresh' });               // tabs: 1, 2, 3
    const source = state.tabs[0].id;
    state = insertTabAfter(state, source, { boot: 'clone', snapshot: { steps: 8 } });

    assert.deepEqual(state.tabs.map((tab) => tab.id), [1, 4, 2, 3]);
    assert.equal(state.activeId, 4);
    assert.equal(source, 1);
    assert.equal(state.tabs[1].seed.boot, 'clone');
});

test('tab ids are never reused, so a closed tab cannot be mistaken for a later one', () => {
    let state = addTab(newTabState(), { boot: 'fresh' });   // ids 1, 2
    state = closeTab(state, 2);
    state = addTab(state, { boot: 'fresh' });
    assert.deepEqual(state.tabs.map((tab) => tab.id), [1, 3]);
});

test('closing the active tab focuses the tab that took its place', () => {
    let state = addTab(addTab(newTabState(), { boot: 'fresh' }), { boot: 'fresh' }); // 1, 2, 3
    state = selectTab(state, 2);
    state = closeTab(state, 2);
    assert.deepEqual(state.tabs.map((tab) => tab.id), [1, 3]);
    assert.equal(state.activeId, 3, 'focus slides to the tab now in that slot');

    // Closing the last tab in the strip falls back to the new last one.
    let end = addTab(newTabState(), { boot: 'fresh' });
    end = closeTab(end, end.activeId);
    assert.equal(end.activeId, 1);
});

test('closing a background tab leaves the focus alone', () => {
    let state = addTab(addTab(newTabState(), { boot: 'fresh' }), { boot: 'fresh' });
    assert.equal(state.activeId, 3);
    state = closeTab(state, 1);
    assert.equal(state.activeId, 3);
});

test('the last tab cannot be closed — a studio always has one', () => {
    const state = newTabState();
    assert.equal(closeTab(state, state.activeId), state);
});

test('unknown ids are inert', () => {
    const state = addTab(newTabState(), { boot: 'fresh' });
    assert.equal(closeTab(state, 99), state);
    assert.equal(selectTab(state, 99), state);
    assert.equal(selectTab(state, state.activeId), state, 're-selecting the active tab is a no-op');
});

test('a consumed seed is dropped so duplicated reference images are not held twice', () => {
    const state = addTab(newTabState(), { boot: 'clone', snapshot: { uploadedImageUrls: ['data:image/png;base64,AAAA'] } });
    const cleared = consumeSeed(state, state.activeId);
    assert.equal(cleared.tabs[1].seed, null);
    assert.equal(consumeSeed(cleared, cleared.activeId), cleared, 'clearing twice is a no-op');
});

/* ---------------- engine snapshots ---------------- */

test('a duplicated tab shares no mutable state with its source', () => {
    // The studio engines keep LoRA selections and per-model tuning in Maps of
    // arrays of objects. A shallow copy would make editing the copy edit the
    // original — the single most damaging way tab duplication could fail.
    const engine = {
        prompt: 'a lighthouse',
        loraSelectionsByModel: new Map([['krea2', [{ id: 'film', strength: 0.8, enabled: true }]]]),
        modelSettingsById: new Map([['local:krea2', { steps: 8, negativePrompt: 'blurry' }]]),
        uploadedImageUrls: ['ref-a.png'],
    };
    const copy = cloneTabValue(engine);

    copy.loraSelectionsByModel.get('krea2')[0].strength = 0.1;
    copy.loraSelectionsByModel.get('krea2').push({ id: 'extra' });
    copy.modelSettingsById.get('local:krea2').steps = 40;
    copy.uploadedImageUrls.push('ref-b.png');

    assert.equal(engine.loraSelectionsByModel.get('krea2').length, 1);
    assert.equal(engine.loraSelectionsByModel.get('krea2')[0].strength, 0.8);
    assert.equal(engine.modelSettingsById.get('local:krea2').steps, 8);
    assert.deepEqual(engine.uploadedImageUrls, ['ref-a.png']);
    assert.ok(copy.loraSelectionsByModel instanceof Map, 'Maps survive the round trip as Maps');
});

test('a snapshot copies only the listed fields and tolerates missing ones', () => {
    const snapshot = snapshotTabFields({ steps: 8, history: ['keep me out'] }, ['steps', 'seed']);
    assert.deepEqual(snapshot, { steps: 8 });
    assert.equal('history' in snapshot, false);
    assert.equal('seed' in snapshot, false, 'a field the engine does not have is skipped, not set to undefined');
});

test('duplicating a tab copies configuration, never results or run state', () => {
    // Copy means "generate again with the same settings", so a duplicate must open
    // on an empty canvas. Anything below leaking into the field list would make a
    // copy claim the original's outputs or its in-flight generation.
    const runState = [
        'history', 'generationHistory', 'generating', 'generationTimer', 'persistTimer',
        'progressDisplay', 'progressReal', 'progressEstimateSec', 'progress', 'localProgress',
        'resultUrl', 'resultModel', 'viewerUrl', 'contextStore', 'lastSubmittedContext',
        'activeLocalJobId', 'abortController', 'authOpen', 'civitaiOpen', 'deleteTarget',
        'cloudRefApproved', 'cloudRefUploads', 'resumeRemaining',
    ];
    for (const field of runState) {
        assert.equal(IMAGE_TAB_FIELDS.includes(field), false, `image tabs must not copy ${field}`);
        assert.equal(VIDEO_TAB_FIELDS.includes(field), false, `video tabs must not copy ${field}`);
    }

    // …and the settings the user would expect to travel with a copy do.
    for (const field of ['prompt', 'negativePrompt', 'selectedModel', 'selectedLocalModel',
        'steps', 'guidanceScale', 'seed', 'uploadedImageUrls', 'loraSelectionsByModel',
        // The per-tab "Run on" pin travels with a duplicate (video keeps it in `setup`).
        'rentedOnly', 'rentedMachineId']) {
        assert.ok(IMAGE_TAB_FIELDS.includes(field), `image tabs must copy ${field}`);
    }
    // The video studio keeps its whole configuration in one immutable `setup`
    // object (model, mode, duration, aspect, seed, keyframes, advanced values).
    for (const field of ['setup', 'videoLoraSelectionsByModel', 'sharedIngredientSelections',
        // The cast, the prompt's stand-ins and the Shots timeline are part of the setup too.
        'cast', 'standIns', 'shotTimeline']) {
        assert.ok(VIDEO_TAB_FIELDS.includes(field), `video tabs must copy ${field}`);
    }
    // Image: what each reference supplies, the UGC deal counters and the open
    // Custom tile travel with the references they describe.
    for (const field of ['referenceRoles', 'ugcVariantIndex', 'ugcRoomIndex', 'customArOpen']) {
        assert.ok(IMAGE_TAB_FIELDS.includes(field), `image tabs must copy ${field}`);
    }
});


/* ---------------- session persistence ---------------- */

test('the strip survives a reload so every tab can reclaim the run it started', () => {
    installSessionStorage();
    let state = addTab(newTabState(), { boot: 'fresh' });
    state = addTab(state, { boot: 'fresh' });
    state = selectTab(state, state.tabs[1].id);
    saveTabState('video', state);

    const restored = loadTabState('video');
    assert.deepEqual(restored.tabs.map((tab) => tab.id), state.tabs.map((tab) => tab.id));
    assert.equal(restored.activeId, state.activeId);
    assert.equal(restored.nextId, state.nextId);
    // Seeds are clone snapshots — reference images and all — and are consumed on
    // the first render anyway. A restored tab is a copy of nothing.
    assert.deepEqual(restored.tabs.map((tab) => tab.seed), [null, null, null]);
});

test('each studio keeps its own strip', () => {
    installSessionStorage();
    saveTabState('video', addTab(newTabState(), { boot: 'fresh' }));
    assert.equal(loadTabState('video').tabs.length, 2);
    assert.equal(loadTabState('image').tabs.length, 1);
});

test('nothing stored, or nonsense stored, opens the usual single tab', () => {
    installSessionStorage();
    assert.deepEqual(loadTabState('video'), newTabState());
    globalThis.sessionStorage.setItem('studio.tabs.video', 'not json');
    assert.deepEqual(loadTabState('video'), newTabState());
    assert.deepEqual(readTabState({ tabs: [] }), newTabState());
    assert.deepEqual(readTabState({ tabs: [{ id: 'x' }, { id: -1 }, { id: 1.5 }] }), newTabState());
});

test('a restored strip can never hand a later tab a live tab id', () => {
    // nextId behind the restored ids would reissue one, and the new tab would
    // inherit the pending generation belonging to the tab that already has it.
    const restored = readTabState({ tabs: [{ id: 4 }, { id: 9 }], activeId: 9, nextId: 2 });
    assert.equal(restored.nextId, 10);
    assert.equal(addTab(restored, { boot: 'fresh' }).tabs.at(-1).id, 10);
});

test('a restored strip drops duplicate ids and an out-of-strip active tab', () => {
    const restored = readTabState({ tabs: [{ id: 3 }, { id: 3 }, { id: 7 }], activeId: 99 });
    assert.deepEqual(restored.tabs.map((tab) => tab.id), [3, 7]);
    assert.equal(restored.activeId, 3);
});

test('a corrupt strip cannot mount an unbounded number of studios', () => {
    const restored = readTabState({ tabs: Array.from({ length: 500 }, (_, i) => ({ id: i + 1 })) });
    assert.equal(restored.tabs.length, 24);
});

test('the app-instance id is stable across mounts, so a resumed run keeps its lane', () => {
    installSessionStorage();
    const first = studioInstanceId();
    assert.equal(studioInstanceId(), first);
    assert.equal(studioLaneId('video', first, 2), studioLaneId('video', studioInstanceId(), 2));
});
