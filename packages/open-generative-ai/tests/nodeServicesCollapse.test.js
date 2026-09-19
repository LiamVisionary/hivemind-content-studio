// Three Node servers became one.
//
// The Canvas host and ComfyUI proxy (8788), the local-inference bridge (8794)
// and the agent MCP (8796) are now three surfaces of one process, mounted on
// path prefixes of a single port. These are the two things that decide whether
// a request still lands where it used to: the prefix routing, and the fact that
// each entry point still listens on its own port when it IS the program.
//
// Deliberately textual: the subjects are a bash supervisor script and three
// Node entry points. There is no component here to mount — what is being
// asserted is that the stack script starts one child instead of three and that
// each old port still has an owner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gatewayRoot = path.join(__dirname, '../../media-gateway');
const collapsedPath = path.join(gatewayRoot, 'node-services.mjs');

async function collapsed() {
  // Dynamic import: the collapsed entry is ESM, and importing it starts
  // nothing — it only listens when it is argv[1].
  return import(require('node:url').pathToFileURL(collapsedPath).href);
}

test('a mount prefix is stripped so each surface sees the path it always saw', async () => {
  const { stripMount } = await collapsed();
  assert.equal(stripMount('/canvas/mobile/api/preview?filename=x.png', '/canvas'), '/mobile/api/preview?filename=x.png');
  assert.equal(stripMount('/canvas/comfy/api/history/abc', '/canvas'), '/comfy/api/history/abc');
  assert.equal(stripMount('/bridge/local-ai/models', '/bridge'), '/local-ai/models');
  assert.equal(stripMount('/agent/mcp', '/agent'), '/mcp');
  // A bare mount is that surface's root, not a 404.
  assert.equal(stripMount('/canvas', '/canvas'), '/');
  assert.equal(stripMount('/canvas?token=x', '/canvas'), '/?token=x');
});

test('a path that only looks like a mount is not routed to that surface', async () => {
  const { stripMount, mountFor } = await collapsed();
  // `/canvasx` shares a prefix with `/canvas` and belongs to neither.
  assert.equal(stripMount('/canvasx/queue', '/canvas'), null);
  assert.equal(mountFor('/canvasx/queue'), null);
  assert.equal(mountFor('/healthz'), null);
  assert.equal(mountFor('/local-ai/models'), null);
});

test('each of the three surfaces has its own mount', async () => {
  const { mountFor } = await collapsed();
  assert.equal(mountFor('/canvas/queue').id, 'canvas');
  assert.equal(mountFor('/bridge/health').id, 'bridge');
  assert.equal(mountFor('/agent/mcp').id, 'agent-mcp');
  // Mounts do not overlap: no path resolves to two surfaces.
  const ids = new Set(['/canvas/x', '/bridge/x', '/agent/x'].map((url) => mountFor(url).id));
  assert.equal(ids.size, 3);
});

test('the old ports keep answering: each entry point still listens when it is the program', () => {
  // Removing a port is a separate decision. Until it is made, the frontend, the
  // stack script, the Tauri shell and the MCP client config all address these
  // by number, so every entry point has to stay runnable on its own.
  const canvas = fs.readFileSync(path.join(gatewayRoot, 'server.js'), 'utf8');
  assert.match(canvas, /require\.main === module/);
  assert.match(canvas, /publicServer\.listen\(port, hostname/);

  const bridge = fs.readFileSync(path.join(__dirname, '../hosted-server.js'), 'utf8');
  assert.match(bridge, /require\.main === module/);
  assert.match(bridge, /server\.listen\(PORT, HOST/);

  const collapsedSource = fs.readFileSync(collapsedPath, 'utf8');
  // And the collapsed service brings the same three numbers up itself.
  assert.match(collapsedSource, /CANVAS_LEGACY_PORT = Number\(process\.env\.PORT \|\| 8788\)/);
  assert.match(collapsedSource, /BRIDGE_LEGACY_PORT = Number\(process\.env\.OGA_PORT \|\| 8794\)/);
  assert.match(collapsedSource, /MEDIA_STUDIO_MCP_PORT \|\| process\.env\.ZIMG_MCP_PORT \|\| 8796/);
});

test('the stack script starts one Node child and waits on one health endpoint', () => {
  const stack = fs.readFileSync(path.join(__dirname, '../../../scripts/hivemind-studio-stack'), 'utf8');
  const live = stack.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  // One `with_credentials … node …` invocation, and it is the collapsed entry.
  const nodeStarts = live.match(/with_credentials \S+ node \S+/g) || [];
  assert.deepEqual(nodeStarts, ['with_credentials hivemind-node-services node node-services.mjs']);
  assert.match(live, /wait_http "http:\/\/127\.0\.0\.1:\$NODE_SERVICES_PORT\/healthz"/);
  // The replaced invocations are kept in a comment beside it, so the switch is
  // readable without the diff.
  assert.match(stack, /#\s+with_credentials z-image-frontend npm run start/);
  assert.match(stack, /#\s+with_credentials open-generative-ai node hosted-server\.js/);
  assert.match(stack, /#\s+with_credentials media-studio-mcp node "\$APP\/bin\/media-studio-mcp\.mjs" --http/);
});
