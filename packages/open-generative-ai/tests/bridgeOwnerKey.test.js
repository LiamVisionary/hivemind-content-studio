// The workspace's vault key rides with every job this bridge starts.
//
// The studio sends `X-E2E-Owner-Pub` — the signed-in workspace's vault public
// key — with each request that starts a gateway job, and the gateway seals the
// job's outputs to whatever key arrives on the submit. This bridge sits between
// the two and used to forward a body and its own token, nothing else: the key
// was dropped here, the gateway fell back to a single machine-wide vault path
// (nobody's, on a machine with more than one workspace), and every local
// render was written as a legacy server-decryptable file.
//
// Runs against real sockets: a stand-in gateway records what it is handed.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOKEN = 'bridge-gateway-token-abcdefgh';
const OWNER_PUB = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' + 'x'.repeat(90);

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-owner-key-'));
fs.writeFileSync(path.join(stateDir, 'zimg-token'), `${TOKEN}\n`, 'utf8');
process.env.ZIMAGE_TOKEN_FILE = path.join(stateDir, 'zimg-token');

// The stand-in control API vouches for one session.
const sessions = http.createServer((req, res) => {
  const ok = req.url.startsWith('/api/owner/session') && String(req.headers.cookie || '').includes('=good-session');
  res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ unlocked: ok }));
});

// The stand-in gateway: remembers the headers of every submit it receives.
const seen = [];
const gateway = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    seen.push({ url: req.url, ownerPub: req.headers['x-e2e-owner-pub'], authorization: req.headers.authorization });
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'job-1', status: 'queued' }));
  });
});

const bridge = http.createServer();

const ready = Promise.all([
  new Promise((resolve) => sessions.listen(0, '127.0.0.1', resolve)),
  new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve)),
]).then(async () => {
  process.env.HIVEMIND_STUDIO_TARGET = `http://127.0.0.1:${sessions.address().port}`;
  process.env.ZIMAGE_API_URL = `http://127.0.0.1:${gateway.address().port}`;
  const { handleBridgeRequest } = require('../hosted-server.js');
  bridge.on('request', handleBridgeRequest);
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
});

test.after(() => { bridge.close(); gateway.close(); sessions.close(); });

function submit(routePath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1',
      port: bridge.address().port,
      path: routePath,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        cookie: 'hivemind_content_studio_account=good-session',
        ...extraHeaders,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

test('the workspace key sent with an upscale reaches the gateway, with the bridge token beside it', async () => {
  await ready;
  seen.length = 0;
  const answer = await submit('/local-ai/upscale', { image_base64: 'data:image/png;base64,AAAA' }, { 'x-e2e-owner-pub': OWNER_PUB });
  assert.equal(answer.status, 202, answer.body);
  assert.equal(JSON.parse(answer.body).id, 'job-1');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/api/upscale');
  assert.equal(seen[0].ownerPub, OWNER_PUB);
  assert.equal(seen[0].authorization, `Bearer ${TOKEN}`);
});

test('a submit without a key sends none — the gateway keeps its own fallback', async () => {
  await ready;
  seen.length = 0;
  const answer = await submit('/local-ai/smart-mask', { image_base64: 'data:image/png;base64,AAAA' });
  assert.equal(answer.status, 202, answer.body);
  assert.equal(seen[0].url, '/api/smart-mask');
  assert.equal(seen[0].ownerPub, undefined);
});

test('a value that is not a public key is not forwarded as one', async () => {
  await ready;
  seen.length = 0;
  const answer = await submit('/local-ai/upscale', { image_base64: 'data:image/png;base64,AAAA' }, { 'x-e2e-owner-pub': 'not a key; ' + 'y'.repeat(200) });
  assert.equal(answer.status, 202, answer.body);
  assert.equal(seen[0].ownerPub, undefined);
});

// Deliberately textual: this is an absence claim over every job-starting route,
// and hosted-server.js is a Node HTTP bridge with no rendered form — the three
// tests above drive the mechanism itself over real sockets. What sockets cannot
// show is the route that is NOT here yet: a seventh handler added without the
// spread would seal to the machine key and no passing test would notice, so the
// six call sites are read as a set.
test('every route that starts a job forwards the key', () => {
  // The submit calls are the six routes the studio proxy knows as
  // job-starting (JOB_STARTING_ROUTES in api/bridge.py); a new one added
  // without the spread would silently seal to the machine key again.
  const source = fs.readFileSync(path.join(__dirname, '../hosted-server.js'), 'utf8');
  for (const route of ['generate', 'interpolate', 'smart-mask', 'ltx-director', 'episode', 'upscale']) {
    const at = source.indexOf(`requestJson(\`\${ZIMAGE_URL}/api/${route}\``);
    assert.ok(at > 0, route);
    const call = source.slice(at, source.indexOf('});', at));
    assert.match(call, /\.\.\.ownerPubHeaders\(req\)/, `${route} drops the workspace key`);
  }
});
