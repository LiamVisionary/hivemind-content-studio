// The sidecar holds an identity of its own (the agent key) AND relays calls
// for browsers that hold theirs. Which one it presents to the gateway decides
// who can ever decrypt the result, so the precedence is worth pinning down.
//
// Run: node packages/media-gateway/test-requester-context.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MEDIA_STUDIO_E2E_PUB = 'A'.repeat(392); // this process's own key
const AGENT_PUB = process.env.MEDIA_STUDIO_E2E_PUB;
const DEVICE_PUB = 'D'.repeat(392); // a browser's key, arriving per request

const { normalizedRequesterPub, runWithRequester, __testRequesterPublicKey } =
  await import('./bin/media-studio-mcp.mjs');

test('a malformed or absent per-request key is ignored, not forwarded', () => {
  for (const junk of ['', '   ', undefined, null, 'short', 'has/slashes+plus', 'x'.repeat(4001)]) {
    assert.equal(normalizedRequesterPub(junk), '');
  }
});

test('a browser key presented on the request wins over the process identity', () => {
  // The whole point: media generated through this sidecar on behalf of a
  // browser must be sealed to THAT browser, not to the shared agent key.
  runWithRequester(DEVICE_PUB, () => {
    assert.equal(__testRequesterPublicKey(), DEVICE_PUB);
  });
});

test('an agent call that presents nothing still seals to the agent key', () => {
  assert.equal(__testRequesterPublicKey(), AGENT_PUB);
  runWithRequester('', () => {
    assert.equal(__testRequesterPublicKey(), AGENT_PUB);
  });
});

test('the scoped key does not leak past the request that carried it', async () => {
  // Async-local storage, not a module global: two overlapping requests must
  // not be able to seal each other's media to the wrong key.
  const seen = [];
  await Promise.all([
    runWithRequester(DEVICE_PUB, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(['device', __testRequesterPublicKey()]);
    }),
    runWithRequester('', async () => {
      seen.push(['agent', __testRequesterPublicKey()]);
    }),
  ]);
  assert.deepEqual(
    seen.sort(),
    [['agent', AGENT_PUB], ['device', DEVICE_PUB]],
  );
  assert.equal(__testRequesterPublicKey(), AGENT_PUB);
});
