import assert from 'node:assert/strict';
import test from 'node:test';

// A rented box goes ready, and then attached, on the BACKEND's schedule —
// minutes after the rent click that fired the only change event there was. The
// studio's own rented-state poll discovered it and nobody else heard: the
// composer's status line read "1 running, about $0.82/hr" off the poll while
// the model picker's Rental tab stayed empty off a machine list fetched before
// the box existed (seen 2026-09-14, both on screen at once).
//
// So a read that lands a DIFFERENT world announces it, whoever caused the read.
// These tests pin the two halves that matter: it fires on a real change, and it
// stays silent otherwise — because the listeners refresh, and a poll that
// announced every time would feed itself.

function installWindow() {
  const listeners = new Map();
  const fired = [];
  globalThis.window = {
    addEventListener: (name, fn) => listeners.set(name, [...(listeners.get(name) || []), fn]),
    removeEventListener: () => {},
    dispatchEvent: (event) => { fired.push(event.type); return true; },
  };
  globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
  return fired;
}

function machine(id, { attached = true, tunnel = true } = {}) {
  return { rental_id: id, managed: true, phase: 'ready', attached, tunnel_alive: tunnel };
}

async function freshModule(responses) {
  let call = 0;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ rentals: responses[Math.min(call++, responses.length - 1)] }),
  });
  return import(`../src/lib/rentedMachines.js?t=${Math.random()}`);
}

test('a box that attaches between polls is announced to everyone', async () => {
  const fired = installWindow();
  // First read: nothing rented. Second: the box is ready and attached.
  const mod = await freshModule([[], [machine('vast:50991951')]]);

  const first = await mod.rentedMachinesState({ force: true });
  assert.equal(first.live.length, 0);
  assert.deepEqual(fired, [], 'the first read establishes the world; it is not a change');

  const second = await mod.rentedMachinesState({ force: true });
  assert.equal(second.live.length, 1);
  assert.deepEqual(fired, [mod.RENTED_CHANGED_EVENT],
    'the picker only refreshes on this event, so an unannounced attach is invisible to it');
});

test('a settled poll says nothing, so an announcement cannot feed itself', async () => {
  const fired = installWindow();
  const mod = await freshModule([[machine('vast:50991951')]]);

  await mod.rentedMachinesState({ force: true });
  await mod.rentedMachinesState({ force: true });
  await mod.rentedMachinesState({ force: true });
  assert.deepEqual(fired, [], 'the same world twice is not news');
});

test('the same count with a dead tunnel is still a change', async () => {
  const fired = installWindow();
  const mod = await freshModule([
    [machine('vast:50991951')],
    [machine('vast:50991951', { tunnel: false })],
  ]);

  await mod.rentedMachinesState({ force: true });
  const broken = await mod.rentedMachinesState({ force: true });
  // Same machine, same count — but it moved bucket, and a picker offering it
  // as a place to run would be offering a lane that answers nothing.
  assert.equal(broken.live.length, 0);
  assert.equal(broken.broken.length, 1);
  assert.deepEqual(fired, [mod.RENTED_CHANGED_EVENT]);
});
