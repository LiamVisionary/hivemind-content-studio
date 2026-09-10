// Image studio fix-phase coverage: the pure helpers the studio now renders and
// restores from (imagePrefs.js), the reference picker's admission rules, the
// hosted bridge's cancel/resume contract, and the source-shape guarantees the
// audit findings turned into (Start fresh clears the draft, Cancel is honest,
// dead cloud controls are hidden, the roles block follows the reference count).
//
// Deliberately textual: these pin the studio's WIRING — what a cancel tears
// down, what a captured context carries, which handler a re-render commits —
// none of which a single static render can observe. What the Image studio
// SHOWS is rendered in imageTiering.test.js and pagesSmoke.test.js.
//
// 2026-09-10 — the route's presentation was replaced whole (StudioLayout's
// settings column became StudioFrame's Advanced drawer; the chip toolbar became
// a recipe sentence plus round doors). The wiring below did not move, so only
// the two assertions that named the old markup were re-pointed: Cancel is the
// composer's ComposerSecondary, and the "one primary, pinned right" shape is
// now drawn by frame/ComposerPanel.jsx and asserted there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const prefs = () => import('../src/studios/image/imagePrefs.js');

/* ---------------- seed parsing ---------------- */

test('seed input: 0 is an explicit seed, blanks and junk mean random', async () => {
    const { parseSeedInput } = await prefs();
    assert.equal(parseSeedInput('0'), 0, 'a typed 0 used to read as random (parseInt || -1)');
    assert.equal(parseSeedInput('42'), 42);
    assert.equal(parseSeedInput(' 7 '), 7);
    assert.equal(parseSeedInput(''), -1);
    assert.equal(parseSeedInput('abc'), -1);
    assert.equal(parseSeedInput('-5'), -1);
    assert.equal(parseSeedInput('1.5'), -1);
    assert.equal(parseSeedInput(null), -1);
});

/* ---------------- restore sizing ---------------- */

test('a restored local run keeps the local model\'s reference slots, not the cloud model\'s', async () => {
    const { restoredReferenceLimit } = await prefs();
    // Local Klein (4 slots) restored while the cloud selection is nano-banana (1).
    assert.equal(restoredReferenceLimit({
        imageMode: true, useLocalModel: true, localModel: { maxReferenceImages: 4 }, cloudLimit: 1, referenceCount: 3,
    }), 4);
    // Cloud run: the i2i slot count.
    assert.equal(restoredReferenceLimit({ imageMode: true, useLocalModel: false, cloudLimit: 10, referenceCount: 3 }), 10);
    // No references in the run at all: one slot.
    assert.equal(restoredReferenceLimit({ imageMode: false, useLocalModel: true, localModel: { maxReferenceImages: 4 }, referenceCount: 0 }), 1);
    // Local model not discovered yet: fail open to what was captured.
    assert.equal(restoredReferenceLimit({ imageMode: true, useLocalModel: true, localModel: null, referenceCount: 3 }), 3);
    assert.equal(restoredReferenceLimit({ imageMode: true, useLocalModel: true, localModel: null, referenceCount: 0 }), 1);
});

test('restoreImageContext sizes the reference slice off the model that ran it', () => {
    const studio = read('src/studios/ImageStudio.jsx');
    assert.match(studio, /const maxRefs = restoredReferenceLimit\(\{[\s\S]*?useLocalModel: s\.useLocalModel,[\s\S]*?localModel: s\.useLocalModel \? localModelById\(s\.selectedLocalModel\) : null,[\s\S]*?cloudLimit: s\.useLocalModel \? 1 : getMaxImagesForI2IModel\(s\.selectedModel\)/);
    assert.doesNotMatch(studio, /const maxRefs = s\.imageMode \? getMaxImagesForI2IModel\(s\.selectedModel\) : 1;/);
});

/* ---------------- context capture/restore ---------------- */

test('the captured context carries sampler, scheduler, resolution and the couple fields both ways', () => {
    const studio = read('src/studios/ImageStudio.jsx');
    const capture = studio.match(/const captureImageContext = \(prompt\) => \(\{[\s\S]*?\n  \}\);/)[0];
    const restore = studio.match(/const restoreImageContext = \(context\) => \{[\s\S]*?\n  \};/)[0];
    for (const field of ['sampler', 'scheduler', 'baseSize', 'coupleMode', 'coupleDirection', 'coupleSplit', 'couplePair', 'coupleShared', 'coupleA', 'coupleB']) {
        assert.match(capture, new RegExp(`\\b${field}: s\\.${field}`), `captures ${field}`);
        assert.match(restore, new RegExp(`s\\.${field} = `), `restores ${field}`);
    }
    // `??` keeps a pre-fields context from wiping current values, but restores an explicit false.
    assert.match(restore, /s\.coupleMode = context\.coupleMode \?\? s\.coupleMode;/);
});

/* ---------------- Start fresh ---------------- */

test('Start fresh resets the session-bound fields and nothing about the model', async () => {
    const { startFreshPatch } = await prefs();
    const patch = startFreshPatch();
    assert.equal(patch.prompt, '');
    assert.deepEqual(patch.uploadedImageUrls, []);
    assert.deepEqual(patch.referenceRoles, []);
    assert.deepEqual(patch.regions, []);
    assert.equal(patch.coupleA, '');
    assert.equal(patch.coupleB, '');
    assert.equal(patch.coupleShared, '');
    assert.equal(patch.enhancerOpen, false);
    assert.ok(patch.enhanceTags instanceof Set && patch.enhanceTags.size === 0);
    assert.equal(patch.generateError, '');
    assert.equal(patch.viewerUrl, null);
    // Fresh means a blank canvas, not a different workflow or source.
    for (const kept of ['selectedModel', 'selectedLocalModel', 'useLocalModel', 'selectedAr', 'steps', 'coupleMode', 'regionMode']) {
        assert.equal(kept in patch, false, `${kept} is untouched`);
    }
    // Two calls never share the Set.
    assert.notEqual(startFreshPatch().enhanceTags, patch.enhanceTags);
});

test('Start fresh clears the encrypted composer draft and keeps the cloud model', () => {
    const studio = read('src/studios/ImageStudio.jsx');
    const fresh = studio.match(/const newPrompt = \(\) => \{[\s\S]*?\n  \};/)[0];
    assert.match(fresh, /Object\.assign\(s, startFreshPatch\(\)\)/);
    // Through the draft writers — a bare `s.prompt = ''` left the old draft to be restored on reload.
    assert.match(fresh, /setPromptValue\(''\)/);
    assert.match(fresh, /updateComposerDraft\(\{ references: \[\] \}\)/);
    // The cloud model selection is left alone (it used to snap to t2iModels[0], even on the Local source).
    assert.doesNotMatch(fresh, /s\.selectedModel = t2iModels\[0\]/);
    assert.doesNotMatch(fresh, /s\.selectedAr = /);
});

test('startFreshSummary names what is on screen, and nothing that is not', async () => {
    const { startFreshSummary, startFreshPatch } = await prefs();
    // A blank composer has nothing to lose — which is what lets the studio skip
    // the dialog entirely rather than asking about an empty list.
    assert.deepEqual(startFreshSummary({}), []);
    assert.deepEqual(startFreshSummary({ prompt: '   ', uploadedImageUrls: [], regions: [] }), []);
    assert.deepEqual(startFreshSummary(startFreshPatch()), [], 'and the patch itself lands on an empty summary');
    assert.deepEqual(startFreshSummary({ prompt: 'a cat' }), ['what you typed']);
    assert.deepEqual(startFreshSummary({ uploadedImageUrls: ['/a.png'] }), ['1 attached picture']);
    assert.deepEqual(startFreshSummary({ uploadedImageUrls: ['/a.png', '/b.png'] }), ['2 attached pictures']);
    assert.deepEqual(startFreshSummary({ regions: [{}] }), ['1 region box']);
    assert.deepEqual(startFreshSummary({ regions: [{}, {}] }), ['2 region boxes']);
    assert.deepEqual(startFreshSummary({ coupleA: 'her' }), ['the couple character text']);
    assert.deepEqual(
        startFreshSummary({ prompt: 'a cat', uploadedImageUrls: ['/a.png'], regions: [{}, {}], coupleShared: 'x' }),
        ['what you typed', '1 attached picture', '2 region boxes', 'the couple character text'],
    );
});

// The dialog and the patch have to name the same things, and they are written in
// two places (imagePrefs.js and the modal's body). What holds them together is
// that the body is BUILT from the summary — so this pins that, not the wording.
test('Start fresh asks before it clears, off the same engine the patch empties', () => {
    const studio = read('src/studios/ImageStudio.jsx');
    const request = studio.match(/const requestNewPrompt = \(\) => \{[\s\S]*?\n  \};/)[0];
    assert.match(request, /if \(!startFreshSummary\(s\)\.length\) \{ newPrompt\(\); return; \}/,
        'nothing to lose means nothing to ask');
    assert.match(request, /s\.startFreshConfirm = true;/);
    // The composer's door opens the question, not the act.
    assert.match(studio, /onNewPrompt=\{requestNewPrompt\}/);
    assert.doesNotMatch(studio, /onNewPrompt=\{newPrompt\}/, 'the raw handler is never wired to a press');
    // The dialog lists the summary rather than a hand-typed copy of it.
    const dialog = studio.slice(studio.indexOf('{s.startFreshConfirm ? ('), studio.indexOf('{s.cloudRefConfirm ? ('));
    assert.match(dialog, /startFreshSummary\(s\)\.map\(/);
    assert.match(dialog, /title=\{t\('common\.startFreshTitle'\)\}/);
    assert.match(dialog, /confirmLabel=\{t\('common\.startFresh'\)\}/);
    assert.match(dialog, /cancelLabel=\{t\('common\.keepWhatIHave'\)\}/);
    assert.match(dialog, /tone="primary"/, 'nothing is deleted — the gallery keeps every picture');
    assert.match(dialog, /onConfirm=\{newPrompt\}/);
    // And the act closes its own dialog, so a second press cannot re-run it.
    assert.match(studio.match(/const newPrompt = \(\) => \{[\s\S]*?\n  \};/)[0], /s\.startFreshConfirm = false;/);
});

/* ---------------- clear the prompt, and only the prompt ---------------- */

// The badge in the box's corner. It exists because Start fresh was being pressed
// by people who wanted an empty prompt and got an empty composer.
test('the prompt badge clears the prompt alone, with an Undo and no dialog', () => {
    const studio = read('src/studios/ImageStudio.jsx');
    const clear = studio.match(/const clearPromptOnly = \(\) => \{[\s\S]*?\n  \};/)[0];
    // Through the draft writer, so the encrypted composer forgets it too.
    assert.match(clear, /setPromptValue\(''\)/);
    // One field: nothing about the references, the model or the settings.
    assert.doesNotMatch(clear, /startFreshPatch|uploadedImageUrls|selectedModel|contextStore/);
    assert.doesNotMatch(clear, /startFreshConfirm/, 'a one-field change asks nothing');
    assert.match(clear, /setPromptValue\(before\)/, 'and it is offered back');
    assert.match(studio, /onClearPrompt=\{clearPromptOnly\}/);

    // The composer hands it to the box, which draws the badge.
    const composer = read('src/studios/image/ImageComposer.jsx');
    assert.match(composer, /<ComposerPrompt[\s\S]*?onClear=\{onClearPrompt\}/);
    const panel = read('src/studios/frame/ComposerPanel.jsx');
    assert.match(panel, /const clearable = Boolean\(onClear\) && !disabled && Boolean\(String\(value \|\| ''\)\.trim\(\)\)/,
        'no badge on an empty box, and none on a box that cannot be typed in');
    assert.match(panel, /clearable && 'pr-8'/, 'the text makes room for it');
    assert.match(panel, /aria-label=\{t\('composer\.clearPrompt'\)\}/);
});

/* ---------------- reference roles follow the count ---------------- */

test('a prompt with no roles and no block is left alone; held roles or a block trigger a rewrite', async () => {
    const { referenceRolesNeedRewrite } = await prefs();
    const { OWNERSHIP_HEADING } = await import('../src/lib/imageReferenceRoles.js');
    assert.equal(referenceRolesNeedRewrite('a cat on a roof\n\n', [], OWNERSHIP_HEADING), false);
    assert.equal(referenceRolesNeedRewrite('a cat', [{ role: 'wardrobe', note: '' }], OWNERSHIP_HEADING), true);
    assert.equal(referenceRolesNeedRewrite(`a cat\n\n${OWNERSHIP_HEADING}\n- Picture 1 supplies…`, [], OWNERSHIP_HEADING), true);
});

test('removing or adding references re-applies the roles block at the new count', async () => {
    const { applyReferenceRoles, normalizeReferenceRoles } = await import('../src/lib/imageReferenceRoles.js');
    const roles = [{ role: 'identity', note: '' }, { role: 'wardrobe', note: '' }, { role: 'environment', note: '' }];
    const withThree = applyReferenceRoles('a portrait', roles, 3, { labelStyle: 'h3' });
    assert.match(withThree, /Picture 3/);
    // Down to two pictures: the third clause goes.
    const withTwo = applyReferenceRoles(withThree, normalizeReferenceRoles(roles, 2), 2, { labelStyle: 'h3' });
    assert.doesNotMatch(withTwo, /Picture 3/);
    assert.match(withTwo, /Picture 2/);
    // Down to none: the block goes entirely.
    const withNone = applyReferenceRoles(withTwo, normalizeReferenceRoles(roles, 0), 0);
    assert.equal(withNone, 'a portrait');

    const studio = read('src/studios/ImageStudio.jsx');
    const sync = studio.match(/const syncRolesToReferenceCount = \(\) => \{[\s\S]*?\n  \};/)[0];
    assert.match(sync, /applyRoles\(normalizeReferenceRoles\(s\.referenceRoles, s\.uploadedImageUrls\.length\)\)/);
    const selected = studio.match(/const handleReferencesSelected = \(urls\) => \{[\s\S]*?\n  \};/)[0];
    const cleared = studio.match(/const clearReferences = \(\) => \{[\s\S]*?\n  \};/)[0];
    assert.match(selected, /syncRolesToReferenceCount\(\)/);
    assert.match(cleared, /syncRolesToReferenceCount\(\)/);
    // Attaching/removing no longer resets the aspect ratio or reloads the LoRA catalog.
    assert.doesNotMatch(selected, /s\.selectedAr = /);
    assert.doesNotMatch(cleared, /s\.selectedAr = /);
    assert.doesNotMatch(selected, /loadLorasForCurrentModel/);
    assert.doesNotMatch(cleared, /loadLorasForCurrentModel/);
});

/* ---------------- cancel lifecycle ---------------- */

test('cancel flags the run, tears down the timer and listener, and the late result is ignored', () => {
    const studio = read('src/studios/ImageStudio.jsx');
    const cancel = studio.match(/const cancelGeneration = \(\) => \{[\s\S]*?\n  \};/)[0];
    assert.match(cancel, /run\.cancelled = true/);
    assert.match(cancel, /finishImageProgress\(false\)/, 'the 300 ms progress timer is cleared on cancel');
    assert.match(cancel, /run\.unsub\(\)/, 'the progress listener is released on cancel');
    assert.match(cancel, /window\.localAI\.cancelGeneration\(run\.jobId\)/, 'the hosted bridge stops polling that job by id');
    assert.match(cancel, /toast\('Generation cancelled\.'\)/);
    assert.doesNotMatch(cancel, /toast\.error/);
    // The local continuation checks the flag before history / viewer / chime…
    assert.match(studio, /if \(run\.cancelled\) break;\n\s+if \(run\.jobId\) \{ removePendingJob\(run\.jobId\); run\.jobId = null; \}/);
    assert.match(studio, /if \(run\.cancelled\) return;\n\s+unsub\(\);\n\s+s\.localProgress = \{ active: false, pct: 0, label: '' \};\n\s+finishImageProgress\(true\);/);
    // …and a cancelled rejection is not an error.
    assert.match(studio, /if \(run\.cancelled \|\| e\?\.cancelled\) return;/);
    // No ghost Cancel anywhere: interrupting a paid render is not a quiet
    // action. There are two doors onto it since the frame replaced the settings
    // column — the composer's, beside Generate, and the stage's, on the
    // progress readout that replaced GenerationProgressCard — and BOTH go
    // through this one handler, so a cancel is a cancel either way.
    assert.doesNotMatch(studio, /variant="ghost" onClick=\{cancel/);
    assert.equal(
        (studio.match(/onCancel=\{cancelGeneration\}/g) || []).length,
        2,
        'the composer and the stage both cancel through the one handler',
    );
    // In the composer, Cancel is the SECONDARY — it can never take the one
    // primary press's place — and it only exists while a run is out.
    const composer = read('src/studios/image/ImageComposer.jsx');
    assert.match(composer, /secondary=\{s\.generating \? \(\s*<ComposerSecondary onClick=\{onCancel\}/);
    assert.equal((composer.match(/<ComposerSecondary\b/g) || []).length, 1, 'one Cancel, not one per state');
    assert.doesNotMatch(composer, /<ComposerPrimary[^>]*onClick=\{onCancel\}/, 'Cancel is never the primary');
});

test('local generations save a pending job by the hosted bridge\'s job id and resume through it', () => {
    const studio = read('src/studios/ImageStudio.jsx');
    assert.match(studio, /const onJobId = window\.localAI\?\.isHosted \? \(jobId\) => \{[\s\S]*?savePendingJob\(\{\s*requestId: jobId, studioType: 'image', kind: 'hosted-local', historyMeta, tabId: tabIdRef\.current,/);
    assert.match(studio, /const canResumeLocal = Boolean\(window\.localAI\?\.isHosted\) && typeof window\.localAI\?\.resumeGeneration === 'function'/);
    assert.match(studio, /await window\.localAI\.resumeGeneration\(job\.requestId\)/);
    // The prompt is never written into the pending job record.
    const save = studio.match(/savePendingJob\(\{\s*requestId: jobId, studioType: 'image', kind: 'hosted-local'[\s\S]*?\}\);/)[0];
    assert.doesNotMatch(save, /prompt/);
});

/* ---------------- hosted bridge: onJobId / cancel / resume ---------------- */

function loadBridge({ onFetch }) {
    const shim = read('public/hosted-local-ai.js');
    const window = { location: { search: '', pathname: '/' }, parent: null };
    window.parent = window;
    const context = {
        window,
        URLSearchParams,
        // Poll sleeps collapse to a tick so the test runs in milliseconds.
        setTimeout: (fn) => setImmediate(fn),
        fetch: onFetch,
        encodeURIComponent,
        console,
    };
    vm.runInNewContext(shim, context);
    return window.localAI;
}

const jsonResponse = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test('hosted bridge: generate hands back the job id, cancel by id stops the poll with a cancelled rejection', async () => {
    let polls = 0;
    let cancelAfter = null;
    const bridge = loadBridge({
        onFetch: async (url, options = {}) => {
            if (url.endsWith('/local-ai/generate') && options.method === 'POST') {
                // The callback must never reach the wire.
                assert.doesNotMatch(String(options.body), /onJobId/);
                return jsonResponse({ id: 'job-1' });
            }
            if (url.endsWith('/local-ai/job/job-1')) {
                polls += 1;
                if (cancelAfter && polls >= cancelAfter.at) cancelAfter.fn();
                return jsonResponse({ status: 'running' });
            }
            throw new Error(`unexpected ${url}`);
        },
    });
    let seenJobId = null;
    cancelAfter = { at: 3, fn: () => { void bridge.cancelGeneration(seenJobId); } };
    await assert.rejects(
        bridge.generate({ model: 'x', prompt: 'p', onJobId: (id) => { seenJobId = id; } }),
        (e) => e && e.cancelled === true && /cancelled/i.test(e.message),
    );
    assert.equal(seenJobId, 'job-1');
    const pollsAtCancel = polls;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(polls, pollsAtCancel, 'polling stops once cancelled');
});

test('hosted bridge: cancel without an id stays a no-op, and resume polls an existing job to its result', async () => {
    let polls = 0;
    const bridge = loadBridge({
        onFetch: async (url) => {
            if (url.endsWith('/local-ai/job/job-9')) {
                polls += 1;
                return polls < 3
                    ? jsonResponse({ status: 'running' })
                    : jsonResponse({ status: 'success', url: 'data:image/png;base64,AAA', seed: 7 });
            }
            throw new Error(`unexpected ${url}`);
        },
    });
    // A global (no-id) cancel — what the Video studio fires as a best-effort
    // interrupt — must not tear down this poll.
    // (Field-wise: the values come from another vm realm, so strict deepEqual
    // would fail on prototypes alone.)
    const cancelled = await bridge.cancelGeneration();
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.cancelled.length, 0);
    const result = await bridge.resumeGeneration('job-9');
    assert.equal(result.url, 'data:image/png;base64,AAA');
    assert.equal(result.seed, 7);
    assert.equal(polls, 3);
});

/* ---------------- UploadPicker admission rules ---------------- */

function loadPickerRules() {
    const source = read('src/studios/UploadPicker.jsx');
    const start = source.indexOf('const KIND_EXTENSIONS');
    const end = source.indexOf('const KIND_NOUN');
    assert.ok(start > 0 && end > start, 'the admission helpers sit between KIND_EXTENSIONS and KIND_NOUN');
    const body = source.slice(start, end).replace(/^export /gm, '');
    return new Function(`${body}; return { acceptKind, fileMatchesAccept, fileTooLarge, UPLOAD_LIMIT_MB };`)();
}

test('the picker admits by MIME, falls back to the extension, and refuses oversize files with the server\'s limits', () => {
    const { acceptKind, fileMatchesAccept, fileTooLarge, UPLOAD_LIMIT_MB } = loadPickerRules();
    assert.equal(acceptKind('image/*'), 'image');
    assert.equal(acceptKind('video/*'), 'video');
    assert.equal(acceptKind('*/*'), '');
    // MIME wins when present.
    assert.equal(fileMatchesAccept({ type: 'image/png', name: 'a.png' }, 'image/*'), true);
    assert.equal(fileMatchesAccept({ type: 'video/mp4', name: 'a.mp4' }, 'image/*'), false);
    // Empty MIME (HEIC/AVIF out of some browsers): the extension decides.
    assert.equal(fileMatchesAccept({ type: '', name: 'IMG_0001.HEIC' }, 'image/*'), true);
    assert.equal(fileMatchesAccept({ type: '', name: 'photo.avif' }, 'image/*'), true);
    assert.equal(fileMatchesAccept({ type: '', name: 'scan.tif' }, 'image/*'), true);
    assert.equal(fileMatchesAccept({ type: '', name: 'notes.txt' }, 'image/*'), false);
    assert.equal(fileMatchesAccept({ type: '', name: 'clip.mov' }, 'video/*'), true);
    assert.equal(fileMatchesAccept({ type: '', name: 'anything.bin' }, '*/*'), true);
    // Size ceilings mirror control_api.py: 32 MB images (audio shares it), 100 MB video.
    assert.deepEqual(UPLOAD_LIMIT_MB, { image: 32, video: 100, audio: 32 });
    assert.equal(fileTooLarge({ size: 32 * 1024 * 1024 }, 'image/*'), 0);
    assert.equal(fileTooLarge({ size: 32 * 1024 * 1024 + 1 }, 'image/*'), 32);
    assert.equal(fileTooLarge({ size: 90 * 1024 * 1024 }, 'video/*'), 0);
    assert.equal(fileTooLarge({ size: 101 * 1024 * 1024 }, 'video/*'), 100);
});

test('deleting a recent reference asks first, and the drag state is depth-counted', () => {
    const picker = read('src/studios/UploadPicker.jsx');
    assert.match(picker, /<ConfirmModal[\s\S]*?title="Delete this reference\?"[\s\S]*?body="It is removed from this browser and from the studio's saved references\."/);
    // The X opens the confirm; only the confirm deletes.
    assert.match(picker, /setDeleteEntry\(entry\);/);
    assert.match(picker, /onConfirm=\{\(\) => \{\s*deleteHistoryEntry\(deleteEntry\);/);
    assert.match(picker, /const dragDepthRef = useRef\(0\)/);
    assert.match(picker, /onDragEnter=\{onDragEnter\}/);
    // Refusals are said out loud.
    assert.match(picker, /Only \$\{noun\} can be attached here/);
    assert.match(picker, /larger than the \$\{limitMb\} MB limit/);
});

/* ---------------- dead cloud controls, seed, first-run source ---------------- */

test('on the cloud source the inert Advanced controls are hidden and the seed rides on the request', () => {
    const studio = read('src/studios/ImageStudio.jsx');
    const panel = read('src/studios/image/ImageSettingsPanel.jsx');
    // Steps / guidance / how-many / negative are local-only now.
    assert.match(panel, /\{s\.useLocalModel \? \(\s*<Field label=\{t\('image\.steps'\)\}/);
    assert.match(panel, /\{s\.useLocalModel \? \(\s*<Field label=\{t\('image\.guidanceScale'\)\}/);
    assert.match(panel, /\{s\.useLocalModel \? \(\s*<Field label=\{t\('imagePanel\.howMany'\)\}/);
    assert.match(panel, /\{s\.useLocalModel && supportsNegativePrompt \? \(/);
    // The reference-strength slider is gone, and so is the dead value behind it.
    assert.doesNotMatch(panel, /t\('image\.refStrength'\)/);
    assert.doesNotMatch(studio, /referenceStrength/);
    // Seed reaches both cloud requests; the seed field parses 0 as a seed.
    assert.match(studio, /const seed = \(typeof s\.seed === 'number' && s\.seed >= 0\) \? s\.seed : -1;/);
    const cloud = studio.match(/\/\/ ── Remote API path[\s\S]*?const generate = \(\)/)[0];
    assert.equal((cloud.match(/\n\s+seed,\n/g) || []).length, 2, 'seed is in both the i2i and t2i genParams');
    assert.match(panel, /s\.seed = parseSeedInput\(e\.target\.value\)/);
});

test('with no saved preference the studio boots on the Local source when local models exist', () => {
    const studio = read('src/studios/ImageStudio.jsx');
    assert.match(studio, /const useLocalModel = persistedImagePreferences\s*\? Boolean\(persistedImagePreferences\.useLocalModel && isLocalAIAvailable\(\)\)\s*: Boolean\(isHivemindStudioEnabled\(\) && isLocalAIAvailable\(\)\);/);
});

/* ---------------- failure surface, composer action row, misc ---------------- */

test('a failed generation leaves ONE callout — described, with its remedy — and no toast beside it', () => {
    const studio = read('src/studios/ImageStudio.jsx');
    // Both generation paths hand the error to describeFailure rather than
    // pasting the provider's words into two places at once.
    assert.match(studio, /failGeneration\(e, 'local'\);/);
    assert.match(studio, /failGeneration\(e, 'muapi'\);/);
    assert.doesNotMatch(studio, /toast\.error\(s\.generateError\)/);
    assert.doesNotMatch(studio, /console\.error\('\[Local\] generation error:', e\)/);
    assert.doesNotMatch(studio, /console\.error\(e\);/);
    // The callout is the shared primitive, and its remedy button is wired to a
    // mechanism this studio actually has.
    assert.match(studio, /\{s\.generateError \? \(\s*<FailureCallout/);
    assert.match(studio, /remedy=\{s\.generateFailure\?\.remedy \|\| null\}/);
    assert.match(studio, /onRemedy=\{\(remedy\) => void runFailureRemedy\(remedy, \{/);
    assert.match(studio, /onLowerResolution: lowerResolution,/);
    assert.match(studio, /retryLabel="Try again"/);
});

test('the composer keeps its doors on the left and Generate pinned in its own group', () => {
    const studio = read('src/studios/ImageStudio.jsx');
    const composer = read('src/studios/image/ImageComposer.jsx');
    // ONE primary, pinned right, never wrapped under the doors. The action row
    // belongs to the frame now, so the shape is pinned where it is drawn: the
    // doors flow first, then a single `ml-auto` group holding the eta, Cancel
    // and Generate in that order. Generate cannot wrap under the doors because
    // it is not in the same flex group as them.
    const panel = read('src/studios/frame/ComposerPanel.jsx');
    assert.match(
        panel,
        /<div className="flex items-center gap-2">\s*\{tools\}\s*<div className="ml-auto flex min-w-0 items-center gap-\[15px\]">\s*\{meta\}\s*\{secondary\}\s*\{primary\}\s*<\/div>/,
        'the action row is tools, then one right-hand group',
    );
    // …and the Image composer puts exactly one press in that group, and none
    // among the doors. (imageTiering renders this and checks it holds.)
    assert.equal((composer.match(/<ComposerPrimary\b/g) || []).length, 1, 'one primary press');
    assert.match(composer, /primary=\{\(\s*<ComposerPrimary/);
    const tools = composer.slice(composer.indexOf('const tools = ('), composer.indexOf('\n  return ('));
    assert.ok(tools.length > 0, 'the doors are still declared');
    assert.doesNotMatch(tools, /<ComposerPrimary|<ComposerSecondary/, 'the press is not one of the doors');
    // Every icon-only door carries its name: ComposerTool draws no label, so
    // the aria-label is the only name a screen reader gets.
    for (const door of composer.match(/<ComposerTool[\s\S]{0,240}?\/>/g) || []) {
        assert.match(door, /\n\s+label=/, 'an icon-only door with no name');
    }
    // The app helper lives inside the one "Improve" menu now.
    assert.match(composer, /label=\{t\('composer\.improve'\)\}/);
    assert.doesNotMatch(composer, /className="border-honey\/40 text-honey"/);
    // The progress card carries the bridge status; the button just says Generating.
    assert.match(studio, /const generateLabel = s\.generating \? t\('common\.generating'\) : t\('common\.generate'\);/);
    // Cmd/Ctrl+Enter generates.
    assert.match(composer, /if \(\(e\.metaKey \|\| e\.ctrlKey\) && e\.key === 'Enter'\)/);
    // The placeholder no longer carries a dead fallback; the key exists.
    assert.match(studio, /`\$\{refCount\} \$\{t\('image\.multiImageNote'\)\}`/);
    const i18n = read('src/lib/i18n.js');
    assert.match(i18n, /'image\.multiImageNote':/);
});

test('the viewer walks the gallery and formats Created; gallery tiles contain rather than crop', async () => {
    const gallery = read('src/studios/image/GalleryAndViewer.jsx');
    assert.match(gallery, /onPrev, onNext, position = null/);
    assert.match(gallery, /e\.key === 'ArrowLeft' && hasPrev/);
    assert.match(gallery, /className="aspect-square w-full bg-bg3 object-contain"/);
    assert.match(gallery, /group-focus-within:opacity-100/);
    assert.doesNotMatch(gallery, /<MetaRow label="Id"/);
    const { formatCreated, activatesCard } = await import('../src/studios/image/GalleryAndViewer.jsx').catch(() => ({}));
    if (formatCreated) {
        assert.equal(formatCreated(''), '');
        assert.equal(formatCreated('not a date'), 'not a date');
        assert.equal(activatesCard(' '), true);
    }
    const studio = read('src/studios/ImageStudio.jsx');
    assert.match(studio, /onPrev=\{viewerIndex > 0 \? \(\) => viewImage\(s\.history\[viewerIndex - 1\]\.url\) : undefined\}/);
});

test('the compare viewer only answers Escape when it is the topmost dialog, and zooms with a non-passive wheel listener', () => {
    const compare = read('src/studios/image/CompareViewer.jsx');
    assert.match(compare, /const isTopmostDialog = \(\) => \{[\s\S]*?top === rootRef\.current/);
    assert.match(compare, /if \(!isTopmostDialog\(\)\) return;\n\s+if \(e\.key === 'Escape'\)/);
    assert.match(compare, /el\.addEventListener\('wheel', handler, \{ passive: false \}\)/);
    assert.doesNotMatch(compare, /onWheel=\{/);
    assert.doesNotMatch(compare, /text-bg0/);
    assert.match(compare, /<Segmented[\s\S]*?\{ value: 'reveal', label: 'Reveal' \}/);
    assert.match(compare, /title="Zoom out \(−\)"/);
});

test('the mask editor and the edit dialogs use kit fields', () => {
    const mask = read('src/studios/image/MaskEditorDialog.jsx');
    assert.doesNotMatch(mask, /<input type="range"/);
    assert.doesNotMatch(mask, /<textarea/);
    assert.match(mask, /<Field label="Brush">\s*<Slider/);
    assert.match(mask, /<Field label="What should appear there\?">\s*<TextArea/);
    for (const file of ['ExpandDialog', 'AngleVariationsDialog', 'SequenceEditDialog']) {
        const source = read(`src/studios/image/${file}.jsx`);
        assert.doesNotMatch(source, /<textarea/, `${file} uses the kit TextArea`);
        assert.match(source, /<TextArea/, `${file} uses the kit TextArea`);
    }
    const roles = read('src/studios/image/ReferenceRolesMenu.jsx');
    assert.match(roles, /<Button\s+size="sm"\s+variant="primary"/);
});

test('duplicating a tab carries the reference roles, UGC counters and the open Custom tile', async () => {
    const { IMAGE_TAB_FIELDS } = await import('../src/lib/studioTabs.js');
    for (const field of ['referenceRoles', 'ugcVariantIndex', 'ugcRoomIndex', 'customArOpen']) {
        assert.ok(IMAGE_TAB_FIELDS.includes(field), `${field} is a tab field`);
    }
});

test('every finished picture carries how long it took, and the tile and viewer show it', async () => {
    // 2026-09-07: the number a person compares across tiles while choosing
    // settings. Stamped where each render's await sits (a batch shot on its
    // own clock, a resumed job from its true submit time), never on entries
    // from before this existed — those simply show no chip.
    const gallery = read('src/studios/image/GalleryAndViewer.jsx');
    assert.match(gallery, /formatTook\(entry\.generationMs\) \? \(/, 'the tile has the chip');
    assert.match(gallery, /title=\{t\('image\.generationTime'\)\}/);
    assert.match(gallery, /<MetaRow label="Took" value=\{formatTook\(entry\?\.generationMs\)\} \/>/);
    assert.match(read('src/lib/i18n.js'), /'image\.generationTime':/);
    const { formatTook } = await import('../src/studios/image/GalleryAndViewer.jsx').catch(() => ({}));
    if (formatTook) {
        assert.equal(formatTook(undefined), '', 'an older entry has nothing to show');
        assert.equal(formatTook(0), '');
        assert.equal(formatTook(4180), '4.2s');
        assert.equal(formatTook(37400), '37s');
        assert.equal(formatTook(125000), '2m 05s');
    }
    const studio = read('src/studios/ImageStudio.jsx');
    assert.match(studio, /const shotStartedAt = Date\.now\(\);\n\s+const res = await runImage\(/, 'each batch shot is timed alone');
    assert.match(studio, /\.\.\.tookSince\(shotStartedAt\),/);
    assert.match(studio, /\.\.\.tookSince\(s\.generationStartedAt\),/, 'a cloud render is timed from its submit');
    assert.match(studio, /\.\.\.tookSince\(live\.submittedAt\)/, 'a resumed job keeps its true start');
    assert.match(studio, /\.\.\.tookSince\(job\.submittedAt\)/);
    // The derived renders too: every one of them is a wait a person sat through.
    for (const prefix of ['upscale-', 'expand-', 'inpaint-', 'angle-', 'seq-']) {
        const at = studio.indexOf(`id: \`${prefix}`);
        assert.ok(at > 0, prefix);
        const block = studio.slice(at, studio.indexOf('});', at));
        assert.match(block, /\.\.\.tookSince\(tookFrom\),/, `${prefix} carries its time`);
    }
});
