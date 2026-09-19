// Deliberately textual: that a persisted pointer stays an opaque same-origin
// path is a privacy claim about what is written down, not about what is drawn.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { videoRequestPlan } from '../src/lib/videoTasks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const h3 = (extra = {}) => ({
    modelId: 'hivemind-media:minimax-h3',
    modelFamily: 'minimax',
    ...extra,
});
const ltx = (extra = {}) => ({
    modelId: 'hivemind-media:ltx23-eros-v14-dmd',
    modelFamily: 'ltx-2.3',
    ...extra,
});

test('an armed chain sends motion context and replaces the start frame', () => {
    const plan = videoRequestPlan(h3({ motionContextUrl: '/api/media-studio/gateway/clip-1.mp4', imageUrl: 'frame.png' }));
    assert.equal(plan.sendMotionContext, true);
    // A frame-0 pin and a chain head both claim the opening frames; the model
    // renders contradictions as unions, so the plan drops the image.
    assert.equal(plan.sendImage, false);
    assert.equal(plan.task, 'generate');
});

test('chaining is a minimax-family capability, inert everywhere else', () => {
    // LTX continuation is the extend task; the armed pointer must not leak.
    assert.equal(videoRequestPlan(ltx({ motionContextUrl: '/x.mp4' })).sendMotionContext, false);
    // Cloud models have no chain lane at all.
    assert.equal(videoRequestPlan({ modelId: 'seedance-v2.0-t2v', motionContextUrl: '/x.mp4' }).sendMotionContext, false);
    // A stale armed pointer with a source video attached stays a video job.
    const withVideo = videoRequestPlan(h3({ motionContextUrl: '/x.mp4', videoUrl: 'v.mp4' }));
    assert.equal(withVideo.sendMotionContext, false);
    assert.equal(withVideo.sendVideo, true);
});

test('an unarmed H3 setup keeps its plain start-frame behavior', () => {
    const plan = videoRequestPlan(h3({ imageUrl: 'frame.png' }));
    assert.equal(plan.sendMotionContext, false);
    assert.equal(plan.sendImage, true);
    assert.equal(plan.showFrameSlots, false);
});

test('extend and head swap never send motion context', () => {
    assert.equal(videoRequestPlan(ltx({ videoTask: 'extend', videoUrl: 'v.mp4', motionContextUrl: '/x.mp4' })).sendMotionContext, false);
    assert.equal(videoRequestPlan(ltx({ videoTask: 'head-swap', videoUrl: 'v.mp4', imageUrl: 'f.png', motionContextUrl: '/x.mp4' })).sendMotionContext, false);
});

test('the persisted chain pointer stays an opaque same-origin path', async () => {
    // Only a bounded same-origin path survives — the pointer must never become a
    // foreign-URL exfiltration channel. Now a real round-trip: the normalizer
    // moved out of the .jsx file the node suite could not load.
    const { normalizeVideoPreferences } = await import('../src/lib/videoPreferences.js');
    const pointer = (motionContextUrl) => normalizeVideoPreferences({
        modelId: 'hivemind-media:minimax-h3', motionContextUrl,
    }).motionContextUrl;
    assert.equal(pointer('/api/media-studio/runs/opaque.mp4'), '/api/media-studio/runs/opaque.mp4');
    assert.equal(pointer('https://exfil.test/clip.mp4'), '', 'a foreign origin is dropped');
    assert.equal(pointer('//exfil.test/clip.mp4'), '', 'a protocol-relative host is not same-origin');
    assert.equal(pointer(`/${'x'.repeat(600)}`), '', 'bounded length');

    const videoLogic = fs.readFileSync(path.join(__dirname, '../src/studios/video/videoLogic.js'), 'utf8');
    // applyRestoredPreferences: an in-progress chain survives reload.
    assert.match(videoLogic, /s\.motionContextUrl = preferences\.motionContextUrl/);
    // applyGenerationContext restores BOTH the family (which gates the chain
    // plan) and the armed pointer when a sealed setup is dragged back in. The
    // family now comes from the one selected-model writer.
    assert.match(videoLogic, /modelFamily: String\(model\.workflowFamily \|\| ''\)/);
    assert.match(videoLogic, /withSelectedModel\(s0, model\)/);
    assert.match(videoLogic, /motionContextUrl: context\.motionContextUrl \|\| null/);
});
