import assert from 'node:assert/strict';
import test from 'node:test';
import { withServedModel, buildCatalogs } from '../src/studios/video/videoLogic.js';
import { defaultRunTab, TAB_RENTAL, PLACE_THIS_MAC } from '../src/lib/runTargets.js';

// Two complaints, one cause: the studio treated every lane a rented box serves
// as interchangeable.
//
// The eros tier is deliberately a SUPERSET — its box carries the official H3
// weights as well — so "the first model it serves" is a coin toss, and it kept
// landing on plain MiniMax H3 for someone who had rented the Eros Max box. The
// tier is the only thing that knows why the machine was bought, so it names its
// own lane (gpu_rentals.TIERS[...].primary_workflow) and that rides on the
// machine.

const model = (workflowId, name) => ({
  id: `hivemind-media:${workflowId}`,
  workflowId,
  name,
  label: name,
  provider: 'hivemind-media-studio',
  accelerator: 'cuda',
  ready: true,
});
const catalogs = buildCatalogs([
  model('minimax-h3', 'MiniMax H3'),
  model('minimax-h3-turbo', 'MiniMax H3 Turbo'),
  model('minimax-h3-eros', 'MiniMax H3 Eros Max'),
]);
const box = (primary) => ({
  rental_id: 'vast:50991951', attached: true, tunnel_alive: true,
  models_served: ['minimax_h3', '10eros_max'],
  ...(primary ? { primary_workflow: primary } : {}),
});
const onWan = { modelId: 'wan-2-2-i2v', modelName: 'Wan 2.2 I2V' };

test('a machine rented for the eros lane lands on the eros lane', () => {
  assert.equal(withServedModel(onWan, [box('minimax-h3-eros')], catalogs).modelName, 'MiniMax H3 Eros Max');
});

test('a machine rented for the plain H3 tier lands there instead', () => {
  assert.equal(withServedModel(onWan, [box('minimax-h3')], catalogs).modelName, 'MiniMax H3');
});

test('a machine that names no lane keeps the old first-served behaviour', () => {
  // Boxes rented before the tier named its lane, and every non-H3 tier.
  assert.equal(withServedModel(onWan, [box('')], catalogs).modelName, 'MiniMax H3');
});

test('a tab already on a lane the machine serves is left alone', () => {
  // The preference decides where an UNSERVED tab lands. It must not yank a
  // deliberate choice — someone on Turbo asked for Turbo.
  const onTurbo = { modelId: 'hivemind-media:minimax-h3-turbo', modelName: 'MiniMax H3 Turbo' };
  assert.equal(withServedModel(onTurbo, [box('minimax-h3-eros')], catalogs), onTurbo);
});

// And the picker opened on This Mac while the chosen row sat on Rental — the
// first thing you look for on opening a picker is the row already chosen.
test('the picker opens on the tab holding the current selection', () => {
  const targets = [
    { id: 'wan-2-2-i2v', provider: 'wan2gp', place: PLACE_THIS_MAC, ready: true, label: 'Wan 2.2', machine: null },
    {
      id: 'hivemind-media:minimax-h3-eros', provider: 'media-studio-mcp', place: PLACE_THIS_MAC,
      ready: true, label: 'MiniMax H3 Eros Max', machine: { rental_id: 'vast:50991951' },
    },
  ];
  assert.equal(defaultRunTab(targets, { id: 'hivemind-media:minimax-h3-eros', provider: 'media-studio-mcp' }), TAB_RENTAL);
  // With a local row selected it still opens on This Mac…
  assert.equal(defaultRunTab(targets, { id: 'wan-2-2-i2v', provider: 'wan2gp' }), PLACE_THIS_MAC);
  // …and with nothing selected the old rule stands.
  assert.equal(defaultRunTab(targets), PLACE_THIS_MAC);
});
