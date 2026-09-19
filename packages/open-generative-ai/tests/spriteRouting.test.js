// Where a Sprite animation goes when the picked model is a cloud provider.
//
// The bug this pins: the animation stage used to build `studioRow(pick.id)`
// for every pick, which hard-codes provider `media-studio-mcp`. Choosing
// "Seedance 2.0 · Higgsfield" therefore posted `workflow_id: 'seedance_2_0'`
// to this machine's Media Studio lane, which knows no such workflow — and the
// failure looked like a broken local lane rather than a mis-route.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const loadRunner = () => import('../src/lib/modelRunner.js');
const loadRouting = () => import('../src/studios/sprite/spriteRouting.js');

// The lib reads localStorage and window at call time; node has neither.
// `__HIVEMIND_STUDIO__` marks the app as served by the studio, so the studio
// transport counts as reachable — the exact condition under which a Higgsfield
// row used to slip onto the local lane.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.window = { __HIVEMIND_STUDIO__: 1, location: { search: '' } };

const HIGGSFIELD = { id: 'seedance_2_0', provider: 'higgsfield-consumer', source: 'cloud' };
const LANE = { id: 'minimax-h3', provider: 'media-studio-mcp', source: 'cloud' };

test('a Higgsfield clip is refused rather than posted to the Media Studio lane', async () => {
  const { runVideo } = await loadRunner();
  const posted = [];
  globalThis.fetch = async (path, init) => {
    posted.push({ path, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true, url: '/out.mp4' }), text: async () => '' };
  };

  await assert.rejects(
    () => runVideo({ row: HIGGSFIELD, shared: { prompt: 'a dragon idles', image: 'data:image/png;base64,AA==' } }),
    /Higgsfield/,
  );

  // Nothing left the browser: no request carried `workflow_id: 'seedance_2_0'`
  // to a lane that has never heard of it.
  assert.deepEqual(posted, []);
  delete globalThis.fetch;
});

test('the lane still serves its own workflows, and the picker says which rows it cannot', async () => {
  const { clipRouteFor } = await loadRunner();

  assert.equal(clipRouteFor(LANE).transport, 'studio');
  assert.equal(clipRouteFor(LANE).runnable, true);
  assert.equal(clipRouteFor({ id: 'workflow-default', provider: 'comfyui', source: 'cloud' }).transport, 'studio');
  assert.equal(clipRouteFor({ id: 'seedance-pro-i2v', provider: 'muapi', source: 'cloud' }).transport, 'muapi');

  for (const provider of ['higgsfield-consumer', 'higgsfield-cloud', 'xai-imagine-api', 'hivemindos-hosted-media']) {
    const route = clipRouteFor({ id: 'x', provider, source: 'cloud' });
    assert.equal(route.transport, 'none', provider);
    assert.equal(route.runnable, false, provider);
    // The reason names the fix — which rows CAN run — not the failure. It says
    // "this machine", never a backend product name (DESIGN.md §6).
    assert.match(route.reason, /pick a model that runs on this machine/, provider);
    assert.doesNotMatch(route.reason, /Media Studio/, provider);
  }
});

test('the animation row carries the pick’s own provider, never media-studio-mcp', async () => {
  const { animationRow } = await loadRouting();

  const pick = { ...HIGGSFIELD, key: 'higgsfield-consumer:seedance_2_0', label: 'Seedance 2.0', rating: 'unmeasured' };
  assert.deepEqual(animationRow(pick), HIGGSFIELD);
  assert.deepEqual(animationRow({ ...LANE, key: 'k', label: 'MiniMax H3' }), LANE);
});

test('a row the animation stage cannot reach is offered with its reason, and never as the default', async () => {
  const { animationChoices } = await loadRouting();
  const { defaultPick } = await import('../src/lib/capabilityMatrix.js');

  const rows = animationChoices([
    { ...HIGGSFIELD, key: 'a', rating: 'good', available: true },
    { id: 'seedance-pro-i2v', provider: 'muapi', source: 'cloud', key: 'b', rating: 'good', available: true },
    { ...LANE, key: 'c', rating: 'workable', available: true },
  ]);

  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(byKey.a.available, false);
  assert.match(byKey.a.unavailableReason, /runs on this machine/);
  // MUAPI is a real clip transport, but the sprite is a sealed reference only
  // this machine's studio can read, so the stage builds no MUAPI request.
  assert.equal(byKey.b.available, false);
  assert.match(byKey.b.unavailableReason, /runs here/);
  assert.equal(byKey.c.available, true);
  assert.equal(byKey.c.unavailableReason, '');
  assert.equal(defaultPick(rows).key, 'c');
});

test('the Sprite studio no longer rewrites the pick to a Media Studio row', async () => {
  const source = await readFile(new URL('../src/studios/SpriteStudio.jsx', import.meta.url), 'utf8');
  const body = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

  assert.doesNotMatch(body, /studioRow\s*\(\s*videoModel/);
  assert.match(body, /animationRow\s*\(\s*videoModel/);
});
