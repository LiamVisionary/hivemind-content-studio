import test from 'node:test';
import assert from 'node:assert/strict';

import { visibleLocalImageModels } from '../src/lib/localImageModelFilter.js';

const models = [
    { id: 'z-image', requires: { image: false }, accepts: ['prompt'] },
    { id: 'krea-2', requires: { image: false }, accepts: ['prompt', 'image_base64'] },
    { id: 'biglove', requires: { image: true }, accepts: ['prompt', 'image_base64'] },
];

test('local picker shows image-required workflows before an image is attached', () => {
    assert.deepEqual(
        visibleLocalImageModels(models, false).map(model => model.id),
        ['z-image', 'krea-2', 'biglove'],
    );
});

test('local picker hides workflows that cannot consume an attached image', () => {
    assert.deepEqual(
        visibleLocalImageModels(models, true).map(model => model.id),
        ['krea-2', 'biglove'],
    );
});

test('the negative prompt field only claims support the workflow actually has', async () => {
    const { localModelSupportsNegativePrompt } = await import('../src/lib/localImageModelFilter.js');

    // The Krea 2 identity graph hardcodes an empty negative encoder, so its registry
    // entry no longer lists negative_prompt — and the field must not be offered.
    const krea2 = { id: 'comfy-krea2-turbo-identity-edit', accepts: ['prompt', 'image_base64', 'cfg', 'seed', 'loras'] };
    assert.equal(localModelSupportsNegativePrompt(krea2), false);

    // Workflows that run through the generic Comfy path do wire one.
    assert.equal(localModelSupportsNegativePrompt({ accepts: ['prompt', 'negative_prompt', 'cfg'] }), true);

    // Unknown capability (no declared accepts) keeps the field: silence is not proof.
    assert.equal(localModelSupportsNegativePrompt({ id: 'mystery' }), true);
    assert.equal(localModelSupportsNegativePrompt({ accepts: [] }), true);
    assert.equal(localModelSupportsNegativePrompt(null), true);
});

test('a negative prompt is flagged as inactive at guidance 1', async () => {
    const { negativePromptNeedsGuidance } = await import('../src/lib/localImageModelFilter.js');

    // ComfyUI skips the uncond pass at cfg 1.0, which is the default for the turbo
    // workflows — the text is sent but never evaluated.
    assert.equal(negativePromptNeedsGuidance(1), true);
    assert.equal(negativePromptNeedsGuidance(0.5), true);
    assert.equal(negativePromptNeedsGuidance(1.5), false);
    assert.equal(negativePromptNeedsGuidance(7), false);
    assert.equal(negativePromptNeedsGuidance(undefined), false); // unknown: no claim
});
