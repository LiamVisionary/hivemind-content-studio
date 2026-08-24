const test = require('node:test');
const assert = require('node:assert/strict');

// Hub data-layer behaviours behind the 2026-08 hub polish: humanised status
// words, artifact download extensions, poll backoff, the Planner's confirm
// outcome, History's first-load flag and view-scoped polling.

let instance = 0;
// Fresh module instance per test: hubState is a module singleton.
function freshHub() {
    instance += 1;
    return import(`../src/hub/hubData.js?polish=${instance}`);
}

function jsonResponse(body, ok = true, status = 200) {
    return { ok, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
}

test('humanize turns snake/kebab status words into one sentence-cased phrase', async () => {
    const { humanize, titleCase } = await freshHub();
    assert.equal(humanize('awaiting_generation'), 'Awaiting generation');
    assert.equal(humanize('generate_keyframes'), 'Generate keyframes');
    assert.equal(humanize('scene-video'), 'Scene video');
    assert.equal(humanize(''), '');
    assert.equal(humanize(undefined), '');
    // titleCase keeps Title Case for names but now understands underscores too.
    assert.equal(titleCase('first-frame-animation-ad'), 'First Frame Animation Ad');
    assert.equal(titleCase('in_progress'), 'In Progress');
});

test('artifact downloads derive a file extension from the MIME type', async () => {
    const { extensionForMime } = await freshHub();
    assert.equal(extensionForMime('image/png'), 'png');
    assert.equal(extensionForMime('image/jpeg'), 'jpg');
    assert.equal(extensionForMime('video/mp4; codecs=avc1'), 'mp4');
    assert.equal(extensionForMime('audio/mpeg'), 'mp3');
    assert.equal(extensionForMime('application/json'), 'json');
    // Unknown but sane subtypes pass through; garbage does not.
    assert.equal(extensionForMime('image/heic'), 'heic');
    assert.equal(extensionForMime('application/x-custom+zip'), 'custom');
    assert.equal(extensionForMime(''), '');
    assert.equal(extensionForMime(undefined), '');
});

test('poll cadence doubles on failure up to 60s and snaps back on success', async () => {
    const { nextPollDelay, POLL_BASE_MS, POLL_MAX_MS } = await freshHub();
    assert.equal(POLL_BASE_MS, 10000);
    let delay = POLL_BASE_MS;
    delay = nextPollDelay(delay, false);
    assert.equal(delay, 20000);
    delay = nextPollDelay(delay, false);
    assert.equal(delay, 40000);
    delay = nextPollDelay(delay, false);
    assert.equal(delay, POLL_MAX_MS);
    delay = nextPollDelay(delay, false);
    assert.equal(delay, POLL_MAX_MS, 'capped');
    assert.equal(nextPollDelay(delay, true), POLL_BASE_MS, 'reset on success');
    assert.equal(nextPollDelay(undefined, false), 20000, 'a missing current delay starts from the base');
});

test('createSimpleRun resolves a boolean and marks the plan card that asked', async () => {
    const hub = await freshHub();
    const plan = { mode: 'confirmation', draft: { title: 'X', scenes: [] } };
    // The plan card lives in the thread exactly as submitSimplePrompt pushes it.
    hub.hubState.thread.push({ id: 'plan-item', kind: 'assistant', message: 'Review', plan });

    let fail = true;
    global.fetch = async (path, options = {}) => {
        if (path === '/api/simple/runs') {
            if (fail) return jsonResponse({ detail: 'boom' }, false, 500);
            return jsonResponse({ run_id: 'run-1', status: 'queued' });
        }
        if (path === '/api/runs') return jsonResponse({ runs: [{ run_id: 'run-1', status: 'queued' }] });
        if (path === '/api/telemetry/generations') return jsonResponse({ summary: {} });
        if (path.startsWith('/api/simple/prompts')) return jsonResponse({ prompts: [] });
        if (path.startsWith('/api/canvas/history')) return jsonResponse({ history: [], pagination: {}, filters: {} });
        return jsonResponse({}, false, 404);
    };

    assert.equal(await hub.createSimpleRun(plan), false, 'a refused create resolves false');
    assert.equal(hub.hubState.thread[0].createdRunId, undefined);
    assert.equal(hub.hubState.simpleBusy, false, 'busy is released either way');
    assert.ok(hub.hubState.thread.some((item) => item.kind === 'runError'), 'the failure is in the thread');

    fail = false;
    assert.equal(await hub.createSimpleRun(plan), true, 'a created run resolves true');
    assert.equal(hub.hubState.thread[0].createdRunId, 'run-1', 'the plan card keeps the outcome');
    assert.equal(hub.hubState.selectedRunId, 'run-1');
});

test('History flips historyLoaded after the first load settles, even on failure', async () => {
    const hub = await freshHub();
    assert.equal(hub.hubState.historyLoaded, false);
    global.fetch = async () => { throw new Error('offline'); };
    await hub.loadPrompts({ quiet: true });
    assert.equal(hub.hubState.historyLoaded, true, 'a failed first load must not leave the skeleton up forever');
    assert.deepEqual(hub.hubState.canvasHistory, []);
});

test('deletePrompt resolves false on failure so the confirm stays open', async () => {
    const hub = await freshHub();
    hub.hubState.prompts = [{ prompt_id: 'p1' }, { prompt_id: 'p2' }];
    global.fetch = async (path) => (path.endsWith('/p1') ? jsonResponse({ detail: 'nope' }, false, 500) : jsonResponse({ ok: true }));
    assert.equal(await hub.deletePrompt('p1'), false);
    assert.equal(hub.hubState.prompts.length, 2, 'a failed delete keeps the prompt');
    assert.equal(await hub.deletePrompt('p2'), true);
    assert.deepEqual(hub.hubState.prompts.map((entry) => entry.prompt_id), ['p1']);
});

test('copyText reports a missing clipboard instead of rejecting', async () => {
    const hub = await freshHub();
    const saved = global.navigator;
    Object.defineProperty(global, 'navigator', { value: {}, configurable: true, writable: true });
    try {
        assert.equal(await hub.copyText('hello'), false);
        Object.defineProperty(global, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true, writable: true });
        assert.equal(await hub.copyText('hello'), true);
    } finally {
        Object.defineProperty(global, 'navigator', { value: saved, configurable: true, writable: true });
    }
});

test('the quiet poll only reloads History while the hub is visible and History is the active view', async () => {
    const hub = await freshHub();
    const calls = [];
    global.fetch = async (path) => {
        calls.push(path.split('?')[0]);
        if (path === '/api/catalog') return jsonResponse({ lanes: [] });
        if (path === '/api/oauth') return jsonResponse({ providers: {} });
        if (path === '/api/runs') return jsonResponse({ runs: [] });
        if (path === '/api/telemetry/generations') return jsonResponse({ summary: {} });
        if (path.startsWith('/api/simple/prompts')) return jsonResponse({ prompts: [] });
        if (path.startsWith('/api/canvas/history')) return jsonResponse({ history: [], pagination: {}, filters: {} });
        return jsonResponse({}, false, 404);
    };
    // activateHubView('history') itself loads prompts once; only the POLL is under test.
    hub.hubState.activeView = 'history';
    hub.setHubVisible(false);
    assert.equal(await hub.refreshAll({ quiet: true }), true);
    assert.ok(!calls.includes('/api/simple/prompts'), 'History must not be re-fetched behind a studio page');
    assert.equal(hub.hubState.apiOnline, true);

    calls.length = 0;
    hub.setHubVisible(true);
    await hub.refreshAll({ quiet: true });
    assert.ok(calls.includes('/api/simple/prompts'), 'History polls while it is on screen');
    assert.ok(calls.includes('/api/canvas/history'));

    // OAuth is re-read on the tick only while Providers is showing (or never loaded).
    calls.length = 0;
    hub.hubState.activeView = 'runs';
    await hub.refreshAll({ quiet: true });
    assert.ok(!calls.includes('/api/oauth'), 'a loaded OAuth status is not re-polled on other pages');
    hub.hubState.activeView = 'providers';
    calls.length = 0;
    await hub.refreshAll({ quiet: true });
    assert.ok(calls.includes('/api/oauth'), 'Providers keeps its status live');

    // A failed tick flips apiOnline and resolves false (what the backoff keys off).
    global.fetch = async () => { throw new Error('down'); };
    assert.equal(await hub.refreshAll({ quiet: true }), false);
    assert.equal(hub.hubState.apiOnline, false);
});

test('a tick that finds a refresh in flight joins it instead of stacking another batch', async () => {
    const hub = await freshHub();
    let runsFetches = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    global.fetch = async (path) => {
        if (path === '/api/catalog') return jsonResponse({ lanes: [] });
        if (path === '/api/oauth') return jsonResponse({ providers: {} });
        if (path === '/api/runs') { runsFetches += 1; await gate; return jsonResponse({ runs: [] }); }
        if (path === '/api/telemetry/generations') return jsonResponse({ summary: {} });
        return jsonResponse({}, false, 404);
    };
    const first = hub.pollTick({ quiet: true });
    const second = hub.pollTick({ quiet: true });
    assert.equal(first, second, 'the second tick is the first one, not a new request batch');
    release();
    assert.equal(await first, true);
    assert.equal(runsFetches, 1, 'one /api/runs for two ticks');
    // Once settled, the next tick is a fresh refresh.
    await hub.pollTick({ quiet: true });
    assert.equal(runsFetches, 2);
});
