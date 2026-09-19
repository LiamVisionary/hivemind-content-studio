// A drop-in workflow that did not become a model has to SAY so.
//
// Before this, inspectAutoWorkflow returned a bare null for every rejection
// and nothing carried it anywhere: a file somebody put in the folder on
// purpose simply never appeared, with no message in the studio and nothing in
// any log they would read. These pin the sentence, the file name, and the way
// out being in the same component.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderComponent } = require('./helpers/render.js');

const SKIPPED = [
    { file: 'my-editor-export.json', reason: 'it is a workflow editor export, not an API one — re-export with "Save (API format)"' },
    { file: 'half-saved.json', reason: 'it is not valid JSON' },
];

test('it names every file it skipped, and why', async () => {
    const markup = await renderComponent('src/studios/WorkflowDropInNotice.jsx', 'WorkflowDropInNotice', {
        skipped: SKIPPED,
        directories: ['/Users/someone/comfy/ComfyUI/workflows/auto'],
        onCheckAgain: () => {},
    });
    for (const entry of SKIPPED) {
        assert.ok(markup.includes(entry.file), `${entry.file} is not named`);
    }
    assert.match(markup, /Save \(API format\)/);
    // Where to go and look, because "a folder" is not an address.
    assert.match(markup, /workflows\/auto/);
    // Owner rule: never present a problem without its fix in the same
    // component. The way out of every one of these is to edit the file and
    // ask again.
    assert.match(markup, /Check again/);
});

test('a clean folder costs the panel nothing', async () => {
    const markup = await renderComponent('src/studios/WorkflowDropInNotice.jsx', 'WorkflowDropInNotice', {
        skipped: [],
        directories: ['/x/auto'],
    });
    assert.equal(markup.trim(), '', 'it must render nothing at all, not an empty box');
});

test('one skipped file is not "some workflows"', async () => {
    const markup = await renderComponent('src/studios/WorkflowDropInNotice.jsx', 'WorkflowDropInNotice', {
        skipped: [SKIPPED[0]],
        directories: [],
    });
    assert.match(markup, /One workflow/);
    assert.doesNotMatch(markup, /Some workflows/);
});

// The gate it must NOT be behind. `useLocalModel` is only written when a person
// picks a run target BY HAND (chooseRunTarget); a tab still following the
// Automatic pick has it false even with This Mac chosen and every local model
// loaded — measured in the browser 2026-09-14, which is how this notice was
// found dark the first time. A skipped file is worth saying on the first
// render, not after the first manual pick.
test('the panel does not hide the notice behind useLocalModel', () => {
    const panel = fs.readFileSync(path.join(__dirname, '../src/studios/image/ImageSettingsPanel.jsx'), 'utf8');
    const noticeAt = panel.indexOf('<WorkflowDropInNotice');
    assert.ok(noticeAt > 0, 'the panel no longer renders the notice');
    const gateAt = panel.indexOf('{s.useLocalModel ?');
    assert.ok(gateAt > 0, 'the useLocalModel gate moved — re-check which side the notice is on');
    assert.ok(noticeAt < gateAt, 'the notice must sit ABOVE the useLocalModel gate, not inside it');
});
