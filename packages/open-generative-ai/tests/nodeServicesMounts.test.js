// The mounts on the shared port, over real sockets.
//
// nodeServicesCollapse.test.js reads the collapse out of the source text. These
// two things cannot be read out of text, because both are about what Node does
// with a connection rather than what the dispatch table says:
//
//   * a request carrying `Upgrade` to a surface with no WebSocket route. The
//     three legacy servers register an `upgrade` listener only for the Canvas,
//     and Node serves an upgrade request as ordinary HTTP when no listener
//     exists — so 8794 answered 200 while the shared port, which needs one
//     listener for all three mounts, destroyed the socket with no reply. The
//     mount is documented as answering exactly as the bare port does, and this
//     is the one case where it did not.
//
//   * `/canvas` in a browser. It cannot serve the Canvas UI: everything behind
//     it emits absolute asset URLs (`/_next/…`, `/mobile/assets/…`, `/comfy/…`)
//     and the mount rewrites paths inbound, never bodies outbound — so the HTML
//     would load and every asset in it would 404 on the shared port. A mount
//     that looks like it works and does not is the state to rule out, so a
//     navigation is sent to the port where the Canvas actually answers.
//
// The surfaces here are stubs on purpose: the real Canvas needs a Next
// production build, and neither behaviour depends on what a surface returns.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const collapsedPath = path.join(__dirname, '../../media-gateway/node-services.mjs');
const collapsed = () => import(pathToFileURL(collapsedPath).href);

/** A surface that echoes what it received, so a difference is visible. */
function echoSurface(id, { upgrade = false } = {}) {
  const surface = {
    id,
    label: id,
    legacyPort: 0,
    handleRequest(req, res) {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.stringify({ id, url: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      });
    },
    health: () => ({ ok: true, service: id }),
  };
  if (upgrade) {
    surface.handleUpgrade = (req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n\r\n');
      socket.destroy();
    };
  }
  return surface;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

/** Raw request, so the Upgrade header survives — no HTTP client will send it. */
function raw(port, lines) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`${lines.join('\r\n')}\r\n\r\n`));
    let seen = '';
    socket.on('data', (chunk) => { seen += chunk; });
    socket.on('close', () => resolve(seen || 'CLOSED-WITH-NO-RESPONSE'));
    socket.on('error', () => resolve('CLOSED-WITH-NO-RESPONSE'));
    setTimeout(() => { socket.destroy(); resolve(seen || 'CLOSED-WITH-NO-RESPONSE'); }, 2000);
  });
}

/** Everything but the headers a connection's own lifetime decides. */
function comparable(answer) {
  return answer
    .split('\r\n')
    .filter((line) => !/^(Date|Keep-Alive|Connection):/i.test(line))
    .join('\r\n');
}

async function bothPorts(t, surface) {
  const { sharedHandler, sharedUpgradeHandler } = await collapsed();
  const surfaces = new Map([
    ['canvas', echoSurface('canvas', { upgrade: true })],
    [surface.id, surface],
  ]);

  // The bare port, exactly as start() brings a legacy port up for a surface
  // with no upgrade handler: a request handler and nothing else.
  const bare = http.createServer(surface.handleRequest);
  const shared = http.createServer(sharedHandler(surfaces));
  shared.on('upgrade', sharedUpgradeHandler(surfaces));
  const barePort = await listen(bare);
  const sharedPort = await listen(shared);
  t.after(() => { bare.close(); shared.close(); });
  return { barePort, sharedPort };
}

test('an upgrade request to a surface with no WebSocket route answers as it does on its own port', async (t) => {
  const bridge = echoSurface('bridge');
  const { barePort, sharedPort } = await bothPorts(t, bridge);

  const onBare = await raw(barePort, [
    'GET /local-ai/models HTTP/1.1',
    `Host: 127.0.0.1:${barePort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
  ]);
  const onMount = await raw(sharedPort, [
    'GET /bridge/local-ai/models HTTP/1.1',
    `Host: 127.0.0.1:${sharedPort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
  ]);

  assert.notEqual(onMount, 'CLOSED-WITH-NO-RESPONSE', 'the mount dropped an upgrade the bare port answers');
  assert.equal(comparable(onMount), comparable(onBare));
  assert.match(onMount, /"url":"\/local-ai\/models"/);
});

test('a body that arrived with the upgrade headers still reaches the surface', async (t) => {
  // Node hands everything past the headers to the upgrade listener, so a
  // fallback that forgot it would silently deliver an empty body.
  const agent = echoSurface('agent-mcp');
  const { barePort, sharedPort } = await bothPorts(t, agent);
  const payload = '{"jsonrpc":"2.0"}';

  const onBare = await raw(barePort, [
    'POST /mcp HTTP/1.1',
    `Host: 127.0.0.1:${barePort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Content-Type: application/json',
    `Content-Length: ${payload.length}`,
    '',
    payload,
  ]);
  const onMount = await raw(sharedPort, [
    'POST /agent/mcp HTTP/1.1',
    `Host: 127.0.0.1:${sharedPort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Content-Type: application/json',
    `Content-Length: ${payload.length}`,
    '',
    payload,
  ]);

  assert.match(onBare, /\\"jsonrpc\\":\\"2.0\\"/);
  assert.equal(comparable(onMount), comparable(onBare));
});

test('a surface that owns its upgrades still gets them', async (t) => {
  const bridge = echoSurface('bridge');
  const { sharedPort } = await bothPorts(t, bridge);
  const answer = await raw(sharedPort, [
    'GET /canvas/ws HTTP/1.1',
    `Host: 127.0.0.1:${sharedPort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
  ]);
  assert.match(answer, /^HTTP\/1\.1 101 /);
});

test('an upgrade to no mount at all is still closed', async (t) => {
  const bridge = echoSurface('bridge');
  const { sharedPort } = await bothPorts(t, bridge);
  const answer = await raw(sharedPort, [
    'GET /nowhere HTTP/1.1',
    `Host: 127.0.0.1:${sharedPort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
  ]);
  assert.equal(answer, 'CLOSED-WITH-NO-RESPONSE');
});

test('a browser navigating to /canvas is sent to the port that can serve it', async (t) => {
  const bridge = echoSurface('bridge');
  const { sharedPort } = await bothPorts(t, bridge);
  const answer = await raw(sharedPort, [
    'GET /canvas/mobile/ HTTP/1.1',
    `Host: 127.0.0.1:${sharedPort}`,
    'Sec-Fetch-Mode: navigate',
    'Accept: text/html',
    'Connection: close',
  ]);
  assert.match(answer, /^HTTP\/1\.1 302 /);
  // The path it asked for, on the compatibility port, on the host it typed.
  assert.match(answer, /location: http:\/\/127\.0\.0\.1:8788\/mobile\/\r\n/i);
});

test("the page's own fetches are proxied, not redirected — /canvas is an API mount", async (t) => {
  const bridge = echoSurface('bridge');
  const { sharedPort } = await bothPorts(t, bridge);
  const answer = await raw(sharedPort, [
    'GET /canvas/mobile/api/preview?filename=x.png HTTP/1.1',
    `Host: 127.0.0.1:${sharedPort}`,
    'Sec-Fetch-Mode: cors',
    'Accept: application/json',
    'Connection: close',
  ]);
  assert.match(answer, /^HTTP\/1\.1 200 /);
  assert.match(answer, /"url":"\/mobile\/api\/preview\?filename=x\.png"/);
});

test('an asset a Canvas page would ask for absolutely 404s with the port it wanted', async (t) => {
  const bridge = echoSurface('bridge');
  const { sharedPort } = await bothPorts(t, bridge);
  for (const stray of ['/_next/static/chunks/main.js', '/mobile/assets/index.js', '/comfy/api/queue']) {
    const answer = await raw(sharedPort, [
      `GET ${stray} HTTP/1.1`,
      `Host: 127.0.0.1:${sharedPort}`,
      'Connection: close',
    ]);
    assert.match(answer, /^HTTP\/1\.1 404 /, stray);
    // Never a problem without its fix: the 404 names the port that serves it.
    assert.match(answer, /8788/, stray);
  }
});
