import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// "Use in <studio>" on a machine card re-pointed the model and then looked like
// it had done nothing: the studio opened on local Wan 2.2 every time. The model
// WAS being re-pointed — `withServedModel` is tested next door and gets it
// right — but the tab stayed on Automatic, whose ladder ranks a rented box LAST
// because it is the only rung billed by the hour. Automatic simply picked the
// free local model straight back.
//
// Reproduced against a real attached RTX 5090 on 2026-09-14: the picker showed
// "Rental 3" with the H3 lanes present, and AUTOMATIC sitting on "Wan 2.2 —
// free, stays here". Pinned by source because the handoff is component state,
// and the one line that matters is the flag it clears.

const source = readFileSync(new URL('../src/studios/VideoStudio.jsx', import.meta.url), 'utf8');

function finishRentedHandoffBody() {
  const start = source.indexOf('const finishRentedHandoff = () => {');
  assert.notEqual(start, -1, 'finishRentedHandoff was renamed — re-point this guard');
  return source.slice(start, source.indexOf('\n  };', start));
}

test('the rented handoff turns Automatic OFF', () => {
  const body = finishRentedHandoffBody();
  assert.match(body, /runOnAutomatic:\s*false/,
    'without this Automatic re-picks the free local model and the handoff is a no-op');
});

test('it still routes the model through withServedModel', () => {
  const body = finishRentedHandoffBody();
  assert.match(body, /withServedModel\(/,
    'the machine must decide the model, or the tab lands on one it cannot run');
});

test('it commits unconditionally, because turning Automatic off is itself the change', () => {
  const body = finishRentedHandoffBody();
  // The old code was `if (next !== s.setup) commit(next)`, which skipped the
  // commit whenever the tab was already on a lane the machine serves — leaving
  // Automatic armed on exactly the tabs that looked most correct.
  assert.doesNotMatch(body, /if\s*\(\s*next\s*!==\s*s\.setup\s*\)\s*commit/);
  assert.match(body, /\n\s*commit\(next\);/);
});
