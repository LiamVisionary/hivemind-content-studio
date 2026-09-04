// A production whose record file is gone still shows up, and says so.
//
// GET /api/runs used to answer 500 when ONE run's manifest had moved — the
// envelope was built inside a list comprehension, so a single stale path
// emptied the whole Productions page and the owner saw an incident id. The
// control API now degrades that one row instead. This is the client half of
// that contract: the broken row is a card, the good rows are untouched, and
// the card carries its repair rather than a raw backend string.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { renderComponent, renderElement, root, textOf } = require('./helpers/render.js');

const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);

// RunCard is a memo(), which importComponent's "is it a function" check
// rejects — render it straight off the module instead.
async function renderRunCard(run) {
    const { RunCard } = await load('src/hub/components/RunCard.jsx');
    const { markup, logged } = renderElement(RunCard, { run });
    assert.deepEqual(logged, [], 'a render that logged is not a passing render');
    return textOf(markup);
}

const brokenRun = (runId = 'run-broken', reason = 'missing') => ({
    ok: false,
    run_id: runId,
    lane: 'first-frame-animation-ad',
    status: 'awaiting_generation',
    current_step: 'keyframes',
    steps: [{ step_id: 'script', status: 'completed' }, { step_id: 'keyframes', status: 'pending' }],
    events: [],
    brief: {},
    artifact_records: [],
    next_actions: [],
    budget: {},
    created_at: '2026-07-24T01:35:54Z',
    updated_at: '2026-07-24T01:35:54Z',
    record_status: 'unreadable',
    record_failure: {
        reason,
        message: "This production's record file is missing, so the studio cannot read it.",
        manifest_path: '/Users/someone/old-checkout/data/runs/run-broken/manifest.json',
        detail: "FileNotFoundError: [Errno 2] No such file or directory: '/Users/someone/old-checkout/data/runs/run-broken/manifest.json'",
    },
});

const healthyRun = (runId = 'run-good') => ({
    ok: true,
    run_id: runId,
    lane: 'static-text-ad',
    status: 'completed',
    current_step: null,
    steps: [{ step_id: 'script', status: 'completed' }],
    events: [],
    brief: { title: 'A production that reads fine' },
    artifact_records: [],
    next_actions: [],
    budget: {},
});

test('a run whose record cannot be read is read as one sentence, a hint and a repair', async () => {
    const { runRecordFailure } = await load('src/lib/runRecord.js');

    assert.equal(runRecordFailure(healthyRun()), null, 'a healthy run has no failure to describe');
    assert.equal(runRecordFailure(null), null);

    const missing = runRecordFailure(brokenRun());
    assert.equal(missing.reason, 'missing');
    assert.match(missing.title, /record file is missing/);
    assert.ok(missing.hint, 'a problem is never presented without what to do about it');
    // Rule 2 of describeFailure, applied here: the traceback and the path are
    // evidence the callout hides, never the sentence.
    assert.doesNotMatch(missing.title, /FileNotFoundError|\/Users\//);
    assert.match(missing.detail, /FileNotFoundError/);
    assert.match(missing.detail, /old-checkout/);

    // The other two ways a manifest stops being readable get their own reading.
    assert.match(runRecordFailure(brokenRun('r', 'sealed')).title, /sealed/);
    assert.match(runRecordFailure(brokenRun('r', 'unreadable')).title, /could not be read/);
});

test('the run list card says the record is missing instead of a step it cannot know', async () => {
    const broken = await renderRunCard(brokenRun());
    assert.match(broken, /Record missing/);
    assert.doesNotMatch(broken, /Step: Keyframes/, 'no step claim without the record that carries it');

    const healthy = await renderRunCard(healthyRun());
    assert.doesNotMatch(healthy, /Record missing/);
    assert.match(healthy, /A production that reads fine/);
});

test('one broken production never hides the good ones, and its card carries the repair', async () => {
    const hub = await load('src/hub/hubData.js');
    hub.hubState.runs = [brokenRun('run-broken-1'), healthyRun('run-good'), brokenRun('run-broken-2')];
    hub.hubState.statusFilter = '';
    hub.hubState.selectedRunId = 'run-broken-1';

    const markup = await renderComponent('src/hub/views/RunsView.jsx', 'RunsView', { active: true });
    const text = textOf(markup);

    // Every row is listed — the two broken ones and the one that reads.
    assert.match(text, /3 shown/);
    assert.match(text, /A production that reads fine/);
    assert.equal(text.match(/Record missing/g).length, 2, 'both broken rows say so');

    // And the selected one explains itself with the button that repairs it.
    assert.match(text, /record file is missing/);
    assert.match(text, /Open storage settings/);
    // Nothing that needs the record is offered: those routes answer 409.
    assert.doesNotMatch(text, /Retry step/);
    assert.doesNotMatch(text, /Duplicate & edit/);

    hub.hubState.runs = [];
    hub.hubState.selectedRunId = '';
});
