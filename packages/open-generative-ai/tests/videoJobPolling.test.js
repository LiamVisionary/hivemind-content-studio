// The poller's job is to be honest about a render it cannot see.
//
// It used to fail three ways. A 5xx fell through to a bare `continue`, so a
// broken server was polled in silence until a client-side wall clock gave up.
// That wall clock was Date.now()-based, so a laptop asleep for two hours woke
// to "generation timed out" for a clip the server was still tracking. And a
// 404 promised the clip would appear in History, which is only true for a
// rented lane — a local render dies with the process.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(path.join(__dirname, '..', 'src', 'lib', 'hivemindStudio.js')).href;

function stubWindow() {
    const target = new EventTarget();
    target.location = { search: '', origin: 'https://studio.test' };
    target.parent = { postMessage() {} };
    global.window = target;
    global.localStorage = { getItem: () => null, removeItem() {}, setItem() {} };
    global.sessionStorage = { getItem: () => null, removeItem() {}, setItem() {} };
}

function withFakeTimers(run) {
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => realSetTimeout(fn, 0);
    return run().finally(() => { global.setTimeout = realSetTimeout; });
}

async function pollWith(responses, options = {}) {
    stubWindow();
    let call = 0;
    global.fetch = async () => {
        const next = responses[Math.min(call, responses.length - 1)];
        call += 1;
        return typeof next === 'function' ? next() : next;
    };
    const { pollHivemindVideoJob } = await import(MODULE);
    return withFakeTimers(() => pollHivemindVideoJob('job-1', options));
}

const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
const failing = (status) => ({ ok: false, status, json: async () => ({}) });

test('three failing polls in a row end the wait with a retryable error', async () => {
    await assert.rejects(
        pollWith([failing(502)]),
        (error) => {
            assert.equal(error.retryable, true);
            assert.match(error.message, /Generate again/);
            // Never the backend's own words.
            assert.doesNotMatch(error.message, /502/);
            return true;
        },
    );
});

test('a single failing poll is a blip, not a failure', async () => {
    const url = '/api/media-studio/gateway/clip.mp4';
    const result = await pollWith([
        failing(500),
        ok({ ok: true, status: 'running' }),
        ok({ ok: true, url }),
    ]);
    assert.equal(result.url, url);
});

test('a job nobody can find no longer promises a clip in History', async () => {
    await assert.rejects(
        pollWith([{ ok: false, status: 404, json: async () => ({}) }]),
        (error) => {
            assert.equal(error.retryable, true);
            assert.match(error.message, /anything that did finish is in the History tab/);
            assert.doesNotMatch(error.message, /The finished video will appear/);
            return true;
        },
    );
});

test("the server's retryable error is carried through to the studio's retry", async () => {
    await assert.rejects(
        pollWith([ok({ ok: false, status: 'error', detail: 'The video backend stopped responding', retryable: true })]),
        (error) => {
            assert.equal(error.retryable, true);
            assert.equal(error.message, 'The video backend stopped responding');
            return true;
        },
    );
});

test('a run far past its estimate reports overtime instead of timing out', async () => {
    const seen = [];
    const url = '/api/media-studio/gateway/slow.mp4';
    const result = await pollWith(
        [
            ok({ ok: true, status: 'running', elapsed_seconds: 120, estimate_seconds: 100 }),
            ok({ ok: true, status: 'running', elapsed_seconds: 7200, estimate_seconds: 100 }),
            ok({ ok: true, url }),
        ],
        { onProgress: (info) => seen.push(info) },
    );

    assert.equal(result.url, url);
    // Two hours in — a laptop that slept through the render — is still a
    // render, reported as minutes elapsed rather than an error.
    assert.equal(seen[0].overtimeMinutes, null);
    assert.equal(seen[1].overtimeMinutes, 120);
});
