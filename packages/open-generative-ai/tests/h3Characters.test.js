// H3 character quick-add catalog — reddit-reported names + series fill-ins,
// composed into the community-tested "Name as played by Actor from the
// television series X (1997)" source form.
const test = require('node:test');
const assert = require('node:assert/strict');

test('catalog entries are well-formed with no duplicates', async () => {
    const { H3_CHARACTERS } = await import('../src/lib/h3Characters.js');
    assert.ok(H3_CHARACTERS.length >= 120, `catalog carries the full list (${H3_CHARACTERS.length})`);
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

test('note lines carry casting and source for the prompt helper', async () => {
    const { charactersMentionedIn, characterNoteLines } = await import('../src/lib/h3Characters.js');
    const lines = characterNoteLines(charactersMentionedIn('Geralt meets Buffy'));
    assert.ok(lines.includes('Geralt of Rivia — from the video game The Witcher (2015)'));
    assert.ok(lines.includes('Buffy Summers — played by Sarah Michelle Gellar — from the television series Buffy the Vampire Slayer (1997)'));
});
