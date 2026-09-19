// The one rule this file exists to keep: nothing a person TYPED ends up in
// plaintext browser storage.
//
// Prompts, negative prompts and the sentences written about a reference picture
// live in the client-encrypted composer blob (AGENTS.md, docs/E2E_ENCRYPTION_DESIGN.md).
// The studios also keep a plaintext settings blob in localStorage, because that
// is the only store that can be read synchronously at mount — so the model and
// the frame come back before the vault hydrates. The line between the two was
// enforced by hand-written strip code and by comments, which is exactly how the
// video studio came to persist every reference description ("my daughter at the
// beach") in the clear, where it survives a vault lock.
//
// So each studio's persisted blob is built here from a fixture whose every
// string is a sentence, and asserted to carry none of it. The allow-list below
// is the reviewed statement of which fields are permitted to be text at all:
// they are ids and enums (a model id, an aspect ratio, a sampler), never prose.
// A new free-text field added to a normalizer fails this test until it is either
// moved into the composer or argued onto the list.
const test = require('node:test');
const assert = require('node:assert/strict');

// A sentence nobody could mistake for a model id.
const TYPED = 'my daughter at the beach in a red swimsuit';

// Fields whose value is an identifier or an enum, not prose. Anything here may
// keep its string; everything else in a persisted blob is poisoned and must not
// come back out.
const ID_LIKE = new Set([
  'modelId', 'localModelId', 'workflowId', 'id', 'name', 'displayName',
  // Which account a cloud model runs on. Chosen from the "Run on" menu, never
  // typed, and normalized exactly as modelId is.
  'providerId',
  'aspectRatio', 'resolution', 'quality', 'mode', 'inputMode', 'denoise',
  'sampler', 'scheduler', 'style', 'effectName', 'restylePresetId',
  'videoTask', 'headSwapBackend', 'localRuntimeMode', 'rentedMachineId',
  'coupleDirection', 'couplePair', 'characterSheetPreset',
  // Opaque same-origin pointers to sealed media. They name a file, they do not
  // describe one — and the normalizers already refuse a foreign origin.
  'url', 'previewUrl', 'motionContextUrl', 'ingredientSelectedSheet',
]);

// Bags whose KEYS are not ours — a model's advanced inputs, a workflow's LoRA
// list. The sweep cannot poison them by field name because the names come from
// whatever workflow is loaded, so they have their own rule instead: an input
// named like prose never reaches the blob at all, asserted on its own below.
const OPAQUE = new Set(['advancedValues']);

/** Replace every string in a blob with the sentence, except the id-like fields,
 *  which keep the valid value they were seeded with. Applied to a normalizer's
 *  OWN output, so a field added tomorrow is poisoned without anyone editing
 *  this file. */
function poison(value, key = '') {
  if (OPAQUE.has(key)) return value;
  if (typeof value === 'string') return ID_LIKE.has(key) ? value : TYPED;
  if (Array.isArray(value)) return value.map((entry) => poison(entry, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, poison(entry, name)]));
  }
  return value;
}

function assertNoTypedText(label, blob) {
  const body = JSON.stringify(blob);
  assert.equal(
    body.includes(TYPED),
    false,
    `${label} persisted typed text to plaintext storage: ${body}`,
  );
}

const REFERENCE = '/api/media-studio/references/front.png';
const SHEET = '/api/media-studio/references/sheet.png';

test('the video settings blob carries the reference selection and none of the words', async () => {
  const { normalizeVideoPreferences } = await import('../src/lib/videoPreferences.js');

  const saved = normalizeVideoPreferences({
    modelId: 'minimax-h3',
    aspectRatio: '16:9',
    ingredientSelections: [{ url: REFERENCE, description: TYPED }],
    ingredientSheets: [{ url: SHEET, description: TYPED }],
    ingredientSelectedSheet: 'stitched',
    // Prompt text that has never belonged here, asserted anyway: an extra field
    // in the input must not become a field in the output.
    prompt: TYPED,
    negativePrompt: TYPED,
  });

  assertNoTypedText('video', saved);
  // The selection itself survives — this is a strip, not a deletion.
  assert.deepEqual(saved.ingredientSelections, [{ url: REFERENCE }]);
  assert.deepEqual(saved.ingredientSheets, [{ url: SHEET }]);
  assert.equal(saved.ingredientSelectedSheet, 'stitched');
  assert.equal('description' in saved.ingredientSelections[0], false);
});

test('every string in the video blob is poisoned and none of it survives', async () => {
  const { normalizeVideoPreferences } = await import('../src/lib/videoPreferences.js');

  const shape = normalizeVideoPreferences({
    modelId: 'minimax-h3',
    aspectRatio: '16:9',
    resolution: '1080p',
    quality: 'high',
    mode: 'std',
    denoise: 'light',
    effectName: 'zoom-in',
    videoTask: 'generate',
    headSwapBackend: 'bfs',
    rentedMachineId: 'rental-1',
    motionContextUrl: '/api/media-studio/outputs/clip.mp4',
    advancedValues: { shift: 'auto', steps: 30 },
    loraSelections: { 'wan-2.2': [{ id: 'lora-1', name: 'a.safetensors', strength: 0.8 }] },
    ingredientSelections: [{ url: REFERENCE, description: 'front view' }],
    ingredientSheets: [{ url: SHEET, description: 'the sheet' }],
    ingredientSelectedSheet: SHEET,
  });
  assertNoTypedText('video (round trip)', normalizeVideoPreferences(poison(shape)));
});

test('an advanced input that takes a sentence keeps its control and loses its words', async () => {
  const { normalizeVideoPreferences, PROMPT_LIKE_INPUT_NAME } = await import('../src/lib/videoPreferences.js');

  const saved = normalizeVideoPreferences({
    modelId: 'minimax-h3',
    advancedValues: {
      // Knobs: a number, an enum, a switch. These are what the blob is for.
      shift: 'auto',
      steps: 30,
      enhance: true,
      // Free text a workflow happens to declare. Not written down.
      negative_prompt: TYPED,
      shot_description: TYPED,
      subtitle_text: TYPED,
    },
  });

  assertNoTypedText('video advanced inputs', saved);
  assert.deepEqual(saved.advancedValues, { shift: 'auto', steps: 30, enhance: true });
  assert.equal(PROMPT_LIKE_INPUT_NAME.test('negative_prompt'), true);
  assert.equal(PROMPT_LIKE_INPUT_NAME.test('shift'), false);
});

test('the video descriptions go to the encrypted composer instead, keyed by reference', async () => {
  const {
    videoIngredientDescriptions, withVideoIngredientDescriptions,
  } = await import('../src/lib/videoPreferences.js');

  const live = [{ url: REFERENCE, description: TYPED }, { url: SHEET, description: '' }];
  const descriptions = videoIngredientDescriptions(live);
  assert.deepEqual(descriptions, { [REFERENCE]: TYPED });
  // A reference nobody wrote about is not written down at all.
  assert.equal(SHEET in descriptions, false);

  // And a reload puts them back on the selection localStorage restored.
  const restored = withVideoIngredientDescriptions([{ url: REFERENCE }, { url: SHEET }], descriptions);
  assert.deepEqual(restored, [{ url: REFERENCE, description: TYPED }, { url: SHEET }]);
});

test('the image settings blob carries no negative prompt, top level or per model', async () => {
  const { normalizeImagePreferences, persistedImageSettings } = await import('../src/studios/image/imagePrefs.js');

  const saved = persistedImageSettings(normalizeImagePreferences({
    modelId: 'flux-2-pro',
    aspectRatio: '16:9',
    negativePrompt: TYPED,
    modelSettings: { 'local:krea2': { sampler: 'euler', scheduler: 'simple', negativePrompt: TYPED } },
  }));

  assertNoTypedText('image', saved);
  assert.equal('negativePrompt' in saved, false);
  assert.equal('negativePrompt' in saved.modelSettings['local:krea2'], false);
  // The tuning survives the strip.
  assert.equal(saved.modelSettings['local:krea2'].sampler, 'euler');
  assert.equal(saved.aspectRatio, '16:9');
});

test('every string in the image blob is poisoned and none of it survives', async () => {
  const { normalizeImagePreferences, persistedImageSettings } = await import('../src/studios/image/imagePrefs.js');

  const shape = normalizeImagePreferences({
    modelId: 'flux-2-pro',
    localModelId: 'krea2',
    aspectRatio: '16:9',
    resolution: '1024x1024',
    sampler: 'euler',
    scheduler: 'simple',
    style: 'Cinematic',
    localRuntimeMode: 'one-off',
    rentedMachineId: 'rental-1',
    modelSettings: { 'local:krea2': { sampler: 'euler', scheduler: 'simple', aspectRatio: '1:1' } },
    loraSelections: { 'local:krea2': [{ id: 'lora-1', name: 'a.safetensors', strength: 0.8 }] },
  });
  assertNoTypedText('image (round trip)', persistedImageSettings(normalizeImagePreferences(poison(shape))));
});

test('the lip-sync settings blob is a selection and nothing else', async () => {
  const { normalizeLipSyncPreferences } = await import('../src/lib/studioPreferences.js');

  const saved = normalizeLipSyncPreferences({
    modelId: 'latentsync',
    inputMode: 'video',
    resolution: '720p',
    prompt: TYPED,
    script: TYPED,
  });
  assertNoTypedText('lipsync', saved);
  assertNoTypedText('lipsync (round trip)', normalizeLipSyncPreferences(poison(saved)));
  assert.equal(saved.modelId, 'latentsync');
});

test('the preferences document keeps filter SHAPES and drops the boxes people type in', async () => {
  const { normalizePrefs } = await import('../src/lib/prefs.js');

  const doc = normalizePrefs({
    lang: 'en',
    // The Inspo creator box and the Discover search box are session-only: the
    // view holds them in React state while the tab is open, and neither reaches
    // the document.
    inspoFilters: { sort: 'Most Reactions', period: 'Week', username: TYPED },
    discoverFilters: { type: 'LORA', query: TYPED },
  });

  assertNoTypedText('prefs', doc);
  assert.deepEqual(doc.inspoFilters, { sort: 'Most Reactions', period: 'Week' });
  assert.deepEqual(doc.discoverFilters, { type: 'LORA' });
});
