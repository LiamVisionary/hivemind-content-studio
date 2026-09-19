// Recast — putting your cast into somebody else's clip.
//
// The grammar is the whole product here: a recast that leaves out one of its
// three clauses does not fail loudly, it comes back looking like the source
// video with strangers in it. So the clauses are asserted as TEXT, and the
// contract that separates a recast from a plain motion reference is asserted
// both ways — on and off — because the default must not drift.

const test = require('node:test');
const assert = require('node:assert/strict');

const recastLib = () => import('../src/lib/h3Recast.js');
const castLib = () => import('../src/lib/castPrompt.js');
const weaveLib = () => import('../src/lib/promptWeave.js');

const SAYORI = {
    look: 'short messy coral pink bob hair, blue eyes, school uniform, one red hair bow',
    images: ['/sayori-1.png', '/sayori-2.png'],
    videos: [],
    audios: [],
};

const plan = (over = {}) => ({
    shots: [
        { id: 's1', at: 0, transition: 'the shot cuts to', framing: '', action: 'Medium close-up, eye-level. The two face each other.' },
        { id: 's2', at: 2.5, transition: 'the shot cuts to', framing: 'a close-up of their hands', action: 'She grabs her hand.' },
    ],
    setting: 'A dimly lit room with cool blue lighting and bookshelves',
    styleLock: true,
    blend: true,
    proportions: true,
    ...over,
});

const SUBJECTS = [
    { subject: '<Subject 1>', name: 'Sayori', look: SAYORI.look },
    { subject: '<Subject 2>', name: 'Monika', look: 'long coral brown hair in a high ponytail, green eyes, one white hair bow' },
];

test('the style lock names the pictures and rules the clip out', async () => {
    const { styleLockSentence } = await recastLib();
    const line = styleLockSentence({ pictures: ['<Picture 1>', '<Picture 2>'], videos: ['<Video 1>'] });

    // Both halves. The positive half alone loses to the source clip, which is
    // the failure this whole flow exists to prevent.
    assert.match(line, /Use the exact art style of <Picture 1> and <Picture 2> only\./);
    assert.match(line, /Do not match or copy the art style of <Video 1>\./);
});

test('with no clip attached the lock states where the style comes from and stops', async () => {
    const { styleLockSentence } = await recastLib();
    const line = styleLockSentence({ pictures: ['<Picture 1>'], videos: [] });
    assert.match(line, /Use the exact art style of <Picture 1> only\./);
    assert.doesNotMatch(line, /Do not match/);
});

test('the description carries every clause, in the order it is read', async () => {
    const { recastDescription } = await recastLib();
    const body = recastDescription({
        plan: plan(), subjects: SUBJECTS, pictures: ['<Picture 1>', '<Picture 2>'], videos: ['<Video 1>'],
    });

    assert.match(body, /Use the exact art style of <Picture 1> and <Picture 2> only/);
    // The room, then the blend — the cast must not arrive lit by their sheets.
    assert.match(body, /A dimly lit room with cool blue lighting and bookshelves\./);
    assert.match(body, /Ensure <Subject 1> and <Subject 2> blend into the lighting, color and shadow of the setting without changing their appearances\./);
    assert.match(body, /Maintain consistent height, scale and body proportions/);
    // The shots themselves, serialized by h3Shots — same sentence a Shot
    // Builder shot gets, including the cut stamp on the second.
    assert.match(body, /\[Shot 1\] Medium close-up, eye-level\./);
    assert.match(body, /\[Shot 2\] At 00:02\.500, the shot cuts to a close-up of their hands\./);
    // …and the restatement last, built from the cast's own looks.
    assert.match(body, /Keep <Subject 1> as short messy coral pink bob hair.*and <Subject 2> as long coral brown hair.*clearly recognizable throughout/s);

    // The style lock must come before the shots: it is the frame everything
    // after it is read inside.
    assert.ok(body.indexOf('Use the exact art style') < body.indexOf('[Shot 1]'));
});

test('a shot marker is never written outside the description', async () => {
    // h3PromptCheck counts [Shot N] ANYWHERE as a shot header, so a marker in
    // the summary reports a numbering skip on a prompt that is correct.
    const { recastSummary } = await recastLib();
    const summary = recastSummary({
        plan: plan(), subjects: SUBJECTS, pictures: ['<Picture 1>'], videos: ['<Video 1>'],
    });
    assert.doesNotMatch(summary, /\[Shot\s*\d+\]/);
    assert.match(summary, /\[reference generation\]/);
    assert.match(summary, /re-performed by <Subject 1> and <Subject 2>/);
    assert.match(summary, /Do NOT copy the art style of <Video 1>/);
    assert.match(summary, /expressions, actions, staging and camera cuts only/);
});

test('switching a clause off removes it and leaves the rest intact', async () => {
    const { recastDescription } = await recastLib();
    const body = recastDescription({
        plan: plan({ styleLock: false, proportions: false }),
        subjects: SUBJECTS, pictures: ['<Picture 1>'], videos: ['<Video 1>'],
    });
    assert.doesNotMatch(body, /Use the exact art style/);
    assert.doesNotMatch(body, /Maintain consistent height/);
    // The setting survives a blend that is still on, and so do the shots.
    assert.match(body, /blend into the lighting/);
    assert.match(body, /\[Shot 1\]/);
});

test('blend off still writes the setting — the room is not the blend', async () => {
    const { recastDescription } = await recastLib();
    const body = recastDescription({
        plan: plan({ blend: false }), subjects: SUBJECTS, pictures: ['<Picture 1>'], videos: ['<Video 1>'],
    });
    assert.match(body, /A dimly lit room with cool blue lighting and bookshelves\./);
    assert.doesNotMatch(body, /blend into the lighting/);
});

/* ---------------- the cast half: two contracts, one flag ---------------- */

test('recast widens what the clip may give and names its art style as excluded', async () => {
    const { compileCastPrompt, castPersona } = await castLib();
    const members = [castPersona('Sayori', { ...SAYORI, videos: [{ url: '/source.mp4', name: 'source.mp4' }] })];

    const off = compileCastPrompt({ members }).prompt;
    const on = compileCastPrompt({ members, recast: true }).prompt;

    // OFF — the motion contract, unchanged. This is the default and it must
    // stay the default: it is right for a shot you wrote yourself.
    assert.match(off, /<Video 1>: attribute_transfer — only its manner of movement carries\./);
    assert.doesNotMatch(off, /shot structure/);
    assert.doesNotMatch(off, /ART STYLE/);

    // ON — the shot carries, the style and the performers do not.
    assert.match(on, /<Video 1>: attribute_transfer — its shot structure, camera cuts, framing, staging, timing/);
    assert.match(on, /Its ART STYLE does NOT carry/);
    assert.match(on, /performers' faces, hair, build, wardrobe or identity/);
});

test('recast tells the pictures they are a design guide, not frames or poses', async () => {
    const { compileCastPrompt, castPersona } = await castLib();
    const members = [castPersona('Sayori', SAYORI)];

    const off = compileCastPrompt({ members }).prompt;
    const on = compileCastPrompt({ members, recast: true }).prompt;

    assert.doesNotMatch(off, /NOT frames and NOT poses/);
    // Said where the picture is introduced…
    assert.match(on, /The reference pictures are a guide to <Subject 1>'s character design only/);
    assert.match(on, /They are NOT frames and NOT poses/);
    // …and again in the retention line, which is where the model reads the
    // per-label contract.
    assert.match(on, /<Picture 1>: fully_preserved — .*It is a character-design guide only: its framing, pose and expression do NOT carry\./);
});

test('a subject bound to a clip instead of pictures is not told "not a pose"', async () => {
    // With no picture the clip IS the identity reference; a design-guide clause
    // about pictures that do not exist would contradict that.
    const { compileCastPrompt, castPersona } = await castLib();
    const members = [castPersona('Sayori', {
        look: SAYORI.look, images: [], videos: [{ url: '/only.mp4', name: 'only.mp4' }], audios: [],
    })];
    const on = compileCastPrompt({ members, recast: true }).prompt;
    assert.doesNotMatch(on, /NOT frames and NOT poses/);
    assert.match(on, /<Video 1>: fully_preserved — <Subject 1> IS the person in this clip/);
});

/* ---------------- the whole way through the weave ---------------- */

test('the weave writes the cast half and the recast template writes the creative half', async () => {
    const { weavePrompt } = await weaveLib();
    const { recastTemplate } = await recastLib();

    const cast = [
        { key: 'references', kind: 'persona', name: 'Sayori', data: { look: SAYORI.look, images: SAYORI.images, videos: [{ url: '/source.mp4', name: 'source.mp4' }], audios: [] } },
    ];
    const subjects = [{ subject: '<Subject 1>', name: 'Sayori', look: SAYORI.look }];
    const template = recastTemplate({
        plan: plan(), subjects, pictures: ['<Picture 1>', '<Picture 2>'], videos: ['<Video 1>'],
    });

    const { prompt } = weavePrompt('', {
        cast, target: 'reference', durationSeconds: 10, template, recast: true,
    });

    // Six sections, all present, in H3's order.
    for (const section of ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']) {
        assert.match(prompt, new RegExp(`^${section}:`, 'm'), `missing ${section}`);
    }
    // The cast half carries the recast wording…
    assert.match(prompt, /They are NOT frames and NOT poses/);
    assert.match(prompt, /Its ART STYLE does NOT carry/);
    // …and the creative half carries the plan.
    assert.match(prompt, /Use the exact art style of <Picture 1> and <Picture 2> only/);
    assert.match(prompt, /\[Shot 2\] At 00:02\.500/);
});

test("the author's soundscape survives a recast", async () => {
    // A recast that replaced a written soundscape with boilerplate would be the
    // 2026-08-23 "it doesn't weave" failure in a new coat.
    const { weavePrompt } = await weaveLib();
    const { recastTemplate } = await recastLib();
    const written = [
        'subject_definitions:', '<Subject 1> is a woman: red hair.', '',
        'summary:', 'Something else entirely.', '',
        'retention_analysis:', '—', '',
        'detailed_description:', '[Shot 1] Something else.', '',
        'overall_soundscape:', 'Rain on a window, one distant siren, no other speakers.', '',
        'non_diegetic_music:', 'A slow piano figure.',
    ].join('\n');

    const cast = [{ key: 'references', kind: 'persona', name: '', data: { look: SAYORI.look, images: SAYORI.images, videos: [], audios: [] } }];
    const { prompt } = weavePrompt(written, {
        cast,
        target: 'reference',
        durationSeconds: 10,
        template: recastTemplate({ plan: plan(), subjects: SUBJECTS.slice(0, 1), pictures: ['<Picture 1>'], videos: [] }),
        recast: true,
    });

    assert.match(prompt, /Rain on a window, one distant siren, no other speakers\./);
    assert.match(prompt, /A slow piano figure\./);
    // The summary and description ARE replaced — that is what applying does.
    assert.doesNotMatch(prompt, /Something else entirely/);
    assert.match(prompt, /\[reference generation\]/);
});

/* ---------------- what the panel warns about ---------------- */

test('warnings name the shots nobody described, and the length that frays', async () => {
    const { recastWarnings, RECAST_SECONDS } = await recastLib();

    const codes = (found) => found.map((entry) => entry.code);

    const blank = recastWarnings({
        plan: plan({ shots: [{ id: 'a', at: 0, action: 'Something.' }, { id: 'b', at: 3, action: '' }] }),
        durationSeconds: 10, pictures: ['<Picture 1>'], videos: ['<Video 1>'], subjects: SUBJECTS,
    });
    assert.ok(codes(blank).includes('blank-shot'));
    assert.deepEqual(blank.find((entry) => entry.code === 'blank-shot').shots, [2]);
    // Ten seconds is the sweet spot, so it is not warned about.
    assert.ok(!codes(blank).includes('long'));

    const long = recastWarnings({ plan: plan(), durationSeconds: 11, pictures: ['<Picture 1>'], videos: ['<Video 1>'], subjects: SUBJECTS });
    assert.ok(codes(long).includes('long'));
    const tooLong = recastWarnings({ plan: plan(), durationSeconds: 15, pictures: ['<Picture 1>'], videos: ['<Video 1>'], subjects: SUBJECTS });
    assert.ok(codes(tooLong).includes('too-long'));
    assert.equal(RECAST_SECONDS.best, 10);
    assert.equal(RECAST_SECONDS.max, 12);

    // No clip at all is not a recast, and no pictures means the source's own
    // performers are the only faces in the run.
    const bare = recastWarnings({ plan: plan(), durationSeconds: 10, pictures: [], videos: [], subjects: SUBJECTS });
    assert.ok(codes(bare).includes('no-clip'));
    assert.ok(codes(bare).includes('no-pictures'));

    // A cut stamped past the end of the run is a shot that never plays.
    const past = recastWarnings({
        plan: plan({ shots: [{ id: 'a', at: 0, action: 'One.' }, { id: 'b', at: 9, action: 'Two.' }] }),
        durationSeconds: 6, pictures: ['<Picture 1>'], videos: ['<Video 1>'], subjects: SUBJECTS,
    });
    assert.deepEqual(past.find((entry) => entry.code === 'cut-past-end').shots, [2]);
});

test('a subject with no look is named, because the restatement cannot be written without it', async () => {
    const { recastWarnings, recognitionSentence } = await recastLib();
    const subjects = [{ subject: '<Subject 1>', name: 'Sayori', look: '' }];
    const found = recastWarnings({ plan: plan(), durationSeconds: 10, pictures: ['<Picture 1>'], videos: ['<Video 1>'], subjects });
    assert.deepEqual(found.find((entry) => entry.code === 'no-look').subjects, ['<Subject 1>']);
    // …and nothing is invented in its place.
    assert.equal(recognitionSentence(subjects), '');
});

/* ---------------- read-back ---------------- */

test('a recast prompt is recognised from the prompt, not from a flag', async () => {
    const { isRecastPrompt, recastTemplate } = await recastLib();
    const { detailed_description: body } = recastTemplate({
        plan: plan(), subjects: SUBJECTS, pictures: ['<Picture 1>'], videos: ['<Video 1>'],
    });
    assert.ok(isRecastPrompt(body));
    assert.ok(!isRecastPrompt('integrated_multimodal_description: a woman walks into a room'));
    assert.ok(!isRecastPrompt(''));
});

test('reopening seeds the plan from the shots already in the prompt', async () => {
    const { recastFromPrompt, recastDescription } = await recastLib();
    const body = recastDescription({
        plan: plan(), subjects: SUBJECTS, pictures: ['<Picture 1>'], videos: ['<Video 1>'],
    });
    const seeded = recastFromPrompt(body);
    assert.equal(seeded.shots.length, 2);
    assert.equal(seeded.shots[0].at, 0);
    assert.equal(seeded.shots[1].at, 2.5);
    assert.equal(seeded.shots[1].framing, 'a close-up of their hands');
    assert.match(seeded.shots[1].action, /She grabs her hand\./);
    // A prompt with no shots seeds nothing rather than a blank plan that would
    // overwrite one the author already built.
    assert.equal(recastFromPrompt('nothing here'), null);
});

test('the blend sentence agrees with how many subjects there are', async () => {
    const { blendSentence } = await recastLib();
    const one = blendSentence({ subjects: ['<Subject 1>'], setting: 'A blue room' });
    assert.match(one, /Ensure <Subject 1> blends into/);
    assert.match(one, /without changing their appearance\./);
    const two = blendSentence({ subjects: ['<Subject 1>', '<Subject 2>'], setting: 'A blue room' });
    assert.match(two, /Ensure <Subject 1> and <Subject 2> blend into/);
    assert.match(two, /without changing their appearances\./);
});

test('a render style on a member is reported as arguing with the style lock', async () => {
    // "rendered as photoreal live-action, not illustrated" in subject_definitions
    // against "use the art style of the pictures" in the description. A drawn
    // character sheet loses that argument, which is the usual recast.
    const { recastWarnings } = await recastLib();
    const styled = [{ subject: '<Subject 1>', kind: 'persona', look: 'pink bob', style: 'photoreal live-action' }];
    const found = recastWarnings({
        plan: plan(), durationSeconds: 10, pictures: ['<Picture 1>'], videos: ['<Video 1>'], subjects: styled,
    });
    assert.deepEqual(found.find((entry) => entry.code === 'style-clash').subjects, ['<Subject 1>']);

    // Switching the lock off settles the argument, so the warning goes.
    const unlocked = recastWarnings({
        plan: plan({ styleLock: false }), durationSeconds: 10, pictures: ['<Picture 1>'], videos: ['<Video 1>'], subjects: styled,
    });
    assert.equal(unlocked.find((entry) => entry.code === 'style-clash'), undefined);

    // …and a member with no style of its own never triggers it.
    const plain = recastWarnings({
        plan: plan(), durationSeconds: 10, pictures: ['<Picture 1>'], videos: ['<Video 1>'], subjects: SUBJECTS,
    });
    assert.equal(plain.find((entry) => entry.code === 'style-clash'), undefined);
});

test('castLineup carries the style the warning is about', async () => {
    const { castLineup, reconcileCast } = await weaveLib();
    const cast = reconcileCast([], { images: ['/a.png'], videos: [], audios: [] }, { persona: null });
    const [first] = castLineup(cast);
    // The references member takes the photoreal default, which is exactly the
    // assertion that fights a drawn character sheet.
    assert.match(first.style, /photoreal live-action/);
    assert.equal(first.subject, '<Subject 1>');
});

/* ---------------- the wiring the pure grammar cannot see ---------------- */
//
// Deliberately textual, per this repo's convention for studio panels: what is
// pinned is where the flow is offered from and which gate each door is behind.
// A recast offered on a model with no recast grammar is the failure these
// catch.

const fs = require('node:fs');
const path = require('node:path');
const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('every door into a recast is behind the H3 gate', () => {
    const studio = read('src/studios/VideoStudio.jsx');
    // The dialog writes H3's six sections, so switching family closes it
    // rather than leaving it open over a run that cannot take the prompt.
    assert.match(studio, /\{Boolean\(s\.recastOpen\) && isH3\(\) \?/);
    // isH3() is model-id based, which is what makes this work on every lane —
    // this Mac, a rented box, the hosted rail — rather than on one of them.
    assert.match(studio, /const isH3 = \(\) => \/minimax-h3\/\.test\(s\.setup\.modelId \|\| ''\)/);

    const bar = read('src/studios/video/VideoComposerBar.jsx');
    // The chip sits inside the h3-only block beside the Shot Builder…
    assert.match(bar, /<RecastChip/);
    // …and the References panel's door carries the same gate.
    assert.match(bar, /onRecast=\{h3 && onOpenRecast \? onOpenRecast : null\}/);
});

test('the References panel offers it where the clip is', () => {
    const panel = read('src/studios/video/ReferencesMenu.jsx');
    // Only with a MOTION clip attached: a sound-only row carries no <Video N>
    // and has no shots to describe.
    assert.match(panel, /\{onRecast && motionReferenceRows\(videos\)\.length \?/);
    assert.match(panel, /Want the clip’s shots too, not just its movement\?/);
});

test('the plan survives the panel closing, and the reload', () => {
    const studio = read('src/studios/VideoStudio.jsx');
    // Held on the studio, like the shot timeline — a shot list built against a
    // clip is real work.
    assert.match(studio, /recastPlan: blankRecast\(\),/);
    // …and written to the tab's own encrypted draft, never the plaintext store.
    assert.match(studio, /for \(const key of \['cast', 'standIns', 'shotTimeline', 'recastPlan'\]\)/);
    // The plan is an object, so it cannot ride the array restore loop.
    assert.match(studio, /if \(savedRecast\?\.shots\?\.length && !recastShotsWritten\(s\.recastPlan\)\) s\.recastPlan = savedRecast;/);
});

test('the chip is armed from the prompt, so Start fresh unlights it', () => {
    const studio = read('src/studios/VideoStudio.jsx');
    assert.match(studio, /const recastArmed = \(\) => isRecastPrompt\(s\.setup\.prompt\);/);
    // …and a prompt that already holds a recast keeps the contract through
    // every later weave, rather than reverting to the motion wording when a
    // picture is attached.
    assert.match(studio, /recast: recast \|\| isRecastPrompt\(text\)/);
});

test('a persona name reaches the panel but never the prompt helper', () => {
    // castSubjects withholds it on purpose: its output goes to a model call.
    // castLineup is the local-display sibling and may say it.
    const weave = read('src/lib/promptWeave.js');
    assert.match(weave, /export function castLineup/);
    assert.match(weave, /name: String\(member\.name \|\| ''\),/);
    const studio = read('src/studios/VideoStudio.jsx');
    assert.match(studio, /subjects=\{castLineup\(s\.cast\)\}/, 'the recast panel uses the local one');
    assert.match(studio, /cast=\{castSubjects\(s\.cast\)\}/, 'the prompt helper still uses the withholding one');
});
