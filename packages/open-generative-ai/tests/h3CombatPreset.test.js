// The fight preset — what it moves on each lane, and that turning it off puts
// every one of them back.
//
// The restore contract is the whole reason this preset carries a snapshot, so
// most of what is checked here is the round trip: arm, persist, reload,
// disarm, and land on exactly the values that were there before.
//
// Deliberately textual: the last three tests only. Each pins a rule that lives
// on a path a static render never reaches — the SEND path (whether the
// interpolation multiplier is gated on the selected lane's capability, which
// needs a real generate to observe), the PERSIST path (what reaches the
// plaintext settings blob, which needs localStorage and a mounted front tab),
// and an EFFECT (re-arming on a lane change; effects do not run under a server
// render). The panel above them is rendered.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderComponent, textOf } = require('./helpers/render.js');

// A rented/hosted H3 ComfyUI lane: every dial the preset knows about.
const COMFY = {
  capabilities: { spectrum: true, fastHighRes: true, interpolation: true, nativeH3: false },
  resolutions: ['High', 'Standard', 'Max'],
};
// The Apple-silicon lane (h3.c): no Spectrum, no two-pass, no interpolation
// node — but its own speed shortcuts to switch off.
const NATIVE = {
  capabilities: { spectrum: false, fastHighRes: false, interpolation: false, nativeH3: true },
  resolutions: ['High', 'Standard', 'Max'],
};

const setupAt = (over = {}) => ({
  modelId: 'hivemind-media:minimax-h3',
  resolution: 'High',
  spectrum: null,
  fastHighRes: false,
  interpolate: null,
  h3Native: null,
  prompt: '',
  combat: null,
  ...over,
});

test('the plan names every dial this lane has, and says which it lacks', async () => {
  const { combatPlan } = await import('../src/lib/h3CombatPreset.js');
  const comfy = combatPlan({ setup: setupAt(), ...COMFY });
  assert.deepEqual(comfy.changes.map((c) => c.key), ['resolution', 'fastHighRes', 'spectrum', 'interpolate']);
  assert.deepEqual(comfy.unavailable.map((c) => c.key), ['h3Native']);
  // Every row carries its reason: the menu prints these, and a preset that
  // moves a setting without saying why is the thing this panel exists to avoid.
  comfy.changes.forEach((change) => assert.ok(change.why.length > 30, change.key));

  const native = combatPlan({ setup: setupAt(), ...NATIVE });
  assert.deepEqual(native.changes.map((c) => c.key), ['resolution', 'h3Native']);
  assert.deepEqual(native.unavailable.map((c) => c.key), ['fastHighRes', 'spectrum', 'interpolate']);
});

test('a dial already set the combat way is reported, not counted as a change', async () => {
  const { combatPlan } = await import('../src/lib/h3CombatPreset.js');
  const plan = combatPlan({ setup: setupAt({ resolution: 'Max', spectrum: false }), ...COMFY });
  assert.deepEqual(plan.changes.map((c) => c.key), ['fastHighRes', 'interpolate']);
  assert.deepEqual(plan.alreadySet.map((c) => c.key), ['resolution', 'spectrum']);
});

test('arming writes the combat values and records what they were', async () => {
  const { armCombat } = await import('../src/lib/h3CombatPreset.js');
  const { setup, snapshot } = armCombat(setupAt(), { ...COMFY, loraIds: ['lora-a'] });
  assert.equal(setup.resolution, 'Max');
  assert.equal(setup.fastHighRes, true);
  assert.equal(setup.spectrum, false);
  assert.equal(setup.interpolate, 2);
  // The lane it was armed on, so a model switch can re-arm instead of
  // restoring another workflow's values.
  assert.equal(snapshot.modelId, 'hivemind-media:minimax-h3');
  assert.deepEqual(snapshot.dials, { resolution: 'High', fastHighRes: false, spectrum: null, interpolate: null });
  assert.deepEqual(snapshot.loraIds, ['lora-a']);
  // A dial this lane does not have is never snapshotted — restoring it would
  // write a value the lane never held.
  assert.ok(!('h3Native' in snapshot.dials));
});

test('disarming restores every dial, through the plaintext settings blob', async () => {
  const { armCombat, disarmCombat, normalizeCombatSnapshot } = await import('../src/lib/h3CombatPreset.js');
  const before = setupAt({ resolution: 'Standard', spectrum: true, fastHighRes: true, interpolate: null });
  const { setup: armed } = armCombat(before, COMFY);
  // Round-tripped the way a reload does it: JSON, then the normalizer.
  const reloaded = { ...armed, combat: normalizeCombatSnapshot(JSON.parse(JSON.stringify(armed.combat))) };
  const after = disarmCombat(reloaded);
  assert.equal(after.resolution, 'Standard');
  assert.equal(after.spectrum, true);
  assert.equal(after.fastHighRes, true);
  assert.equal(after.interpolate, null);
  assert.equal(after.combat, null);
});

test('the h3.c lane turns its speed shortcuts off and puts them back', async () => {
  const { armCombat, disarmCombat } = await import('../src/lib/h3CombatPreset.js');
  const before = setupAt({ h3Native: { preset: 'fast', reuse: 2, steps: 20 } });
  const { setup: armed } = armCombat(before, NATIVE);
  assert.equal(armed.h3Native.preset, 'balanced');
  assert.equal(armed.h3Native.reuse, 1);
  assert.equal(armed.h3Native.render_scale, 1);
  assert.equal(armed.h3Native.token_reduction, false);
  // The steps the user had set are carried, not reset: the preset owns the
  // shortcuts, not the whole bench.
  assert.equal(armed.h3Native.steps, 20);
  assert.deepEqual(disarmCombat(armed).h3Native, { preset: 'fast', reuse: 2, steps: 20 });
});

test('an untouched dial comes back as null rather than vanishing from the blob', async () => {
  const { armCombat, normalizeCombatSnapshot, disarmCombat } = await import('../src/lib/h3CombatPreset.js');
  // `interpolate` absent entirely — the shape a setup saved before the field
  // existed has. JSON would drop an `undefined`, and the dial would then never
  // be restored.
  const bare = { modelId: 'x', resolution: 'High' };
  const { setup: armed } = armCombat(bare, COMFY);
  const saved = normalizeCombatSnapshot(JSON.parse(JSON.stringify(armed.combat)));
  assert.equal(saved.dials.interpolate, null);
  assert.equal(disarmCombat({ ...armed, combat: saved }).interpolate, null);
});

test('the direction sentence lands in the description of both H3 formats', async () => {
  const { applyCombatPrompt, COMBAT_PHRASE_H3 } = await import('../src/lib/h3CombatPreset.js');
  const threeField = [
    'integrated_multimodal_description: [Shot 1] Two fighters circle in a stairwell.',
    'overall_soundscape: Concrete room tone.',
    'non_diegetic_music: N/A',
  ].join('\n\n');
  const armed = applyCombatPrompt(threeField, true, { h3: true });
  // Not in the music field, which is where a plain append would have put it.
  assert.match(armed, /circle in a stairwell\.\nFight direction:/);
  assert.match(armed, /non_diegetic_music: N\/A$/);
  assert.ok(armed.includes(COMBAT_PHRASE_H3));
  // And out again, byte for byte.
  assert.equal(applyCombatPrompt(armed, false, { h3: true }), threeField);
});

test('the phrase is stripped in either dialect, because the model can change under it', async () => {
  const { applyCombatPrompt } = await import('../src/lib/h3CombatPreset.js');
  const prose = applyCombatPrompt('A duel on a rooftop.', true, { h3: false });
  // Armed on a cloud model, then the tab switches to H3: the phrase in the box
  // is the prose one, and clearing must still find it.
  assert.equal(applyCombatPrompt(prose, false, { h3: true }), 'A duel on a rooftop.');
  // Re-arming replaces rather than stacks.
  const twice = applyCombatPrompt(prose, true, { h3: true });
  assert.equal(twice.match(/Fight direction:/g).length, 1);
});

test('the LoRA is matched from what the lane reports, never invented', async () => {
  const { combatLoraFrom, combatPlan, COMBAT_LORA } = await import('../src/lib/h3CombatPreset.js');
  assert.equal(combatLoraFrom([]), null);
  assert.equal(combatLoraFrom([{ id: 'a', displayName: 'Cinematic Grain' }]), null);
  const hit = combatLoraFrom([
    { id: 'a', displayName: 'Cinematic Grain' },
    { id: 'b', displayName: 'MiniMax H3 Combat Base — fight motion' },
  ]);
  assert.equal(hit.id, 'b');
  // "combatant" is not a fight LoRA and neither is "uncombative": the match is
  // word-bounded so a substring cannot arm the wrong file.
  assert.equal(combatLoraFrom([{ id: 'c', displayName: 'Wombats' }]), null);
  // Nothing installed is a fact the menu prints with the source beside it.
  const plan = combatPlan({ setup: setupAt(), ...COMFY, availableLoras: [] });
  assert.equal(plan.lora, null);
  assert.match(COMBAT_LORA.source, /^https:\/\/civitai\.com\//);
});

/* ---------------- the panel ---------------- */

// The popover's body is its own export precisely so it can be rendered: a
// Menu is closed under a static render, and the copy inside it — which dials
// this lane is about to have moved — is the whole point of the door.
async function panel(props) {
  return textOf(await renderComponent('src/studios/video/CombatMenu.jsx', 'CombatPanel', {
    onApply: () => {}, close: () => {}, ...props,
  }));
}

test('the panel names the dials it will move, before it moves any', async () => {
  const { combatPlan } = await import('../src/lib/h3CombatPreset.js');
  const text = await panel({ armed: false, plan: combatPlan({ setup: setupAt(), ...COMFY }) });
  assert.match(text, /On this lane/);
  // Each dial, and what it is at right now — the value the button is about to
  // change out from under them.
  assert.match(text, /Size.*\(now High\)/);
  assert.match(text, /Fast high-res.*\(now off\)/);
  assert.match(text, /Spectrum.*\(now on\)/);
  assert.match(text, /Motion smoothing.*\(now off\)/);
  assert.match(text, /Tune for combat/);
});

test('the panel says what this lane cannot do, rather than arming four of five silently', async () => {
  const { combatPlan } = await import('../src/lib/h3CombatPreset.js');
  const text = await panel({ armed: false, plan: combatPlan({ setup: setupAt(), ...NATIVE }) });
  assert.match(text, /Not here.*Fast high-res, Spectrum, Motion smoothing/);
  assert.match(text, /this lane's graph has no such control/);
});

test('with no fight LoRA installed the panel says so and names the source', async () => {
  const { combatPlan, COMBAT_LORA } = await import('../src/lib/h3CombatPreset.js');
  const missing = await panel({ plan: combatPlan({ setup: setupAt(), ...COMFY, availableLoras: [] }) });
  assert.match(missing, /No fight LoRA is installed on this lane/);
  assert.ok(missing.includes(COMBAT_LORA.sourceLabel), 'the source is named, not just the gap');
  const installed = await panel({
    plan: combatPlan({
      setup: setupAt(), ...COMFY, availableLoras: [{ id: 'b', displayName: 'H3 Combat Base' }],
    }),
  });
  assert.match(installed, /H3 Combat Base is installed on this lane/);
});

test('armed, the panel offers the way back rather than only the way in', async () => {
  const { combatPlan } = await import('../src/lib/h3CombatPreset.js');
  const text = await panel({ armed: true, plan: combatPlan({ setup: setupAt(), ...COMFY }) });
  assert.match(text, /Holding/);
  assert.match(text, /Turn off and restore/);
  assert.match(text, /restores the dials it moved/);
});

/* ---------------- the wiring, pinned at the source ---------------- */

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('interpolation is gated on the capability everywhere it travels', () => {
  // The registry derivation, in the ONE place capabilities are derived.
  assert.match(read('src/lib/hivemindStudio.js'), /supportsInterpolation: accepts\.includes\('interpolate'\)/);
  // The send path, gated like fast high-res and steps beside it, so a value
  // left on from H3 cannot ride into a graph with no interpolation node.
  assert.match(
    read('src/studios/VideoStudio.jsx'),
    /Number\(setup\.interpolate\) >= 2 && supportsInterpolation\(currentModel\(setup, s\.catalogs\)\)/,
  );
  // And the switch only renders where the graph has the node.
  assert.match(read('src/studios/video/VideoAdvanced.jsx'), /\{interpolationAvailable \? \(/);
});

test('the snapshot persists as settings, and the sentence does not', () => {
  const prefs = read('src/lib/videoPreferences.js');
  assert.match(prefs, /combat: normalizeCombatSnapshot\(value\.combat\)/);
  assert.match(prefs, /interpolate: \(typeof value\.interpolate === 'number'/);
  // The direction rides with the prompt in the encrypted composer, like every
  // other phrase — the plaintext blob holds dial values only.
  const preset = read('src/lib/h3CombatPreset.js');
  assert.doesNotMatch(preset, /normalizeCombatSnapshot[\s\S]*?prompt/);
  assert.match(read('src/studios/VideoStudio.jsx'), /combat: s\.setup\.combat,/);
});

test('a lane change re-arms instead of carrying another lane’s snapshot', () => {
  const studio = read('src/studios/VideoStudio.jsx');
  assert.match(studio, /if \(combatSnapshotModelId\(s\.setup\) === s\.setup\.modelId\) return;/);
  // And it re-arms over the RESTORED setup, not the armed one: snapshotting
  // Max/on/2x as "what it was before" is how a lane you armed, left and came
  // back to would stop being able to turn the preset off.
  assert.match(studio, /const restored = disarmCombat\(s\.setup\);/);
  assert.match(studio, /armCombat\(clean, \{/);
});

test('re-arming over an armed setup would trap the dials \u2014 the lib composes to avoid it', async () => {
  const { armCombat, disarmCombat } = await import('../src/lib/h3CombatPreset.js');
  const start = setupAt({ resolution: 'Standard', spectrum: true, fastHighRes: false });
  // Arm on the ComfyUI lane, leave for another, come back and arm again the
  // way the studio's effect does it: disarm first, then arm.
  const { setup: armedA } = armCombat(start, COMFY);
  const { setup: armedB } = armCombat(disarmCombat(armedA), { ...COMFY, loraIds: [] });
  assert.deepEqual(armedB.combat.dials, armedA.combat.dials, 'the second snapshot is still the real before');
  const back = disarmCombat(armedB);
  assert.equal(back.resolution, 'Standard');
  assert.equal(back.spectrum, true);
  assert.equal(back.fastHighRes, false);
});
