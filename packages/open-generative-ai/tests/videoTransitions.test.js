// The Video Studio's setup transitions, EVALUATED rather than pattern-matched.
//
// videoLogic carried a .jsx extension while containing no JSX at all, so
// node:test could not import it and every rule in it was pinned by reading the
// source as text. That is a weak guarantee, and it failed exactly once it
// mattered: relocating the pure helpers into src/lib left the transitions
// calling a name that `export … from` had forwarded but not bound, and the whole
// studio rendered a blank page. The suite passed. The build passed. Only loading
// the app caught it.
//
// So: these actually run the transitions. Anything that throws or leaves the
// setup incoherent fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function stubBrowserGlobals() {
    const originals = { window: global.window, localStorage: global.localStorage, sessionStorage: global.sessionStorage };
    const eventTarget = new EventTarget();
    eventTarget.location = { search: '?hivemindStudio=1', origin: 'https://studio.test' };
    eventTarget.parent = { postMessage() {} };
    global.window = eventTarget;
    global.localStorage = { getItem: () => null, removeItem() {}, setItem() {} };
    global.sessionStorage = { getItem: () => null, removeItem() {}, setItem() {} };
    return () => Object.assign(global, originals);
}

const H3 = {
    id: 'hivemind-media:minimax-h3',
    name: 'MiniMax H3',
    workflowId: 'minimax-h3',
    workflowFamily: 'minimax',
    accepts: ['steps', 'spectrum', 'end_image_base64', 'reference_images'],
    supportsEndFrame: true,
    supportsSpectrum: true,
    supportsQualitySteps: true,
    defaultSteps: 15,
    aspectRatios: ['16:9', '9:16'],
    durations: [1, 2, 3, 4, 5],
    defaultDuration: 5,
};

async function loadLogic(tag) {
    return import(`${pathToFileURL(path.join(__dirname, '../src/studios/video/videoLogic.js')).href}?test=${tag}`);
}

test('every setup transition runs without reaching an unbound helper', async () => {
    const restore = stubBrowserGlobals();
    try {
        const logic = await loadLogic('transitions');
        const catalogs = logic.buildCatalogs([logic.adaptHivemindToVideoEntry(H3)]);
        const initial = logic.buildInitialSetup(catalogs);
        const onH3 = logic.applyModelDefaults({ ...initial, modelId: H3.id, imageMode: true }, catalogs);

        // Each of these both changes the model and re-derives its defaults, which
        // is where an unbound helper hides.
        const cases = {
            newPrompt: () => logic.newPromptTransition(onH3, catalogs),
            extend: () => logic.extendTransition(onH3, catalogs),
            startFrameCleared: () => logic.startFrameClearedTransition({ ...onH3, modelId: catalogs.allI2V[1].id }, catalogs),
            startFrameSelected: () => logic.startFrameSelectedTransition(initial, '/api/x.png', catalogs).setup,
            videoUploaded: () => logic.videoUploadedTransition(initial, { url: '/v.mp4', name: 'v', useHivemind: false }, catalogs),
            clearVideoUpload: () => logic.clearVideoUploadTransition({ ...initial, videoUrl: '/v.mp4' }, catalogs),
            selectRegular: () => logic.selectRegularModelTransition(initial, catalogs.allT2V[0], catalogs),
            selectHivemind: () => logic.selectHivemindWorkflowTransition(initial, catalogs.hivemindI2V[0], catalogs),
            restoredPreferences: () => logic.applyRestoredPreferences(initial, { modelId: H3.id, duration: 5 }, catalogs),
            generationContext: () => logic.applyGenerationContext(initial, { model: H3.id, imageMode: false }, catalogs)?.setup,
        };
        for (const [name, run] of Object.entries(cases)) {
            const setup = run();
            assert.ok(setup, `${name} produced a setup`);
            assert.equal(typeof setup.modelId, 'string', `${name} names a model`);
            assert.ok(setup.modelId, `${name} names a model`);
            assert.equal(typeof setup.advancedValues, 'object', `${name} re-derived advanced values`);
        }
    } finally {
        restore();
    }
});

test('changing the model always rewrites the family it is gated on', async () => {
    const restore = stubBrowserGlobals();
    try {
        const logic = await loadLogic('family-writer');
        const catalogs = logic.buildCatalogs([logic.adaptHivemindToVideoEntry(H3)]);
        const onH3 = { ...logic.buildInitialSetup(catalogs), modelId: H3.id, modelName: H3.name, modelFamily: 'minimax', imageMode: true };

        // Leaving on H3 for a cloud model used to keep modelFamily 'minimax',
        // because these transitions spread the previous setup and rewrote only
        // the id and name. Every family-scoped control then answered for a model
        // that was no longer selected.
        for (const [name, next] of Object.entries({
            newPrompt: logic.newPromptTransition(onH3, catalogs),
            extend: logic.extendTransition(onH3, catalogs),
        })) {
            assert.ok(!next.modelId.startsWith('hivemind-media:minimax'), `${name} left the H3 family`);
            assert.notEqual(next.modelFamily, 'minimax', `${name} must not carry the old family forward`);
        }

        // And selecting a local workflow sets it.
        const back = logic.selectHivemindWorkflowTransition(onH3, catalogs.hivemindI2V[0], catalogs);
        assert.equal(back.modelFamily, 'minimax');
    } finally {
        restore();
    }
});

test('capabilities do not depend on whether a start frame is attached', async () => {
    const restore = stubBrowserGlobals();
    try {
        const logic = await loadLogic('mode-blind');
        const catalogs = logic.buildCatalogs([logic.adaptHivemindToVideoEntry(H3)]);
        const answer = (imageMode) => {
            const model = logic.currentModel({ modelId: H3.id, imageMode, v2vMode: false }, catalogs);
            return {
                resolved: Boolean(model),
                endFrame: Boolean(model?.supportsEndFrame),
                spectrum: logic.supportsSpectrum(model),
                steps: logic.supportsQualitySteps(model),
            };
        };
        assert.deepEqual(answer(false), answer(true),
            'the same model must answer the same way with and without a start frame');
        assert.deepEqual(answer(false), { resolved: true, endFrame: true, spectrum: true, steps: true });

        // The picker stays mode-scoped — that part is deliberate.
        assert.notEqual(
            logic.generationModelsFor({ imageMode: true }, catalogs).length,
            logic.generationModelsFor({ imageMode: false }, catalogs).length,
        );
    } finally {
        restore();
    }
});

test('the registry model reaches the studio whole', async () => {
    const restore = stubBrowserGlobals();
    try {
        const logic = await loadLogic('adapter');
        // The adapter used to enumerate the fields it copied, so any capability
        // the registry gained and it forgot read as undefined downstream.
        const entry = logic.adaptHivemindToVideoEntry({ ...H3, someLaterCapability: true });
        for (const key of Object.keys(H3)) {
            assert.deepEqual(entry[key], H3[key], `${key} carried through`);
        }
        assert.equal(entry.someLaterCapability, true, 'a field added later carries through unchanged');
        assert.equal(entry.provider, 'hivemind-media-studio');
        assert.ok(entry.inputs?.prompt, 'and the catalog input shim is synthesized');
    } finally {
        restore();
    }
});
