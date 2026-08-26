// The Story studio → Video studio handoff. See src/studios/story/handoff.js.
//
// What this is named after: on 2026-08-27 Liam filled the whole Viral Character
// Method out, pressed "Open in the Video studio", and landed in the composer
// with the motion script as loose prose and NOTHING attached — no character
// sheets, no location plate, no storyboard — on a rental serving MiniMax H3.
// Both halves were the same defect: the handoff sent only `primaryPrompt`, and
// the weave picks its grammar from what is attached, so with nothing attached
// there was no reference target and no six-section prompt to compile.
import assert from 'node:assert/strict';
import test from 'node:test';

const loadHandoff = () => import('../src/studios/story/handoff.js');
const loadWeave = () => import('../src/lib/promptWeave.js');
const loadDelivery = () => import('../src/lib/videoDelivery.js');

// The four targets this story can be sent to, as the matrix describes them.
const planFor = async (kind) => {
    const { deliveryPlan } = await loadDelivery();
    if (kind === 'h3') return deliveryPlan({ modelFamily: 'minimax', modelId: 'hivemind:minimax-h3' }, { referenceLane: true });
    if (kind === 'ltx-ingredients') return deliveryPlan({ modelFamily: 'ltx-2.3', modelId: 'hivemind:ltx23-ic-ingredients-lora' }, { ingredientsLane: true, endFrame: true });
    if (kind === 'ltx') return deliveryPlan({ modelFamily: 'ltx-2.3', modelId: 'hivemind:ltx23-regular-fp8' }, { endFrame: true });
    return deliveryPlan({ modelId: 'seedance-2.5-t2v' }, {});
};

const LIMITS = { images: 9, videos: 3, audios: 3 };

const story = (overrides = {}) => ({
    style: 'muted painterly animation',
    aspect: '9:16',
    title: 'The night driver',
    promise: 'The driver who has stopped noticing anyone is quietly kept company.',
    characters: [
        {
            id: 'c1', name: 'Halvard', role: 'the night driver', species: 'man',
            silhouette: 'heavy shoulders, work coat', face: 'deep-set eyes, grey stubble',
            pattern: '', signature: 'ticket punch on a lanyard', behavior: 'stands square',
            never: '', sheetUrl: 'https://x/halvard.png',
        },
        {
            id: 'c2', name: 'the moth', role: 'the companion', species: 'moth',
            silhouette: 'broad soft wings', face: '', pattern: 'pale grey dust',
            signature: '', behavior: 'resettles once', never: '', sheetUrl: 'https://x/moth.png',
        },
    ],
    location: { place: 'harbour bus stand', plateUrl: 'https://x/plate.png', motion: [], lights: '' },
    board: { format: 'four', arc: '', panels: [], sheetUrl: 'https://x/board.png' },
    motion: {
        seconds: 15, force: 'cold air off the water', layers: { subject: 'his shoulders drop on the exhale' },
        beats: [
            { from: 0, to: 5, action: 'the moth drops onto the ticket', emotion: 'he has not noticed' },
            { from: 5, to: 10, action: 'his hand reaches past it, stops, and comes back', emotion: 'attention' },
            { from: 10, to: 15, action: 'he pulls away from the stand', emotion: 'company, unacknowledged' },
        ],
        camera: 'macro on the machine, then close on his face', audio: 'the idling engine, one wing-beat',
        music: 'none', negatives: 'no on-screen text', limit: 0, override: '',
    },
    ...overrides,
});

const weaveHandoff = async (input) => {
    const { storyHandoff } = await loadHandoff();
    const { weavePrompt } = await loadWeave();
    const handoff = storyHandoff(input, { script: 'the prose script', plan: await planFor('h3') });
    return {
        handoff,
        ...weavePrompt(handoff.script, {
            cast: handoff.cast, limits: LIMITS, durationSeconds: handoff.seconds,
            target: 'reference', template: handoff.template,
        }),
    };
};

/* ---------------- what travels ---------------- */

test('every drawn sheet, the plate and the board travel with the script', async () => {
    const { storyHandoff } = await loadHandoff();
    const handoff = storyHandoff(story(), { script: 'the prose script', plan: await planFor('h3') });
    assert.equal(handoff.format, 'story-production');
    assert.equal(handoff.script, 'the prose script');
    assert.deepEqual(handoff.counts, { subjects: 2, scenes: 2, available: 4, pictures: 4, unattached: 0 });
    assert.equal(handoff.seconds, 15);
    assert.equal(handoff.aspect, '9:16');
});

test('a character whose sheet was never drawn is not in the cast', async () => {
    const { storyHandoff } = await loadHandoff();
    const input = story();
    input.characters[1].sheetUrl = '';
    const handoff = storyHandoff(input, { script: 's', plan: await planFor('h3') });
    assert.equal(handoff.counts.subjects, 1);
    assert.equal(handoff.cast.filter((member) => member.kind !== 'scene').length, 1);
});

test('the identity lines the sheet stage wrote become the subject appearance', async () => {
    const { storyHandoff } = await loadHandoff();
    const [first] = storyHandoff(story(), { script: 's', plan: await planFor('h3') }).cast;
    assert.match(first.data.look, /Halvard/);
    assert.match(first.data.look, /heavy shoulders, work coat/);
    assert.deepEqual(first.data.images, ['https://x/halvard.png']);
});

/* ---------------- what the weave then compiles ---------------- */

test('the handoff lands as H3’s six-section reference prompt, not prose', async () => {
    const { prompt } = await weaveHandoff(story());
    for (const section of ['subject_definitions', 'summary', 'retention_analysis',
        'detailed_description', 'overall_soundscape', 'non_diegetic_music']) {
        assert.ok(prompt.includes(`${section}:`), `missing ${section}`);
    }
    assert.ok(!prompt.includes('the prose script'), 'the loose script should have been replaced by the structure');
    assert.match(prompt, /\[Shot 1\] <Subject 2> drops onto the ticket/);
    assert.match(prompt, /At 00:05\.000, his hand reaches past it/);
    assert.match(prompt, /At 00:10\.000, /);
});

test('the story’s own names become the subjects the shot addresses', async () => {
    // A definition that names a subject the description never addresses is a
    // slot the model fills with whoever it likes — the Prompt Check flagged
    // exactly this on the first wired handoff, for BOTH subjects.
    const { prompt, warnings } = await weaveHandoff(story());
    const described = prompt.split('detailed_description:')[1];
    assert.ok(described.includes('<Subject 1>'), 'the first subject must appear in the description');
    assert.ok(described.includes('<Subject 2>'), 'the second subject must appear in the description');
    assert.match(described, /<Subject 1> and <Subject 2> are the only characters in it\./);
    assert.ok(!warnings.some((line) => line.includes('never appears')), warnings.join('\n'));
});

test('a longer name is recast before a shorter one it contains', async () => {
    const { subjectLabeller } = await loadHandoff();
    const label = subjectLabeller([{ name: 'Mira' }, { name: "Mira's mother" }]);
    assert.equal(label("Mira's mother waves at Mira"), '<Subject 2> waves at <Subject 1>');
});

test('the subject definitions keep the real names, so the sheet is identifiable', async () => {
    const { prompt } = await weaveHandoff(story());
    const definitions = prompt.split('summary:')[0];
    assert.match(definitions, /Who they are: Halvard, the night driver, man/);
    assert.ok(!/square\.\./.test(definitions), 'the appearance must not end in a doubled full stop');
});

test('the plate and the board are labelled, and neither is a subject', async () => {
    const { prompt } = await weaveHandoff(story());
    // Two people, so two subjects — the two extra pictures take none.
    assert.ok(prompt.includes('<Subject 2>'), 'the second person is <Subject 2>');
    assert.ok(!prompt.includes('<Subject 3>'), 'a place must never become a subject');
    assert.match(prompt, /<Picture 3> is the empty harbour bus stand plate/);
    assert.match(prompt, /<Picture 3>: attribute_transfer/);
    assert.match(prompt, /<Picture 4> is the storyboard for this clip/);
    assert.match(prompt, /<Picture 4>: weak_reference/);
    // The failure a board grid invites, said in H3's own grammar.
    assert.match(prompt, /never come back as a grid of panels/);
    assert.match(prompt, /It holds no subject and is not a person/);
});

test('the pictures are attached, subjects first, in cast order', async () => {
    const { rows } = await weaveHandoff(story());
    assert.deepEqual(rows.images, [
        'https://x/halvard.png', 'https://x/moth.png', 'https://x/plate.png', 'https://x/board.png',
    ]);
    assert.deepEqual(rows.videos, []);
    assert.deepEqual(rows.audios, []);
});

test('a non-human subject is not asserted to have real human skin', async () => {
    const { prompt } = await weaveHandoff(story());
    assert.match(prompt, /<Subject 2> is the moth shown in <Picture 2>/);
    assert.ok(!prompt.includes('real human skin texture'), 'the persona photoreal default must not cover a story cast');
    assert.match(prompt, /rendered as muted painterly animation/);
});

test('a script with no dialogue gives nobody a speaker id', async () => {
    const { prompt, warnings } = await weaveHandoff(story());
    assert.ok(!/speaks as S\d/.test(prompt), 'a silent clip has no speakers');
    assert.ok(!warnings.some((line) => line.includes('subjects speak')),
        'the two-speakers warning must not fire on a clip where nobody speaks');
});

test('the run length and the beats agree, so nothing is cut or invented', async () => {
    const { warnings } = await weaveHandoff(story());
    assert.ok(!warnings.some((line) => line.includes('unwritten')), warnings.join('\n'));
    assert.ok(!warnings.some((line) => line.includes('but the clip is')), warnings.join('\n'));
});

test('re-weaving the landed prompt changes nothing', async () => {
    // Pressing Weave, attaching one more picture or reordering the cast all
    // re-run the weave over the prompt it already produced. The story prompt
    // used to grow a "<Subject 1> speaks as S1." on that second pass — a silent
    // clip quietly acquiring a speaker the moment anything was touched.
    const { storyHandoff } = await loadHandoff();
    const { weavePrompt } = await loadWeave();
    const handoff = storyHandoff(story(), { script: 'the prose script', plan: await planFor('h3') });
    const options = {
        cast: handoff.cast, limits: LIMITS, durationSeconds: handoff.seconds, target: 'reference',
    };
    const first = weavePrompt(handoff.script, { ...options, template: handoff.template });
    const second = weavePrompt(first.prompt, options);
    assert.equal(second.prompt, first.prompt);
});

test('a scene picture is one member, so each row answers for itself', async () => {
    // The References panel edits scene pictures per ROW — "is this a place or
    // is it staging" — so a member holding two of them could not answer.
    const { storyHandoff } = await loadHandoff();
    const scenes = storyHandoff(story(), { script: 's', plan: await planFor('h3') })
        .cast.filter((member) => member.kind === 'scene');
    assert.equal(scenes.length, 2);
    for (const member of scenes) assert.equal(member.data.images.length, 1);
    assert.deepEqual(scenes.map((member) => member.retention), ['attribute_transfer', 'weak_reference']);
});

/* ---------------- the cast stays honest afterwards ---------------- */

test('a picture dropped on the composer joins a person, never the location plate', async () => {
    const { storyHandoff } = await loadHandoff();
    const { reconcileCast, castRows } = await loadWeave();
    const { cast } = storyHandoff(story(), { script: 's', plan: await planFor('h3') });
    const rows = castRows(cast);
    const next = reconcileCast(cast, { ...rows, images: [...rows.images, 'https://x/dropped.png'] });
    const place = next.find((member) => member.key === 'story:place');
    assert.deepEqual(place.data.images, ['https://x/plate.png']);
    const board = next.find((member) => member.key === 'story:board');
    assert.deepEqual(board.data.images, ['https://x/board.png']);
    const owner = next.find((member) => (member.data?.images || []).includes('https://x/dropped.png'));
    assert.ok(owner, 'somebody must own the new picture');
    assert.notEqual(owner.kind, 'scene');
});

test('removing the plate leaves the subjects and their pictures untouched', async () => {
    const { storyHandoff } = await loadHandoff();
    const { reconcileCast, castRows } = await loadWeave();
    const { cast } = storyHandoff(story(), { script: 's', plan: await planFor('h3') });
    const kept = cast.filter((member) => member.key !== 'story:place');
    const next = reconcileCast(kept, castRows(kept));
    assert.equal(next.length, 3);
    assert.deepEqual(castRows(next).images, [
        'https://x/halvard.png', 'https://x/moth.png', 'https://x/board.png',
    ]);
});

test('the helper is told about the people only', async () => {
    const { storyHandoff } = await loadHandoff();
    const { castSubjects } = await loadWeave();
    const subjects = castSubjects(storyHandoff(story(), { script: 's', plan: await planFor('h3') }).cast);
    assert.equal(subjects.length, 2);
    assert.deepEqual(subjects.map((row) => row.subject), [1, 2]);
});

/* ---------------- every other target ---------------- */

test('LTX takes the sheets as stitched ingredient views, with their own captions', async () => {
    const { storyHandoff } = await loadHandoff();
    const handoff = storyHandoff(story(), { script: 's', plan: await planFor('ltx-ingredients') });
    assert.equal(handoff.grammar, 'ltx-ingredients');
    assert.equal(handoff.cast.length, 0, 'ingredients are not a cast');
    assert.deepEqual(handoff.ingredients.map((view) => view.url), [
        'https://x/halvard.png', 'https://x/moth.png', 'https://x/plate.png',
    ]);
    assert.match(handoff.ingredients[0].description, /Halvard, the night driver/);
    assert.ok(!handoff.ingredients[0].description.includes('Silhouette:'),
        'a paragraph caption must not carry the sheet prompt’s labels');
    assert.match(handoff.ingredients[2].description, /with no one in it/);
    // The board is not a character or a prop, so it does not become an ingredient.
    assert.equal(handoff.counts.unattached, 1);
});

test('an LTX prompt is one paragraph with no shot markers, and its negatives leave the prompt', async () => {
    const { storyHandoff } = await loadHandoff();
    const handoff = storyHandoff(story(), { script: 's', plan: await planFor('ltx-ingredients') });
    assert.ok(!/\[Shot \d\]/.test(handoff.prompt), 'LTX has no shot grammar');
    assert.ok(!/00:\d\d\./.test(handoff.prompt), 'LTX has no timecodes');
    assert.ok(!handoff.prompt.includes('\n'), 'one paragraph');
    assert.match(handoff.prompt, /from the reference sheet/);
    // The sheet carries the look; repeating it in the paragraph makes the two compete.
    assert.ok(!handoff.prompt.includes('deep-set eyes'), 'the look belongs to the sheet here');
    assert.equal(handoff.negativePrompt, 'no on-screen text');
    assert.ok(!handoff.prompt.includes('on-screen text'),
        'on the native distilled path an unwanted thing named in the positive prompt is one asked for');
});

test('with no picture lane the LTX paragraph describes the characters itself', async () => {
    const { storyHandoff } = await loadHandoff();
    const handoff = storyHandoff(story(), { script: 's', plan: await planFor('ltx') });
    assert.equal(handoff.grammar, 'ltx-paragraph');
    assert.equal(handoff.ingredients.length, 0);
    assert.equal(handoff.counts.unattached, 4, 'all four pictures stay behind, and that is said');
    assert.match(handoff.prompt, /Halvard, the night driver, a man/);
});

test('Seedance gets labelled blocks and keeps its prohibitions in the prompt', async () => {
    const { storyHandoff } = await loadHandoff();
    const handoff = storyHandoff(story(), { script: 's', plan: await planFor('seedance') });
    assert.equal(handoff.grammar, 'seedance-blocks');
    for (const block of ['SUBJECT:', 'SETTING:', 'VISUAL STYLE:', 'TIMELINE:', 'CAMERA:', 'AUDIO:', 'GOAL:']) {
        assert.ok(handoff.prompt.includes(block), `missing ${block}`);
    }
    // Seedance takes prohibitions in the prompt; H3 documents that they do not work.
    assert.match(handoff.prompt, /No on-screen text/);
    assert.equal(handoff.negativePrompt, '', 'Seedance has no negative field here');
});

test('a run longer than the target holds is clamped, and what was asked for is kept', async () => {
    const { storyHandoff } = await loadHandoff();
    const ltx = storyHandoff(story(), { script: 's', plan: await planFor('ltx') });
    assert.equal(ltx.askedSeconds, 15);
    assert.equal(ltx.seconds, 10, 'LTX holds a scene for about ten seconds');
    const h3 = storyHandoff(story(), { script: 's', plan: await planFor('h3') });
    assert.equal(h3.seconds, 15);
});

/* ---------------- the model without a reference lane ---------------- */

test('with no reference target the prose script is what lands', async () => {
    const { storyHandoff } = await loadHandoff();
    const { weavePrompt } = await loadWeave();
    const handoff = storyHandoff(story(), { script: 'the prose script', plan: await planFor('h3') });
    const woven = weavePrompt(handoff.script, {
        cast: [], limits: LIMITS, durationSeconds: handoff.seconds, target: 'prose', template: handoff.template,
    });
    assert.equal(woven.prompt, 'the prose script');
    assert.equal(woven.rows, null);
});
