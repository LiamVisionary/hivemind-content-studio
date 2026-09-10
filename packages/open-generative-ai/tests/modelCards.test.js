// The Models grid after it stopped being a wall of text.
//
// The rule this pins is a split: a card carries a picture and a sentence, and
// every technical fact — the id, the step count, the pixel size, the base-model
// chips — lives in the detail panel instead. Both halves are rendered here,
// because "the id is no longer on the card" is only true if the card actually
// renders and the detail actually holds it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, renderComponent, textOf } = require('./helpers/render.js');

const imageModel = (overrides = {}) => ({
    id: 'z-image-turbo',
    name: 'Z-Image Turbo LoRA Optimizer',
    description: 'Fast local text-to-image generation through the optimized Z-Image Turbo route.',
    type: 'image',
    family: 'z-image',
    compatibleBaseModels: ['ZImageTurbo'],
    supportsLoras: true,
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultSteps: 8,
    accepts: ['prompt', 'width', 'height', 'steps'],
    requires: { prompt: true, image: false },
    ready: true,
    ...overrides,
});

const resolvedCard = (overrides = {}) => ({
    source: 'huggingface',
    sourceName: 'Tongyi-MAI/Z-Image-Turbo',
    sourceUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo',
    artUrl: '/local-ai/model-art/' + 'a'.repeat(40),
    artKind: 'image',
    about: 'Z-Image is an efficient image generation model that runs in a handful of steps and holds prompt adherence while doing it.',
    links: [{ kind: 'huggingface', label: 'Hugging Face', url: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo' }],
    stats: {},
    matched: 1,
    ...overrides,
});

test('a card is a picture and a sentence — the numbers are not on it', async () => {
    // No bridge: the lookup never resolves, which is also the first paint of
    // every real visit, so this is the state the grid has to look right in.
    browser.setLocalAI({});
    const markup = await renderComponent('src/hub/views/models/RunnableModels.jsx', 'RunnableModels', {
        models: [imageModel()],
        loading: false,
    });
    const text = textOf(markup);
    assert.match(text, /Z-Image Turbo LoRA Optimizer/);
    // The registry's own line, until a source has a better one.
    assert.match(text, /Fast local text-to-image generation/);
    // What moved to the detail panel.
    assert.doesNotMatch(text, /z-image-turbo/, 'the id is back on the card');
    assert.doesNotMatch(text, /8 steps/, 'the step count is back on the card');
    assert.doesNotMatch(text, /1024/, 'the pixel size is back on the card');
    assert.doesNotMatch(text, /ZImageTurbo/, 'the base-model chip is back on the card');
});

test('a model with no artwork gets a tile of its own colour, not a hole', async () => {
    browser.setLocalAI({});
    const markup = await renderComponent('src/hub/views/models/ModelArt.jsx', 'ModelArt', {
        model: imageModel(),
        card: null,
    });
    assert.match(markup, /linear-gradient/);
    assert.match(textOf(markup), /ZI/);
});

test('a resolved card draws the picture the bridge cached, never a CDN url', async () => {
    browser.setLocalAI({});
    const card = resolvedCard();
    const markup = await renderComponent('src/hub/views/models/ModelArt.jsx', 'ModelArt', { model: imageModel(), card });
    assert.match(markup, /src="\/local-ai\/model-art\//);
    assert.doesNotMatch(markup, /huggingface\.co|civitai/);
});

test('only the exception is badged: a ready model does not say so on the tile', async () => {
    browser.setLocalAI({});
    const ready = await renderComponent('src/hub/views/models/RunnableModels.jsx', 'RunnableModels', {
        models: [imageModel()],
        loading: false,
    });
    assert.doesNotMatch(textOf(ready), /Ready/);
    const offline = await renderComponent('src/hub/views/models/RunnableModels.jsx', 'RunnableModels', {
        models: [imageModel({ ready: false, readyReason: 'engine-offline' })],
        loading: false,
    });
    assert.match(textOf(offline), /Offline/);
});

/* ---------------- the detail panel ---------------- */

test('the detail panel says what the model is, where that came from, and what it can do', async () => {
    browser.setLocalAI({});
    const markup = await renderComponent('src/hub/views/models/ModelDetail.jsx', 'ModelDetailBody', {
        model: imageModel(),
        card: resolvedCard(),
        onClose() {},
    });
    const text = textOf(markup);
    assert.match(text, /Z-Image is an efficient image generation model/);
    // Attribution, never implied: the page names the repo it matched.
    assert.match(text, /Matched to Tongyi-MAI\/Z-Image-Turbo on Hugging Face/);
    assert.match(text, /Read on Hugging Face/);
    // Capabilities in words rather than in field names.
    assert.match(text, /Works from a written prompt/);
    assert.match(text, /Runs with LoRAs/);
    // The lane's own sentence stays too: the model is Z-Image, the workflow is
    // our LoRA-optimised route through it, and they are not the same claim.
    assert.match(text, /What this workflow does/);
    assert.match(text, /Fast local text-to-image generation/);
    // And the numbers, behind their own disclosure.
    assert.match(text, /Technical details/);
});

test('one reference picture is not “up to 1 reference pictures”', async () => {
    browser.setLocalAI({});
    const one = await renderComponent('src/hub/views/models/ModelDetail.jsx', 'ModelDetailBody', {
        model: imageModel({ maxReferenceImages: 1 }),
        card: null,
        onClose() {},
    });
    assert.match(textOf(one), /Takes a reference picture/);
    const several = await renderComponent('src/hub/views/models/ModelDetail.jsx', 'ModelDetailBody', {
        model: imageModel({ maxReferenceImages: 4 }),
        card: null,
        onClose() {},
    });
    assert.match(textOf(several), /Takes up to 4 reference pictures/);
});

test('the picture and the words are attributed separately when they differ', async () => {
    browser.setLocalAI({});
    const markup = await renderComponent('src/hub/views/models/ModelDetail.jsx', 'ModelDetailBody', {
        model: imageModel(),
        // Civitai had the gallery; the repo wrote the description.
        card: resolvedCard({ artSource: 'civitai', links: [
            { kind: 'huggingface', url: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo' },
            { kind: 'civitai-mirror', url: 'https://civitai.red/models/2168935' },
        ] }),
        onClose() {},
    });
    const text = textOf(markup);
    assert.match(text, /Matched to Tongyi-MAI\/Z-Image-Turbo on Hugging Face\. Artwork from Civitai\./);
    // A mirror is named as one rather than opening a civitai.red address under
    // a button that says Civitai.
    assert.match(text, /Read on the Civitai mirror/);
});

test('a weak match is offered as a guess, not as the model’s page', async () => {
    browser.setLocalAI({});
    const markup = await renderComponent('src/hub/views/models/ModelDetail.jsx', 'ModelDetailBody', {
        model: imageModel(),
        card: resolvedCard({ source: 'civitai', sourceName: 'Z Image Turbo', matched: 0.5 }),
        onClose() {},
    });
    assert.match(textOf(markup), /Closest match on Civitai: Z Image Turbo/);
});

test('an unavailable model says what is missing and offers the download', async () => {
    browser.setLocalAI({});
    const markup = await renderComponent('src/hub/views/models/ModelDetail.jsx', 'ModelDetailBody', {
        model: imageModel({ ready: false, readyReason: 'missing-weights', missingWeights: ['unet/z-image-turbo.safetensors'] }),
        card: null,
        onClose() {},
        onOpenStore() {},
    });
    const text = textOf(markup);
    assert.match(text, /files are not on this machine yet/);
    assert.match(text, /unet\/z-image-turbo\.safetensors/);
    // A problem is never shown without its repair beside it.
    assert.match(text, /Browse models to install/);
});

test('a video workflow is described by its own registry paragraph', async () => {
    browser.setLocalAI({});
    const markup = await renderComponent('src/hub/views/models/ModelDetail.jsx', 'ModelDetailBody', {
        model: {
            id: 'hivemind-media:minimax-h3',
            workflowId: 'minimax-h3',
            name: 'MiniMax H3',
            description: 'MiniMax H3 omni-modal video generation: video and native stereo audio are denoised jointly in one pass.',
            type: 'video',
            workflowFamily: 'minimax',
            durations: [1, 2, 3, 4, 5],
            supportsMotionContext: true,
            ready: true,
        },
        card: null,
        onClose() {},
    });
    const text = textOf(markup);
    assert.match(text, /denoised jointly in one pass/);
    assert.match(text, /Clips up to 5 seconds/);
    assert.match(text, /Carries motion and room tone/);
});
