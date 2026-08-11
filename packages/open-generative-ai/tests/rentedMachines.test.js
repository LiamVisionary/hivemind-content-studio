import assert from 'node:assert/strict';
import test from 'node:test';
import { machineServesModel, servedByAnyMachine } from '../src/lib/rentedMachines.js';

const machine = { models_served: ['krea2_turbo_convrot', 'waianima'] };

test('matches auto-workflow ids despite separator differences', () => {
  assert.equal(machineServesModel(machine, { id: 'comfy-auto-krea2_turbo_convrot_int8_civitai' }), true);
  // gateway needles come from FILE names (waiANIMA_v10Base10) but UI ids are
  // dash-separated — normalization bridges the two.
  assert.equal(machineServesModel(machine, { id: 'wai-anima-native-06b-turbo', name: 'WAI Anima (native 0.6B)' }), true);
});

test('does not match unrelated models', () => {
  assert.equal(machineServesModel(machine, { id: 'z-image-turbo', name: 'Z-Image Turbo' }), false);
  assert.equal(servedByAnyMachine([], { id: 'wai-anima-native-06b-turbo' }), false);
});

test('tolerates missing fields', () => {
  assert.equal(machineServesModel({}, { id: 'x' }), false);
  assert.equal(machineServesModel(machine, null), false);
});

test('rentedMachinesState splits live from pending', async () => {
  const { rentedMachinesState } = await import('../src/lib/rentedMachines.js');
  const ready = { managed: true, attached: true, tunnel_alive: true, phase: 'ready', rental_id: 1 };
  const provisioning = { managed: true, attached: false, tunnel_alive: false, phase: 'provisioning', rental_id: 2 };
  const readyUnattached = { managed: true, attached: false, tunnel_alive: false, phase: 'ready', rental_id: 3 };
  const foreign = { managed: false, attached: true, tunnel_alive: true, phase: 'ready', rental_id: 4 };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ rentals: [ready, provisioning, readyUnattached, foreign] }) });

  const state = await rentedMachinesState({ force: true });
  assert.deepEqual(state.live.map((m) => m.rental_id), [1], 'only attached+tunnel+ready is usable now');
  // A ready-but-unattached box is PENDING, not live: the studio must offer to
  // finish connecting it rather than claim it can serve generations.
  assert.deepEqual(state.pending.map((m) => m.rental_id), [2, 3]);
});

test('a dead tunnel is broken, not "coming online"', async () => {
  const { rentedMachinesState, classifyMachine } = await import('../src/lib/rentedMachines.js');
  // Seen live 2026-08-08: Vast refused the rental key, the tunnel died, and the
  // studio showed a spinner reading "ready — connecting it to the studios…"
  // that could never resolve. Each unusable state must be named separately so
  // the panel can offer the action that actually fixes it.
  const brokenTunnel = { managed: true, attached: true, tunnel_alive: false, phase: 'ready', rental_id: 9 };
  const stillPulling = { managed: true, attached: false, tunnel_alive: false, phase: 'provisioning', rental_id: 8 };
  const notPointedHere = { managed: true, attached: false, tunnel_alive: false, phase: 'ready', rental_id: 7 };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ rentals: [brokenTunnel, stillPulling, notPointedHere] }) });

  assert.equal(classifyMachine(brokenTunnel), 'broken');
  assert.equal(classifyMachine(stillPulling), 'provisioning');
  assert.equal(classifyMachine(notPointedHere), 'idle');

  const state = await rentedMachinesState({ force: true });
  assert.deepEqual(state.broken.map((m) => m.rental_id), [9]);
  assert.deepEqual(state.provisioning.map((m) => m.rental_id), [8]);
  assert.deepEqual(state.idle.map((m) => m.rental_id), [7]);
  assert.deepEqual(state.live, []);
  // Old callers keep working.
  assert.deepEqual(state.pending.map((m) => m.rental_id).sort(), [7, 8, 9]);
});

test('the routing leader is the machine a generation actually lands on', async () => {
  const { attachedOrder, isRoutingLeader, routingLeaderFor } = await import('../src/lib/rentedMachines.js');
  // Two H3 boxes: both match the same graph, and the gateway's lane rules are
  // FIRST-MATCH in priority order. Whichever leads is where the clip renders.
  const a = { rental_id: 7, attached: true, tunnel_alive: true, priority: 1, models_served: ['minimax_h3'] };
  const b = { rental_id: 8, attached: true, tunnel_alive: true, priority: 4, models_served: ['minimax_h3'] };
  // A different workload: it leads for its own models regardless of the above.
  const images = { rental_id: 9, attached: true, tunnel_alive: true, priority: 0, models_served: ['waianima'] };
  const unattached = { rental_id: 10, attached: false, priority: 99, models_served: ['minimax_h3'] };
  const all = [a, b, images, unattached];

  assert.deepEqual(attachedOrder(all).map((m) => m.rental_id), [8, 7, 9]);
  assert.equal(isRoutingLeader(b, all), true);
  assert.equal(isRoutingLeader(a, all), false, 'outranked for the models it shares');
  assert.equal(isRoutingLeader(images, all), true, 'nothing ahead of it serves waianima');
  assert.equal(isRoutingLeader(unattached, all), false, 'priority means nothing until it is attached');
  assert.equal(routingLeaderFor(all, { id: 'minimax-h3' })?.rental_id, 8);
  assert.equal(routingLeaderFor(all, { id: 'wai-anima-native-06b' })?.rental_id, 9);
  assert.equal(routingLeaderFor(all, { id: 'z-image-turbo' }), null);
});

test('a dead tunnel still holds its routing position', async () => {
  const { isRoutingLeader } = await import('../src/lib/rentedMachines.js');
  // The gateway routes on the registry, which knows nothing about tunnel
  // health. Showing the live-but-outranked box as "in use" would put a green
  // light on a machine that receives nothing.
  const dead = { rental_id: 1, attached: true, tunnel_alive: false, priority: 5, models_served: ['minimax_h3'] };
  const alive = { rental_id: 2, attached: true, tunnel_alive: true, priority: 1, models_served: ['minimax_h3'] };
  assert.equal(isRoutingLeader(dead, [dead, alive]), true);
  assert.equal(isRoutingLeader(alive, [dead, alive]), false);
});

test('ties break the same way the server orders them', async () => {
  const { attachedOrder } = await import('../src/lib/rentedMachines.js');
  // gpu_rentals sorts by (-priority, string key); a UI that broke ties
  // differently would name the wrong machine on a fresh pair of attachments.
  const machines = [
    { rental_id: 7, attached: true, priority: 0 },
    { rental_id: 10, attached: true, priority: 0 },
  ];
  assert.deepEqual(attachedOrder(machines).map((m) => m.rental_id), [10, 7]);
});

test('rentedMachinesState never throws when the API is unreachable', async () => {
  const { rentedMachinesState } = await import('../src/lib/rentedMachines.js');
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const state = await rentedMachinesState({ force: true });
  assert.deepEqual(state, { live: [], provisioning: [], idle: [], broken: [], pending: [] });
});

test('the Source choice survives a reload in BOTH studios', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const read = (rel) => fs.readFileSync(new URL(path.join('..', rel), import.meta.url), 'utf8');

  // Video shipped with rentedOnly readable but never writable: the restore path
  // asked for it, no persist path ever produced it, so Rented silently fell back
  // to Local on every reload. Both studios must carry it in the payload they save.
  assert.match(
    read('src/studios/VideoStudio.jsx').match(/const currentVideoPreferences = [\s\S]*?\n  \}\);/)[0],
    /rentedOnly: s\.setup\.rentedOnly/,
    'video preferences must persist the rented source',
  );
  assert.match(
    read('src/studios/ImageStudio.jsx').match(/const currentImagePreferences = [\s\S]*?\n  \};/)[0],
    /rentedOnly: s\.rentedOnly/,
    'image preferences must persist the rented source',
  );
});

test('the video boot state names its Source instead of leaving it undefined', async () => {
  const fs = await import('node:fs');
  const logic = fs.readFileSync(new URL('../src/studios/video/videoLogic.jsx', import.meta.url), 'utf8');

  // A first run must say "not rented" out loud: an absent key normalizes to null,
  // which is what made a never-written rentedOnly indistinguishable from a real
  // "the user chose Local" and hid the missing persist above.
  assert.match(logic.match(/export function buildInitialSetup[\s\S]*?\n\}/)[0], /rentedOnly: false/);
  // Rented is a flavour of local routing, so it cannot outlive the local source.
  assert.match(
    logic.match(/export function applyRestoredPreferences[\s\S]*?\n\}/)[0],
    /rentedOnly: Boolean\(preferences\.rentedOnly && /,
  );
});
