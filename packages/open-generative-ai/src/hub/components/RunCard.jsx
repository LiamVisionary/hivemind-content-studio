// Run list card — the durable-production summary row shared by the Runs view
// (and reusable anywhere a run needs a compact, selectable presentation).
import { cx } from '../../ui/kit.jsx';
import { runTitle, titleCase } from '../hubData.js';
import { StatusPill } from './StatusPill.jsx';

export function RunCard({ run, selected = false, onOpen }) {
  return (
    <button
      type="button"
      onClick={() => onOpen?.(run.run_id)}
      className={cx(
        'flex w-full flex-col gap-1.5 rounded-lg border bg-bg2 p-3 text-left transition-colors duration-150',
        selected ? 'border-honey/50 bg-honey-tint' : 'border-line1 hover:border-line2 hover:bg-bg3',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <b className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink1">{runTitle(run)}</b>
        <StatusPill status={run.status} />
      </div>
      <small className="truncate text-xs text-ink3">
        {titleCase(run.lane)} · {run.current_step ? `step: ${run.current_step}` : 'complete'}
      </small>
    </button>
  );
}
