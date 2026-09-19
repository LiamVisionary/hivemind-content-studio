import assert from 'node:assert/strict';
import test from 'node:test';

import { createStudioGenerationQueue } from '../src/lib/studioGenerationQueue.js';

test('one studio tab runs generations FIFO and continues after an error', async () => {
  const queue = createStudioGenerationQueue();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];

  const first = queue.enqueue(async () => {
    calls.push('first');
    await firstGate;
    throw new Error('first failed');
  });
  const second = queue.enqueue(async () => { calls.push('second'); });
  const third = queue.enqueue(async () => { calls.push('third'); });

  await Promise.resolve();
  assert.deepEqual(calls, ['first']);
  assert.equal(queue.pending, 3);
  releaseFirst();
  await assert.rejects(first, /first failed/);
  await Promise.all([second, third]);
  assert.deepEqual(calls, ['first', 'second', 'third']);
  assert.equal(queue.pending, 0);
});

test('different tabs and image/video studios own independent queues', async () => {
  const imageTabOne = createStudioGenerationQueue();
  const imageTabTwo = createStudioGenerationQueue();
  const videoTabOne = createStudioGenerationQueue();
  const started = [];

  await Promise.all([
    imageTabOne.enqueue(async () => { started.push('image-1'); }),
    imageTabTwo.enqueue(async () => { started.push('image-2'); }),
    videoTabOne.enqueue(async () => { started.push('video-1'); }),
  ]);

  assert.deepEqual(new Set(started), new Set(['image-1', 'image-2', 'video-1']));
});

test('a waiting press can be inspected and removed, and a removed one never runs', async () => {
  const queue = createStudioGenerationQueue();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  const changes = [];
  const unsubscribe = queue.subscribe(() => changes.push(queue.list().map((item) => item.label)));

  const first = queue.enqueue(async () => { calls.push('first'); await firstGate; }, { label: 'a dog jumping' });
  queue.enqueue(async () => { calls.push('second'); }, { label: 'a dog landing', detail: 'LTX 2.3 · 16:9 · 5s' });
  const third = queue.enqueue(async () => { calls.push('third'); }, { label: 'a dog running' });

  await Promise.resolve();
  // The running one is not ON the list — the list is what has NOT started, which
  // is exactly the set the composer offers a ✕ for.
  assert.deepEqual(queue.list().map((item) => [item.place, item.label, item.detail]), [
    [1, 'a dog landing', 'LTX 2.3 · 16:9 · 5s'],
    [2, 'a dog running', undefined],
  ]);
  assert.equal(queue.waiting, 2);
  assert.equal(queue.pending, 3);

  const [, waitingThird] = queue.list();
  assert.equal(queue.remove(waitingThird.id), true);
  assert.equal(queue.remove(waitingThird.id), false, 'removing twice is not an error, it is a no-op');
  // Resolved, never rejected: `void generate()` callers must not turn a change
  // of mind into an unhandled rejection.
  assert.deepEqual(await third, { removed: true });

  releaseFirst();
  await first;
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.deepEqual(calls, ['first', 'second'], 'the removed press never ran');
  assert.equal(queue.pending, 0);
  assert.ok(changes.length > 0, 'the list tells its subscribers when it moves');
  unsubscribe();
});

test('clearing drops every waiting press and leaves the running one alone', async () => {
  const queue = createStudioGenerationQueue();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];

  const first = queue.enqueue(async () => { calls.push('first'); await firstGate; });
  const second = queue.enqueue(async () => { calls.push('second'); });
  const third = queue.enqueue(async () => { calls.push('third'); });

  await Promise.resolve();
  assert.equal(queue.clearWaiting(), 2);
  assert.deepEqual(queue.list(), []);
  assert.deepEqual(await Promise.all([second, third]), [{ removed: true }, { removed: true }]);
  assert.equal(queue.pending, 1, 'the render already out is not the queue\'s to stop');

  releaseFirst();
  await first;
  assert.deepEqual(calls, ['first']);
});
