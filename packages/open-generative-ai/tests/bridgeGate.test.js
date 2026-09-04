// The local-inference bridge, gated like the surface beside it.
//
// The bridge attaches the gateway's capability token to everything it forwards
// — it queues local generations and it spends the owner's Civitai key — and
// authenticated nothing of its own. Loopback binding was not doing that job:
// `fromLoopback` stops a rebound DNS name, but a page on any other site can aim
// a CORS-simple `text/plain` POST at 127.0.0.1:8794 and the request goes
// through. So the same gate the Canvas uses now stands in front of it, on the
// bare port AND under the `/bridge` mount, because they are one handler.
//
// These run against a real socket on both shapes. The one exemption is
// liveness: the supervisor, the Tauri shell and unified_runtime.py all poll
// `GET /health` before anybody has signed in.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOKEN = 'bridge-gateway-token-abcdefgh';

// The bridge reads its token file and its studio target at require time, so
// both are settled before the module is loaded.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-gate-'));
fs.writeFileSync(path.join(stateDir, 'zimg-token'), `${TOKEN}\n`, 'utf8');
process.env.ZIMAGE_TOKEN_FILE = path.join(stateDir, 'zimg-token');

// A stand-in control API: the only session it vouches for is "good-session".
const sessions = http.createServer((req, res) => {
  const cookie = String(req.headers.cookie || '');
  const ok = req.url.startsWith('/api/owner/session') && cookie.includes('=good-session');
  res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ unlocked: ok }));
});
sessions.listen(0, '127.0.0.1');

// Bound before hosted-server.js is required: it resolves the studio target once.
const sessionsReady = new Promise((resolve) => sessions.once('listening', () => {
  process.env.HIVEMIND_STUDIO_TARGET = `http://127.0.0.1:${sessions.address().port}`;
  resolve();
}));

const bare = http.createServer();
// The mount: node-services.mjs strips `/bridge` and hands the same handler the
// path it has always seen. Anything true on one has to be true on the other.
const mounted = http.createServer();

const ready = sessionsReady.then(async () => {
  const { handleBridgeRequest } = require('../hosted-server.js');
  const { mountFor } = await import(require('node:url').pathToFileURL(
    path.join(__dirname, '../../media-gateway/node-services.mjs'),
  ).href);
  // The bare port: hosted-server.js run as the program.
  bare.on('request', handleBridgeRequest);
  mounted.on('request', (req, res) => {
    const target = mountFor(req.url || '/');
    if (!target || target.id !== 'bridge') { res.writeHead(404); res.end(); return; }
    req.url = target.url;
    handleBridgeRequest(req, res);
  });
  await Promise.all([
    new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => mounted.listen(0, '127.0.0.1', resolve)),
  ]);
});

test.after(() => { bare.close(); mounted.close(); sessions.close(); });

/** The same request against both shapes; a difference is a bug in the mount. */
async function bothWays(routePath, options = {}) {
  await ready;
  const call = (port, prefix) => new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: `${prefix}${routePath}`,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        location: response.headers.location || '',
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
  const [onBare, onMount] = await Promise.all([
    call(bare.address().port, ''),
    call(mounted.address().port, '/bridge'),
  ]);
  assert.deepEqual(onMount, onBare, `${routePath} answered differently under the mount`);
  return onBare;
}

test('an unauthenticated read of the model library is refused on both paths', async () => {
  for (const route of ['/local-ai/library', '/local-ai/models', '/local-ai/civitai-search', '/local-ai/binary-status']) {
    const answer = await bothWays(route);
    assert.equal(answer.status, 401, route);
    const payload = JSON.parse(answer.body);
    assert.equal(payload.privacy, 'account-locked');
    // Never a problem without its fix, and never backend text.
    assert.match(payload.error, /sign in to the studio/i);
    assert.match(payload.sign_in_url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.doesNotMatch(answer.body, /ECONNREFUSED|Traceback|\/Users\//);
  }
});

test('an unauthenticated POST cannot spend anything', async () => {
  // The CSRF shape: a form-simple content type, which readBody never checked.
  for (const route of ['/local-ai/generate', '/local-ai/civitai-download', '/local-ai/upscale']) {
    const answer = await bothWays(route, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"prompt":"x"}',
    });
    assert.equal(answer.status, 401, route);
  }
});

test('the studio dist behind this port is account-locked too', async () => {
  // serveStatic used to hand the whole built app to anyone; a navigation now
  // lands on the sign-in gate instead of a 401 with nothing to press.
  const answer = await bothWays('/', {
    headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
  });
  assert.equal(answer.status, 302);
  assert.match(answer.location, /^http:\/\/127\.0\.0\.1:\d+\/$/);
});

test('liveness is the one thing that answers without a credential', async () => {
  for (const route of ['/health', '/healthz']) {
    const answer = await bothWays(route);
    assert.equal(answer.status, 200, route);
    const payload = JSON.parse(answer.body);
    assert.equal(payload.ok, true);
    // Liveness and where its gateway is — no models, no library, no paths.
    assert.doesNotMatch(answer.body, /\/Users\/|Application Support/);
  }
});

test('a health path is only exempt as a bare GET or HEAD', async () => {
  const answer = await bothWays('/health', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(answer.status, 401);
});

test('the gateway token gets in — agents and the control API have no session', async () => {
  for (const headers of [
    { authorization: `Bearer ${TOKEN}` },
    { 'x-token': TOKEN },
    { cookie: `zimg_token=${TOKEN}` },
  ]) {
    const answer = await bothWays('/local-ai/binary-status', { headers });
    assert.equal(answer.status, 200);
    assert.equal(JSON.parse(answer.body).hosted, true);
  }
});

test('a wrong token is not a token', async () => {
  const answer = await bothWays('/local-ai/binary-status', {
    headers: { authorization: 'Bearer not-the-token-at-all-xy' },
  });
  assert.equal(answer.status, 401);
});

test('the studio session cookie gets in, so the browser reaches its own bridge', async () => {
  const ok = await bothWays('/local-ai/binary-status', {
    headers: { cookie: 'hivemind_content_studio_account=good-session' },
  });
  assert.equal(ok.status, 200);

  const signedOut = await bothWays('/local-ai/binary-status', {
    headers: { cookie: 'hivemind_content_studio_account=stale-session' },
  });
  assert.equal(signedOut.status, 401);
});
