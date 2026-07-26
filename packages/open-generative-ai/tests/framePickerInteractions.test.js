// Reference / keyframe picker interaction rules.
//
// UploadPicker.jsx, FrameSlotsPicker.jsx, VideoStudio.jsx and videoLogic.jsx are
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
        assert.match(source, /const rootRef = useDismissable\(panelOpen, \(\) => setPanelOpen\(false\)\)/, `${file} names the dismissable region rootRef`);
        assert.match(source, /ref=\{rootRef\}/, `${file} attaches it to the wrapper`);
        assert.doesNotMatch(source, /ref=\{panelRef\}/, `${file} no longer scopes dismissal to the panel alone`);
    }
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

test('single-mode picks can keep the panel open for models with more frame slots', () => {
    const upload = read('src/studios/UploadPicker.jsx');
    assert.match(upload, /keepOpenOnSelect = false/);
    assert.match(upload, /if \(!keepOpenOnSelect\) setPanelOpen\(false\)/);

    const studio = read('src/studios/VideoStudio.jsx');
    assert.match(studio, /keepOpenOnSelect=\{endFrameVisible\}/);
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
    const logic = read('src/studios/video/videoLogic.jsx');
    const cleared = logic.slice(logic.indexOf('export function startFrameClearedTransition'));
    const body = cleared.slice(0, cleared.indexOf('\n}'));
    // The keyframe pickers live on hivemind workflows, which take the start frame
    // as an optional input: falling back to allT2V[0] unmounted the picker mid-edit
    // and discarded the middle/end frames.
    assert.match(body, /if \(isHivemindVideoModelId\(s\.modelId\)\) return s;/);
    assert.ok(
        body.indexOf('isHivemindVideoModelId(s.modelId)') < body.indexOf('c.allT2V[0]'),
        'the local-workflow guard runs before the cloud t2v fallback',
    );

    // One predicate for "this model shows start/middle/end slots", shared by the
    // render and by the start-frame handler.
    assert.match(logic, /export function frameSlotsVisible\(s, c\) \{/);
    assert.match(read('src/studios/VideoStudio.jsx'), /const ltxFramesVisible = frameSlotsVisible\(s\.setup, s\.catalogs\)/);
});
