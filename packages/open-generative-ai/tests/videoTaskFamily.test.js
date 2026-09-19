import assert from 'node:assert/strict';
import test from 'node:test';
import { isLtxFamilyModel, videoTasksFor } from '../src/lib/videoTasks.js';

// Capability must follow the workflow's REGISTRY FAMILY, not "is it a hivemind
// model" — that blanket check offered Extend/Head-swap (LTX graph features) on
// MiniMax H3, which has neither.
test('extend/head-swap are offered ONLY for LTX-family workflows', () => {
  const ltx = { modelId: 'hivemind-media:ltx23-eros-v14-dmd', modelFamily: 'ltx-2.3' };
  const h3 = { modelId: 'hivemind-media:minimax-h3', modelFamily: 'minimax' };
  assert.deepEqual(videoTasksFor(ltx), ['generate', 'extend', 'head-swap']);
  assert.deepEqual(videoTasksFor(h3), ['generate'], 'H3 has no extension graph or head-swap LoRA');
});

test('family falls back to the id for setups persisted before the field', () => {
  // Real ids carry the provider prefix — the fallback must look past it.
  assert.equal(isLtxFamilyModel({ modelId: 'hivemind-media:ltx23-eros-v14-dmd' }), true);
  assert.equal(isLtxFamilyModel({ modelId: 'hivemind-media:minimax-h3' }), false);
  // …and ONLY past it. A bare id belongs to a cloud provider, whose model names
  // live in a different namespace that collides: the remote catalog ships
  // `ltx-2-pro-image-to-video` and MiniMax Hailuo, neither of which is the local
  // LTX graph. Guessing a registry family from an unprefixed id would hand a
  // remote model the extend/head-swap tabs it cannot run.
  assert.equal(isLtxFamilyModel({ modelId: 'ltx-2-pro-image-to-video' }), false);
  assert.equal(isLtxFamilyModel({ modelId: 'ltx23-eros-v14-dmd' }), false);
});

// The same predicate has to answer for a catalog ENTRY as well as a setup:
// the two carry the same fact under different field names, and the studio asks
// the question while holding whichever one it has.
test('family predicates read a model entry as readily as a setup', () => {
  assert.equal(isLtxFamilyModel({ workflowFamily: 'ltx-2.3' }), true);
  assert.equal(isLtxFamilyModel({ workflowFamily: 'minimax' }), false);
  // A cloud entry's own `family` field is a different namespace and is ignored.
  assert.equal(isLtxFamilyModel({ id: 'ltx-2-pro-image-to-video', family: 'ltx' }), false);
});

test('an explicit non-LTX family wins over a misleading id', () => {
  assert.equal(isLtxFamilyModel({ modelId: 'ltx-ish-name', modelFamily: 'minimax' }), false);
});

test('keyframe slots are LTX-only; other families keep a single start frame', async () => {
  const { videoRequestPlan } = await import('../src/lib/videoTasks.js');
  const ltx = { modelId: 'hivemind-media:ltx23-eros-v14-dmd', modelFamily: 'ltx-2.3' };
  const h3 = { modelId: 'hivemind-media:minimax-h3', modelFamily: 'minimax' };
  assert.equal(videoRequestPlan(ltx).showFrameSlots, true);
  // H3 accepts exactly one image_path — a Middle/End picker would promise
  // inputs the workflow has no slots for.
  assert.equal(videoRequestPlan(h3).showFrameSlots, false);
  // …but it still sends the start image (image-to-video is supported).
  assert.equal(videoRequestPlan(h3).sendImage, true);
});

// Attaching a SOURCE clip is not free: extend and head swap are LTX-graph
// features, so a non-LTX workflow has to be swapped out, and a source clip and
// reference mode never combine. Both used to happen silently — you picked
// MiniMax H3, dropped in a clip, and were quietly on another model with your
// references gone.
test('attaching a source clip reports what it will cost', async () => {
  const { sourceVideoSwitchCost } = await import('../src/lib/videoTasks.js');
  const h3 = { modelId: 'hivemind-media:minimax-h3', modelName: 'MiniMax H3', modelFamily: 'minimax' };
  const ltx = { id: 'hivemind-media:ltx23-eros-fast', name: 'LTX 2.3 Eros Fast' };

  const swap = sourceVideoSwitchCost({ setup: h3, target: ltx });
  assert.equal(swap.switchesModel, true);
  assert.equal(swap.fromModel, 'MiniMax H3');
  assert.equal(swap.toModel, 'LTX 2.3 Eros Fast');
  assert.equal(swap.droppedReferences, 0);

  // Every reference kind counts — a voice clip is as much a loss as a picture.
  const withRefs = sourceVideoSwitchCost({
    setup: { ...h3, referenceImageUrls: ['/a.png', '/b.png'], referenceAudios: [{ url: '/v.m4a' }], referenceVideos: [] },
    target: ltx,
  });
  assert.equal(withRefs.droppedReferences, 3);

  // Staying on the same workflow with nothing attached costs nothing, so there
  // is nothing to ask about.
  assert.equal(sourceVideoSwitchCost({ setup: { ...h3, modelId: ltx.id, modelName: ltx.name }, target: ltx }), null);
  assert.equal(sourceVideoSwitchCost({ setup: h3, target: null }), null);
  // …but losing references is worth asking about even without a model change.
  assert.equal(
    sourceVideoSwitchCost({ setup: { modelId: ltx.id, referenceVideos: [{ url: '/m.mp4' }] }, target: ltx }).droppedReferences,
    1,
  );
});

test('the source-clip slot is not called a "reference"', async () => {
  const { slotLabelsFor } = await import('../src/lib/videoTasks.js');
  // It sat one word away from the References menu beside it, which conditions
  // on motion clips and is an entirely different input.
  assert.doesNotMatch(slotLabelsFor('generate').video, /reference/i);
  assert.match(slotLabelsFor('generate').video, /extend|edit/i);
  assert.match(slotLabelsFor('generate').videoHint, /extend|tools/i);
  // The task-specific labels already said what they do.
  assert.equal(slotLabelsFor('extend').video, 'Video to extend');
  assert.equal(slotLabelsFor('head-swap').video, 'Source video');
});
