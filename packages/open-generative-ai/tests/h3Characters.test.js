// H3 character quick-add catalog — reddit-reported names + series fill-ins,
// composed into the community-tested "Name as played by Actor from the
// television series X (1997)" source form.
const test = require('node:test');
const assert = require('node:assert/strict');

test('catalog entries are well-formed with no duplicates', async () => {
    const { H3_CHARACTERS } = await import('../src/lib/h3Characters.js');
    assert.ok(H3_CHARACTERS.length >= 470, `catalog carries the full list (${H3_CHARACTERS.length})`);
    const seen = new Set();
    for (const entry of H3_CHARACTERS) {
        assert.ok(entry.name && entry.series, `${entry.name || '?'} has name + series`);
        const key = `${entry.series}::${entry.name}`;
        assert.ok(!seen.has(key), `${key} appears once`);
        seen.add(key);
        // Every entry can state its source with a year: either structured
        // medium+year or an origin clause that embeds one.
        if (entry.origin) {
            assert.match(entry.origin, /\(\d{4}\)/, `${entry.name} origin carries a year`);
        } else {
            assert.ok(Number.isInteger(entry.year), `${entry.name} has a year`);
            assert.ok(entry.medium, `${entry.name} has a medium`);
        }
    }
    const filled = H3_CHARACTERS.filter((entry) => entry.filled);
    assert.ok(filled.length > 0, 'fill-ins are marked');
    assert.ok(filled.some((entry) => entry.series === 'The Office'), 'The Office got characters');
});

test('prompt text carries name, casting, source and year', async () => {
    const { H3_CHARACTERS, characterPromptText } = await import('../src/lib/h3Characters.js');
    const buffy = H3_CHARACTERS.find((e) => e.name === 'Buffy Summers');
    assert.equal(
        characterPromptText(buffy),
        'Buffy Summers as played by Sarah Michelle Gellar from the television series Buffy the Vampire Slayer (1997)',
    );
    // No actor → no casting clause; origin overrides the composed from-clause.
    const shrek = H3_CHARACTERS.find((e) => e.name === 'Shrek');
    assert.equal(characterPromptText(shrek), 'Shrek from the animated film Shrek (2001)');
    const elsa = H3_CHARACTERS.find((e) => e.name === 'Elsa');
    assert.equal(characterPromptText(elsa), 'Elsa from the animated film Frozen (2013)');
    // prompt overrides the base wording but keeps the source clause.
    const joker = H3_CHARACTERS.find((e) => e.name === 'Joker');
    assert.equal(characterPromptText(joker), 'the Joker from the DC comics (1940)');
});

test('search matches by character name and by series', async () => {
    const { searchH3Characters, H3_CHARACTERS } = await import('../src/lib/h3Characters.js');
    assert.equal(searchH3Characters('').length, H3_CHARACTERS.length);
    assert.ok(searchH3Characters('sephiroth').some((e) => e.name === 'Sephiroth'));
    const office = searchH3Characters('OFFICE');
    assert.ok(office.some((e) => e.name === 'Michael Scott'));
    assert.equal(searchH3Characters('zzzz-no-such').length, 0);
    // The fuller `prompt` name is searchable too — it is the one people type,
    // while the row itself stays labelled with the short catalog name.
    assert.ok(searchH3Characters('Leon S. Kennedy').some((e) => e.name === 'Leon Kennedy'));
    assert.ok(searchH3Characters('Amicia de Rune').some((e) => e.name === 'Amicia'));
    assert.ok(searchH3Characters('Knuckles the Echidna').some((e) => e.name === 'Knuckles'));
    // Doom's two eras are separate entries: the name is what picks the armour.
    const doom = searchH3Characters('doom').map((e) => e.name);
    assert.ok(doom.includes('Doomguy') && doom.includes('Doom Slayer'));
});

test('grouping preserves catalog order', async () => {
    const { groupH3Characters, searchH3Characters } = await import('../src/lib/h3Characters.js');
    const groups = groupH3Characters(searchH3Characters('seinfeld'));
    assert.equal(groups.length, 1);
    assert.deepEqual(
        groups[0].characters.map((e) => e.name),
        ['Jerry Seinfeld', 'George Costanza', 'Elaine Benes', 'Cosmo Kramer'],
    );
});

test('applying a character enriches a bare name, else appends, never stacks', async () => {
    const { H3_CHARACTERS, applyCharacterToPrompt, characterPromptText } = await import('../src/lib/h3Characters.js');
    const shrek = H3_CHARACTERS.find((e) => e.name === 'Shrek');
    const full = characterPromptText(shrek);
    assert.equal(applyCharacterToPrompt('', shrek), full);
    assert.equal(applyCharacterToPrompt('a foggy swamp at dawn', shrek), `a foggy swamp at dawn, ${full}`);
    assert.equal(applyCharacterToPrompt('He waits.', shrek), `He waits. ${full}`);
    // A bare mention is enriched IN PLACE, not appended again.
    assert.equal(
        applyCharacterToPrompt('Shrek trudges through a foggy swamp', shrek),
        `${full} trudges through a foggy swamp`,
    );
    // Exact-case word match only: "data center" must not become Lt. Cmdr. Data.
    const data = H3_CHARACTERS.find((e) => e.name === 'Data');
    const enrichedData = applyCharacterToPrompt('a humming data center', data);
    assert.match(enrichedData, /^a humming data center, Data as played by Brent Spiner/);
    // Already enriched (any case) → unchanged.
    const withFull = `${full} walks into frame`;
    assert.equal(applyCharacterToPrompt(withFull, shrek), withFull);
});

test('mentioned-character matching finds full and partial names, capped', async () => {
    const { charactersMentionedIn } = await import('../src/lib/h3Characters.js');
    const matched = charactersMentionedIn('buffy walks through a cemetery at night, Willow next to her');
    const names = matched.map((e) => e.name);
    assert.ok(names.includes('Buffy Summers'), 'first-name mention matches');
    assert.ok(names.includes('Willow Rosenberg'));
    // Generic words alone never match a character.
    assert.equal(charactersMentionedIn('a white dress under a full moon by an iron gate').length, 0);
    assert.equal(charactersMentionedIn('').length, 0);
    assert.ok(charactersMentionedIn('simpson family dinner').length <= 12, 'result stays capped');
});

// A voice is asked for by NAME in the dialogue language tag, and the two halves
// that make it retrievable are the source work and the performer. Shipping
// "SpongeBob SquarePants' own voice" — which named neither — produced a
// SpongeBob who did not sound like SpongeBob (2026-08-12).
test('a voice tag names its source and performer, never just "own voice"', async () => {
    const { H3_CHARACTERS, characterVoiceText } = await import('../src/lib/h3Characters.js');
    const find = (name) => H3_CHARACTERS.find((entry) => entry.name === name);

    // The community-proven form, from a working example: "<Character>'s voice
    // from <Series> as played by <Actor>".
    assert.equal(
        characterVoiceText(find('Willow Rosenberg')),
        "Willow Rosenberg's voice from Buffy the Vampire Slayer as played by Alyson Hannigan",
    );
    // Animation names the VOICE actor: the on-screen performer does not exist,
    // and the person who identifies the sound is never in frame.
    assert.equal(
        characterVoiceText(find('SpongeBob SquarePants')),
        "SpongeBob SquarePants' voice from SpongeBob SquarePants as voiced by Tom Kenny",
    );
    // A character with neither kind of performer still names where it is from.
    assert.equal(characterVoiceText(find('Mario')), "Mario's voice from Super Mario");

    // No catalog entry may lose its source, whatever its name and series are.
    for (const entry of H3_CHARACTERS) {
        const text = characterVoiceText(entry);
        assert.doesNotMatch(text, /own voice/, `${entry.name} collapsed to a content-free voice`);
        assert.ok(text.includes(entry.series), `${entry.name} names no source work`);
    }
});

test('note lines carry casting and source for the prompt helper', async () => {
    const { charactersMentionedIn, characterNoteLines } = await import('../src/lib/h3Characters.js');
    const lines = characterNoteLines(charactersMentionedIn('Geralt meets Buffy'));
    assert.ok(lines.includes('Geralt of Rivia — from the video game The Witcher (2015)'));
    assert.ok(lines.includes('Buffy Summers — played by Sarah Michelle Gellar — from the television series Buffy the Vampire Slayer (1997)'));
});

test('a six-section prompt gets a subject, not text appended past its last section', async () => {
    const { H3_CHARACTERS, applyCharacterToPrompt, characterPromptText, characterVoiceText } = await import('../src/lib/h3Characters.js');
    const { parseSixSections } = await import('../src/lib/castPrompt.js');
    const shrek = H3_CHARACTERS.find((e) => e.name === 'Shrek');
    const prompt = [
        'subject_definitions:',
        '<Subject 1> is the character shown in <Picture 1>: [appearance].',
        '',
        'detailed_description:',
        '[Shot 1] <Subject 1> waits in the swamp.',
        '',
        'non_diegetic_music:',
        'none',
    ].join('\n');

    const sections = parseSixSections(applyCharacterToPrompt(prompt, shrek));
    // Appending would have filed the ogre inside non_diegetic_music, where he
    // is a note about the music rather than someone in the shot.
    assert.equal(sections.non_diegetic_music, 'none');
    assert.equal(sections.subject_definitions, [
        '<Subject 1> is the character shown in <Picture 1>: [appearance].',
        `<Subject 2> is ${characterPromptText(shrek)}.`,
        // The VOICE, beside the likeness: "as played by Mike Myers" in the
        // identity line says how the ogre looks, and asks for nothing of how he
        // sounds. Without this line he speaks in a generic adult male the
        // moment somebody writes him a line.
        `<Subject 2> speaks in ${characterVoiceText(shrek)}.`,
    ].join('\n'));
    assert.equal(sections.detailed_description, '[Shot 1] <Subject 1> waits in the swamp.');
});

test('a quick-added character is given no speaker id, because it has no line yet', async () => {
    const { H3_CHARACTERS, applyCharacterToPrompt } = await import('../src/lib/h3Characters.js');
    const prompt = [
        'subject_definitions:',
        '<Subject 1> is the character shown in <Picture 1>: [appearance].',
        '<Subject 1> speaks as S1.',
        '',
        'detailed_description:',
        '[Shot 1] <Subject 1> (S1) says: <d>[English] Well then.</d>',
    ].join('\n');
    const next = applyCharacterToPrompt(prompt, H3_CHARACTERS.find((e) => e.name === 'Shrek'));
    // H3 numbers speakers by who talks FIRST, and this one talks not at all
    // yet — guessing S2 here is how two characters' lines get swapped.
    assert.doesNotMatch(next, /<Subject 2> speaks as S/);
    assert.match(next, /<Subject 2> speaks in Shrek's voice/);
});

// ---------------------------------------------------------------------------
// The 2026-08-22 merge of malcolmrey's H3 usability index (284 entries). Its
// "Real Actor / Actress" is ONE column covering both kinds of performer; this
// catalog splits them, and getting it backwards is the failure the split exists
// to prevent (naming the wrong performer is worse than naming none).
test('a drawn character names a voice actor, never an on-screen one', async () => {
    const { H3_CHARACTERS } = await import('../src/lib/h3Characters.js');
    const drawn = new Set(['animation', 'anime', 'animated-film']);
    const wrong = H3_CHARACTERS.filter((entry) => drawn.has(entry.medium) && entry.actor);
    assert.deepEqual(wrong.map((entry) => entry.name), [], 'an animated likeness has no on-screen performer');
    // The reverse is NOT symmetrical: Darth Vader is a suit plus a separate
    // voice, which is exactly why voiceActor is its own field.
    const vader = H3_CHARACTERS.find((entry) => entry.name === 'Darth Vader');
    assert.equal(vader.voiceActor, 'James Earl Jones');
    assert.ok(!vader.actor);
});

test('the catalog stays fictional characters only', async () => {
    const { H3_CHARACTERS } = await import('../src/lib/h3Characters.js');
    // The index carries 78 real-celebrity rows plus talk-show and sports hosts
    // filed under their programme; none of them belong here.
    const people = ['Joe Rogan', 'Conan O\'Brien', 'Kobe Bryant', 'Gordon Ramsay', 'Donald Trump',
        'Barack Obama', 'Jon Stewart', 'Tucker Carlson', 'David Letterman', 'John Oliver',
        'Larry David', 'Dave Chappelle', 'Neil deGrasse Tyson', 'Robert Lewandowski'];
    const leaked = H3_CHARACTERS.filter((entry) => people.includes(entry.name));
    assert.deepEqual(leaked.map((entry) => entry.name), []);
    // Jerry Seinfeld stays: he is a scripted character in a sitcom who happens
    // to share his performer's name, which the source clause makes explicit.
    const jerry = H3_CHARACTERS.find((entry) => entry.name === 'Jerry Seinfeld');
    assert.equal(jerry.series, 'Seinfeld');
    assert.equal(jerry.actor, 'Jerry Seinfeld');
});

test('one character per depiction, disambiguated by its source', async () => {
    const { H3_CHARACTERS, characterPromptText } = await import('../src/lib/h3Characters.js');
    // Five Batmen and two Hannibal Lecters are the point, not a bug: the index
    // tested each likeness separately and the source clause is what picks one.
    const batmen = H3_CHARACTERS.filter((entry) => entry.name === 'Bruce Wayne / Batman');
    assert.equal(batmen.length, 5);
    assert.equal(new Set(batmen.map((entry) => entry.series)).size, 5);
    const dark = batmen.find((entry) => entry.series === 'The Dark Knight');
    assert.equal(
        characterPromptText(dark),
        'Bruce Wayne / Batman as played by Christian Bale from the film The Dark Knight (2008)',
    );
});

// ---------------------------------------------------------------------------
// Every character has to answer "what does this sound like?" one way or the
// other. A subject whose voice is never named or described comes back in H3's
// default generic adult male — measured twice (2026-08-13), once on an
// unattributed exhale and once on a SpongeBob named without a description.
test('a character either names its performer or describes its timbre', async () => {
    const { H3_CHARACTERS, characterVoiceText } = await import('../src/lib/h3Characters.js');

    // The exemptions, each for a stated reason — not a backlog.
    const WORDLESS = ['Link', 'Samus Aran', 'Doomguy', 'Doom Slayer', 'Chewbacca', 'Xenomorph',
        'Charizard', 'Nezuko Kamado', 'Aether'];       // grunt, roar or stay silent
    const NO_ONE_VOICE = ['Commander Shepard'];        // the player picks it
    const UNDESCRIBED = ['Claire Redfield', 'Jill Valentine', 'Abby', 'Cal Kestis', 'Cere Junda',
        'Senua', 'Amicia', 'Kara', 'Dani Rojas', 'Yuna', 'Superman', 'Wonder Woman'];
    // ^ nobody was confident enough to describe these, and a wrong timbre
    //   misdirects where a missing one merely falls back. Fill them in when
    //   someone knows; do not guess.
    const exempt = new Set([...WORDLESS, ...NO_ONE_VOICE, ...UNDESCRIBED]);

    const silent = H3_CHARACTERS.filter((entry) => (
        !/as (voiced|played) by/.test(characterVoiceText(entry))
        && !entry.voiceQuality
        && !exempt.has(entry.name)
    ));
    assert.deepEqual(
        silent.map((entry) => `${entry.series}::${entry.name}`),
        [],
        'name a performer, describe the timbre, or add it to an exemption list above with a reason',
    );
});

test('the timbre description says what the voice must NOT be, where that is the trap', async () => {
    const { H3_CHARACTERS } = await import('../src/lib/h3Characters.js');
    // The fallback is a generic ADULT MALE, so a childlike or high voice that
    // does not exclude it is the one most likely to come back wrong.
    for (const name of ['Pikachu', 'Paimon', 'Naruto Uzumaki', 'Tails', 'Atreus', 'Sailor Moon']) {
        const entry = H3_CHARACTERS.find((e) => e.name === name);
        assert.match(entry.voiceQuality, /never .*(adult|deep)/, `${name} rules out the default`);
    }
});
