// One "where does this run" vocabulary, one ladder, and no registry ids in it.
//
// The studio used to ask that question four ways: a Local / API / Rented
// segmented control in Image and Video, sections named This machine /
// HivemindOS / Your accounts in the text producer, a provider caption with no
// notion of place in Story and Sprite, and a lane list in Restore. This pins
// the replacement: three places grouped by BILL, a rental that is a property of
// This Mac rather than a mode, and an Automatic default that says why.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = {
  __HIVEMIND_STUDIO__: 1,
  location: { search: '' },
  localAI: { isElectron: true, isHosted: true, listModels: async () => [], wan2gp: { listModels: async () => [] } },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
};

const read = (rel) => fs.readFileSync(new URL(path.join('..', rel), import.meta.url), 'utf8');

const machine = (over = {}) => ({
  rental_id: 'vast:1',
  gpu: 'RTX 5090',
  usd_per_hour: 0.42,
  attached: true,
  tunnel_alive: true,
  priority: 1,
  models_served: ['zimage'],
  ...over,
});

const catalog = (over = {}) => ({
  image: [
    { id: 'hivemindos-hosted-media', available: true, models: [{ id: 'automatic', label: 'Automatic hosted model' }] },
    { id: 'openai-gpt-image-oauth', available: true, models: [{ id: 'gpt-image-2', label: 'GPT Image 2' }] },
    { id: 'muapi', available: true, models: [{ id: 'flux-2-pro', label: 'Flux 2 Pro' }] },
  ],
  ...over,
});

const localModels = [{ id: 'z-image-turbo', name: 'Z-Image Turbo', provider: 'sdcpp' }];

async function build(over = {}) {
  const { buildRunTargets } = await import('../src/lib/runTargets.js');
  return buildRunTargets({
    kind: 'image', localModels, catalogProviders: catalog().image, machines: null, pinned: '', ...over,
  });
}

/* ---------------- the three places ---------------- */

test('there are three places, they are three bills, and a rental is not a fourth', async () => {
  const { RUN_PLACES, groupRunTargets } = await import('../src/lib/runTargets.js');
  assert.deepEqual(RUN_PLACES.map((place) => place.label), ['This Mac', 'HivemindOS credits', 'Your accounts']);

  // With a live machine serving a local model, the groups are still three: the
  // machine rides on its This Mac row rather than opening a "Machines" group.
  const targets = await build({ machines: { live: [machine()], idle: [], broken: [] } });
  const groups = groupRunTargets(targets);
  assert.deepEqual(groups.map((group) => group.label), ['This Mac', 'HivemindOS credits', 'Your accounts']);
  for (const group of groups) {
    assert.doesNotMatch(group.label, /rent|machine|gpu/i, 'no group is a rental');
  }
  const zimage = targets.find((target) => target.id === 'z-image-turbo');
  assert.equal(zimage.place, 'this-mac');
  assert.equal(zimage.machine?.rental_id, 'vast:1');
  // The readout names the hardware the work lands on, because that is the true
  // answer to "where does this run" once a box is serving it.
  assert.equal(zimage.placeLabel, 'RTX 5090');
});

test('a machine that does not serve the model leaves the row on This Mac', async () => {
  const targets = await build({ machines: { live: [machine({ models_served: ['wan22'] })], idle: [], broken: [] } });
  const zimage = targets.find((target) => target.id === 'z-image-turbo');
  assert.equal(zimage.machine, null);
  assert.equal(zimage.placeLabel, 'This Mac');
});

test('an idle or broken machine never claims a row: it cannot run anything yet', async () => {
  for (const state of ['idle', 'broken']) {
    const machines = { live: [], idle: [], broken: [] };
    machines[state] = [machine(state === 'broken' ? { tunnel_alive: false } : { attached: false })];
    const targets = await build({ machines });
    assert.equal(targets.find((target) => target.id === 'z-image-turbo').machine, null, state);
  }
});

/* ---------------- labels ---------------- */

test('no label carries a registry id, a transport name or a family slug', async () => {
  const { PROVIDER_TRANSPORTS, placeLabelFor } = await import('../src/lib/modelRunner.js');
  const targets = await build({ machines: { live: [machine()], idle: [], broken: [] } });
  assert.ok(targets.length >= 4);
  for (const target of targets) {
    assert.notEqual(target.placeLabel, target.provider, `${target.provider} leaked as a label`);
    // A registry id is lower-case-with-separators; a place is a sentence.
    assert.doesNotMatch(target.placeLabel, /[:_]|-oauth|-api\b|hivemind-media|comfyui|sdcpp|wan2gp|media-studio/i);
    assert.doesNotMatch(target.placeLabel, /^(API|cloud|local)$/i);
    assert.ok(target.placeLabel, 'every offered row names its place');
  }
  // Every provider the catalog can list declares one, so a new provider cannot
  // fall through to printing its id.
  for (const [provider, entry] of Object.entries(PROVIDER_TRANSPORTS)) {
    assert.ok(entry.place, `${provider} declares no place`);
    assert.ok(entry.placeLabel, `${provider} declares no placeLabel`);
    assert.notEqual(entry.placeLabel, provider);
  }
  assert.equal(placeLabelFor({ provider: 'openai-gpt-image-oauth', source: 'cloud' }), 'Your OpenAI account');
  assert.equal(placeLabelFor({ provider: 'hivemindos-hosted-media', source: 'cloud' }), 'HivemindOS credits');
  assert.equal(placeLabelFor({ provider: 'muapi', source: 'cloud' }), 'MUAPI account');
  // An unknown provider gets no label rather than an invented one.
  assert.equal(placeLabelFor({ provider: 'brand-new-thing', source: 'cloud' }), '');
});

test('the readout is a place, a model and a reason', async () => {
  const { readoutText, runOnReadout } = await import('../src/lib/runTargets.js');
  const targets = await build();
  const zimage = targets.find((target) => target.id === 'z-image-turbo');
  assert.equal(
    readoutText(runOnReadout(zimage, { reason: 'free, stays on this Mac', automatic: true })),
    'This Mac · Z-Image Turbo — free, stays on this Mac',
  );
  const rented = (await build({ machines: { live: [machine()], idle: [], broken: [] } }))
    .find((target) => target.id === 'z-image-turbo');
  assert.equal(readoutText(runOnReadout(rented)), 'RTX 5090 · Z-Image Turbo — $0.42/hr');
});

/* ---------------- the Automatic ladder ---------------- */

async function pick(targets, readiness, machines = null) {
  const { pickRunTarget } = await import('../src/lib/runTargets.js');
  return pickRunTarget('image', { catalog: targets, machines, readiness });
}

test('the ladder runs local → HivemindOS credits → a connected account → a keyed account → a rental', async () => {
  const all = await build();
  const cloudOnly = all.filter((target) => target.source !== 'local');

  // 1. A model that runs here wins: free, private, and it answers now.
  let chosen = await pick(all, { hivemindosCredits: true, connectedProviders: ['openai-gpt-image-oauth'], keyedProviders: ['muapi'] });
  assert.equal(chosen.target.id, 'z-image-turbo');
  assert.equal(chosen.reason, 'free, stays on this Mac');

  // 2. Nothing local: the house default, but only when its credits are configured.
  chosen = await pick(cloudOnly, { hivemindosCredits: true, connectedProviders: [], keyedProviders: [] });
  assert.equal(chosen.target.place, 'hivemindos');
  assert.equal(chosen.reason, 'on your HivemindOS credits');

  // 3. Credits not configured: an account the owner actually connected.
  chosen = await pick(cloudOnly, {
    hivemindosCredits: false, connectedProviders: ['openai-gpt-image-oauth'], keyedProviders: ['muapi'],
  });
  assert.equal(chosen.target.provider, 'openai-gpt-image-oauth');
  assert.equal(chosen.reason, 'on your openai account');

  // 4. No grant either: a provider whose key is present.
  chosen = await pick(cloudOnly, { hivemindosCredits: false, connectedProviders: [], keyedProviders: ['muapi'] });
  assert.equal(chosen.target.provider, 'muapi');

  // 5. A rented box is the LAST rung: it bills by the hour whether or not
  //    anything is generating, so it is never chosen over something free.
  const rented = await build({ machines: { live: [machine()], idle: [], broken: [] } });
  const localOnRental = rented.filter((target) => target.source === 'local');
  chosen = await pick(localOnRental, { hivemindosCredits: false, connectedProviders: [], keyedProviders: [] },
    { live: [machine()], idle: [], broken: [] });
  assert.equal(chosen.target.machine.gpu, 'RTX 5090');
  assert.match(chosen.reason, /RTX 5090 you are renting, \$0\.42\/hr/);
});

test('a poorly rated local model does not lead the ladder', async () => {
  const { buildRunTargets, pickRunTarget } = await import('../src/lib/runTargets.js');
  const ratings = new Map([['sdcpp:z-image-turbo', { rating: 'poor', reason: 'It cannot draw a sprite sheet.' }]]);
  const targets = buildRunTargets({
    kind: 'image', localModels, catalogProviders: catalog().image, ratings,
  });
  const chosen = pickRunTarget('image', {
    catalog: targets,
    readiness: { hivemindosCredits: true, connectedProviders: [], keyedProviders: [] },
  });
  assert.equal(chosen.target.place, 'hivemindos', 'a poor local rating loses to the house default');
});

test('nothing runnable is an honest empty answer, not a row that fails at the press', async () => {
  const chosen = await pick([], { hivemindosCredits: true });
  assert.equal(chosen.target, null);
});

/* ---------------- video has no route for every place yet ---------------- */

test('a clip is only offered where a clip can actually run, and the rest is said once', async () => {
  const { videoRunTargets } = await import('../src/studios/video/videoRunTargets.js');
  const { targets, unreachable } = videoRunTargets({
    models: [{ id: 'minimax-h3', name: 'MiniMax H3' }, { id: 'seedance-v2.0-t2v', name: 'Seedance 2.0' }],
    tools: [],
    catalogProviders: [
      { id: 'hivemindos-hosted-media', available: true, models: [{ id: 'automatic', label: 'Automatic' }] },
      { id: 'higgsfield-consumer', available: true, models: [{ id: 'kling3_0', label: 'Kling 3.0' }] },
      { id: 'media-studio-mcp', available: true, models: [] },
    ],
  });
  assert.deepEqual(targets.map((target) => target.label).sort(), ['MiniMax H3', 'Seedance 2.0']);
  // Named by place, never by provider id.
  assert.deepEqual(unreachable, ['HivemindOS credits', 'Your Higgsfield account']);
  for (const label of unreachable) assert.doesNotMatch(label, /[:_]|-/);
});

/* ---------------- the four controls are actually gone ---------------- */

test('no studio still offers Local / API / Rented as a mode', async () => {
  const image = read('src/studios/image/ImageSettingsPanel.jsx');
  const video = read('src/studios/VideoStudio.jsx');
  for (const [name, source] of [['image', image], ['video', video]]) {
    assert.match(source, /<RunOnPicker/, `${name} shows the one readout`);
    assert.doesNotMatch(source, /value: 'rented'/, `${name} still offers a rented mode`);
    assert.doesNotMatch(source, /t\('image\.local'\)|t\('image\.api'\)/, `${name} still speaks the old vocabulary`);
  }
  // The i18n dictionary no longer holds the words either.
  const i18n = read('src/lib/i18n.js');
  for (const key of ["'image.local'", "'image.rented'", "'image.api'"]) {
    assert.doesNotMatch(i18n, new RegExp(key.replace(/[.]/g, '\\.')), `${key} is still in the dictionary`);
  }
  // …and the Send-to menu's copy of the triad is two places, not three modes.
  const { SEND_SOURCES, SOURCE_LABELS } = await import('../src/lib/studioTargets.js');
  assert.deepEqual([...SEND_SOURCES], ['local', 'api']);
  assert.deepEqual(SEND_SOURCES.map((source) => SOURCE_LABELS[source]), ['This Mac', 'Your accounts']);
});

test('the served-model filter has one implementation, not three', async () => {
  // It used to be copied into the image model menu, the video model menu and
  // the send-to resolver. The gateway owns the rule; the UI says what it means.
  assert.doesNotMatch(read('src/studios/video/videoSendTargets.js'), /servedByAnyMachine/);
  assert.match(read('src/lib/runTargets.js'), /export function servedByPinnedMachine/);
});


/* ---------------- the main studios can reach the other places ---------------- */

test("the Image studio joins its own cloud catalog with the server's other places", async (t) => {
  const { applyCloudCatalog, resetCloudCatalog } = await import('../src/lib/cloudCatalog.js');
  const { imageRunTargets, studioCloudImageModels } = await import('../src/studios/image/imageRunTargets.js');
  // The MUAPI half is SERVED now, so it is empty until a catalog lands — in the
  // app because App.jsx gates the studios on cloudCatalogReady(), here because
  // this seeds it. Twelve rows against the media catalog's curated handful is
  // the whole point of the join, and one id appears in both buckets to hold the
  // dedup (a model with a text-to-image AND an editing row is one model).
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `muapi-model-${i}`, name: `Model ${i}` }));
  applyCloudCatalog({ t2i: rows, i2i: [rows[0], { id: 'muapi-edit-only', name: 'Edit only' }] }, 'server');
  t.after(() => resetCloudCatalog());
  const targets = imageRunTargets({
    localModels,
    catalogProviders: catalog().image,
    machines: null,
  });
  const places = new Set(targets.map((target) => target.place));
  // HivemindOS credits and a connected account used to be readable only by
  // Story and Sprite; the studio's main image surface offers them now.
  assert.ok(places.has('this-mac'));
  assert.ok(places.has('hivemindos'));
  assert.ok(places.has('accounts'));
  assert.ok(targets.some((target) => target.provider === 'openai-gpt-image-oauth'));
  // …and nothing was taken away: the MUAPI catalog is dozens of models the
  // server's MEDIA catalog only samples, so it stays the source for that
  // account rather than being replaced by the curated handful.
  const muapi = targets.filter((target) => target.provider === 'muapi');
  assert.equal(muapi.length, studioCloudImageModels().length);
  assert.equal(muapi.length, 13, 'the full MUAPI catalog survives the join, deduplicated');
  assert.ok(muapi.length > catalog().image.length, 'the join is not the media catalog alone');
  assert.equal(muapi.every((target) => target.placeLabel === 'MUAPI account'), true);
});

test('an image runs on the account the picker chose, not always on MUAPI', async () => {
  const studio = read('src/studios/ImageStudio.jsx');
  // The routing identity is the model AND the account. Assuming MUAPI is what
  // kept HivemindOS credits and a connected ChatGPT out of this studio.
  assert.match(studio, /const cloudRow = \(\) => \(\{ id: s\.selectedModel, provider: s\.selectedProvider \|\| 'muapi', source: 'cloud' \}\);/);
  assert.doesNotMatch(studio, /muapiRow\(/, 'no cloud call assumes the account any more');
  // Both cloud calls declare a payload for the studio transport, or resolveRun
  // refuses the row rather than sending a MUAPI body somewhere else.
  const calls = studio.match(/row: cloudRow\(\),[\s\S]{0,900}?signal: run\.abort\.signal,/g) || [];
  assert.equal(calls.length, 2, 'both cloud generate paths route on the provider');
  for (const call of calls) assert.match(call, /studio: \{ quality/);
  // The account travels with the tab and survives a reload.
  const { normalizeImagePreferences } = await import('../src/studios/image/imagePrefs.js');
  assert.equal(normalizeImagePreferences({ modelId: 'm', providerId: 'openai-gpt-image-oauth' }).providerId,
    'openai-gpt-image-oauth');
  const { IMAGE_TAB_FIELDS } = await import('../src/lib/studioTabs.js');
  assert.ok(IMAGE_TAB_FIELDS.includes('selectedProvider'));
  assert.ok(IMAGE_TAB_FIELDS.includes('runOnAutomatic'), 'Automatic is sticky per tab');
});
