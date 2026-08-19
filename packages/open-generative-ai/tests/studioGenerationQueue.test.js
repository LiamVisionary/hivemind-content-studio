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
