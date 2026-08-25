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
    calls.push({ url: String(url), headers: init?.headers || {}, method: init?.method || 'GET' });
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
