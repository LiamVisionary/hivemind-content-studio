// The delivery matrix: what a video target accepts, and how its prompt is
// written. See src/lib/videoDelivery.js.
//
// Every verdict here is traceable to the workflow registry or to the studio's
// own prompt families — the point of the module is that nothing guesses.
import assert from 'node:assert/strict';
import test from 'node:test';

const load = () => import('../src/lib/videoDelivery.js');

const H3 = { modelId: 'hivemind:minimax-h3', modelFamily: 'minimax' };
const LTX = { modelId: 'hivemind:ltx23-regular-fp8', modelFamily: 'ltx-2.3' };
const EROS = { modelId: 'hivemind:ltx23-eros-v14-comfy', modelFamily: 'ltx' };

test('H3 reference pictures and start/end frames are alternatives, never a pair', async () => {
    const { deliveryPlan } = await load();
    const plan = deliveryPlan(H3, { referenceLane: true });
    assert.equal(plan.pictures.kind, 'reference');
    assert.equal(plan.pictures.max, 9);
    // minimax-h3-reference.accepts carries no image_path at all; the registry
    // says the nine pictures come "instead of a start/end frame".
    assert.equal(plan.framesExcludePictures, true);
});

test('a lane the catalog has not declared is never promised', async () => {
    const { deliveryPlan } = await load();
    assert.equal(deliveryPlan(H3, {}).pictures, null);
    assert.equal(deliveryPlan(LTX, {}).pictures, null);
    assert.equal(deliveryPlan(LTX, { ingredientsLane: true }).pictures.kind, 'ingredients');
});

test('an end frame appears only where the model declares one', async () => {
    const { deliveryPlan } = await load();
    assert.deepEqual(deliveryPlan(LTX, {}).frames, ['start', 'middle']);
    assert.deepEqual(deliveryPlan(LTX, { endFrame: true }).frames, ['start', 'middle', 'end']);
    assert.deepEqual(deliveryPlan(H3, {}).frames, ['start']);
});

test('10Eros wants the scene script, not LTX 2.3’s paragraph', async () => {
    const { deliveryPlan } = await load();
    const plan = deliveryPlan(EROS, { ingredientsLane: true });
    assert.equal(plan.textGrammar, 'ltx-scene-script');
    assert.equal(plan.pictures, null, 'its graph takes no pictures');
    assert.deepEqual(plan.frames, []);
});

test('Seedance is matched by id, and 2.5 alone holds the full half-minute', async () => {
    const { deliveryPlan } = await load();
    assert.equal(deliveryPlan({ modelId: 'seedance-2.5-t2v' }).maxSeconds, 30);
    assert.equal(deliveryPlan({ modelId: 'seedance-lite-i2v' }).maxSeconds, 10);
    assert.equal(deliveryPlan({ modelId: 'seedance-lite-i2v' }).textGrammar, 'seedance-blocks');
});

test('only H3 renders its own audio, and only LTX reads a negative prompt', async () => {
    const { deliveryPlan } = await load();
    assert.equal(deliveryPlan(H3, { referenceLane: true }).audio, true);
    assert.equal(deliveryPlan(H3, { referenceLane: true }).negatives, false);
    assert.equal(deliveryPlan(LTX, {}).audio, false);
    assert.equal(deliveryPlan(LTX, {}).negatives, true);
    assert.equal(deliveryPlan({ modelId: 'seedance-2.5-t2v' }).negatives, false);
});

test('a model nothing is known about still gets a plan it can keep', async () => {
    const { deliveryPlan } = await load();
    const plan = deliveryPlan({ modelId: 'kling-2-1-pro' }, { referenceLane: true, ingredientsLane: true });
    assert.equal(plan.family, '');
    assert.equal(plan.textGrammar, 'prose');
    // Declared lanes are ignored for a family whose picture vocabulary is unknown:
    // sending pictures somewhere with no idea what they mean is worse than not.
    assert.equal(plan.pictures, null);
    assert.deepEqual(plan.frames, ['start']);
});

test('the grammar follows what will actually be attached', async () => {
    const { deliveryPlan, grammarFor } = await load();
    const plan = deliveryPlan(H3, { referenceLane: true });
    assert.equal(grammarFor(plan, { pictures: 0 }).id, 'h3-text');
    assert.equal(grammarFor(plan, { pictures: 3 }).id, 'h3-reference');
    const noLane = deliveryPlan(H3, {});
    assert.equal(grammarFor(noLane, { pictures: 3 }).id, 'h3-text', 'a lane that is not there cannot change the grammar');
});

test('a per-model ceiling overrides the family’s', async () => {
    const { deliveryPlan } = await load();
    assert.equal(deliveryPlan(H3, { referenceLane: true, maxSeconds: 8 }).maxSeconds, 8);
    assert.equal(deliveryPlan(H3, { referenceLane: true }).maxSeconds, 15);
});

test('describePlan says what will and will not travel', async () => {
    const { deliveryPlan, describePlan } = await load();
    assert.match(describePlan(deliveryPlan(H3, { referenceLane: true }), { pictures: 4 }), /4 as reference pictures/);
    assert.match(describePlan(deliveryPlan(LTX, { ingredientsLane: true }), { pictures: 4 }), /4 as ingredient references/);
    assert.match(describePlan(deliveryPlan({ modelId: 'seedance-2.5-t2v' }), { pictures: 4 }), /would not travel/);
    assert.match(describePlan(deliveryPlan({ modelId: 'seedance-2.5-t2v' }), { pictures: 0 }), /frames only/);
});
