const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadHostedImageModels, loadHostedWorkflowModels } = require('../hosted-local-models');

test('hosted image models are derived from launchable image workflow entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-image-workflows-'));
    const registryPath = path.join(dir, 'workflow-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({
        workflows: [
            {
                id: 'image-edit',
                media_type: 'image',
                builder: 'image-backend',
                title: 'Image Edit',
                family: 'test-family',
                backend: 'comfy-image-edit',
                supports_loras: true,
                compatible_base_models: ['Test Base'],
                prompt_helper: {
                    profile: 'swarm_booru_tags',
                    label: 'Anima prompt',
                    helper_mode: 'None',
                    timeout_seconds: 75,
                },
                requires: { prompt: true, image: true },
                accepts: ['prompt', 'image_base64'],
                max_reference_images: 1,
                defaults: { width: 768, height: 1024, steps: 4, guidance: 3.5 },
            },
            { id: 'video-only', media_type: 'video', builder: 'comfy-api' },
            { id: 'unlaunchable-image', media_type: 'image', builder: 'saved-ui-graph' },
        ],
    }));

    const models = loadHostedImageModels(registryPath);
    assert.equal(models.length, 1);
    assert.deepEqual(models[0], {
        id: 'image-edit',
        name: 'Image Edit',
        description: '',
        type: 'image',
        family: 'test-family',
        provider: 'hosted-media-studio',
        state: 'downloaded',
        backend: 'comfy-image-edit',
        supportsLoras: true,
        compatibleBaseModels: ['Test Base'],
        promptHelper: {
            profile: 'swarm_booru_tags',
            label: 'Anima prompt',
            helperMode: 'None',
            timeoutSeconds: 75,
        },
        requires: { prompt: true, image: true },
        accepts: ['prompt', 'image_base64'],
        supportsImage: true,
        maxReferenceImages: 1,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        samplers: [],
        schedulers: [],
        defaultWidth: 768,
        defaultHeight: 1024,
        defaultSteps: 4,
        defaultGuidance: 3.5,
        tags: ['local'],
        featured: false,
    });
});

test('hosted workflow discovery resolves inherited workflow definitions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-inherited-workflows-'));
    const registryPath = path.join(dir, 'workflow-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({
        workflows: [
            {
                id: 'regular-ingredients',
                media_type: 'video',
                family: 'ltx-2.3',
                supports_loras: true,
                compatible_base_models: ['LTXV'],
            },
            {
                id: 'eros-ingredients',
                inherits: 'regular-ingredients',
                title: 'Eros Ingredients',
            },
        ],
    }));

    const models = loadHostedWorkflowModels(registryPath);
    assert.deepEqual(models[1], {
        id: 'eros-ingredients',
        name: 'Eros Ingredients',
        mediaType: 'video',
        family: 'ltx-2.3',
        supportsLoras: true,
        compatibleBaseModels: ['LTXV'],
        promptHelper: null,
    });
});

// React component wiring has no importable surface, so this stays a source check —
// aimed at the shipping studio (src/studios/ImageStudio.jsx) and at the LoRA panel
// the Civitai/download affordances moved into during the React port.
test('Explore discovers runtime image workflows and forwards inline images', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/studios/ImageStudio.jsx'), 'utf8');
    const loraPanel = fs.readFileSync(path.join(__dirname, '../src/studios/image/LoraSection.jsx'), 'utf8');

    assert.match(source, /localAI\.listModels\(\)/, 'discovers runtime local models');
    assert.match(source, /compatibleLocalModels\(\)/, 'filters them to the compatible set');
    assert.match(source, /image_base64:/, 'forwards inline image bytes rather than a blob URL');
    assert.match(source, /localAI\.listLoras\(model\.id\)/, 'lists LoRAs for the selected model');
    assert.match(source, /loras: loraGenerationPayload\(currentLoraSelection\(\)\)/, 'forwards the LoRA payload');
    assert.match(source, /CivitaiDownloadDialog/, 'can open the Civitai download dialog');
    assert.match(loraPanel, /Download LoRA/, 'the LoRA panel offers a download affordance');
    assert.match(source, /localAI\.generatePrompt\(/, 'runs the local prompt helper');
    // A blob: URL cannot survive a reload or reach the backend — references must be
    // read as bytes. This guard is why image_base64 exists above.
    assert.doesNotMatch(source, /URL\.createObjectURL\(file\)/);
});
