const test = require('node:test');
const assert = require('node:assert/strict');
const { loadStudioLogic } = require('./helpers/loadStudioLogic.js');

async function loadVideoStudioHelpers() {
    return loadStudioLogic('../src/studios/video/videoLogic.jsx');
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
            pingWhenComplete: true,
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
                    // Muted LoRAs stay in the list with their weight across reloads.
                    enabled: true,
                }],
            },
            ingredientSelections: [{
                url: '/api/media-studio/references/front.png',
                description: 'front view',
            }],
            ingredientSheets: [],
            ingredientSelectedSheet: 'stitched',
            // pingWhenComplete is deliberately absent: the completion ping is a
            // shared all-studio setting (lib/completionPing.js), so a legacy
            // value in saved video preferences is dropped here, not round-tripped.
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
    const loraSection = fs.readFileSync(path.join(__dirname, '../src/studios/image/LoraSection.jsx'), 'utf8');
    const hive = fs.readFileSync(path.join(__dirname, '../src/lib/hivemindStudio.js'), 'utf8');

    assert.match(source, /CivitaiDownloadDialog/);
    // Video workflows do NOT live in workflow-registry.json, so the bridge cannot
    // resolve their base models by id alone — the catalog's compatibleBaseModels
    // must ride along or /local-ai/loras/<id> 404s "Unknown local workflow".
    assert.match(source, /localAI\.listLoras\(model\.workflowId, model\.compatibleBaseModels\)/);
    assert.match(source, /loras: loraGenerationPayload\(currentVideoLoraSelection\(\)\)/);
    assert.match(source, /hivemind-context-updated/);
    assert.match(source, /isHivemindStudioEnabled\(\)/);
    // Video reuses the image studio's LoRA panel rather than a second copy.
    assert.match(source, /<LoraSection/);
    assert.match(loraSection, /Download LoRA/);
    assert.match(hive, /supportsLoras: Boolean\(workflow\.supports_loras\)/);
    assert.match(hive, /loras: params\.loras/);
});

test('Explore supports direct video routing and narrow-width media navigation', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const app = fs.readFileSync(path.join(__dirname, '../src/app/App.jsx'), 'utf8');
    const shell = fs.readFileSync(path.join(__dirname, '../src/app/Shell.jsx'), 'utf8');

    // ?page=<studio> routes straight in; anything unknown falls back to image.
    assert.match(app, /get\('page'\)/);
    assert.match(app, /isKnownPage\(requested\) \? requested : 'image'/);
    // A failed lazy import must leave the router retryable — the page only
    // commits after a successful load — and trigger stale-chunk recovery.
    assert.match(app, /recoverFromStaleChunks\(error\);\s*return;/);
    assert.match(app, /await loadWithRetry\([\s\S]*?pageRef\.current = target;/);
    // One immediate retry absorbs transient import failures (dist rebuilt
    // mid-session / stack restarting) before the router snaps back.
    assert.match(app, /async function loadWithRetry\(loader\) \{\s*try \{ return await loader\(\); \}\s*catch \{ return loader\(\); \}/);
    assert.match(app, /dynamically imported module/);
    // Superseded navigations never commit over a newer one.
    assert.match(app, /if \(token !== navTokenRef\.current\) return;/);
    assert.match(shell, /aria-label="Studio navigation"/);
    assert.match(shell, /lg:hidden/);
});

test('video Studio exposes conditioning-only Ingredients reference views', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    const panel = fs.readFileSync(path.join(__dirname, '../src/studios/video/IngredientsPanel.jsx'), 'utf8');
    const logic = fs.readFileSync(path.join(__dirname, '../src/studios/video/videoLogic.jsx'), 'utf8');
    const hive = fs.readFileSync(path.join(__dirname, '../src/lib/hivemindStudio.js'), 'utf8');

    assert.match(panel, /Ingredient references/);
    assert.match(source, /LTX Ingredients/);
    assert.match(logic, /workflowId === 'ltx23-ic-ingredients-lora'/);
    assert.match(panel, /Stitched sheet/);
    assert.match(panel, /Active in next generation/);
    // Several reference views are picked in one go.
    assert.match(panel, /multiple/);
    // One shared selection across the regular and Eros Ingredients workflows —
    // never a per-model map, which used to strand references on a model switch.
    assert.match(source, /sharedIngredientSelections/);
    assert.match(source, /sharedIngredientSheets/);
    assert.doesNotMatch(source, /ingredientSelectionsByModel/);
    assert.match(source, /normalizeSelectedVideoIngredientSheet/);
    assert.match(panel, /Tap again to turn ingredients off/);
    assert.match(panel, /Used as-is, no stitching/);
    assert.match(source, /selectedIngredientSheet = 'stitched'/);
    // Selecting or uploading a finished sheet snaps the output aspect to the
    // sheet's geometry so it is not letterboxed into a tiny conditioning image,
    // and generation re-asserts the match even after a session restore.
    assert.equal(source.match(/void matchAspectToIngredientSheet\(s\.selectedIngredientSheet\)/g).length, 2);
    assert.match(source, /await matchAspectToIngredientSheet\(s\.selectedIngredientSheet\)/);
    // The active sheet (stitched or uploaded) is what reaches the bridge.
    assert.match(source, /ingredientImages: activeItems\.map/);
    assert.match(source, /previewHivemindIngredientSheet/);
    // Local workflows expose a Standard/High resolution tier that reaches the
    // backend as a lowercase resolution field.
    assert.match(source, /resolution: String\(setup\.resolution \|\| ''\)\.toLowerCase\(\) === 'high' \? 'high' : 'standard'/);
    assert.match(logic, /Number\(model\?\.inputs\?\.duration\?\.default\)/);

    const mcp = fs.readFileSync(path.join(__dirname, '../../media-gateway/bin/media-studio-mcp.mjs'), 'utf8');
    // A single ingredient source is described as a whole reference sheet, not
    // as a lone positioned panel.
    assert.match(mcp, /entries\.length === 1/);
    assert.match(mcp, /The reference sheet shows the same character from multiple angles/);
    // Extending a video wins over a start frame; otherwise the uploaded frame
    // is the conditioning image, never a second ingredient.
    assert.match(source, /else if \(setup\.imageUrl\) \{ localParams\.image = setup\.imageUrl; \}/);
    assert.match(hive, /supportsIngredientImages: accepts\.includes\('ingredient_images'\)/);
    assert.match(hive, /ingredient_images: ingredientImages/);
    assert.match(hive, /resolution: String\(params\.resolution\)\.trim\(\)\.toLowerCase\(\)/);
    assert.match(hive, /workflow\.aspect_ratios/);
    assert.match(hive, /workflow\.default_duration_seconds/);
    assert.doesNotMatch(hive, /!ingredientImages\.length && imageReference/);
    assert.doesNotMatch(hive, /!ingredientImages\.length && imageBase64/);
    assert.match(hive, /\/api\/media-studio\/ingredients\/preview/);
});

test('expanded media view closes without touching the setup', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '../src/studios/ImageStudio.jsx'), 'utf8');
    const viewer = fs.readFileSync(path.join(__dirname, '../src/studios/image/GalleryAndViewer.jsx'), 'utf8');

    // The viewer offers two distinct exits, and they must stay distinct.
    assert.match(viewer, /ViewerModal\(\{ url, entry, onClose, onBackToSetup/);
    assert.match(viewer, /<Modal open onClose=\{onClose\}/, 'X and backdrop both route through onClose');

    // The plain close dismisses the view only — it must not restore an old
    // context or clear the user's in-progress prompt and settings.
    const plainClose = source.match(/onClose=\{\(\) => \{ s\.viewerUrl = null;[\s\S]{0,160}?\}\}/)[0];
    assert.doesNotMatch(plainClose, /restore|getViewed|clearViewed/, 'plain close leaves the setup untouched');

    // Back to setup is the one that deliberately restores the viewed context.
    const backToSetup = source.match(/onBackToSetup=\{\(\) => \{[\s\S]{0,260}?\}\}/)[0];
    assert.match(backToSetup, /getViewed\(\)/);
    assert.match(backToSetup, /restoreImageContext\(viewed\)/);
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
