const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { discoverAutoImageWorkflows, inspectAutoWorkflow } = require('../auto-workflow-discovery');

const T2I_GRAPH = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'waiANIMA_v10Base10.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'LoadQwen35AnimaCLIP', inputs: { clip_name: 'qwen35_4b.safetensors' } },
    4: {
        class_type: 'ForgeCoupleRegionalPrompt',
        inputs: { model: ['1', 0], clip: ['2', 0], positive_text: 'two girls', width: 1024, height: 1344 },
    },
    6: { class_type: 'EmptyQwenImageLayeredLatentImage', inputs: { width: 1024, height: 1344, layers: 0, batch_size: 1 } },
    7: {
        class_type: 'KSampler',
        inputs: { model: ['4', 0], positive: ['4', 1], negative: ['4', 1], latent_image: ['6', 0], seed: 7, steps: 8, cfg: 1.0 },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'auto_test' } },
};

test('auto-detects an API-format text-to-image graph with template defaults', () => {
    const model = inspectAutoWorkflow('/x/wai-anima-couple-turbo.json', JSON.stringify(T2I_GRAPH));
    assert.ok(model);
    assert.equal(model.id, 'comfy-auto-wai-anima-couple-turbo');
    assert.equal(model.backend, 'comfy-api-image');
    assert.equal(model.workflowFile, '/x/wai-anima-couple-turbo.json');
    assert.equal(model.type, 'image');
    assert.equal(model.defaultWidth, 1024);
    assert.equal(model.defaultHeight, 1344);
    assert.equal(model.defaultSteps, 8);
    assert.equal(model.requires.image, false);
    assert.equal(model.supportsImage, false);
    assert.match(model.description, /waiANIMA_v10Base10/);
});

test('accepts a {prompt: graph} wrapper export', () => {
    const model = inspectAutoWorkflow('/x/wrapped.json', JSON.stringify({ prompt: T2I_GRAPH }));
    assert.ok(model);
    assert.equal(model.id, 'comfy-auto-wrapped');
});

test('skips web-format editor exports, utility graphs, and image-input graphs', () => {
    const webFormat = { nodes: [{ id: 1, type: 'KSampler' }], links: [] };
    assert.equal(inspectAutoWorkflow('/x/web.json', JSON.stringify(webFormat)), null);

    const conversion = {
        0: { class_type: 'INT8PreLoraLoader', inputs: { lora_name_1: 'x.safetensors' } },
        1: { class_type: 'OTUNetLoaderW8A8', inputs: { unet_name: 'y.safetensors', pre_lora: ['0', 0] } },
        2: { class_type: 'INT8ModelSave', inputs: { model: ['1', 0], filename_prefix: 'z' } },
    };
    assert.equal(inspectAutoWorkflow('/x/convert.json', JSON.stringify(conversion)), null);

    const withImage = JSON.parse(JSON.stringify(T2I_GRAPH));
    withImage[3] = { class_type: 'LoadImage', inputs: { image: 'ref.png' } };
    assert.equal(inspectAutoWorkflow('/x/i2i.json', JSON.stringify(withImage)), null);

    assert.equal(inspectAutoWorkflow('/x/broken.json', '{not json'), null);
});

test('discovers from folders, skipping invalid files without failing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-workflows-'));
    try {
        fs.writeFileSync(path.join(dir, 'good_api.json'), JSON.stringify(T2I_GRAPH));
        fs.writeFileSync(path.join(dir, 'bad.json'), '{');
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');
        const models = discoverAutoImageWorkflows([dir, path.join(dir, 'missing-subdir')]);
        assert.equal(models.length, 1);
        assert.equal(models[0].id, 'comfy-auto-good-api');
        assert.equal(models[0].name, 'Good');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('hosted server merges auto-detected models and forwards workflow_file', () => {
    const source = fs.readFileSync(path.join(__dirname, '../hosted-server.js'), 'utf8');
    assert.match(source, /discoverAutoImageWorkflows/);
    assert.match(source, /workflow_file = selected\.workflowFile/);
});

test('marks regional-prompt graphs couple-capable, plain graphs not', () => {
    const regional = {
        ...T2I_GRAPH,
        4: {
            ...T2I_GRAPH[4],
            inputs: { ...T2I_GRAPH[4].inputs, advanced_mapping: '[[0.0, 0.5, 0.0, 1.0, 1.0], [0.5, 1.0, 0.0, 1.0, 1.0]]' },
        },
    };
    assert.equal(inspectAutoWorkflow('/x/couple.json', JSON.stringify(regional)).coupleCapable, true);
    assert.equal(inspectAutoWorkflow('/x/plain.json', JSON.stringify(T2I_GRAPH)).coupleCapable, false);
});

test('hosted server forwards couple options to the local API', () => {
    const source = fs.readFileSync(path.join(__dirname, '../hosted-server.js'), 'utf8');
    assert.match(source, /payload\.couple_mode = true/);
    assert.match(source, /couple_split/);
    assert.match(source, /couple_direction/);
});

test('infers LoRA base compatibility from the checkpoint name', () => {
    const anima = inspectAutoWorkflow('/x/wai.json', JSON.stringify(T2I_GRAPH));
    assert.equal(anima.supportsLoras, true);
    assert.deepEqual(anima.compatibleBaseModels, ['Anima']);

    const unknown = {
        ...T2I_GRAPH,
        1: { class_type: 'UNETLoader', inputs: { unet_name: 'mystery_model_v2.safetensors', weight_dtype: 'default' } },
    };
    const model = inspectAutoWorkflow('/x/mystery.json', JSON.stringify(unknown));
    assert.equal(model.supportsLoras, false);
    assert.deepEqual(model.compatibleBaseModels, []);
});

test('loras route falls back to auto-discovered models', () => {
    const source = fs.readFileSync(path.join(__dirname, '../hosted-server.js'), 'utf8');
    assert.match(source, /listWorkflowModels\(\)\.find\(\(model\) => model\.id === modelId\)\s*\|\|\s*listModels\(\)\.find/);
});
