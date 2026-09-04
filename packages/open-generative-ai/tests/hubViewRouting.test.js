// Deliberately textual: "derived from a single current value" is a statement
// about the source having one of something, which a render cannot count.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Regression, carried over from the retired vanilla hub (src/views/hub/hubApp.js,
// deleted 2026-08): the create view carries data-studio-mode for CSS, so a bare
// $$('[data-studio-mode]') in selectNativeStudioMode also matched the VIEW element
// and re-added `is-active` to it — stacking the create view over whichever hub
// view (History, Runs, …) the user had open.
//
// The React hub cannot reproduce that by construction, and this test pins the
// construction rather than the old symptom: every view's `active` is derived from
// ONE value, so two of them can never be active at once. A future refactor that
// gave a view its own independent activation flag is exactly what would bring the
// stacking bug back, and that is what this catches.
test('hub view activation is derived from a single current value', () => {
    const layer = fs.readFileSync(path.join(__dirname, '../src/hub/HubLayer.jsx'), 'utf8');

    // One source of truth for which view is showing.
    assert.match(layer, /const current = visible \? view : null;/);

    // Every rendered view compares against it — no view carries its own flag.
    const activations = [...layer.matchAll(/<(\w+View)\s+active=\{([^}]+)\}/g)];
    assert.ok(activations.length >= 6, `expected the hub's views, saw ${activations.length}`);
    for (const [, name, expression] of activations) {
        assert.match(
            expression.trim(),
            /^current === '[a-z]+'$/,
            `${name} must derive active from current, got: ${expression.trim()}`,
        );
    }

    // And the view names are distinct, so no two can be true together.
    const keys = activations.map(([, , expression]) => expression.trim());
    assert.equal(new Set(keys).size, keys.length, 'two views share an activation key');
});
