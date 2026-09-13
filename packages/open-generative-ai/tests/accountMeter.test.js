// The free-allowance meter, and the two ways it lied.
//
// Deliberately textual in one place only (the i18n keys it asserts on are read
// through `t`, not grepped); everything else here RENDERS or computes, because
// the bugs were both arithmetic rather than layout:
//
//   1. "Free allowance unknown" was printed whenever a REMAINING count was
//      missing — over a meter whose daily ceiling was in the same object. The
//      gateway's status route carries the ceiling always and a live `usage`
//      block only sometimes, so that was most of the time.
//   2. `Number(null)` is 0, so a missing count painted the bar danger-red at
//      0% underneath the words that said the allowance was full.
const test = require('node:test');
const assert = require('node:assert/strict');

test('a missing remaining count is not a count of zero', async () => {
  const { allowanceFraction, allowanceTone } = await import('../src/lib/account.js');
  const ceilingOnly = {
    known: true, remainingRequests: null, remainingTokens: null,
    requestLimit: 400, tokenLimit: 1_000_000,
  };
  assert.equal(allowanceFraction(ceilingOnly), null);
  assert.equal(allowanceTone(ceilingOnly), 'neutral');
});

test('the bar shows whichever of requests and tokens is emptier', async () => {
  const { allowanceFraction } = await import('../src/lib/account.js');
  // Either can run out first, and a meter reading half full while the next
  // press is refused is worse than no meter at all.
  assert.equal(allowanceFraction({
    known: true, remainingRequests: 200, requestLimit: 400,
    remainingTokens: 50_000, tokenLimit: 1_000_000,
  }), 0.05);
});

test('a spent allowance is danger, a nearly spent one is a warning', async () => {
  const { allowanceTone } = await import('../src/lib/account.js');
  const at = (remaining) => allowanceTone({
    known: true, remainingRequests: remaining, requestLimit: 400,
    remainingTokens: remaining * 2500, tokenLimit: 1_000_000,
  });
  assert.equal(at(0), 'danger');
  assert.equal(at(22), 'warn');
  assert.equal(at(400), 'ok');
});

test('an unreachable gateway is the only thing that reads as unknown', async () => {
  const { allowanceFraction, allowanceTone } = await import('../src/lib/account.js');
  const unreachable = { known: false, remainingRequests: null, requestLimit: null };
  assert.equal(allowanceFraction(unreachable), null);
  assert.equal(allowanceTone(unreachable), 'neutral');
});
