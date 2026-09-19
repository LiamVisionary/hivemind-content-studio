import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ORDER_HANDOFF_SECONDS, PROVISION_STEPS, machineProgress, mergeOrders, orderOutcome, orderProgress,
  ordersToDraw, placingTiers,
} from '../src/lib/rentalOrders.js';

// Pressing Rent held a spinner on the button for the whole placement, and when
// it stopped the list it re-read predated the machine — the box was billing and
// the page showed nothing (2026-09-15). The order is a row from the click on.

const order = (stage, extra = {}) => ({
  order_id: 'click-1', tier: 'minimaxeros', stage, count: 1, quoted_usd_per_hour: 0.8625,
  started_at: 1000, finished_at: stage === 'placed' || stage === 'failed' ? 1010 : null,
  rental_ids: [], usd_per_hour: null, partial: null, error: null, ...extra,
});

test('the click draws a row before the server has answered, and the server copy takes over', () => {
  const draft = order('sending');
  assert.deepEqual(ordersToDraw(mergeOrders([], [draft]), []).map((o) => o.stage), ['sending']);
  const merged = mergeOrders([order('preparing')], [draft]);
  assert.deepEqual(merged.map((o) => o.stage), ['preparing'], 'one row per order, never a draft beside its own copy');
});

test('the bar only ever moves forward, from the click to a booting machine', () => {
  const values = ['sending', 'searching', 'preparing', 'renting', 'placed'].map((stage) => orderProgress(order(stage)).value);
  for (let i = 1; i < values.length; i += 1) assert.ok(values[i] > values[i - 1], `stage ${i} must be ahead of stage ${i - 1}`);
  assert.ok(values[0] > 0, 'something is on the bar the moment Rent is pressed');
  // The order's row hands over to the machine's row at the SAME place, with the same words.
  const booting = machineProgress({ phase: 'booting' });
  assert.equal(orderProgress(order('placed')).value, booting.value);
  assert.equal(orderProgress(order('placed')).label, booting.step.label);
  // And the machine carries on past it.
  assert.ok(machineProgress({ phase: 'provisioning', provision: { step: 'downloading', done: 5, total: 20 } }).value > booting.value);
  assert.equal(machineProgress({ phase: 'provisioning', provision: { step: 'ready' } }).value, 1);
  assert.equal(PROVISION_STEPS[0].key, 'placing');
});

test('a placed order keeps its row until the list shows its machine', () => {
  const placed = order('placed', { rental_ids: ['runpod:3plgrd2s31pv1d'] });
  assert.equal(ordersToDraw([placed], [], 1011).length, 1, 'the list is a snapshot and can trail the order');
  assert.equal(ordersToDraw([placed], [{ rental_id: 'runpod:3plgrd2s31pv1d' }], 1011).length, 0);
  // A box that died before the list saw it does not hold "Starting the machine" forever.
  assert.equal(ordersToDraw([placed], [], 1010 + ORDER_HANDOFF_SECONDS + 1).length, 0);
});

test('a failed order draws no row; it is said once, in words', () => {
  assert.equal(ordersToDraw([order('failed', { error: { message: 'no' } })], []).length, 0);
  assert.deepEqual(orderOutcome(order('failed', { error: { message: 'credit is not enough', status: 402 } })), {
    kind: 'error', message: 'credit is not enough', unexpected: false, incident: '', remedy: '',
  });
});

test('a price that went up is a question; one that went down was taken', () => {
  const up = orderOutcome(order('failed', { error: { status: 409, priceChanged: { quoted: 0.819, now: 0.863 } } }));
  assert.equal(up.kind, 'price');
  const down = orderOutcome(order('failed', { error: { message: 'gone', status: 409, priceChanged: { quoted: 0.9, now: 0.8 } } }));
  assert.equal(down.kind, 'error');
});

test('a placed order names what differs from what was clicked', () => {
  assert.deepEqual(orderOutcome(order('placed', { usd_per_hour: 0.8625 })), { kind: 'placed', notice: '' });
  const pricier = orderOutcome(order('placed', { usd_per_hour: 0.8791, partial: 'rented without 1 pinned LoRA' }));
  assert.match(pricier.notice, /^rented without 1 pinned LoRA; it cost \$0\.879\/hr instead of the \$0\.863\/hr quoted/);
  assert.equal(orderOutcome(order('renting')), null, 'nothing to say while it is still going');
});

test('only a tier with an order still going is busy', () => {
  const tiers = placingTiers([order('renting'), order('placed', { tier: 'image' }), order('failed', { tier: 'video' })]);
  assert.deepEqual([...tiers], ['minimaxeros']);
});
