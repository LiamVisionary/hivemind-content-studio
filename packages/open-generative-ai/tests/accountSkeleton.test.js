// The loading state of the account row and its two sheets.
//
// Deliberately textual for the reduced-motion rule: it is a claim about which
// CLASS is written on the element, and a render cannot answer whether a
// stylesheet will later calm it to a single frame. The rest RENDERS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');

test('a skeleton keeps pulsing when the viewer has asked for less motion', () => {
  // base.css calms every animation to one 0.01ms frame under
  // prefers-reduced-motion, and exempts .hive-motion-keep. Without that class a
  // skeleton freezes into a static grey rectangle, which is exactly what an
  // empty box looks like — the one thing a loading state may not resemble.
  const kit = read('ui/kit.jsx');
  const skeleton = kit.slice(kit.indexOf('export function Skeleton'));
  assert.match(skeleton.slice(0, 400), /hive-motion-keep/);
  assert.match(skeleton.slice(0, 400), /animate-pulse/);
  assert.match(skeleton.slice(0, 400), /aria-hidden/);
});

test('the row skeletons its content without losing its two buttons', () => {
  // `loaded` is "we have asked"; `known` is "we were told". The skeleton keys
  // on the first, so a FAILED read shows its own (different) state rather than
  // pulsing forever.
  //
  // And it swaps CONTENT, never the buttons: an early return replaced the whole
  // row with inert shapes, so the one control that opens the credits sheet was
  // unclickable for exactly as long as the slow read that made someone want it.
  const row = read('app/AccountRow.jsx');
  const render = row.slice(row.indexOf('export function AccountRow'));
  assert.match(render, /<Skeleton/);
  assert.match(render, /aria-busy=\{loaded \? undefined : 'true'\}/);
  // Both doors are rendered unconditionally.
  assert.equal((render.match(/onClick=\{onOpenAccount\}/g) || []).length, 2);
  assert.match(render, /onClick=\{onOpenCredits\}/);
  assert.doesNotMatch(render, /if \(!loaded\) \{\s*return/);
});

test('neither sheet prints a balance it has not been told', () => {
  // Both used to render the not-connected copy while the read was still in
  // flight, which is how "No account yet" appeared over a funded account.
  const credits = read('dialogs/CreditsDialog.jsx');
  assert.match(credits, /loaded \? \(/);
  // The balance is a 26px mono figure now, so the shape standing in for it is
  // that figure's, not the old single line of text.
  assert.match(credits, /<Skeleton className="mt-1 h-7 w-32" \/>/);

  const account = read('dialogs/AccountDialog.jsx');
  const gate = account.slice(account.indexOf('if (!loaded) {'), account.indexOf('if (failed'));
  assert.match(gate, /<Skeleton/);
  assert.doesNotMatch(gate, /Spinner/);
});
