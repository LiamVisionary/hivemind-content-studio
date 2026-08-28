// The pieces every Story stage is built out of.
//
// They live here rather than inside the studio for one hard reason: a component
// declared inside a render is a NEW type on every render, so React unmounts and
// remounts the input underneath it and the field loses focus on every keystroke.
// This studio is forty text fields deep, so that failure is not subtle.
//
// The second reason is the shape of the redesign. Nearly every stage is the same
// four things — a heading, a draft button that reports what the producer is
// doing, rows of writable fields, and a disclosure holding the fields you only
// open when you disagree with what was written. Saying that once is what keeps
// the four stages looking like one studio.
import { Icon } from '../../ui/icons.jsx';
import { Button, ProgressBar, Spinner, TextArea, TextInput, cx } from '../../ui/kit.jsx';
import { useMediaSrc } from '../../hooks/hooks.js';
import { producerIsRunning } from './state.js';

/** A drawn reference. The caller owns the shape — the same box holds the empty
 *  slot before it is drawn, so the row must not move when it arrives. */
export function Plate({ url, alt, className = '' }) {
  const src = useMediaSrc(url);
  if (!src) return null;
  return <img src={src} alt={alt} className={cx('border border-line1', className)} />;
}

/** The title and the sentence that says what the stage is FOR. */
export function StageHead({ title, children }) {
  return (
    <div>
      <h2 className="m-0 text-[20px] font-semibold tracking-[-0.01em] text-ink1">{title}</h2>
      <p className="m-0 mt-1.5 max-w-[56ch] text-[13px] leading-relaxed text-ink2">{children}</p>
    </div>
  );
}

/**
 * A rule with a label on it: "8 directions ———— ranked by silhouette".
 *
 * The stages are long, and a heading that is only bold text disappears between
 * two cards. `children` sits on the right of the rule, where the actions that
 * belong to the section below it go.
 */
export function Rule({ label, hint, children }) {
  return (
    <div className="flex items-center gap-3">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink3">{label}</span>
      <span className="h-px min-w-4 flex-1 bg-line1" />
      {hint ? <span className="shrink-0 text-[11px] text-ink3">{hint}</span> : null}
      {children}
    </div>
  );
}

/**
 * The fields you open when you disagree with what the producer wrote.
 *
 * A native <details> rather than state: the stages hold a dozen of these, and a
 * dozen `useState`s that all reset when a parent re-renders is how an open panel
 * closes itself while you are typing in it.
 */
export function Disclosure({ label, hint, children, className = '', tone = 'quiet' }) {
  return (
    <details className={cx('group', tone === 'card' && 'rounded-lg border border-line1 bg-bg1', className)}>
      <summary
        className={cx(
          'flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-semibold text-ink2 transition-colors hover:text-ink1',
          '[&::-webkit-details-marker]:hidden',
          tone === 'card' ? 'px-3 py-2.5' : 'py-1',
        )}
      >
        <Icon name="chevronRight" size={13} className="shrink-0 transition-transform duration-150 group-open:rotate-90" />
        {label}
        {hint ? <span className="min-w-0 truncate font-normal text-ink3">{hint}</span> : null}
      </summary>
      <div className={cx('flex flex-col gap-2.5', tone === 'card' ? 'border-t border-line1 p-3' : 'pb-1 pt-2.5')}>
        {children}
      </div>
    </details>
  );
}

/** A grid of labelled fields, the shape every disclosure in the studio uses. */
export function FieldGrid({ columns = 2, className = '', children }) {
  return (
    <div className={cx('grid gap-2.5', columns === 2 ? 'sm:grid-cols-2' : columns === 3 ? 'sm:grid-cols-3' : '', className)}>
      {children}
    </div>
  );
}

/**
 * One labelled field with the wand that writes it from the rest of the story.
 *
 * The wand is an icon and never a labelled button: there is one on nearly every
 * field in the studio, and forty "Auto-fill"s would drown the writing they sit
 * beside.
 */
const COMPACT_INPUT = '!h-8 !rounded-lg !bg-bg1 !px-2.5 !text-[12px]';
const COMPACT_AREA = '!rounded-lg !bg-bg1 !px-2.5 !py-2 !text-[12px] !leading-snug';

export function WriteField({
  id, spec, busy, onFill, label, hint, multiline = false, rows = 2,
  className = '', inputClassName = '', compact = true, children, ...rest
}) {
  const running = producerIsRunning(busy, `fill:${id}`);
  const title = label || spec?.label || id;
  const guidance = hint === undefined ? spec?.hint : hint;
  const shape = compact ? (multiline ? COMPACT_AREA : COMPACT_INPUT) : '';
  return (
    <label className={cx('flex min-w-0 flex-col gap-1', className)}>
      <span className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink3">{title}</span>
        {onFill ? (
          <button
            type="button"
            title={`Write ${title.toLowerCase()} from the rest of the story`}
            aria-label={`Write ${title.toLowerCase()} from the rest of the story`}
            onClick={() => onFill([id])}
            disabled={Boolean(busy)}
            className={cx(
              'grid h-5 w-5 shrink-0 place-items-center rounded-sm text-ink3 transition-colors hover:bg-bg3 hover:text-ink1 disabled:opacity-40',
              running && 'animate-spin text-honey',
            )}
          >
            <Icon name={running ? 'refresh' : 'wand'} size={12} />
          </button>
        ) : null}
      </span>
      {children || (multiline
        ? <TextArea rows={rows} className={cx(shape, inputClassName)} {...rest} />
        : <TextInput className={cx(shape, inputClassName)} {...rest} />)}
      {guidance ? <span className="text-[10.5px] leading-snug text-ink3/80">{guidance}</span> : null}
    </label>
  );
}

/**
 * The one button that makes a stage happen, with what the producer is doing
 * beside it.
 *
 * The status line is not decoration. Loading a 30B model off a cold cache is
 * minutes, and "Loading Qwen3 30B…" is the only thing that distinguishes that
 * from a hung request — which is what a bare spinner looks like after ninety
 * seconds.
 */
export function DraftButton({ label, running, blocked, hint, status, onPress, onCancel, children }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <Button
        variant="primary"
        onClick={onPress}
        // Running counts as blocked: a second press would abort the first ask
        // mid-flight, which reads as the button having done nothing.
        disabled={blocked || running}
        className={cx(running && '!bg-honey-tint !text-honey !opacity-100')}
      >
        {running ? <Spinner size={15} /> : <Icon name="wand" size={15} />}
        {running ? 'Drafting…' : label}
      </Button>
      {running ? <Button size="sm" onClick={onCancel}>Cancel</Button> : null}
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink3">{running ? (status || 'Working…') : hint}</span>
      {children}
      {running ? <ProgressBar label={status || 'The producer is writing'} /> : null}
    </div>
  );
}

/** A list of objections, shown as objections — every one is something the
 *  director may have chosen on purpose. */
export function Notes({ items, tone = 'warn' }) {
  if (!items?.length) return null;
  return (
    <ul className={cx('flex flex-col gap-1 text-[11px] leading-snug', tone === 'warn' ? 'text-warn' : 'text-ink3')}>
      {items.map((item) => <li key={item}>• {item}</li>)}
    </ul>
  );
}

/** The hatched square a reference occupies before it is drawn, so the row does
 *  not jump when it arrives. `box` carries width, ratio and rounding, and is
 *  applied to both states for exactly that reason. */
export function PlateSlot({
  url, alt, lines = [], box = 'w-full aspect-[3/4] rounded-md', fit = 'object-cover', className = '',
}) {
  const shape = cx(box, className);
  if (url) return <Plate url={url} alt={alt} className={cx(shape, fit)} />;
  return (
    <span
      style={{ backgroundImage: 'repeating-linear-gradient(135deg, var(--bg-3) 0 6px, var(--bg-2) 6px 12px)' }}
      className={cx(
        'grid place-items-center border border-dashed border-line2 px-1 text-center',
        'font-mono text-[9px] leading-[1.4] text-ink3',
        shape,
      )}
    >
      <span>{lines.map((line) => <span key={line} className="block">{line}</span>)}</span>
    </span>
  );
}
