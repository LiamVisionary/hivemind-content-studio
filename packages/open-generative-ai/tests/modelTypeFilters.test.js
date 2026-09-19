// A bill is not a type.
//
// The Runs-on picker segmented its list by who pays and by nothing else, so the
// 110 MUAPI image rows — 54 of them editors that take a required picture and
// (19 times) no prompt field at all — were the same grey names as the 50 a
// prompt alone reaches. The only rows that said what they were were the hosted
// rail's, which declare an endpoint per capability, and even those said it as
// "Text" and "Edit" with no way to ask the list for one or the other.
//
// This pins the second question: what does the model START from, where does
// each inventory's answer come from, and what a row that nobody answered for
// looks like (nothing — an unbadged row is honest, a guessed badge is not).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { importComponent, renderElement, root, textOf } = require('./helpers/render.js');

globalThis.__HIVEMIND_STUDIO__ = 1;

const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);

/* ---------------- the derivation ---------------- */

test('what a row starts from comes from its inventory, and is left blank when none said', async () => {
    const { buildRunTargets } = await load('src/lib/runTargets.js');
    const typeOf = (model) => buildRunTargets({
        kind: 'image',
        catalogProviders: [{ id: 'muapi', available: true, models: [{ label: 'row', ...model }] }],
    })[0].startsFrom;

    // The hosted rail names one endpoint per capability: `flux-3` is four
    // prices and one model, and collapsed to a row the capabilities are the
    // only thing left that says it can start from a picture.
    assert.equal(typeOf({ id: 'a', hosted_routes: { 'text-to-image': {}, 'image-to-image': {} } }), 'hybrid');
    assert.equal(typeOf({ id: 'b', hosted_routes: { 'image-to-image': {} } }), 'image');
    assert.equal(typeOf({ id: 'c', hosted_routes: { 'text-to-image': {} } }), 'text');
    // A clip or a soundtrack in, no prompt: the v2v tools and the rail's own
    // video rows. Still a type, so the filter can offer them.
    assert.equal(typeOf({ id: 'd', hosted_routes: { 'video-to-video': {} } }), 'video');

    // The two studio catalogs say the same thing as a plain list.
    assert.equal(typeOf({ id: 'e', capabilities: ['text-to-image', 'image-to-image'] }), 'hybrid');
    assert.equal(typeOf({ id: 'f', capabilities: ['image-to-video'] }), 'image');

    // With no capabilities, the fields the model accepts answer — and
    // `requires_image` is the one thing that rules a prompt out.
    assert.equal(typeOf({ id: 'g', accepts: ['prompt'] }), 'text');
    assert.equal(typeOf({ id: 'h', accepts: ['prompt', 'image_url'] }), 'hybrid');
    assert.equal(typeOf({ id: 'i', accepts: ['prompt', 'image_url'], requires_image: true }), 'image');
    // H3's ordered multi-slot grammar is an image input too.
    assert.equal(typeOf({ id: 'j', accepts: ['prompt', 'reference_images'] }), 'hybrid');

    // AND THE ONE THAT MATTERS MOST: an inventory that declared nothing gets
    // no type. The media catalog leaves `accepts` empty for every provider
    // whose inputs it never listed — GPT Image, which takes sixteen reference
    // pictures, is one of them — so reading an empty list as "text only" would
    // print a wrong badge on a right row.
    assert.equal(typeOf({ id: 'k' }), '');
    assert.equal(typeOf({ id: 'l', accepts: [] }), '');
});

test('a local workflow that cannot start from a prompt says so', async () => {
    const { buildRunTargets } = await load('src/lib/runTargets.js');
    const rows = buildRunTargets({
        kind: 'image',
        localModels: [
            { id: 'z-image-turbo', name: 'Z-Image Turbo', accepts: ['prompt'], requires: { prompt: true, image: false } },
            { id: 'krea2-edit', name: 'Krea 2 Identity Edit', accepts: ['prompt', 'image_path'], requires: { prompt: true, image: true } },
        ],
    });
    assert.deepEqual(rows.map((row) => row.startsFrom), ['text', 'image']);
});

/* ---------------- where each catalog's answer comes from ---------------- */

test('the image catalog answers from the bucket a model is listed in', async () => {
    // The namespace, never a destructure: the buckets are live bindings that
    // are EMPTY until the catalog lands, and `const { t2iModels } = …` copies
    // the empty array rather than following the reassignment.
    const catalog = await load('src/lib/cloudCatalog.js');
    await catalog.cloudCatalogReady();
    const { i2iModels, t2iModels } = catalog;
    const { studioCloudImageModels } = await load('src/studios/image/imageRunTargets.js');
    const rows = new Map(studioCloudImageModels().map((row) => [row.id, row.capabilities]));

    // Every row is claimed by at least one bucket, and a model in both is one
    // row that can do both.
    assert.ok(rows.size >= 100, `only ${rows.size} cloud image models`);
    for (const [id, capabilities] of rows) {
        assert.ok(capabilities.length >= 1, `${id} claims no capability`);
        assert.equal(capabilities.includes('text-to-image'), t2iModels.some((m) => m.id === id));
        assert.equal(capabilities.includes('image-to-image'), i2iModels.some((m) => m.id === id));
    }
    // The editors are the point: an upscaler is not a model a prompt reaches.
    assert.deepEqual(rows.get('ai-image-upscaler'), ['image-to-image']);
});

test('the video catalog answers mode-blind, from four inventories', async () => {
    const catalog = await load('src/lib/cloudCatalog.js');
    await catalog.cloudCatalogReady();
    const { i2vModels, t2vModels, v2vModels } = catalog;
    const { videoModelCapabilities } = await load('src/studios/video/videoRunTargets.js');
    const { hivemindVideoModelId } = await load('src/lib/hivemindModelIds.js');

    assert.deepEqual(videoModelCapabilities(t2vModels[0]), ['text-to-video']);
    assert.deepEqual(videoModelCapabilities(i2vModels[0]), ['image-to-video']);
    assert.deepEqual(videoModelCapabilities(v2vModels[0]), ['video-to-video']);

    // A lane is text-to-video first — H3 with no start frame is the studio's
    // most common run — and takes what its graph wires on top. Read off the
    // registry mapper's flags, never off which mode-scoped list the model is
    // in right now: with a start frame attached that list is the i2v one and
    // nothing else, which answers "is a frame attached", not "what can it do".
    assert.deepEqual(
        videoModelCapabilities({ id: hivemindVideoModelId('minimax-h3'), supportsStartFrame: true, supportsReferenceImages: true }),
        ['text-to-video', 'image-to-video'],
    );
    assert.deepEqual(
        videoModelCapabilities({ id: hivemindVideoModelId('ltx23-regular-fp8'), supportsStartFrame: true, supportsVideoInput: true }),
        ['text-to-video', 'image-to-video', 'video-to-video'],
    );
    assert.deepEqual(videoModelCapabilities({ id: hivemindVideoModelId('plain') }), ['text-to-video']);
    // A model no inventory here claims stays untyped.
    assert.equal(videoModelCapabilities({ id: 'nothing-knows-this' }), null);
});

/* ---------------- the filters, and the kind's own words ---------------- */

test('the filters offer only the types that are there, in the kind own words', async () => {
    const { buildRunTargets, runTypesFor } = await load('src/lib/runTargets.js');
    const targets = buildRunTargets({
        kind: 'image',
        catalogProviders: [{
            id: 'muapi',
            available: true,
            models: [
                { id: 'a', label: 'A', capabilities: ['text-to-image'] },
                { id: 'b', label: 'B', capabilities: ['text-to-image'] },
                { id: 'c', label: 'C', capabilities: ['image-to-image'] },
                { id: 'd', label: 'D', capabilities: ['text-to-image', 'image-to-image'] },
                { id: 'e', label: 'E' },
            ],
        }],
    });
    assert.deepEqual(
        runTypesFor(targets, 'image').map((type) => [type.label, type.targets.length]),
        [['Text to image', 2], ['Image to image', 1], ['Hybrid', 1]],
    );
    // The same rows in the video studio's vocabulary — a model that takes a
    // picture to EDIT one and a model that takes one to MOVE it are not the
    // same thing said twice.
    assert.deepEqual(
        runTypesFor(buildRunTargets({
            kind: 'video',
            catalogProviders: [{ id: 'muapi', available: true, models: [
                { id: 'a', label: 'A', capabilities: ['text-to-video'] },
                { id: 'b', label: 'B', capabilities: ['image-to-video'] },
                { id: 'c', label: 'C', capabilities: ['video-to-video'] },
            ] }],
        }), 'video').map((type) => type.label),
        ['Text to video', 'Image to video', 'From a clip'],
    );
    // The untyped row is in none of them — and so is never hidden by a chip
    // that claims to hold it.
    assert.equal(runTypesFor(targets, 'image').reduce((sum, type) => sum + type.targets.length, 0), targets.length - 1);
});

/* ---------------- and what the picker draws ---------------- */

async function drawPicker(targets) {
    const RunOnList = await importComponent('src/components/RunOnPicker.jsx', 'RunOnList');
    const { markup, logged } = renderElement(RunOnList, {
        targets, value: null, onChange: () => {}, close: () => {},
    });
    assert.deepEqual(logged, [], 'the picker logged during render');
    return markup;
}

test('the picker draws the types as chips with counts, and each row wears its own', async () => {
    const { buildRunTargets } = await load('src/lib/runTargets.js');
    const markup = await drawPicker(buildRunTargets({
        kind: 'image',
        catalogProviders: [{
            id: 'muapi',
            available: true,
            models: [
                { id: 'nano-banana', label: 'Nano Banana', capabilities: ['text-to-image'] },
                { id: 'ai-image-upscaler', label: 'AI Image Upscaler', capabilities: ['image-to-image'] },
                { id: 'flux-3', label: 'Flux 3', hosted_routes: { 'text-to-image': {}, 'image-to-image': {}, 'video-to-video': {} } },
                { id: 'quiet', label: 'Quiet Row' },
            ],
        }],
    }));
    const text = textOf(markup);
    // The chips, with the rows behind each one counted.
    assert.match(text, /All Text to image 1 Image to image 1 Hybrid 1/);
    // …and the same fact on the row, in the width a row has. The editor's is a
    // requirement, not an extra: "Edit" beside a name reads as "can also edit",
    // which is how a prompt came to be written for a schema with no prompt.
    assert.match(text, /Nano Banana Text/);
    assert.match(text, /AI Image Upscaler Needs a picture/);
    // A capability the type does not cover is still said.
    assert.match(text, /Flux 3 Hybrid From video/);
    // Nobody answered for this one, so the picker does not answer for it.
    assert.match(text, /Quiet Row/);
    assert.doesNotMatch(textOf(markup.slice(markup.indexOf('Quiet Row'))), /Text|Hybrid|Needs/);
});

test('one type is a fact about the list, not a filter', async () => {
    const { buildRunTargets } = await load('src/lib/runTargets.js');
    const markup = await drawPicker(buildRunTargets({
        kind: 'image',
        catalogProviders: [{
            id: 'muapi',
            available: true,
            models: [
                { id: 'a', label: 'A', capabilities: ['text-to-image'] },
                { id: 'b', label: 'B', capabilities: ['text-to-image'] },
            ],
        }],
    }));
    assert.doesNotMatch(textOf(markup), /Text to image/);
});
