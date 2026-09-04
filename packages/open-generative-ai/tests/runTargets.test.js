// One "where does this run" vocabulary, one ladder, and no registry ids in it.
//
// The studio used to ask that question four ways: a Local / API / Rented
// segmented control in Image and Video, sections named This machine /
// HivemindOS / Your accounts in the text producer, a provider caption with no
// notion of place in Story and Sprite, and a lane list in Restore. This pins
// the replacement: three places grouped by BILL, a rental that is a property of
// This Mac rather than a mode, and an Automatic default that says why.
//
// Deliberately textual: "no studio still offers" and "one implementation, not
// three" are absence claims over the tree.
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
    readoutText(runOnReadout(zimage, { reason: 'free, stays here', automatic: true })),
    'This Mac · Z-Image Turbo — free, stays here',
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
  // One phrasing, not two: the Automatic reason and the manual readout used to
  // say the same thing in different words on the same chip.
  assert.equal(chosen.reason, 'free, stays here');

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

  // 4. No grant either: a provider whose key is present. "Present" is the
  //    whole condition — a MUAPI row with no key anywhere is not a rung, it is
  //    a row that cannot run, so the key has to be there for it to be picked.
  const { setMuapiKeyOnServer } = await import('../src/lib/modelRunner.js');
  setMuapiKeyOnServer(true);
  chosen = await pick(await build(), { hivemindosCredits: false, connectedProviders: [], keyedProviders: ['muapi'] });
  assert.equal(chosen.target.id, 'z-image-turbo', 'local still wins');
  chosen = await pick(
    (await build()).filter((target) => target.source !== 'local'),
    { hivemindosCredits: false, connectedProviders: [], keyedProviders: ['muapi'] },
  );
  assert.equal(chosen.target.provider, 'muapi');
  setMuapiKeyOnServer(null);

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

/* ---------------- one picker, one vocabulary, in every studio ---------------- */

/**
 * The surfaces that let somebody choose where work runs, and the ONE component
 * each of them has to ask with.
 *
 * Phase 3 built the picker and put it in Image and Video; Story and Sprite kept
 * a fit picker with no notion of place, Restore kept a lane list with a
 * CLOUD_LANE id, and the Send-to menu kept a two-row control that merely
 * borrowed the new words. This is the guard against the fifth one: a studio may
 * bring its own INVENTORY (a feature's rated rows, the gateway's lanes, another
 * tab's sources) but never its own vocabulary for where the bill lands.
 */
const RUN_ON_SURFACES = [
  'src/studios/image/ImageSettingsPanel.jsx',
  'src/studios/image/ImageComposer.jsx',
  'src/studios/VideoStudio.jsx',
  'src/studios/story/CastStage.jsx',
  'src/studios/story/MotionStage.jsx',
  'src/studios/SpriteStudio.jsx',
  'src/studios/restore/RestoreSettings.jsx',
  'src/components/SendToMenu.jsx',
];

test('every studio asks where work runs with the SAME component', async () => {
  for (const file of RUN_ON_SURFACES) {
    const source = read(file);
    assert.match(source, /<RunOn(Picker|List)/, `${file} must render the one picker`);
    assert.match(
      source,
      /from '[^']*RunOnPicker\.jsx'/,
      `${file} must import it rather than reimplement it`,
    );
    // The controls it replaced, by name. A studio that grows one again fails
    // here rather than shipping a fourth mental model.
    assert.doesNotMatch(source, /ModelFitPicker/, `${file} still has a fit picker of its own`);
    assert.doesNotMatch(source, /rentedOnly/, `${file} still has a rented MODE`);
    assert.doesNotMatch(source, /<LaneRow/, `${file} still has a lane list of its own`);
    assert.doesNotMatch(source, /<SourceRow/, `${file} still has a source control of its own`);
  }
  // …and the fit picker is gone, not merely unused: a component nothing renders
  // is the next studio's shortcut back to a fourth vocabulary.
  assert.equal(fs.existsSync(new URL(path.join('..', 'src/studios/ModelFitPicker.jsx'), import.meta.url)), false);
});

test('every studio speaks the SAME group names, whatever inventory it brings', async () => {
  const { RUN_PLACES, groupRunTargets, runTargetsFromRows } = await import('../src/lib/runTargets.js');
  const { restoreRunTargets } = await import('../src/lib/videoRestore.js');
  const { sendRunTargets } = await import('../src/lib/studioTargets.js');
  const places = new Set(RUN_PLACES.map((place) => place.id));
  const labels = RUN_PLACES.map((place) => place.label);

  const inventories = {
    // Image and Video: the served media catalog joined with this browser's own.
    catalog: await build(),
    // Story and Sprite: the capability matrix's rows for one feature, rated.
    matrix: runTargetsFromRows([
      { id: 'z-image-turbo', label: 'Z-Image Turbo', provider: 'sdcpp', source: 'local', rating: 'good', reason: 'Draws a clean sheet.', evidence: 'measured' },
      { id: 'gpt-image-2', label: 'GPT Image 2', provider: 'openai-gpt-image-oauth', source: 'cloud', rating: 'good', reason: 'Follows the brief.', evidence: 'reported' },
      { id: 'automatic', label: 'Automatic', provider: 'hivemindos-hosted-media', source: 'cloud', rating: 'workable', reason: 'The house default.', evidence: 'reasoned' },
    ]),
    // Restore: the gateway's own lanes, which are places and not providers.
    lanes: runTargetsFromRows(restoreRunTargets([
      { lane: 'default', available: true, paid: false, assembles_here: true },
      { lane: 'vast-48', available: true, paid: true, machine: 'RTX 5090' },
      { lane: 'cloud', available: true, paid: true },
    ]), { kind: 'video' }),
    // The Send-to menu: another tab's two places, described.
    send: runTargetsFromRows(sendRunTargets({
      sources: {
        local: { available: true, modelId: 'minimax-h3', modelName: 'MiniMax H3', switches: false, note: '' },
        api: { available: true, modelId: 'seedance', modelName: 'Seedance', switches: true, note: '' },
      },
    }), { kind: 'video' }),
  };

  for (const [name, targets] of Object.entries(inventories)) {
    assert.ok(targets.length, `${name} produced no rows`);
    for (const target of targets) {
      assert.ok(places.has(target.place), `${name}: "${target.place}" is not one of the three places`);
      assert.ok(target.placeLabel, `${name}: a row with no place label`);
      // No registry id, lane name or mode word may reach a reader.
      assert.doesNotMatch(target.placeLabel, /[:_]|^(API|cloud|local|rented|default)$/i,
        `${name}: "${target.placeLabel}" is a wire value, not a place`);
    }
    const groups = groupRunTargets(targets).map((group) => group.label);
    assert.deepEqual(groups, labels.filter((label) => groups.includes(label)),
      `${name} groups in a different order`);
  }

  // Restore's lanes in particular: the hosted one is a BILL (HivemindOS
  // credits), a rented box is This Mac's hardware, and CLOUD_LANE stays the
  // wire value it always was.
  const hosted = inventories.lanes.find((target) => target.id === 'cloud');
  assert.equal(hosted.place, 'hivemindos');
  assert.equal(hosted.placeLabel, 'HivemindOS credits');
  assert.equal(inventories.lanes.find((target) => target.id === 'vast-48').place, 'this-mac');
  assert.equal(inventories.lanes.find((target) => target.id === 'default').place, 'this-mac');
});

test('a rental is the per-tab pin now, not a mode any preference remembers', async () => {
  // `rentedOnly` was a fourth thing to be in on top of three places, and it
  // meant "local, plus filter the menu" — which the gateway's lane rules did
  // anyway. The pin is what a person actually set, so the pin is what survives.
  const RETIRED_IN = ['src/lib/videoPreferences.js', 'src/studios/image/imagePrefs.js',
    'src/lib/studioTabs.js', 'src/studios/video/videoLogic.js', 'src/studios/video/videoSendTargets.js',
    'src/studios/ImageStudio.jsx', 'src/studios/VideoStudio.jsx', 'src/studios/image/LoraSection.jsx'];
  for (const file of RETIRED_IN) {
    // Comments may still explain what was retired; nothing may still read it.
    const live = read(file).split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.equal(live.includes('rentedOnly'), false, `${file} still reads or writes rentedOnly`);
  }
  // …and everywhere it USED to gate the routing, the pin took its place rather
  // than the promise about where work lands simply disappearing.
  for (const file of ['src/lib/videoPreferences.js', 'src/studios/image/imagePrefs.js',
    'src/lib/studioTabs.js', 'src/studios/video/videoLogic.js',
    'src/studios/ImageStudio.jsx', 'src/studios/VideoStudio.jsx', 'src/studios/image/LoraSection.jsx']) {
    assert.match(read(file), /rentedMachineId|onRentedMachine|pinnedMachine/, `${file} lost the pin with it`);
  }
  const { normalizeVideoPreferences } = await import('../src/lib/videoPreferences.js');
  const { normalizeImagePreferences } = await import('../src/studios/image/imagePrefs.js');
  const video = normalizeVideoPreferences({ modelId: 'minimax-h3', rentedOnly: true, rentedMachineId: 'vast:48' });
  assert.equal('rentedOnly' in video, false);
  assert.equal(video.rentedMachineId, 'vast:48');
  const image = normalizeImagePreferences({ modelId: 'z-image-turbo', rentedOnly: true, rentedMachineId: 'vast:48' });
  assert.equal('rentedOnly' in image, false);
  assert.equal(image.rentedMachineId, 'vast:48');
  // The per-tab pin still travels with a duplicated tab; the retired mode does not.
  const { IMAGE_TAB_FIELDS } = await import('../src/lib/studioTabs.js');
  assert.ok(IMAGE_TAB_FIELDS.includes('rentedMachineId'));
  assert.equal(IMAGE_TAB_FIELDS.includes('rentedOnly'), false);
});
