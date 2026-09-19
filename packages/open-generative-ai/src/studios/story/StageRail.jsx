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
  // The id is the persisted stage key and stays; the label is what this stage
  // actually does, which is record a sign-off.
  { id: 'ship', label: 'Sign-off' },
]);

// The strip is always wider than a phone — four labelled chips at touch sizing
// measure about 510px — so the stage you are ON has to be brought into view, or
// the answer to "which of the four am I in" is off the right edge for anyone
// past the second one. A callback ref rather than an effect: it runs on the
// chip that IS current, whenever that changes, and on nothing else. Same helper
// shape as the shell's own mobile navigation, which has the same problem.
function scrollCurrentStepIntoView(node) {
  if (!node || typeof node.scrollIntoView !== 'function') return;
  try { node.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch { /* older engines */ }
}

export function StageRail({ stages, stage, onStage, title, promise, locked, onNew, onExample, compact = false }) {
  // Below lg the rail is not drawn at all — it lives in the settings sheet
  // behind a button — which left a phone with no answer to the one question
  // this studio is arranged around: which of the four decisions am I in, and
  // which are done. `compact` is that answer on screen, in the app's own
  // mobile-navigation shape: a strip of chips that scrolls, with the edge fade
  // saying there is more of it.
  if (compact) {
    return (
      <nav
        className="hive-edge-fade flex min-h-11 w-full items-center gap-1.5 overflow-x-auto px-4 py-1.5 touch:min-h-[52px]"
        aria-label="Production stages"
      >
        {stages.map((entry, index) => {
          const on = entry.id === stage;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onStage(entry.id)}
              aria-current={on ? 'step' : undefined}
              ref={on ? scrollCurrentStepIntoView : undefined}
              className={cx(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-semibold transition-colors duration-150',
                'touch:h-[38px] touch:px-3 touch:text-[13px]',
                on ? 'border-honey/40 bg-honey-tint text-ink1' : 'border-transparent text-ink2 hover:bg-bg2 hover:text-ink1',
              )}
            >
              <span
                className={cx(
                  'grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-[10px] font-bold',
                  entry.done ? 'bg-ok-tint text-ok' : on ? 'bg-bg0/50 text-ink2' : 'bg-bg2 text-ink3',
                )}
              >
                {entry.done ? <Icon name="check" size={11} /> : index + 1}
              </span>
              {entry.label}
            </button>
          );
        })}
      </nav>
    );
  }
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
              ref={on ? scrollCurrentStepIntoView : undefined}
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
