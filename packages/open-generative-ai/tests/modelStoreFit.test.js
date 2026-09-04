// "Will this run on MY machine?" — the one line a store card has to get right.
//
// The fit line is the only place in the app that tells someone their computer
// is not enough, so two things are tested here: that it changes with the
// machine (the same model reads differently on a 64 GB Mac and a 16 GB one),
// and that a "no" is never a dead end — a blocked verdict always carries the
// action that leads somewhere.
import assert from 'node:assert/strict';
import test from 'node:test';

const load = () => import('../src/lib/modelStore.js');

const mac = (ramGB) => ({
  platform: 'Darwin',
  arch: 'arm64',
  ram_gb: ramGB,
  accelerator: { class: 'apple-silicon', label: 'Apple M5 Max', unified_memory: true, vram_gb: ramGB },
  models_root: '/Users/owner/comfy/ComfyUI',
  free_disk_gb: 900,
});

const nvidia = (vramGB, { free = 900 } = {}) => ({
  platform: 'Linux',
  arch: 'x86_64',
  ram_gb: 64,
  accelerator: { class: 'nvidia', label: 'NVIDIA GeForce RTX 4090', unified_memory: false, vram_gb: vramGB },
  models_root: '/opt/comfy',
  free_disk_gb: free,
});

const cpuOnly = () => ({
  platform: 'Linux',
  arch: 'x86_64',
  ram_gb: 8,
  accelerator: { class: 'cpu', label: 'Linux x86_64', unified_memory: false, vram_gb: null },
  models_root: '/opt/comfy',
  free_disk_gb: 900,
});

const Z_IMAGE_TURBO = { id: 'z-image-turbo', name: 'Z-Image Turbo', type: 'z-image', provider: 'sdcpp', sizeGB: 3.4, tags: ['turbo', 'fast'], featured: true };
const IDEOGRAM_4 = { id: 'ideogram4-fp8', name: 'Ideogram 4', type: 'ideogram4', provider: 'ideogram4', sizeGB: 18, tags: ['typography'], featured: true };

test('the same model reads differently on different machines', async () => {
  const { modelFit } = await load();

  // 36 GB of unified memory: 18 GB of weights is 21.6 GB of working set against
  // a 27 GB budget — it runs, and the machine will feel it.
  assert.equal(modelFit(IDEOGRAM_4, mac(36)).tone, 'warn');
  assert.match(modelFit(IDEOGRAM_4, mac(36)).text, /your 36 GB Mac/);

  // 64 GB: room to spare.
  const roomy = modelFit(IDEOGRAM_4, mac(64));
  assert.equal(roomy.tone, 'ok');
  assert.equal(roomy.text, 'Fits your 64 GB Mac.');

  // 16 GB: not this one.
  const small = modelFit(IDEOGRAM_4, mac(16));
  assert.equal(small.tone, 'blocked');
  assert.match(small.text, /Too big for your 16 GB Mac/);

  // …and the small fast model is the one that fits there.
  assert.equal(modelFit(Z_IMAGE_TURBO, mac(16)).tone, 'ok');
});

test('a dedicated card is named and budgeted as itself, not as system RAM', async () => {
  const { modelFit, machineLabel, usableMemoryGB } = await load();

  assert.equal(machineLabel(nvidia(24)), 'your 24 GB GeForce RTX 4090');
  // 24 GB of VRAM, not the 64 GB of host memory sitting behind it.
  assert.equal(Math.round(usableMemoryGB(nvidia(24))), 22);
  assert.equal(modelFit(Z_IMAGE_TURBO, nvidia(24)).tone, 'ok');
  assert.equal(modelFit(IDEOGRAM_4, nvidia(8)).tone, 'blocked');
});

test('every "no" carries somewhere to go', async () => {
  const { modelFit } = await load();

  const tooBig = modelFit(IDEOGRAM_4, mac(16));
  assert.equal(tooBig.tone, 'blocked');
  assert.deepEqual(tooBig.action, { label: 'Rent a GPU', page: 'machines' });

  // Out of disk is the one verdict that also makes the download pointless, so
  // it blocks install and points at the folder setting instead.
  const noRoom = modelFit(IDEOGRAM_4, nvidia(24, { free: 4 }));
  assert.equal(noRoom.tone, 'blocked');
  assert.equal(noRoom.blocksInstall, true);
  assert.equal(noRoom.action.page, 'settings');
  assert.match(noRoom.text, /18\.0 GB/);

  // A machine with room does not block anything.
  assert.equal(modelFit(IDEOGRAM_4, nvidia(24)).blocksInstall, undefined);

  // And a model already on disk is never told the disk is too full to fetch
  // the weights that are already sitting on it.
  const alreadyHere = modelFit({ ...IDEOGRAM_4, state: 'downloaded' }, nvidia(24, { free: 4 }));
  assert.equal(alreadyHere.tone, 'warn', 'it is judged on memory, like any installed model');
  assert.doesNotMatch(alreadyHere.text, /disk/);
  assert.equal(alreadyHere.blocksInstall, undefined);
});

test('no hardware answer yet is "still checking", never a refusal', async () => {
  const { modelFit } = await load();

  assert.equal(modelFit(Z_IMAGE_TURBO, null).tone, 'unknown');
  assert.equal(modelFit(Z_IMAGE_TURBO, { pending: true }).tone, 'unknown');
  // A model with no download size is a server someone else runs.
  assert.equal(modelFit({ id: 'wan2gp:flux-dev', provider: 'wan2gp' }, mac(36)).tone, 'unknown');
  // A machine that did not report its memory says so instead of guessing.
  assert.match(
    modelFit(Z_IMAGE_TURBO, { accelerator: { class: 'cpu' }, ram_gb: null, free_disk_gb: 900 }).text,
    /has not reported its memory/,
  );
});

test('a CPU-only box is told the truth about small models and big ones', async () => {
  const { modelFit } = await load();

  const small = modelFit({ id: 'dreamshaper-8', sizeGB: 2.1, tags: [] }, cpuOnly());
  assert.equal(small.tone, 'ok');
  assert.match(small.text, /slow without a GPU/);

  const big = modelFit(IDEOGRAM_4, cpuOnly());
  assert.equal(big.tone, 'blocked');
  assert.equal(big.action.page, 'machines');
});

test('Z-Image Turbo is what an empty Apple Silicon machine is pointed at', async () => {
  const { recommendedModelId } = await load();
  const catalog = [IDEOGRAM_4, Z_IMAGE_TURBO, { id: 'stable-diffusion-xl-base', sizeGB: 6.9, tags: [] }];

  assert.equal(recommendedModelId(catalog, mac(36)), 'z-image-turbo');
  // Already installed: recommend something that is not already there.
  assert.notEqual(
    recommendedModelId(catalog.map((m) => (m.id === 'z-image-turbo' ? { ...m, state: 'downloaded' } : m)), mac(36)),
    'z-image-turbo',
  );
  // Nothing left to install recommends nothing at all.
  assert.equal(recommendedModelId(catalog.map((m) => ({ ...m, state: 'downloaded' })), mac(36)), '');
  // A remote server is not something this machine can install.
  assert.equal(recommendedModelId([{ id: 'wan2gp:flux-dev', provider: 'wan2gp' }], mac(36)), '');
});

test('badges come from the server matrix, and only for a good rating', async () => {
  const { capabilityBadges } = await load();
  const matrix = {
    features: [
      { id: 'sprite_source', label: 'Draw a game sprite', rules: [{ match: 'model:anything-v5', rating: 'good', reason: '', evidence: 'reasoned' }] },
      { id: 'story_location', label: 'Draw an empty location plate', rules: [{ match: 'model:anything-v5', rating: 'workable', reason: '', evidence: 'reasoned' }] },
    ],
  };

  assert.deepEqual(capabilityBadges(matrix, { id: 'anything-v5' }), ['Draw a game sprite']);
  assert.deepEqual(capabilityBadges(matrix, { id: 'z-image-turbo' }), []);
  assert.deepEqual(capabilityBadges(null, { id: 'anything-v5' }), []);
});

test('every model gets a purpose line and a starter prompt to try it with', async () => {
  const { modelPurpose, starterPromptFor } = await load();

  assert.match(modelPurpose(IDEOGRAM_4), /words in the picture/);
  assert.match(modelPurpose({ type: 'video', tags: [] }), /clip/);
  assert.equal(modelPurpose({ tags: [] }), 'General image generation.');

  for (const model of [IDEOGRAM_4, Z_IMAGE_TURBO, { tags: ['anime'] }, { tags: ['photorealistic'] }]) {
    const prompt = starterPromptFor(model);
    assert.ok(prompt.length > 20 && prompt.length < 220, 'a starter is a sentence, not an essay');
  }
});
