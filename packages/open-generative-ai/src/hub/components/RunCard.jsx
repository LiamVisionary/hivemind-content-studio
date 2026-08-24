// Run list card — the durable-production summary row shared by the Runs view
// (and reusable anywhere a run needs a compact, selectable presentation).
// Title is the brief's title or the lane's name; the opaque run id is the mono
// subline, never the headline.
import { memo } from 'react';
import { cx } from '../../ui/kit.jsx';
import { humanize, runDisplayTitle } from '../hubData.js';
import { StatusPill } from './StatusPill.jsx';

export const RunCard = memo(function RunCard({ run, selected = false, onOpen }) {
  return (
    <button
      type="button"
      onClick={() => onOpen?.(run.run_id)}
      aria-pressed={selected}
      className={cx(
        'flex w-full flex-col gap-1.5 rounded-lg border bg-bg2 p-3 text-left transition-colors duration-150',
        selected ? 'border-honey/50 bg-honey-tint' : 'border-line1 hover:border-line2 hover:bg-bg3',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <b className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink1">{runDisplayTitle(run)}</b>
        <StatusPill status={run.status} />
      </div>
      <small className="truncate font-mono text-[11px] text-ink3" title={run.run_id}>{run.run_id}</small>
      <small className="truncate text-xs text-ink3">
        {run.current_step ? `Step: ${humanize(run.current_step)}` : 'Complete'}
      </small>
    </button>
  );
});
