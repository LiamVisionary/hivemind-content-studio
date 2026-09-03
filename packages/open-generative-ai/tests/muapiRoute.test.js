// Where the MUAPI key lives, and that every call still lands somewhere real.
//
// Until 2026-08-24 the key sat in this browser's localStorage while every other
// provider was authenticated from the shared Hive environment — so a machine
// whose HivemindOS already had MUAPI_API_KEY still prompted for one. The client
// now proxies through this machine. Only the destination and the auth header
// changed; the endpoint resolution, poll cadence, request-id contract and
// MUAPI's detail-envelope failures are all the same code, deliberately.
import assert from 'node:assert/strict';
import test from 'node:test';

function harness({ serverKey = true, browserKey = 'browser-key' } = {}) {
  const calls = [];
  globalThis.window = { location: { search: '' } };
  globalThis.localStorage = { getItem: () => browserKey, setItem: () => {} };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers || {}, method: init?.method || 'GET', body: init?.body });
    if (String(url).includes('/api/muapi/status')) {
      return { ok: true, json: async () => ({ ok: true, server_key: serverKey }) };
    }
    if (String(url).includes('predictions')) {
      return { ok: true, json: async () => ({ status: 'completed', outputs: ['data:image/png;base64,x'] }) };
    }
    return { ok: true, json: async () => ({ request_id: 'r1' }) };
  };
  return calls;
}

const fresh = async () => {
  const { MuapiClient } = await import('../src/lib/muapi.js');
  return new MuapiClient();
};

test('with the key on this machine, nothing goes to api.muapi.ai and no key leaves the browser', async () => {
  const calls = harness({ serverKey: true });
  const client = await fresh();

  await client.generateImage({ model: 'flux-2-pro', prompt: 'a pier' });

  const outbound = calls.filter((c) => !c.url.includes('/status'));
  assert.ok(outbound.length > 0);
  for (const call of outbound) {
    assert.match(call.url, /^\/api\/muapi\/api\/v1\//, `${call.url} left this origin`);
    // The key is attached on the server. A header here would mean the browser
    // still holds one.
    assert.equal(call.headers['x-api-key'], undefined);
  }
});

test('without a server key it falls back to the browser key and the real host', async () => {
  const calls = harness({ serverKey: false, browserKey: 'browser-key' });
  const client = await fresh();

  await client.generateImage({ model: 'flux-2-pro', prompt: 'a pier' });

  const submit = calls.find((c) => c.url.includes('/api/v1/flux-2-pro'));
  assert.match(submit.url, /^https:\/\/api\.muapi\.ai\//);
  assert.equal(submit.headers['x-api-key'], 'browser-key');
});

test('the route is resolved once, not per call', async () => {
  const calls = harness({ serverKey: true });
  const client = await fresh();

  await client.generateImage({ model: 'flux-2-pro', prompt: 'a' });
  await client.generateImage({ model: 'flux-2-pro', prompt: 'b' });

  assert.equal(calls.filter((c) => c.url.includes('/status')).length, 1);
});

test('every generating method reaches an endpoint — none was left holding a stale local', async () => {
  // Six call sites passed the old `key` local into pollForResult. A missed one
  // is a ReferenceError the user meets as "key is not defined" in a toast.
  const calls = harness({ serverKey: true });
  const client = await fresh();

  await client.generateImage({ model: 'flux-2-pro', prompt: 'x' });
  await client.generateI2I({ model: 'gpt-image-2-edit', prompt: 'x', image_url: 'u' });
  await client.generateVideo({ model: 'seedance-v2.0-t2v', prompt: 'x' });

  const submits = calls.filter((c) => /\/api\/v1\/[^/]+$/.test(c.url) && !c.url.includes('predictions'));
  assert.equal(submits.length, 3);
  // And each one polled, which is the call the stale local was passed to.
  assert.ok(calls.filter((c) => c.url.includes('predictions')).length >= 3);
});

test('polling goes to the same route as the submit', async () => {
  const calls = harness({ serverKey: true });
  const client = await fresh();

  await client.generateImage({ model: 'flux-2-pro', prompt: 'x' });

  const poll = calls.find((c) => c.url.includes('predictions'));
  assert.match(poll.url, /^\/api\/muapi\/api\/v1\/predictions\/r1\/result$/);
});

test('a resume that still has a stored key does not send it to our own server', async () => {
  // The resume path reads a key out of storage before it knows which route the
  // page is on, and passes it to pollForResult. On the proxied route it is
  // ignored rather than forwarded.
  const calls = harness({ serverKey: true });
  const client = await fresh();

  await client.pollForResult('old-job', 'a-stored-key', 1, 1);

  const poll = calls.find((c) => c.url.includes('predictions'));
  assert.match(poll.url, /^\/api\/muapi\//);
  assert.equal(poll.headers['x-api-key'], undefined);
});

/* ---------------- one door: where a pasted key goes ---------------- */

// The dialog used to write localStorage and nothing else, so a machine with a
// credential store still ended up with a paid key in its browser profile — and
// the copy it kept was never the one the proxied route used.

function storeHarness({ serverKey = false, browserKey = '', passbookStatus = 200 } = {}) {
  const calls = [];
  const writes = [];
  const removals = [];
  let stored = browserKey;
  globalThis.window = { __HIVEMIND_STUDIO__: 1, location: { search: '' } };
  globalThis.localStorage = {
    getItem: () => stored,
    setItem: (k, v) => { writes.push([k, v]); stored = v; },
    removeItem: (k) => { removals.push(k); stored = ''; },
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body });
    if (String(url).includes('/api/muapi/status')) {
      return { ok: true, json: async () => ({ ok: true, server_key: serverKey }) };
    }
    if (String(url).includes('/api/passbook')) {
      return passbookStatus === 200
        ? { ok: true, status: 200, json: async () => ({ stored: ['MUAPI_API_KEY'] }) }
        : { ok: false, status: passbookStatus, json: async () => ({ detail: { message: 'no store here' } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { calls, writes, removals };
}

test('a key pasted in the dialog is saved to this machine, never to this browser', async () => {
  const { calls, writes } = storeHarness({ serverKey: false });
  const { storeMuapiKey } = await import('../src/lib/muapiKey.js');
  const { muapiKeyIsOnServer, setMuapiKeyOnServer, needsBrowserKey, muapiRow } = await import('../src/lib/modelRunner.js');

  const result = await storeMuapiKey('sk-live-value');

  assert.equal(result.where, 'machine');
  const post = calls.find((c) => c.url === '/api/passbook');
  assert.ok(post, 'the key never reached the shared store');
  assert.deepEqual(JSON.parse(post.body), { values: { MUAPI_API_KEY: 'sk-live-value' } });
  // The whole point: no second copy in the browser.
  assert.deepEqual(writes, []);
  // And the answer every gate reads flips without a round trip, so the next
  // Generate runs instead of re-opening the dialog.
  assert.equal(muapiKeyIsOnServer(), true);
  assert.equal(needsBrowserKey(muapiRow('flux-2-pro')), false);
  setMuapiKeyOnServer(null);
});

test('a store that cannot take the key keeps it in this browser rather than dead-ending', async () => {
  const { writes } = storeHarness({ serverKey: false, passbookStatus: 501 });
  const { storeMuapiKey } = await import('../src/lib/muapiKey.js');
  const { setMuapiKeyOnServer } = await import('../src/lib/modelRunner.js');

  // 501 is "this host holds no credentials" — a standalone build, not a refusal
  // of this value. Falling back is what keeps the direct route usable.
  const result = await storeMuapiKey('sk-live-value');

  assert.equal(result.where, 'browser');
  assert.deepEqual(writes, [['muapi_key', 'sk-live-value']]);
  setMuapiKeyOnServer(null);
});

test('a value the store refused is reported, not silently written to the browser', async () => {
  const { writes } = storeHarness({ serverKey: false, passbookStatus: 400 });
  const { storeMuapiKey } = await import('../src/lib/muapiKey.js');
  const { setMuapiKeyOnServer } = await import('../src/lib/modelRunner.js');

  await assert.rejects(() => storeMuapiKey('sk-live-value'), /no store here/);
  assert.deepEqual(writes, []);
  setMuapiKeyOnServer(null);
});

test('a legacy browser key is moved into the machine store at boot, and said so', async () => {
  const { calls, removals } = storeHarness({ serverKey: false, browserKey: 'old-browser-key' });
  const { seedMuapiKeyLocation } = await import('../src/lib/muapiKey.js');
  const { setMuapiKeyOnServer } = await import('../src/lib/modelRunner.js');

  const result = await seedMuapiKeyLocation();

  assert.equal(result.migrated, true);
  assert.equal(result.onServer, true);
  assert.deepEqual(
    JSON.parse(calls.find((c) => c.url === '/api/passbook').body),
    { values: { MUAPI_API_KEY: 'old-browser-key' } },
  );
  assert.ok(removals.includes('muapi_key'), 'the browser copy stayed behind');
  setMuapiKeyOnServer(null);
});

test('a browser copy on a machine that already holds the key is simply dropped', async () => {
  const { calls, removals } = storeHarness({ serverKey: true, browserKey: 'stale' });
  const { seedMuapiKeyLocation } = await import('../src/lib/muapiKey.js');
  const { setMuapiKeyOnServer } = await import('../src/lib/modelRunner.js');

  const result = await seedMuapiKeyLocation();

  assert.equal(result.onServer, true);
  // Nothing to migrate — the machine has it. Re-posting would be a write with
  // no purpose, and calling it a migration would be a lie.
  assert.equal(result.migrated, false);
  assert.equal(calls.filter((c) => c.url === '/api/passbook').length, 0);
  assert.ok(removals.includes('muapi_key'));
  setMuapiKeyOnServer(null);
});
