// Cancelling a CLOUD generation used to do nothing underneath: muapi's poll
// took no signal, so the "cancelled" clip landed on the canvas minutes later
// and the next Generate queued behind the dead poll. The poll now reads an
// AbortSignal and rejects with the same `{ cancelled: true }` marker the local
// Media Studio poll uses.
//
// Deliberately textual: a signal forwarded from the studio into the poll is a
// call-site fact.
const test = require('node:test');
const assert = require('node:assert/strict');

function stubBrowser({ fetchImpl }) {
    const originals = { window: global.window, localStorage: global.localStorage, fetch: global.fetch };
    global.window = { __MUAPI_KEY__: 'k' };
    global.localStorage = { getItem: () => 'k', setItem() {}, removeItem() {} };
    global.fetch = fetchImpl;
    return () => Object.assign(global, originals);
}

const load = () => import('../src/lib/muapi.js');

test('an aborted signal stops the poll at once and rejects with the cancelled marker', async () => {
    let polls = 0;
    const restore = stubBrowser({
        // Only PREDICTION fetches count. Resolving which route this page is on
        // (/api/muapi/status — this machine's key, or the browser's) is a
        // separate, once-per-page call and not a poll.
        fetchImpl: async (url) => {
            if (String(url).includes('/api/muapi/status')) return { ok: true, json: async () => ({ server_key: false }) };
            polls += 1;
            return { ok: true, json: async () => ({ status: 'processing' }) };
        },
    });
    try {
        const { muapi } = await load();
        const controller = new AbortController();
        const started = Date.now();
        const poll = muapi.pollForResult('req-1', 'k', 900, 2000, { signal: controller.signal });
        // Abort mid-wait: the 2 s tick must not be sat out.
        setTimeout(() => controller.abort(), 30);
        await assert.rejects(poll, (error) => error.cancelled === true);
        assert.ok(Date.now() - started < 1500, 'the wait itself is interruptible');
        assert.equal(polls, 0, 'nothing was fetched after the abort');
    } finally {
        restore();
    }
});

test('a signal already aborted never fetches; a live one polls to completion and resolves', async () => {
    const seen = [];
    const restore = stubBrowser({
        fetchImpl: async (url, init) => {
            seen.push(Boolean(init?.signal));
            return { ok: true, json: async () => (seen.length < 2 ? { status: 'processing' } : { status: 'completed', outputs: ['https://cdn/out.mp4'] }) };
        },
    });
    try {
        const { muapi } = await load();
        const aborted = new AbortController();
        aborted.abort();
        await assert.rejects(muapi.pollForResult('req-2', 'k', 5, 1, { signal: aborted.signal }), (error) => error.cancelled === true);
        assert.equal(seen.length, 0);

        const live = new AbortController();
        const result = await muapi.pollForResult('req-3', 'k', 5, 1, { signal: live.signal });
        assert.deepEqual(result.outputs, ['https://cdn/out.mp4']);
        assert.ok(seen.every(Boolean), 'the fetches carried the signal');
        // And without a signal the old call shape still works byte for byte.
        const plain = await muapi.pollForResult('req-4', 'k', 5, 1);
        assert.equal(plain.status, 'completed');
    } finally {
        restore();
    }
});

test('the generate calls forward params.signal to the poll, and the studio reads it per run', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const lib = fs.readFileSync(path.join(__dirname, '../src/lib/muapi.js'), 'utf8');
    for (const fn of ['generateImage', 'generateVideo', 'generateI2I', 'generateI2V', 'processV2V', 'processLipSync']) {
        const body = lib.slice(lib.indexOf(`async ${fn}(`));
        assert.match(body.slice(0, body.indexOf('\n    }\n')), /pollForResult\([^)]*\{ signal: params\.signal \}\)/, `${fn} forwards the signal`);
    }
    // Privacy: no console.log of payloads / prompts / poll responses / URLs.
    assert.doesNotMatch(lib, /console\.log\(/, 'muapi.js logs nothing');
    const studio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    assert.match(studio, /const runSignal = s\.abortController\.signal;/);
    assert.match(studio, /signal: runSignal/);
    // A poll that resolved in the same tick as Cancel is still cancelled.
    assert.match(studio, /const settled = \(res\) => \{ if \(runSignal\.aborted\) throw cancelledMarker\(\); return res; \};/);
    // Cancel drops the cloud job's pending record, so a reload does not resume it.
    assert.match(studio, /const cloudId = s\.activeCloudRequestId;[\s\S]*?if \(cloudId\) removePendingJob\(cloudId\);/);
});
