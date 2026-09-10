// The stage — the one thing you made, as large as the window allows.
//
// It holds its aspect ratio rather than filling the box, because a picture
// letterboxed into a 16:9 hole is a worse look at the picture. The frame is the
// only rounded surface behind the composer, so the composer's blur has
// something to sit on.
import { Icon } from '../../ui/icons.jsx';
import { cx } from '../../ui/kit.jsx';

/**
 * @param {string} aspect  CSS aspect-ratio for the frame, e.g. '9 / 16'
 * @param {bool}   busy    draw the honey hairline that marks a run in flight
 * @param {node}   overlay chrome drawn over the media (player bar, progress)
 */
export function Stage({ aspect = '1 / 1', busy = false, overlay = null, children, className = '' }) {
  return (
    <div
      className={cx(
        'relative grid max-h-full max-w-full place-items-center overflow-hidden rounded-[12px] bg-bg2',
        busy && 'shadow-[0_0_0_1px_rgba(246,178,27,0.3)]',
        className,
      )}
      style={{ aspectRatio: aspect, height: '100%' }}
    >
      {children}
      {overlay}
    </div>
  );
}

/** A round door floating at the stage's top-right: download, expand, more. */
export function StageAction({ icon, label, onClick, disabled = false, active = false, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      {...rest}
      className={cx(
        'grid h-8 w-8 place-items-center rounded-full backdrop-blur transition-colors',
        active ? 'bg-honey text-on-honey' : 'bg-bg0/[0.72] text-ink1 hover:bg-bg0',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-bg0/[0.72]',
      )}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}

/**
 * The mid-render readout, drawn along the bottom of the stage.
 *
 * Everything the old progress card said, in the place you are already looking:
 * the phase and step, the percentage, what is being made, and how long is left.
 * Cancel is here too — it was the card's only button.
 */
export function StageProgress({
  phase = '',
  percent = null,
  subject = '',
  timing = '',
  onCancel,
  cancelLabel = 'Cancel render',
  note = '',
}) {
  const pct = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  return (
    <div
      className="absolute inset-x-0 bottom-0 flex flex-col gap-[9px] bg-gradient-to-t from-bg0/90 to-transparent px-[18px] pb-4 pt-8"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-baseline justify-between gap-3 font-mono text-[11px] text-honey">
        <span className="truncate">{phase}</span>
        {pct === null ? null : <span className="shrink-0">{`${Math.round(pct)}%`}</span>}
      </div>
      <span className="relative block h-0.5 overflow-hidden rounded-full bg-white/[0.14]">
        <span
          className={cx('absolute inset-y-0 left-0 rounded-full bg-honey', pct === null && 'w-1/3 animate-pulse')}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </span>
      <div className="flex items-baseline justify-between gap-3 font-mono text-[10.5px] text-inkSoft">
        <span className="truncate">{subject}</span>
        <span className="shrink-0">{timing}</span>
      </div>
      {note || onCancel ? (
        <div className="flex items-center justify-between gap-3 pt-0.5">
          <span className="min-w-0 truncate text-[11px] text-ink3">{note}</span>
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="shrink-0 rounded-full border border-danger/40 px-3 py-1 text-[11px] font-medium text-danger transition-colors hover:bg-danger/10"
            >
              {cancelLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The player bar under a clip: time, scrubber, what it is. */
export function StagePlayerBar({ time = '', progress = 0, meta = '', onSeek }) {
  const pct = Math.max(0, Math.min(100, progress));
  return (
    <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-bg0/85 to-transparent px-4 pb-3.5 pt-8">
      <span className="shrink-0 font-mono text-[10.5px] text-inkSoft">{time}</span>
      <button
        type="button"
        aria-label="Seek"
        onClick={onSeek}
        className="relative block h-0.5 flex-1 rounded-full bg-white/[0.18]"
      >
        <span className="absolute inset-y-0 left-0 rounded-full bg-ink1" style={{ width: `${pct}%` }} />
      </button>
      <span className="shrink-0 truncate font-mono text-[10.5px] text-inkSoft">{meta}</span>
    </div>
  );
}

/** Nothing made yet. The stage is not empty-stated into a card — it says one line. */
export function StageEmpty({ icon = 'image', title, hint, action = null }) {
  return (
    <div className="flex max-w-[420px] flex-col items-center gap-3 px-6 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-white/[0.04] text-ink3">
        <Icon name={icon} size={22} />
      </span>
      <span className="text-[15px] font-medium text-ink1">{title}</span>
      {hint ? <span className="text-[12.5px] leading-relaxed text-inkSoft">{hint}</span> : null}
      {action}
    </div>
  );
}
