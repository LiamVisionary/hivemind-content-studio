const test = require('node:test');
const assert = require('node:assert/strict');

// The live studio is src/studios/VideoStudio.jsx; its pure logic lives in
// video/videoLogic.js (a plain .js module precisely so node:test can import it).
async function loadVideoStudioHelpers() {
    return import('../src/studios/video/videoLogic.js');
}

test('video progress normalizes ratio and percentage telemetry', async () => {
    const { normalizeVideoGenerationProgress } = await loadVideoStudioHelpers();

    assert.equal(normalizeVideoGenerationProgress(0.42), 0.42);
    assert.equal(normalizeVideoGenerationProgress(42), 0.42);
    assert.equal(normalizeVideoGenerationProgress(120), 1);
    assert.equal(normalizeVideoGenerationProgress(-1), 0);
    assert.equal(normalizeVideoGenerationProgress(undefined), null);
});

test('video progress classifies provider stages without displaying raw messages', async () => {
    const { classifyVideoGenerationStage } = await loadVideoStudioHelpers();

    assert.equal(classifyVideoGenerationStage('loading model weights'), 'loading');
    assert.equal(classifyVideoGenerationStage('pending'), 'queued');
    assert.equal(classifyVideoGenerationStage('encoding output'), 'finishing');
    assert.equal(classifyVideoGenerationStage('sampling'), 'rendering');
});

test('video progress formats elapsed generation time', async () => {
    const { formatVideoGenerationElapsed } = await loadVideoStudioHelpers();

    assert.equal(formatVideoGenerationElapsed(0), '0:00');
    assert.equal(formatVideoGenerationElapsed(65_900), '1:05');
});

test('video popup positioning stays inside desktop and mobile viewports', async () => {
    const { clampVideoDropdownViewportLeft } = await loadVideoStudioHelpers();

    assert.equal(clampVideoDropdownViewportLeft(900, 384, 1024), 628);
    assert.equal(clampVideoDropdownViewportLeft(-40, 384, 1024), 12);
    assert.equal(clampVideoDropdownViewportLeft(24, 272, 320), 24);
    assert.equal(clampVideoDropdownViewportLeft(0, 400, 320), 12);
});

test('studio dropdowns cap their height to the space above the anchor and scroll', async () => {
    const { clampVideoDropdownMaxHeight } = await loadVideoStudioHelpers();

    assert.equal(clampVideoDropdownMaxHeight(600), 576);
    assert.equal(clampVideoDropdownMaxHeight(120), 180);
    assert.equal(clampVideoDropdownMaxHeight(undefined), 180);

    // The vanilla studios each set dropdown.style.maxHeight imperatively. React routes
    // every studio popup through one shared Menu, so the cap is asserted once, at the
    // single place that can now regress it.
    const fs = require('node:fs');
    const path = require('node:path');
    const menu = fs.readFileSync(path.join(__dirname, '../src/ui/Menu.jsx'), 'utf8');
    assert.match(menu, /max-h-\[min\([^\]]+\)\]/, 'the shared menu caps its height');
    assert.match(menu, /overflow-y-auto/, 'and scrolls instead of overflowing the viewport');
});

test('Ingredients start frames choose the nearest supported output geometry', async () => {
    const { closestVideoAspectRatio } = await loadVideoStudioHelpers();
    const ratios = ['16:9', '9:16', '4:3', '3:4', '1:1'];

    assert.equal(closestVideoAspectRatio(720, 1024, ratios), '3:4');
    assert.equal(closestVideoAspectRatio(1920, 1080, ratios), '16:9');
    assert.equal(closestVideoAspectRatio(1000, 1000, ratios), '1:1');
    assert.equal(closestVideoAspectRatio(0, 1000, ratios), null);
});

test('video preferences retain the complete generation configuration', async () => {
    const { normalizeVideoPreferences } = await loadVideoStudioHelpers();

    assert.deepEqual(
        normalizeVideoPreferences({
            modelId: ' hivemind-video:ltx23-eros-fast ',
            localMode: true,
            aspectRatio: ' 16:9 ',
            duration: '6',
            resolution: '1080p',
            quality: 'high',
            mode: 'pro',
            effectName: 'dolly',
            advancedValues: { generate_audio: false, guidance: 3.5, ignored: null },
            loraSelections: {
                'ltx23-regular-fp8': [{ id: 'ltx/style.safetensors', displayName: 'Style', strength: 0.75 }],
            },
            ingredientSelections: {
                'ltx23-ic-ingredients-lora': [
                    { url: '/api/media-studio/references/front.png', description: ' front view ' },
                    { url: 'https://outside.test/profile.png', description: 'ignored' },
                ],
            },
        }),
        {
            modelId: 'hivemind-video:ltx23-eros-fast',
            localMode: true,
            aspectRatio: '16:9',
            duration: 6,
            resolution: '1080p',
            quality: 'high',
            mode: 'pro',
            effectName: 'dolly',
            matchStartFrameAr: null,
            denoise: '',
            nagScale: null,
            seed: -1,
            advancedValues: { generate_audio: false, guidance: 3.5 },
            loraSelections: {
                'ltx23-regular-fp8': [{
                    id: 'ltx/style.safetensors',
                    name: 'ltx/style.safetensors',
                    displayName: 'Style',
                    previewUrl: '',
                    strength: 0.75,
                    enabled: true,
                }],
            },
            ingredientSelections: [{
                url: '/api/media-studio/references/front.png',
                description: 'front view',
            }],
            ingredientSheets: [],
            ingredientSelectedSheet: 'stitched',
        },
    );
    assert.deepEqual(
        normalizeVideoPreferences({ modelId: 'seedance-v2.0-t2v', duration: 0 }),
        {
            modelId: 'seedance-v2.0-t2v',
            localMode: null,
            aspectRatio: '',
            duration: null,
            resolution: '',
            quality: '',
            mode: '',
            effectName: '',
            matchStartFrameAr: null,
            denoise: '',
            nagScale: null,
            seed: -1,
            advancedValues: {},
            loraSelections: {},
            ingredientSelections: [],
            ingredientSheets: [],
            ingredientSelectedSheet: '',
        },
    );
    assert.equal(normalizeVideoPreferences({ duration: 5 }), null);
    assert.equal(normalizeVideoPreferences(null), null);
});

test('ping-when-complete is a shared setting, not a per-studio video preference', async () => {
    const { normalizeVideoPreferences } = await loadVideoStudioHelpers();

    // It used to round-trip through the video preferences blob. It is now owned by
    // lib/completionPing.js and shared across every studio, so persisting a copy here
    // would let the two disagree.
    const prefs = normalizeVideoPreferences({ modelId: 'seedance-v2.0-t2v', pingWhenComplete: true });
    assert.ok(!('pingWhenComplete' in prefs));

    const ping = await import('../src/lib/completionPing.js');
    assert.equal(typeof ping.isCompletionPingEnabled, 'function');
    assert.equal(typeof ping.setCompletionPingEnabled, 'function');
    assert.equal(typeof ping.subscribeCompletionPing, 'function');
});

test('video preferences migrate regular and Eros Ingredients into one shared selection', async () => {
    const { normalizeVideoPreferences } = await loadVideoStudioHelpers();

    const preferences = normalizeVideoPreferences({
        modelId: 'hivemind-video:ltx23-eros-ic-ingredients-lora',
        ingredientSelections: {
            'ltx23-ic-ingredients-lora': [
                { url: '/api/media-studio/references/front.png', description: 'front view' },
                { url: '/api/media-studio/references/profile.png', description: '' },
            ],
            'ltx23-eros-ic-ingredients-lora': [
                { url: '/api/media-studio/references/profile.png', description: 'profile view' },
            ],
        },
    });

    assert.deepEqual(preferences.ingredientSelections, [
        { url: '/api/media-studio/references/front.png', description: 'front view' },
        { url: '/api/media-studio/references/profile.png', description: 'profile view' },
    ]);
});

test('video preferences persist uploaded ingredient sheets and the selected sheet', async () => {
    const { normalizeVideoPreferences } = await loadVideoStudioHelpers();

    const preferences = normalizeVideoPreferences({
        modelId: 'hivemind-video:ltx23-ic-ingredients-lora',
        ingredientSelections: [{ url: '/api/media-studio/references/front.png', description: 'front' }],
        ingredientSheets: [
            { url: '/api/media-studio/references/sheet.png', description: ' full cast sheet ' },
            { url: 'https://outside.test/sheet.png', description: 'ignored' },
        ],
        ingredientSelectedSheet: '/api/media-studio/references/sheet.png',
    });

    assert.deepEqual(preferences.ingredientSheets, [
        { url: '/api/media-studio/references/sheet.png', description: 'full cast sheet' },
    ]);
    assert.equal(preferences.ingredientSelectedSheet, '/api/media-studio/references/sheet.png');

    const missingSelection = normalizeVideoPreferences({
        modelId: 'hivemind-video:ltx23-ic-ingredients-lora',
        ingredientSelections: [{ url: '/api/media-studio/references/front.png', description: '' }],
        ingredientSelectedSheet: '/api/media-studio/references/gone.png',
    });
    assert.equal(missingSelection.ingredientSelectedSheet, '');
});

test('ingredient sheet selection normalizes stitched, uploaded, and off states', async () => {
    const { normalizeSelectedVideoIngredientSheet } = await loadVideoStudioHelpers();
    const views = [{ url: '/api/media-studio/references/a.png', description: '' }];
    const sheets = [{ url: '/api/media-studio/references/sheet.png', description: '' }];

    // Legacy state without an explicit selection keeps saved views active.
    assert.equal(normalizeSelectedVideoIngredientSheet(undefined, views, sheets), 'stitched');
    assert.equal(normalizeSelectedVideoIngredientSheet(undefined, [], sheets), '');
    assert.equal(normalizeSelectedVideoIngredientSheet('stitched', views, sheets), 'stitched');
    assert.equal(normalizeSelectedVideoIngredientSheet('stitched', [], sheets), '');
    assert.equal(
        normalizeSelectedVideoIngredientSheet('/api/media-studio/references/sheet.png', views, sheets),
        '/api/media-studio/references/sheet.png',
    );
    assert.equal(normalizeSelectedVideoIngredientSheet('/api/media-studio/references/gone.png', views, sheets), '');
    // Tapping the selected sheet again turns ingredients off and stays off.
    assert.equal(normalizeSelectedVideoIngredientSheet('', views, sheets), '');
});

test('video Studio renders and forwards workflow-compatible LoRAs', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    const loraPanel = fs.readFileSync(path.join(__dirname, '../src/studios/image/LoraSection.jsx'), 'utf8');
    const hive = fs.readFileSync(path.join(__dirname, '../src/lib/hivemindStudio.js'), 'utf8');

    assert.match(source, /CivitaiDownloadDialog/, 'can open the Civitai download dialog');
    // Video workflows are not in workflow-registry.json, so the bridge cannot look up
    // their base models by id — the client must pass the catalog's compatibleBaseModels
    // alongside the WORKFLOW id (not the model id) or LoRA lookup 404s.
    assert.match(source, /listLoras\(model\.workflowId, model\.compatibleBaseModels\)/);
    assert.match(source, /loras: loraGenerationPayload\(/, 'forwards the LoRA payload to generation');
    assert.match(loraPanel, /Download LoRA/, 'the shared LoRA panel offers a download affordance');
    assert.match(source, /hivemind-context-updated/, 'reacts to Hivemind context changes');
    assert.match(source, /isHivemindStudioEnabled\(\)/, 'gated on studio mode');
    // The bridge side of the contract is a plain module and unchanged by the port.
    assert.match(hive, /supportsLoras: Boolean\(workflow\.supports_loras\)/);
    assert.match(hive, /loras: params\.loras/);
});

test('Explore supports direct video routing and narrow-width media navigation', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const app = fs.readFileSync(path.join(__dirname, '../src/app/App.jsx'), 'utf8');
    const shell = fs.readFileSync(path.join(__dirname, '../src/app/Shell.jsx'), 'utf8');

    // ?page=<studio> still deep-links, and an unknown page still falls back to image.
    assert.match(app, /get\('page'\)/);
    assert.match(app, /isKnownPage\(requested\) \? requested : 'image'/);
    // A failed lazy import must leave the router retryable — the committed page
    // (pageRef) may only advance AFTER the module resolves, never before.
    assert.match(app, /await loadWithRetry\([\s\S]{0,400}?pageRef\.current = target;/);
    assert.doesNotMatch(app, /pageRef\.current = target;[\s\S]{0,200}?await loadWithRetry\(/);
    // One immediate retry absorbs transient import failures (dist rebuilt
    // mid-session / stack restarting) before the router snaps back.
    assert.match(app, /async function loadWithRetry\(loader\) \{\s*try \{ return await loader\(\); \}\s*catch \{ return loader\(\); \}/);
    assert.match(app, /recoverFromStaleChunks\(error\)/);
    assert.match(app, /dynamically imported module/);
    // Narrow widths get a horizontally scrollable studio nav rather than a wrapped one.
    assert.match(shell, /overflow-x-auto[^"]*lg:hidden/);
});

// What the vanilla test could only grep for, the React split exposes as real
// functions: which images a generation actually conditions on.
test('the active ingredient set follows the selected sheet', async () => {
    const { activeIngredientSheetItems } = await loadVideoStudioHelpers();
    const model = { id: 'hivemind-video:ltx23-ic-ingredients-lora', supportsIngredientImages: true };
    const selections = [
        { url: '/api/media-studio/references/front.png', description: 'front' },
        { url: '/api/media-studio/references/side.png', description: 'side' },
    ];
    const sheets = [{ url: '/api/media-studio/references/sheet.png', description: 'cast sheet' }];

    // 'stitched' conditions on every saved view (the sheet is built from them).
    assert.deepEqual(
        activeIngredientSheetItems(model, { selectedSheet: 'stitched', selections, sheets }),
        selections,
    );
    // A finished sheet is used as-is, no stitching — it alone conditions the run.
    assert.deepEqual(
        activeIngredientSheetItems(model, { selectedSheet: sheets[0].url, selections, sheets }),
        [sheets[0]],
    );
    // Tapping the selected sheet again turns ingredients off entirely.
    assert.deepEqual(activeIngredientSheetItems(model, { selectedSheet: '', selections, sheets }), []);
    // A sheet that no longer exists must not silently fall back to the saved views.
    assert.deepEqual(
        activeIngredientSheetItems(model, { selectedSheet: '/api/media-studio/references/gone.png', selections, sheets }),
        [],
    );
    // No ingredients-capable model selected: nothing is conditioned on.
    assert.deepEqual(activeIngredientSheetItems(null, { selectedSheet: 'stitched', selections, sheets }), []);
});

test('the Ingredients workflow resolves from the selection, then the canonical LTX one', async () => {
    const { getIngredientsWorkflow } = await loadVideoStudioHelpers();
    const canonical = { id: 'hv:a', workflowId: 'ltx23-ic-ingredients-lora', supportsIngredientImages: true };
    const eros = { id: 'hv:b', workflowId: 'ltx23-eros-ic-ingredients-lora', supportsIngredientImages: true };
    const plain = { id: 'hv:c', workflowId: 'ltx23-regular-fp8', supportsIngredientImages: false };
    const catalog = [plain, canonical, eros];

    // The selected model wins when it supports ingredients...
    assert.equal(getIngredientsWorkflow({ modelId: 'hv:b' }, catalog), eros);
    // ...otherwise the canonical LTX Ingredients workflow is offered.
    assert.equal(getIngredientsWorkflow({ modelId: 'hv:c' }, catalog), canonical);
    // With no canonical entry, any ingredients-capable workflow will do.
    assert.equal(getIngredientsWorkflow({ modelId: 'hv:c' }, [plain, eros]), eros);
    assert.equal(getIngredientsWorkflow({ modelId: 'hv:c' }, [plain]), null);
});

test('video Studio exposes conditioning-only Ingredients reference views', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    const panel = fs.readFileSync(path.join(__dirname, '../src/studios/video/IngredientsPanel.jsx'), 'utf8');
    const hive = fs.readFileSync(path.join(__dirname, '../src/lib/hivemindStudio.js'), 'utf8');

    // The panel is conditioning-only and says so.
    assert.match(panel, /Ingredient references/);
    assert.match(panel, /Stitched sheet/);
    assert.match(panel, /Active in next generation/);
    assert.match(panel, /Tap again to turn ingredients off/);
    assert.match(panel, /Used as-is, no stitching/);
    assert.match(source, /LTX Ingredients/);
    assert.match(source, /normalizeSelectedVideoIngredientSheet/);
    // Ingredient state is shared across the regular and Eros workflows, never
    // keyed per model (the old per-model map caused them to diverge).
    assert.doesNotMatch(source, /ingredientSelectionsByModel/);
    // Selecting or uploading a finished sheet snaps the output aspect to the sheet's
    // geometry so it is not letterboxed into a tiny conditioning image, and
    // generation re-asserts the match even after a session restore.
    assert.match(source, /matchAspectToIngredientSheet/);
    assert.match(source, /previewHivemindIngredientSheet/);
    // Local workflows expose a Standard/High tier that reaches the backend lowercased.
    assert.match(source, /=== 'high' \? 'high' : 'standard'/);

    const mcp = fs.readFileSync(path.join(__dirname, '../../media-gateway/bin/media-studio-mcp.mjs'), 'utf8');
    // A single ingredient source is described as a whole reference sheet, not
    // as a lone positioned panel.
    assert.match(mcp, /entries\.length === 1/);
    assert.match(mcp, /The reference sheet shows the same character from multiple angles/);

    // The bridge contract is a plain module, unchanged by the port.
    assert.match(hive, /supportsIngredientImages: accepts\.includes\('ingredient_images'\)/);
    assert.match(hive, /ingredient_images: ingredientImages/);
    assert.match(hive, /resolution: String\(params\.resolution\)\.trim\(\)\.toLowerCase\(\)/);
    assert.match(hive, /workflow\.aspect_ratios/);
    assert.match(hive, /workflow\.default_duration_seconds/);
    // Ingredients must not suppress a separately-supplied start frame.
    assert.doesNotMatch(hive, /!ingredientImages\.length && imageReference/);
    assert.doesNotMatch(hive, /!ingredientImages\.length && imageBase64/);
    assert.match(hive, /\/api\/media-studio\/ingredients\/preview/);
});

test('expanded media view closes via X or backdrop without touching the setup', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    // The vanilla studios each hand-rolled a canvas overlay. React routes the
    // expanded view through the shared Modal, so the close paths are asserted once.
    const modal = fs.readFileSync(path.join(__dirname, '../src/ui/Modal.jsx'), 'utf8');
    assert.match(modal, /onClick=\{dismissable \? onClose : undefined\}/, 'backdrop click closes');
    assert.match(modal, /e\.key === 'Escape'\) onClose\?\.\(\)/, 'Escape closes');

    // The contract that mattered: a plain close only dismisses the view. Restoring
    // the shot's setup is a SEPARATE, explicitly-invoked action, so dismissing can
    // never clobber the user's in-progress prompt and settings.
    const viewer = fs.readFileSync(path.join(__dirname, '../src/studios/image/GalleryAndViewer.jsx'), 'utf8');
    assert.match(viewer, /export function ViewerModal\(\{[^}]*\bonClose\b[^}]*\bonBackToSetup\b/s,
        'dismiss and restore-setup are distinct props, not one handler');
    assert.match(viewer, /<Modal open onClose=\{onClose\}/, 'the X and backdrop route to the plain dismiss');
});

test('video preference restoration validates advanced values against the current model schema', async () => {
    const { getRestoredAdvancedVideoValues } = await loadVideoStudioHelpers();
    const model = {
        inputs: {
            generate_audio: { type: 'boolean', default: true },
            movement: { type: 'string', enum: ['small', 'large'], default: 'small' },
            guidance: { type: 'float', minValue: 1, maxValue: 5, default: 2 },
            steps: { type: 'int', minValue: 1, maxValue: 20, default: 8 },
        },
    };

    assert.deepEqual(getRestoredAdvancedVideoValues(model, {
        generate_audio: false,
        movement: 'removed-option',
        guidance: 99,
        steps: 6.7,
        stale_field: 'ignored',
    }), {
        generate_audio: false,
        movement: 'small',
        guidance: 5,
        steps: 7,
    });
});

test('video advanced inputs include supported model options and preserve falsey defaults', async () => {
    const { getAdvancedVideoInputs, getDefaultAdvancedVideoValues, getAdvancedVideoPayload } = await loadVideoStudioHelpers();
    const model = {
        inputs: {
            prompt: { type: 'string', default: '' },
            duration: { type: 'int', default: 5 },
            generate_audio: { type: 'boolean', title: 'Generate Audio', default: false },
            movement_amplitude: { type: 'string', enum: ['small', 'large'], default: 'small' },
            variety: { type: 'int', minValue: 0, maxValue: 100, default: 0 },
            images_list: { type: 'array' },
        },
    };

    assert.deepEqual(
        getAdvancedVideoInputs(model).map((input) => input.name),
        ['generate_audio', 'movement_amplitude', 'variety'],
    );
    assert.deepEqual(getDefaultAdvancedVideoValues(model), {
        generate_audio: false,
        movement_amplitude: 'small',
        variety: 0,
    });
    assert.deepEqual(getAdvancedVideoPayload(model, {
        generate_audio: true,
        movement_amplitude: 'large',
        variety: 25,
        ignored: 'nope',
    }), {
        generate_audio: true,
        movement_amplitude: 'large',
        variety: 25,
    });
});

test('Muapi copies only model-declared video inputs, including false values', async () => {
    const { applyDeclaredModelInputs } = await import('../src/lib/muapi.js');
    const payload = applyDeclaredModelInputs(
        { prompt: 'shot' },
        { prompt: 'shot', generate_audio: false, camera_fixed: true, ignored: 'nope' },
        { inputs: { prompt: {}, generate_audio: {}, camera_fixed: {} } },
    );

    assert.deepEqual(payload, { prompt: 'shot', generate_audio: false, camera_fixed: true });
});
