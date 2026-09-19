// `private: true` on a generate tool must change exactly one thing about the
// job: it goes out with NO requester key and the workspace owner's vault key
// as the only recipient, so the output is sealed like the owner's own private
// generations and this process gets no copy. Everything below drives the real
// request builder with a stubbed fetch and reads what would have hit the wire.
//
// Run: node --test packages/media-gateway/test-private-generation.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AGENT_PUB = 'A'.repeat(392);
const OWNER_PUB = 'O'.repeat(392);
process.env.MEDIA_STUDIO_E2E_PUB = AGENT_PUB;
process.env.MEDIA_STUDIO_TOKEN = 'test-token';
delete process.env.MEDIA_STUDIO_OWNER_PUB;
delete process.env.MEDIA_STUDIO_OWNER_PUB_FILE;

const { runPrivately, isPrivateCall, __testOwnerPublicKey, __testRequestJson } =
  await import('./bin/media-studio-mcp.mjs');

// Capture the headers of the last request instead of talking to a gateway.
let lastHeaders = null;
globalThis.fetch = async (_url, init) => {
  lastHeaders = { ...(init?.headers || {}) };
  return new Response(JSON.stringify({ ok: true, id: 'job-1' }), {
    status: 202, headers: { 'Content-Type': 'application/json' },
  });
};

test('a normal agent call presents the agent key and no owner key', async () => {
  await __testRequestJson('/api/generate', { method: 'POST', body: { prompt: 'x' } });
  assert.equal(lastHeaders['X-E2E-Requester-Pub'], AGENT_PUB);
  assert.equal(lastHeaders['X-E2E-Owner-Pub'], undefined);
});

test('a private call presents ONLY the owner key: no requester, so no agent copy', async () => {
  process.env.MEDIA_STUDIO_OWNER_PUB = OWNER_PUB;
  await runPrivately(() => __testRequestJson('/api/generate', { method: 'POST', body: { prompt: 'x' } }));
  assert.equal(lastHeaders['X-E2E-Owner-Pub'], OWNER_PUB);
  assert.equal(lastHeaders['X-E2E-Requester-Pub'], undefined, 'the agent must not be a recipient');
  delete process.env.MEDIA_STUDIO_OWNER_PUB;
});

test('private fails closed when no owner key is configured', async () => {
  // Refusing beats quietly sealing to the agent, which would make a "private"
  // generation readable by every agent on the machine.
  await assert.rejects(
    () => runPrivately(() => __testRequestJson('/api/generate', { method: 'POST', body: { prompt: 'x' } })),
    /owner key/,
  );
});

test('the owner key resolves env, then a file, then the sibling of the agent key file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-pub-'));
  // 3) conventional sibling of the agent key file
  writeFileSync(join(dir, 'agent-e2e-pub'), AGENT_PUB);
  writeFileSync(join(dir, 'owner-e2e-pub'), OWNER_PUB + '\n');
  process.env.MEDIA_STUDIO_E2E_PUB_FILE = join(dir, 'agent-e2e-pub');
  assert.equal(__testOwnerPublicKey(), OWNER_PUB);
  // 2) an explicit file wins over the sibling
  writeFileSync(join(dir, 'explicit'), 'E'.repeat(392));
  process.env.MEDIA_STUDIO_OWNER_PUB_FILE = join(dir, 'explicit');
  assert.equal(__testOwnerPublicKey(), 'E'.repeat(392));
  // 1) inline env wins over everything
  process.env.MEDIA_STUDIO_OWNER_PUB = 'I'.repeat(392);
  assert.equal(__testOwnerPublicKey(), 'I'.repeat(392));
  delete process.env.MEDIA_STUDIO_OWNER_PUB;
  delete process.env.MEDIA_STUDIO_OWNER_PUB_FILE;
  delete process.env.MEDIA_STUDIO_E2E_PUB_FILE;
});

test('privacy is scoped to the call and does not leak to a concurrent one', async () => {
  process.env.MEDIA_STUDIO_OWNER_PUB = OWNER_PUB;
  assert.equal(isPrivateCall(), false);
  await Promise.all([
    runPrivately(async () => { await new Promise((r) => setTimeout(r, 5)); assert.equal(isPrivateCall(), true); }),
    (async () => { await new Promise((r) => setTimeout(r, 1)); assert.equal(isPrivateCall(), false); })(),
  ]);
  assert.equal(isPrivateCall(), false);
  delete process.env.MEDIA_STUDIO_OWNER_PUB;
});
