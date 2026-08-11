const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// MiniMax H3 quality controls: the 15s duration ceiling, the refinement-steps
// preset gate, and the family helper they both hang off. The measured facts
// behind them (15s identity ceiling, 0.8-1.0MP quality knee, 30-32 step
// motion/audio gain) live in the workflow registry + server tiers; these tests
// pin the client-side plumbing that surfaces them.

function stubBrowserGlobals() {
    const originals = {
        window: global.window,
        localStorage: global.localStorage,
        sessionStorage: global.sessionStorage,
    };
    const eventTarget = new EventTarget();
    eventTarget.location = { search: '?hivemindStudio=1', origin: 'https://studio.test' };
    eventTarget.parent = { postMessage() {} };
    global.window = eventTarget;
    global.localStorage = { getItem: () => null, removeItem() {}, setItem() {} };
    global.sessionStorage = { getItem: () => null, removeItem() {}, setItem() {} };
    return () => {
        global.window = originals.window;
        global.localStorage = originals.localStorage;
        global.sessionStorage = originals.sessionStorage;
    };
}

function catalogWith(models) {
    return {
        ok: true,
        media: { video: [{ id: 'media-studio-mcp', label: 'Media Studio', available: true, detail: 'ready', models }] },
    };
}

test('minimax workflows get the 15s duration ceiling; other families keep 10s', async () => {
    const restore = stubBrowserGlobals();
    try {
        const studio = await import(`${pathToFileURL(path.join(__dirname, '../src/lib/hivemindStudio.js')).href}?test=minimax-durations`);
        const [h3, ltx] = studio.mapHivemindWorkflowModels(catalogWith([
            { id: 'minimax-h3', label: 'MiniMax H3', family: 'minimax', accepts: ['prompt', 'steps', 'spectrum'], defaults: {}, default_duration_seconds: 5, default_steps: 15 },
            { id: 'ltx23-eros-fast', label: 'LTX 2.3 Eros Fast', family: 'ltx-2.3', accepts: ['prompt'], default_duration_seconds: 4 },
        ]));
        assert.equal(h3.durations.length, 15);
        assert.equal(h3.durations[h3.durations.length - 1], 15);
        assert.deepEqual(ltx.durations, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        // The registered step default reaches the client so the refinement
        // presets can be labeled truthfully and turbo lanes excluded.
        assert.equal(h3.defaultSteps, 15);
        assert.equal(ltx.defaultSteps, null);
    } finally {
        restore();
    }
});

test('isMinimaxFamilyModel follows the registry family with an id fallback', async () => {
    const restore = stubBrowserGlobals();
    try {
        const tasks = await import(`${pathToFileURL(path.join(__dirname, '../src/lib/videoTasks.js')).href}?test=minimax-family`);
        assert.equal(tasks.isMinimaxFamilyModel({ modelFamily: 'minimax', modelId: 'hivemind-media:minimax-h3' }), true);
        assert.equal(tasks.isMinimaxFamilyModel({ modelFamily: 'ltx-2.3', modelId: 'hivemind-media:ltx23-eros-fast' }), false);
        // Setups persisted before modelFamily existed fall back to the id.
        assert.equal(tasks.isMinimaxFamilyModel({ modelId: 'hivemind-media:minimax-h3-turbo' }), true);
        assert.equal(tasks.isMinimaxFamilyModel({ modelId: 'hivemind-media:ltx23-eros-fast' }), false);
    } finally {
        restore();
    }
});

test('refinement steps stay gated on a full-step lane end to end', () => {
    // videoLogic.jsx cannot be imported by node:test (JSX), so pin the two
    // load-bearing rules as source assertions, like loraSelection.test.js does.
    const videoLogic = fs.readFileSync(path.join(__dirname, '../src/studios/video/videoLogic.jsx'), 'utf8');
    // The capability needs BOTH a registry-mapped steps slot and a full-step
    // default — a distilled turbo build (4-8 steps) must never get the 32-step
    // preset bolted on.
    assert.match(videoLogic, /accepts\.includes\('steps'\)\s*\n?\s*&& Number\(model\?\.defaultSteps\) >= 10/);
    const videoStudio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    // The request only carries steps when the SELECTED model passes that gate,
    // so a preference saved on H3 cannot leak into a turbo or LTX graph.
    assert.match(videoStudio, /supportsQualitySteps\(currentModel\(setup, s\.catalogs\)\)/);
    // And the persisted preference round-trips within sane bounds.
    assert.match(videoLogic, /steps: \(typeof value\.steps === 'number'/);
});
