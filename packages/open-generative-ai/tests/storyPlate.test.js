// The Story studio's drawn-reference slot: a sheet that cannot be shown is a
// STATE with an action, never a broken <img> with alt text in it.
//
// Deliberately textual: a sheet the tab cannot open, and one drawn from bytes
// still in hand, are both states reached after an async read.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('a sheet the tab cannot open says so — locked, foreign key, or missing — instead of a broken picture', () => {
  const parts = read('../src/studios/story/parts.jsx');
  // The resolver fails open to the envelope URL; the slot has to ask the seal
  // registry, through the hook (a render-time read misses the flip).
  assert.match(parts, /useMediaSealFailure\(url\)/);
  assert.match(parts, /<VaultLockedTile reason=\{sealFailure\}/);
  // A file that is gone, or bytes the browser cannot decode, is the third state.
  assert.match(parts, /onError=\{\(\) => setFailed\(src\)\}/);
  assert.match(parts, /Redraw it/);
});

test('a freshly drawn sheet is shown from the bytes in hand, not re-fetched sealed', () => {
  const studio = read('../src/studios/StoryStudio.jsx');
  // Read once in the clear, hand the same bytes to the upload AND the cache.
  assert.match(studio, /const dataUrl = await mediaSourceToDataUrl\(result\.url, 'image'\)/);
  assert.match(studio, /promoteOutputToReference\(result\.url, \{ kind: 'image', name, dataUrl \}\)/);
  assert.match(studio, /primeResolvedMedia\(reference, dataUrl\)/);
});
