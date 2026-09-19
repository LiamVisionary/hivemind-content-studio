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
//
// Deliberately textual: the round trip through normalize → restore is checked
// directly above; the source pin is that the panel reads the same fields back.
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
    // The cloud model catalog is SERVED now (src/lib/cloudCatalog.js), so the
    // studio's t2v/i2v lists are empty until it has loaded — and
    // buildInitialSetup boots off t2vModels[0]. With no control API here this
    // resolves from the generated offline list, the same one a standalone build
    // uses. The module is shared across these ?test= instances, so once is enough.
    const catalog = await import(pathToFileURL(path.join(__dirname, '../src/lib/cloudCatalog.js')).href);
    await catalog.cloudCatalogReady();
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
            newPrompt: () => logic.newPromptTransition(onH3),
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
            extend: logic.extendTransition(onH3, catalogs),
        })) {
            assert.ok(!next.modelId.startsWith('hivemind-media:minimax'), `${name} left the H3 family`);
            assert.notEqual(next.modelFamily, 'minimax', `${name} must not carry the old family forward`);
        }
        // "+ New" no longer leaves at all: H3 generates from text, so a fresh
        // prompt stays on it — and the family stays truthful WITH it.
        const fresh = logic.newPromptTransition(onH3);
        assert.equal(fresh.modelId, H3.id, '+ New keeps the H3 model');
        assert.equal(fresh.modelFamily, 'minimax');

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

// "+ New" and clearing a source clip used to land on allT2V[0] — the first CLOUD
// model — while the Source stayed Local: the Model chip named Seedance Lite with
// a cloud icon, the picker (filtered to local models) did not list it, and
// Generate opened the API-key modal.
//
// Start fresh no longer moves the model AT ALL, which settles that class of bug
// rather than steering around it: the model is not one of the inputs the press
// clears, so a cleared image-to-video model waits for its next start frame
// (Generate says so) instead of hopping to a text-to-video sibling and taking
// the clip length, aspect, resolution and advanced values with it. Clearing the
// clip, a different door, still respects the source the old way.
test('Start fresh clears every input and leaves the model exactly where it was', async () => {
    const restore = stubBrowserGlobals();
    try {
        const logic = await loadLogic('no-cloud-hop');
        const LTX = {
            id: 'hivemind-media:ltx23-eros-fast', name: 'LTX 2.3 Eros', workflowId: 'ltx23-eros-fast',
            workflowFamily: 'ltx', accepts: ['video_base64'], supportsVideoInput: true,
            aspectRatios: ['16:9'], durations: [4, 8], defaultDuration: 4,
        };
        const catalogs = logic.buildCatalogs([logic.adaptHivemindToVideoEntry(H3), logic.adaptHivemindToVideoEntry(LTX)]);
        const initial = logic.buildInitialSetup(catalogs);
        const isLocal = (id) => logic.isLocalVideoModel(id);

        // H3, Local: "+ New" keeps the model, clears every input, keeps the format.
        const onH3 = logic.applyModelDefaults({
            ...initial, modelId: H3.id, modelName: H3.name, modelFamily: 'minimax', imageMode: true, localMode: true,
            prompt: 'a shot', imageUrl: '/api/x.png', referenceImageUrls: ['/api/r.png'], duration: 3,
        }, catalogs);
        const fresh = logic.newPromptTransition({ ...onH3, duration: 3 });
        assert.equal(fresh.modelId, H3.id);
        assert.equal(fresh.prompt, '');
        assert.equal(fresh.imageUrl, null);
        assert.deepEqual(fresh.referenceImageUrls, []);
        assert.equal(fresh.duration, 3, 'the format settings survive a fresh prompt on the same model');
        assert.equal(fresh.imageMode, true, 'local workflows keep the optional-start-frame shape');

        // An LTX clip being extended, Local: clearing the clip keeps LTX.
        const extending = logic.videoUploadedTransition(
            { ...initial, localMode: true, modelId: H3.id, modelName: H3.name, modelFamily: 'minimax' },
            { url: '/api/clip.mp4', name: 'clip.mp4', useHivemind: true, preferredHive: catalogs.hivemindI2V[1] },
            catalogs,
        );
        assert.equal(extending.modelId, LTX.id, 'precondition: the upload moved to the LTX extension graph');
        const cleared = logic.clearVideoUploadTransition(extending, catalogs);
        assert.equal(cleared.videoUrl, null);
        assert.equal(cleared.modelId, LTX.id, 'clearing the clip keeps the local model');
        assert.equal(cleared.localMode, true);

        // A video TOOL keeps itself and its mode: the source clip is gone, the
        // tool is still selected, and Generate asks for the next clip.
        const onTool = logic.selectV2VModelTransition({ ...initial, localMode: true, videoUrl: '/api/c.mp4' }, logic.v2vModels[0], catalogs);
        const offTool = logic.newPromptTransition(onTool);
        assert.equal(offTool.modelId, onTool.modelId, 'a video tool survives Start fresh');
        assert.equal(offTool.v2vMode, true, 'and stays in the mode that model runs in');
        assert.equal(offTool.videoUrl, null, 'while the clip it was fed is gone');
        assert.equal(offTool.localMode, onTool.localMode, 'and the source is left as it was found');
        // Note what is NOT asserted: that a Local session ends up on a local
        // model. Start fresh cannot introduce that mismatch any more, because it
        // moves no model — so it also no longer quietly REPAIRS a session that
        // was already in one. Fixing a mismatched source belongs to the picker
        // that made it, not to a press that says it clears the composer.

        // A cloud image-to-video model keeps ITSELF — the start frame is what
        // goes, not the lane the user chose, and the settings that came with it
        // are still there when the next frame is attached.
        const cloudI2V = catalogs.allI2V.find((m) => !isLocal(m.id) && m.family
            && catalogs.allT2V.some((t) => t.family === m.family && !isLocal(t.id)));
        const onCloudI2V = logic.applyModelDefaults(
            logic.withSelectedModel({ ...initial, localMode: false, imageMode: true, imageUrl: '/api/x.png' }, cloudI2V), catalogs,
        );
        const offCloud = logic.newPromptTransition({ ...onCloudI2V, duration: onCloudI2V.duration });
        assert.equal(offCloud.modelId, cloudI2V.id, 'a cloud image-to-video model is kept, not swapped for a sibling');
        assert.equal(offCloud.imageMode, true, 'and keeps the mode it runs in');
        assert.equal(offCloud.imageUrl, null, 'while the start frame is gone');
        assert.equal(offCloud.duration, onCloudI2V.duration, 'and its format settings were never re-derived');
        assert.equal(offCloud.ar, onCloudI2V.ar);
        assert.equal(offCloud.resolution, onCloudI2V.resolution);
        assert.equal(offCloud.modelFamily, onCloudI2V.modelFamily, 'the family gate still answers for the kept model');

        // A plain cloud text-to-video model simply keeps itself.
        const cloudT2V = catalogs.allT2V.find((m) => !isLocal(m.id));
        const onCloudT2V = logic.selectRegularModelTransition({ ...initial, localMode: false, prompt: 'x' }, cloudT2V, catalogs);
        assert.equal(logic.newPromptTransition(onCloudT2V).modelId, cloudT2V.id);
    } finally {
        restore();
    }
});

// The list the confirm dialog reads out. It has to name what is ACTUALLY
// attached: a dialog that promises to clear a persona nobody loaded teaches
// people to stop reading it.
test('startFreshSummary names what is attached, and nothing that is not', async () => {
    const restore = stubBrowserGlobals();
    try {
        const logic = await loadLogic('fresh-summary');
        // An empty composer has nothing to lose — which is what lets the studio
        // skip the dialog rather than asking about an empty list.
        assert.deepEqual(logic.startFreshSummary({}), []);
        assert.deepEqual(logic.startFreshSummary({ prompt: '  ', referenceImageUrls: [] }), []);
        assert.deepEqual(logic.startFreshSummary({ prompt: 'a shot' }), ['what you typed']);
        assert.deepEqual(logic.startFreshSummary({ imageUrl: '/a.png' }), ['the start frame']);
        assert.deepEqual(logic.startFreshSummary({ endImageUrl: '/b.png', ltxEndUrl: '/c.png' }), ['2 other keyframes']);
        assert.deepEqual(logic.startFreshSummary({ referenceVideos: ['/v.mp4'] }), ['1 attached clip']);
        assert.deepEqual(logic.startFreshSummary({ referenceAudios: ['/a.wav', '/b.wav'] }), ['2 attached voices']);
        assert.deepEqual(logic.startFreshSummary({ persona: { id: 'x' } }), ['the loaded persona']);
        assert.deepEqual(logic.startFreshSummary({ videoUrl: '/clip.mp4' }), ['the source clip']);
        assert.deepEqual(
            logic.startFreshSummary({ prompt: 'a shot', imageUrl: '/a.png', referenceImageUrls: ['/r.png', '/s.png'] }),
            ['what you typed', 'the start frame', '2 attached pictures'],
        );
        // Everything the transition clears can be named by the summary, and the
        // summary of a cleared setup is empty — which is the only guarantee that
        // the dialog and the patch have not drifted apart.
        const cleared = logic.newPromptTransition({
            prompt: 'a shot', imageUrl: '/a.png', endImageUrl: '/b.png', ltxMiddleUrl: '/m.png', ltxEndUrl: '/e.png',
            referenceImageUrls: ['/r.png'], referenceVideos: ['/v.mp4'], referenceAudios: ['/a.wav'],
            persona: { id: 'x' }, videoUrl: '/clip.mp4', videoName: 'clip.mp4',
        });
        assert.deepEqual(logic.startFreshSummary(cleared), []);
    } finally {
        restore();
    }
});

// Settings the Advanced / Task panels hold used to reset on every reload:
// normalizeVideoPreferences carried fields for them, currentVideoPreferences
// never wrote most of them, and applyRestoredPreferences never read any. The
// writer (VideoStudio.currentVideoPreferences) is pinned by text below; the
// reader is evaluated.
test('every Advanced / Task setting survives normalize → restore, and the chips reconcile with the prompt', async () => {
    const restore = stubBrowserGlobals();
    try {
        const logic = await loadLogic('prefs-restore');
        const fs = await import('node:fs');
        const path = await import('node:path');
        const studio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
        const writer = studio.match(/const currentVideoPreferences = [\s\S]*?\n  \}\);/)[0];
        for (const key of ['spectrum', 'nagScale', 'detailerStrength', 'videoTask', 'headSwapBackend', 'headSwapFaceEnhancer', 'headSwapLoraStrength', 'cameraMotionIds', 'restylePresetId']) {
            assert.match(writer, new RegExp(`${key}: s\\.setup\\.${key}`), `the studio persists ${key}`);
        }

        const catalogs = logic.buildCatalogs([logic.adaptHivemindToVideoEntry(H3)]);
        const initial = logic.buildInitialSetup(catalogs);
        const saved = logic.normalizeVideoPreferences({
            modelId: H3.id, duration: 5, spectrum: false, nagScale: 15, detailerStrength: 0.6,
            videoTask: 'head-swap', headSwapBackend: 'facefusion', headSwapFaceEnhancer: true, headSwapLoraStrength: 1.2,
            cameraMotionIds: ['dolly-in', 'roll-cw', 'nope'], restylePresetId: 'anime-2d',
        });
        assert.deepEqual(saved.cameraMotionIds, ['dolly-in', 'roll-cw'], 'ids are normalized, unknown ones dropped');
        assert.equal(saved.restylePresetId, 'anime-2d');
        assert.equal(logic.normalizeVideoPreferences({ modelId: 'm', restylePresetId: 'not-a-preset' }).restylePresetId, null);

        const restored = logic.applyRestoredPreferences(initial, saved, catalogs);
        assert.equal(restored.spectrum, false);
        assert.equal(restored.nagScale, 15);
        assert.equal(restored.detailerStrength, 0.6);
        assert.equal(restored.videoTask, 'head-swap');
        assert.equal(restored.headSwapBackend, 'facefusion');
        assert.equal(restored.headSwapFaceEnhancer, true);
        assert.equal(restored.headSwapLoraStrength, 1.2);
        assert.deepEqual(restored.cameraMotionIds, ['dolly-in', 'roll-cw']);
        assert.equal(restored.restylePresetId, 'anime-2d');
        // Defaults stay defaults (undefined = "the workflow's own"), so a save
        // from before these fields existed changes nothing.
        const plain = logic.applyRestoredPreferences(initial, logic.normalizeVideoPreferences({ modelId: H3.id }), catalogs);
        assert.equal(plain.spectrum, undefined);
        assert.equal(plain.nagScale, undefined);
        assert.equal(plain.videoTask, undefined);

        // The Style chip reads its id back out of the prompt — the phrase comes
        // back with the prompt (encrypted), the id with the settings (plain),
        // and the studio reconciles them at hydration.
        const { applyRestylePrompt } = await import('../src/lib/h3RestylePresets.js');
        const { prompt } = applyRestylePrompt('A quiet street.', null, 'anime-2d');
        assert.equal(logic.restylePresetIdInPrompt(prompt), 'anime-2d');
        assert.equal(logic.restylePresetIdInPrompt('A quiet street.'), null);
        assert.match(studio, /const cameraIds = cameraMotionIdsInPrompt\(restoredPrompt\);/);
        assert.match(studio, /const restyleId = restylePresetIdInPrompt\(restoredPrompt\);/);
    } finally {
        restore();
    }
});
