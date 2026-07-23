const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Regression: the create view carries data-studio-mode for CSS, so a bare
// $$('[data-studio-mode]') in selectNativeStudioMode also matched the VIEW
// element and re-added `is-active` to it when boot() finished — stacking the
// create view over whichever hub view (History, Runs, …) the user had open.
test('hub studio-mode highlighting can never activate the create view', () => {
    const hub = fs.readFileSync(path.join(__dirname, '../src/views/hub/hubApp.js'), 'utf8');

    // The CSS contract keeps the mode on the view element…
    assert.match(hub, /createView\.dataset\.studioMode = selected;/);
    // …so the button-highlight query MUST be scoped to the tab strip.
    assert.match(hub, /\$\$\('#native-studio-modes \[data-studio-mode\]'\)\.forEach/);
    assert.doesNotMatch(hub, /\$\$\('\[data-studio-mode\]'\)/);

    // And view activation stays exclusive: one toggle pass over every .view.
    assert.match(hub, /\$\$\('\.view'\)\.forEach\(\(item\) => item\.classList\.toggle\('is-active', item\.dataset\.view === selected\)\);/);
});
