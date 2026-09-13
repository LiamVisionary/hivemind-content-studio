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
        // The per-tab "Run on" pin travels with a duplicate (video keeps it in
        // `setup`). It is the only run-on override a tab carries — `rentedOnly`
        // was a mode beside it and is retired.
        'rentedMachineId']) {
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

/* ---------------- each tab keeps its OWN settings ---------------- */
//
// Reported 2026-09-12: reloading the app put every tab back on the studio-wide
// preferences, so three tabs set up three different ways came back identical —
// and the video studio in particular always reopened on whatever model the last
// write happened to leave in localStorage rather than the one that tab was on.
// Only tab IDS were ever written. Now each tab's own configuration travels with
// its id, and a restored tab boots from that instead.

import {
    mergePrivateSnapshotFields, stripPrivateSnapshotFields, takePrivateSnapshotFields,
} from '../src/lib/studioTabs.js';

test('a reloaded tab boots from its own settings, not the studio-wide ones', () => {
    installSessionStorage();
    const state = { tabs: [{ id: 1 }, { id: 2 }], activeId: 2, nextId: 3 };
    saveTabState('video', state, {
        1: { setup: { modelId: 'ltx23-ic-lora', duration: 5 } },
        2: { setup: { modelId: 'wan-2.2', duration: 3 } },
    });

    const restored = loadTabState('video');
    assert.equal(restored.tabs.length, 2);
    assert.equal(restored.tabs[0].seed.boot, 'restore');
    assert.equal(restored.tabs[0].seed.snapshot.setup.modelId, 'ltx23-ic-lora');
    assert.equal(restored.tabs[1].seed.snapshot.setup.modelId, 'wan-2.2');
});

test('a tab with no snapshot still falls back to the studio-wide preferences', () => {
    // An older strip, or a restored tab nobody ever fronted, so it never
    // published one. A null seed is what boots from persisted prefs.
    installSessionStorage();
    saveTabState('image', { tabs: [{ id: 1 }], activeId: 1, nextId: 2 });
    assert.equal(loadTabState('image').tabs[0].seed, null);
});

test('nothing a person typed is written to sessionStorage', () => {
    // The rule this store has to keep: prompts live encrypted in the composer.
    const store = installSessionStorage();
    saveTabState('video', { tabs: [{ id: 1 }], activeId: 1, nextId: 2 }, {
        1: {
            setup: { prompt: 'a medium shot captures a...', modelId: 'ltx' },
            standIns: ['the dog'], cast: [{ name: 'Ada' }], shotTimeline: [{ line: 'she turns' }],
        },
    });
    const raw = store.get('studio.tabs.video');
    for (const secret of ['medium shot', 'the dog', 'Ada', 'she turns']) {
        assert.doesNotMatch(raw, new RegExp(secret), `"${secret}" reached sessionStorage`);
    }
    // …and the configuration around it still survived.
    assert.equal(loadTabState('video').tabs[0].seed.snapshot.setup.modelId, 'ltx');
});

test('the image prompt and negative prompt are stripped too', () => {
    const stripped = stripPrivateSnapshotFields('image', {
        prompt: 'a dog runs to his owner',
        negativePrompt: 'blurry',
        selectedAr: '1:1',
        modelSettingsById: new Map([['krea2', { steps: 8, negativePrompt: 'ugly' }]]),
        result: { url: '/image/x.png', prompt: 'a dog runs to his owner', model: 'local:z' },
    });
    assert.equal(stripped.prompt, undefined);
    assert.equal(stripped.negativePrompt, undefined);
    assert.equal(stripped.modelSettingsById.get('krea2').negativePrompt, '');
    assert.equal(stripped.modelSettingsById.get('krea2').steps, 8, 'the tuning itself survives');
    assert.equal(stripped.selectedAr, '1:1');
    // The result keeps what it needs to render and loses what it does not.
    assert.equal(stripped.result.url, '/image/x.png');
    assert.equal(stripped.result.prompt, undefined);
});

test('what sessionStorage loses, the draft vault carries — and the two rejoin', () => {
    // The split is a storage detail: a tab that comes back is the tab that left.
    // sessionStorage keeps the configuration, the encrypted vault keeps the
    // words, and readTabState hands the studio one whole snapshot again.
    const snapshot = {
        prompt: 'a dog runs to his owner',
        negativePrompt: 'blurry',
        selectedAr: '1:1',
        modelSettingsById: new Map([['krea2', { steps: 8, negativePrompt: 'ugly' }]]),
        result: { url: '/image/x.png', prompt: 'a dog runs to his owner' },
    };
    const draft = takePrivateSnapshotFields('image', snapshot);
    assert.equal(draft.prompt, 'a dog runs to his owner');
    assert.equal(draft.negativePrompt, 'blurry');
    assert.equal(draft.modelSettingsById.krea2.negativePrompt, 'ugly');
    assert.equal(draft.result.prompt, 'a dog runs to his owner');
    assert.equal(draft.selectedAr, undefined, 'a plain setting was taken as if it were private');

    const rejoined = mergePrivateSnapshotFields('image', stripPrivateSnapshotFields('image', snapshot), draft);
    assert.equal(rejoined.prompt, 'a dog runs to his owner');
    assert.equal(rejoined.negativePrompt, 'blurry');
    assert.equal(rejoined.modelSettingsById.get('krea2').negativePrompt, 'ugly');
    assert.equal(rejoined.modelSettingsById.get('krea2').steps, 8, 'the tuning around it was lost');
    assert.equal(rejoined.result.prompt, 'a dog runs to his owner');
    assert.equal(rejoined.selectedAr, '1:1');
});

test('the video prompt, cast and timeline make the same round trip', () => {
    const snapshot = {
        setup: { prompt: 'a medium shot captures a...', modelId: 'ltx' },
        standIns: ['the dog'], cast: [{ name: 'Ada' }], shotTimeline: [{ line: 'she turns' }],
    };
    const draft = takePrivateSnapshotFields('video', snapshot);
    const rejoined = mergePrivateSnapshotFields('video', stripPrivateSnapshotFields('video', snapshot), draft);
    assert.equal(rejoined.setup.prompt, 'a medium shot captures a...');
    assert.equal(rejoined.setup.modelId, 'ltx');
    assert.deepEqual(rejoined.standIns, ['the dog']);
    assert.deepEqual(rejoined.cast, [{ name: 'Ada' }]);
    assert.deepEqual(rejoined.shotTimeline, [{ line: 'she turns' }]);
});

test('a draft never resurrects a per-model entry the snapshot has dropped', () => {
    // The tuning cache is rebuilt from the catalog; a negative prompt left over
    // from a model that is no longer there must not put the model back.
    const merged = mergePrivateSnapshotFields('image', {
        modelSettingsById: new Map([['krea2', { steps: 8, negativePrompt: '' }]]),
    }, { modelSettingsById: { krea2: { negativePrompt: 'ugly' }, retired: { negativePrompt: 'gone' } } });
    assert.equal(merged.modelSettingsById.get('krea2').negativePrompt, 'ugly');
    assert.equal(merged.modelSettingsById.has('retired'), false);
});

test('a tab with no draft still comes back with its settings', () => {
    const merged = mergePrivateSnapshotFields('image', { selectedAr: '16:9', prompt: '' }, null);
    assert.equal(merged.selectedAr, '16:9');
    assert.equal(merged.prompt, '');
});

test('Maps and Sets survive the round trip through storage', () => {
    // The engines keep two Maps; JSON drops them silently, which would restore a
    // tab with its LoRA selections quietly emptied.
    installSessionStorage();
    saveTabState('image', { tabs: [{ id: 1 }], activeId: 1, nextId: 2 }, {
        1: { loraSelectionsByModel: new Map([['krea2', [{ id: 'a', strength: 0.8 }]]]) },
    });
    const back = loadTabState('image').tabs[0].seed.snapshot.loraSelectionsByModel;
    assert.ok(back instanceof Map, 'came back as a plain object, not a Map');
    assert.equal(back.get('krea2')[0].strength, 0.8);
});

test('the last result travels so a restored tab is not staring at nothing', () => {
    installSessionStorage();
    saveTabState('video', { tabs: [{ id: 7 }], activeId: 7, nextId: 8 }, {
        7: { setup: { modelId: 'ltx' }, result: { url: '/image/clip.mp4', model: 'ltx23' } },
    });
    const seed = loadTabState('video').tabs[0].seed;
    assert.equal(seed.snapshot.result.url, '/image/clip.mp4');
    assert.equal(seed.snapshot.result.model, 'ltx23');
});

/* ---------------- what a new tab and a duplicate open with ---------------- */
//
// The spec, 2026-09-12: "new tabs must use their respective route's persistence
// (e.g. a new tab in the image studio must use the image studio's last used
// model/workflow), unless duplicating a tab in which case it must duplicate the
// complete settings of the tab duplicated including last generation preview".
// A new tab used to boot on CATALOG DEFAULTS, so pressing + threw away the local
// model you had just chosen. These pin the three boot modes against the source.

import { readFileSync } from 'node:fs';

// Deliberately textual: the branch under test lives inside createEngine, which
// runs once per MOUNT from a seed. Rendering a studio to observe it means
// standing up the cloud catalog, the local-model discovery and the vault for
// each of the three boot modes — and the thing being pinned is a one-line
// precedence decision, which reads more honestly as the line itself.
for (const studio of ['ImageStudio', 'VideoStudio']) {
    test(`${studio}: a new tab inherits the studio's last-used settings`, () => {
        const source = readFileSync(new URL(`../src/studios/${studio}.jsx`, import.meta.url), 'utf8');
        assert.match(
            source,
            /if \(boot === 'persisted' \|\| boot === 'fresh'\) \{/,
            'a new tab is booting on catalog defaults again',
        );
    });

    test(`${studio}: a duplicate and a restored tab both adopt a snapshot`, () => {
        const source = readFileSync(new URL(`../src/studios/${studio}.jsx`, import.meta.url), 'utf8');
        assert.match(source, /boot === 'clone' \|\| boot === 'restore'/);
        // …and the result comes with it, rather than opening on an empty stage.
        assert.match(source, /const \{ result, \.\.\.config \} = snapshot;/);
        assert.match(source, /result:\s/, 'snapshot() no longer publishes the last result');
    });
}
