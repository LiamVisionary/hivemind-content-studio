// Direction edits: the pick, the words, and the one constant set that has to
// agree with the gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    DIRECTION_LANES,
    EYES_CANVAS,
    SUN_RANGES,
    describeSunDirection,
    directionPayload,
    directionPromptText,
    directionReferenceParams,
    discFromSun,
    sunFromDisc,
} from '../src/lib/directionEdit.js';

const GATEWAY = '../../media-gateway/gateway/direction_reference.py';

test('the trigger sentence is the one each LoRA was trained on', () => {
    // Quoted from the model cards; a rewrite here silently stops the LoRA
    // firing, which looks like a bad model rather than a bad string.
    assert.equal(DIRECTION_LANES.eyes.trigger, 'change the eyes to match the reference dot direction');
    assert.equal(DIRECTION_LANES.sun.trigger, 'match the sun direction from the reference');
});

test('extra words are appended to the trigger, never substituted for it', () => {
    assert.equal(directionPromptText('eyes', ''), DIRECTION_LANES.eyes.trigger);
    assert.equal(directionPromptText('eyes', '  '), DIRECTION_LANES.eyes.trigger);
    assert.equal(
        directionPromptText('sun', 'add a clear blue sky'),
        'match the sun direction from the reference, add a clear blue sky',
    );
});

test('the studio and the gateway compose the same prompt', () => {
    // Deliberately textual: the other half of this rule is Python, so there is
    // nothing to render — graphs.direction_prompt_text builds the same string
    // for callers that never open the dialog (an agent, the MCP), and two
    // spellings of the trigger would put two different prompts on one lane.
    // test_direction_reference.py asserts the behaviour on that side.
    const source = readFileSync(new URL('../../media-gateway/gateway/graphs.py', import.meta.url), 'utf8');
    assert.match(source, /return f"\{trigger\}, \{extra\}" if extra else trigger/);
});

test('the eyes canvas matches the gateway renderer exactly', () => {
    // Deliberately textual: the constants being compared are Python literals.
    // The picker draws the reference itself, so these four numbers ARE the
    // image the model reads; they live in two languages, and this is what stops
    // them drifting.
    const source = readFileSync(new URL(GATEWAY, import.meta.url), 'utf8');
    const constant = (name) => Number(new RegExp(`^${name} = (\\d+)`, 'm').exec(source)?.[1]);
    assert.equal(constant('_CANVAS'), EYES_CANVAS.size);
    assert.equal(constant('_FRAME'), EYES_CANVAS.frame);
    assert.equal(constant('_DOT_RADIUS'), EYES_CANVAS.dot);
    assert.equal(constant('_BORDER'), EYES_CANVAS.border);
});

test('the sun ranges match the gateway renderer', () => {
    // Deliberately textual: same reason — the ranges the slider clamps to are
    // declared on the Python side, and a picker that let you pick an angle the
    // renderer then clamps would lie about what was sent.
    const source = readFileSync(new URL(GATEWAY, import.meta.url), 'utf8');
    const range = (name) => {
        const found = new RegExp(`^${name} = \\((-?[\\d.]+), (-?[\\d.]+)\\)`, 'm').exec(source);
        return { min: Number(found[1]), max: Number(found[2]) };
    };
    assert.deepEqual(range('SUN_ROTATION_RANGE'), { min: SUN_RANGES.rotation.min, max: SUN_RANGES.rotation.max });
    assert.deepEqual(range('SUN_ELEVATION_RANGE'), { min: SUN_RANGES.elevation.min, max: SUN_RANGES.elevation.max });
    assert.deepEqual(range('SUN_INTENSITY_RANGE'), { min: SUN_RANGES.intensity.min, max: SUN_RANGES.intensity.max });
});

test('the sun disc round-trips an angle', () => {
    for (const [rotation, elevation] of [[0, 45], [90, 30], [180, 10], [-90, 80], [-67, 41]]) {
        const disc = discFromSun(rotation, elevation);
        assert.deepEqual(sunFromDisc(disc.x, disc.y), { rotation, elevation });
    }
});

test('the disc reads the camera at the bottom and the backlight at the top', () => {
    // The whole point of a sky-dome picker over a lit-ball one: a ball can only
    // express light in FRONT of the subject, and backlight is half of what this
    // LoRA is for.
    assert.equal(sunFromDisc(0, 0.9).rotation, 0);
    assert.equal(sunFromDisc(0, -0.9).rotation, 180);
    assert.equal(sunFromDisc(0.9, 0).rotation, 90);
    assert.equal(sunFromDisc(-0.9, 0).rotation, -90);
    // The centre is the sun overhead, the rim is the sun at the horizon.
    assert.equal(sunFromDisc(0, 0).elevation, SUN_RANGES.elevation.max);
    assert.equal(sunFromDisc(0, 1).elevation, SUN_RANGES.elevation.min);
});

test('a drag outside the disc keeps steering instead of sticking', () => {
    const far = sunFromDisc(0, 4);
    assert.equal(far.elevation, SUN_RANGES.elevation.min);
    assert.equal(far.rotation, 0);
    assert.equal(sunFromDisc(4, 0).rotation, 90);
});

test('describeSunDirection names the quadrant and the height', () => {
    assert.equal(describeSunDirection(0, 45), 'behind the camera, midday');
    assert.equal(describeSunDirection(180, 10), 'behind the subject, low');
    assert.equal(describeSunDirection(-90, 80), 'left, high');
});

test('the payload clamps to what the LoRA was trained inside', () => {
    assert.deepEqual(
        directionPayload('sun', { rotation: 999, elevation: -40, intensity: 99, strength: 99, flattenLight: false }),
        { rotation: 180, elevation: 5, intensity: 3, flatten_light: false, strength: 1.6 },
    );
    assert.deepEqual(directionPayload('eyes', { x: -2, y: 7, strength: 0.75 }), { x: 0, y: 1, strength: 0.75 });
});

test('flattening the light is on unless it is turned off', () => {
    // The author's workflow ships the overcast pass enabled, because the LoRA
    // only lands cleanly on a picture with no light direction of its own.
    assert.equal(directionPayload('sun', {}).flatten_light, true);
    assert.equal(directionPayload('sun', { flattenLight: true }).flatten_light, true);
    assert.equal(directionPayload('sun', { flattenLight: false }).flatten_light, false);
});

test('the reference request carries only what each renderer needs', () => {
    assert.deepEqual(directionReferenceParams('eyes', { x: 0.25, y: 0.75, strength: 1 }),
        { kind: 'eyes', x: '0.25', y: '0.75' });
    assert.deepEqual(directionReferenceParams('sun', { rotation: 90, elevation: 20, intensity: 2, strength: 1 }),
        { kind: 'sun', rotation: '90', elevation: '20', intensity: '2' });
    assert.equal(directionReferenceParams('nonsense', {}), null);
});

test('each lane names the registry workflow that carries its LoRA', () => {
    const registry = JSON.parse(readFileSync(new URL('../../media-gateway/workflow-registry.json', import.meta.url), 'utf8'));
    for (const lane of Object.values(DIRECTION_LANES)) {
        const entry = registry.workflows.find((w) => w.id === lane.workflowId);
        assert.ok(entry, `${lane.workflowId} is not registered`);
        assert.equal(entry.builder, 'comfy-api-image');
        assert.equal(entry.requires.image, true);
        assert.ok(entry.accepts.includes('direction'), `${lane.workflowId} does not accept a direction`);
        // The LoRA is the workflow, so it is baked into the graph and add-on
        // LoRAs are off — the Eros v1.4 lane's shape.
        assert.equal(entry.supports_loras, false);
    }
});
