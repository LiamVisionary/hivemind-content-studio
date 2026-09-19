// Object → character: how the two prompts meet, which model is asked, and that
// every shipped image prompt has the example picture its row promises.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const { renderComponent } = require('./helpers/render.js');

const load = () => import('../src/lib/objectToCharacter.js');

test('the character is appended to the framing prompt as one paragraph', async () => {
    const { composeCharacterPrompt } = await load();
    assert.equal(composeCharacterPrompt('A studio portrait', 'A tall man.'), 'A studio portrait. A tall man.');
    assert.equal(composeCharacterPrompt('A studio portrait.  ', '  A tall man.'), 'A studio portrait. A tall man.');
    // Either half alone is an ordinary answer, never a dangling join.
    assert.equal(composeCharacterPrompt('', 'A tall man.'), 'A tall man.');
    assert.equal(composeCharacterPrompt('A studio portrait.', ''), 'A studio portrait.');
});

test('a loaded model that can see is asked before anything is loaded', async () => {
    const { pickVisionModel } = await load();
    const snapshot = { models: [
        { id: 'blind', fit: 'loaded', vision: false, estimatedLoadBytes: 1 },
        { id: 'big', fit: 'fits', vision: true, estimatedLoadBytes: 30 },
        { id: 'scout', fit: 'loaded', vision: true, estimatedLoadBytes: 10 },
    ] };
    const pick = pickVisionModel(snapshot);
    assert.equal(pick.loaded.id, 'scout');
    assert.equal(pick.blocked, null);
});

test('with nothing loaded it offers the remembered seeing model, else the smallest that fits', async () => {
    const { pickVisionModel } = await load();
    const snapshot = { models: [
        { id: 'blind-loaded', fit: 'loaded', vision: false, estimatedLoadBytes: 5 },
        { id: 'big', fit: 'needs_unload', vision: true, estimatedLoadBytes: 30 },
        { id: 'small', fit: 'fits', vision: true, estimatedLoadBytes: 10 },
        { id: 'huge', fit: 'insufficient', vision: true, estimatedLoadBytes: 900 },
    ] };
    assert.equal(pickVisionModel(snapshot).candidate.id, 'small');
    assert.equal(pickVisionModel(snapshot, { lastUsedId: 'big' }).candidate.id, 'big');
    // A remembered model that cannot be loaded is not offered.
    assert.equal(pickVisionModel(snapshot, { lastUsedId: 'huge' }).candidate.id, 'small');
});

test('a seeing model that does not fit is named, so the dialog can say that instead of "no model"', async () => {
    const { pickVisionModel } = await load();
    const pick = pickVisionModel({ models: [{ id: 'huge', fit: 'insufficient', vision: true, name: 'Huge' }] });
    assert.equal(pick.loaded, null);
    assert.equal(pick.candidate, null);
    assert.equal(pick.blocked.id, 'huge');
    assert.deepEqual(pickVisionModel(null), { loaded: null, candidate: null, blocked: null });
});

test('the workflow starter loads the framing half and names its workflow', async () => {
    const { DEFAULT_PROMPTS } = await import('../src/lib/defaultPrompts.js');
    const { OBJECT_TO_CHARACTER_FRAME } = await load();
    const entry = DEFAULT_PROMPTS.find((item) => item.id === 'object-to-character-krea2');
    assert.equal(entry.workflow, 'object-to-character');
    assert.equal(entry.parts[0].prompt, OBJECT_TO_CHARACTER_FRAME);
    // The frame owns the staging; the character paragraph is told to leave it.
    assert.match(OBJECT_TO_CHARACTER_FRAME, /illustration/);
    assert.match(OBJECT_TO_CHARACTER_FRAME, /Behind them/);
});

test('every shipped image prompt has an example picture, and every picture is a real file', async () => {
    const { STARTER_ART, QUICK_PROMPT_ART, OBJECT_TO_CHARACTER_ART, starterArtFor } = await import('../src/studios/image/starterArt.js');
    const { DEFAULT_PROMPTS } = await import('../src/lib/defaultPrompts.js');
    const { QUICK_PROMPTS } = await import('../src/lib/promptUtils.js');
    const { OBJECT_TO_CHARACTER_EXAMPLES } = await load();

    const urls = [];
    for (const entry of DEFAULT_PROMPTS.filter((item) => item.section === 'image')) {
        assert.ok(starterArtFor(entry), `${entry.id} has a picture`);
        urls.push(STARTER_ART[entry.id]);
    }
    // A video starter has none, and says so with '' rather than undefined.
    assert.equal(starterArtFor(DEFAULT_PROMPTS.find((item) => item.section !== 'image')), '');
    for (const quick of QUICK_PROMPTS) {
        assert.ok(QUICK_PROMPT_ART[quick.label], `the ${quick.label} quick starter has a picture`);
        urls.push(QUICK_PROMPT_ART[quick.label]);
    }
    for (const example of OBJECT_TO_CHARACTER_EXAMPLES) {
        const pair = OBJECT_TO_CHARACTER_ART[example.key];
        assert.ok(pair?.before && pair?.after, `${example.key} has its before and after`);
        urls.push(pair.before, pair.after);
    }
    // Under node the URLs are file: URLs, so "the picture exists" is checkable
    // here; under Vite the same literals become fingerprinted asset URLs.
    for (const url of urls) {
        const file = fileURLToPath(url);
        assert.ok(fs.existsSync(file) && fs.statSync(file).size > 1000, `${path.basename(file)} is a real picture`);
    }
});

test('a preview card shows the character, the object it came from, and whether it is loaded', async () => {
    // The dialog around these portals through ui/Modal.jsx, which the render
    // harness cannot build; its flow was verified live. A card is plain markup.
    const { OBJECT_TO_CHARACTER_EXAMPLES } = await load();
    const { OBJECT_TO_CHARACTER_ART } = await import('../src/studios/image/starterArt.js');
    for (const example of OBJECT_TO_CHARACTER_EXAMPLES) {
        const art = OBJECT_TO_CHARACTER_ART[example.key];
        const idle = await renderComponent('src/dialogs/ObjectToCharacterDialog.jsx', 'ExampleCard', { example, art, active: false, onPick() {} });
        assert.equal((idle.match(/<img /g) || []).length, 2, `${example.key} draws both pictures`);
        assert.ok(idle.includes(`alt="${example.object}"`) && idle.includes(`alt="${example.character}"`));
        assert.match(idle, /aria-pressed="false"/);
        assert.match(idle, /Try it/);
        const loaded = await renderComponent('src/dialogs/ObjectToCharacterDialog.jsx', 'ExampleCard', { example, art, active: true, onPick() {} });
        assert.match(loaded, /aria-pressed="true"/);
        assert.match(loaded, /Loaded/);
    }
});
