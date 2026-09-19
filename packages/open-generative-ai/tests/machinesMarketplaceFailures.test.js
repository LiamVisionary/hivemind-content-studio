// Deliberately textual: the view branches on a server payload this machine
// cannot produce without two marketplaces refusing a credential.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 2026-08-28: the Machines view said "No RTX 5090 offers match right now" while
// Vast alone listed 39 rentable 5090s. Both marketplaces were refusing a sealed
// credential, the server dropped both refusals, and an unpriced rung is drawn
// identically whether the market is sold out or nobody was ever asked. The
// server now sends `marketplace_failures`; these pin that the view actually
// branches on it. The rendering itself was driven in the browser against a
// fixture plan.
const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const view = read('src/hub/views/GpuMachinesView.jsx');

test('the sold-out line is reached only when no marketplace failed', () => {
    assert.match(view, /const troubles = plan\?\.marketplace_failures \|\| \[\];/,
        'the view reads the failures the plan carries');
    // The branch order is the whole fix: troubles are checked BEFORE the market
    // is blamed, so the two can never render the same sentence again.
    const troubleBranch = view.indexOf(') : troubles.length ? (');
    const soldOut = view.indexOf('offers match right now');
    assert.ok(troubleBranch > 0, 'the view has a marketplace-failure branch');
    assert.ok(troubleBranch < soldOut,
        'a refused marketplace must be answered before "no offers match right now"');
});

test('each failure is shown with its own repair, never the upstream error line', () => {
    // why + fix come from the server, which writes them for a person. `detail`
    // is the raw marketplace string (`Vast API POST /v0/bundles/ failed: …`) and
    // is deliberately NOT rendered — it names an endpoint, not a repair.
    assert.match(view, /\{trouble\.why\}/);
    assert.match(view, /\{trouble\.fix\}/);
    assert.doesNotMatch(view, /trouble\.detail/);
});

test('a price built from half the market says so', () => {
    // A rung the other marketplace could still have undercut must not be
    // presented as the market's price.
    assert.match(view, /this is what is left of the\s*\n?\s*market/);
});
