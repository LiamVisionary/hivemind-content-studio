// Is anything ready to make a picture on this machine?
//
// The Setup state is derived from this one predicate, so its four inputs are
// the whole contract: a cloud account, a local engine with something installed,
// the Media Studio workflow registry, and a live rental. Any one is enough, and
// none of them may be faked by a near miss — a bridge that says "ready" with an
// empty shelf is not a source, and a catalog row the server marked unavailable
// is not one either.
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = { __HIVEMIND_STUDIO__: 1, location: { search: '' } };

const load = () => import('../src/lib/setupReadiness.js');

const NOTHING = {
  cloudRows: [],
  oauth: null,
  localStatus: 'empty',
  localModelCount: 0,
  videoWorkflowCount: 0,
  rentedLiveCount: 0,
};

test('a machine with no source of any kind is not ready', async () => {
  const { isAnySourceReady } = await load();
  assert.equal(isAnySourceReady(NOTHING), false);
  // And the no-argument call — the shape the store starts from — agrees.
  assert.equal(isAnySourceReady(), false);
});

test('a live OAuth grant is enough on its own', async () => {
  const { isAnySourceReady } = await load();
  const ready = isAnySourceReady({
    ...NOTHING,
    cloudRows: [{ id: 'gpt-image-2', provider: 'openai-gpt-image-oauth', source: 'cloud' }],
    oauth: { openai: { connected: true, usable: true } },
  });
  assert.equal(ready, true);
});

test('a stale grant is not a source', async () => {
  const { isAnySourceReady } = await load();
  const ready = isAnySourceReady({
    ...NOTHING,
    cloudRows: [{ id: 'gpt-image-2', provider: 'openai-gpt-image-oauth', source: 'cloud' }],
    oauth: { openai: { connected: true, usable: false, needs_reconnect: true } },
  });
  assert.equal(ready, false);
});

test('a provider the server marked unavailable is not a source', async () => {
  const { isAnySourceReady } = await load();
  const row = { id: 'gpt-image-2', provider: 'openai-gpt-image', source: 'cloud', available: false };
  assert.equal(isAnySourceReady({ ...NOTHING, cloudRows: [row] }), false);
  // The same row, once the key is on the machine.
  assert.equal(isAnySourceReady({ ...NOTHING, cloudRows: [{ ...row, available: true }] }), true);
});

test('the local engine counts only when it has something installed', async () => {
  const { isAnySourceReady } = await load();
  // The bug this guards: "ready" with an empty shelf left the studio inviting a
  // press with nothing behind it.
  assert.equal(isAnySourceReady({ ...NOTHING, localStatus: 'ready', localModelCount: 0 }), false);
  assert.equal(isAnySourceReady({ ...NOTHING, localStatus: 'empty', localModelCount: 3 }), false);
  assert.equal(isAnySourceReady({ ...NOTHING, localStatus: 'ready', localModelCount: 1 }), true);
});

test('a workflow registry with workflows in it is a source', async () => {
  const { isAnySourceReady } = await load();
  assert.equal(isAnySourceReady({ ...NOTHING, videoWorkflowCount: 4 }), true);
});

test('a live rented machine is a source', async () => {
  const { isAnySourceReady } = await load();
  assert.equal(isAnySourceReady({ ...NOTHING, rentedLiveCount: 1 }), true);
});

test('the catalog becomes rows the readiness rules already understand', async () => {
  const { cloudRowsFromCatalog } = await load();
  const rows = cloudRowsFromCatalog({
    media: {
      image: [
        { id: 'stickman-renderer', label: 'Stickman', available: true, models: [] },
        { id: 'comfyui', label: 'ComfyUI', available: true, models: [] },
        { id: 'openai-gpt-image', label: 'OpenAI', available: false, detail: 'Needs a key.', models: [{ id: 'gpt-image-2' }] },
      ],
      video: [
        { id: 'media-studio-mcp', label: 'Media Studio', available: true, models: [] },
        { id: 'openai-gpt-image', label: 'OpenAI', available: false, models: [] },
        { id: 'muapi', label: 'MUAPI', available: true, models: [{ id: 'flux' }] },
      ],
    },
  });

  // Renderers and this machine's own studio are not accounts anyone connects,
  // and a provider listed under both kinds is one row, not two.
  assert.deepEqual(rows.map((row) => row.provider), ['openai-gpt-image', 'muapi']);
  assert.equal(rows[0].source, 'cloud');
  assert.equal(rows[0].available, false);
  assert.equal(rows[0].needs, 'Needs a key.');
});

test('every account that is not ready carries the control that readies it', async () => {
  const { accountRepairs } = await load();
  const repairs = accountRepairs({
    cloudRows: [
      { provider: 'openai-gpt-image-oauth', label: 'OpenAI (sign-in)', source: 'cloud' },
      { provider: 'openai-gpt-image', label: 'OpenAI (key)', source: 'cloud', available: false },
    ],
    oauth: { openai: { connected: false } },
  });

  assert.deepEqual(repairs.map((r) => r.action.kind), ['oauth', 'key']);
  assert.equal(repairs[1].action.key, 'OPENAI_API_KEY');
});
