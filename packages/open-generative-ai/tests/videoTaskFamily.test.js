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
  assert.equal(isLtxFamilyModel({ modelId: 'ltx23-eros-v14-dmd' }), true);
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
