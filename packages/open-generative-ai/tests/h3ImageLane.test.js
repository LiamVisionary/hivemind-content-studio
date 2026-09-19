// The H3 still-image lane, from the registry through to a model the studio can
// select. H3 was never released as an image model — this graph decodes a short
// clip and picks the still out of it — so the wiring is worth pinning.
//
// Deliberately textual: an expanded subgraph and the weight names a lane routes
// on are JSON shapes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REGISTRY = path.join(__dirname, '../../media-gateway/workflow-registry.json');
const { loadHostedImageModels } = require('../hosted-local-models.js');

test('the H3 image lane reaches /local-ai/models as a selectable image model', () => {
    const models = loadHostedImageModels(REGISTRY);
    const h3 = models.find((model) => model.id === 'minimax-h3-image');
    assert.ok(h3, 'minimax-h3-image is registered');
    assert.equal(h3.type, 'image');
    // comfy-api-image is what run_comfy_api_image dispatches on; an image-backend
    // id would send it to a Python builder that does not exist for this lane.
    assert.equal(h3.backend, 'comfy-api-image');
    assert.equal(h3.maxReferenceImages, 9, 'the nine ordered @ImageN slots');
});

test('the lane names a graph file that exists and is API format', () => {
    const h3 = loadHostedImageModels(REGISTRY).find((model) => model.id === 'minimax-h3-image');
    // Absolute: the gateway resolves this from its own cwd, not the registry's.
    assert.ok(path.isAbsolute(h3.workflowFile), 'workflowFile is absolute');
    assert.ok(fs.existsSync(h3.workflowFile), `${h3.workflowFile} exists`);

    const graph = JSON.parse(fs.readFileSync(h3.workflowFile, 'utf8'));
    const nodes = Object.values(graph);
    assert.ok(nodes.length > 0);
    // API format: every value is a node with a class_type. A UI-format export
    // (nodes[]/links[]) would be silently unexecutable.
    for (const node of nodes) assert.equal(typeof node.class_type, 'string');
});

test('the graph keeps the two settings that make it drivable headlessly', () => {
    const h3 = loadHostedImageModels(REGISTRY).find((model) => model.id === 'minimax-h3-image');
    const graph = JSON.parse(fs.readFileSync(h3.workflowFile, 'utf8'));
    const director = Object.values(graph).find((n) => n.class_type === 'H3StudioDirector');
    assert.ok(director, 'the Director drives the run');

    // EMPTY studio_state is the whole reason this works from an API graph: the
    // node falls back to its widgets instead of the JSON its own frontend writes.
    assert.equal(director.inputs.studio_state, '', 'studio_state must stay empty');
    // compile_only keeps @ImageN -> <Picture N> deterministic and skips the VLM
    // rewrite; our own prompt writer already produced the text.
    assert.equal(director.inputs.enhance_mode, 'compile_only');
});

test('the sampling subgraph is expanded, because API format cannot carry one', () => {
    const h3 = loadHostedImageModels(REGISTRY).find((model) => model.id === 'minimax-h3-image');
    const graph = JSON.parse(fs.readFileSync(h3.workflowFile, 'utf8'));
    const classes = new Set(Object.values(graph).map((n) => n.class_type));
    // These six were one subgraph box in the upstream example workflow.
    for (const cls of ['H3StudioContextSamplingPreset', 'BasicGuider', 'RandomNoise',
        'SamplerCustomAdvanced', 'H3StudioDecode', 'H3StudioFrameSelector']) {
        assert.ok(classes.has(cls), `${cls} is present`);
    }
    // And nothing references a subgraph id.
    for (const node of Object.values(graph)) {
        assert.doesNotMatch(node.class_type, /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'no subgraph placeholder');
    }
});

test('every link points at a node that exists, on a real output slot', () => {
    const h3 = loadHostedImageModels(REGISTRY).find((model) => model.id === 'minimax-h3-image');
    const graph = JSON.parse(fs.readFileSync(h3.workflowFile, 'utf8'));
    for (const [id, node] of Object.entries(graph)) {
        for (const [name, value] of Object.entries(node.inputs || {})) {
            if (!Array.isArray(value)) continue;
            const [target, slot] = value;
            assert.ok(graph[target], `${id}.${name} -> node ${target} exists`);
            assert.ok(Number.isInteger(slot) && slot >= 0, `${id}.${name} slot is an index`);
        }
    }
    // The graph must terminate in a save, or nothing is written.
    assert.ok(Object.values(graph).some((n) => n.class_type === 'H3StudioSaveImage'));
});

test('the H3 weights are named so the existing rental lane routes it', () => {
    const h3 = loadHostedImageModels(REGISTRY).find((model) => model.id === 'minimax-h3-image');
    const graph = JSON.parse(fs.readFileSync(h3.workflowFile, 'utf8'));
    const loader = Object.values(graph).find((n) => n.class_type === 'H3StudioLoader');
    // gpu_rentals pins lane_needles ["minimax_h3"] and routes on model filenames,
    // so these names are what send the job to the rented H3 box. Renaming them
    // would silently run it on whatever lane answered first.
    assert.match(loader.inputs.fl2va_model, /minimax_h3/);
    assert.match(loader.inputs.ref2va_model, /minimax_h3/);
});

test('the graph has no LoadImage nodes, because the Director loads its own', () => {
    const h3 = loadHostedImageModels(REGISTRY).find((model) => model.id === 'minimax-h3-image');
    const graph = JSON.parse(fs.readFileSync(h3.workflowFile, 'utf8'));
    const director = Object.values(graph).find((n) => n.class_type === 'H3StudioDirector');

    // h3studio/image_inputs.py collect_images(): when media_{N} is unlinked but
    // media_filename_{N} names a file in ComfyUI input storage, the Director
    // loads it itself. That is why the still-image graph carries none of the
    // nine LoadImage nodes its video sibling pre-wires — the gateway sets the
    // filenames instead (_apply_h3_studio_director in media-gateway/app.py).
    assert.equal(Object.values(graph).filter((n) => n.class_type === 'LoadImage').length, 0);
    // And nothing else in the graph may claim to carry a reference.
    assert.ok(!('media_1' in director.inputs), 'no dangling media link in the exported graph');
});

test('the lane advertises the reference grammar the gateway actually reads', () => {
    const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    const entry = (registry.workflows || []).find((w) => w.id === 'minimax-h3-image');

    // `reference_images` is what flips the studio's UploadPicker on
    // (localModelSupportsImageInput). It was advertised here before any send
    // path existed; these two must not drift apart again.
    assert.ok(entry.accepts.includes('reference_images'));
    assert.equal(entry.max_reference_images, 9);
    assert.equal(entry.reference_slots.images, 9);
    // The Director's own cap (h3studio/constants.py MAX_REFERENCE_IMAGES).
    assert.equal(entry.reference_slots.videos, 0, 'the still lane takes pictures only');
    assert.equal(entry.reference_slots.audios, 0);
});
