const test = require('node:test');
const assert = require('node:assert/strict');

// The cast is the one place that decides what the model is told to call anyone.
// A template addresses <Subject 1>; this decides which <Picture N> that is. The
// whole point is that the numbering is re-derived per run, so the same saved
// prompt works with one persona, with two, or with a persona and a cartoon.
const load = () => import('../src/lib/castPrompt.js');

const CHERYL = {
    images: ['/c1.jpg', '/c2.jpg'],
    videos: [{ url: '/walk.mov', name: 'walk.mov', useAudio: true }],
    audios: [],
};
const DANA = { images: ['/d1.jpg'], videos: [], audios: [{ url: '/dana.wav', name: 'dana.wav' }] };

test('slots are allocated in cast order, and each member learns its own labels', async () => {
    const { allocateCast, castPersona, castCharacter } = await load();
    const { images, videos, audios, roles, overflow } = allocateCast([
        castPersona('Cheryl', CHERYL),
        castCharacter('SpongeBob', 'SpongeBob SquarePants from the animated series (1999)'),
        castPersona('Dana', DANA),
    ]);

    // The merged rows are exactly what the References panel should hold.
    assert.deepEqual(images, ['/c1.jpg', '/c2.jpg', '/d1.jpg']);
    assert.equal(videos.length, 1);
    assert.equal(audios.length, 1);
    assert.deepEqual(overflow, []);

    // Cheryl owns pictures 1-2; Dana's picture is 3 — NOT 1, which is the bug
    // that a template with a hardcoded <Picture 1> would produce.
    assert.deepEqual(roles[0].pictures, ['<Picture 1>', '<Picture 2>']);
    assert.deepEqual(roles[2].pictures, ['<Picture 3>']);

    // A character occupies no slots at all and still gets a subject.
    assert.equal(roles[1].subject, '<Subject 2>');
    assert.deepEqual(roles[1].pictures, []);

    // Speaker ids are per member, so two subjects never share one.
    assert.deepEqual(roles.map((role) => role.speaker), ['S1', 'S2', 'S3']);
});

test("a clip's own soundtrack is its owner's voice, and numbers ahead of its video", async () => {
    const { allocateCast, castPersona, roleVoiceLabel } = await load();
    const { roles } = allocateCast([castPersona('Cheryl', CHERYL), castPersona('Dana', DANA)]);

    // Cheryl brought no voice clip, but her motion clip has its soundtrack on —
    // that IS her voice reference, and it claims <Audio 1> before <Video 1>.
    assert.deepEqual(roles[0].videos, [{ video: '<Video 1>', audio: '<Audio 1>' }]);
    assert.equal(roleVoiceLabel(roles[0]), '<Audio 1>');

    // Dana's standalone voice clip is therefore <Audio 2>, not <Audio 1>.
    assert.deepEqual(roles[1].audios, ['<Audio 2>']);
    assert.equal(roleVoiceLabel(roles[1]), '<Audio 2>');
});

test('a cast too big for the row says so instead of losing a character', async () => {
    const { allocateCast, castPersona } = await load();
    const six = { images: ['1', '2', '3', '4', '5', '6'], videos: [], audios: [] };
    const { images, overflow } = allocateCast(
        [castPersona('A', six), castPersona('B', six)],
        { limits: { images: 9, videos: 3, audios: 3 } },
    );
    assert.equal(images.length, 9);
    assert.deepEqual(overflow, [{ member: 'B', kind: 'images', dropped: 3 }]);
});

test('compiling writes who the subjects are and what each reference may carry', async () => {
    const { compileCastPrompt, castPersona, castCharacter } = await load();
    const { prompt } = compileCastPrompt({
        members: [
            castPersona('Cheryl', CHERYL),
            castCharacter('SpongeBob', 'SpongeBob SquarePants from the animated series (1999)'),
        ],
        template: {
            summary: 'A sidescrolling fighting game match between <Subject 1> and <Subject 2>.',
            detailed_description: '[Shot 1] They square up in profile.',
            overall_soundscape: 'Arcade room tone.',
            non_diegetic_music: 'none',
        },
    });

    // Each subject is defined once, in cast order, by what actually identifies it.
    assert.match(prompt, /subject_definitions:\n<Subject 1> is the person shown in <Picture 1>, <Picture 2>/);
    assert.match(prompt, /<Subject 2> is SpongeBob SquarePants from the animated series \(1999\)\./);

    // Cheryl's soundtrack makes her a speaker, so her timbre reference is named.
    assert.match(prompt, /<Audio 1> is the voice-timbre reference for <Subject 1> \(S1\)\./);

    // Every reference gets its retention contract, and the motion clip carries
    // the exclusion that stops it replacing the subject it is moving.
    assert.match(prompt, /<Picture 1>: fully_preserved/);
    assert.match(prompt, /<Video 1>: attribute_transfer[\s\S]*do NOT carry/);
    // A voice reference anywhere means the summary states the audio contract.
    assert.match(prompt, /summary:\n\[audio reference\] A sidescrolling/);
    // The creative half survives untouched.
    assert.match(prompt, /detailed_description:\n\[Shot 1\] They square up in profile\./);
    assert.match(prompt, /non_diegetic_music:\nnone/);
});

test('a cast of one cartoon needs no references and no audio contract', async () => {
    const { compileCastPrompt, castCharacter } = await load();
    const { prompt, allocation } = compileCastPrompt({
        members: [castCharacter('SpongeBob', 'SpongeBob SquarePants from the animated series (1999)')],
        template: { summary: '<Subject 1> flips a patty.' },
    });
    assert.equal(allocation.images.length, 0);
    assert.doesNotMatch(prompt, /retention_analysis/);
    // No voice anywhere, so no [audio reference] tag is invented.
    assert.match(prompt, /summary:\n<Subject 1> flips a patty\./);
});

test('an existing audio tag in the template is not doubled', async () => {
    const { compileCastPrompt, castPersona } = await load();
    const { prompt } = compileCastPrompt({
        members: [castPersona('Cheryl', CHERYL)],
        template: { summary: '[audio reuse] <Subject 1> repeats the line.' },
    });
    assert.equal((prompt.match(/\[audio re/g) || []).length, 1);
});

test('a scene style cannot quietly restyle a real person', async () => {
    const { compileCastPrompt, castPersona, castCharacter, PERSONA_DEFAULT_STYLE } = await load();
    // Measured 2026-08-12: a "2D sidescrolling fighting game" scene turned a
    // photographed person into pixel art, because nothing in the prompt said
    // how she should be DRAWN — only who she was. Rendering is per member.
    const { prompt } = compileCastPrompt({
        members: [
            castPersona('Cheryl', CHERYL),
            castCharacter('SpongeBob', 'SpongeBob SquarePants from the animated series (1999)', {
                style: '3D CGI character animation, semi-realistic',
            }),
        ],
        template: { summary: 'A fighting game match between <Subject 1> and <Subject 2>.' },
    });
    // The person defined by photographs defaults to photoreal, stated outright.
    assert.match(prompt, /<Subject 1> is rendered as photoreal live-action/);
    assert.match(PERSONA_DEFAULT_STYLE, /not illustrated, not stylised/);
    // And the cartoon is rendered its own way in the same shot — the two are
    // independent, which is the whole point of putting it on the member.
    assert.match(prompt, /<Subject 2> is rendered as 3D CGI character animation, semi-realistic\./);
});

test('a persona can carry its own appearance instead of a placeholder', async () => {
    const { compileCastPrompt, castPersona } = await load();
    const member = castPersona('Cheryl', CHERYL);
    member.appearance = 'long dark wavy hair with a blunt fringe, warm open smile';
    const { prompt } = compileCastPrompt({ members: [member], template: { summary: 'x' } });
    assert.match(prompt, /long dark wavy hair with a blunt fringe/);
    assert.doesNotMatch(prompt, /\[appearance/);
});

test('speaker ids follow first-vocal-event order and are bound to their subject', async () => {
    const { compileCastPrompt, castPersona, castCharacter } = await load();
    // H3's own rules (references/base-modes.md, full-reference.md): ids are
    // assigned in first-vocal-event order, and a subject is tied to its id by
    // writing the pairing out. Getting this wrong twice put a woman's lines in
    // a cartoon's mouth (2026-08-12) — a trailing (S1) on a <d> line binds
    // nothing on its own.
    const { prompt, allocation } = compileCastPrompt({
        members: [
            castPersona('Cheryl', CHERYL),
            castCharacter('SpongeBob', 'SpongeBob SquarePants from the animated series (1999)'),
        ],
        speakingOrder: [1, 0], // the cartoon speaks first
        template: { summary: 'x' },
    });
    assert.equal(allocation.roles[1].speaker, 'S1', 'the first voice heard is S1');
    assert.equal(allocation.roles[0].speaker, 'S2');
    assert.match(prompt, /<Subject 2> speaks as S1, in its own established voice\./);
    assert.match(prompt, /<Subject 1> speaks as S2\./);
});

test('a member who never speaks is given no speaker id', async () => {
    const { allocateCast, castPersona, castCharacter } = await load();
    const { roles } = allocateCast(
        [castPersona('Cheryl', CHERYL), castCharacter('Extra', 'a passer-by')],
        { speakingOrder: [0] },
    );
    assert.equal(roles[0].speaker, 'S1');
    assert.equal(roles[1].speaker, '', 'a silent member must not consume an id');
});

// ---------------------------------------------------------------------------
// Recasting what is already in the composer.
test('applying a cast rewrites only the two sections the cast owns', async () => {
    const { applyCastToPrompt, castPersona, castCharacter, parseSixSections } = await load();
    const existing = [
        'subject_definitions:',
        '<Subject 1> is somebody else entirely.',
        '',
        'summary:',
        'A fight on a wet street.',
        '',
        'retention_analysis:',
        '<Picture 1>: weak_reference — stale.',
        '',
        'detailed_description:',
        '[Shot 1] <Subject 1> (S1) throws a punch.',
        '',
        'overall_soundscape:',
        'Night street room tone.',
        '',
        'non_diegetic_music:',
        'none',
    ].join('\n');

    const { prompt } = applyCastToPrompt(existing, {
        members: [castPersona('Cheryl', CHERYL), castCharacter('SpongeBob', 'SpongeBob SquarePants (1999)')],
    });
    const sections = parseSixSections(prompt);

    // Rewritten from the cast that is actually attached.
    assert.match(sections.subject_definitions, /<Subject 1> is the person shown in <Picture 1>, <Picture 2>/);
    assert.match(sections.subject_definitions, /<Subject 2> is SpongeBob SquarePants \(1999\)\./);
    assert.doesNotMatch(prompt, /somebody else entirely/);
    assert.match(sections.retention_analysis, /<Picture 1>: fully_preserved/);
    assert.doesNotMatch(prompt, /weak_reference — stale/);

    // The creative half is left exactly as written.
    assert.equal(sections.detailed_description, '[Shot 1] <Subject 1> (S1) throws a punch.');
    assert.equal(sections.overall_soundscape, 'Night street room tone.');
    assert.equal(sections.non_diegetic_music, 'none');
    // …except the audio contract, which the attached references decide.
    assert.equal(sections.summary, '[audio reference] A fight on a wet street.');
});

test('a plain paragraph is framed rather than sent as-is', async () => {
    const { applyCastToPrompt, castPersona, parseSixSections } = await load();
    const { prompt, warnings } = applyCastToPrompt('She throws a punch on a wet street at night.', {
        members: [castPersona('Cheryl', CHERYL)],
    });
    const sections = parseSixSections(prompt);
    // Loose prose IS the shot, so it is filed as one — a description with no
    // [Shot N] header is the one shape H3 cannot read a timeline from.
    assert.equal(sections.detailed_description, '[Shot 1] She throws a punch on a wet street at night.');
    assert.ok(sections.subject_definitions, 'the frame it never had is written around it');
    // …and the two sections a six-section prompt cannot go without are written
    // with the defaults the reference scaffold uses, so the model is never left
    // to invent a soundscape or a score.
    assert.match(sections.overall_soundscape, /no music/i);
    assert.equal(sections.non_diegetic_music, 'none');
    // And it is told the paragraph is far thinner than H3 asks for.
    assert.ok(warnings.some((text) => /H3's guide asks for roughly 350-500/.test(text)));
});

test('an empty composer is not silently cast into nothing', async () => {
    const { applyCastToPrompt, castPersona } = await load();
    const { warnings } = applyCastToPrompt('', { members: [castPersona('Cheryl', CHERYL)] });
    assert.ok(warnings.some((text) => /Nothing describes the shot/.test(text)));
});

// ---------------------------------------------------------------------------
// What "left as written" does NOT cover. Measured 2026-08-22: a fight recast
// from SpongeBob onto Naruto rewrote the definitions and kept the spoken line's
// "[English in SpongeBob SquarePants' voice … as voiced by Tom Kenny]" tag, so
// half the prompt asked for one character and half for another.
const SPONGEBOB_FIGHT = [
    'subject_definitions:',
    '<Subject 1> is the character shown in <Picture 1>: [appearance].',
    '<Subject 1> speaks as S1.',
    '<Subject 2> is SpongeBob SquarePants from the animated series SpongeBob SquarePants (1999).',
    "<Subject 2> speaks as S2, in SpongeBob SquarePants' voice from SpongeBob SquarePants as voiced by Tom Kenny.",
    '',
    'summary:',
    'A fight between <Subject 1> and SpongeBob SquarePants.',
    '',
    'detailed_description:',
    '[Shot 1] <Subject 1> lands a punch and SpongeBob SquarePants reels backwards.',
    "At 00:02.700, <Subject 2> (S2) says: <d>[English in SpongeBob SquarePants' voice from SpongeBob SquarePants as voiced by Tom Kenny] Ouch! That really hurt!</d>",
    '',
    'overall_soundscape:',
    'Night street room tone.',
].join('\n');

test('recasting renames the voice inside the dialogue tag, not just the definitions', async () => {
    const { applyCastToPrompt, castPersona, castCharacter, parseSixSections } = await load();
    const { prompt } = applyCastToPrompt(SPONGEBOB_FIGHT, {
        members: [
            castPersona('Cheryl', CHERYL),
            castCharacter('Naruto Uzumaki', 'Naruto Uzumaki from the anime series Naruto (2002)', {
                voice: "Naruto Uzumaki's voice from Naruto",
            }),
        ],
    });
    const sections = parseSixSections(prompt);

    // The tag is the cast's to write — the outgoing character's voice cannot
    // survive in it, in ANY section.
    assert.match(sections.detailed_description, /<d>\[English in Naruto Uzumaki's voice from Naruto\] Ouch!/);
    assert.doesNotMatch(prompt, /Tom Kenny/);
    // …and the prose that named the outgoing character now addresses the
    // position that character held, so the next recast is exact too.
    assert.match(sections.summary, /A fight between <Subject 1> and <Subject 2>\./);
    assert.match(sections.detailed_description, /<Subject 1> lands a punch and <Subject 2> reels backwards\./);
});

test('a persona inheriting a spoken part loses the voice the previous member was asked for', async () => {
    const { applyCastToPrompt, castPersona, parseSixSections } = await load();
    // One member now, so what was <Subject 2>'s line belongs to nobody — but
    // <Subject 1>'s tag must still stop naming a voice it does not have.
    const { prompt } = applyCastToPrompt([
        'subject_definitions:',
        '<Subject 1> is SpongeBob SquarePants from the animated series SpongeBob SquarePants (1999).',
        "<Subject 1> speaks as S1, in SpongeBob SquarePants' voice from SpongeBob SquarePants as voiced by Tom Kenny.",
        '',
        'detailed_description:',
        "[Shot 1] <Subject 1> (S1) says: <d>[English in SpongeBob SquarePants' voice from SpongeBob SquarePants as voiced by Tom Kenny] Ouch!</d>",
    ].join('\n'), { members: [castPersona('Dana', DANA)] });

    assert.match(parseSixSections(prompt).detailed_description, /<d>\[English\] Ouch!<\/d>/);
});

test('a name left in the words that get SAID is reported, never rewritten', async () => {
    const { applyCastToPrompt, castPersona, castCharacter, parseSixSections } = await load();
    const { prompt, warnings } = applyCastToPrompt([
        'subject_definitions:',
        '<Subject 1> is the character shown in <Picture 1>: [appearance].',
        '<Subject 1> speaks as S1.',
        '<Subject 2> is SpongeBob SquarePants from the animated series SpongeBob SquarePants (1999).',
        '',
        'detailed_description:',
        '[Shot 1] <Subject 1> (S1) says: <d>[English] Take that, SpongeBob SquarePants!</d>',
    ].join('\n'), {
        members: [
            castPersona('Cheryl', CHERYL),
            castCharacter('Naruto Uzumaki', 'Naruto Uzumaki from the anime series Naruto (2002)'),
        ],
    });

    // Rewriting it would have the model read the label out loud.
    assert.match(parseSixSections(prompt).detailed_description, /Take that, SpongeBob SquarePants!/);
    assert.ok(warnings.some((text) => /still says .SpongeBob SquarePants./.test(text)));
});

test('speaker ids in carried prose follow the new speaking order', async () => {
    const { applyCastToPrompt, castPersona, castCharacter, parseSixSections } = await load();
    const { prompt } = applyCastToPrompt([
        'subject_definitions:',
        '<Subject 1> is the character shown in <Picture 1>: [appearance].',
        '<Subject 1> speaks as S1.',
        '<Subject 2> is SpongeBob SquarePants from the animated series (1999).',
        '<Subject 2> speaks as S2.',
        '',
        'detailed_description:',
        '[Shot 1] <Subject 2> (S2) says: <d>[English] I go first now.</d> <Subject 1> (S1) answers.',
    ].join('\n'), {
        members: [castPersona('Cheryl', CHERYL), castCharacter('SpongeBob', 'SpongeBob SquarePants (1999)')],
        // The cartoon speaks first, so it is S1 and the persona becomes S2.
        speakingOrder: [1, 0],
    });
    const description = parseSixSections(prompt).detailed_description;
    assert.match(description, /<Subject 2> \(S1\) says:/);
    assert.match(description, /<Subject 1> \(S2\) answers\./);
});

test('a label the cast cannot fill is reported instead of conditioning on nothing', async () => {
    const { applyCastToPrompt, castPersona } = await load();
    const { warnings } = applyCastToPrompt([
        'subject_definitions:',
        '<Subject 1> is the character shown in <Picture 1>: [appearance].',
        '',
        'detailed_description:',
        '[Shot 1] <Subject 1> and <Subject 3> square up, lit exactly as <Picture 5> is lit.',
    ].join('\n'), { members: [castPersona('Cheryl', CHERYL)] });

    assert.ok(warnings.some((text) => /addresses <Picture 5>, but this cast fills 2 pictures/.test(text)));
    assert.ok(warnings.some((text) => /addresses <Subject 3>, but this cast has 1 member/.test(text)));
});


// ---------------------------------------------------------------------------
// Beats. Measured 2026-08-12: an 8s clip was handed ~14s of choreography as
// prose, and the model dropped and reordered to fit — a one-word "Ouch!" landed
// on the kick that was meant to provoke it instead of the punch that landed.
test('beats are anchored inside one shot, never cut into new ones', async () => {
    const { compileCastPrompt, castPersona, castCharacter } = await load();
    const { prompt } = compileCastPrompt({
        members: [castPersona('Cheryl', CHERYL), castCharacter('SpongeBob', 'SpongeBob SquarePants (1999)')],
        durationSeconds: 8,
        template: {
            style: 'One continuous live-action photoreal take, locked side-on camera.',
            beats: [
                { seconds: 1.5, action: '<Subject 1> and <Subject 2> hold their stances.' },
                { seconds: 2, action: '<Subject 1> throws a straight right that lands.' },
                {
                    seconds: 2,
                    action: '<Subject 1> follows through.',
                    line: { member: 0, text: 'Take that, you absolute sponge!' },
                },
                { seconds: 2.5, action: '<Subject 2> staggers back.', line: { member: 1, text: 'That really hurt my feelings!' } },
            ],
        },
    });

    // The first beat opens the shot; every later beat is a TIME ANCHOR, not a
    // [Shot 2] — a new shot marker is a cut, and this is one continuous take.
    assert.match(prompt, /\[Shot 1\] <Subject 1> and <Subject 2> hold their stances\./);
    assert.match(prompt, /\nAt 00:01\.500, <Subject 1> throws a straight right/);
    assert.match(prompt, /\nAt 00:03\.500, <Subject 1> follows through\./);
    assert.doesNotMatch(prompt, /\[Shot 2\]/);

    // The compiler writes the pairing and the tag, so neither is ever typed.
    assert.match(prompt, /<Subject 1> \(S1\) says: <d>\[English\] Take that, you absolute sponge!<\/d>/);
    assert.match(prompt, /<Subject 2> \(S2\) says: <d>\[English\] That really hurt my feelings!<\/d>/);
});

test('the speaking order is derived from the beats, not from the cast order', async () => {
    const { compileCastPrompt, castPersona, castCharacter, speakingOrderFromBeats } = await load();
    // The cartoon speaks first even though the persona is cast first, so it is
    // S1. Getting this backwards put a woman's lines in a sponge's mouth twice.
    const beats = [
        { seconds: 4, action: 'x', line: { member: 1, text: 'I am ready for you now.' } },
        { seconds: 4, action: 'y', line: { member: 0, text: 'You are not ready at all.' } },
    ];
    assert.deepEqual(speakingOrderFromBeats(beats), [1, 0]);

    const { prompt, allocation } = compileCastPrompt({
        members: [castPersona('Cheryl', CHERYL), castCharacter('SpongeBob', 'SpongeBob SquarePants (1999)')],
        durationSeconds: 8,
        template: { beats },
    });
    assert.equal(allocation.roles[1].speaker, 'S1');
    assert.equal(allocation.roles[0].speaker, 'S2');
    assert.match(prompt, /<Subject 2> \(S1\) says:/);
});

test('a shot that does not fit its runtime says so before the GPU does', async () => {
    const { compileCastPrompt, castPersona } = await load();
    const beat = (seconds) => ({ seconds, action: 'something happens.' });

    const over = compileCastPrompt({
        members: [castPersona('Cheryl', CHERYL)],
        durationSeconds: 8,
        template: { beats: [beat(4), beat(4), beat(3), beat(3)] },
    });
    assert.ok(over.warnings.some((text) => /add up to 14\.0s but the clip is 8s/.test(text)));

    // And the opposite failure, which is the one that fills dead time with
    // invented speech: far fewer beats than the clip has seconds.
    const under = compileCastPrompt({
        members: [castPersona('Cheryl', CHERYL)],
        durationSeconds: 8,
        template: { beats: [beat(2)] },
    });
    assert.ok(under.warnings.some((text) => /6\.0s is unwritten/.test(text)));

    // A shot that fits is not nagged about either.
    const fits = compileCastPrompt({
        members: [castPersona('Cheryl', CHERYL)],
        durationSeconds: 8,
        template: { beats: [beat(4), beat(4)] },
    });
    assert.deepEqual(fits.warnings.filter((text) => /add up to|unwritten/.test(text)), []);
});

test('a line too short to place, or too long for its beat, is flagged', async () => {
    const { compileCastPrompt, castPersona, lineSeconds } = await load();
    assert.equal(lineSeconds('Ouch!'), 1 / 3);

    const { warnings } = compileCastPrompt({
        members: [castPersona('Cheryl', CHERYL)],
        durationSeconds: 8,
        template: {
            beats: [
                { seconds: 4, action: 'she swings.', line: { member: 0, text: 'Ouch!' } },
                { seconds: 4, action: 'she keeps talking.', line: { member: 0, text: 'This line is far too long to fit inside the four seconds this beat has been given for it' } },
            ],
        },
    });
    // The one-word interjection is exactly what slid onto the wrong action.
    assert.ok(warnings.some((text) => /“Ouch!”.*0\.3s.*slide onto a neighbouring action/s.test(text)));
    assert.ok(warnings.some((text) => /Beat 2's line needs about \d+\.\ds but the beat is 4\.0s/.test(text)));
});

// Measured across three takes 2026-08-12/13: the ONE take whose subject and
// speaker numbering crossed is the one that swapped two characters' lines. H3
// numbers speakers by first vocal event, which is legal and which the compiler
// follows — but when that makes <Subject 1> into S2, say so, because both
// constraints can always be satisfied by moving the first line instead.
test('crossed subject and speaker numbering is called out', async () => {
    const { compileCastPrompt, castPersona, castCharacter } = await load();
    const members = [castPersona('Cheryl', CHERYL), castCharacter('SpongeBob', 'SpongeBob SquarePants (1999)')];
    const beat = (member, text) => ({ seconds: 4, action: 'they fight.', line: { member, text } });

    // The cartoon speaks first, so it becomes S1 while staying <Subject 2>.
    const crossed = compileCastPrompt({
        members, durationSeconds: 8,
        template: { beats: [beat(1, 'I am going to get you now'), beat(0, 'You will not get me at all')] },
    });
    assert.ok(crossed.warnings.some((text) => /numbering are crossed \(<Subject 1>=S2, <Subject 2>=S1\)/.test(text)));

    // Reordering the lines satisfies both rules at once, and says nothing.
    const aligned = compileCastPrompt({
        members, durationSeconds: 8,
        template: { beats: [beat(0, 'You will not get me at all'), beat(1, 'I am going to get you now')] },
    });
    assert.deepEqual(aligned.warnings.filter((text) => /crossed/.test(text)), []);
});

test('a voice reference that drifts off the first speaker is called out', async () => {
    const { compileCastPrompt, castPersona, castCharacter } = await load();
    // Cheryl brings the only voice clip; the cartoon takes the first line, so
    // the clone no longer belongs to S1 — the shape in which her own lines came
    // back in someone else's voice.
    const { warnings } = compileCastPrompt({
        members: [castPersona('Cheryl', CHERYL), castCharacter('SpongeBob', 'SpongeBob SquarePants (1999)')],
        durationSeconds: 8,
        template: {
            beats: [
                { seconds: 4, action: 'x', line: { member: 1, text: 'I am going to get you now' } },
                { seconds: 4, action: 'y', line: { member: 0, text: 'You will not get me at all' } },
            ],
        },
    });
    assert.ok(warnings.some((text) => /<Audio 1> is <Subject 1>'s voice, but <Subject 1> speaks as S2/.test(text)));

    // A lone speaker owning the voice is S1 by definition — nothing to say.
    const solo = compileCastPrompt({
        members: [castPersona('Cheryl', CHERYL)],
        durationSeconds: 8,
        template: { beats: [{ seconds: 8, action: 'x', line: { member: 0, text: 'I am talking to myself here' } }] },
    });
    assert.deepEqual(solo.warnings.filter((text) => /voice reference|rather than S1/.test(text)), []);
});

test('a named voice is described as well as named', async () => {
    const { compileCastPrompt, castPersona, castCharacter } = await load();
    // Naming a voice only helps if the model can retrieve it; when it cannot it
    // reaches for a generic adult male. Measured twice — an unattributed exhale
    // and then a fully named SpongeBob both came back as an older man
    // (2026-08-13) — so the description, and what it must NOT be, ship too.
    const bob = castCharacter('SpongeBob', 'SpongeBob SquarePants (1999)', {
        voice: "SpongeBob SquarePants' voice from SpongeBob SquarePants as voiced by Tom Kenny",
        voiceQuality: 'high-pitched, nasal, squeaky and childlike — never deep or adult-sounding',
    });
    const { prompt } = compileCastPrompt({
        members: [castPersona('Cheryl', CHERYL), bob],
        speakingOrder: [0, 1],
        template: { summary: 'x' },
    });
    assert.match(prompt, /<Subject 2> speaks as S2, in SpongeBob SquarePants' voice/);
    assert.match(prompt, /<Subject 2>'s voice is high-pitched, nasal, squeaky and childlike — never deep or adult-sounding\./);

    // A character with no description says nothing extra rather than inventing.
    const plain = castCharacter('Extra', 'a passer-by', { voice: "the passer-by's voice from nowhere" });
    const quiet = compileCastPrompt({ members: [plain], template: { summary: 'x' } });
    assert.doesNotMatch(quiet.prompt, /voice is /);
});

test('the catalog describes the voices most likely to be mistaken for generic', async () => {
    const { H3_CHARACTERS } = await import('../src/lib/h3Characters.js');
    const described = H3_CHARACTERS.filter((entry) => entry.voiceQuality);
    assert.ok(described.length >= 8, 'the distinctive cartoon voices carry a description');
    // Each says what it must NOT be: the negative half is what stopped a scene
    // style restyling a person and a default grin surviving a punch.
    const bob = H3_CHARACTERS.find((entry) => entry.name === 'SpongeBob SquarePants');
    assert.match(bob.voiceQuality, /never deep, gravelly or adult-sounding/);
    // A description does NOT require a performer, and is worth most where there
    // cannot be one: Mickey Mouse has had several across eras and Yoda's is a
    // puppeteer, so naming one would be a guess while describing the voice is
    // not. The two fields are independent handles on the same thing.
    assert.ok(described.every((entry) => entry.voiceQuality.length > 30),
        'a description has to actually describe');
    assert.ok(described.some((entry) => !entry.voiceActor),
        'describing a voice must not depend on being able to name who performs it');
});

test('a character noise in the soundscape is called out as unvoiced', async () => {
    const { compileCastPrompt, castPersona } = await load();
    // H3's guide: synchronised dialogue and character sound belong in
    // detailed_description; overall_soundscape is whole-video ambience. The
    // reason it matters is that nothing in the soundscape carries a speaker id,
    // so this exact line came back as a quiet old man over a cartoon sponge.
    const bad = compileCastPrompt({
        members: [castPersona('Cheryl', CHERYL)],
        template: {
            summary: 'x',
            overall_soundscape: 'Night street room tone, impact thuds, a sharp exhale from each fighter on exertion.',
        },
    });
    assert.ok(bad.warnings.some((text) => /comes back in a default voice/.test(text)));

    // Physical sound alone — what the section is actually for — is left alone.
    // "electrical hum" is the case that made this warning cry wolf on its first
    // real prompt, so it is pinned: in an ambience section a hum is a machine.
    const good = compileCastPrompt({
        members: [castPersona('Cheryl', CHERYL)],
        template: {
            summary: 'x',
            overall_soundscape: 'Night street room tone with a faint electrical hum from the signage, impact thuds, '
                + 'a low whoosh, shoes scuffing wet asphalt, and no speech from anyone else.',
        },
    });
    assert.deepEqual(good.warnings.filter((text) => /default voice/.test(text)), []);
});

test("a known character's voice is named inside the dialogue tag", async () => {
    const { allocateCast, castPersona, castCharacter, dialogueTag, compileCastPrompt } = await load();
    // H3 knows a known character's VOICE the same way it knows their face, and
    // it is invoked in the language tag — not through a cloned reference clip.
    const bob = castCharacter('SpongeBob', 'SpongeBob SquarePants from the animated series (1999)', {
        voice: "SpongeBob SquarePants' voice from the animated series SpongeBob SquarePants",
    });
    const { roles } = allocateCast([castPersona('Cheryl', CHERYL), bob], { speakingOrder: [0, 1] });

    assert.equal(dialogueTag(roles[1]), "[English in SpongeBob SquarePants' voice from the animated series SpongeBob SquarePants]");
    // A persona speaks in its own referenced timbre, so it keeps the plain tag:
    // naming a voice it does not have invites the model to invent one over the
    // reference it was given.
    assert.equal(dialogueTag(roles[0]), '[English]');
    assert.equal(dialogueTag(roles[0], 'Mandarin'), '[Mandarin]');

    const { prompt } = compileCastPrompt({
        members: [castPersona('Cheryl', CHERYL), bob], speakingOrder: [0, 1], template: { summary: 'x' },
    });
    assert.match(prompt, /<Subject 2> speaks as S2, in SpongeBob SquarePants' voice/);
});

// A persona with only a clip: the clip is the character reference — MiniMax's
// guide binds subjects to videos outright — so the definition names it and the
// retention contract carries the person, not just the movement. With a picture
// beside it the same clip is motion-only again, exactly as before.
test('a persona with only a clip is introduced by that clip, which carries the person', async () => {
    const { compileCastPrompt, castPersona } = await load();
    const clipOnly = castPersona('Liam', { images: [], videos: [{ url: '/liam.mov', useAudio: false }], audios: [], gender: 'male' });
    const { prompt } = compileCastPrompt({ members: [clipOnly], speakingOrder: [0], template: { summary: 'x' } });
    assert.match(prompt, /<Subject 1> is the man shown in <Video 1>: \[hair, face/);
    assert.match(prompt, /<Subject 1>: fully_preserved — the same face, hair, build and wardrobe/);
    assert.match(prompt, /<Video 1>: fully_preserved — <Subject 1> IS the person in this clip/);
    assert.doesNotMatch(prompt, /<Video 1>: attribute_transfer/);

    const withPicture = castPersona('Liam', { images: ['/l.jpg'], videos: [{ url: '/liam.mov', useAudio: false }], audios: [], gender: 'male' });
    const pictured = compileCastPrompt({ members: [withPicture], template: { summary: 'x' } }).prompt;
    assert.match(pictured, /<Subject 1> is the man shown in <Picture 1>/);
    assert.match(pictured, /<Video 1>: attribute_transfer[\s\S]*do NOT carry/);
});

// The persona's saved gender is what the definition calls them. "The
// character" only when it was never set, so an older persona reads as it did.
test('a persona is introduced by its gender, and asked for a matching voice when it has no clone', async () => {
    const { compileCastPrompt, castPersona } = await load();

    const her = compileCastPrompt({ members: [castPersona('Cheryl', { ...CHERYL, gender: 'female' })], template: { summary: 'x' } }).prompt;
    assert.match(her, /<Subject 1> is the woman shown in <Picture 1>, <Picture 2>/);
    // Cheryl's clip soundtrack IS her voice, so no voice kind is asked for.
    assert.match(her, /<Subject 1> speaks as S1\.\n<Audio 1> is the voice-timbre reference for <Subject 1> \(S1\)\./);
    assert.doesNotMatch(her, /woman's voice/);

    // Pictures only, and speaking: say what kind of voice, or H3 picks its
    // generic adult male for whoever is on screen.
    const marco = castPersona('Marco', { images: ['/m.jpg'], gender: 'male' });
    const him = compileCastPrompt({ members: [marco], speakingOrder: [0], template: { summary: 'x' } }).prompt;
    assert.match(him, /<Subject 1> is the man shown in <Picture 1>: \[hair, face/);
    assert.match(him, /<Subject 1> speaks as S1, in a man's voice\./);

    // Non-binary: the noun is "person" and no voice kind is implied. Marco,
    // left out of the speaking order, gets no speaker line and so no voice kind.
    const sam = castPersona('Sam', { images: ['/s.jpg'], gender: 'nonbinary' });
    const them = compileCastPrompt({ members: [marco, sam], speakingOrder: [1], template: { summary: 'x' } }).prompt;
    assert.match(them, /<Subject 2> is the person shown in <Picture 2>/);
    assert.match(them, /<Subject 2> speaks as S1\./);
    assert.doesNotMatch(them, /<Subject 1> speaks as/);
    assert.doesNotMatch(them, /voice\./);

    // Unset reads as a person — a persona is a photographed human.
    const unset = compileCastPrompt({ members: [castPersona('Cheryl', CHERYL)], template: { summary: 'x' } }).prompt;
    assert.match(unset, /<Subject 1> is the person shown in <Picture 1>, <Picture 2>/);
    assert.equal(castPersona('Cheryl', CHERYL).gender, '');
    assert.equal(castPersona('Cheryl', { ...CHERYL, gender: 'Woman' }).gender, 'female');
});

// ---------------------------------------------------------------------------
// The wiring around the pure rules. CastStrip.jsx and VideoStudio.jsx are JSX,
// which node:test cannot import, so these assert the shape of the source the
// same way the other studio tests do (see personaBar.test.js).
const fs = require('node:fs');
const path = require('node:path');
const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('the panel hands the catalog description of a voice to the compiler', () => {
    // Naming a voice the model cannot place falls back to a generic adult male
    // — a named SpongeBob came back as one (2026-08-13). The catalog carries a
    // description of the timbre for exactly that, and the control that
    // GENERATES the starter prompt was dropping it while the starter kept it.
    assert.match(
        read('src/lib/promptWeave.js'),
        /voiceQuality: member\.useVoice \? String\(member\.entry\?\.voiceQuality \|\| ''\) : ''/,
    );
});

test('the cast lives in the studio, so a loaded prompt can be recast on the way in', () => {
    const studio = read('src/studios/VideoStudio.jsx');
    // Held in the engine, not inside the menu: a menu only remembers its
    // members while it is open, and a prompt can arrive while it is shut.
    assert.match(studio, /^\s*cast: \[\],$/m);
    assert.match(studio, /members=\{s\.cast\}/);
    // Every change in the menu applies at once — no Apply step to forget.
    assert.match(studio, /onMembersChange=\{applyCast\}/);
    // Every prompt from the library goes through the weave, with the starter's
    // stand-ins, and it changes the PROMPT only — loading a prompt is not a
    // request to reshuffle attachments (the rows the cast occupies are the
    // rows it already had). A starter's opt-in setup (timeline, duration)
    // rides beside the prompt and is applied separately, after the weave.
    assert.match(studio, /onLoadPrompt=\{\(\{ prompt, standIns, timeline, durationSeconds \}\) => \{\s*loadPromptText\(prompt, \{ standIns: standIns \|\| \[\] \}\);/);
    const loader = /const loadPromptText = \(text, \{ standIns = \[\] \} = \{\}\) => \{[\s\S]*?\n  \};/.exec(studio);
    assert.ok(loader, 'the loader exists');
    assert.match(loader[0], /acceptPrompt\(text, \{ standIns \}\)/);
    assert.doesNotMatch(loader[0], /referenceImageUrls|referenceVideos|referenceAudios/);
    // And every other door is the same call: the helper, the Shot Builder,
    // the insert bridge, the canvas restore, the References panel's Weave, and
    // the last one — Generate, for text typed straight into the box.
    assert.ok((studio.match(/acceptPrompt\(/g) || []).length >= 7, 'every door goes through acceptPrompt');
    assert.doesNotMatch(studio, /withReferenceTags|applyCharacterToPrompt|castApplication\(/);
});

// A persona clip switched to SOUND ONLY is a voice reference and nothing else:
// it binds the voice, never introduces the subject by sight, and writes no
// <Video N> line — with no picture beside it the name has to introduce them.
test('a persona clip switched to sound only is a voice reference, not the character reference', async () => {
    const { compileCastPrompt, castPersona } = await load();
    const soundOnly = castPersona('Liam', { images: ['/l.jpg'], videos: [{ url: '/liam.mov', motion: false, useAudio: true }], audios: [], gender: 'male' });
    const { prompt } = compileCastPrompt({ members: [soundOnly], speakingOrder: [0], template: { summary: 'x' } });
    assert.match(prompt, /<Subject 1> is the man shown in <Picture 1>/);
    assert.match(prompt, /<Audio 1> is the voice-timbre reference for <Subject 1>/);
    assert.match(prompt, /<Audio 1>: reference — only the timbre carries/);
    assert.doesNotMatch(prompt, /<Video 1>/);

    const noPicture = castPersona('Liam', { images: [], videos: [{ url: '/liam.mov', motion: false, useAudio: true }], audios: [], gender: 'male' });
    const named = compileCastPrompt({ members: [noPicture], speakingOrder: [0], template: { summary: 'x' } }).prompt;
    assert.match(named, /<Subject 1> is a man, Liam/);
    assert.match(named, /<Audio 1> is the voice-timbre reference for <Subject 1>/);
    assert.doesNotMatch(named, /<Video 1>/);
    assert.doesNotMatch(named, /IS the person in this clip/);
});

// ---------------------------------------------------------------------------
// The weave: a cast applied over the OTHER native format, over stand-ins, and
// over a persona that carries its own look (2026-08-23).

const LONE = { gender: 'female', images: ['/lone.jpg'], videos: [], audios: [] };

const THREE_FIELD = `integrated_multimodal_description: Handheld DV camcorder look. [Shot 1] A Korean woman in her early twenties (S1) sits on a low concrete wall; she has black wavy hair, black canvas sneakers. She smiles to herself. [Shot 2] At 00:05.000, she walks into an alley.

overall_soundscape: Birdsong, a distant motorcycle, light wind in the leaves.

non_diegetic_music: none`;

test('a three-field prompt is converted field by field, never swallowed whole', async () => {
    const { applyCastToPrompt, castPersona, parseSixSections } = await load();
    const { prompt } = applyCastToPrompt(THREE_FIELD, { members: [castPersona('Cheryl', LONE)] });
    const sections = parseSixSections(prompt);
    assert.doesNotMatch(sections.detailed_description, /integrated_multimodal_description|overall_soundscape|non_diegetic_music/);
    assert.match(sections.detailed_description, /^Handheld DV camcorder look\. \[Shot 1\] A Korean woman/);
    assert.equal(sections.overall_soundscape, 'Birdsong, a distant motorcycle, light wind in the leaves.');
    assert.equal(sections.non_diegetic_music, 'none');
    assert.ok(sections.subject_definitions.includes('<Subject 1> is the woman shown in <Picture 1>'));
});

test('a stand-in is bound to the member holding its slot, and its look goes with it', async () => {
    const { applyCastToPrompt, castPersona, parseSixSections } = await load();
    const standIns = [{
        index: 1,
        phrases: ['A Korean woman in her early twenties'],
        looks: ['; she has black wavy hair, black canvas sneakers'],
    }];
    const { prompt, standIns: report } = applyCastToPrompt(THREE_FIELD, {
        members: [castPersona('Cheryl', LONE)], standIns,
    });
    const sections = parseSixSections(prompt);
    assert.match(sections.detailed_description, /\[Shot 1\] <Subject 1> \(S1\) sits on a low concrete wall\. She smiles/);
    assert.doesNotMatch(sections.detailed_description, /black wavy hair/, 'the stand-in look is gone — the definition carries the real one');
    assert.deepEqual(report.bound, [1]);
    assert.deepEqual(report.remaining, []);
});

test('a stand-in for a slot nobody holds stays as written, and is handed back to bind later', async () => {
    const { applyCastToPrompt, castPersona } = await load();
    const standIns = [
        { index: 1, phrases: ['A Korean woman in her early twenties'], looks: [] },
        { index: 2, phrases: ['a stray tabby cat'], looks: [] },
    ];
    const text = `${THREE_FIELD} A stray tabby cat trots up.`.replace('A stray tabby cat', 'a stray tabby cat');
    const { prompt, standIns: report } = applyCastToPrompt(text, { members: [castPersona('Cheryl', LONE)], standIns });
    assert.match(prompt, /<Subject 1> \(S1\) sits/);
    assert.match(prompt, /a stray tabby cat trots up/);
    assert.deepEqual(report.bound, [1]);
    assert.deepEqual(report.remaining.map((item) => item.index), [2]);
});

test('a stand-in whose words were edited is refused and reported, not half-bound', async () => {
    const { applyCastToPrompt, castPersona } = await load();
    const standIns = [{ index: 1, phrases: ['A Korean woman in her early twenties'], looks: ['; she has black wavy hair'] }];
    const edited = THREE_FIELD.replace('A Korean woman', 'A Korean girl');
    const { prompt, warnings, standIns: report } = applyCastToPrompt(edited, { members: [castPersona('Cheryl', LONE)], standIns });
    assert.match(prompt, /A Korean girl in her early twenties \(S1\)/, 'text untouched');
    assert.deepEqual(report.unmatched, [1]);
    assert.ok(warnings.some((text) => /stand-in phrase is no longer in the text/.test(text)));
});

test("a persona's saved look fills the definition, so no blank reaches the model", async () => {
    const { applyCastToPrompt, castPersona, parseSixSections, APPEARANCE_BLANK } = await load();
    const withLook = { ...LONE, look: 'shoulder-length auburn hair, freckles, a grey hoodie' };
    const { prompt } = applyCastToPrompt('She waves.', { members: [castPersona('Cheryl', withLook)] });
    const sections = parseSixSections(prompt);
    assert.match(sections.subject_definitions, /<Subject 1> is the woman shown in <Picture 1>: shoulder-length auburn hair, freckles, a grey hoodie\./);
    assert.ok(!prompt.includes(APPEARANCE_BLANK));
    // And without one, the blank is the wording the Prompt Check knows.
    const bare = applyCastToPrompt('She waves.', { members: [castPersona('Cheryl', LONE)] }).prompt;
    assert.ok(bare.includes(APPEARANCE_BLANK));
    assert.match(APPEARANCE_BLANK, /write it out/);
});

test('a prompt with no summary gets one that names every subject and what drives it', async () => {
    const { applyCastToPrompt, castPersona, castCharacter, parseSixSections } = await load();
    const voiced = { ...LONE, audios: [{ url: '/cheryl.m4a', name: 'cheryl.m4a' }] };
    const { prompt } = applyCastToPrompt('They square off.', {
        members: [castPersona('Cheryl', voiced), castCharacter('SpongeBob SquarePants', 'SpongeBob SquarePants from the animated series SpongeBob SquarePants (1999)')],
    });
    const sections = parseSixSections(prompt);
    assert.match(sections.summary, /^\[audio reference\] One continuous take of <Subject 1>, speaking in the voice of <Audio 1>; and <Subject 2>\.$/);
});

test('the dialogue stub is written only by the explicit scaffold, never by an automatic weave', async () => {
    const { applyCastToPrompt, castPersona, parseSixSections } = await load();
    const voiced = { ...LONE, audios: [{ url: '/cheryl.m4a', name: 'cheryl.m4a' }] };
    const quiet = applyCastToPrompt('She waits by the window.', { members: [castPersona('Cheryl', voiced)] }).prompt;
    assert.ok(!quiet.includes('<d>'), 'an automatic weave leaves a silent description silent');
    const scaffolded = applyCastToPrompt('She waits by the window.', { members: [castPersona('Cheryl', voiced)], scaffold: true }).prompt;
    const sections = parseSixSections(scaffolded);
    assert.match(sections.detailed_description, /^\[Shot 1\] She waits by the window\.\n<Subject 1> \(S1\) <d>\[English\] Write the line you want spoken here/);
    // An empty composer under the scaffold gets the placeholder shot.
    const empty = applyCastToPrompt('', { members: [castPersona('Cheryl', voiced)], scaffold: true }).prompt;
    assert.match(parseSixSections(empty).detailed_description, /^\[Shot 1\] Medium shot of <Subject 1> against \[setting\]/);
});
