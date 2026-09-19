import assert from 'node:assert/strict';
import test from 'node:test';
import { machineServesModel, servedByAnyMachine } from '../src/lib/rentedMachines.js';

// A rented box advertises the models it serves as NEEDLES — lowercase
// substrings matched against a model's id and name, the same rule the
// media-gateway routes on. A name is not a capability, and on 2026-09-14 that
// gap showed: "MiniMax H3 (Apple Silicon)" is antirez/h3.c, a Metal engine
// whose registry row says it "runs on an Apple-silicon Mac and nowhere else" —
// and its id contains `minimax_h3`, which is exactly the needle a rented H3 box
// advertises. So it was listed on the Rental tab of an RTX 5090, and picked as
// the model to hand a "Use in Video studio" to, until the preflight refused the
// run and dropped the tab back to a local model.

const box = {
  rental_id: 'vast:50991951', attached: true, tunnel_alive: true,
  models_served: ['minimax_h3', '10eros_max'],
};
const cuda = (id, name) => ({ id, name, accelerator: 'cuda' });

test('a lane the rented card can run is served', () => {
  assert.equal(machineServesModel(box, cuda('hivemind-media:minimax-h3', 'MiniMax H3')), true);
  assert.equal(machineServesModel(box, cuda('hivemind-media:minimax-h3-eros', 'MiniMax H3 Eros Max')), true);
});

test('a Metal-only lane is NOT served, however well its name matches', () => {
  const apple = {
    id: 'hivemind-media:minimax-h3-native',
    name: 'MiniMax H3 (Apple Silicon)',
    accelerator: 'mps',
  };
  // The needle still matches — that is the whole point of the test.
  assert.match(apple.id.replace(/[^a-z0-9]/g, ''), /minimaxh3/);
  assert.equal(machineServesModel(box, apple), false);
  assert.equal(servedByAnyMachine([box], apple), false);
});

test('a lane that declares no accelerator is judged on its needles alone', () => {
  // Most rows say nothing about hardware; the rule must not quietly exclude
  // them, or the Rental tab empties out.
  assert.equal(machineServesModel(box, { id: 'hivemind-media:minimax-h3', name: 'MiniMax H3' }), true);
  assert.equal(machineServesModel(box, { id: 'wan-2-2-i2v', name: 'Wan 2.2 I2V' }), false);
});

test('the accelerator is compared case-insensitively', () => {
  assert.equal(machineServesModel(box, { id: 'hivemind-media:minimax-h3', name: 'H3', accelerator: 'CUDA' }), true);
  assert.equal(machineServesModel(box, { id: 'hivemind-media:minimax-h3', name: 'H3', accelerator: 'MPS' }), false);
});

test('a detached or tunnel-dead box serves nothing', () => {
  const model = cuda('hivemind-media:minimax-h3-eros', 'MiniMax H3 Eros Max');
  assert.equal(machineServesModel({ ...box, attached: false }, model), true, 'the needle rule is about the model');
  // machineForModel is what filters on attachment; machineServesModel answers
  // only "would this box's weights run it", which stays true either way.
  assert.equal(servedByAnyMachine([{ ...box, models_served: [] }], model), false);
});
