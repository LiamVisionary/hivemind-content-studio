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

// Dragging: the row a file lands in, and the highlight that promises it.
async function loadDrag() {
    const module = await import('../src/lib/h3References.js');
    return module;
}

test('a dragged file routes to the row that matches its type', async () => {
    const { referenceKindForFile } = await loadDrag();
    assert.equal(referenceKindForFile({ type: 'image/png', name: 'a.png' }), 'images');
    assert.equal(referenceKindForFile({ type: 'video/quicktime', name: 'a.mov' }), 'videos');
    assert.equal(referenceKindForFile({ type: 'audio/x-m4a', name: 'a.m4a' }), 'audios');
});

test('falls back to the extension when the drag carries no usable type', async () => {
    const { referenceKindForFile } = await loadDrag();
    // Finder and some pickers hand over application/octet-stream or nothing.
    assert.equal(referenceKindForFile({ type: 'application/octet-stream', name: 'voice.m4a' }), 'audios');
    assert.equal(referenceKindForFile({ type: '', name: 'clip.MP4' }), 'videos');
    assert.equal(referenceKindForFile({ type: '', name: 'notes.pdf' }), null);
    assert.equal(referenceKindForFile({ type: '', name: '' }), null);
});

test('the highlight reads every kind the drag is carrying', async () => {
    const { referenceKindsInDrag } = await loadDrag();
    const dt = { items: [
        { kind: 'file', type: 'image/png' },
        { kind: 'file', type: 'audio/wav' },
        { kind: 'string', type: 'text/plain' },
    ] };
    assert.deepEqual(referenceKindsInDrag(dt).sort(), ['audios', 'images']);
    assert.deepEqual(referenceKindsInDrag(null), []);
});

// The retention-tag button: it has to produce a line that clears the warning.
test('the tag button writes a line that names the clip AND excludes its look', async () => {
    const { withMotionRetentionTags, motionReferenceWarning } = await loadDrag();
    const videos = [{ url: 'v1' }];
    const prompt = withMotionRetentionTags('A woman speaks to camera.', videos);

    assert.match(prompt, /<Video 1>: attribute_transfer/);
    assert.equal(motionReferenceWarning({ prompt, videos }), null);
});

test('the tag button lands inside retention_analysis when the section exists', async () => {
    const { withMotionRetentionTags } = await loadDrag();
    const prompt = withMotionRetentionTags(
        'subject_definitions:\n<Subject 1> is a courier.\n\nretention_analysis:\n<Picture 1>: fully_preserved — same person.\n\ndetailed_description:\n[Shot 1] She walks.',
        [{ url: 'v1' }],
    );
    const lines = prompt.split('\n');
    assert.equal(lines[lines.indexOf('retention_analysis:') + 1].startsWith('<Video 1>:'), true);
    assert.ok(prompt.indexOf('<Video 1>:') < prompt.indexOf('detailed_description:'));
});

test('the tag button never duplicates a tag it already wrote', async () => {
    const { withMotionRetentionTags } = await loadDrag();
    const once = withMotionRetentionTags('A shot.', [{ url: 'v1' }]);
    assert.equal(withMotionRetentionTags(once, [{ url: 'v1' }]), once);
});

test('the tag button covers a second clip without touching the first', async () => {
    const { withMotionRetentionTags } = await loadDrag();
    const once = withMotionRetentionTags('A shot.', [{ url: 'v1' }]);
    const twice = withMotionRetentionTags(once, [{ url: 'v1' }, { url: 'v2' }]);
    assert.equal((twice.match(/<Video 1>:/g) || []).length, 1);
    assert.equal((twice.match(/<Video 2>:/g) || []).length, 1);
});
