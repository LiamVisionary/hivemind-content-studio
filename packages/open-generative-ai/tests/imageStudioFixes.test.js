// Image studio fix-phase coverage: the pure helpers the studio now renders and
// restores from (imagePrefs.js), the reference picker's admission rules, the
// hosted bridge's cancel/resume contract, and the source-shape guarantees the
// audit findings turned into (Start fresh clears the draft, Cancel is honest,
// dead cloud controls are hidden, the roles block follows the reference count).
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
    // No ghost Cancel inside the progress card; a danger Cancel beside Generate
    // (the composer is its own module now).
    assert.doesNotMatch(studio, /variant="ghost" onClick=\{cancel/);
    assert.match(studio, /onCancel=\{cancelGeneration\}/);
    const composer = read('src/studios/image/ImageComposer.jsx');
    assert.match(composer, /<Button\s+variant="danger"\s+size="lg"\s+onClick=\{onCancel\}/);
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
    assert.match(panel, /\{s\.useLocalModel \? \(\s*<Field label="How many"/);
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

/* ---------------- failure surface, composer row, misc ---------------- */

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

test('the composer keeps the chips wrapping and Generate pinned in its own group', () => {
    const studio = read('src/studios/ImageStudio.jsx');
    const composer = read('src/studios/image/ImageComposer.jsx');
    assert.match(composer, /<div className="flex items-end gap-2">\s*<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">/);
    assert.match(composer, /<div className="ml-auto flex shrink-0 items-center gap-2">/);
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
