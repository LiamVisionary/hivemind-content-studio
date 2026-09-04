// "Something else is still holding this machine's memory" — and the one click
// that gives it back.
//
// This renders NOTHING almost all of the time, on purpose. A lane being up is
// not worth a word (an idle ComfyUI lane holds under a gigabyte), and a lane
// that is mid-job must not be offered up for freeing at all. It appears only
// when a local lane has finished, still holds real memory, and can be freed
// safely — which on this stack is mostly the LTX video lane, the one launched
// --gpu-only so its weights stay in the MPS working set after the clip is done.
//
// Freeing uses ComfyUI's own /free: models drop, the lane stays up and reloads
// on next use. Nothing here quits a service, so the worst case of a click is
// that the next video generation reloads its model.
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';

import { api } from '../hub/hubData.js';
import { formatGB, laneNotice } from '../lib/laneMemory.js';
import { Button } from '../ui/kit.jsx';
import { toastFailure } from '../ui/failureToast.jsx';

const POLL_MS = 20000;

export function LaneMemoryNotice({ active = true }) {
  const [snapshot, setSnapshot] = useState(null);
  const [freeing, setFreeing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api('/api/lanes/memory'));
    } catch {
      // Owner-gated and best-effort: a studio that cannot read lane memory is
      // a studio with one less hint, not a broken one.
      setSnapshot(null);
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    refresh();
    // Skipped while the window is hidden: /api/lanes/memory spawns an `lsof` and
    // a `ps` per lane, asks each one's queue over HTTP and then runs `vm_stat`.
    // That is a lot of process spawning for a panel nobody is looking at — and
    // the answer it produces is about right now, so it is asked on wake instead.
    const beat = () => { if (!document.hidden) refresh(); };
    const timer = setInterval(beat, POLL_MS);
    document.addEventListener('visibilitychange', beat);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', beat);
    };
  }, [active, refresh]);

  const notice = laneNotice(snapshot);
  if (!notice) return null;

  const free = async () => {
    setFreeing(true);
    try {
      const result = await api('/api/lanes/free', {
        method: 'POST',
        body: JSON.stringify({ lane: notice.lane }),
      });
      setSnapshot(result);
      // Report what came back, not what was promised: freeing races with
      // everything else on the machine, so the honest number is the measured one.
      toast.success(`Freed ${formatGB(result?.freedBytes)} from the ${notice.label}`);
    } catch (error) {
      toastFailure(error, { operation: 'Freeing the lane' });
      refresh();
    } finally {
      setFreeing(false);
    }
  };

  return (
    <div
      className={`flex flex-col gap-2 rounded-md border px-3 py-2 ${
        notice.tone === 'warn' ? 'border-warn/40 bg-warn/10' : 'border-line1 bg-bg2'
      }`}
    >
      <div className="text-[11px] leading-relaxed text-ink2">{notice.message}</div>
      <div>
        <Button size="sm" variant="neutral" loading={freeing} onClick={free}>
          {freeing ? 'Freeing…' : notice.action}
        </Button>
      </div>
    </div>
  );
}
