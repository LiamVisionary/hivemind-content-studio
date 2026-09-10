// The shipped IMAGE starter shelf: which model sees it, and whether the recipe
// each starter carries is one the workflow can actually be set to.
//
// An image starter is a prompt AND the numbers it was written at, so the numbers
// are checked against the real workflow registry rather than a fixture. A graph
// that drops a sampler, a scheduler or an aspect ratio the shelf depends on
// fails here instead of silently running the starter at the graph's own
// defaults, which is the failure that has no visible symptom — the picture just
// comes back wrong and nothing says why.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadHostedImageModels } = require('../hosted-local-models');

const REGISTRY = path.join(__dirname, '..', '..', 'media-gateway', 'workflow-registry.json');
const imageWorkflows = () => loadHostedImageModels(REGISTRY);

test('every image starter is a recipe its own workflow can be set to', async () => {
    const { DEFAULT_PROMPTS } = await import('../src/lib/defaultPrompts.js');
    const starters = DEFAULT_PROMPTS.filter((entry) => entry.section === 'image');
    assert.ok(starters.length, 'the image shelf ships');
    const workflows = imageWorkflows();

    for (const entry of starters) {
        const setup = entry.setup;
        assert.ok(setup, `${entry.id} carries the settings it was written at`);
        // Which workflows this starter is offered to. At least one has to exist,
        // or the row can never appear.
        const targets = workflows.filter((model) => model.family === entry.family);
        assert.ok(targets.length, `${entry.id} targets a workflow the registry ships (${entry.family})`);

        for (const model of targets) {
            const where = `${entry.id} on ${model.id}`;
            // Sampler and scheduler are applied only when the graph advertises
            // them (applyImageStarterSetup), so one the graph does not list is
            // not an error at runtime — it is a starter that silently runs on a
            // different schedule than the one it was tuned on.
            if (setup.sampler) {
                assert.ok(model.samplers.includes(setup.sampler), `${where} can select ${setup.sampler}`);
            }
            if (setup.scheduler) {
                assert.ok(model.schedulers.includes(setup.scheduler), `${where} can select ${setup.scheduler}`);
            }
            if (setup.aspectRatio) {
                assert.ok(model.aspectRatios.includes(setup.aspectRatio), `${where} offers ${setup.aspectRatio}`);
            }
            if (setup.loras?.length) {
                assert.ok(model.supportsLoras, `${where} has a LoRA path at all`);
            }
        }

        // The studio's own step/CFG inputs are the range these land in.
        assert.ok(Number(setup.steps) > 0 && Number(setup.steps) <= 50, `${entry.id} steps are in range`);
        assert.ok(Number(setup.guidanceScale) >= 0 && Number(setup.guidanceScale) <= 20,
            `${entry.id} CFG is in range`);
        // The short side is snapped to 64 by resolveLocalDimensions; a base that
        // is not already a multiple would advertise a size it never renders at.
        if (setup.baseSize) {
            assert.equal(Number(setup.baseSize) % 64, 0, `${entry.id} base size is a multiple of 64`);
        }
        // A starter that names a LoRA has to say so on the row: the menu shows
        // `requires` once, and the trigger word is already in the prompt doing
        // nothing until the adapter behind it is installed.
        for (const lora of setup.loras || []) {
            assert.ok(entry.requires?.toLowerCase().includes(String(lora.match).toLowerCase()),
                `${entry.id} names ${lora.match} in its Needs line`);
        }
    }
});

test('the image shelf is offered to its own workflow and nothing else', async () => {
    const { defaultPromptsFor, imagePromptFamilyOf } = await import('../src/lib/defaultPrompts.js');
    const krea2 = imageWorkflows().find((model) => model.id === 'comfy-krea2-turbo-identity-edit');
    assert.ok(krea2, 'the Krea 2 Turbo workflow ships');

    assert.equal(imagePromptFamilyOf(krea2), 'krea-2');
    // A model that reached the studio without a registry family (the desktop
    // catalog, an auto-discovered drop-in) is still recognised by its backend.
    assert.equal(imagePromptFamilyOf({ backend: 'comfy-krea2-turbo-identity-edit' }), 'krea-2');
    // A cloud model is the ordinary no-starter case, not a missing one.
    assert.equal(imagePromptFamilyOf(null), '');
    assert.equal(imagePromptFamilyOf({ id: 'gpt-image-2' }), '');
    // A workflow whose family nothing is written for answers '' rather than
    // itself, so it cannot pull another family's prompts into the menu.
    assert.equal(imagePromptFamilyOf({ id: 'z-image-turbo', family: 'z-image' }), '');

    const listed = defaultPromptsFor('image', krea2);
    assert.ok(listed.length, 'Krea 2 Turbo sees the shelf');
    assert.ok(listed.every((entry) => entry.family === 'krea-2' && entry.section === 'image'));
    assert.deepEqual(defaultPromptsFor('image', { id: 'z-image-turbo', family: 'z-image' }), []);
    assert.deepEqual(defaultPromptsFor('image', null), []);
});

test('the anime/photoreal starter keeps the two halves it exists for', async () => {
    const { DEFAULT_PROMPTS, describeDefaultPrompt } = await import('../src/lib/defaultPrompts.js');
    const entry = DEFAULT_PROMPTS.find((item) => item.id === 'anime-cast-photoreal-krea2');
    assert.ok(entry, 'the starter ships');
    const prompt = entry.parts[0].prompt;

    // The LoRA trigger is the first token, not a mention somewhere in the middle:
    // it is what puts the characters in the trained style at all.
    assert.match(prompt, /^greedice_style, /);
    assert.equal(entry.setup.loras[0].match, 'greedice');

    // The whole effect is one paragraph written in two vocabularies. Flattening
    // either half into the other's language is the edit that loses it, so both
    // are asserted rather than described in a comment.
    assert.match(prompt, /anime-style illustration/);
    assert.match(prompt, /clean anime line work, soft shading/);
    assert.match(prompt, /highly realistic photographic farmyard/);
    assert.match(prompt, /authentic lighting, depth, and detail of a real outdoor photograph/);
    assert.match(prompt, /mixed-media contrast/);

    // Turbo's window. 8 is the recipe and 12 the ceiling; CFG is 1 because the
    // model is distilled, and raising it burns rather than tightens.
    assert.equal(entry.setup.steps, 8);
    assert.equal(entry.setup.guidanceScale, 1);
    assert.match(entry.note, /12 steps is the ceiling/);

    // "3:4 (1536p)": the short side is the base, so 1152 is what makes 1536.
    assert.equal(entry.setup.aspectRatio, '3:4');
    assert.equal(entry.setup.baseSize, 1152);
    assert.equal(Math.round(entry.setup.baseSize * 4 / 3 / 64) * 64, 1536);

    assert.equal(
        describeDefaultPrompt(entry),
        'Krea 2 Turbo · 3:4 · 8 steps · Drawn anime girls standing in a real photographic farmyard',
    );
});
