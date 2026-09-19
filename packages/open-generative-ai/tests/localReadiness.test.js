// One readiness answer, shared by Image, Story and Sprite.
//
// The bug: a bridge that did not answer left the static desktop catalog on
// screen (ids the hosted bridge refuses with "Unknown local image workflow")
// under a live Generate button, and an empty catalog looked exactly the same as
// a full one. "Nothing installed" and "the engine is starting" are different
// problems with different fixes, so they are now different answers.
//
// Deliberately textual: what the hosted bridge ANSWERS, and that a hosted
// studio never seeds its picker from the desktop catalog, are facts about a
// payload and about which module is read — neither has a rendered form on a
// machine with no bridge at all.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.window = { __HIVEMIND_STUDIO__: 1, location: { search: '' } };

const read = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const bridge = (listModels) => {
  globalThis.window.localAI = { isElectron: true, isHosted: true, listModels, wan2gp: { listModels: async () => [] } };
};

test('the catalog fetch says WHY the list is empty', async () => {
  const { localAI, localCatalogStatusNow } = await import('../src/lib/localInferenceClient.js');

  bridge(async () => [{ id: 'z-image-turbo', ready: true }]);
  const ready = await localAI.listModels();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.models.length, 1);
  assert.equal(localCatalogStatusNow(), 'ready');

  // The bridge answered and there is nothing to run — an install problem.
  bridge(async () => []);
  assert.equal((await localAI.listModels()).status, 'empty');

  // The bridge did not answer at all — a starting-engine problem.
  bridge(async () => { throw new Error('fetch failed'); });
  const down = await localAI.listModels();
  assert.equal(down.status, 'unreachable');
  assert.deepEqual(down.models, []);
  assert.equal(localCatalogStatusNow(), 'unreachable');

  // Models are installed; the lane that runs them is not up. Saying "nothing
  // installed" here would send someone to download what they already have.
  bridge(async () => [{ id: 'z-image-turbo', ready: false, readyReason: 'engine-offline' }]);
  assert.equal((await localAI.listModels()).status, 'unreachable');

  // A model whose weights are missing is an install problem again.
  bridge(async () => [{ id: 'z-image-turbo', ready: false, readyReason: 'missing-weights' }]);
  assert.equal((await localAI.listModels()).status, 'empty');
});

test('nothing has been asked yet is its own answer, and blocks nothing', async () => {
  bridge(async () => []);
  const fresh = await import('../src/lib/localInferenceClient.js?case=untouched');
  assert.equal(fresh.localCatalogStatusNow(), 'discovering');
});

test('a local row is refused with the shared reason once the engine is known to be down', async () => {
  const { localAI, setLocalCatalogStatus } = await import('../src/lib/localInferenceClient.js');
  const { localRow, transportFor } = await import('../src/lib/modelRunner.js');

  bridge(async () => [{ id: 'z-image-turbo', ready: true }]);
  await localAI.listModels();
  assert.equal(transportFor(localRow('z-image-turbo')).runnable, true);

  bridge(async () => { throw new Error('fetch failed'); });
  await localAI.listModels();
  const blocked = transportFor(localRow('z-image-turbo'));
  assert.equal(blocked.runnable, false);
  assert.match(blocked.reason, /local engine is starting/i);

  bridge(async () => []);
  await localAI.listModels();
  const nothing = transportFor(localRow('z-image-turbo'));
  assert.equal(nothing.runnable, false);
  assert.match(nothing.reason, /No local model is installed/i);

  // Discovery in flight greys nothing out: the answer is milliseconds away.
  setLocalCatalogStatus('discovering');
  assert.equal(transportFor(localRow('z-image-turbo')).runnable, true);
});

test('the hosted bridge answers with a real per-model readiness, not a constant', async () => {
  const server = await read('../hosted-server.js');
  // Weights on disk, and a lane that answers — asked once every five seconds
  // rather than once per model.
  assert.match(server, /LANE_PROBE_TTL_MS = 5000/);
  assert.match(server, /\/comfy\/system_stats/);
  assert.match(server, /readyReason: 'engine-offline'/);
  assert.match(server, /readyReason: 'missing-weights'/);
  assert.match(server, /pathname === '\/local-ai\/models'\) return sendJson\(res, 200, await listModelsWithReadiness\(\)\)/);

  const models = await read('../hosted-local-models.js');
  assert.match(models, /function missingWeightFiles/);
});

test('a hosted studio never seeds its picker from the desktop catalog', async () => {
  const image = await read('../src/studios/ImageStudio.jsx');
  assert.match(image, /isHostedLocalAI\(\) \? \[\] : LOCAL_MODEL_CATALOG/);
  // The Model section explains itself, and Generate refuses with that reason.
  assert.match(await read('../src/studios/image/ImageSettingsPanel.jsx'), /<LocalCatalogNotice/);
  assert.match(image, /const localBlocked = Boolean\(/);
  assert.match(image, /generateBlocked=\{generateBlocked\}/);
  assert.match(await read('../src/studios/image/ImageComposer.jsx'), /disabled=\{generateBlocked\}/);
  // Discovery is re-runnable, not a one-shot at mount.
  assert.match(image, /addEventListener\('hivemind-hub-refresh', onHubRefresh\)/);
  // The default pick is the featured workflow, not whatever is first.
  assert.match(image, /list\.find\(\(model\) => model\.featured\)/);

  // Story used to list the desktop sd.cpp ids as "On this machine" and never
  // discover at all.
  const story = await read('../src/studios/StoryStudio.jsx');
  assert.doesNotMatch(story, /LOCAL_MODEL_CATALOG/);
  assert.match(story, /useLocalImageCatalog\(\)/);

  const sprite = await read('../src/studios/SpriteStudio.jsx');
  assert.doesNotMatch(sprite, /LOCAL_MODEL_CATALOG/);
  assert.match(sprite, /useLocalImageCatalog\(\)/);

  const hook = await read('../src/lib/useLocalCatalog.js');
  assert.match(hook, /hivemind-hub-refresh/);
  assert.match(hook, /else if \(isHostedLocalAI\(\)\) setModels\(\[\]\)/);
});

test('a bridge that is down reaches the browser as a sentence, not an HTTP code', async () => {
  const shim = await read('../public/hosted-local-ai.js');
  assert.match(shim, /data\.message \|\| data\.error \|\| `HTTP \$\{res\.status\}`/);
  assert.match(shim, /failure\.remedy = data\.remedy/);
});
