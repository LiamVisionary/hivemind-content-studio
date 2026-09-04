#!/usr/bin/env node
/* One Node service for the studio's three Node surfaces.
 *
 * The stack used to run three separate Node processes on three ports: the
 * Canvas host and ComfyUI proxy (server.js, 8788), the local-inference bridge
 * (open-generative-ai/hosted-server.js, 8794) and the agent MCP endpoint
 * (bin/media-studio-mcp.mjs, 8796). Three processes meant three health
 * endpoints, three failure modes and three things to supervise, all of them
 * small and all of them serving the same single-user machine.
 *
 * This file mounts all three, unchanged, on one port:
 *
 *     /canvas/...   the Canvas host and ComfyUI proxy (server.js)
 *     /bridge/...   the local-inference bridge (hosted-server.js)
 *     /agent/mcp    the agent MCP endpoint (media-studio-mcp.mjs)
 *     /healthz      one health answer covering all three
 *
 * Each surface keeps its own dispatch table: the prefix is stripped before the
 * request reaches it, so every route answers exactly as it did on its own port
 * — including a request that carries an `Upgrade` header to a surface with no
 * WebSocket route, which is served as ordinary HTTP here exactly as the bare
 * port serves it.
 *
 * ONE thing the mounts do not do, and it is deliberate: `/canvas` is for API
 * and proxy routes, not for opening in a browser. Everything behind it emits
 * absolute asset URLs, and this mount rewrites paths inbound and never bodies
 * outbound, so a browser navigation is redirected to the compatibility port
 * rather than served HTML whose every asset would 404. See CANVAS_BROWSER_ROOTS
 * below; the bridge is unaffected (its index.html is already mount-relative).
 *
 * The three old ports keep answering. Removing one is a separate decision, and
 * until it is made the frontend, the stack script, the Tauri shell, the MCP
 * client config and any running instance all address these by number. Set
 * HIVEMIND_NODE_SERVICES_LEGACY_PORTS=0 to bring up only the shared port.
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const openGenRoot = resolve(here, '..', 'open-generative-ai');
const canvasGate = require('./lib/canvas-gate');

const HOST = process.env.HIVEMIND_NODE_SERVICES_HOST || process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.HIVEMIND_NODE_SERVICES_PORT || 8793);
// The old numbers, still read from the names each service already used, so a
// machine that overrides one of them keeps overriding it.
const CANVAS_LEGACY_PORT = Number(process.env.PORT || 8788);
const BRIDGE_LEGACY_PORT = Number(process.env.OGA_PORT || 8794);
const MCP_LEGACY_PORT = Number(process.env.MEDIA_STUDIO_MCP_PORT || process.env.ZIMG_MCP_PORT || 8796);
const LEGACY_PORTS_ENABLED = process.env.HIVEMIND_NODE_SERVICES_LEGACY_PORTS !== '0';

const MOUNTS = Object.freeze({ canvas: '/canvas', bridge: '/bridge', 'agent-mcp': '/agent' });

/** Strip a mount prefix off a request so the surface behind it sees the path it
 *  has always seen. `/canvas/mobile/api/preview?x=1` becomes
 *  `/mobile/api/preview?x=1`; a bare `/canvas` becomes `/`. */
export function stripMount(url, mount) {
  const raw = String(url || '/');
  if (raw === mount) return '/';
  if (!raw.startsWith(`${mount}/`) && !raw.startsWith(`${mount}?`) && !raw.startsWith(`${mount}#`)) return null;
  const rest = raw.slice(mount.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/** Which mount a request belongs to, or null for the shared port's own routes. */
export function mountFor(url) {
  for (const [id, mount] of Object.entries(MOUNTS)) {
    const rewritten = stripMount(url, mount);
    if (rewritten !== null) return { id, mount, url: rewritten };
  }
  return null;
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': payload.length,
  });
  res.end(payload);
}

/** Bring up whatever each surface needs, never letting one failure take the
 *  others down: a surface that will not start is reported as down by the one
 *  health endpoint instead of killing the process. */
async function loadSurfaces() {
  const surfaces = new Map();

  // Canvas: server.js has to reach Next's build before it can answer, so this
  // is the one that can genuinely fail on a checkout that was never built.
  try {
    const canvasModule = require('./server.js');
    const canvas = await canvasModule.createCanvasSurface();
    surfaces.set('canvas', {
      id: 'canvas',
      label: 'Canvas and ComfyUI proxy',
      legacyPort: CANVAS_LEGACY_PORT,
      handleRequest: canvas.handleRequest,
      handleUpgrade: canvas.handleUpgrade,
      health: () => ({ ...canvasModule.canvasHealth(), lanes: canvasModule.laneSummary() }),
    });
  } catch (error) {
    surfaces.set('canvas', failedSurface('canvas', 'Canvas and ComfyUI proxy', CANVAS_LEGACY_PORT, error));
  }

  try {
    const bridgeModule = require(join(openGenRoot, 'hosted-server.js'));
    surfaces.set('bridge', {
      id: 'bridge',
      label: 'Local model bridge',
      legacyPort: BRIDGE_LEGACY_PORT,
      handleRequest: bridgeModule.handleBridgeRequest,
      health: bridgeModule.bridgeHealth,
    });
  } catch (error) {
    surfaces.set('bridge', failedSurface('bridge', 'Local model bridge', BRIDGE_LEGACY_PORT, error));
  }

  try {
    const mcpModule = await import(pathToFileURL(join(here, 'bin', 'media-studio-mcp.mjs')).href);
    const app = mcpModule.createMcpHttpApp({ host: HOST });
    surfaces.set('agent-mcp', {
      id: 'agent-mcp',
      label: 'Agent MCP',
      legacyPort: MCP_LEGACY_PORT,
      handleRequest: (req, res) => app(req, res),
      health: mcpModule.mcpHealth,
    });
  } catch (error) {
    surfaces.set('agent-mcp', failedSurface('agent-mcp', 'Agent MCP', MCP_LEGACY_PORT, error));
  }

  return surfaces;
}

/** A surface that would not start still has to answer, or its callers get a
 *  connection refused with no reason in it. It says what is missing and what
 *  the studio loses, and the health endpoint says the same thing. */
function failedSurface(id, label, legacyPort, error) {
  const reason = (error && error.message) || String(error);
  console.error(`[node-services] ${label} did not start: ${reason}`);
  return {
    id,
    label,
    legacyPort,
    failed: reason,
    handleRequest: (req, res) => sendJson(res, 503, {
      ok: false,
      service: id,
      error: `${label} did not start on this machine.`,
      remedy: 'Restart the studio; the log for this service says what was missing.',
    }),
    health: () => ({ ok: false, service: id, error: reason }),
  };
}

function healthDocument(surfaces) {
  const detail = {};
  let allOk = true;
  for (const surface of surfaces.values()) {
    const own = surface.health();
    if (!own.ok) allOk = false;
    detail[surface.id] = {
      ...own,
      label: surface.label,
      mount: MOUNTS[surface.id],
      legacyPort: LEGACY_PORTS_ENABLED ? surface.legacyPort : null,
    };
  }
  return { ok: allOk, service: 'hivemind-node-services', host: HOST, port: PORT, surfaces: detail };
}

// `/canvas` is an API and proxy mount, not a place to open in a browser.
//
// Every page behind it emits ABSOLUTE asset URLs — Next writes `/_next/...`
// (next.config.js sets no basePath or assetPrefix), ComfyUI Mobile's build
// writes `/mobile/assets/...`, and app/mobile/[[...path]]/route.js rewrites
// `/comfy/...` in — and this mount strips the prefix on the way in without
// rewriting bodies on the way out. So the HTML would arrive and every asset in
// it would land on the shared port's 404. Rewriting three surfaces' bodies to
// be mount-relative is a real project; until someone does it, a navigation is
// sent to the compatibility port, where the Canvas genuinely works and where
// the studio's iframe and the Tauri shell already address it.
// Only roots that are unambiguously the Canvas's. A bare `/assets/` is not:
// the bridge's own index.html is mount-relative, so a page opened at `/bridge`
// without the trailing slash resolves `./assets/…` there, and it would be
// pointed at the wrong port.
const CANVAS_BROWSER_ROOTS = ['/_next/', '/mobile/', '/comfy/'];

/** The shared port's own dispatch: one health answer, then the three mounts.
 *  Exported so the mount's behaviour can be tested over a real socket without
 *  a Next build behind it. */
export function sharedHandler(surfaces) {
  return (req, res) => {
    const url = req.url || '/';
    const pathname = url.split('?')[0].split('#')[0];
    if ((pathname === '/healthz' || pathname === '/health' || pathname === '/')
      && (req.method === 'GET' || req.method === 'HEAD')) {
      const body = healthDocument(surfaces);
      sendJson(res, body.ok ? 200 : 503, body);
      return;
    }
    const target = mountFor(url);
    if (!target) {
      // A `/_next/...` or `/mobile/assets/...` request here is a page that was
      // opened on the wrong port, so the 404 says which port it wanted rather
      // than leaving a blank screen and a mounts list to interpret.
      const strayCanvasAsset = CANVAS_BROWSER_ROOTS.some((root) => pathname.startsWith(root));
      sendJson(res, 404, {
        ok: false,
        error: 'No service is mounted at this path.',
        ...(strayCanvasAsset ? { remedy: canvasBrowserRemedy() } : {}),
        mounts: MOUNTS,
      });
      return;
    }
    if (target.id === 'canvas' && isBrowserNavigation(req)) {
      const location = canvasBrowserUrl(req, target.url);
      if (location) {
        res.writeHead(302, { location, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      sendJson(res, 404, {
        ok: false,
        error: 'The Canvas is not served on this port.',
        remedy: canvasBrowserRemedy(),
      });
      return;
    }
    req.url = target.url;
    surfaces.get(target.id).handleRequest(req, res);
  };
}

/** A person typing a URL in, as opposed to the page's own fetch/XHR. Same
 *  predicate the credential gate uses, so the two cannot disagree. */
function isBrowserNavigation(req) {
  return canvasGate.wantsHtml(req);
}

function canvasBrowserRemedy() {
  return LEGACY_PORTS_ENABLED
    ? `Open the Canvas on http://${HOST}:${CANVAS_LEGACY_PORT} instead; ${MOUNTS.canvas} on this port serves its API and proxy routes only.`
    : `${MOUNTS.canvas} on this port serves API and proxy routes only, and the compatibility port is switched off (HIVEMIND_NODE_SERVICES_LEGACY_PORTS=0). Start it to open the Canvas in a browser.`;
}

/** Where the same path is actually browsable, or null when nothing serves it. */
function canvasBrowserUrl(req, strippedUrl) {
  if (!LEGACY_PORTS_ENABLED) return null;
  const host = String(req.headers.host || `${HOST}:${PORT}`).replace(/:\d+$/, '') || HOST;
  return `http://${host}:${CANVAS_LEGACY_PORT}${strippedUrl}`;
}

/** Answer an upgrade request the way a server with no `upgrade` listener would.
 *
 *  Node only routes a request to `'upgrade'` when a listener is registered; with
 *  none, it clears `req.upgrade` and the request is served as ordinary HTTP.
 *  The three legacy ports register a listener only for the Canvas, so `GET
 *  /local-ai/models` with `Upgrade: websocket` answers 200 on 8794 — while the
 *  shared port, which needs ONE listener for all three mounts, used to destroy
 *  the socket with no reply. That is the mount diverging from the port it
 *  replaces, so the fallback is to serve the request rather than drop it.
 *
 *  `head` is everything the parser read past the headers, which is the whole
 *  body of an upgrade request. `unshift` puts it back before `'end'` is emitted
 *  (`push` would throw: the parser already signalled EOF). Nothing frames it
 *  after that, so Content-Length has to be honoured here or a pipelined byte
 *  would arrive as body — the bare port's parser stops at the declared length
 *  and so does this. The one visible difference from the bare port is that this
 *  connection closes after the answer instead of staying keep-alive. */
function serveUpgradeAsRequest(surface, req, socket, head) {
  const res = new http.ServerResponse(req);
  res.assignSocket(socket);
  res.on('finish', () => { res.detachSocket(socket); socket.end(); });
  socket.on('error', () => { /* a client that hung up mid-answer is not an error here */ });
  const declared = Number(req.headers['content-length']);
  const body = head && head.length
    ? (Number.isFinite(declared) && declared >= 0 ? head.subarray(0, declared) : head)
    : null;
  if (body && body.length) req.unshift(body);
  surface.handleRequest(req, res);
}

export function sharedUpgradeHandler(surfaces) {
  return (req, socket, head) => {
    const target = mountFor(req.url || '/');
    const surface = target && surfaces.get(target.id);
    if (!surface) {
      socket.destroy();
      return;
    }
    req.url = target.url;
    if (typeof surface.handleUpgrade !== 'function') {
      serveUpgradeAsRequest(surface, req, socket, head);
      return;
    }
    surface.handleUpgrade(req, socket, head);
  };
}

function listen(server, port, host, description) {
  return new Promise((resolveListen) => {
    server.once('error', (error) => {
      console.error(`[node-services] ${description} could not bind ${host}:${port}: ${error.message}`);
      resolveListen(false);
    });
    server.listen(port, host, () => {
      console.log(`[node-services] ${description} on http://${host}:${port}`);
      resolveListen(true);
    });
  });
}

export async function start() {
  const surfaces = await loadSurfaces();

  const shared = http.createServer(sharedHandler(surfaces));
  shared.on('upgrade', sharedUpgradeHandler(surfaces));
  await listen(shared, PORT, HOST, 'all three surfaces');

  const servers = [shared];
  if (LEGACY_PORTS_ENABLED) {
    // The three old ports, each serving its own surface unprefixed — the same
    // bytes on the same number as before, from one process instead of three.
    for (const surface of surfaces.values()) {
      const legacy = http.createServer(surface.handleRequest);
      if (typeof surface.handleUpgrade === 'function') legacy.on('upgrade', surface.handleUpgrade);
      await listen(legacy, surface.legacyPort, HOST, `${surface.label} (compatibility port)`);
      servers.push(legacy);
    }
  }

  // Last line of defence: log the kind of failure (never a payload — these
  // requests carry prompts and pictures) and keep serving the other callers.
  process.on('unhandledRejection', (reason) => {
    const name = reason && reason.name ? reason.name : typeof reason;
    console.error(`[node-services] unhandled rejection (${name}); the service stays up`);
  });

  return { servers, surfaces, health: () => healthDocument(surfaces) };
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
})();

if (invokedDirectly) {
  start().catch((error) => {
    console.error('[node-services] failed to start:', error);
    process.exit(1);
  });
}
