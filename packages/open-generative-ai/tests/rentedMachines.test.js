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

test('a pending switch reads as done before the server says so', async () => {
  const { isRoutingLeader, withSelection } = await import('../src/lib/rentedMachines.js');
  // Selecting is a round-trip, and until it lands the picker used to keep
  // pointing at the machine you just switched AWAY from — so the click read as
  // a no-op and got made again. This is the answer rendered on the click,
  // mirroring the priority the server writes (max + 1).
  const a = { rental_id: 7, attached: true, priority: 1, models_served: ['minimax_h3'] };
  const b = { rental_id: 8, attached: true, priority: 4, models_served: ['minimax_h3'] };
  const idle = { rental_id: 9, attached: false, priority: 0, models_served: ['minimax_h3'] };

  const switched = withSelection([a, b, idle], 7);
  assert.equal(isRoutingLeader(switched.find((m) => m.rental_id === 7), switched), true);
  assert.equal(isRoutingLeader(switched.find((m) => m.rental_id === 8), switched), false);
  assert.deepEqual([a.priority, b.priority], [1, 4], 'the live list is not mutated');

  // Selecting a machine that is only idle attaches it too — the optimistic
  // view has to say so, or the row would still read "switch" while it lands.
  const attached = withSelection([a, b, idle], 9);
  assert.equal(isRoutingLeader(attached.find((m) => m.rental_id === 9), attached), true);
});

test('a refresh forced by a switch is never answered by a request that predates it', async () => {
  const { rentedMachinesState, notifyRentedMachinesChanged } = await import('../src/lib/rentedMachines.js');
  // The studios poll on a timer AND refresh on every attachment change. If the
  // forced read joined a poll that started before the switch, it would report
  // the old machine as leading and nothing would correct it for a full poll
  // interval — the switch would look like it had silently reverted.
  const machine = (rental_id, priority) => ({
    managed: true, attached: true, tunnel_alive: true, phase: 'ready', rental_id, priority,
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let served = [machine(7, 2), machine(8, 1)];
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) await gate;
    const rentals = served;
    return { ok: true, json: async () => ({ rentals }) };
  };

  const poll = rentedMachinesState({ force: true });   // in flight, pre-switch
  served = [machine(7, 2), machine(8, 3)];             // the switch lands
  notifyRentedMachinesChanged();
  const afterSwitch = rentedMachinesState({ force: true });
  release();

  const state = await afterSwitch;
  await poll;
  assert.equal(requests, 2, 'the stale request cannot answer a post-change read');
  assert.deepEqual(state.live.map((m) => m.priority), [2, 3], 'the switch is visible');
  const settled = await rentedMachinesState();
  assert.deepEqual(settled.live.map((m) => m.priority), [2, 3],
    'and the stale response must not overwrite it on the way in');
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
  const logic = fs.readFileSync(new URL('../src/studios/video/videoLogic.js', import.meta.url), 'utf8');

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

/* ---------------- per-tab "Run on" pin ---------------- */

test('withPin puts the pinned box in front for THIS tab only, and is inert for an unattached pin', async () => {
  const { withPin, isRoutingLeader } = await import('../src/lib/rentedMachines.js');
  // Two H3 boxes; the GLOBAL priority says 48 leads.
  const m47 = { rental_id: 'vast:47', attached: true, priority: 0, models_served: ['minimax_h3'] };
  const m48 = { rental_id: 'vast:48', attached: true, priority: 3, models_served: ['minimax_h3'] };
  const idle = { rental_id: 'vast:49', attached: false, priority: 0, models_served: ['minimax_h3'] };
  const all = [m47, m48, idle];

  assert.equal(isRoutingLeader(m48, withPin(all, '')), true, 'no pin: the server order stands');
  assert.equal(isRoutingLeader(m47, withPin(all, 'vast:47')), true, 'pinned box leads this tab');
  assert.equal(isRoutingLeader(m48, withPin(all, 'vast:47')), false);
  // The input list is never mutated — the other tab's picker reads the same array.
  assert.equal(m48.priority, 3);
  assert.equal(isRoutingLeader(m48, all), true, 'the shared list still says 48 leads');
  // A pin naming a box with no lane (idle / detached) does nothing: the gateway
  // has nothing to route to, and the panel drops it as stale.
  assert.equal(withPin(all, 'vast:49'), all);
  assert.equal(withPin(all, 'vast:gone'), all);
  assert.deepEqual(withPin(null, 'vast:47'), []);
});

test('the studios send the tab pin as run_on only in Rented mode, persist it, and copy it with the tab', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const read = (rel) => fs.readFileSync(new URL(path.join('..', rel), import.meta.url), 'utf8');
  const image = read('src/studios/ImageStudio.jsx');
  const video = read('src/studios/VideoStudio.jsx');

  // Image: one helper, gated on the Rented source, spread into every generate/upscale call.
  assert.match(image, /const runOn = \(\) => \(s\.rentedOnly && s\.rentedMachineId \? \{ run_on: s\.rentedMachineId \} : \{\}\);/);
  // \s* rather than \n\s+: the invariant is that the lane and the pin travel
  // TOGETHER on every local generate, not that they sit on two lines. Two of
  // them moved onto one line when the calls were routed through modelRunner.
  const generateCalls = image.match(/studio_lane: studioLane,\s*\.\.\.runOn\(\),/g) || [];
  assert.equal(generateCalls.length, 5, 'every local generate call carries the pin');
  assert.match(image, /localAI\.upscale\(\{[^}]*\.\.\.runOn\(\) \}\)/);
  // Video: the hivemind request carries it, gated the same way.
  assert.match(video, /\.\.\.\(setup\.rentedOnly && setup\.rentedMachineId \? \{ run_on: setup\.rentedMachineId \} : \{\}\),/);
  // Both persist it alongside rentedOnly…
  assert.match(image.match(/const currentImagePreferences = [\s\S]*?\n  \};/)[0], /rentedMachineId: s\.rentedMachineId/);
  assert.match(video.match(/const currentVideoPreferences = [\s\S]*?\n  \}\);/)[0], /rentedMachineId: s\.setup\.rentedMachineId/);
  // …and hand the picker the value + the writer, so the machine list edits THIS
  // tab. The rented card lives INSIDE the Runs-on list now — a rental is a
  // property of This Mac, not a mode of its own — so both studios hand the pin
  // to RunOnPicker and it mounts the panel under the This Mac group.
  assert.match(
    read('src/components/RunOnPicker.jsx'),
    /<RentedSourceStatus engine=\{engine\} page=\{page\} pinned=\{pinned\} onPin=\{onPin\} \/>/,
  );
  for (const [file, page] of [['src/studios/image/ImageSettingsPanel.jsx', 'image'],
    ['src/studios/image/ImageComposer.jsx', 'image'], ['src/studios/VideoStudio.jsx', 'video']]) {
    assert.match(read(file), new RegExp(`page="${page}"\\n\\s+pinned=\\{runOn\\.pinned\\}\\n\\s+onPin=\\{runOn\\.onPin\\}`));
  }
  assert.match(image, /onPin: pinMachine,/);
  assert.match(video, /onPin: pinMachine,/);

  const { IMAGE_TAB_FIELDS } = await import('../src/lib/studioTabs.js');
  assert.ok(IMAGE_TAB_FIELDS.includes('rentedMachineId'), 'a duplicated image tab keeps its machine');
  const { normalizeImagePreferences } = await import('../src/studios/image/imagePrefs.js');
  assert.equal(normalizeImagePreferences({ modelId: 'm', rentedMachineId: ' vast:47 ' }).rentedMachineId, 'vast:47');
  const { normalizeVideoPreferences } = await import('../src/lib/videoPreferences.js');
  assert.equal(normalizeVideoPreferences({ modelId: 'm', rentedMachineId: 'vast:48' }).rentedMachineId, 'vast:48');
  assert.equal(normalizeVideoPreferences({ modelId: 'm' }).rentedMachineId, '');
});

test('the Rented panel pins per tab instead of rewriting the global selection', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../src/studios/RentedSourceStatus.jsx', import.meta.url), 'utf8');
  // The picker used to POST /select — one global priority that every tab then
  // followed, which is exactly the "tab 1 flipped when I switched in tab 2" bug.
  assert.doesNotMatch(source, /\/select/);
  assert.match(source, /onPin\(machine\.rental_id\)/);
  // An idle/broken box is attached (plain attach: the global order is left alone) and only then pinned.
  assert.match(source, /\/attach`, \{ method: 'POST' \}\);\n\s+onPin\(machine\.rental_id\);/);
  // A pin whose machine is no longer attached is dropped — but never on an empty
  // list, which is what an unreachable API looks like.
  assert.match(source, /known\.length > 0\n\s+&& !known\.some\(\(machine\) => machine\.rental_id === pinned && machine\.attached\)/);
  assert.match(source, /withPin\(known, pinned\)/);
});
