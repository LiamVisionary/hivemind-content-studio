// Overwriting a saved LoRA group from the save dialog.
//
// The store already upserts by name (savedLibraryStore.test.js covers that); what
// was missing was a way to AIM at an existing group without retyping its name
// exactly. SavedLibrary.jsx and LoraGroupsMenu.jsx are JSX, which node:test cannot
// import, so these assert the source shape — the dialog itself was driven in the
// browser (pick a row → button reads "Overwrite" → onSave gets that exact name).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('the save dialog can target an existing entry instead of retyping its name', () => {
    const dialog = read('src/ui/SavedLibrary.jsx');
    assert.match(dialog, /existing = \[\]/);
    // takenNames drives the Save/Overwrite switch; deriving it from `existing`
    // keeps the picker and the warning from ever disagreeing.
    assert.match(dialog, /takenNames = existing\.map\(\(entry\) => entry\.name\)/);
    assert.match(dialog, /title=\{`Save over “\$\{entry\.name\}”`\}/);
    // Picking only fills the field — the save still goes through the button, so a
    // stray tap on the list cannot overwrite anything.
    const pick = dialog.slice(dialog.indexOf('const pick = (entry)'));
    const body = pick.slice(0, pick.indexOf('\n  };'));
    assert.match(body, /setName\(entry\.name\)/);
    assert.doesNotMatch(body, /onSave/);
});

test('the LoRA group saver lists the saved groups and pre-aims at the loaded one', () => {
    const menu = read('src/studios/image/LoraGroupsMenu.jsx');
    assert.match(menu, /existing=\{entries\.map\(\(entry\) => \(\{ id: entry\.id, name: entry\.name, hint: groupSummary\(entry\.data\) \}\)\)\}/);
    assert.match(menu, /initialName=\{activeName\}/);
    // Load a group, retune a weight, save — that path should update the group it
    // came from rather than leave a near-duplicate behind.
    assert.match(menu, /onLoad\(next\);\s*\n\s*setActiveName\(entry\.name\);/);
    assert.match(menu, /setActiveName\(name\);/);
    // A deleted group must stop being the save target.
    assert.match(menu, /if \(sameName\(entry\.name, activeName\)\) setActiveName\(''\);/);
    // The confirmation says which of the two things happened.
    assert.match(menu, /replaced \? `Updated “\$\{name\}”\.` : `Saved “\$\{name\}”\.`/);
});
