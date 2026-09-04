import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    MAX_TAB_LABEL, prettyModelName, publishTabLabels, readTabLabels, resetTabLabels, tabChipLabel,
} from '../src/lib/studioTabLabel.js';

test('a tab is named after its prompt', () => {
    assert.equal(tabChipLabel({ prompt: 'a lighthouse at dusk' }), 'a lighthouse at dusk');
});

test('a long prompt is clipped to a chip-sized name', () => {
    const label = tabChipLabel({ prompt: 'a lighthouse at dusk, storm rolling in over the bay, 35mm' });
    assert.ok(label.length <= MAX_TAB_LABEL + 1, `"${label}" is chip sized`);
    assert.ok(label.endsWith('…'), 'the cut is visible');
    assert.ok(label.startsWith('a lighthouse at dusk'));
});

test('newlines and runs of spaces collapse — a chip is one line', () => {
    assert.equal(tabChipLabel({ prompt: '  a  cat\non a\troof ' }), 'a cat on a roof');
});

test('with no prompt the tab is named after its model', () => {
    assert.equal(tabChipLabel({ prompt: '', model: 'krea2' }), 'krea2');
    // Ids arrive namespaced and as workflow filenames; the chip shows the tail.
    assert.equal(tabChipLabel({ model: 'local:krea2' }), 'krea2');
    assert.equal(tabChipLabel({ model: 'hivemind/wan_2_2.json' }), 'wan_2_2');
    assert.equal(prettyModelName('a/b/flux.safetensors'), 'flux');
});

test('an empty tab says so, in the caller’s words', () => {
    assert.equal(tabChipLabel(null), 'New tab');
    assert.equal(tabChipLabel({ prompt: '   ', model: '' }), 'New tab');
    assert.equal(tabChipLabel({}, { fallback: '新标签' }), '新标签');
});

test('the palette reads the names the strip published, and never the live objects', () => {
    resetTabLabels();
    publishTabLabels('video', [{ id: 3, index: 0, label: 'a lighthouse', busy: true }]);
    const read = readTabLabels('video');
    assert.deepEqual(read, [{ id: 3, index: 0, label: 'a lighthouse', busy: true }]);

    read[0].label = 'mutated';
    assert.equal(readTabLabels('video')[0].label, 'a lighthouse', 'the registry hands out copies');
    assert.deepEqual(readTabLabels('image'), [], 'each studio keeps its own strip');
});

// A registry id is not a label. Found live on 2026-09-04: the picker said
// "Z-Image Turbo LoRA Optimizer" while the tab strip beside it said
// "z-image-turbo", because the Image studio's chip() published the raw id on
// its local branch only. The cloud branch had always resolved a name.
test('the Image studio publishes a local model NAME to the tab strip, never its id', () => {
  const source = fs.readFileSync(new URL('../src/studios/ImageStudio.jsx', import.meta.url), 'utf8');
  // Deliberately textual: this guards a call site, not a rendered string —
  // chip() is only reachable through the studio's imperative api handle.
  const chip = source.slice(source.indexOf('chip: () => ({'));
  const body = chip.slice(0, chip.indexOf('}),') + 3);
  assert.match(body, /localModelDisplayName\(/, 'the local branch must resolve a display name');
  assert.doesNotMatch(
    body.replace(/localModelDisplayName\([^)]*\)/g, ''),
    /model:\s*s\.useLocalModel\s*\?\s*s\.selectedLocalModel\b/,
    'the raw local id must not be published as the chip label',
  );
});
