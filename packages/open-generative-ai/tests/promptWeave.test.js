// The weave: every door into the composer goes through one rule. See
// src/lib/promptWeave.js. The scenarios here are the ones that did not work on
// 2026-08-23 — each test is named after what Liam pressed.
import assert from 'node:assert/strict';
import test from 'node:test';

const load = () => import('../src/lib/promptWeave.js');
const loadCast = () => import('../src/lib/castPrompt.js');
const loadStarters = () => import('../src/lib/defaultPrompts.js');
const loadCharacters = () => import('../src/lib/h3Characters.js');

const LIMITS = { images: 9, videos: 3, audios: 3 };
const PICTURES = ['/api/media-studio/references/a.jpg', '/api/media-studio/references/b.jpg', '/api/media-studio/references/c.jpg'];
const VOICE = { url: '/api/media-studio/references/me.m4a', name: 'me.m4a' };
const WALK = { url: '/api/media-studio/references/walk.mov', name: 'walk.mov', useAudio: false };

const THREE_FIELD = `integrated_multimodal_description: Handheld DV camcorder look. [Shot 1] A Korean woman in her early twenties (S1) sits on a low concrete wall; she has black wavy hair, black canvas sneakers. She smiles to herself. [Shot 2] At 00:05.000, she walks into an alley.

overall_soundscape: Birdsong, a distant motorcycle, light wind in the leaves.

non_diegetic_music: none`;
const STAND_INS = [{ index: 1, phrases: ['A Korean woman in her early twenties'], looks: ['; she has black wavy hair, black canvas sneakers'] }];

/* ---------------- reconcileCast: the rows ARE a member ---------------- */

test('pictures attached by hand become <Subject 1> without opening any menu', async () => {
    const { reconcileCast, REFERENCES_KEY, castRows } = await load();
    const cast = reconcileCast([], { images: PICTURES, videos: [], audios: [VOICE] });
    assert.equal(cast.length, 1);
    assert.equal(cast[0].key, REFERENCES_KEY);
    assert.equal(cast[0].kind, 'persona');
    assert.deepEqual(cast[0].data.images, PICTURES);
    assert.deepEqual(cast[0].data.audios, [VOICE]);
    assert.deepEqual(castRows(cast), { images: PICTURES, videos: [], audios: [VOICE] });
});

test('a loaded Persona ID names the references member; its pictures are still the rows', async () => {
    const { reconcileCast, castPersonaIdentity } = await load();
    const rows = { images: PICTURES.slice(0, 2), videos: [], audios: [] };
    const persona = { id: 'p1', name: 'Cheryl', gender: 'female', look: 'auburn hair' };
    const cast = reconcileCast([], rows, { persona });
    assert.equal(cast[0].key, 'persona:p1');
    assert.equal(cast[0].name, 'Cheryl');
    assert.equal(cast[0].data.gender, 'female');
    assert.equal(cast[0].data.look, 'auburn hair');
    assert.deepEqual(castPersonaIdentity(cast), { id: 'p1', name: 'Cheryl', gender: 'female', look: 'auburn hair' });
    // Naming happens after the rows, too: first the rows arrive anonymous…
    const anonymous = reconcileCast([], rows);
    // …then the identity, and the SAME member is renamed rather than doubled.
    const named = reconcileCast(anonymous, rows, { persona });
    assert.equal(named.length, 1);
    assert.equal(named[0].key, 'persona:p1');
});

test('a picture added to a loaded persona edits THAT persona; one removed leaves it', async () => {
    const { reconcileCast } = await load();
    const persona = { id: 'p1', name: 'Cheryl', gender: 'female' };
    let cast = reconcileCast([], { images: PICTURES.slice(0, 2), videos: [], audios: [] }, { persona });
    cast = reconcileCast(cast, { images: PICTURES, videos: [WALK], audios: [] }, { persona });
    assert.equal(cast.length, 1, 'still one member');
    assert.deepEqual(cast[0].data.images, PICTURES);
    assert.deepEqual(cast[0].data.videos, [WALK]);
    cast = reconcileCast(cast, { images: [PICTURES[2]], videos: [], audios: [] }, { persona });
    assert.deepEqual(cast[0].data.images, [PICTURES[2]]);
    cast = reconcileCast(cast, { images: [], videos: [], audios: [] }, { persona });
    assert.deepEqual(cast, [], 'a persona with no media left leaves the shot');
});

test('a person attached after a character goes FIRST — the cartoon moves to <Subject 2>', async () => {
    const { reconcileCast, characterCastMember } = await load();
    const { H3_CHARACTERS } = await loadCharacters();
    const sponge = characterCastMember(H3_CHARACTERS.find((entry) => /SpongeBob/.test(entry.name)));
    const cast = reconcileCast([sponge], { images: PICTURES, videos: [], audios: [] });
    assert.deepEqual(cast.map((member) => member.kind), ['persona', 'character']);
    assert.equal(cast[1].key, sponge.key);
});

test('with two personas from the Cast menu, hand-attached media is a third person after them', async () => {
    const { reconcileCast, personaMember, REFERENCES_KEY } = await load();
    const cheryl = personaMember({ id: 'c', name: 'Cheryl', data: { gender: 'female', images: [PICTURES[0]], videos: [], audios: [] } });
    const dana = personaMember({ id: 'd', name: 'Dana', data: { gender: 'female', images: [PICTURES[1]], videos: [], audios: [] } });
    const rows = { images: [PICTURES[0], PICTURES[1], PICTURES[2]], videos: [], audios: [] };
    const cast = reconcileCast([cheryl, dana], rows);
    assert.deepEqual(cast.map((member) => member.key), ['persona:c', 'persona:d', REFERENCES_KEY]);
    assert.deepEqual(cast[2].data.images, [PICTURES[2]]);
    // Row ORDER is kept per member even when the rows were reordered.
    const swapped = reconcileCast(cast, { images: [PICTURES[1], PICTURES[0], PICTURES[2]], videos: [], audios: [] });
    assert.deepEqual(swapped.map((member) => member.key), ['persona:c', 'persona:d', REFERENCES_KEY]);
});

test('reconcile never mutates the members it was given', async () => {
    const { reconcileCast, personaMember } = await load();
    const cheryl = personaMember({ id: 'c', name: 'Cheryl', data: { gender: 'female', images: [PICTURES[0]], videos: [], audios: [] } });
    const frozen = JSON.stringify(cheryl);
    reconcileCast([cheryl], { images: [], videos: [], audios: [] });
    assert.equal(JSON.stringify(cheryl), frozen);
});

/* ---------------- weaveTarget: from what is attached, never a dropdown ---------------- */

test('the target follows the family and what is attached', async () => {
    const { weaveTarget } = await load();
    assert.equal(weaveTarget({ h3: true, referenceLane: true, rows: { images: PICTURES } }), 'reference');
    assert.equal(weaveTarget({ h3: true, referenceLane: true, rows: { images: [], videos: [], audios: [] } }), 'h3-text');
    assert.equal(weaveTarget({ h3: true, referenceLane: false, rows: { images: PICTURES } }), 'h3-text');
    assert.equal(weaveTarget({ h3: false, referenceLane: true, rows: { images: PICTURES } }), 'prose');
});

/* ---------------- weavePrompt: Liam's examples ---------------- */

test('EXAMPLE 1 — load a starter, then attach your pictures: you replace the woman', async () => {
    const { reconcileCast, weavePrompt } = await load();
    const { parseSixSections } = await loadCast();
    const cast = reconcileCast([], { images: PICTURES, videos: [], audios: [VOICE] });
    const woven = weavePrompt(THREE_FIELD, {
        cast, limits: LIMITS, durationSeconds: 10, target: 'reference', standIns: STAND_INS,
    });
    const sections = parseSixSections(woven.prompt);
    assert.match(sections.subject_definitions, /^<Subject 1> is the person shown in <Picture 1>, <Picture 2>, <Picture 3>:/m);
    assert.match(sections.subject_definitions, /<Audio 1> is the voice-timbre reference for <Subject 1> \(S1\)/);
    assert.match(sections.detailed_description, /\[Shot 1\] <Subject 1> \(S1\) sits on a low concrete wall\. She smiles to herself\./);
    assert.doesNotMatch(sections.detailed_description, /Korean woman|black wavy hair/, 'the stranger is gone');
    assert.doesNotMatch(sections.detailed_description, /integrated_multimodal_description|overall_soundscape/);
    assert.equal(sections.overall_soundscape, 'Birdsong, a distant motorcycle, light wind in the leaves.');
    assert.deepEqual(woven.rows, { images: PICTURES, videos: [], audios: [VOICE] });
    assert.deepEqual(woven.standIns, [], 'the stand-in was consumed');
});

test('EXAMPLE 2 — start with your pictures woven in, then load a starter: the starter adapts to you', async () => {
    const { reconcileCast, weavePrompt } = await load();
    const { parseSixSections } = await loadCast();
    const cast = reconcileCast([], { images: PICTURES, videos: [], audios: [] }, { persona: { id: 'me', name: 'Liam', gender: 'male', look: 'short dark hair, beard, black tee' } });
    // What the composer holds after the attach weave: a six-section prompt about <Subject 1>.
    const first = weavePrompt('He waves at the camera.', { cast, limits: LIMITS, durationSeconds: 5, target: 'reference' });
    assert.match(first.prompt, /<Subject 1> is the man shown in <Picture 1>, <Picture 2>, <Picture 3>: short dark hair, beard, black tee\./);
    // Now the Prompts menu: a three-field starter rendered for HIS gender, with its stand-in.
    const starter = THREE_FIELD.replace('A Korean woman in her early twenties', 'A Korean man in his early twenties')
        .replace('she has black wavy hair', 'he has short black hair').replace(/She smiles to herself/, 'He smiles to himself').replace('she walks', 'he walks');
    const standIns = [{ index: 1, phrases: ['A Korean man in his early twenties'], looks: ['; he has short black hair, black canvas sneakers'] }];
    const second = weavePrompt(starter, { cast, limits: LIMITS, durationSeconds: 10, target: 'reference', standIns });
    const sections = parseSixSections(second.prompt);
    assert.match(sections.subject_definitions, /short dark hair, beard, black tee/, 'his look, not the starter\'s');
    assert.match(sections.detailed_description, /\[Shot 1\] <Subject 1> \(S1\) sits on a low concrete wall\. He smiles to himself\./);
    assert.doesNotMatch(sections.detailed_description, /short black hair/);
    assert.equal(second.persona.name, 'Liam');
});

test('a starter shortened by the reference cap is re-timed on the way in, in the same pass', async () => {
    const { reconcileCast, weavePrompt } = await load();
    const cast = reconcileCast([], { images: PICTURES, videos: [], audios: [] });
    const long = THREE_FIELD.replace('[Shot 2] At 00:05.000', '[Shot 2] At 00:05.000, she stands. [Shot 3] At 00:10.000');
    const woven = weavePrompt(long, { cast, limits: LIMITS, durationSeconds: 8, target: 'reference', standIns: STAND_INS });
    assert.equal(woven.refit.changed, true);
    assert.doesNotMatch(woven.prompt, /At 00:10\.000/);
});

test('EXAMPLE 3 — pick a known character with nothing attached: it is written into the scene, not the music', async () => {
    const { weavePrompt, characterCastMember } = await load();
    const { H3_CHARACTERS } = await loadCharacters();
    const sponge = characterCastMember(H3_CHARACTERS.find((entry) => /SpongeBob/.test(entry.name)));
    const starter = `integrated_multimodal_description: [Shot 1] A woman sits at a kitchen table, morning light.

overall_soundscape: Kitchen room tone, a kettle.

non_diegetic_music: none`;
    const woven = weavePrompt(starter, { cast: [sponge], durationSeconds: 5, target: 'h3-text' });
    assert.match(woven.prompt, /^integrated_multimodal_description: \[Shot 1\] A woman sits at a kitchen table, morning light\. SpongeBob SquarePants from the animated series SpongeBob SquarePants \(1999\)/m);
    assert.match(woven.prompt, /\n\nnon_diegetic_music: none$/, 'the music field is untouched');
    assert.equal(woven.rows, null);
});

test('EXAMPLE 3b — with a stand-in, the character TAKES the stand-in\'s place in text mode', async () => {
    const { weavePrompt, characterCastMember } = await load();
    const { H3_CHARACTERS } = await loadCharacters();
    const sponge = characterCastMember(H3_CHARACTERS.find((entry) => /SpongeBob/.test(entry.name)));
    const woven = weavePrompt(THREE_FIELD, { cast: [sponge], durationSeconds: 10, target: 'h3-text', standIns: STAND_INS });
    assert.match(woven.prompt, /\[Shot 1\] SpongeBob SquarePants from the animated series SpongeBob SquarePants \(1999\) \(S1\) sits on a low concrete wall\. She smiles/);
    assert.doesNotMatch(woven.prompt, /black wavy hair/);
});

test('EXAMPLE 4 — you plus a character: you are <Subject 1>, the cartoon <Subject 2>, both in the shot', async () => {
    const { reconcileCast, weavePrompt, characterCastMember } = await load();
    const { parseSixSections } = await loadCast();
    const { H3_CHARACTERS } = await loadCharacters();
    const sponge = characterCastMember(H3_CHARACTERS.find((entry) => /SpongeBob/.test(entry.name)));
    const cast = reconcileCast([sponge], { images: PICTURES, videos: [], audios: [VOICE] });
    const fight = `subject_definitions:
<Subject 1> is the woman shown in <Picture 1>: red hair.
<Subject 2> is Naruto Uzumaki from the anime series Naruto (2002).

summary:
A fight.

retention_analysis:
<Picture 1>: fully_preserved — same person.

detailed_description:
[Shot 1] <Subject 1> (S1) squares up to <Subject 2> (S2). <Subject 2> (S2) says: <d>[English in Naruto's voice] Bring it.</d>

overall_soundscape:
Wind.

non_diegetic_music:
none`;
    const woven = weavePrompt(fight, { cast, limits: LIMITS, durationSeconds: 8, target: 'reference' });
    const sections = parseSixSections(woven.prompt);
    assert.match(sections.subject_definitions, /<Subject 1> is the person shown in <Picture 1>, <Picture 2>, <Picture 3>/);
    assert.match(sections.subject_definitions, /<Subject 2> is SpongeBob SquarePants from the animated series/);
    assert.match(sections.detailed_description, /<Subject 2> \(S2\) says: <d>\[English in SpongeBob SquarePants' voice/);
    assert.doesNotMatch(sections.detailed_description, /Naruto's voice/);
    assert.deepEqual(woven.rows.images, PICTURES);
});

test('a prose family leaves the text alone except for a character and the timeline', async () => {
    const { weavePrompt, reconcileCast } = await load();
    const cast = reconcileCast([], { images: PICTURES, videos: [], audios: [] });
    const woven = weavePrompt('A woman walks her dog along a pier at dusk.', { cast, durationSeconds: 5, target: 'prose' });
    assert.equal(woven.prompt, 'A woman walks her dog along a pier at dusk.');
    assert.equal(woven.rows, null);
});

test('an empty cast is the old behaviour: the prompt passes through, re-timed only', async () => {
    const { weavePrompt } = await load();
    const woven = weavePrompt(THREE_FIELD, { cast: [], durationSeconds: 3, target: 'h3-text' });
    assert.match(woven.prompt, /^integrated_multimodal_description: Handheld DV camcorder look/);
    assert.equal(woven.refit.changed, true, '[Shot 2] At 00:05 on a 3s clip is re-timed');
});

/* ---------------- the studio-facing helpers ---------------- */

test('castSubjects tells the helper the slots, never a persona\'s name', async () => {
    const { reconcileCast, castSubjects, characterCastMember } = await load();
    const { H3_CHARACTERS } = await loadCharacters();
    const sponge = characterCastMember(H3_CHARACTERS.find((entry) => /SpongeBob/.test(entry.name)));
    const cast = reconcileCast([sponge], { images: PICTURES, videos: [], audios: [VOICE] }, { persona: { id: 'me', name: 'Liam', gender: 'male', look: 'beard' } });
    assert.deepEqual(castSubjects(cast), [
        { subject: 1, kind: 'persona', gender: 'male', name: '', voice: true, look: 'beard' },
        { subject: 2, kind: 'character', gender: '', name: 'SpongeBob SquarePants', voice: true, look: '' },
    ]);
});

test('the render gender is whoever holds <Subject 1>', async () => {
    const { reconcileCast, castRenderGender } = await load();
    assert.equal(castRenderGender([]), '');
    const cast = reconcileCast([], { images: PICTURES, videos: [], audios: [] }, { persona: { id: 'me', name: 'Liam', gender: 'male' } });
    assert.equal(castRenderGender(cast), 'male');
});

test('describeMember reads like a chip', async () => {
    const { reconcileCast, describeMember } = await load();
    const cast = reconcileCast([], { images: PICTURES, videos: [WALK], audios: [VOICE] });
    assert.equal(describeMember(cast[0]), '3 pictures · 1 motion clip · voice');
});

test('every H3 starter that carries a stand-in binds with nothing of the stand-in left behind', async () => {
    const { reconcileCast, weavePrompt } = await load();
    const { DEFAULT_PROMPTS, renderDefaultPrompt } = await loadStarters();
    const { parseSixSections } = await loadCast();
    const cast = reconcileCast([], { images: PICTURES, videos: [], audios: [] }, { persona: { id: 'me', name: 'Liam', gender: 'male', look: 'beard' } });
    let checked = 0;
    for (const entry of DEFAULT_PROMPTS.filter((item) => item.family === 'minimax')) {
        const rendered = renderDefaultPrompt(entry, 'male');
        for (const part of rendered.parts) {
            if (!part.standIns?.length) continue;
            checked += 1;
            const woven = weavePrompt(part.prompt, { cast, limits: LIMITS, durationSeconds: 10, target: 'reference', standIns: part.standIns });
            const sections = parseSixSections(woven.prompt);
            assert.match(sections.detailed_description, /<Subject 1>/, `${entry.id}: the subject is in the shot`);
            for (const standIn of part.standIns) {
                for (const phrase of standIn.phrases) assert.ok(!sections.detailed_description.includes(phrase), `${entry.id}: stand-in phrase left: ${phrase}`);
                for (const look of standIn.looks) assert.ok(!sections.detailed_description.includes(look.trim()), `${entry.id}: stand-in look left`);
            }
            assert.deepEqual(woven.standIns, [], `${entry.id}: all stand-ins consumed`);
        }
    }
    assert.ok(checked >= 2, `expected the Korean home video parts to carry stand-ins (checked ${checked})`);
});

test('PHASE 3 — on a prose family, a known character takes the stand-in\'s place in a Seedance or LTX starter', async () => {
    const { weavePrompt, characterCastMember } = await load();
    const { DEFAULT_PROMPTS, renderDefaultPrompt } = await loadStarters();
    const { H3_CHARACTERS } = await loadCharacters();
    const sponge = characterCastMember(H3_CHARACTERS.find((entry) => /SpongeBob/.test(entry.name)));
    let checked = 0;
    for (const id of ['korean-home-video-seedance', 'korean-home-video-seedance-25', 'korean-home-video-ltx']) {
        const entry = DEFAULT_PROMPTS.find((item) => item.id === id);
        assert.ok(entry, id);
        const rendered = renderDefaultPrompt(entry, 'female');
        for (const part of rendered.parts) {
            if (!part.standIns?.length) continue;
            checked += 1;
            const woven = weavePrompt(part.prompt, { cast: [sponge], durationSeconds: 15, target: 'prose', standIns: part.standIns });
            assert.match(woven.prompt, /SpongeBob SquarePants from the animated series SpongeBob SquarePants \(1999\)/, `${id}: the character is in`);
            for (const standIn of part.standIns) {
                for (const phrase of standIn.phrases) assert.ok(!woven.prompt.includes(phrase), `${id}: stand-in phrase left: ${phrase}`);
                for (const look of standIn.looks) assert.ok(!woven.prompt.includes(look.trim()), `${id}: stand-in look left`);
            }
            assert.deepEqual(woven.standIns, [], `${id}: consumed`);
            // The source form is written ONCE per mention of the stand-in, never
            // appended a second time past the end.
            assert.ok(!/\(1999\)[\s\S]*\(1999\)[\s\S]*\(1999\)/.test(woven.prompt), `${id}: not tripled`);
        }
    }
    assert.ok(checked >= 4, `expected several prose parts with stand-ins (checked ${checked})`);
});

/* ---------------- a SECOND person — anyone can be a subject (2026-08-24) ---------------- */

test('ANOTHER PERSON — a new member survives with no media, and the next attach is claimed for them', async () => {
    const { reconcileCast, newPersonMember, nextPersonKey } = await load();
    // Liam is in the shot from his pictures; a second person is added on purpose.
    let cast = reconcileCast([], { images: PICTURES.slice(0, 2), videos: [], audios: [] }, { persona: { id: 'me', name: 'Liam', gender: 'male' } });
    const second = newPersonMember(cast);
    assert.equal(second.key, 'person:1');
    cast = [...cast, second];
    // Reconcile with nothing new attached: the empty person STAYS (explicit).
    cast = reconcileCast(cast, { images: PICTURES.slice(0, 2), videos: [], audios: [] }, { persona: { id: 'me', name: 'Liam', gender: 'male' } });
    assert.deepEqual(cast.map((member) => member.key), ['persona:me', 'person:1']);
    // Her pictures arrive, claimed for HER — they do not join Liam.
    cast = reconcileCast(cast, { images: [...PICTURES.slice(0, 2), '/her-1.jpg'], videos: [], audios: [] }, { claimNew: 'person:1' });
    assert.deepEqual(cast[0].data.images, PICTURES.slice(0, 2), 'Liam keeps his own');
    assert.deepEqual(cast[1].data.images, ['/her-1.jpg']);
    // Without a claim, new media still joins the references member, never a
    // random person: two holders exist, so it opens a third, anonymous one.
    const free = reconcileCast(cast, { images: [...PICTURES.slice(0, 2), '/her-1.jpg', '/stray.jpg'], videos: [], audios: [] });
    assert.equal(free.length, 3);
    assert.deepEqual(free[2].data.images, ['/stray.jpg']);
    assert.equal(nextPersonKey(cast), 'person:2');
});

test('ANOTHER PERSON — claiming for a key that does not exist yet creates the member in place', async () => {
    const { reconcileCast } = await load();
    let cast = reconcileCast([], { images: [PICTURES[0]], videos: [], audios: [] });
    cast = reconcileCast(cast, { images: [PICTURES[0], '/her-1.jpg'], videos: [], audios: [] }, { claimNew: 'person:1' });
    assert.deepEqual(cast.map((member) => member.key), ['references', 'person:1']);
    assert.equal(cast[1].explicit, true);
    assert.deepEqual(cast[1].data.images, ['/her-1.jpg']);
});

test('ANOTHER PERSON — two people from pictures weave as <Subject 1> and <Subject 2>', async () => {
    const { reconcileCast, weavePrompt } = await load();
    const { parseSixSections } = await loadCast();
    let cast = reconcileCast([], { images: PICTURES.slice(0, 2), videos: [], audios: [] }, { persona: { id: 'me', name: 'Liam', gender: 'male', look: 'beard, black tee' } });
    cast = reconcileCast(cast, { images: [...PICTURES.slice(0, 2), '/ana-1.jpg'], videos: [], audios: [] }, { claimNew: 'person:1' });
    cast = cast.map((member) => (member.key === 'person:1'
        ? { ...member, name: 'Ana', data: { ...member.data, gender: 'female', look: 'red coat, tall' } }
        : member));
    const woven = weavePrompt('They argue over a chessboard.', { cast, limits: LIMITS, durationSeconds: 5, target: 'reference' });
    const sections = parseSixSections(woven.prompt);
    assert.match(sections.subject_definitions, /<Subject 1> is the man shown in <Picture 1>, <Picture 2>: beard, black tee\./);
    assert.match(sections.subject_definitions, /<Subject 2> is the woman shown in <Picture 3>: red coat, tall\./);
    assert.deepEqual(woven.rows.images, [...PICTURES.slice(0, 2), '/ana-1.jpg']);
});

test('ANOTHER PERSON — a text-defined person is a real subject in reference mode, holding no slot', async () => {
    const { reconcileCast, newPersonMember, weavePrompt } = await load();
    const { parseSixSections } = await loadCast();
    let cast = reconcileCast([], { images: [PICTURES[0]], videos: [], audios: [] }, { persona: { id: 'me', name: 'Liam', gender: 'male' } });
    const ana = { ...newPersonMember(cast), name: 'Ana', data: { v: 1, gender: 'female', look: 'red coat, tall', images: [], videos: [], audios: [] } };
    cast = [...cast, ana];
    const woven = weavePrompt('He shows her the map.', { cast, limits: LIMITS, durationSeconds: 5, target: 'reference' });
    const sections = parseSixSections(woven.prompt);
    assert.match(sections.subject_definitions, /<Subject 2> is a woman, Ana: red coat, tall\./);
    assert.deepEqual(woven.rows.images, [PICTURES[0]], 'no slot spent on her');
});

test('ANOTHER PERSON — in text mode a stand-in binds to the text-defined person', async () => {
    const { weavePrompt, newPersonMember, prosePersonPhrase } = await load();
    const ana = { ...newPersonMember([]), name: 'Ana', data: { v: 1, gender: 'female', look: 'red coat', images: [], videos: [], audios: [] } };
    assert.equal(prosePersonPhrase(ana), 'Ana, a woman — red coat —');
    const woven = weavePrompt(THREE_FIELD, { cast: [ana], durationSeconds: 10, target: 'h3-text', standIns: STAND_INS });
    assert.match(woven.prompt, /\[Shot 1\] Ana, a woman — red coat — \(S1\) sits on a low concrete wall/);
});
