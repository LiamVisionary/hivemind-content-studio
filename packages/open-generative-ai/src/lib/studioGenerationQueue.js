// One serial submission queue per mounted studio tab. This catches every
// provider path (local gateway, Electron, rented, cloud) before it fans out;
// backend queues remain the authoritative safety boundary for local workers.
export function createStudioGenerationQueue() {
  let tail = Promise.resolve();
  let pending = 0;

  return {
    enqueue(task) {
      if (typeof task !== 'function') return Promise.reject(new TypeError('generation task must be a function'));
      pending += 1;
      const result = tail.then(() => task());
      // Keep the internal tail fulfilled so one failed generation never drops
      // the requests behind it. Callers still receive the original rejection.
      tail = result.then(
        () => { pending -= 1; },
        () => { pending -= 1; },
      );
      return result;
    },
    get pending() {
      return pending;
    },
  };
}
