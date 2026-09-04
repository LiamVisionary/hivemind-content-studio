// Reference / keyframe picker interaction rules.
//
// UploadPicker.jsx, FrameSlotsPicker.jsx, VideoStudio.jsx and videoLogic.js are
// JSX, which node:test cannot import, so these assert the shape of the source the
// same way the other studio tests do (see loraSelection.test.js). The behaviors
// themselves were verified in the browser against the running studio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('both pickers dismiss from a region that includes their trigger', () => {
    for (const file of ['src/studios/UploadPicker.jsx', 'src/studios/video/FrameSlotsPicker.jsx']) {
        const source = read(file);
        // The dismissable ref lands on the outer wrapper (which holds the trigger),
        // not on the floating panel: with it on the panel, the trigger's pointerdown
        // dismissed and its click re-opened, so the panel never closed from there.
        // It suspends while a full-size preview is up, or closing the preview
        // (scrim/Escape) would also tear down the panel underneath it — and
        // likewise while a delete confirm raised from the panel is up.
        assert.match(source, /const rootRef = useDismissable\(panelOpen && !preview\w+(?: && !\w+)*, \(\) => setPanelOpen\(false\)\)/, `${file} names the dismissable region rootRef`);
        assert.match(source, /ref=\{rootRef\}/, `${file} attaches it to the wrapper`);
        assert.doesNotMatch(source, /ref=\{panelRef\}/, `${file} no longer scopes dismissal to the panel alone`);
    }
});

test('a set frame or attached chip opens a full-size preview when pressed', () => {
    // Shared preview modal: full-resolution source resolved the same E2E-aware
    // way as Thumb (never the cached thumbnail).
    const upload = read('src/studios/UploadPicker.jsx');
    assert.match(upload, /export function ReferencePreview\(\{ url, name, onClose \}\)/);
    assert.match(upload, /onPreview=\{\(\) => setPreviewUrl\(url\)\}/, 'chip thumbnails open the preview');

    const frames = read('src/studios/video/FrameSlotsPicker.jsx');
    assert.match(frames, /onClick=\{\(\) => setPreviewSlotKey\(slot\.key\)\}/, 'set slot thumbnails open the preview');
    // Keyed by slot, not URL, so clearing the frame mid-view closes the preview.
    assert.match(frames, /\{previewSlot\?\.url \? \(/);
});

test('armed character references dim the frames picker instead of hiding it', () => {
    const studio = read('src/studios/VideoStudio.jsx');
    // Hiding the picker stranded an already-set start frame: nothing on screen
    // could change it or add the end frame until the references were cleared.
    assert.doesNotMatch(studio, /refsArmed \? null/);
    assert.match(studio, /inactiveNote=\{refsArmed/);
    assert.match(studio, /ignored=\{refsArmed\}/, 'the plain start-frame picker dims its chip too');

    const frames = read('src/studios/video/FrameSlotsPicker.jsx');
    assert.match(frames, /inactiveNote = ''/);
    // The note reaches both the trigger tooltip and the open panel.
    assert.match(frames, /inactiveNote \? ` — \$\{inactiveNote\}` : ''/);
    assert.match(frames, /\{inactiveNote \? \(/);
});

test('tapping the selected reference clears it instead of re-selecting', () => {
    const upload = read('src/studios/UploadPicker.jsx');
    // Single mode: an already-selected entry clears the selection and the panel
    // stays open so a replacement can be picked straight away.
    assert.match(upload, /if \(idx !== -1\) \{\s*\n\s*onChange\?\.\(\[\]\);\s*\n\s*return;/);
    assert.match(upload, /click to unselect/);

    const frames = read('src/studios/video/FrameSlotsPicker.jsx');
    assert.match(frames, /const inActiveSlot = activeSlot\?\.url === entry\.uploadedUrl/);
    assert.match(frames, /assign\(activeKey, inActiveSlot \? null : entry\.uploadedUrl\)/);
});

test('end-frame models get the combined slots picker, never twin icon buttons', () => {
    const upload = read('src/studios/UploadPicker.jsx');
    assert.match(upload, /keepOpenOnSelect = false/);
    assert.match(upload, /if \(!keepOpenOnSelect\) setPanelOpen\(false\)/);

    // FLF models (H3 FL2VA, remote first/last) render ONE FrameSlotsPicker with
    // Start/End rows — two compact single-image pickers side by side read as
    // identical unlabeled icon buttons.
    const studio = read('src/studios/VideoStudio.jsx');
    assert.match(studio, /endFrameVisible \? \(/);
    assert.match(studio, /\{ key: 'end', label: zh\(\) \? '结束帧（可选）' : 'End \(optional\)', url: s\.setup\.endImageUrl \}/);
    assert.doesNotMatch(studio, /keepOpenOnSelect=\{endFrameVisible\}/);
});

test('every reference kind rides one menu and routes to the reference workflow', () => {
    const studio = read('src/studios/VideoStudio.jsx');
    // The control shows whenever the family has a reference lane…
    assert.match(studio, /referenceWorkflowForHivemindModel\(s\.setup\.modelId\)/);
    assert.match(studio, /<ReferencesMenu/);
    // …sized from the slots the graph actually wired, never hardcoded…
    assert.match(studio, /images: referenceEntry\?\.referenceSlots\?\.images \|\| 9/);
    assert.match(studio, /videos: referenceEntry\?\.referenceSlots\?\.videos \|\| 3/);
    // …and attached refs reroute the submission to that workflow, all three kinds.
    assert.match(studio, /if \(plan\.sendReferenceImages\) \{/);
    assert.match(studio, /localParams\.referenceImages = \(setup\.referenceImageUrls \|\| \[\]\)\.filter\(Boolean\)/);
    assert.match(studio, /localParams\.referenceAudios = \(setup\.referenceAudios \|\| \[\]\)/);
    assert.match(studio, /localParams\.referenceVideos = \(setup\.referenceVideos \|\| \[\]\)/);

    // The plan is the single decision point: refs replace the start frame, and
    // a voice or motion clip arms the mode just as a picture does.
    const tasks = read('src/lib/videoTasks.js');
    assert.match(tasks, /sendImage: !setup\?\.videoUrl && !sendMotionContext && !sendReferenceImages/);
    assert.match(tasks, /'referenceImageUrls', 'referenceVideos', 'referenceAudios'/);
});

test('a start-frame pick that switches to a keyframe model opens that picker', () => {
    const frames = read('src/studios/video/FrameSlotsPicker.jsx');
    assert.match(frames, /useState\(autoOpen && !disabled\)/);

    const studio = read('src/studios/VideoStudio.jsx');
    assert.match(studio, /framesPanelAutoOpen: false/);
    assert.match(studio, /const hadFrameSlots = frameSlotsVisible\(s\.setup, s\.catalogs\)/);
    assert.match(studio, /if \(!hadFrameSlots && frameSlotsVisible\(setup, s\.catalogs\)\) \{\s*\n\s*s\.framesPanelAutoOpen = true;/);
    // Consumed at mount, then cleared so unrelated remounts don't pop it open.
    assert.match(studio, /useEffect\(\(\) => \{ s\.framesPanelAutoOpen = false; \}\)/);
    assert.match(studio, /autoOpen=\{s\.framesPanelAutoOpen\}/);
});

test('clearing the start frame keeps a local workflow selected', () => {
    const logic = read('src/studios/video/videoLogic.js');
    const cleared = logic.slice(logic.indexOf('export function startFrameClearedTransition'));
    const body = cleared.slice(0, cleared.indexOf('\n}'));
    // The keyframe pickers live on hivemind workflows, which take the start frame
    // as an optional input: falling back to allT2V[0] unmounted the picker mid-edit
    // and discarded the middle/end frames.
    assert.match(body, /if \(isHivemindVideoModelId\(s\.modelId\)\) return s;/);
    // The fallback itself respects the tab's Source (defaultTextToVideoModelFor):
    // `c.allT2V[0]` is the first CLOUD model, which is what hopped a Local
    // session onto Seedance Lite.
    assert.doesNotMatch(body, /c\.allT2V\[0\]/, 'no bare cloud-first fallback');
    assert.ok(
        body.indexOf('isHivemindVideoModelId(s.modelId)') < body.indexOf('defaultTextToVideoModelFor(s, c)'),
        'the local-workflow guard runs before the text-to-video fallback',
    );

    // One predicate for "this model shows start/middle/end slots", shared by the
    // render and by the start-frame handler.
    assert.match(logic, /export function frameSlotsVisible\(s, c\) \{/);
    assert.match(read('src/studios/VideoStudio.jsx'), /const ltxFramesVisible = frameSlotsVisible\(s\.setup, s\.catalogs\)/);
});

test('a local workflow resolves its capabilities with or without a start frame', () => {
    const logic = read('src/studios/video/videoLogic.js');

    // currentModel feeds every capability gate in the studio. It must resolve
    // through the MODE-BLIND list, because what a model can do is a property of
    // the model. Resolving through the mode-scoped picker list is what broke:
    // hivemind workflows take the start frame as an OPTIONAL input (H3 is
    // text-to-video by default), so any state with imageMode false — restoring
    // a generation that had no start frame, which is every reference run —
    // found nothing in the t2v list and silently turned every capability false.
    // The Frames control vanished while the References menu, which resolved
    // through the lib's own flat registry, stayed. Same model, two answers.
    const resolver = logic.slice(logic.indexOf('export const resolveVideoModel'));
    assert.match(resolver.slice(0, resolver.indexOf(';')), /allVideoModels\(c\)\.find/);
    assert.match(logic, /export const currentModel = \(s, c\) => resolveVideoModel\(s\.modelId, c\)/);

    // The mode-scoped list still exists — for the PICKER, which is allowed to
    // offer a different menu per mode — but nothing may resolve a capability
    // through it.
    assert.match(logic, /export const generationModelsFor/);
    assert.doesNotMatch(logic, /generationModelsFor\([^)]*\)\.find/,
        'a capability lookup must never go through the picker list');
});

test('every model the studio can select also resolves flat', async () => {
    // The flat resolver is only unambiguous while ids stay unique across the
    // catalogs — a collision would make a capability answer depend on list
    // order, which is the same class of bug one layer down.
    const data = await import('../src/lib/cloudCatalog.js');
    await data.cloudCatalogReady();
    const seen = new Map();
    for (const list of ['t2vModels', 'i2vModels', 'v2vModels']) {
        for (const entry of data[list] || []) {
            assert.ok(!seen.has(entry.id), `${entry.id} is in both ${seen.get(entry.id)} and ${list}`);
            seen.set(entry.id, list);
        }
    }
    assert.ok(seen.size > 100, 'sanity: the catalogs actually loaded');
});
