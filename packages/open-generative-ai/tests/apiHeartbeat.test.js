// Offline is a shared state, not a pill frozen at boot.
//
// The old store pinged /api/catalog once behind a `pinged` latch: a session that
// opened while the studio was restarting said "not running" until the tab was
// reloaded, and a session whose studio died mid-flight kept saying "Ready" while
// every press failed on its own. These tests hold the schedule, the pause in a
// hidden tab, and the one event a recovery has to fire.
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeWindow extends EventTarget {}

function browser({ hidden = false } = {}) {
  globalThis.window = new FakeWindow();
  globalThis.document = {
    hidden,
    listeners: new Set(),
    addEventListener() {},
    removeEventListener() {},
  };
}

// Fake timers run the scheduled callback synchronously; the beat it starts
// settles over a handful of microtasks.
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

function fetchStub() {
  const calls = [];
  let ok = true;
  globalThis.fetch = async (path) => {
    calls.push(path);
    if (ok === 'throw') throw new Error('fetch failed');
    // index.html from a static host is a 200 that is not a studio.
    if (ok === 'html') return { ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    return { ok, json: async () => ({ ok: true, service: 'hivemind-content-studio' }) };
  };
  return {
    calls,
    up() { ok = true; },
    down() { ok = 'throw'; },
    refuse() { ok = false; },
    html() { ok = 'html'; },
  };
}

test('the delay is 15 s while up and backs off to a minute while down', async () => {
  browser();
  const { heartbeatDelay, BEAT_MS, MAX_BACKOFF_MS } = await import('../src/app/statusStore.js');
  assert.equal(heartbeatDelay({ online: true }), BEAT_MS);
  assert.equal(heartbeatDelay({ online: true, failures: 9 }), BEAT_MS);
  // First miss asks again just as promptly — a studio restarting comes back fast.
  assert.equal(heartbeatDelay({ online: false, failures: 1 }), BEAT_MS);
  assert.equal(heartbeatDelay({ online: false, failures: 2 }), 2 * BEAT_MS);
  assert.equal(heartbeatDelay({ online: false, failures: 3 }), MAX_BACKOFF_MS);
  assert.equal(heartbeatDelay({ online: false, failures: 40 }), MAX_BACKOFF_MS);
});

test('the heartbeat re-asks, flips both ways, and refreshes the app on reconnect', async (t) => {
  browser();
  const server = fetchStub();
  // Date too: `since` is a wall-clock stamp, and two beats inside the same
  // millisecond would make the "the verdict is new" assertion flaky.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const store = await import('../src/app/statusStore.js');
  const { BEAT_MS, getApiStatus, startApiHeartbeat, stopApiHeartbeat } = store;
  t.after(() => { stopApiHeartbeat(); t.mock.timers.reset(); });

  let refreshes = 0;
  globalThis.window.addEventListener('hivemind-hub-refresh', () => { refreshes += 1; });

  startApiHeartbeat();
  await flush();
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0], '/healthz');
  assert.equal(getApiStatus().online, true);
  assert.equal(getApiStatus().label, 'Ready');
  // The first verdict is not a "reconnect": nothing was stale to refill.
  assert.equal(refreshes, 0);
  const readySince = getApiStatus().since;

  // The studio dies. Within one beat the whole app knows.
  server.down();
  t.mock.timers.tick(BEAT_MS);
  await flush();
  assert.equal(server.calls.length, 2);
  assert.equal(getApiStatus().online, false);
  assert.equal(getApiStatus().label, 'Not running');
  assert.notEqual(getApiStatus().since, readySince);

  // It comes back on its own — no reload, and every cached server answer is
  // told to refill (VideoStudio's workflow list rides this event).
  server.up();
  t.mock.timers.tick(BEAT_MS);
  await flush();
  assert.equal(getApiStatus().online, true);
  assert.equal(refreshes, 1);
  // A reconnect must not answer its own refresh event with a second probe.
  assert.equal(server.calls.length, 3);
});

test('a 200 that is not the studio does not count as up', async (t) => {
  browser();
  const server = fetchStub();
  const { pingApiStatus, getApiStatus } = await import('../src/app/statusStore.js');
  t.after(() => { globalThis.fetch = undefined; });
  server.html();
  await pingApiStatus();
  assert.equal(getApiStatus().online, false, 'index.html answered 200 — that is not a health check');
  assert.equal(server.calls.length, 1);
});

test('a hidden tab pauses, and comes back the moment it is looked at', async (t) => {
  browser({ hidden: true });
  const server = fetchStub();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await import('../src/app/statusStore.js');
  const { BEAT_MS, startApiHeartbeat, stopApiHeartbeat, pingApiStatus, getApiStatus } = store;
  t.after(() => { stopApiHeartbeat(); t.mock.timers.reset(); });

  // Start visible so there is a verdict to go stale.
  globalThis.document.hidden = false;
  startApiHeartbeat();
  await flush();
  assert.equal(server.calls.length, 1);

  globalThis.document.hidden = true;
  t.mock.timers.tick(BEAT_MS * 4);
  await flush();
  assert.equal(server.calls.length, 1, 'a background tab does not poll');

  // "Retry now" is a person asking, so it probes regardless.
  server.refuse();
  await pingApiStatus();
  await flush();
  assert.equal(server.calls.length, 2);
  assert.equal(getApiStatus().online, false);

  // Back on screen: the pause resumes on its next tick rather than staying dead.
  globalThis.document.hidden = false;
  server.up();
  t.mock.timers.tick(BEAT_MS);
  await flush();
  assert.equal(server.calls.length, 3);
  assert.equal(getApiStatus().online, true);
});

test('an asked-for refresh re-asks the studio too', async (t) => {
  browser();
  const server = fetchStub();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { startApiHeartbeat, stopApiHeartbeat } = await import('../src/app/statusStore.js');
  t.after(() => { stopApiHeartbeat(); t.mock.timers.reset(); });

  startApiHeartbeat();
  await flush();
  assert.equal(server.calls.length, 1);

  globalThis.window.dispatchEvent(new Event('hivemind-hub-refresh'));
  await flush();
  assert.equal(server.calls.length, 2);

  // Stopped means stopped: no timer keeps firing after the app unmounts.
  stopApiHeartbeat();
  t.mock.timers.tick(60000 * 5);
  await flush();
  assert.equal(server.calls.length, 2);
});
