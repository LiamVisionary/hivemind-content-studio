import assert from 'node:assert/strict';
import test from 'node:test';
import { withServedModel } from '../src/studios/video/videoLogic.js';

// "Use in Video Studio" on a machine card used to commit the source flags raw,
// skipping the re-pick the source picker does — so the studio arrived pointed
// at a cloud model the box cannot run (Seedance Lite against a MiniMax H3
// rental, 2026-08-24). withServedModel is now the one rule both paths go
// through, and the flag it has to preserve is the per-tab pin: there is no
// rented MODE any more, only the machine this Mac's work lands on.

const h3 = { id: 'minimax-h3-reference', name: 'MiniMax H3 (reference)' };
const wan = { id: 'wan-2-2-i2v', name: 'Wan 2.2 I2V' };
const catalogs = { hivemindI2V: [h3], allT2V: [wan] };
const machine = { models_served: ['minimax_h3'] };

test('re-points a model the machine does not serve', () => {
  const next = withServedModel(
    { modelId: 'seedance-lite', modelName: 'Seedance Lite', rentedMachineId: 'vast:48', localMode: true },
    [machine], catalogs,
  );
  assert.equal(next.modelId, h3.id);
  // The flags the caller set must survive the re-point, or the studio lands on
  // the right model in the wrong place.
  assert.equal(next.rentedMachineId, 'vast:48');
  assert.equal(next.localMode, true);
});

test('leaves a model the machine already serves alone', () => {
  const setup = { modelId: h3.id, modelName: h3.name, rentedMachineId: 'vast:48', localMode: true };
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
  const setup = { modelId: 'seedance-lite', modelName: 'Seedance Lite', rentedMachineId: 'vast:48' };
  assert.equal(withServedModel(setup, [stranger], catalogs), setup);
});
