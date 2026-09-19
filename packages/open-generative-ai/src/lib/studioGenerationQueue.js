// One serial submission queue per mounted studio tab. This catches every
// provider path (local gateway, Electron, rented, cloud) before it fans out;
// backend queues remain the authoritative safety boundary for local workers.
//
// It is also the studio's WAITING LIST. A press made while a render is out is
// queued rather than refused, so the entries have to be inspectable (what is
// waiting, in what order) and removable (a press you changed your mind about) —
// a queue you can only add to is a trap, not a feature.

/** Resolved, not rejected, when an entry is dropped before it ran: the press
 *  simply never happened, and the callers that do `void generate()` must not
 *  turn a change of mind into an unhandled rejection. */
const REMOVED = Object.freeze({ removed: true });

export function createStudioGenerationQueue() {
  /** Presses that have not started yet, oldest first. */
  let queued = [];
  /** The one press executing right now, or null. */
  let running = null;
  let seq = 0;
  const listeners = new Set();

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* a bad listener never stalls the queue */ }
    }
  };

  const start = () => {
    if (running || !queued.length) return;
    const entry = queued.shift();
    running = entry;
    notify();
    let result;
    try { result = Promise.resolve(entry.task()); }
    catch (err) { result = Promise.reject(err); }
    result.then(entry.resolve, entry.reject);
    // Settled either way, so one failed generation never drops the presses
    // behind it. Callers still receive the original rejection above.
    result.then(() => {}, () => {}).then(() => {
      running = null;
      notify();
      start();
    });
  };

  return {
    /**
     * @param {function} task  the generation to run when its turn comes
     * @param {object}   meta  what to SHOW while it waits — { label, detail }
     * @returns {Promise} settles with the task; resolves REMOVED if the entry
     *                    is dropped before it ever runs.
     */
    enqueue(task, meta = {}) {
      if (typeof task !== 'function') return Promise.reject(new TypeError('generation task must be a function'));
      seq += 1;
      const entry = { id: `gen-${seq}`, task, meta: { ...meta }, resolve: null, reject: null };
      const promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      queued.push(entry);
      notify();
      // Deferred by a microtask, the way the old tail-chained queue started: the
      // press that enqueued returns before the task's own validation toasts fire.
      Promise.resolve().then(start);
      return promise;
    },
    /** Running + waiting: what "is this tab busy?" means. */
    get pending() { return (running ? 1 : 0) + queued.length; },
    /** Just the ones that have not started — what the composer counts. */
    get waiting() { return queued.length; },
    /** The waiting list, oldest first, for the UI that has to show it. */
    list() {
      return queued.map((entry, index) => ({ id: entry.id, place: index + 1, ...entry.meta }));
    },
    /** Drop a press that has not started. The running one is not the queue's to
     *  stop — that is the studio's own Cancel, which interrupts a real job. */
    remove(id) {
      const index = queued.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      const [entry] = queued.splice(index, 1);
      entry.resolve(REMOVED);
      notify();
      return true;
    },
    /** Drop every press that has not started; the running one is untouched. */
    clearWaiting() {
      const dropped = queued;
      queued = [];
      for (const entry of dropped) entry.resolve(REMOVED);
      if (dropped.length) notify();
      return dropped.length;
    },
    /** Re-render on every change of the list. Returns an unsubscribe. */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
