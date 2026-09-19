// MiniMax H3 (Apple Silicon): the bench in the Video drawer, and the rule that
// makes it portable.
//
// The rule is "only what was changed travels". An untouched studio must send
// NOTHING — no preset, no dials — because that is what asks the gateway to pick
// a preset for whatever Mac the render lands on. The moment this file stops
// holding, a tab saved on a 128 GB M5 opens on a 16 GB Air already pinned to a
// preset that machine cannot hold, and nothing in the UI would say so.
//
// The second rule is that the panel is the REGISTRY's, not the studio's: the
// presets, their dial values and the sentence about token reduction all arrive
// on the workflow row. A default written into the frontend would be a second
// copy of the engine's, and the two would drift the first time upstream
// remeasured a recipe.
//
// Deliberately textual: the last two tests. Both pin a rule that only holds on
// a code path a static render never reaches — the SEND path (whether the dials
// are gated on the selected lane, which needs a real generate to observe) and
// the PERSIST path (whether an empty bag survives a round trip as null, which
// needs localStorage and a mounted front tab). Everything above them is
// rendered or exercised through the real module.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderComponent, textOf } = require('./helpers/render.js');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const REGISTRY = JSON.parse(read('../media-gateway/workflow-registry.json'));
const LANE = REGISTRY.workflows.find((workflow) => workflow.id === 'minimax-h3-native');

async function lib() {
    return import(new URL('../src/lib/h3Native.js', `file://${__filename}`).href);
}

test('the request carries only what was changed', async () => {
    const { h3NativeRequest } = await lib();
    // Untouched: nothing at all, so the gateway recommends for this machine.
    assert.equal(h3NativeRequest({}), null);
    assert.equal(h3NativeRequest(null), null);
    assert.equal(h3NativeRequest(undefined), null);
    // A preset alone.
    assert.deepEqual(h3NativeRequest({ preset: 'draft' }), { preset: 'draft' });
    // A dial pins its numbers, and a switch its boolean — and nothing else.
    assert.deepEqual(
        h3NativeRequest({ preset: 'balanced', layers: 42, token_reduction: true }),
        { preset: 'balanced', layers: 42, token_reduction: true },
    );
    // Empty strings and nulls are "unset", not zero.
    assert.equal(h3NativeRequest({ preset: '', steps: null, layers: '' }), null);
});

test('the slider opens on what this Mac recommends until someone moves it', async () => {
    const { resolveH3Preset } = await lib();
    const profile = { machine: { recommended: { preset: 'balanced' } } };
    const untouched = resolveH3Preset({}, LANE.h3_native, profile);
    assert.equal(untouched.name, 'balanced');
    assert.equal(untouched.explicit, false, 'an untouched studio has made no choice');

    // A different machine, same untouched studio, different stop.
    const small = resolveH3Preset({}, LANE.h3_native, { machine: { recommended: { preset: 'draft' } } });
    assert.equal(small.name, 'draft');

    // And a choice is a choice on every machine.
    const chosen = resolveH3Preset({ preset: 'reference' }, LANE.h3_native, profile);
    assert.equal(chosen.name, 'reference');
    assert.equal(chosen.explicit, true);

    // With no gateway answer at all it still has somewhere to stand: the
    // registry's own default, never a blank slider.
    const offline = resolveH3Preset({}, LANE.h3_native, null);
    assert.equal(offline.name, LANE.h3_native.default_preset);
});

test('the dials read through the preset, and say when they have left it', async () => {
    const { resolveH3Preset, effectiveH3Dials, h3DialsAreCustom } = await lib();
    const { preset } = resolveH3Preset({ preset: 'balanced' }, LANE.h3_native, null);
    const plain = effectiveH3Dials({ preset: 'balanced' }, preset);
    assert.equal(plain.steps, LANE.h3_native.presets.balanced.steps);
    assert.equal(plain.layers, LANE.h3_native.presets.balanced.layers);
    assert.equal(h3DialsAreCustom({ preset: 'balanced' }, preset), false);

    const moved = effectiveH3Dials({ preset: 'balanced', layers: 44 }, preset);
    assert.equal(moved.layers, 44);
    assert.equal(moved.steps, LANE.h3_native.presets.balanced.steps, 'an untouched dial still follows the preset');
    assert.equal(h3DialsAreCustom({ preset: 'balanced', layers: 44 }, preset), true);
    // Setting a dial to the value it already had is not "custom".
    assert.equal(h3DialsAreCustom({ preset: 'balanced', layers: preset.layers }, preset), false);
});

test('token reduction is refused where upstream says it produces artefacts', async () => {
    const { tokenReductionBlocked } = await lib();
    // The Draft recipe: 40 blocks, velocity reused every third step.
    assert.equal(tokenReductionBlocked({ layers: 40, reuse: 3 }), true);
    assert.equal(tokenReductionBlocked({ layers: 50, reuse: 2 }), false);
    assert.equal(tokenReductionBlocked({ layers: 40, reuse: 1 }), false);
    // And it is never the default anywhere.
    assert.equal(LANE.h3_native.token_reduction.default, false);
});

test('the panel renders the registry, and says what is missing before it is asked for', async () => {
    const markup = await renderComponent('src/studios/video/H3NativePanel.jsx', 'H3NativePanel', {
        nativeH3: LANE.h3_native,
        setup: {},
        onChange: () => {},
        active: false,   // no gateway fetch in a static render
    });
    const text = textOf(markup);
    // Every stop of the ladder is named, in the registry's own words.
    for (const name of LANE.h3_native.preset_order) {
        assert.ok(text.includes(LANE.h3_native.presets[name].label), `the ${name} stop is missing`);
    }
    assert.match(text, /How much work to spend/, 'the ladder needs a name a person can read');
    assert.match(text, /Show the individual dials/, 'the dials must be reachable');
});

test('the panel disappears entirely on every other lane', async () => {
    const markup = await renderComponent('src/studios/video/H3NativePanel.jsx', 'H3NativePanel', {
        nativeH3: null,
        setup: {},
        onChange: () => {},
        active: false,
    });
    assert.equal(markup, '', 'a workflow with no h3_native block gets no bench');
});

test('the studio only sends these dials on the lane that declares them', () => {
    const studio = read('src/studios/VideoStudio.jsx');
    // The same gate the Refinement and Fast high-res settings use: a preference
    // saved on this lane must not ride along into a ComfyUI graph that has no
    // idea what a transformer-block count is.
    assert.match(
        studio,
        /nativeH3\)\s*\{[\s\S]{0,200}?h3NativeRequest\(setup\.h3Native\)/,
        'h3_native must be gated on the selected model declaring the lane',
    );
    // And the mapper is the only place `accepts` is read for this capability.
    const mapper = read('src/lib/hivemindStudio.js');
    assert.match(mapper, /accepts\.includes\('h3_native'\)/, 'the capability is derived in the registry mapper');
    assert.doesNotMatch(studio, /accepts\.includes\('h3_native'\)/, 'the studio must not re-test accepts');
});

test('a misaligned snapshot is said in the panel with its one command', () => {
    // The gateway's profile carries `advisory` when the checkpoint's shards
    // were written without the safetensors header padding: the render is still
    // right (the runner copies the weights) but heavier, and the person on a
    // smaller Mac needs the command, not a mystery.
    const panel = read('src/studios/video/H3NativePanel.jsx');
    assert.match(panel, /machine\?\.advisory \? \(/, 'the advisory must render when present');
    assert.match(panel, /machine\.advisory\.reason/, 'with its reason');
    assert.match(panel, /machine\.advisory\.fix/, 'and the fix beside it');
});

test('what is saved is what was chosen, never what was resolved', () => {
    const prefs = read('src/lib/videoPreferences.js');
    assert.match(prefs, /normalizeH3NativePreferences/, 'the dials must be normalized like every other setting');
    // An empty bag normalizes to null: "nothing set" has to survive a round
    // trip, or a reload would pin one machine's recommendation.
    assert.match(
        prefs,
        /export function normalizeH3NativePreferences[\s\S]{0,900}?return Object\.keys\(out\)\.length \? out : null;/,
        'an empty bag must persist as null, not as {}',
    );
});
