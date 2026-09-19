import assert from 'node:assert/strict';
import test from 'node:test';

// "Use in Video studio" on a model card wrote the studio-wide preferences blob
// and nothing else. That is enough only for a studio with no tab yet: a studio
// remounts on navigation and each tab restores its own snapshot over the top
// (VIDEO_TAB_FIELDS includes `setup`), so the handoff was overwritten by
// whatever the front tab was last used with. Seen 2026-09-14: "Use in Video
// studio" on MiniMax H3 Eros opened the Video studio on local Wan 2.2.
//
// The fix is a one-shot request the studio claims, so these tests are about the
// channel: it must survive until the studio is ready to read it, be taken by
// exactly one reader, and never be handed to the wrong page.

function installSessionStorage() {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return store;
}

async function freshModule() {
  // Cache-busted so each test gets the module with the CURRENT sessionStorage.
  return import(`../src/lib/studioHandoff.js?t=${Math.random()}`);
}

test('a handed-over model waits to be claimed and is claimed once', async () => {
  installSessionStorage();
  const { requestStudioModel, consumeStudioModelRequest } = await freshModule();

  requestStudioModel('video', 'hivemind-media:minimax-h3-eros');
  // Claimed once…
  assert.equal(consumeStudioModelRequest('video'), 'hivemind-media:minimax-h3-eros');
  // …and never twice: a second tab must not re-point itself to the same model.
  assert.equal(consumeStudioModelRequest('video'), '');
});

test('only the page it was addressed to may take it', async () => {
  installSessionStorage();
  const { requestStudioModel, consumeStudioModelRequest } = await freshModule();

  requestStudioModel('video', 'hivemind-media:minimax-h3-eros');
  // The image studio is mounted at the same time as the video one, so a
  // handoff it answered would steal the model AND consume the request.
  assert.equal(consumeStudioModelRequest('image'), '');
  assert.equal(consumeStudioModelRequest('video'), 'hivemind-media:minimax-h3-eros');
});

test('an empty or missing model is not a handoff', async () => {
  const store = installSessionStorage();
  const { requestStudioModel, consumeStudioModelRequest } = await freshModule();

  requestStudioModel('video', '');
  requestStudioModel('video', null);
  requestStudioModel('', 'some-model');
  assert.equal(store.size, 0, 'nothing to hand over must not leave a request behind');
  assert.equal(consumeStudioModelRequest('video'), '');
});

test('a corrupt request clears itself instead of wedging every later one', async () => {
  const store = installSessionStorage();
  const { requestStudioModel, consumeStudioModelRequest } = await freshModule();

  store.set('studio_open_model_once', '{not json');
  assert.equal(consumeStudioModelRequest('video'), '');
  // …and the next handoff still works, which is the point.
  requestStudioModel('video', 'hivemind-media:minimax-h3-eros');
  assert.equal(consumeStudioModelRequest('video'), 'hivemind-media:minimax-h3-eros');
});

test('private mode is survivable: a storage that throws is not a crash', async () => {
  globalThis.sessionStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  const { requestStudioModel, consumeStudioModelRequest } = await freshModule();

  assert.doesNotThrow(() => requestStudioModel('video', 'hivemind-media:minimax-h3-eros'));
  assert.equal(consumeStudioModelRequest('video'), '');
});
