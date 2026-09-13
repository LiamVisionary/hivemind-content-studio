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

// ── the OWNER key needed the same rule, and did not have it ──────────────────
//
// Reported 2026-09-12: two workspaces open, the user working in account 2, and
// every video render came back "Can't decrypt — Sealed for a different key".
// control_api resolves the SIGNED-IN account's vault key correctly and sends it
// as X-E2E-Owner-Pub; this sidecar threw it away and read a machine-wide file
// instead, which holds whichever account is is_owner (account 1). Images were
// unaffected because they bypass the MCP entirely (the /local-ai proxy attaches
// the workspace key itself), which is exactly how one question came to have two
// answers. The precedence below is now the same one the agent key has used all
// along: the caller decides, the process is only the fallback.
const { runWithRequester: runWithCaller, __testOwnerPublicKey } =
  await import('./bin/media-studio-mcp.mjs');
const OWNER_MACHINE = 'M'.repeat(392); // whichever account is is_owner here
const OWNER_CALLER = 'C'.repeat(392);  // the workspace that actually asked

test("the caller's workspace key outranks the machine's configured owner key", () => {
  process.env.MEDIA_STUDIO_OWNER_PUB = OWNER_MACHINE;
  try {
    assert.equal(__testOwnerPublicKey(), OWNER_MACHINE, 'no caller: the machine key is the fallback');
    runWithCaller('', () => {
      assert.equal(__testOwnerPublicKey(), OWNER_CALLER, 'a caller that presents a key must win');
    }, OWNER_CALLER);
  } finally {
    delete process.env.MEDIA_STUDIO_OWNER_PUB;
  }
});

test('a malformed caller owner key falls back rather than sealing to nothing', () => {
  process.env.MEDIA_STUDIO_OWNER_PUB = OWNER_MACHINE;
  try {
    runWithCaller('', () => {
      assert.equal(__testOwnerPublicKey(), OWNER_MACHINE);
    }, 'not-a-key');
  } finally {
    delete process.env.MEDIA_STUDIO_OWNER_PUB;
  }
});

test('the two keys are scoped independently within one request', () => {
  // A browser presents both: its device key (agent copy) and its workspace vault
  // key (owner copy). Neither may overwrite the other.
  runWithCaller(DEVICE_PUB, () => {
    assert.equal(__testRequesterPublicKey(), DEVICE_PUB);
    assert.equal(__testOwnerPublicKey(), OWNER_CALLER);
  }, OWNER_CALLER);
});

// ── and the header has to actually be SENT ───────────────────────────────────
//
// 2026-09-12, round three. Making ownerPublicKey() honour the caller was not
// enough: X-E2E-Owner-Pub was only ever attached inside `if (isPrivateCall())`,
// and a studio render is not a private call. So a normal generation named no
// vault at all and the gateway fell back to whichever account is is_owner —
// which its own log said out loud once it was asked to:
//   "…is being sealed to this machine's DEFAULT owner vault: the request
//    presented no X-E2E-Owner-Pub."
// A workspace-public generation is sealed to the vault AND the agent key, so
// the vault was always meant to be a recipient; it was simply never named.
const { __testRequestJson, runPrivately } = await import('./bin/media-studio-mcp.mjs');

async function headersSentBy(run) {
    const seen = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        Object.assign(seen, init?.headers || {});
        return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    };
    try { await run(); } catch { /* the response shape is not what is under test */ }
    finally { globalThis.fetch = realFetch; }
    return seen;
}

test('an ordinary generation names the owner vault, not just a private one', async () => {
    const sent = await headersSentBy(() => runWithCaller(
        DEVICE_PUB,
        () => __testRequestJson('/api/generate', { method: 'POST', body: { prompt: 'x' } }),
        OWNER_CALLER,
    ));
    assert.equal(sent['X-E2E-Owner-Pub'], OWNER_CALLER, 'the gateway was left to guess the vault');
    assert.equal(sent['X-E2E-Requester-Pub'], DEVICE_PUB, 'and the agent copy still has its key');
});

test('a private generation still sends the owner key and NO requester key', async () => {
    const sent = await headersSentBy(() => runWithCaller(
        DEVICE_PUB,
        () => runPrivately(() => __testRequestJson('/api/generate', { method: 'POST', body: { prompt: 'x' } })),
        OWNER_CALLER,
    ));
    assert.equal(sent['X-E2E-Owner-Pub'], OWNER_CALLER);
    assert.equal(sent['X-E2E-Requester-Pub'], undefined, 'a private clip must get no agent copy');
});

test('an HTTP caller that sends no owner key gets none — not the machine\'s', async () => {
    // The silent-wrong-seal path. The env/file key belongs to whichever account
    // is is_owner on this machine; substituting it for a caller's seals media to
    // a vault that caller cannot open, while every log reads "present". Better
    // to send nothing and let the gateway say so.
    process.env.MEDIA_STUDIO_OWNER_PUB = OWNER_MACHINE;
    try {
        runWithCaller('', () => {
            assert.equal(__testOwnerPublicKey(), '', 'the machine key stood in for a caller again');
        }, '', true);
        // A stdio/agent invocation has no HTTP caller and legitimately uses it.
        assert.equal(__testOwnerPublicKey(), OWNER_MACHINE);
    } finally {
        delete process.env.MEDIA_STUDIO_OWNER_PUB;
    }
});
