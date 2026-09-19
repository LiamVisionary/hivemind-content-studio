// The background poster warm-up.
//
// It runs unattended over the owner's whole reference library, so what matters
// is what it refuses to do: never twice, never all at once, never in front of
// the user, and never derailed by one unreadable file.
const test = require('node:test');
const assert = require('node:assert/strict');

async function load() {
    return import('../src/lib/referencePosterWarmup.js');
}

const REFS = [
    { uploadedUrl: '/api/media-studio/references/a.png', kind: 'image', posterUrl: null },
    { uploadedUrl: '/api/media-studio/references/b.mp4', kind: 'video', posterUrl: null },
    { uploadedUrl: '/api/media-studio/references/c.png', kind: 'image', posterUrl: '/api/media-studio/references/c.poster.jpg' },
    { uploadedUrl: '/api/media-studio/references/d.m4a', kind: 'audio', posterUrl: null },
];

function spy({ capture = async () => 'data:image/jpeg;base64,X', publish = async () => '/poster.jpg' } = {}) {
    const calls = { capture: [], publish: [], posters: [], pauses: [] };
    return {
        calls,
        effects: {
            capture: async (url, kind) => { calls.capture.push([url, kind]); return capture(url, kind); },
            publish: async (url, data) => { calls.publish.push([url, data]); return publish(url, data); },
            onPoster: (url, posterUrl) => calls.posters.push([url, posterUrl]),
            pause: async (ms) => { calls.pauses.push(ms); },
            shouldStop: () => false,
        },
    };
}

test('only references that lack a poster and have something to show', async () => {
    const { referencesNeedingPosters } = await load();
    const pending = referencesNeedingPosters(REFS).map((entry) => entry.uploadedUrl);
    assert.deepEqual(pending, [
        '/api/media-studio/references/a.png',
        '/api/media-studio/references/b.mp4',
    ]);
    // c already has one — redoing it would decrypt an original for nothing.
    // d is a voice clip: no frame to draw.
    assert.deepEqual(referencesNeedingPosters([]), []);
    assert.deepEqual(referencesNeedingPosters(), []);
});

test('each reference is captured with the right kind and published once', async () => {
    const { warmReferencePosters } = await load();
    const { calls, effects } = spy();
    const result = await warmReferencePosters(REFS, effects);

    assert.deepEqual(calls.capture, [
        ['/api/media-studio/references/a.png', 'image'],
        ['/api/media-studio/references/b.mp4', 'video'],
    ]);
    assert.equal(calls.publish.length, 2);
    assert.equal(result.published, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.stopped, false);
    assert.deepEqual(calls.posters.map(([url]) => url), calls.capture.map(([url]) => url));
});

test('it yields between items instead of running them all at once', async () => {
    // Housekeeping must never compete with what the user is looking at — the
    // whole point is that nobody waits for a thumbnail, including now.
    const { warmReferencePosters, WARMUP_GAP_MS } = await load();
    const { calls, effects } = spy();
    await warmReferencePosters(REFS, effects);
    assert.equal(calls.pauses.length, 2);
    assert.ok(calls.pauses.every((ms) => ms === WARMUP_GAP_MS));
});

test('one unreadable reference does not end the pass', async () => {
    const { warmReferencePosters } = await load();
    const { calls, effects } = spy({
        capture: async (url) => {
            if (url.endsWith('a.png')) throw new Error('cannot decrypt');
            return 'data:image/jpeg;base64,X';
        },
    });
    const result = await warmReferencePosters(REFS, effects);
    assert.equal(result.failed, 1);
    assert.equal(result.published, 1, 'the clip after the broken picture still got a poster');
    assert.deepEqual(calls.publish.map(([url]) => url), ['/api/media-studio/references/b.mp4']);
});

test('a capture that yields nothing is counted, not published', async () => {
    const { warmReferencePosters } = await load();
    const { calls, effects } = spy({ capture: async () => null });
    const result = await warmReferencePosters(REFS, effects);
    assert.equal(result.published, 0);
    assert.equal(result.failed, 2);
    assert.deepEqual(calls.publish, [], 'nothing to hand back means nothing is sent');
});

test('a rejected publish is a failure, not a poster', async () => {
    const { warmReferencePosters } = await load();
    const { calls, effects } = spy({ publish: async () => null });
    const result = await warmReferencePosters(REFS, effects);
    assert.equal(result.published, 0);
    assert.equal(result.failed, 2);
    assert.deepEqual(calls.posters, [], 'the panel is never told about a poster that does not exist');
});

test('it stops the moment the studio goes away', async () => {
    const { warmReferencePosters } = await load();
    const { calls, effects } = spy();
    let alive = true;
    const result = await warmReferencePosters(REFS, {
        ...effects,
        // Unmounted, or the tab was hidden, after the first item.
        shouldStop: () => { const stop = !alive; alive = false; return stop; },
    });
    assert.equal(result.stopped, true);
    assert.equal(calls.capture.length, 1, 'the pass ends rather than finishing the library');
    // Whatever is still missing is picked up on the next mount.
    assert.equal(result.published, 1);
});
