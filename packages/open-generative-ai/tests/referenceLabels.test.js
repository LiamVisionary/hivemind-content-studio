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

// Attaching the same source twice. Nothing about a reference varies per slot —
// the item carries a url, a filename and (video only) its soundtrack switch,
// which belongs to the one row — so a repeat sent the model one picture as two
// <Picture N>s, burned a slot, and collided the rows' React keys.
test('a source already in the row is found whatever shape the row holds', async () => {
    const { referenceAttachIndex } = await import('../src/lib/h3References.js');

    // Pictures are bare urls; clips are objects, and the extra per-slot state a
    // clip carries (name, soundtrack) does not make it a different attachment.
    assert.equal(referenceAttachIndex(['/a.png', '/b.png'], '/b.png'), 1);
    assert.equal(referenceAttachIndex(['/a.png'], '/c.png'), -1);
    assert.equal(referenceAttachIndex([{ url: '/v.mp4', name: 'take 1', useAudio: true }], '/v.mp4'), 0);
    assert.equal(referenceAttachIndex([{ url: '/voice.m4a', name: 'her' }], '/voice.m4a'), 0);

    assert.equal(referenceAttachIndex([], '/a.png'), -1);
    assert.equal(referenceAttachIndex(['/a.png'], ''), -1);
});

test('the panel names the label that already holds it, and never attaches twice', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const menu = fs.readFileSync(path.join(__dirname, '../src/studios/video/ReferencesMenu.jsx'), 'utf8');

    // The check runs BEFORE the row-full return, or a saved picture clicked
    // into a full row would come back as silence rather than "already attached".
    const guard = menu.indexOf('const attached = referenceAttachIndex(current, url);');
    assert.ok(guard > 0, 'attach() consults the row it is adding to');
    assert.ok(guard < menu.indexOf('if (current.length >= limits[kind]) return;'));
    assert.match(menu.slice(guard), /Already attached as \$\{tag\}/);
});

test('row keys survive a list that arrives with the same source twice', async () => {
    const { referenceRowKeys } = await import('../src/lib/h3References.js');

    // The url IS the key, so removing one reference leaves the others mounted
    // with their decrypted previews intact.
    assert.deepEqual(referenceRowKeys(['/a.png', '/b.png']), ['/a.png', '/b.png']);

    // A restored generation sealed before attach() deduped can still hand over
    // a repeat, and duplicate keys are a React error rather than a cosmetic one.
    const keys = referenceRowKeys(['/a.png', '/b.png', '/a.png', '/a.png']);
    assert.equal(new Set(keys).size, 4);
    assert.equal(keys[0], '/a.png', 'the first of each stays bare');

    // Clips key off their url too, and an entry with no url at all still keys.
    assert.deepEqual(referenceRowKeys([{ url: '/v.mp4' }, {}]), ['/v.mp4', 'row-1']);
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

// Three unrelated reasons a dropped file cannot be attached, told apart.
// They used to collapse into one "Not usable as a reference: <name>", so a clip
// the server had refused with a perfectly clear explanation ("too large; max
// 100 MB") came back unexplained — and a full row read as a broken file.
test('a rejected drop reports WHICH failure it was', async () => {
    const { referenceDropBlock } = await import('../src/lib/h3References.js');

    assert.equal(referenceDropBlock({ kind: null }), 'unsupported');
    assert.equal(referenceDropBlock({ kind: 'videos', taken: 3, limit: 3 }), 'full');
    assert.equal(referenceDropBlock({ kind: 'videos', taken: 2, limit: 3 }), null);
    // A row whose limit the graph did not wire holds nothing at all.
    assert.equal(referenceDropBlock({ kind: 'audios', taken: 0, limit: 0 }), 'full');

    // And a server refusal is neither: it carries its own message, which the
    // drop handler must pass through rather than replace.
    const fs = require('node:fs');
    const path = require('node:path');
    const menu = fs.readFileSync(path.join(__dirname, '../src/studios/video/ReferencesMenu.jsx'), 'utf8');
    assert.match(menu, /reason: `\$\{err\?\.message/);
});

// The scaffold button. It used to write the <Video N> line alone, which left
// the two hardest parts of reference mode undiscoverable: that a clip's
// soundtrack takes an <Audio N> label of its own, and that spoken lines live in
// <d>…</d> with a speaker id. Nobody guesses either from an empty box.
test('the scaffold covers a clip, its soundtrack, and what gets said', async () => {
    const { withReferenceTags } = await import('../src/lib/h3References.js');
    const out = withReferenceTags('', { videos: [{ useAudio: true }], audios: [{ url: '/v.m4a' }] });
    const lines = out.split('\n').filter(Boolean);

    // Numbered in the order the model presents them: the clip's own track
    // immediately BEFORE the clip, then the standalone voice.
    assert.match(lines[0], /^<Audio 1>: reference —/);
    assert.match(lines[1], /^<Video 1>: attribute_transfer —/);
    assert.match(lines[2], /^<Audio 2>: reference —/);

    // Markers come from the model's own vocabulary — audio and video do not
    // share a set, and writing a video marker on an audio label is nonsense.
    assert.match(out, /\(fully_copy instead/, 'the audio alternative is named');
    assert.match(out, /\(fully_preserved to reproduce/, 'the video alternative is named');
    assert.doesNotMatch(out.split('\n')[0], /attribute_transfer/);

    // Speech, in the only form the model reads it.
    assert.match(out, /\(S1\) <d>\[English\] .+<\/d>/);
    // And the summary contract that says the source's words must not reappear.
    assert.match(out, /\[audio reference\]/);
});

test('a clip with no soundtrack gets no audio scaffold', async () => {
    const { withReferenceTags } = await import('../src/lib/h3References.js');
    const out = withReferenceTags('', { videos: [{ useAudio: false }] });
    assert.match(out, /^<Video 1>: attribute_transfer/);
    assert.doesNotMatch(out, /<Audio/);
    assert.doesNotMatch(out, /<d>/, 'nothing is speaking, so there is no line to write');
    assert.doesNotMatch(out, /\[audio reference\]/);
});

test('pressing it twice does not write the scaffold twice', async () => {
    const { withReferenceTags } = await import('../src/lib/h3References.js');
    const refs = { videos: [{ useAudio: true }], audios: [{ url: '/v.m4a' }] };
    const once = withReferenceTags('', refs);
    assert.equal(withReferenceTags(once, refs), once);

    // And a label the user already wrote is left exactly as they wrote it.
    const edited = once.replace(/<Video 1>: attribute_transfer[^\n]*/, '<Video 1>: fully_preserved — copy this move.');
    const after = withReferenceTags(edited, refs);
    assert.match(after, /<Video 1>: fully_preserved — copy this move\./);
    assert.equal((after.match(/<Video 1>:/g) || []).length, 1);
});

test('each piece lands in its own section when the six-section format is in use', async () => {
    const { withReferenceTags } = await import('../src/lib/h3References.js');
    const prompt = [
        'subject_definitions:', '<Subject 1> is a courier.', '',
        'summary:', 'She crosses a rooftop.', '',
        'retention_analysis:', '<Picture 1>: fully_preserved — same person.', '',
        'detailed_description:', '[Shot 1] She walks.',
    ].join('\n');
    const out = withReferenceTags(prompt, { videos: [{ useAudio: true }] });
    const lines = out.split('\n');

    assert.match(lines[lines.indexOf('summary:') + 1], /\[audio reference\]/);
    assert.match(lines[lines.indexOf('retention_analysis:') + 1], /^<Audio 1>:/);
    assert.match(lines[lines.indexOf('detailed_description:') + 1], /^\(S1\) <d>/);
    // The user's own retention line survives.
    assert.match(out, /<Picture 1>: fully_preserved — same person\./);
});
