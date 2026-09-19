const test = require('node:test');
const assert = require('node:assert/strict');

// The gate. H3 fails quietly, so every finding here is a failure that would
// otherwise only show up in the finished clip.
const load = () => import('../src/lib/h3PromptCheck.js');

const codes = (result) => result.findings.map((finding) => finding.code);
const find = (result, code) => result.findings.find((finding) => finding.code === code);

const SIX = [
    'subject_definitions:',
    '<Subject 1> is a woman in a red coat.',
    '',
    'summary:',
    'She waits.',
    '',
    'retention_analysis:',
    '<Picture 1>: attribute_transfer — identity only.',
    '',
    'detailed_description:',
    '[Shot 1] A wide shot of <Subject 1> against a wet street.',
    '',
    'overall_soundscape:',
    'Rain on tarmac.',
    '',
    'non_diegetic_music:',
    'N/A',
].join('\n');

test('an empty prompt is not an error — there is nothing to be wrong yet', async () => {
    const { checkH3Prompt } = await load();
    const result = checkH3Prompt({ prompt: '   ' });
    assert.equal(result.ok, true);
    assert.deepEqual(codes(result), ['empty']);
});

test('a complete six-section reference prompt passes clean', async () => {
    const { checkH3Prompt } = await load();
    const result = checkH3Prompt({ prompt: SIX, images: ['a.jpg'], durationSeconds: 10 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.findings, []);
    assert.equal(result.mode, 'reference');
    assert.equal(result.sections.length, 6);
});

test('references attached with no sections written is called out', async () => {
    const { checkH3Prompt } = await load();
    const result = checkH3Prompt({ prompt: 'A woman in a red coat waits, and <Picture 1> is her.', images: ['a.jpg'] });
    assert.ok(codes(result).includes('no-sections'));
});

test('sections in the wrong order are a real failure, not a style note', async () => {
    const { checkH3Prompt } = await load();
    const jumbled = 'detailed_description:\n[Shot 1] She waits.\n\nsummary:\nShe waits.\n\noverall_soundscape:\nRain.';
    const result = checkH3Prompt({ prompt: jumbled });
    assert.ok(codes(result).includes('sections-out-of-order'));
});

test('a cut stamped at or past the end never renders', async () => {
    const { checkH3Prompt } = await load();
    const late = `${SIX}\n[Shot 2] At 00:10.000, the shot cuts to a close-up.`;
    const result = checkH3Prompt({ prompt: late, images: ['a.jpg'], durationSeconds: 10 });
    const finding = find(result, 'cut-past-end');
    assert.ok(finding);
    assert.equal(finding.level, 'error');
    assert.equal(finding.shot, 2);
});

test('cuts that go backwards are caught', async () => {
    const { checkH3Prompt } = await load();
    const text = '[Shot 1] Open.\n[Shot 2] At 00:06.000, the shot cuts to a close-up.\n[Shot 3] At 00:03.000, the shot cuts to a wide.';
    const result = checkH3Prompt({ prompt: text, durationSeconds: 12 });
    assert.equal(find(result, 'cut-out-of-order').level, 'error');
});

test('shot markers that skip a number are caught', async () => {
    const { checkH3Prompt } = await load();
    const result = checkH3Prompt({ prompt: '[Shot 1] Open.\n[Shot 3] At 00:04.000, the shot cuts to a wide.', durationSeconds: 10 });
    assert.equal(find(result, 'shot-number').found, 3);
});

// The keyframe anchor sentence names the shot a pinned picture belongs to, and
// prompt_profiles._MINIMAX_H3_I2VA tells the helper to emit it verbatim above
// the fields. Read as a header it made every image-to-video prompt report a
// numbering skip and a first shot with no cut — two errors on a form the studio
// writes itself, on the prompt that was correct.
test('the keyframe anchor cites a shot without opening one', async () => {
    const { checkH3Prompt, shotMarkers } = await load();
    const anchor = 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
    const text = `${anchor}\n\nintegrated_multimodal_description: [Shot 1] She runs.\n[Shot 2] At 00:03.000, she stops.\n\noverall_soundscape: Footfalls.\n\nnon_diegetic_music: N/A`;
    assert.deepEqual(shotMarkers(text).map((shot) => shot.number), [1, 2]);
    const result = checkH3Prompt({ prompt: text, durationSeconds: 10 });
    assert.equal(find(result, 'shot-number'), undefined);
    assert.equal(find(result, 'shot-no-cut'), undefined);
    // Only that one construction is excused: a marker is otherwise a header
    // wherever it sits, because the shipped prompts open shots mid-paragraph.
    assert.deepEqual(shotMarkers('x [Shot 1] a. Then [Shot 2] At 00:04.500, b').map((s) => s.number), [1, 2]);
});

test('a shot with no cut stamp is a warning, because H3 has to guess', async () => {
    const { checkH3Prompt } = await load();
    const result = checkH3Prompt({ prompt: '[Shot 1] Open.\n[Shot 2] A close-up.', durationSeconds: 10 });
    assert.equal(find(result, 'shot-no-cut').shot, 2);
});

test('a dialogue block with no language tag is an error', async () => {
    const { checkH3Prompt } = await load();
    const result = checkH3Prompt({ prompt: '[Shot 1] She speaks. Ada (S1) says: <d> hello</d>' });
    assert.equal(find(result, 'dialogue-no-language').level, 'error');
});

test('unbalanced dialogue tags are an error', async () => {
    const { checkH3Prompt } = await load();
    const result = checkH3Prompt({ prompt: '[Shot 1] Ada says: <d>[English] hello' });
    const finding = find(result, 'dialogue-unbalanced');
    assert.equal(finding.opens, 1);
    assert.equal(finding.closes, 0);
});

test('a carry-over line with nothing to carry into is flagged', async () => {
    const { checkH3Prompt } = await load();
    const text = '[Shot 1] Ada says: <d>[English] listen to me — <scenetrans></d>\n[Shot 2] At 00:04.000, the shot cuts to a wide.';
    const result = checkH3Prompt({ prompt: text, durationSeconds: 10 });
    const finding = find(result, 'scenetrans-unpaired');
    assert.equal(finding.out, 1);
    assert.equal(finding.in, 0);
});

test('a paired carry-over is left alone', async () => {
    const { checkH3Prompt } = await load();
    const text = [
        '[Shot 1] Ada says: <d>[English] listen to me — <scenetrans></d>',
        '[Shot 2] At 00:04.000, the shot cuts to a wide. Ada says: <d>[English] <scenetrans> — you never listen</d>',
    ].join('\n');
    const result = checkH3Prompt({ prompt: text, durationSeconds: 10 });
    assert.equal(codes(result).includes('scenetrans-unpaired'), false);
});

test('a cut-off line that is not the last line stops the clip early', async () => {
    const { checkH3Prompt } = await load();
    const text = '[Shot 1] Ada says: <d>[English] wait — <cutoff></d> Then she says: <d>[English] never mind.</d>';
    const result = checkH3Prompt({ prompt: text });
    assert.equal(find(result, 'cutoff-not-last').index, 1);
});

test('speaker ids that skip or start above S1 are errors', async () => {
    const { checkH3Prompt } = await load();
    const skip = checkH3Prompt({ prompt: '(S1) says: <d>[English] a</d> (S3) says: <d>[English] b</d>' });
    assert.equal(find(skip, 'speaker-ids-skip').found, 3);
    const late = checkH3Prompt({ prompt: '(S2) says: <d>[English] a</d>' });
    assert.equal(find(late, 'speaker-ids-start').first, 2);
});

test('a reference tag with nothing behind it is an error', async () => {
    const { checkH3Prompt } = await load();
    const result = checkH3Prompt({ prompt: '[Shot 1] <Picture 4> shows the room.', images: ['a.jpg', 'b.jpg'] });
    const finding = find(result, 'tag-unbacked');
    assert.equal(finding.tag, '<Picture 4>');
    assert.equal(finding.attached, 2);
});

test("a clip's soundtrack counts toward the audio labels it can back", async () => {
    const { checkH3Prompt } = await load();
    const withTrack = checkH3Prompt({
        prompt: '[Shot 1] <Subject 1> speaks in the voice of <Audio 1>. <d>[English] hello</d>',
        videos: [{ url: 'v.mov', useAudio: true }],
        images: ['a.jpg'],
    });
    assert.equal(codes(withTrack).includes('tag-unbacked'), false);
});

test('pictures attached and never named waste their slots', async () => {
    const { checkH3Prompt } = await load();
    const result = checkH3Prompt({ prompt: '[Shot 1] A woman waits in the rain.', images: ['a.jpg'] });
    assert.equal(find(result, 'pictures-unnamed').count, 1);
});

test('more spoken words than clip is an error; too few is a warning', async () => {
    const { checkH3Prompt } = await load();
    const long = Array.from({ length: 60 }, () => 'word').join(' ');
    const over = checkH3Prompt({ prompt: `[Shot 1] Ada says: <d>[English] ${long}</d>`, durationSeconds: 6 });
    assert.equal(find(over, 'overscripted-time').level, 'error');

    const quiet = checkH3Prompt({
        prompt: '[Shot 1] Ada says: <d>[English] hi.</d>',
        durationSeconds: 10,
        audios: [{ url: 'voice.wav' }],
        images: ['a.jpg'],
    });
    assert.equal(find(quiet, 'unscripted-time').level, 'warn');
});

test('a voice clip with nothing to say is flagged', async () => {
    const { checkH3Prompt } = await load();
    const result = checkH3Prompt({
        prompt: '[Shot 1] <Subject 1> stands in the rain.',
        images: ['a.jpg'],
        audios: [{ url: 'voice.wav' }],
        durationSeconds: 8,
    });
    assert.ok(codes(result).includes('voice-without-line'));
});

test('the reference budget is folded in rather than reported separately', async () => {
    const { checkH3Prompt } = await load();
    const result = checkH3Prompt({
        prompt: SIX,
        audios: [{ url: 'a.wav' }, { url: 'b.wav' }, { url: 'c.wav' }, { url: 'd.wav' }],
    });
    const over = find(result, 'budget:over-audio-clips');
    assert.ok(over);
    assert.equal(over.level, 'error');
    // Audio with no picture or clip has nothing to attach to.
    assert.ok(codes(result).includes('budget:audio-without-visual'));
});

test('the character ceiling is an error and the approach is a warning', async () => {
    const { checkH3Prompt, H3_PROMPT_LIMITS } = await load();
    const over = checkH3Prompt({ prompt: 'x'.repeat(H3_PROMPT_LIMITS.chars + 1) });
    assert.equal(find(over, 'over-chars').level, 'error');
    const near = checkH3Prompt({ prompt: 'x'.repeat(H3_PROMPT_LIMITS.charsWarnAt + 1) });
    assert.equal(find(near, 'near-chars').level, 'warn');
});

test('a prompt with no soundscape at all is flagged — H3 renders the audio', async () => {
    const { checkH3Prompt } = await load();
    const result = checkH3Prompt({ prompt: '[Shot 1] A woman waits in the rain.' });
    assert.ok(codes(result).includes('no-soundscape'));
});

test('the parts are exported so the builder can read the same timeline', async () => {
    const { shotMarkers, dialogueBlocks, speakerIdsIn, referenceTagsIn, sectionsIn } = await load();
    assert.deepEqual(shotMarkers('[Shot 1] a\n[Shot 2] At 00:04.500, b'), [
        { number: 1, cutSec: null },
        { number: 2, cutSec: 4.5 },
    ]);
    assert.equal(dialogueBlocks('<d>[Spanish] hola</d>')[0].lang, 'Spanish');
    assert.deepEqual(speakerIdsIn('(S2) x (S1) y'), [1, 2]);
    assert.deepEqual([...referenceTagsIn('<Picture 1> and <Video 2>').Video], [2]);
    assert.deepEqual(sectionsIn(SIX).length, 6);
});

// A blank that reaches the model is not a blank, it is an instruction. Liam
// generated on 2026-08-23 with the dialogue stub still in the prompt and the
// clip read it out loud in his cloned voice, while the unfilled <Subject 1>
// blank left the pasted starter's "A Korean man in his early twenties" as the
// only description of a person in the whole prompt — so that is who it drew.
test("the scaffold's own blanks are errors, named by the section holding them", async () => {
    const { checkH3Prompt } = await load();
    const { withReferenceTags } = await import('../src/lib/h3References.js');
    const refs = { images: ['p1', 'p2'], videos: [], audios: [{ url: 'a1' }] };
    const frame = withReferenceTags('', { ...refs, gender: 'male' });

    const findings = checkH3Prompt({ prompt: frame, durationSeconds: 8, ...refs })
        .findings.filter((finding) => finding.code === 'placeholder-left');

    const subject = findings.find((finding) => finding.blank === 'write it out');
    assert.ok(subject, 'an unwritten <Subject 1> must be flagged');
    assert.equal(subject.level, 'error');
    assert.equal(subject.where, 'subject_definitions');

    const line = findings.find((finding) => finding.blank === 'Write the line you want spoken here');
    assert.ok(line, 'the dialogue stub must be flagged — the model says it out loud');
    assert.equal(line.where, 'detailed_description');

    // Filling them in clears the findings; nothing here fires on real writing.
    const written = frame
        .replace(/\[hair[^\]]*\]/, 'a man in his thirties, short dark hair, black t-shirt')
        .replace('[setting]', 'a kitchen counter').replace('[lighting]', 'flat morning light')
        .replace(/Write the line you want spoken here — this is what the cloned voice says\./, 'Morning.');
    assert.deepEqual(
        checkH3Prompt({ prompt: written, durationSeconds: 8, ...refs })
            .findings.filter((finding) => finding.code === 'placeholder-left'),
        [],
    );
});

test('every blank the scaffolds write is one the check knows about', async () => {
    // The list in SCAFFOLD_BLANKS is literal text, so it can go stale the moment
    // a scaffold gains a new [bracket]. This walks what the writers actually
    // emit and fails until the new one is listed — otherwise a fresh placeholder
    // ships straight to the model with nothing watching for it.
    const { SCAFFOLD_BLANKS } = await load();
    const { withReferenceTags } = await import('../src/lib/h3References.js');
    const { composeH3Prompt } = await import('../src/lib/h3Shots.js');

    const scaffolds = [
        withReferenceTags('', { images: ['p1'], videos: [], audios: [{ url: 'a1' }], gender: 'female' }),
        withReferenceTags('', { images: [], videos: [{ url: 'v1', motion: true }], audios: [], gender: '' }),
        withReferenceTags('', { images: [], videos: [], audios: [], gender: '' }),
        composeH3Prompt({ mode: 'reference', shots: [{}] }),
        composeH3Prompt({ mode: 'text', shots: [{}] }),
    ];

    // H3's own grammar is full of legitimate brackets, and those are not blanks:
    // [Shot 2] is a marker, [English] is a language tag, [audio reference] is
    // the summary's audio contract.
    const grammar = /^\[(Shot \d+|audio (reference|reuse)|[A-Z][a-z]+)\]$/;
    const covered = (span) => SCAFFOLD_BLANKS.some((blank) => span.toLowerCase().includes(blank.toLowerCase()));

    for (const scaffold of scaffolds) {
        for (const [span] of scaffold.matchAll(/\[[^\]\n]*\]/g)) {
            if (grammar.test(span)) continue;
            assert.ok(covered(span), `SCAFFOLD_BLANKS does not cover ${span}`);
        }
    }
});

test('a subject that is defined but never staged is a finding of its own', async () => {
    const { checkH3Prompt } = await import('../src/lib/h3PromptCheck.js');
    const prompt = `subject_definitions:
<Subject 1> is the woman shown in <Picture 1>: red hair.
<Subject 2> is SpongeBob SquarePants from the animated series SpongeBob SquarePants (1999).

summary:
One take of <Subject 1>.

retention_analysis:
<Picture 1>: fully_preserved — same person.

detailed_description:
[Shot 1] <Subject 1> (S1) sits at a table and looks out of the window.

overall_soundscape:
Room tone.

non_diegetic_music:
none`;
    const { findings } = checkH3Prompt({ prompt, images: ['/a.png'] });
    const missing = findings.filter((finding) => finding.code === 'subject-not-in-scene');
    assert.deepEqual(missing.map((finding) => finding.subject), [2]);
    // Staging the second subject clears it.
    const staged = checkH3Prompt({ prompt: prompt.replace('looks out of the window.', 'looks out of the window as <Subject 2> bounces in.'), images: ['/a.png'] });
    assert.equal(staged.findings.some((finding) => finding.code === 'subject-not-in-scene'), false);
});
