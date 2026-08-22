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

test('the ordered multi-slot reference grammar counts as image input', async () => {
    const { localModelSupportsImageInput } = await import('../src/lib/localImageModelFilter.js');

    // The H3 still-image lane takes nine ordered references and names none of
    // the single-source image_* fields — it declares `reference_images`, the
    // same grammar its video sibling speaks. Reading only the image_* list
    // rendered the UploadPicker disabled on a lane with nine live slots.
    const h3 = {
        id: 'minimax-h3-image',
        requires: { prompt: true, image: false },
        accepts: ['prompt', 'width', 'height', 'seed', 'aspect_ratio', 'reference_images'],
        maxReferenceImages: 9,
    };
    assert.equal(localModelSupportsImageInput(h3), true);

    // Still a real gate: a text-only lane stays refused.
    assert.equal(localModelSupportsImageInput({ id: 'z-image', accepts: ['prompt', 'seed'] }), false);
});

test('the registry mapper derives the same reference capability server-side', async () => {
    const { createRequire } = await import('node:module');
    const path = await import('node:path');
    const require = createRequire(import.meta.url);
    const { loadHostedImageModels } = require('../hosted-local-models.js');
    const { localModelSupportsImageInput } = await import('../src/lib/localImageModelFilter.js');

    const registry = path.join(import.meta.dirname, '../../media-gateway/workflow-registry.json');
    const h3 = loadHostedImageModels(registry).find((model) => model.id === 'minimax-h3-image');

    // /local-ai/models reported supportsImage:false while advertising nine
    // reference slots. The mapper and the client filter must not disagree.
    assert.equal(h3.supportsImage, true, 'the API tells the truth about the nine slots');
    assert.equal(localModelSupportsImageInput(h3), true);
});
