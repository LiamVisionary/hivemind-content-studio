import test from 'node:test';
import assert from 'node:assert/strict';

import {
    activeVideoTask,
    headSwapReadiness,
    slotLabelsFor,
    videoTasksFor,
} from '../src/lib/videoTasks.js';

const local = (extra = {}) => ({ modelId: 'hivemind-media:ltx23-eros-v14-dmd', ...extra });
const cloud = (extra = {}) => ({ modelId: 'seedance-v2.0-t2v', ...extra });

test('an attached video no longer forces the extend interpretation', () => {
    // The original bug: any attached video meant "extend", so head swap could
    // never be expressed and the face image was dropped from the payload.
    assert.equal(activeVideoTask(local({ videoUrl: 'v.mp4', videoTask: 'extend' })), 'extend');
    assert.equal(activeVideoTask(local({ videoUrl: 'v.mp4', videoTask: 'head-swap' })), 'head-swap');
});

test('slot labels follow the task, so one slot never lies about its role', () => {
    assert.equal(slotLabelsFor('head-swap').image, 'New face');
    assert.equal(slotLabelsFor('head-swap').video, 'Source video');
    assert.equal(slotLabelsFor('extend').video, 'Video to extend');
    assert.equal(slotLabelsFor('generate').image, 'Start frame');
});

test('cloud models expose only plain generation', () => {
    assert.deepEqual(videoTasksFor(cloud()), ['generate']);
    assert.deepEqual(videoTasksFor(local()), ['generate', 'extend', 'head-swap']);
});

test('a task the model cannot do falls back instead of sticking', () => {
    // Switching from a local model to a cloud one must not strand the studio in
    // head-swap, which the cloud model has no way to run.
    assert.equal(activeVideoTask(cloud({ videoTask: 'head-swap' })), 'generate');
    assert.equal(activeVideoTask(local({ videoTask: 'head-swap' })), 'head-swap');
    assert.equal(activeVideoTask(local({ videoTask: 'nonsense' })), 'generate');
});

test('head swap reports exactly which input is missing', () => {
    assert.deepEqual(headSwapReadiness(local({ videoTask: 'head-swap' })).missing, ['source video', 'face image']);
    assert.deepEqual(headSwapReadiness(local({ videoTask: 'head-swap', videoUrl: 'v.mp4' })).missing, ['face image']);
    assert.deepEqual(headSwapReadiness(local({ videoTask: 'head-swap', imageUrl: 'f.png' })).missing, ['source video']);

    const ready = headSwapReadiness(local({ videoTask: 'head-swap', videoUrl: 'v.mp4', imageUrl: 'f.png' }));
    assert.equal(ready.ready, true);
    assert.deepEqual(ready.missing, []);
});

test('readiness is inert outside head swap', () => {
    assert.deepEqual(headSwapReadiness(local({ videoTask: 'extend' })), { active: false, ready: false, missing: [] });
});

// --- videoRequestPlan: the one decision every layer now consumes ------------

import { videoRequestPlan } from '../src/lib/videoTasks.js';

test('head swap sends both media and is never an extension', () => {
    const plan = videoRequestPlan(local({ videoTask: 'head-swap', videoUrl: 'v.mp4', imageUrl: 'f.png' }));
    assert.equal(plan.sendVideo, true);
    assert.equal(plan.sendImage, true);
    // The bug in one line: any non-null videoMode made servers treat this as an
    // extend regardless of the task.
    assert.equal(plan.videoMode, null);
});

test('head swap keeps its slots and its face when footage is attached', () => {
    // Both were previously killed by `!videoUrl` rules: the slots disappeared and
    // the uploaded face was nulled out.
    const plan = videoRequestPlan(local({ videoTask: 'head-swap', videoUrl: 'v.mp4' }));
    assert.equal(plan.showFrameSlots, true);
    assert.equal(plan.keepImageOnVideoUpload, true);
});

test('extend sends only the video and declares the mode', () => {
    const plan = videoRequestPlan(local({ videoTask: 'extend', videoUrl: 'v.mp4', imageUrl: 'f.png' }));
    assert.equal(plan.sendVideo, true);
    assert.equal(plan.sendImage, false);
    assert.equal(plan.videoMode, 'extend');
    assert.equal(plan.showFrameSlots, false);
});

test('plain generation still anchors on a start frame, and shows the slots', () => {
    const plan = videoRequestPlan(local({ videoTask: 'generate', imageUrl: 'f.png' }));
    assert.equal(plan.sendImage, true);
    assert.equal(plan.sendVideo, false);
    assert.equal(plan.videoMode, null);
    assert.equal(plan.showFrameSlots, true);
});

test('a dropped-in clip on plain generation still behaves as an extension', () => {
    // Preserves the old behaviour, but as a stated consequence of the task
    // rather than an inference each layer repeats.
    const plan = videoRequestPlan(local({ videoTask: 'generate', videoUrl: 'v.mp4' }));
    assert.equal(plan.videoMode, 'extend');
    assert.equal(plan.showFrameSlots, false);
});

test('cloud models never get local-only slots', () => {
    assert.equal(videoRequestPlan(cloud({ imageUrl: 'f.png' })).showFrameSlots, false);
});
