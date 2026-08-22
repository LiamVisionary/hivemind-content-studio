// Reloading the page mid-generation must bring every tab's run back.
//
// A render outlives the page: the job id is in sessionStorage and the backend keeps
// working. Before this, only Tab 1 was restored and only one job was resumed, so a
// reload during (say) a rented MiniMax H3 render left the studio looking idle over a
// machine that was still rendering — and every other tab's run was orphaned outright.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { pendingJobsForTab } from '../src/lib/pendingJobs.js';

const readSource = (relative) => fs.readFileSync(path.join(import.meta.dirname, '..', relative), 'utf8');

const job = (requestId, tabId, extra = {}) => ({
    requestId, studioType: 'video', kind: 'hivemind-local', submittedAt: 1, ...extra,
    ...(tabId === undefined ? {} : { tabId }),
});

/* ---------------- who resumes what ---------------- */

test('a tab resumes the generation it started and no other tab’s', () => {
    const jobs = [job('a', 1), job('b', 2), job('c', 3)];
    const open = [1, 2, 3];

    assert.deepEqual(pendingJobsForTab(jobs, 2, { primary: false, openTabIds: open }).map((j) => j.requestId), ['b']);
    // Even the primary tab keeps its hands off a job another open tab owns —
    // otherwise Tab 1 polls Tab 3's render and files the clip in its own history.
    assert.deepEqual(pendingJobsForTab(jobs, 1, { primary: true, openTabIds: open }).map((j) => j.requestId), ['a']);
});

test('the primary tab adopts jobs no open tab can claim', () => {
    // Tab 5 was closed while it was rendering; the legacy job predates tab ids.
    const jobs = [job('mine', 1), job('closed-tab', 5), job('legacy', undefined)];
    const open = [1, 2];

    assert.deepEqual(
        pendingJobsForTab(jobs, 1, { primary: true, openTabIds: open }).map((j) => j.requestId),
        ['mine', 'closed-tab', 'legacy'],
    );
    // A non-primary tab adopts nothing, so an orphan is polled exactly once.
    assert.deepEqual(pendingJobsForTab(jobs, 2, { primary: false, openTabIds: open }), []);
});

test('without the open-tab list only an unstamped job counts as orphaned', () => {
    const jobs = [job('stamped', 7), job('legacy', undefined)];
    assert.deepEqual(pendingJobsForTab(jobs, 1, { primary: true }).map((j) => j.requestId), ['legacy']);
});

test('job ownership tolerates a junk registry', () => {
    assert.deepEqual(pendingJobsForTab(null, 1, { primary: true }), []);
    assert.deepEqual(pendingJobsForTab([job('a', 1)], undefined, { primary: false }), []);
    // A tab with no usable id still adopts orphans when it is the primary one.
    assert.deepEqual(pendingJobsForTab([job('a', 1), job('b')], null, { primary: true, openTabIds: [1] }).map((j) => j.requestId), ['b']);
});

/* ---------------- the wiring that makes the above reachable ---------------- */

test('the tab strip is persisted and each tab is told which run is its own', () => {
    const tabs = readSource('src/app/StudioTabs.jsx');
    assert.match(tabs, /loadTabState\(studioType\)/, 'the strip is restored on mount');
    assert.match(tabs, /saveTabState\(studioType, state\)/, 'and written back on every change');
    assert.match(tabs, /tabId=\{tab\.id\}/, 'each studio knows its tab id');
    assert.match(tabs, /primary=\{tab\.id === state\.tabs\[0\]\.id && !tab\.seed\}/,
        'exactly one tab is primary, decided by position rather than by a null seed');
    assert.match(tabs, /openTabIds=\{openTabIds\}/, 'and can tell an orphan from another open tab’s job');
});

test('a started generation records the tab that started it', () => {
    for (const relative of ['src/studios/VideoStudio.jsx', 'src/studios/ImageStudio.jsx']) {
        const source = readSource(relative);
        const saves = source.match(/savePendingJob\(\{[\s\S]*?\}\);/g) || [];
        assert.ok(saves.length > 0, `${relative} saves pending jobs`);
        saves.forEach((call) => assert.match(call, /tabId: tabIdRef\.current/,
            `${relative}: every saved job is stamped with its tab`));
        assert.match(source, /pendingJobsForTab\(/, `${relative} claims jobs by tab on resume`);
        assert.match(source, /const isPrimaryTab = primary == null \? !seedRef\.current : Boolean\(primary\)/,
            `${relative}: primary is told, not inferred from the seed`);
    }
});

test('the video resume restores the progress canvas, its clock and its cancel', () => {
    const source = readSource('src/studios/VideoStudio.jsx');
    // The elapsed clock must run from the original submit, not from the reload —
    // otherwise a 40-minute render reads as having just started.
    assert.match(source, /s\.generationStartedAt = live\.submittedAt \|\| Date\.now\(\);/);
    assert.match(source, /modelName: live\.modelName/, 'the resumed card names the model that is rendering');
    // Cancel has to be able to stop a resumed poll; without a controller it reset
    // the UI while the poll kept running and later dropped its clip on screen.
    assert.match(source, /s\.abortController = new AbortController\(\);[\s\S]{0,600}?startGenerationProgress\(\{[\s\S]{0,200}?modelName: live\.modelName/);
});

test('a studio with unfinished work is mounted at boot, whatever page you land on', () => {
    const app = readSource('src/app/App.jsx');
    assert.match(app, /getPendingJobs\(\)/, 'boot consults the pending-job registry');
    assert.match(app, /STUDIO_LOADERS\[studio\]/, 'and loads the studio that owns the work');
});
