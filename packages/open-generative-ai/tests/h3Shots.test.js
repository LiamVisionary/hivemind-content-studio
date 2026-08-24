const test = require('node:test');
const assert = require('node:assert/strict');

// The timeline inside one generation: [Shot N], stamped cuts, stamped beats,
// and speech in H3's own <d> grammar. The serialized text is the contract.
const load = () => import('../src/lib/h3Shots.js');

test('a timecode is mm:ss.mmm, the form H3 examples use', async () => {
    const { timecode } = await load();
    assert.equal(timecode(0), '00:00.000');
    assert.equal(timecode(5), '00:05.000');
    assert.equal(timecode(65.25), '01:05.250');
});

test('the first shot opens at zero and carries no cut stamp', async () => {
    const { newShot, shotText } = await load();
    const shot = newShot();
    shot.action = 'she looks up';
    assert.equal(shotText(shot, 0), '[Shot 1] She looks up.');
});

test('a later shot states its cut, its verb and what it lands on', async () => {
    const { newShot, shotText } = await load();
    const shot = newShot();
    shot.cutSec = 5.5;
    shot.transition = 'the shot cross-dissolves to';
    shot.cutTo = 'a wide of the empty street';
    assert.match(shotText(shot, 1), /^\[Shot 2\] At 00:05\.500, the shot cross-dissolves to a wide of the empty street\./);
});

test('with no landing written, the cut falls back to the builder framing', async () => {
    const { newShot, shotText } = await load();
    const shot = newShot();
    shot.cutSec = 3;
    shot.camera = { ...shot.camera, framing: 'wide' };
    assert.match(shotText(shot, 1, { subject: 'Ada' }), /the shot cuts to a wide shot shows Ada in full/);
});

test('speaker ids number by who is heard first, not by who matters', async () => {
    const { newShot, newDialogue, speakerIds } = await load();
    const one = newShot();
    const dana = newDialogue('Dana'); dana.line = 'wait';
    one.dialogue = [dana];
    const two = newShot();
    const ada = newDialogue('Ada'); ada.line = 'no';
    const danaAgain = newDialogue('Dana'); danaAgain.line = 'please';
    two.dialogue = [ada, danaAgain];
    const ids = speakerIds([one, two]);
    assert.equal(ids.get('Dana'), 'S1');
    assert.equal(ids.get('Ada'), 'S2');
});

test('a line with no words earns no speaker id at all', async () => {
    const { newShot, newDialogue, speakerIds } = await load();
    const shot = newShot();
    const silent = newDialogue('Ghost');
    const spoken = newDialogue('Ada'); spoken.line = 'hello';
    shot.dialogue = [silent, spoken];
    const ids = speakerIds([shot]);
    assert.equal(ids.has('Ghost'), false);
    assert.equal(ids.get('Ada'), 'S1');
});

test('a spoken line carries its language tag, delivery and speaker id', async () => {
    const { newDialogue, dialogueLine } = await load();
    const line = newDialogue('<Subject 1>');
    line.line = "I'm not opening it.";
    line.delivery = 'in a flat, tired voice';
    assert.equal(
        dialogueLine(line, 'S1'),
        "<Subject 1> (S1) says in a flat, tired voice: <d>[English] I'm not opening it.</d>",
    );
});

test('carry-over and cut-off use H3 tags, on the right side of the line', async () => {
    const { newDialogue, dialogueLine } = await load();
    const out = newDialogue('Ada');
    out.line = 'listen to me —';
    out.carry = 'out';
    out.cutoff = true;
    assert.equal(dialogueLine(out, 'S1'), 'Ada (S1) says: <d>[English] listen to me — <scenetrans> <cutoff></d>');

    const arriving = newDialogue('Ada');
    arriving.line = '— you never listen';
    arriving.carry = 'in';
    assert.equal(dialogueLine(arriving, 'S1'), 'Ada (S1) says: <d>[English] <scenetrans> — you never listen</d>');
});

test('voiceover and off-screen are stated as manner, not invented staging', async () => {
    const { newDialogue, dialogueLine } = await load();
    const line = newDialogue('Narrator');
    line.line = 'It began on a Tuesday.';
    line.voiceover = true;
    assert.match(dialogueLine(line, 'S1'), /says in voiceover: <d>\[English\]/);
});

test('a timed beat is stamped in seconds into the SHOT, not the clip', async () => {
    const { newShot, newBeat, shotText } = await load();
    const shot = newShot();
    shot.beats = [newBeat(0, 2.5), newBeat(2.5, 6)];
    shot.beats[0].action = 'she reaches for the handle';
    shot.beats[1].action = 'the door gives way';
    const text = shotText(shot, 0);
    assert.match(text, /For the first 2\.50 seconds, she reaches for the handle\./);
    assert.match(text, /From 2\.50 to 6\.00 seconds into the shot, the door gives way\./);
});

test('a line linked to a beat speaks inside that beat', async () => {
    const { newShot, newBeat, newDialogue, speakerIds, shotText } = await load();
    const shot = newShot();
    const beat = newBeat(1, 3);
    beat.action = 'she turns toward him';
    const line = newDialogue('Ada');
    line.line = 'you came back';
    line.beatId = beat.id;
    shot.beats = [beat];
    shot.dialogue = [line];
    const text = shotText(shot, 0, { ids: speakerIds([shot]) });
    assert.match(text, /From 1\.00 to 3\.00 seconds into the shot, she turns toward him; during this action, Ada \(S1\) says: <d>\[English\] you came back<\/d>/);
});

test('beats are emitted in stamped order however they were entered', async () => {
    const { newShot, newBeat, shotText } = await load();
    const shot = newShot();
    const late = newBeat(4, 6); late.action = 'the light goes out';
    const early = newBeat(0, 4); early.action = 'she crosses the room';
    shot.beats = [late, early];
    const text = shotText(shot, 0);
    assert.ok(text.indexOf('she crosses the room') < text.indexOf('the light goes out'));
});

test('the mode is derived from what is attached, never from a dropdown', async () => {
    const { h3Mode } = await load();
    assert.equal(h3Mode({}), 'text');
    assert.equal(h3Mode({ firstFrame: 'a.jpg' }), 'first');
    assert.equal(h3Mode({ lastFrame: 'z.jpg' }), 'last');
    assert.equal(h3Mode({ firstFrame: 'a.jpg', lastFrame: 'z.jpg' }), 'flf');
    assert.equal(h3Mode({ firstFrame: 'a.jpg', images: ['r.jpg'] }), 'reference');
    assert.equal(h3Mode({ audios: [{ url: 'v.wav' }] }), 'reference');
});

test('a frame-anchored run opens with the alignment sentence H3 needs', async () => {
    const { alignmentHeader } = await load();
    assert.match(alignmentHeader('first'), /at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced/);
    assert.match(
        alignmentHeader('flf', { shotCount: 3, durationSeconds: 10 }),
        /<Picture 2> \(from \[Shot 3\]\) aligns with the 10\.00-second mark/,
    );
    assert.match(
        alignmentHeader('last', { shotCount: 2, durationSeconds: 8 }),
        /<Picture 1> \(from \[Shot 2\]\) aligns with the 8\.00-second mark/,
    );
    assert.equal(alignmentHeader('text'), '');
    assert.equal(alignmentHeader('reference'), '');
});

test('reference mode composes the six sections; the other modes compose three fields', async () => {
    const { newShot, composeH3Prompt } = await load();
    const shot = newShot();
    shot.action = 'she waits';

    const six = composeH3Prompt({
        mode: 'reference',
        shots: [shot],
        subjects: ['<Subject 1> is a woman in a red coat.'],
        retention: ['<Picture 1>: attribute_transfer — identity only.'],
        summary: 'A woman waits.',
        soundscape: 'Rain on a window.',
    });
    for (const section of ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:']) {
        assert.ok(six.includes(section), `missing ${section}`);
    }
    assert.ok(six.includes('non_diegetic_music:\nN/A'));

    const three = composeH3Prompt({ mode: 'text', shots: [shot], soundscape: 'Rain.' });
    assert.match(three, /^integrated_multimodal_description: \[Shot 1\] She waits\./);
    assert.ok(!three.includes('subject_definitions'));
});

test('a frame-anchored prompt is opened by its alignment sentence', async () => {
    const { newShot, composeH3Prompt } = await load();
    const shot = newShot();
    shot.action = 'she steps out';
    const text = composeH3Prompt({ mode: 'first', shots: [shot], soundscape: 'Street.' });
    assert.match(text, /^For the target video, at 0\.00 seconds/);
    assert.ok(text.includes('integrated_multimodal_description:'));
});

test('an unwritten summary is derived from the shots rather than left blank', async () => {
    const { newShot, composeH3Prompt } = await load();
    const a = newShot(); a.action = 'she crosses the road';
    const b = newShot(); b.cutSec = 4;
    const text = composeH3Prompt({ mode: 'reference', shots: [a, b], durationSeconds: 8 });
    assert.match(text, /summary:\nShe crosses the road, in 2 shots over 8\.00 seconds\./);
});

test('the timeline end is the furthest of duration, cuts and beats', async () => {
    const { newShot, newBeat, timelineEndSec } = await load();
    const a = newShot();
    a.beats = [newBeat(0, 4)];
    const b = newShot(); b.cutSec = 12;
    assert.equal(timelineEndSec([a, b], 8), 12);
    assert.equal(timelineEndSec([a], 8), 8);
});

// The reverse direction: a prompt that already has [Shot N] blocks can seed the
// builder, so it does not open on one blank shot over three written ones.
test('the shots already written into a prompt are read back out, stamps and all', async () => {
    const { parseShotBlocks, timelineShotsFromPrompt, newShot, composeH3Prompt } = await load();
    assert.deepEqual(parseShotBlocks(''), []);
    assert.deepEqual(parseShotBlocks('A quiet street, no shot markers.'), []);

    const prompt = [
        'integrated_multimodal_description: Handheld documentary footage. [Shot 1] She looks up from the letter. (S1) says: <d>[English] Not yet.</d>',
        '[Shot 2] At 00:05.500, the shot cross-dissolves to a wide of the empty street. Rain starts.',
        '[Shot 3] At 00:10.000, the shot cuts to her hands. She folds the page.',
        '',
        'overall_soundscape: rain on glass',
        '',
        'non_diegetic_music: N/A',
    ].join('\n');
    const blocks = parseShotBlocks(prompt);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].cutSec, 0);
    assert.match(blocks[0].text, /^She looks up from the letter\./);
    assert.match(blocks[0].text, /<d>\[English\] Not yet\.<\/d>$/, 'dialogue stays in the text');
    assert.equal(blocks[1].cutSec, 5.5);
    assert.equal(blocks[1].transition, 'the shot cross-dissolves to');
    assert.equal(blocks[1].cutTo, 'a wide of the empty street');
    assert.equal(blocks[1].text, 'Rain starts.');
    assert.equal(blocks[2].cutSec, 10);
    assert.equal(blocks[2].transition, 'the shot cuts to');
    assert.equal(blocks[2].cutTo, 'her hands');
    assert.equal(blocks[2].text, 'She folds the page.', 'the section headers after the last shot are not swallowed');

    // And they become builder shots that re-serialize with the same cuts.
    const shots = timelineShotsFromPrompt(prompt);
    assert.equal(shots.length, 3);
    assert.equal(shots[1].cutSec, 5.5);
    assert.equal(shots[2].cutTo, 'her hands');
    const out = composeH3Prompt({ mode: 'text', shots });
    assert.match(out, /\[Shot 2\] At 00:05\.500, the shot cross-dissolves to a wide of the empty street\. Rain starts\./);
    assert.match(out, /\[Shot 3\] At 00:10\.000, the shot cuts to her hands\. She folds the page\./);
    // A fresh shot is still fresh.
    assert.equal(newShot().cutSec, 0);
});
