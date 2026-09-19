// Ingredients are conditioning, not the model.
//
// An IC-LoRA Ingredients lane builds a reference latent out of a stitched sheet
// and has no path without one — the native planner returns no plan when it has
// no reference image, and the Comfy graph's image slot goes unfilled. The
// composer therefore refused a prompt-only run with "Please add reference views
// or select an ingredients sheet", which reads as "LTX 2.3 cannot do
// text-to-video". It can: that is a sibling lane in the same registry family.
//
// So the registry names the lane a prompt-only run goes to instead, and the
// studio routes there rather than refusing. These pin the three joints that
// makes that true: the declaration, the resolver, and the composer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REGISTRY = path.join(__dirname, '../../media-gateway/workflow-registry.json');

function resolvedRegistry() {
    const data = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    const items = Array.isArray(data) ? data : (Array.isArray(data.workflows) ? data.workflows : Object.values(data.workflows || {}));
    const byId = new Map(items.map((item) => [String(item.id), item]));
    const merge = (base, override) => {
        if (!base || typeof base !== 'object' || Array.isArray(base)) return structuredClone(override);
        const out = structuredClone(base);
        for (const [key, value] of Object.entries(override)) {
            out[key] = (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]))
                ? merge(out[key], value)
                : structuredClone(value);
        }
        return out;
    };
    const resolve = (id) => {
        const item = byId.get(id);
        const parent = String(item.inherits || '').trim();
        return parent ? merge(resolve(parent), item) : structuredClone(item);
    };
    return [...byId.keys()].map(resolve);
}

test('every ingredients lane names a plain text-to-video lane that exists', () => {
    const workflows = resolvedRegistry();
    const byId = new Map(workflows.map((workflow) => [workflow.id, workflow]));
    const ingredientLanes = workflows.filter((workflow) => (workflow.accepts || []).includes('ingredient_images'));
    assert.ok(ingredientLanes.length, 'the registry has ingredient lanes to check');
    for (const lane of ingredientLanes) {
        const targetId = String(lane.text_to_video_workflow || '');
        assert.ok(targetId, `${lane.id} names a text_to_video_workflow`);
        const target = byId.get(targetId);
        assert.ok(target, `${lane.id} -> ${targetId} is a registered workflow`);
        // Routing one ingredients lane at another leaves the run exactly as
        // stuck as it started.
        assert.ok(!(target.accepts || []).includes('ingredient_images'),
            `${lane.id} -> ${targetId} is not itself an ingredients lane`);
        assert.ok((target.accepts || []).includes('prompt'), `${targetId} takes a prompt`);
        assert.ok(!(target.requires || {}).image, `${targetId} does not require an image`);
    }
});

test('an Eros ingredients lane does not fall back onto the regular checkpoint', () => {
    const byId = new Map(resolvedRegistry().map((workflow) => [workflow.id, workflow]));
    // The fallback is declared per workflow rather than found by scanning the
    // family, because "the plain lane" is a checkpoint decision: an Eros run
    // that quietly rendered on the regular build would be a worse surprise than
    // the refusal this replaced.
    for (const id of ['ltx23-eros-ic-ingredients-lora', 'ltx23-eros-v14-ic-ingredients-lora', 'ltx23-eros-dmd-ic-ingredients-lora']) {
        assert.notEqual(byId.get(id).text_to_video_workflow, 'ltx23-regular-fp8', `${id} keeps its own family`);
    }
    assert.equal(byId.get('ltx23-ic-ingredients-lora').text_to_video_workflow, 'ltx23-regular-fp8');
});

test('the MCP publishes the fallback, so the studio can read it off the catalog', () => {
    const mcp = fs.readFileSync(path.join(__dirname, '../../media-gateway/bin/media-studio-mcp.mjs'), 'utf8');
    assert.match(mcp, /text_to_video_workflow: String\(workflow\.text_to_video_workflow\)/);
    const catalog = fs.readFileSync(path.join(__dirname, '../../../src/hivemind_content_studio/media_catalog.py'), 'utf8');
    assert.match(catalog, /text_to_video_workflow: str = ""/);
    assert.match(catalog, /text_to_video_workflow=str\(workflow\.get\("text_to_video_workflow"\)/);
});

test('the resolver answers with the sibling, and refuses to invent one', async () => {
    const { pathToFileURL } = require('node:url');
    const originalWindow = global.window;
    const originalFetch = global.fetch;
    const originalLocalStorage = global.localStorage;
    const originalSessionStorage = global.sessionStorage;
    const eventTarget = new EventTarget();
    eventTarget.location = { search: '?hivemindStudio=1', origin: 'https://studio.test' };
    eventTarget.parent = { postMessage() {} };
    global.window = eventTarget;
    global.localStorage = { getItem: () => null, removeItem() {}, setItem() {} };
    global.sessionStorage = { getItem: () => null, removeItem() {}, setItem() {} };
    const workflow = (id, extra) => ({
        id,
        title: id,
        accepts: ['prompt', 'image_base64', 'loras'],
        family: 'ltx-2.3',
        aspect_ratios: ['16:9'],
        ...extra,
    });
    global.fetch = async (url) => {
        if (String(url).startsWith('/api/simple/prompts')) return { ok: true, json: async () => ({ prompts: [] }) };
        if (String(url).startsWith('/api/simple/catalog')) {
            return {
                ok: true,
                json: async () => ({
                    ok: true,
                    media: {
                        video: [{
                            id: 'media-studio-mcp',
                            label: 'Media Studio',
                            available: true,
                            detail: 'ready',
                            models: [
                                workflow('ltx23-regular-fp8'),
                                workflow('ltx23-ic-ingredients-lora', {
                                    accepts: ['prompt', 'ingredient_images', 'loras'],
                                    text_to_video_workflow: 'ltx23-regular-fp8',
                                }),
                                workflow('ltx23-orphan-ingredients', {
                                    accepts: ['prompt', 'ingredient_images'],
                                    text_to_video_workflow: 'a-lane-this-catalog-does-not-serve',
                                }),
                            ],
                        }],
                    },
                }),
            };
        }
        return { ok: true, json: async () => ({}) };
    };
    const moduleUrl = `${pathToFileURL(path.join(__dirname, '../src/lib/hivemindStudio.js')).href}?test=${Date.now()}`;
    const studio = await import(moduleUrl);
    try {
        await studio.loadHivemindStudioContext({ refresh: true });

        const target = studio.textToVideoWorkflowForHivemindModel('hivemind-media:ltx23-ic-ingredients-lora');
        assert.equal(target?.workflowId, 'ltx23-regular-fp8');

        // A model that needs no conditioning is already its own answer.
        assert.equal(
            studio.textToVideoWorkflowForHivemindModel('hivemind-media:ltx23-regular-fp8')?.workflowId,
            'ltx23-regular-fp8',
        );

        // A named lane this catalog does not serve resolves to nothing, which
        // keeps the composer's refusal instead of routing a run into a workflow
        // id the backend would reject.
        assert.equal(studio.textToVideoWorkflowForHivemindModel('hivemind-media:ltx23-orphan-ingredients'), null);
        assert.equal(studio.textToVideoWorkflowForHivemindModel('hivemind-media:not-a-model'), null);
    } finally {
        global.window = originalWindow;
        global.fetch = originalFetch;
        global.localStorage = originalLocalStorage;
        global.sessionStorage = originalSessionStorage;
    }
});

// The panel says what the off state DOES, in the panel — a person should not
// have to press Generate to learn whether it was going to be refused.
test('the empty ingredients panel names the lane a prompt-only run goes to', async () => {
    const { renderComponent, textOf } = require('./helpers/render.js');
    const props = {
        model: { ingredientInputs: { max_images: 12 } },
        selection: [],
        sheets: [],
        selectedSheet: '',
        preview: { signature: '', status: 'idle', url: '', error: '' },
        previewSignature: '',
        uploadMessage: '',
        activeCount: 0,
        onAddViews() {},
        onAddSheets() {},
        onClear() {},
        onToggleSheet() {},
        onRemoveSheet() {},
        onRemoveView() {},
        onViewDescription() {},
        onSheetDescription() {},
        onRetryPreview() {},
    };
    const withFallback = textOf(await renderComponent(
        'src/studios/video/IngredientsPanel.jsx', 'IngredientsPanel',
        { ...props, textToVideoLabel: 'LTX 2.3 Regular FP8' },
    ));
    assert.match(withFallback, /Optional/);
    assert.match(withFallback, /generates from the prompt alone, on LTX 2\.3 Regular FP8/);

    // No fallback lane, no promise of one: the composer still refuses there, and
    // a line saying otherwise would be the same dead end one screen earlier.
    const without = textOf(await renderComponent(
        'src/studios/video/IngredientsPanel.jsx', 'IngredientsPanel',
        { ...props, textToVideoLabel: '' },
    ));
    assert.doesNotMatch(without, /generates from the prompt alone/);

    // Nor while a sheet IS armed — then the references are what the shot uses.
    const armed = textOf(await renderComponent(
        'src/studios/video/IngredientsPanel.jsx', 'IngredientsPanel',
        { ...props, activeCount: 1, textToVideoLabel: 'LTX 2.3 Regular FP8' },
    ));
    assert.match(armed, /Active in next generation/);
    assert.doesNotMatch(armed, /generates from the prompt alone/);
});

// The panel lives inside the References control, so the composer states it too:
// a run that renders on a different lane than the one named in the picker is
// exactly the invisible state that banner exists for.
test('the composer banner names the lane, and goes quiet once a sheet is armed', async () => {
    const logic = await import('../src/studios/video/videoLogic.js');
    const setup = { modelId: 'hivemind-media:ltx23-ic-ingredients-lora', v2vMode: false };
    const catalogs = { hivemindI2V: [], allI2V: [], allT2V: [] };
    assert.match(
        logic.deriveExtendBanner(setup, catalogs, { ingredientsFallbackLabel: 'LTX 2.3 Regular FP8' }),
        /No ingredients attached — this renders from the prompt alone, on LTX 2\.3 Regular FP8\./,
    );
    // Armed sheet or no fallback lane: VideoStudio passes '' and the banner
    // disappears rather than describing a run that is not happening.
    assert.equal(logic.deriveExtendBanner(setup, catalogs, { ingredientsFallbackLabel: '' }), '');
    assert.equal(logic.deriveExtendBanner(setup, catalogs), '');

    // A start frame does NOT silence it — the run still goes to the plain lane —
    // but "from the prompt alone" would then be a lie about what is in the
    // render, so the sentence names the frame.
    const framed = { ...setup, imageUrl: 'data:image/png;base64,AAA' };
    const banner = logic.deriveExtendBanner(framed, catalogs, { ingredientsFallbackLabel: 'LTX 2.3 Regular FP8' });
    assert.match(banner, /renders from your start frame and prompt, on LTX 2\.3 Regular FP8\./);
    assert.doesNotMatch(banner, /from the prompt alone/);
});

// --- a start frame is not a reference sheet ----------------------------------
//
// Reported 2026-09-13: pressing the sequence's "Continue the scene" on the LTX
// 2.3 IC-LoRA Ingredients lane and then Generate failed INSTANTLY with "Media
// Studio did not return a job id: the backend redacted the reason". The gateway
// log named it: `workflow ltx23-ic-ingredients-lora requires
// reference_description, unless prompt already contains both ### Reference Sheet
// Description and ### Target Description`.
//
// Cause: the routing rule was `!hasIngredientReferences && !setup.imageUrl`, so
// a start frame cancelled the fallback and held the run on the IC lane — an
// input that lane cannot use in place of a sheet. Continue attaches a start
// frame by design, so it hit this every time.
test('an ingredients lane with a start frame and no sheet still routes to the plain lane', () => {
    // The contract is the registry's, and it is what makes the frame useless
    // here: EVERY ingredients lane carries it, so there is no lane where a
    // frame-without-sheet run could have been accepted.
    const workflows = resolvedRegistry();
    const ingredientLanes = workflows.filter((workflow) => (workflow.accepts || []).includes('ingredient_images'));
    assert.ok(ingredientLanes.length);
    for (const lane of ingredientLanes) {
        assert.equal(lane.prompt_contract?.type, 'ltx23-ingredients',
            `${lane.id} must declare the contract that refuses a sheetless run`);
        // ...and it takes a start frame, which is exactly why the rule looked
        // reasonable and was not.
        assert.ok((lane.accepts || []).includes('image_base64'), `${lane.id} takes a start frame`);
    }

    const studio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    // Neither copy of the rule may consult the start frame again.
    assert.doesNotMatch(studio, /!hasIngredientReferences && !setup\.imageUrl/,
        'the start frame is back in the routing rule, and the IC lane will refuse the run');
    assert.doesNotMatch(studio, /!activeIngredients && !s\.setup\.imageUrl/);

    // Three of the four lanes fall back to ltx23-eros-v14-comfy, which has NO
    // start-frame input. Routing a frame there would drop it silently, so the
    // press refuses instead and names both ways out.
    const byId = new Map(workflows.map((workflow) => [workflow.id, workflow]));
    const droppers = ingredientLanes.filter((lane) => {
        const target = byId.get(String(lane.text_to_video_workflow || ''));
        return target && !(target.accepts || []).includes('image_base64');
    });
    assert.ok(droppers.length, 'this guard is only worth its words while such a lane exists');
    assert.match(studio, /if \(setup\.imageUrl && ingredientsOffTarget && !ingredientsOffTarget\.supportsStartFrame\) \{/);
    assert.match(studio, /has no start-frame input, and with no reference views attached this run goes there/);
});

test('the composer generates from the prompt alone, and sends it to that lane', () => {
    // Deliberately textual: this is the submit handler's control flow, not
    // markup. generate() is ~400 lines inside VideoStudio's engine object and
    // reaches it only through a real press with a loaded catalog, a seeded
    // setup and a live fetch; there is nothing a static render can show about
    // which workflow id the request carries. The rendered half of this change
    // is covered above.
    const studio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    // The run is allowed through the imageMode guard when a fallback exists...
    assert.match(studio, /const hiveTextToVideo = isHivemindLocal\s*\n\s*&& \(!model\?\.supportsIngredientImages \|\| Boolean\(ingredientsOffTarget\)\);/);
    // ...and is actually sent to that lane, not to the IC graph.
    assert.match(studio, /localParams\.workflow_id = ingredientsOffTarget\.workflowId;/);
    // ...and only while no SHEET is attached: a run WITH a sheet must still go
    // to the IC graph, which is what the sheet is for. A start frame must NOT
    // hold the run on the IC lane — see the start-frame test below.
    assert.match(studio, /&& !hasIngredientReferences\n\s*\? textToVideoWorkflowForHivemindModel\(setup\.modelId\)/);
    // "Describe the shot to generate from these references" is only true when
    // there ARE references; it used to fire on the model alone and demanded a
    // prompt for a sheet that was not attached.
    assert.match(studio, /if \(hasIngredientReferences && !prompt\)/);

    // The placeholder stops naming references that are not selected.
    const logic = fs.readFileSync(path.join(__dirname, '../src/studios/video/videoLogic.js'), 'utf8');
    assert.match(logic, /model\?\.supportsIngredientImages && ingredientsActive/);
    // One resolution, read by the banner, the panel label and the request — so
    // the three can never name different lanes.
    assert.match(studio, /const ingredientsFallback = ingredientModel && !activeIngredients\n/);
    assert.match(studio, /ingredientsFallbackLabel: ingredientsFallback\?\.name \|\| ''/);
    assert.match(studio, /textToVideoLabel=\{ingredientsFallback\?\.name \|\| ''\}/);
});
