// The four decisions, and where this production has got to in them.
//
// The studio used to be six cards down one page, which meant the only way to
// know whether the plate had been drawn was to scroll past everything to find
// out. The rail answers that without moving: every stage carries the one fact
// that says whether it is done, written as a fact rather than as a tick — "2
// characters · plate not drawn" is actionable and "incomplete" is not.
import { Icon } from '../../ui/icons.jsx';
import { Button, cx } from '../../ui/kit.jsx';

/** The four stages, in the order the production is decided in. */
export const STORY_STAGES = Object.freeze([
  { id: 'story', label: 'The story' },
  { id: 'cast', label: 'Cast & place' },
  { id: 'motion', label: 'What happens' },
  { id: 'ship', label: 'Ship it' },
]);

export function StageRail({ stages, stage, onStage, title, promise, locked, onNew, onExample }) {
  return (
    <>
      <div className="flex flex-col gap-2 rounded-lg border border-line1 bg-bg2 p-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink3">This production</span>
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink1">
            {title || 'Untitled'}
          </span>
          {locked ? (
            <span className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-ok-tint px-2 text-[10px] font-semibold text-ok">
              locked
            </span>
          ) : null}
        </span>
        <p className="text-[12px] leading-snug text-ink3">
          {promise || 'No promise written yet — the story stage writes it when you lock a direction.'}
        </p>
      </div>

      <nav className="flex flex-col gap-1" aria-label="Production stages">
        {stages.map((entry, index) => {
          const on = entry.id === stage;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onStage(entry.id)}
              aria-current={on ? 'step' : undefined}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors duration-150',
                on ? 'border-honey/40 bg-honey-tint text-ink1' : 'border-transparent text-ink2 hover:bg-bg2 hover:text-ink1',
              )}
            >
              <span
                className={cx(
                  'grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border text-[11px] font-bold',
                  entry.done ? 'border-transparent bg-ok-tint text-ok' : 'border-line1 bg-bg2 text-ink3',
                )}
              >
                {entry.done ? <Icon name="check" size={12} /> : index + 1}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] font-medium">{entry.label}</span>
                <span className="truncate text-[11px] text-ink3">{entry.status}</span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-2 border-t border-line1 pt-3">
        <Button size="sm" icon="sparkles" onClick={onNew}>New production</Button>
        <button
          type="button"
          onClick={onExample}
          className="self-start text-[11px] text-ink3 underline decoration-line2 underline-offset-2 transition-colors hover:text-ink2"
        >
          Load the worked example
        </button>
      </div>
    </>
  );
}
