// The Canvas gate over a real socket.
//
// The unit tests next door prove the decision table. These prove the two things
// that only a live server can: a POST body still arrives intact after an
// asynchronous gate (the session probe is a network round trip, and dropping
// bodies would break every generation queued from the Canvas), and a refused
// WebSocket upgrade closes with a status line instead of hanging.
//
// Deliberately textual: which host the Canvas URL is built on is what decides
// whether the session cookie is in scope for the iframe.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  ACCOUNT_COOKIE,
  createCanvasGate,
  isHealthProbe,
  refusal,
} = require('../../media-gateway/lib/canvas-gate.js');

const TOKEN = 'gateway-token-abcdefghijklmnop';
const STUDIO = 'http://127.0.0.1:8765';

// The same three branches server.js wires around its dispatch: health, gate,
// then the real handler.
function startServer({ verifyDelayMs = 5 } = {}) {
  const seen = [];
  const gate = createCanvasGate({
    readGatewayToken: () => TOKEN,
    verifyAccountCookie: (value) => new Promise((resolve) => {
      setTimeout(() => resolve(value === 'good-session'), verifyDelayMs);
    }),
  });

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (isHealthProbe(pathname, req.method)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    gate.authorize(req, pathname).then((decision) => {
      if (!decision.allowed) {
        const answer = refusal(req, STUDIO);
        res.writeHead(answer.status, answer.headers);
        res.end(answer.body);
        return;
      }
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        seen.push({ pathname, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ forwarded: body }));
      });
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    gate.authorize(req, pathname).then((decision) => {
      if (!decision.allowed) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.end();
    });
    void head;
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

function call(port, { method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function upgrade(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/ws',
      headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers },
    });
    req.on('upgrade', (res) => resolve({ status: res.statusCode }));
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', reject);
    req.end();
  });
}

test('an anonymous caller is refused; the token and the session both get through', async (t) => {
  const { server, seen, port } = await startServer();
  t.after(() => server.close());

  const anonymous = await call(port, { method: 'POST', path: '/prompt', body: '{"prompt":{}}' });
  assert.equal(anonymous.status, 401);
  assert.equal(JSON.parse(anonymous.body).privacy, 'account-locked');
  assert.equal(seen.length, 0, 'nothing anonymous reaches the proxy');

  // The body survives the async gate — this is the whole reason for the test.
  const agent = await call(port, {
    method: 'POST',
    path: '/prompt',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{"prompt":{"1":{}}}',
  });
  assert.equal(agent.status, 200);
  assert.equal(JSON.parse(agent.body).forwarded, '{"prompt":{"1":{}}}');

  // The Canvas iframe: same host as the studio, so the session cookie rides
  // along, and the gate has to wait for a real round trip before forwarding.
  const canvas = await call(port, {
    method: 'POST',
    path: '/prompt',
    headers: { cookie: `${ACCOUNT_COOKIE}=good-session`, 'content-type': 'application/json' },
    body: '{"prompt":{"2":{}}}',
  });
  assert.equal(canvas.status, 200);
  assert.equal(JSON.parse(canvas.body).forwarded, '{"prompt":{"2":{}}}');
  assert.equal(seen.length, 2);
});

test('a browser that navigates to the Canvas port lands on the sign-in gate', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const response = await call(port, {
    path: '/mobile/',
    headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, 'http://127.0.0.1:8765/');
});

test('the supervisor can still see the child is alive', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const health = await call(port, { path: '/healthz' });
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);
});

test('the Canvas WebSocket opens with the session and is refused without it', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  assert.equal((await upgrade(port)).status, 401);
  assert.equal((await upgrade(port, { cookie: `${ACCOUNT_COOKIE}=good-session` })).status, 101);
  assert.equal((await upgrade(port, { authorization: `Bearer ${TOKEN}` })).status, 101);
});

test('the studio builds the Canvas URL on its own host, so the session cookie is in scope', () => {
  // Cookies are scoped by host and not by port, and 8765/8788 are the same
  // site — which is the whole reason the account cookie can gate 8788. A build
  // that reached a different HOST would silently sign the Canvas out.
  const source = fs.readFileSync(path.join(__dirname, '../src/hub/hubData.js'), 'utf8');
  const builder = source.slice(source.indexOf('export function gatewayUrl'));
  assert.match(builder.slice(0, 300), /location\.hostname/);
});
