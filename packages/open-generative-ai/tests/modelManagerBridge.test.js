// Deliberately textual: "no iframe, no gateway surface entry" is an absence
// claim, and the surface it replaced would still render.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const hostedServer = fs.readFileSync(path.join(__dirname, '../hosted-server.js'), 'utf8');
const shim = fs.readFileSync(path.join(__dirname, '../public/hosted-local-ai.js'), 'utf8');
const modelsView = fs.readFileSync(path.join(__dirname, '../src/hub/views/ModelsView.jsx'), 'utf8');
const hubData = fs.readFileSync(path.join(__dirname, '../src/hub/hubData.js'), 'utf8');

// The gateway's own /api/library ships the full Civitai sidecar and the absolute
// path for every installed file — 56 MB for ~150 models. Both are dropped here, so
// the browser gets a ~150 KB payload and never learns the filesystem layout.
test('the installed library is slimmed before it reaches the browser', () => {
    assert.match(hostedServer, /pathname === '\/local-ai\/library'/);
    assert.match(hostedServer, /function slimLibraryAsset/);
    // Explicitly built field by field: a spread would carry `metadata` and `path`
    // straight through the moment the gateway adds another field.
    assert.doesNotMatch(hostedServer.slice(hostedServer.indexOf('function slimLibraryAsset')), /^\s*\.\.\.item,/m);
    assert.match(hostedServer, /sizeBytes: Number\(item\.size_bytes \|\| 0\)/);
});

test('descriptions are stripped of the markup Civitai stores them as', () => {
    assert.match(hostedServer, /function plainText/);
    assert.match(hostedServer, /description: plainText\(item\.description\)/);
});

test('remote card art is fetched by the bridge, host-checked, and bounded', () => {
    // The browser must not open connections to Civitai itself.
    assert.match(hostedServer, /function isCivitaiHost/);
    assert.match(hostedServer, /preview host not allowed/);
    assert.match(hostedServer, /allowHost: isCivitaiHost/);
    // Civitai's media CDN 301s to its storage host; a fetch that does not follow
    // that renders every remote preview as "not found".
    assert.match(hostedServer, /maxRedirects: 3/);
    assert.match(hostedServer, /PREVIEW_MAX_BYTES = 12 \* 1024 \* 1024/);
    assert.match(hostedServer, /maxBytes: PREVIEW_MAX_BYTES/);
    // A card-sized transform: the original of a video preview is ~85 MB.
    assert.match(hostedServer, /PREVIEW_TRANSFORM = 'width=450'/);
    assert.match(hostedServer, /PREVIEW_STILL_TRANSFORM = 'anim=false,width=450'/);
    // Local previews stay behind the gateway's own path allowlist.
    assert.match(hostedServer, /if \(!target\.startsWith\('\/'\) \|\| target\.includes\('\.\.'\)\)/);
});

test('video card art ships as a still plus an on-demand motion path', () => {
    assert.match(hostedServer, /motionPath: kindOfPreview === 'video' \? previewRoute : ''/);
    assert.match(hostedServer, /previewPath = `\$\{previewRoute\}\?anim=0`/);
    assert.match(shim, /motionUrl: asset\.motionPath \? `\$\{apiBase\}\$\{asset\.motionPath\}` : ''/);
});

test('Civitai search results carry installed ids only, not the installed files', () => {
    assert.match(hostedServer, /pathname === '\/local-ai\/civitai-search'/);
    assert.match(hostedServer, /installedVersionIds:/);
    assert.match(hostedServer, /installedFileIds:/);
    // The download records themselves (filenames, folders) stay server-side.
    assert.doesNotMatch(hostedServer, /installed: data\.installed/);
    // Only known parameters are forwarded upstream.
    assert.match(hostedServer, /for \(const key of CIVITAI_SEARCH_PARAMS\)/);
});

test('a result is downloadable through the existing URL flow, so there is one download path', () => {
    // The card's own url is version-pinned, which is exactly what the gateway's
    // civitai-download route resolves — no second {versionId, fileId} shape.
    assert.match(hostedServer, /https:\/\/civitai\.com\/models\/\$\{encodeURIComponent\(String\(item\.id\)\)\}/);
    assert.match(hostedServer, /modelVersionId=\$\{encodeURIComponent\(String\(version\.id\)\)\}/);
});

test('the models surface is native: no iframe, no gateway surface entry', () => {
    assert.doesNotMatch(modelsView, /ToolSurface/);
    assert.match(modelsView, /localAI\.listLibrary/);
    // The retired iframe surface must not come back through the fallback either.
    assert.doesNotMatch(hubData, /models: \{ gateway_path/);
    assert.doesNotMatch(hubData, /\['canvas', 'models'\]/);
});

// ── one manager ────────────────────────────────────────────────────────────
// Installing a model used to be three doors: this page, a Settings tab holding
// a second copy of the same manager, and the Canvas editor's own button into an
// external LoRA UI in a new tab. These assert the two that were closed.

const settingsView = fs.readFileSync(path.join(__dirname, '../src/hub/views/SettingsView.jsx'), 'utf8');
const localModelManager = fs.readFileSync(path.join(__dirname, '../src/dialogs/LocalModelManager.jsx'), 'utf8');
const canvasMenu = fs.readFileSync(
    path.join(__dirname, '../../comfyui-mobile/src/components/AppMenu/MenuModelManagerSection.tsx'), 'utf8');

test('the model manager is mounted on the Models page and nowhere else', () => {
    assert.match(modelsView, /import \{ LocalModelManager \}/);
    assert.match(modelsView, /value: 'engine'/);
    assert.doesNotMatch(settingsView, /LocalModelManager/);
    // Settings still SAYS where they live — a removed tab must not read as a
    // removed feature.
    assert.match(settingsView, /page: 'models'/);
});

test('a store card says what the model is for and whether this machine can run it', () => {
    assert.match(localModelManager, /from '\.\.\/lib\/modelStore\.js'/);
    assert.match(localModelManager, /<FitLine fit=\{fit\} \/>/);
    assert.match(localModelManager, /modelPurpose\(model\)/);
    assert.match(localModelManager, /capabilityBadges\(matrix, model\)/);
    // "Try it" hands the model AND a starter prompt to the studio through the
    // existing open-in-studio handoff.
    assert.match(localModelManager, /openModelInStudio\(model, \{ prompt: starterPromptFor\(model\) \}\)/);
});

test('the Canvas editor asks the shell for the Models page instead of a second tab', () => {
    assert.match(canvasMenu, /requestStudioPage\('models'\)/);
    // The external UI stays as the standalone fallback, not as the embedded path.
    assert.match(canvasMenu, /if \(requestStudioPage\('models'\)\) return;\s*\n\s+openLoraManagerUiInNewTab\(\);/);
    // The shell accepts that message only from the canvas frame, at its origin,
    // and only for a page on an allow-list.
    assert.match(hubData, /CANVAS_NAVIGABLE_PAGES = new Set\(\['models', 'history'\]\)/);
    assert.match(hubData, /event\.data\?\.type !== 'hivemind-navigate'/);
    assert.match(hubData, /event\.origin !== canvasFrameOrigin\(\)/);
});
