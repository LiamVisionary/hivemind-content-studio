const test = require('node:test');
const assert = require('node:assert/strict');

// The panel shows each attached reference the label the MODEL will give it, and
// that numbering is not one counter per list: MiniMaxH3ReferenceToVideo presents
// pictures, then each video (a switched-on soundtrack claiming an <Audio N> just
// before its <Video N>), then the standalone clips. A prompt written from the
// wrong labels addresses the wrong reference.
async function loadLabels() {
    const module = await import('../src/lib/h3References.js');
    return module.referenceLabels;
}

test('pictures, videos and voice clips number within their own kind', async () => {
    const referenceLabels = await loadLabels();
    const labels = referenceLabels({
        images: ['a', 'b'],
        videos: [{ url: 'v1' }],
        audios: [{ url: 'a1' }, { url: 'a2' }],
    });

    assert.deepEqual(labels.images, ['<Picture 1>', '<Picture 2>']);
    assert.deepEqual(labels.videos, [{ video: '<Video 1>', audio: '' }]);
    assert.deepEqual(labels.audios, ['<Audio 1>', '<Audio 2>']);
});

test("a reference video's own soundtrack takes the <Audio N> ahead of standalone clips", async () => {
    const referenceLabels = await loadLabels();
    const labels = referenceLabels({
        images: ['sheet'],
        videos: [{ url: 'v1', useAudio: true }],
        audios: [{ url: 'voice' }],
    });

    // The clip's soundtrack is <Audio 1>; the voice clip is pushed to <Audio 2>.
    assert.deepEqual(labels.videos, [{ video: '<Video 1>', audio: '<Audio 1>' }]);
    assert.deepEqual(labels.audios, ['<Audio 2>']);
});

test('only the videos with sound consume audio ordinals', async () => {
    const referenceLabels = await loadLabels();
    const labels = referenceLabels({
        images: [],
        videos: [{ url: 'v1' }, { url: 'v2', useAudio: true }, { url: 'v3' }],
        audios: [{ url: 'voice' }],
    });

    assert.deepEqual(labels.videos, [
        { video: '<Video 1>', audio: '' },
        { video: '<Video 2>', audio: '<Audio 1>' },
        { video: '<Video 3>', audio: '' },
    ]);
    assert.deepEqual(labels.audios, ['<Audio 2>']);
});

// A reference video takes over the shot when the prompt doesn't hold it back:
// measured on the rental, the same clip under the same attribute_transfer tag
// kept our character with a describing + excluding prompt and replaced her with
// the reference performer without one. The panel warns before the run.
async function loadWarning() {
    const module = await import('../src/lib/h3References.js');
    return module.motionReferenceWarning;
}

test('no motion clip attached means nothing to warn about', async () => {
    const warn = await loadWarning();
    assert.equal(warn({ prompt: '', videos: [] }), null);
});

test('warns when the prompt never names the attached motion clip', async () => {
    const warn = await loadWarning();
    const result = warn({ prompt: 'A woman speaks to camera.', videos: [{ url: 'v1' }] });
    assert.equal(result.kind, 'unnamed');
    assert.deepEqual(result.labels, ['<Video 1>']);
});

test('names every unnamed clip, not just the first', async () => {
    const warn = await loadWarning();
    const result = warn({
        prompt: '<Video 1> drives her gestures.',
        videos: [{ url: 'v1' }, { url: 'v2' }],
    });
    assert.deepEqual(result.labels, ['<Video 2>']);
});

test('warns when the clip is named but nothing is excluded', async () => {
    const warn = await loadWarning();
    const result = warn({
        prompt: '<Video 1> drives her gestures.',
        videos: [{ url: 'v1' }],
    });
    assert.equal(result.kind, 'no-exclusion');
});

test('stays quiet once the prompt says what must not carry', async () => {
    const warn = await loadWarning();
    assert.equal(warn({
        prompt: "<Video 1> is a motion reference. Its performer's appearance, clothing and setting do NOT carry.",
        videos: [{ url: 'v1' }],
    }), null);
});
