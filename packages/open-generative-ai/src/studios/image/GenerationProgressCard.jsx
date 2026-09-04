// The Image studio's live progress card, and the tiny store behind it.
//
// The bar moves on a 300 ms timer and again on every message the local bridge
// sends. Both used to go through the studio's `bump()`, which re-renders the
// whole tree — settings panel, composer and every gallery card with its decrypt
// hook — several times a second for the length of a render.
//
// So the ticking values live here instead: one store per studio engine, one
// subscriber (this card). Everything that changes rarely still arrives as a
// prop, because a prop change means the studio re-rendered anyway.
import { useSyncExternalStore } from 'react';

import { formatElapsed } from '../../lib/genProgress.js';
import { zh } from '../../lib/i18n.js';
import { Card, ProgressBar } from '../../ui/kit.jsx';

const EMPTY = { pct: 0, startedAt: 0, estimateSec: 0, label: '' };

export function createProgressStore() {
  let value = EMPTY;
  const listeners = new Set();
  return {
    get: () => value,
    reset() { value = EMPTY; for (const listener of [...listeners]) listener(); },
    set(patch) {
      value = { ...value, ...patch };
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function GenerationProgressCard({ store, heading, fallbackLabel }) {
  const progress = useSyncExternalStore(store.subscribe, store.get, store.get);
  const pct = Math.max(0, Math.min(1, Number(progress.pct) || 0));
  const eta = Number(progress.estimateSec) > 0 ? formatElapsed(progress.estimateSec * 1000) : null;
  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-ink2">{heading}</span>
        <span className="font-mono text-xs font-semibold text-honey">{Math.round(pct * 100)}%</span>
      </div>
      <ProgressBar value={pct} label={zh() ? '生成进度' : 'Generation progress'} />
      <div className="flex items-center justify-between gap-3 font-mono text-[11px] text-ink3">
        {/* The bridge's status text lives here, not on the Generate button. */}
        <span className="min-w-0 truncate">{progress.label || fallbackLabel}</span>
        <span className="shrink-0">
          {formatElapsed(Date.now() - (progress.startedAt || Date.now()))}{eta ? ` / ~${eta}` : ''}
        </span>
      </div>
    </Card>
  );
}
