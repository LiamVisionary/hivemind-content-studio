import assert from 'node:assert/strict';
import test from 'node:test';
import { withServedModel } from '../src/studios/video/videoLogic.js';

// "Use in Video Studio" on a machine card used to commit { localMode, rentedOnly }
// raw, skipping the re-pick the source picker does — so the studio arrived in
// Rented mode still pointed at a cloud model the box cannot run (Seedance Lite
// against a MiniMax H3 rental, 2026-08-24). withServedModel is now the one rule
// both paths go through.

const h3 = { id: 'minimax-h3-reference', name: 'MiniMax H3 (reference)' };
const wan = { id: 'wan-2-2-i2v', name: 'Wan 2.2 I2V' };
const catalogs = { hivemindI2V: [h3], allT2V: [wan] };
const machine = { models_served: ['minimax_h3'] };

test('re-points a model the machine does not serve', () => {
  const next = withServedModel(
    { modelId: 'seedance-lite', modelName: 'Seedance Lite', rentedOnly: true, localMode: true },
    [machine], catalogs,
  );
  assert.equal(next.modelId, h3.id);
  // The flags the caller set must survive the re-point, or the studio lands on
  // the right model in the wrong source.
  assert.equal(next.rentedOnly, true);
  assert.equal(next.localMode, true);
});

test('leaves a model the machine already serves alone', () => {
  const setup = { modelId: h3.id, modelName: h3.name, rentedOnly: true, localMode: true };
  assert.equal(withServedModel(setup, [machine], catalogs), setup);
});

test('with no machines yet, changes nothing', () => {
  // The handoff can be claimed before the machine list arrives; re-picking off
  // an empty list would strand the user on whatever happened to be first.
  const setup = { modelId: 'seedance-lite', modelName: 'Seedance Lite' };
  assert.equal(withServedModel(setup, [], catalogs), setup);
  assert.equal(withServedModel(setup, null, catalogs), setup);
});

test('keeps the model when the machine serves nothing in the catalogue', () => {
  const stranger = { models_served: ['something_else_entirely'] };
  const setup = { modelId: 'seedance-lite', modelName: 'Seedance Lite', rentedOnly: true };
  assert.equal(withServedModel(setup, [stranger], catalogs), setup);
});
