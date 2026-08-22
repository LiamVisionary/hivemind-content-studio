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
        images: ['/a.png'],
        videos: [{ url: 'v1' }],
    });
    assert.equal(result.kind, 'no-exclusion');
});

test('stays quiet once the prompt says what must not carry', async () => {
    const warn = await loadWarning();
    assert.equal(warn({
        prompt: "<Video 1> is a motion reference. Its performer's appearance, clothing and setting do NOT carry.",
        images: ['/a.png'],
        videos: [{ url: 'v1' }],
    }), null);
});

// With no picture attached the clip IS the character reference — its performer
// taking over the shot is the point — so the exclusion nag would be wrong.
// An unnamed clip is still flagged: the model has to be told which label it is.
test('with no picture the clip is the character reference, so nothing need be excluded', async () => {
    const warn = await loadWarning();
    assert.equal(warn({ prompt: '<Video 1> is who she is.', videos: [{ url: 'v1' }] }), null);
    assert.equal(warn({ prompt: 'She talks to camera.', videos: [{ url: 'v1' }] }).kind, 'unnamed');
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
    const { withReferenceTags, motionReferenceWarning } = await loadDrag();
    const images = ['/a.png'];
    const videos = [{ url: 'v1' }];
    const prompt = withReferenceTags('A woman speaks to camera.', { images, videos });

    assert.match(prompt, /<Video 1>: attribute_transfer/);
    assert.equal(motionReferenceWarning({ prompt, videos, images }), null);
});

// The same button with no picture attached: the clip is the character
// reference, so the line it writes carries the person rather than excluding them.
test('with no picture the tag button makes the clip the character reference', async () => {
    const { withMotionRetentionTags, motionReferenceWarning } = await loadDrag();
    const videos = [{ url: 'v1' }];
    const prompt = withMotionRetentionTags('A woman speaks to camera.', videos);

    assert.match(prompt, /<Subject 1> is the person shown in <Video 1>: \[hair, face/);
    assert.match(prompt, /<Video 1>: fully_preserved — <Subject 1> IS the person in this clip/);
    assert.doesNotMatch(prompt, /<Video 1>: attribute_transfer/);
    assert.equal(motionReferenceWarning({ prompt, videos }), null);
    // A second clip stays a motion reference: only the first carries the person.
    const two = withMotionRetentionTags('A woman speaks to camera.', [{ url: 'v1' }, { url: 'v2' }]);
    assert.match(two, /<Video 1>: fully_preserved — <Subject 1> IS the person/);
    assert.match(two, /<Video 2>: attribute_transfer/);
    assert.match(two, /carrying the look and manner of <Video 1>, gesturing in the manner of <Video 2>/);
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
    // Retention lines, counted at line start: the subject sentence "…shown in
    // <Video 1>: [hair…" mentions the label too, and is not a claim.
    assert.equal((twice.match(/^<Video 1>:/gm) || []).length, 1);
    assert.equal((twice.match(/^<Video 2>:/gm) || []).length, 1);
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
    // drop path must pass through rather than replace. The panel no longer
    // words this itself — routing lives in lib/referenceDrop.js and the sentence
    // in referenceKinds.js, shared with the composer — so the message is
    // checked where it travels, and the panel is pinned to that route.
    const { attachDroppedReferences } = await import('../src/lib/referenceDrop.js');
    const { describeReferenceRejection } = await import('../src/studios/video/referenceKinds.js');
    const file = { name: 'clip.mp4', type: 'video/mp4', size: 150 * 1024 * 1024 };
    const { added, rejected } = await attachDroppedReferences({
        files: [file],
        taken: { videos: 0 },
        limits: { videos: 3 },
        upload: async () => { throw new Error('too large; max 100 MB'); },
    });
    assert.deepEqual(added.videos, []);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].code, 'upload-failed');
    assert.equal(rejected[0].error?.message, 'too large; max 100 MB');
    // The server states its cap but cannot state YOUR file's size; the sentence
    // carries both, or "max 100 MB" is not actionable.
    assert.equal(describeReferenceRejection(rejected[0]), 'clip.mp4 — too large; max 100 MB (150.0 MB)');
    // A refusal that arrives without a message still says the upload failed —
    // never the wording of the other two codes.
    assert.match(
        describeReferenceRejection({ name: 'clip.mp4', code: 'upload-failed', kind: 'videos', error: new Error(''), size: 0 }),
        /^clip\.mp4 — upload failed$/,
    );

    const fs = require('node:fs');
    const path = require('node:path');
    const menu = fs.readFileSync(path.join(__dirname, '../src/studios/video/ReferencesMenu.jsx'), 'utf8');
    assert.match(menu, /await attachDroppedReferences\(\{/, 'the panel files drops through the shared router');
    assert.match(menu, /toast\.error\(describeReferenceRejection\(rejection\)\)/, 'and reports each refusal in the shared words');
});

// The scaffold button. It used to write the <Video N> line alone, which left
// the two hardest parts of reference mode undiscoverable: that a clip's
// soundtrack takes an <Audio N> label of its own, and that spoken lines live in
// <d>…</d> with a speaker id. Nobody guesses either from an empty box.
test('the scaffold covers a clip, its soundtrack, and what gets said', async () => {
    const { withReferenceTags } = await import('../src/lib/h3References.js');
    const out = withReferenceTags('', { images: ['/a.png'], videos: [{ useAudio: true }], audios: [{ url: '/v.m4a' }] });
    const retention = out.split('retention_analysis:\n')[1].split('\n\n')[0].split('\n');

    // Numbered in the order the model presents them: pictures, then the clip's
    // own track immediately BEFORE the clip, then the standalone voice.
    assert.match(retention[0], /^<Picture 1>: fully_preserved —/);
    assert.match(retention[1], /^<Audio 1>: reference —/);
    assert.match(retention[2], /^<Video 1>: attribute_transfer —/);
    assert.match(retention[3], /^<Audio 2>: reference —/);

    // Markers come from the model's own vocabulary — audio and video do not
    // share a set, and writing a video marker on an audio label is nonsense.
    assert.match(out, /\(fully_copy instead/, 'the audio alternative is named');
    assert.match(out, /\(fully_preserved to reproduce/, 'the video alternative is named');
    assert.doesNotMatch(retention[1], /attribute_transfer/);

    // Speech, in the only form the model reads it.
    assert.match(out, /\(S1\) <d>\[English\] .+<\/d>/);
    // And the summary contract that says the source's words must not reappear.
    assert.match(out, /\[audio reference\]/);
});

// The scaffold used to stop at the retention lines and the dialogue stub, which
// read finished and was not: a run built that way spent half of an eight-second
// clip on invented speech, because nothing said who <Subject 1> was, what the
// shot was, or that no one else speaks. An empty composer gets the whole frame.
test('an empty composer gets the whole six-section frame, not a bare tag block', async () => {
    const { withReferenceTags } = await import('../src/lib/h3References.js');
    const out = withReferenceTags('', { images: ['/a.png'], videos: [{ useAudio: true }] });

    assert.deepEqual(
        out.split('\n').filter((line) => /^[a-z_]+:$/.test(line)),
        ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:'],
    );
    // <Subject 1> is written into every retention line, so something has to say
    // who it is and which voice belongs to it.
    assert.match(out, /<Subject 1> is the person shown in <Picture 1>: \[hair, face/);
    assert.match(out, /<Audio 1> is the voice-timbre reference for <Subject 1> \(S1\)\./);
    assert.match(out, /^\[Shot 1\] /m, 'there is a shot for the dialogue to happen in');
    // The instruction whose absence let the model talk over the empty seconds.
    assert.match(out, /no speech before or after the line above/);
});

test('a clip with no soundtrack gets a frame but no audio scaffold', async () => {
    const { withReferenceTags } = await import('../src/lib/h3References.js');
    const out = withReferenceTags('', { videos: [{ useAudio: false }] });
    assert.match(out, /^subject_definitions:/);
    // No picture, so the clip is who <Subject 1> is — not merely how they move.
    assert.match(out, /<Subject 1> is the person shown in <Video 1>/);
    assert.match(out, /<Video 1>: fully_preserved — <Subject 1> IS the person in this clip/);
    assert.doesNotMatch(out, /<Video 1>: attribute_transfer/);
    assert.doesNotMatch(out, /<Audio/);
    assert.doesNotMatch(out, /<d>/, 'nothing is speaking, so there is no line to write');
    assert.doesNotMatch(out, /\[audio reference\]/);
    assert.match(out, /No speech and no music\./);
});

test('whatever was already typed becomes the shot rather than being dropped', async () => {
    const { withReferenceTags } = await import('../src/lib/h3References.js');
    const out = withReferenceTags('She steps onto the rooftop at dusk.', { images: ['/a.png'], audios: [{ url: '/v.m4a' }] });
    assert.match(out, /^\[Shot 1\] She steps onto the rooftop at dusk\.$/m);
    assert.equal((out.match(/She steps onto the rooftop/g) || []).length, 1, 'not left dangling above the frame as well');
});

test('a line already written keeps its own slot and does not earn a second one', async () => {
    // Wrapping a bare dialogue line is the exact recovery path for a prompt
    // written before the frame existed. Folding it into [Shot 1] buried it AND
    // added the placeholder underneath, so the clip had two lines to say.
    const { withReferenceTags, unscriptedTimeWarning } = await import('../src/lib/h3References.js');
    const videos = [{ useAudio: true }];
    const bare = "(S1) <d>[English] Oh my god, I can't believe Liam made this with Hivemind OS</d>";
    const out = withReferenceTags(bare, { images: ['/a.png'], videos });

    assert.equal((out.match(/<d>/g) || []).length, 1, 'exactly one line to speak');
    assert.doesNotMatch(out, /Write the line you want spoken here/, 'no placeholder on top of a real line');
    assert.match(out, /^\(S1\) <d>\[English\] Oh my god[^\n]*<\/d>$/m, 'on its own line under the shot');
    assert.match(out, /^\[Shot 1\] Medium shot of <Subject 1>/m, 'and the shot is the default, not the line');
    // Which is the point: pressing the button is what clears the warning.
    assert.ok(unscriptedTimeWarning({ prompt: bare, durationSeconds: 8, videos }));
    assert.equal(unscriptedTimeWarning({ prompt: out, durationSeconds: 8, videos }), null);
});

test('pressing it twice does not write the scaffold twice', async () => {
    const { withReferenceTags } = await import('../src/lib/h3References.js');
    const refs = { videos: [{ useAudio: true }], audios: [{ url: '/v.m4a' }] };
    const once = withReferenceTags('', refs);
    assert.equal(withReferenceTags(once, refs), once);

    // And a label the user already wrote is left exactly as they wrote it.
    // (No picture here, so the scaffold's own line is the identity one.)
    const edited = once.replace(/^<Video 1>: fully_preserved — <Subject 1> IS[^\n]*/m, '<Video 1>: fully_preserved — copy this move.');
    assert.notEqual(edited, once, 'the scaffold wrote the clip line this test rewrites');
    const after = withReferenceTags(edited, refs);
    assert.match(after, /<Video 1>: fully_preserved — copy this move\./);
    assert.equal((after.match(/^<Video 1>:/gm) || []).length, 1);
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

// Unscripted time. The clip that failed on 2026-08-11 was eight seconds long
// with one ~4s line and nothing describing the rest; the model filled the gap
// with invented speech before reaching the written words. A voice reference
// makes it want to talk, so silence has to be asked for or the span shortened.
test('a clip much longer than its dialogue is flagged before the run', async () => {
    const { unscriptedTimeWarning } = await import('../src/lib/h3References.js');
    const line = "(S1) <d>[English] Oh my god, I can't believe Liam made this with Hivemind OS</d>";
    const videos = [{ useAudio: true }];

    const warning = unscriptedTimeWarning({ prompt: line, durationSeconds: 8, videos });
    assert.equal(warning.kind, 'unscripted');
    assert.equal(warning.spoken, 4, '12 words at ~3 a second');
    assert.equal(warning.gap, 4);

    // The same line in a clip sized for it is fine — this is the fix, so it
    // must not keep nagging once applied.
    assert.equal(unscriptedTimeWarning({ prompt: line, durationSeconds: 6, videos }), null);
});

test('saying nobody else speaks clears the warning, because that IS the fix', async () => {
    const { unscriptedTimeWarning, withReferenceTags } = await import('../src/lib/h3References.js');
    const videos = [{ useAudio: true }];
    // The scaffold writes that sentence into overall_soundscape, so pressing
    // the button must not leave a warning still sitting there.
    const scaffolded = withReferenceTags('', { videos });
    assert.equal(unscriptedTimeWarning({ prompt: scaffolded, durationSeconds: 15, videos }), null);
    assert.match(unscriptedTimeWarning({
        prompt: '(S1) <d>[English] Two words</d>', durationSeconds: 15, videos,
    })?.kind, /unscripted/);
});

test('nothing to say, and nothing to warn about without a voice', async () => {
    const { unscriptedTimeWarning } = await import('../src/lib/h3References.js');
    // A voice clone with no line at all is the sharper version of the same bug.
    assert.equal(unscriptedTimeWarning({
        prompt: 'subject_definitions:\nA woman on a rooftop.', durationSeconds: 8, videos: [{ useAudio: true }],
    }).kind, 'no-line');
    // A silent clip is allowed to be as long as it likes.
    assert.equal(unscriptedTimeWarning({
        prompt: '(S1) <d>[English] Hi</d>', durationSeconds: 15, videos: [{ useAudio: false }],
    }), null);
    // And an untouched composer is not a mistake yet.
    assert.equal(unscriptedTimeWarning({ prompt: '', durationSeconds: 8, audios: [{ url: '/v.m4a' }] }), null);
});

// The frame's subject line used to say "the person" no matter who was loaded,
// which left the model to pick a gender — and an unvoiced subject then came
// back as a generic adult male whoever was in the pictures.
test('the frame names the loaded persona\'s gender, and says "person" when it has none', async () => {
    const { withReferenceTags } = await import('../src/lib/h3References.js');
    assert.match(withReferenceTags('', { images: ['/a.png'], gender: 'female' }), /<Subject 1> is the woman shown in <Picture 1>: \[hair, face/);
    assert.match(withReferenceTags('', { images: ['/a.png'], gender: 'male' }), /<Subject 1> is the man shown in <Picture 1>/);
    // Non-binary and unset both read "person": there is no noun to add.
    assert.match(withReferenceTags('', { images: ['/a.png'], gender: 'nonbinary' }), /<Subject 1> is the person shown in <Picture 1>/);
    assert.match(withReferenceTags('', { images: ['/a.png'] }), /<Subject 1> is the person shown in <Picture 1>/);
    // With no pictures but a clip, the clip is the character reference and the
    // noun lands in front of it, the way MiniMax's own guide binds a subject to
    // a video ("<Subject N> is the young man in <Video 2>, with …").
    assert.match(withReferenceTags('', { videos: [{ useAudio: false }], gender: 'male' }), /<Subject 1> is the man shown in <Video 1>: \[hair, face/);
    assert.match(withReferenceTags('', { videos: [{ useAudio: false }] }), /<Subject 1> is the person shown in <Video 1>: \[hair, face/);
    // With no visual reference at all the noun still lands, ahead of the fill-in.
    assert.match(withReferenceTags('', { audios: [{ url: '/v.wav' }], gender: 'male' }), /<Subject 1> is a man: \[hair, face/);
    assert.match(withReferenceTags('', { audios: [{ url: '/v.wav' }] }), /<Subject 1> is \[hair, face/);
});

// The scaffold and the UGC reference brief introduce <Subject 1> with ONE
// sentence, exported so they cannot drift apart.
test('the subject line is one exported sentence, shared by the frame and the UGC brief', async () => {
    const { referenceSubjectLine, referenceVoiceLabel, referenceLabels, withReferenceTags } = await import('../src/lib/h3References.js');
    const line = referenceSubjectLine({ pictures: ['<Picture 1>', '<Picture 2>'], gender: 'male' });
    assert.equal(line, '<Subject 1> is the man shown in <Picture 1> through <Picture 2>: [hair, face, build, wardrobe — write it out. Identity holds from these words as much as from the pictures].');
    assert.ok(withReferenceTags('', { images: ['/a', '/b'], gender: 'male' }).includes(line));
    const labels = referenceLabels({ images: ['/a'], videos: [{ useAudio: true }], audios: [{ url: '/v' }] });
    assert.equal(referenceVoiceLabel(labels), '<Audio 1>', "a clip's soundtrack is the first voice heard");
    assert.equal(referenceVoiceLabel(referenceLabels({ images: ['/a'] })), '');
});

// A label is "spoken for" only by a retention line of its own. The subject
// sentence — "…shown in <Picture 1> through <Picture 3>: [hair…" — mentions the
// last picture followed by a colon, and used to count as its claim, so the last
// picture got no contract at all (found by the UGC reference brief, 2026-08-21).
test('a label mentioned mid-sentence is not a claim; only its own retention line is', async () => {
    const { withReferenceTags } = await import('../src/lib/h3References.js');
    const prompt = [
        'subject_definitions:',
        '<Subject 1> is the woman shown in <Picture 1> through <Picture 3>: [hair, face].',
        '', 'summary:', 'y', '',
        'retention_analysis:',
        '<Picture 2>: fully_preserved — written by hand.',
        '', 'detailed_description:', 'z',
    ].join('\n');
    const out = withReferenceTags(prompt, { images: ['/a', '/b', '/c'] });
    assert.match(out, /^<Picture 1>: fully_preserved/m);
    assert.match(out, /^<Picture 3>: fully_preserved/m, 'the last picture gets its contract despite the subject sentence');
    assert.equal(out.match(/^<Picture 2>:/gm).length, 1, 'a hand-written line is respected, not doubled');
    assert.match(out, /^<Picture 2>: fully_preserved — written by hand\.$/m);
});

// Compact staging. Measured 2026-08-21 on a rented 5090 (same seed, 5s clip
// @1216x704, three identity pictures, a phone clip as the motion reference): a
// reference staged 384 px wide transfers the motion as well as the node's own
// 704x1504 canvas — PSNR 23.7 dB / SSIM 0.88 between the two renders against
// ~17.4 dB / 0.80 to a no-video control — at 22 s a step instead of 42 s and
// 16.7 GiB instead of 23.0. So the row offers it; but it is a MOTION-only
// result, and with no picture attached the clip IS the character reference.
test('a compact row stages "compact", and is held to "full" while the clip is the character reference', async () => {
    const { referenceVideoCanvas, referenceVideoCompactLocked } = await import('../src/lib/h3References.js');
    const pictures = ['/api/media-studio/references/face.png'];

    // Off by default: a row that never touched the switch stages full.
    assert.equal(referenceVideoCanvas({ url: '/walk.mp4' }, { images: pictures }), 'full');
    assert.equal(referenceVideoCanvas({ url: '/walk.mp4', compact: false }, { images: pictures }), 'full');
    assert.equal(referenceVideoCanvas('/walk.mp4', { images: pictures }), 'full', 'a bare url has no switch');
    // Switched on, with a picture carrying the identity: compact.
    assert.equal(referenceVideoCanvas({ url: '/walk.mp4', compact: true }, { images: pictures }), 'compact');
    // No picture — the clip is the character reference, identity needs pixels,
    // and the switch is HELD rather than honoured, however the row is set.
    assert.equal(referenceVideoCanvas({ url: '/walk.mp4', compact: true }, { images: [] }), 'full');
    assert.equal(referenceVideoCanvas({ url: '/walk.mp4', compact: true }), 'full');
    assert.equal(referenceVideoCanvas({ url: '/walk.mp4', compact: true }, { images: ['', null] }), 'full', 'junk picture slots are not pictures');
    assert.equal(referenceVideoCompactLocked({ images: [] }), true);
    assert.equal(referenceVideoCompactLocked({ images: pictures }), false);
    assert.equal(referenceVideoCompactLocked(), true);
});

test('the switch changes neither the labels nor the budget — staging size is not a reference', async () => {
    const { referenceLabels, referenceBudgetReport } = await import('../src/lib/h3References.js');
    const plain = [{ url: '/walk.mp4', useAudio: true }];
    const compact = [{ url: '/walk.mp4', useAudio: true, compact: true }];
    assert.deepEqual(referenceLabels({ images: ['/a'], videos: compact }), referenceLabels({ images: ['/a'], videos: plain }));
    const durations = { '/walk.mp4': 6 };
    assert.deepEqual(
        referenceBudgetReport({ images: ['/a'], videos: compact, durations }),
        referenceBudgetReport({ images: ['/a'], videos: plain, durations }),
    );
});

test('each video row carries a Compact switch beside its sound switch, held off without a picture', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const menu = fs.readFileSync(path.join(__dirname, '../src/studios/video/ReferencesMenu.jsx'), 'utf8');

    // The row: a per-video toggle, with the hint that says what it buys and
    // when it is off, and a disabled state that gives the reason instead.
    const sound = menu.indexOf("{zh() ? '含原声' : 'sound'}");
    const compact = menu.indexOf("{zh() ? '紧凑' : 'Compact'}");
    assert.ok(sound > 0 && compact > sound, 'Compact sits beside the sound toggle on the video row');
    assert.match(menu, /Stage this clip small \(384 px\) — same motion, 3x cheaper\. Off when the clip is the character reference\./);
    assert.match(menu, /Off while no picture is attached: this clip is the character reference, and identity needs pixels\./);
    assert.match(menu, /disabled=\{compactLocked\}/);
    assert.match(menu, /aria-pressed=\{!compactLocked && Boolean\(item\?\.compact\)\}/, 'a locked row reads as off whatever it holds');

    // The lock is the shared rule, not a second opinion: no picture attached.
    assert.match(menu, /import \{[^}]*referenceVideoCompactLocked[^}]*\} from '\.\.\/\.\.\/lib\/h3References\.js'/s);
    assert.match(menu, /compactLocked=\{kind === 'videos' && referenceVideoCompactLocked\(\{ images \}\)\}/);
    // Toggling flips THAT row only, the same way the sound switch does.
    assert.match(menu, /onToggleCompact=\{\(index\) => emit\('videos', videos\.map\(\(item, i\) => \(\s*i === index \? \{ \.\.\.item, compact: !item\.compact \} : item\s*\)\)\)\}/);
    // Default OFF on every way a clip arrives — picked, dropped, or prepped in
    // place (which spreads the row and so keeps what it had).
    assert.match(menu, /\{ url, name, useAudio: false, compact: false \}/);
    assert.match(menu, /\(\{ \.\.\.item, useAudio: false, compact: false \}\)/);
});
