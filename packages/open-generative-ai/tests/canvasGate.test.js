// The Canvas port (8788) used to authenticate nothing while attaching the
// gateway's master token to everything it forwarded — so anything that could
// reach the port could queue ComfyUI graphs and read the whole library, and the
// stack published that port on the tailnet at boot. These pin the gate that
// replaced that: who gets in, who does not, and what a refusal tells them.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACCOUNT_COOKIE,
  createCanvasGate,
  isHealthProbe,
  presentedGatewayToken,
  refusal,
  signInUrl,
} = require('../../media-gateway/lib/canvas-gate.js');

const TOKEN = 'gateway-token-abcdefghijklmnop';
const STUDIO = 'http://127.0.0.1:8765';

function request({ url = '/mobile/', method = 'GET', headers = {} } = {}) {
  return { url, method, headers: { host: '127.0.0.1:8788', ...headers } };
}

function gate({ token = TOKEN, verify = async () => false, now } = {}) {
  return createCanvasGate({
    readGatewayToken: () => token,
    verifyAccountCookie: verify,
    ...(now ? { now } : {}),
  });
}

test('an unauthenticated request is refused', async () => {
  const decision = await gate().authorize(request(), '/mobile/');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'no-credentials');
});

test('every ComfyUI pass-through path is refused the same way', async () => {
  const g = gate();
  for (const path of ['/comfy/prompt', '/prompt', '/upload/image', '/view', '/api/history', '/mobile/api/comfy/queue']) {
    const decision = await g.authorize(request({ url: path, method: 'POST' }), path);
    assert.equal(decision.allowed, false, `${path} must not be reachable without a credential`);
  }
});

test('the gateway bearer token passes — agents and the MCP have no session', async () => {
  const g = gate();
  for (const headers of [
    { authorization: `Bearer ${TOKEN}` },
    { 'x-token': TOKEN },
    { cookie: `zimg_token=${TOKEN}` },
  ]) {
    const decision = await g.authorize(request({ headers }), '/api/history');
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'gateway-token');
  }
});

test('a wrong token is not a token', async () => {
  const decision = await gate().authorize(
    request({ headers: { authorization: 'Bearer not-the-token-at-all-x' } }),
    '/api/history',
  );
  assert.equal(decision.allowed, false);
});

test('an account cookie passes once the control API vouches for it', async () => {
  const asked = [];
  const g = gate({ verify: async (value) => { asked.push(value); return value === 'good-session'; } });

  const ok = await g.authorize(request({ headers: { cookie: `${ACCOUNT_COOKIE}=good-session` } }), '/mobile/');
  assert.equal(ok.allowed, true);
  assert.equal(ok.reason, 'account-cookie');
  assert.deepEqual(asked, ['good-session']);

  const stale = await g.authorize(request({ headers: { cookie: `${ACCOUNT_COOKIE}=signed-out` } }), '/mobile/');
  assert.equal(stale.allowed, false);
  assert.equal(stale.reason, 'session-invalid');
});

test('the session answer is cached, so a reconnect is not a request storm', async () => {
  let calls = 0;
  let clock = 0;
  const g = gate({ verify: async () => { calls += 1; return true; }, now: () => clock });
  const req = request({ headers: { cookie: `${ACCOUNT_COOKIE}=good` } });

  await Promise.all([g.authorize(req, '/mobile/'), g.authorize(req, '/mobile/')]);
  await g.authorize(req, '/mobile/');
  assert.equal(calls, 1);

  clock = 60_000;
  await g.authorize(req, '/mobile/');
  assert.equal(calls, 2, 'the cache expires rather than pinning a signed-out session open');
});

test('a cookie that is not shaped like a session is never sent upstream', async () => {
  // The value is copied into an outbound Cookie header on the session probe, so
  // anything with a space, a quote or a control character is refused here
  // rather than handed to Node to throw on mid-probe.
  const asked = [];
  const g = gate({ verify: async (value) => { asked.push(value); return true; } });
  for (const value of ['a b', 'a\r\nX-Evil: 1', '"quoted"', '']) {
    const decision = await g.authorize(
      request({ headers: { cookie: `${ACCOUNT_COOKIE}=${value}` } }),
      '/mobile/',
    );
    assert.equal(decision.allowed, false);
  }
  assert.deepEqual(asked, []);
});

test('a control API that cannot answer refuses rather than falling open', async () => {
  const g = gate({ verify: async () => { throw new Error('connection refused'); } });
  const decision = await g.authorize(request({ headers: { cookie: `${ACCOUNT_COOKIE}=good` } }), '/mobile/');
  assert.equal(decision.allowed, false);
});

test('only a bare health probe is exempt', async () => {
  assert.equal(isHealthProbe('/healthz', 'GET'), true);
  assert.equal(isHealthProbe('/healthz', 'POST'), false);
  assert.equal(isHealthProbe('/', 'GET'), false);
  assert.equal(isHealthProbe('/healthz/../api/history', 'GET'), false);

  const decision = await gate().authorize(request({ url: '/healthz' }), '/healthz');
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'health');
});

test('a token in the query string is still the token it always was', () => {
  assert.equal(presentedGatewayToken(request({ url: `/mobile/?token=${TOKEN}` })), TOKEN);
  assert.equal(presentedGatewayToken(request()), '');
});

// ── the refusal names its own fix ────────────────────────────────────────────

test('an unauthenticated navigation is sent to the studio sign-in gate', () => {
  const answer = refusal(request({ headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' } }), STUDIO);
  assert.equal(answer.status, 302);
  assert.equal(answer.headers.location, 'http://127.0.0.1:8765/');
});

test('an XHR gets 401 JSON that says where to sign in', () => {
  const answer = refusal(request({ headers: { 'sec-fetch-mode': 'cors', accept: 'application/json' } }), STUDIO);
  assert.equal(answer.status, 401);
  const body = JSON.parse(answer.body);
  assert.equal(body.privacy, 'account-locked');
  assert.equal(body.sign_in_url, 'http://127.0.0.1:8765/');
  // A problem is never presented without its fix, and never as backend text.
  assert.match(body.detail, /sign in/i);
  assert.doesNotMatch(body.error, /proxy|upstream|ECONNREFUSED/i);
});

test('the sign-in URL keeps the host the person actually typed', () => {
  assert.equal(signInUrl(request({ headers: { host: 'localhost:8788' } }), STUDIO), 'http://localhost:8765/');
  assert.equal(
    signInUrl(request({ headers: { host: 'studio.tailnet.example', 'x-forwarded-proto': 'https' } }), STUDIO),
    'https://studio.tailnet.example:8765/',
  );
});
