// Hive primitive kit — the only building blocks components should use.
// See DESIGN.md. All plain JSX, no external deps.
import { createContext, useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiOfflineSentence, pingApiStatus, useApiStatus } from '../app/statusStore.js';
import { inDesktopShell, restartStudio } from '../lib/desktopShell.js';
import { t } from '../lib/i18n.js';
import { sectionOpen, setSectionOpen } from '../lib/prefs.js';
import { Icon } from './icons.jsx';

const FieldIdContext = createContext(undefined);

export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

/* ---------------- Buttons ---------------- */

const BTN_SIZES = {
  sm: 'h-ctl-sm px-2.5 text-xs gap-1.5 rounded-sm',
  md: 'h-ctl-md px-3.5 text-[13px] gap-2 rounded-md',
  lg: 'h-ctl-lg px-5 text-sm gap-2 rounded-md',
};

const BTN_VARIANTS = {
  primary:
    'bg-honey text-on-honey font-semibold hover:bg-honey-bright active:translate-y-px disabled:opacity-40 disabled:hover:bg-honey',
  neutral:
    'bg-bg2 text-ink1 border border-line1 hover:border-line2 hover:bg-bg3 active:translate-y-px disabled:opacity-40',
  ghost:
    'text-ink2 hover:text-ink1 hover:bg-bg2 disabled:opacity-40',
  danger:
    'bg-danger-tint text-danger border border-transparent hover:border-danger/40 active:translate-y-px disabled:opacity-40',
};

export function Button({
  variant = 'neutral',
  size = 'md',
  icon,
  loading = false,
  className = '',
  children,
  type = 'button',
  ...rest
}) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center font-medium transition-all duration-150 ease-swift',
        BTN_SIZES[size],
        BTN_VARIANTS[variant],
        className,
      )}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

const canHover = () => (
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(hover: hover) and (pointer: fine)').matches
);

// The hint renders into <body>, not inside the button. A bubble anchored in the
// button is clipped by any scroll/rounding container above it — a Modal panel is
// overflow-hidden, so the last button in a footer row lost most of its label at
// the panel's edge. Fixed coordinates, measured after mount and clamped to the
// viewport, so the bubble also flips below when there is no room above.
function HintBubble({ anchor, label }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return undefined;
    const place = () => {
      const target = anchor.getBoundingClientRect();
      const bubble = ref.current.getBoundingClientRect();
      const margin = 8;
      const centered = target.left + target.width / 2 - bubble.width / 2;
      const rightmost = Math.max(margin, window.innerWidth - bubble.width - margin);
      const above = target.top - bubble.height - 6;
      const next = {
        left: Math.min(Math.max(centered, margin), rightmost),
        top: above >= margin ? above : target.bottom + 6,
      };
      setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
    };
    place();
    // Fixed coordinates don't follow the anchor on their own: a scroll or resize
    // under an open hint would leave it stranded where the button used to be.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor, label]);

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      // Hidden for the measuring pass only — width has to settle before it can be
      // placed, and an unplaced bubble must not flash in the corner.
      style={{ position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      className="hive-fade-in pointer-events-none z-[200] w-max max-w-[200px] rounded-sm border border-line1 bg-bg3 px-2 py-1 text-center text-[11px] font-medium leading-snug text-ink1 shadow-pop"
    >
      {label}
    </div>,
    document.body,
  );
}

// A Button whose label collapses into a hover hint wherever a pointer can hover,
// so a crowded action row reads as icons instead of a wall of words. Touch devices
// keep the label visible — they have no hover to reveal it. The label always
// reaches assistive tech through aria-label, hidden or not.
export function ActionButton({ icon, label, className = '', ...rest }) {
  const [anchor, setAnchor] = useState(null);
  const reveal = (event) => { if (canHover()) setAnchor(event.currentTarget); };

  return (
    <>
      <Button
        icon={icon}
        aria-label={label}
        data-hint={label}
        className={className}
        {...rest}
        onMouseEnter={(e) => { rest.onMouseEnter?.(e); reveal(e); }}
        onMouseLeave={(e) => { rest.onMouseLeave?.(e); setAnchor(null); }}
        onFocus={(e) => { rest.onFocus?.(e); if (e.currentTarget.matches(':focus-visible')) reveal(e); }}
        onBlur={(e) => { rest.onBlur?.(e); setAnchor(null); }}
      >
        <span className="hive-hint-label">{label}</span>
      </Button>
      {anchor ? <HintBubble anchor={anchor} label={label} /> : null}
    </>
  );
}

// Sizes: xs 24px (dense rows, card corners), sm 28, md 36, lg 44.
const ICON_BTN_DIMS = {
  xs: 'h-6 w-6 rounded-sm',
  sm: 'h-ctl-sm w-[28px] rounded-md',
  md: 'h-ctl-md w-[36px] rounded-md',
  lg: 'h-ctl-lg w-[44px] rounded-md',
};
const ICON_BTN_GLYPH = { xs: 12, sm: 14, md: 17, lg: 18 };

export function IconButton({ icon, label, size = 'md', active = false, className = '', ...rest }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cx(
        'grid shrink-0 place-items-center transition-colors duration-150',
        ICON_BTN_DIMS[size] || ICON_BTN_DIMS.md,
        active ? 'bg-honey-tint text-honey' : 'text-ink2 hover:bg-bg2 hover:text-ink1',
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={ICON_BTN_GLYPH[size] || 17} />
    </button>
  );
}

/* ---------------- Form ---------------- */

export function Field({ label, hint, error, children, className = '', labelRight }) {
  const id = useId();
  return (
    <label htmlFor={id} className={cx('block min-w-0', className)}>
      {label ? (
        <span className="mb-1.5 flex items-center justify-between gap-2 text-xs font-medium text-ink2">
          <span>{label}</span>
          {labelRight}
        </span>
      ) : null}
      <FieldIdContext.Provider value={id}>{children}</FieldIdContext.Provider>
      {error ? (
        <span className="mt-1 block text-xs text-danger">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-ink3">{hint}</span>
      ) : null}
    </label>
  );
}

const INPUT_BASE =
  'w-full rounded-md border border-line1 bg-bg2 px-3 text-[13px] text-ink1 placeholder:text-ink3 transition-colors duration-150 hover:border-line2 focus:border-honey/60 disabled:opacity-40';

export function TextInput({ className = '', ...rest }) {
  const id = useContext(FieldIdContext);
  return <input id={id} className={cx(INPUT_BASE, 'h-ctl-md', className)} {...rest} />;
}

export function TextArea({ className = '', rows = 3, ...rest }) {
  const id = useContext(FieldIdContext);
  return <textarea id={id} rows={rows} className={cx(INPUT_BASE, 'resize-none py-2.5 leading-relaxed', className)} {...rest} />;
}

export function NativeSelect({ className = '', children, ...rest }) {
  const id = useContext(FieldIdContext);
  return (
    <span className={cx('relative block', className)}>
      <select
        id={id}
        className={cx(INPUT_BASE, 'h-ctl-md appearance-none pr-8 [&>option]:bg-bg2 [&>option]:text-ink1')}
        {...rest}
      >
        {children}
      </select>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink3">
        <Icon name="chevronDown" size={14} />
      </span>
    </span>
  );
}

export function Segmented({ options, value, onChange, size = 'md', className = '' }) {
  return (
    <div
      className={cx(
        'inline-flex shrink-0 items-center gap-0.5 rounded-md border border-line1 bg-bg1 p-0.5',
        className,
      )}
      role="group"
    >
      {options.map((opt) => {
        const val = typeof opt === 'string' ? opt : opt.value;
        const label = typeof opt === 'string' ? opt : opt.label;
        const on = val === value;
        return (
          <button
            key={val}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(val)}
            className={cx(
              'rounded-[7px] font-medium transition-colors duration-150',
              size === 'sm' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-xs',
              on ? 'bg-bg3 text-ink1 shadow-card' : 'text-ink2 hover:text-ink1',
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// Card-grid replacement for an aspect-ratio <select>: each option renders a
// proportion-true shape preview plus its "W:H" label. `nameFor` optionally maps
// a ratio to a friendly name shown above the label (kept a prop so the kit
// stays i18n-free). `custom` ({ name, detail? }) appends a free-size tile that
// reports onChange('custom') and reads as selected when value === 'custom'.
function arTileClass(on) {
  return cx(
    'flex flex-col items-center gap-1 rounded-md border px-1 pb-1.5 pt-2 transition-colors duration-150',
    on ? 'border-honey/70 bg-honey/10' : 'border-line1 bg-bg2 hover:border-line2',
  );
}

export function AspectRatioPicker({ options, value, onChange, nameFor, custom = null, disabled = false, className = '' }) {
  const customOn = value === 'custom';
  return (
    <div role="radiogroup" className={cx('grid grid-cols-3 gap-1.5', disabled && 'opacity-40', className)}>
      {options.map((ar) => {
        const on = ar === value;
        const [w, h] = String(ar).split(':').map(Number);
        const valid = w > 0 && h > 0;
        const scale = valid ? 18 / Math.max(w, h) : 18;
        const shapeW = valid ? Math.max(7, Math.round(w * scale)) : 18;
        const shapeH = valid ? Math.max(7, Math.round(h * scale)) : 18;
        const name = nameFor ? nameFor(ar) : null;
        return (
          <button
            key={ar}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(ar)}
            className={arTileClass(on)}
          >
            <span className="flex h-[20px] items-center justify-center">
              <span
                className={cx('rounded-[3px] border', on ? 'border-honey bg-honey/30' : 'border-line2 bg-bg3')}
                style={{ width: shapeW, height: shapeH }}
              />
            </span>
            {name ? (
              <span className={cx('text-[11px] font-medium leading-none', on ? 'text-ink1' : 'text-ink2')}>{name}</span>
            ) : null}
            <span className={cx('font-mono text-[10px] leading-none', on ? 'text-ink2' : 'text-ink3')}>{ar}</span>
          </button>
        );
      })}
      {custom ? (
        <button
          type="button"
          role="radio"
          aria-checked={customOn}
          disabled={disabled}
          onClick={() => onChange('custom')}
          className={arTileClass(customOn)}
        >
          <span className="flex h-[20px] items-center justify-center">
            <span
              className={cx(
                'flex h-4 w-4 items-center justify-center rounded-[3px] border border-dashed text-[10px] leading-none',
                customOn ? 'border-honey text-honey' : 'border-line2 text-ink3',
              )}
            >
              ?
            </span>
          </span>
          <span className={cx('text-[11px] font-medium leading-none', customOn ? 'text-ink1' : 'text-ink2')}>{custom.name}</span>
          <span className={cx('font-mono text-[10px] leading-none', customOn ? 'text-ink2' : 'text-ink3')}>{custom.detail || 'W×H'}</span>
        </button>
      ) : null}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150',
        checked ? 'bg-honey' : 'bg-bg3 border border-line1',
        disabled && 'opacity-40',
      )}
    >
      <span
        className={cx(
          'absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full transition-all duration-150 ease-swift',
          checked ? 'left-[18px] bg-on-honey' : 'left-[3px] bg-ink2',
        )}
      />
    </button>
  );
}

export function Slider({ value, min = 0, max = 100, step = 1, onChange, onCommit, mono = true, format, className = '', ...rest }) {
  const id = useContext(FieldIdContext);
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className={cx('flex min-w-0 flex-1 items-center gap-2.5', className)}>
      <input
        id={id}
        type="range"
        className="hive-range flex-1"
        {...rest}
        style={{ '--fill': `${pct}%` }}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={onCommit ? (e) => onCommit(Number(e.target.value)) : undefined}
        onTouchEnd={onCommit ? (e) => onCommit(Number(e.target.value)) : undefined}
        // Arrow keys never raise a mouse or touch end, so a keyboard user would
        // otherwise never reach a commit — which matters now that callers defer
        // their expensive work (a whole-studio re-render, a save) to it.
        onKeyUp={onCommit ? (e) => onCommit(Number(e.target.value)) : undefined}
      />
      <span className={cx('w-10 shrink-0 text-right text-xs text-ink2', mono && 'font-mono')}>
        {format ? format(value) : value}
      </span>
    </div>
  );
}

/* ---------------- Surfaces & structure ---------------- */

export function Card({ className = '', children, ...rest }) {
  return (
    <div className={cx('rounded-lg border border-line1 bg-bg2 shadow-card', className)} {...rest}>
      {children}
    </div>
  );
}

const SECTION_LABEL_TYPE = 'text-[11px] font-semibold uppercase tracking-[0.08em]';

export function SectionLabel({ children, className = '' }) {
  return (
    <div className={cx(SECTION_LABEL_TYPE, 'text-ink3', className)}>
      {children}
    </div>
  );
}

// Whether a collapsible section was left open. A boolean about panel chrome —
// no prompt or media data — so it rides in the preferences document with the
// other small non-sensitive settings (lib/prefs.js, which migrated the old
// `hive.section.*` keys).
// Force a section open from outside it — a deep link that lands on a page inside
// a collapsed group has to show where you are. Writes the same field the header
// does, so the group then stays open the way your own click would have left it.
// True when it actually changed something (the caller re-mounts on that).
export function openSection(storageKey) {
  return setSectionOpen(storageKey, true);
}

const readSectionOpen = (storageKey, fallback) => sectionOpen(storageKey, fallback);

/**
 * A titled section that hides its body until asked for. Collapsed unless
 * `defaultOpen`, and with a `storageKey` it reopens the way the user left it.
 *
 * `hint` is what is switched on inside — it shows on the closed header so a
 * collapsed section never turns an active control into invisible state.
 */
export function CollapsibleSection({
  title,
  hint = '',
  defaultOpen = false,
  storageKey = '',
  className = '',
  children,
}) {
  const [open, setOpen] = useState(() => readSectionOpen(storageKey, defaultOpen));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    setSectionOpen(storageKey, next);
  };
  return (
    <div className={cx('flex flex-col gap-3', className)}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="-mx-1 flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-ink3 transition-colors hover:text-ink1"
      >
        <Icon
          name="chevronRight"
          size={13}
          className={cx('shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className={SECTION_LABEL_TYPE}>{title}</span>
        {!open && hint ? (
          <span className="min-w-0 truncate text-[11px] font-medium normal-case tracking-normal text-honey">
            {hint}
          </span>
        ) : null}
      </button>
      {open ? children : null}
    </div>
  );
}

export function Divider({ className = '' }) {
  return <div className={cx('h-px w-full bg-line1', className)} />;
}

export function Pill({ tone = 'neutral', dot = false, children, className = '', ...rest }) {
  const tones = {
    neutral: 'bg-bg2 text-ink2 border-line1',
    honey: 'bg-honey-tint text-honey border-transparent',
    ok: 'bg-ok-tint text-ok border-transparent',
    danger: 'bg-danger-tint text-danger border-transparent',
    warn: 'bg-warn/10 text-warn border-transparent',
    info: 'bg-info/10 text-info border-transparent',
  };
  return (
    <span
      className={cx(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold',
        tones[tone],
        className,
      )}
      {...rest}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

// The one shape a failure takes anywhere in the app (DESIGN.md §4).
//
// Three rules live here rather than in twelve call sites: a failure is shown
// ONCE (this callout, never also a toast); it says one sentence a person can
// read, not the provider's words; and it carries the repair beside the sentence
// instead of pointing at a page two clicks away. The technical tail — the raw
// message, the traceback, whatever the upstream said — is kept, because it is
// what makes a bug reportable, but it goes behind a Details disclosure so the
// first thing read is the sentence and not the stack.
//
// `remedy` is the repair, `{ label }` plus whatever the caller's runner needs;
// `onRemedy` receives it. `onRetry`/`onDismiss` are the two ways out DESIGN.md
// requires; omit either and its button is not rendered.
export function FailureCallout({
  title,
  detail = '',
  remedy = null,
  onRemedy = null,
  onRetry = null,
  onDismiss = null,
  retryLabel = t('common.tryAgain'),
  detailsLabel = 'Details',
  dismissLabel = 'Dismiss',
  retryDisabled = false,
  className = '',
}) {
  // A detail identical to the sentence above it is noise, not evidence.
  const tail = String(detail || '').trim();
  const showDetail = Boolean(tail) && tail !== String(title || '').trim();
  return (
    <div
      className={cx('flex items-start justify-between gap-3 rounded-md border border-danger/40 bg-danger-tint px-3.5 py-3', className)}
      role="alert"
    >
      <div className="min-w-0">
        <div className="text-xs font-semibold text-danger">{title}</div>
        {showDetail ? (
          <details className="mt-1.5">
            <summary className="cursor-pointer list-none text-[11px] font-medium text-danger/80 hover:text-danger">
              {detailsLabel}
            </summary>
            <div className="mt-1 max-h-40 overflow-y-auto break-words font-mono text-[11px] leading-relaxed text-danger/90 [overflow-wrap:anywhere]">
              {tail}
            </div>
          </details>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {remedy && onRemedy ? (
          <Button size="sm" variant="primary" onClick={() => onRemedy(remedy)}>{remedy.label}</Button>
        ) : null}
        {onRetry ? (
          <Button size="sm" variant="neutral" icon="refresh" disabled={retryDisabled} onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : null}
        {onDismiss ? <IconButton icon="x" label={dismissLabel} size="sm" onClick={onDismiss} /> : null}
      </div>
    </div>
  );
}

export function EmptyState({ icon = 'sparkles', title, hint, action, className = '' }) {
  return (
    <div className={cx('flex flex-col items-center justify-center gap-3 px-6 py-14 text-center', className)}>
      <div className="grid h-12 w-12 place-items-center rounded-lg border border-line1 bg-bg2 text-ink3">
        <Icon name={icon} size={22} />
      </div>
      <div className="max-w-sm">
        <div className="text-sm font-semibold text-ink1">{title}</div>
        {hint ? <div className="mt-1 text-[13px] leading-relaxed text-ink3">{hint}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function Spinner({ size = 16, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cx('hive-motion-keep animate-[hive-spin_0.7s_linear_infinite]', className)}
      role="status"
      aria-label="Loading"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function ProgressBar({ value = null, className = '', tone = 'honey', label }) {
  // value 0..1, or null for indeterminate. tone 'danger' marks a failed transfer.
  const fill = tone === 'danger' ? 'bg-danger' : tone === 'ok' ? 'bg-ok' : 'bg-honey';
  const pct = value == null ? null : Math.max(0, Math.min(100, value * 100));
  return (
    <div
      className={cx('h-1 w-full overflow-hidden rounded-full bg-bg3', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct == null ? undefined : Math.round(pct)}
    >
      {pct == null ? (
        <div className={cx('hive-motion-keep h-full w-1/4 rounded-full animate-[hive-indeterminate_1.2s_ease-in-out_infinite]', fill)} />
      ) : (
        <div className={cx('h-full rounded-full transition-[width] duration-200', fill)} style={{ width: `${pct}%` }} />
      )}
    </div>
  );
}

export function Kbd({ children }) {
  return (
    <kbd className="rounded-sm border border-line1 bg-bg2 px-1.5 py-0.5 font-mono text-[10px] text-ink2">
      {children}
    </kbd>
  );
}

/* ---------------- Tabs ---------------- */

export function Tabs({ tabs, value, onChange, className = '' }) {
  return (
    <div className={cx('flex items-center gap-1 border-b border-line1', className)} role="tablist">
      {tabs.map((tab) => {
        const val = typeof tab === 'string' ? tab : tab.value;
        const label = typeof tab === 'string' ? tab : tab.label;
        const on = val === value;
        return (
          <button
            key={val}
            role="tab"
            aria-selected={on}
            type="button"
            onClick={() => onChange(val)}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors duration-150',
              on ? 'border-honey text-ink1' : 'border-transparent text-ink2 hover:text-ink1',
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- Studio layout ---------------- */

// The composer bar, and — when the studio says what a dropped file should mean
// there — a drop target of its own.
//
// Everywhere else in the app, dragging in a picture or a clip restores the
// settings that made it (app/OutputRestoreDropZone.jsx). Over the box you write
// the shot in, that is the wrong reading: what you dropped is an INPUT. The
// window-level restore zone stands down for anything inside
// [data-studio-composer], and this is what wears that mark — the whole bar
// rather than the inner card, so the margins beside a centred composer are not
// quietly a different feature.
//
// The kit stays dependency-free: the studio supplies what it accepts, what to
// say, and what to do with it.
//   drop = { accepts(dataTransfer, target), hint(dataTransfer) | string,
//            onDrop(dataTransfer), busy }
function ComposerSlot({ drop, children }) {
  const [over, setOver] = useState(false);
  const [hint, setHint] = useState('');
  // dragenter/dragleave fire for every child element, so a plain boolean
  // flickers as the pointer crosses the buttons. Count enters instead.
  const depthRef = useRef(0);
  const active = typeof drop?.onDrop === 'function';
  const accepts = (event) => active
    && (typeof drop.accepts !== 'function' || drop.accepts(event.dataTransfer, event.target));
  const hintFor = (dataTransfer) => (typeof drop?.hint === 'function' ? drop.hint(dataTransfer) : (drop?.hint || ''));
  const busy = Boolean(drop?.busy);
  const showing = over || busy;

  const handlers = active
    ? {
      onDragEnter: (event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        depthRef.current += 1;
        setHint(hintFor(event.dataTransfer));
        setOver(true);
      },
      onDragOver: (event) => {
        if (!accepts(event)) return;
        event.preventDefault(); // required to allow a drop
        try { event.dataTransfer.dropEffect = 'copy'; } catch { /* non-critical */ }
      },
      onDragLeave: () => {
        depthRef.current = Math.max(0, depthRef.current - 1);
        if (!depthRef.current) setOver(false);
      },
      onDrop: (event) => {
        depthRef.current = 0;
        setOver(false);
        if (!accepts(event)) return;
        event.preventDefault();
        // Keeps the drop off the window-level restore zone even before its own
        // [data-studio-composer] guard gets a look at it.
        event.stopPropagation();
        drop.onDrop(event.dataTransfer);
      },
    }
    : {};

  return (
    <div
      {...(active ? { 'data-studio-composer': '' } : {})}
      {...handlers}
      className={cx(
        'relative shrink-0 border-t bg-bg1/80 p-3 backdrop-blur-sm transition-colors',
        showing ? 'border-honey' : 'border-line1',
      )}
    >
      {children}
      {showing ? (
        <div
          className="pointer-events-none absolute inset-0 z-30 grid place-items-center border-2 border-dashed border-honey bg-bg0/90"
          role={busy ? 'status' : undefined}
          aria-live={busy ? 'polite' : undefined}
        >
          <span className="flex items-center gap-2 text-sm font-medium text-honey">
            {busy ? <Spinner size={14} className="text-honey" /> : null}
            {busy ? 'Attaching…' : hint}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// THE remedy for a studio that is not answering, in the two shapes it can take.
//
// This replaced a `<code>` holding `scripts/hivemind-studio-stack restart` on
// three surfaces — the studio banner, the status menu and the Settings
// restart-required strip. That command is a repo-relative path: correct for the
// person who started the stack from a checkout, useless to anyone who installed
// the .dmg, which is most of the people who will ever see it. The desktop shell
// supervises those services and can restart them from a button; a browser tab
// cannot, and says so rather than printing a command it cannot run either.
//
// A successful restart reloads the page, because the control API the page is
// served BY has just been replaced.
export function StudioRestartAction({ className = '' }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inShell = inDesktopShell();
  const press = async () => {
    setBusy(true);
    setFailed(false);
    const result = await restartStudio();
    if (result.ok) {
      try { window.location.reload(); return; } catch { /* no window (tests) */ }
    }
    setBusy(false);
    setFailed(true);
  };
  if (!inShell) {
    return <span className={cx('min-w-0 text-xs leading-relaxed text-ink2', className)}>{t('app.restartOutsideShell')}</span>;
  }
  return (
    <span className={cx('inline-flex flex-wrap items-center gap-2', className)}>
      <Button size="sm" icon="refresh" loading={busy} onClick={press}>{t('app.restartStudio')}</Button>
      {failed ? <span className="text-xs text-danger">{t('app.restartFailed')}</span> : null}
    </span>
  );
}

// The studio is not answering — said once, at the top of whatever studio the
// user is standing in, with the same Retry the topbar pill offers. A press that
// cannot possibly work is greyed out by each studio; this line is why.
function StudioOfflineBanner() {
  const status = useApiStatus();
  const [busy, setBusy] = useState(false);
  if (status.tone !== 'offline') return null;
  const retry = () => {
    setBusy(true);
    void pingApiStatus().finally(() => setBusy(false));
  };
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warn/40 bg-warn/10 px-3.5 py-2 text-xs text-ink1"
    >
      <span className="font-semibold">{t('app.notRunning')}</span>
      <span className="min-w-0 text-ink2">{apiOfflineSentence()}</span>
      <StudioRestartAction />
      <Button size="sm" icon="refresh" loading={busy} onClick={retry} className="ml-auto">
        {t('common.tryAgain')}
      </Button>
    </div>
  );
}

// Workspace-first studio frame: left params panel, main canvas, optional bottom composer.
// On < lg the panel collapses into a toggleable sheet.
export function StudioLayout({
  panel, panelTitle = 'Settings', composer, composerDrop, children,
  // A settings panel is 320px; a stage rail is narrower, because its rows are
  // one line of status each rather than sliders and pickers.
  panelWidth = 'w-[320px]',
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  return (
    <div className="relative flex min-h-0 flex-1">
      {panel ? (
        <>
          <aside className={cx('hidden shrink-0 flex-col gap-4 overflow-y-auto border-r border-line1 bg-bg1 p-4 lg:flex', panelWidth)}>
            {panel}
          </aside>
          {panelOpen ? (
            <div className="fixed inset-0 z-40 flex lg:hidden" role="dialog" aria-modal="true">
              <div className="absolute inset-0 bg-scrim" onClick={() => setPanelOpen(false)} />
              <div className="hive-scale-in relative m-3 mt-16 flex max-h-[80vh] w-[min(360px,92vw)] flex-col gap-4 overflow-y-auto rounded-xl border border-line1 bg-bg1 p-4 shadow-overlay">
                <div className="flex items-center justify-between">
                  <SectionLabel>{panelTitle}</SectionLabel>
                  <IconButton icon="x" label="Close" size="sm" onClick={() => setPanelOpen(false)} />
                </div>
                {panel}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <StudioOfflineBanner />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
        {/* Below lg the panel lives in a sheet; its opener sits in its own row so it
            can never cover the composer (a floating button used to sit on the chips). */}
        {panel ? (
          <div className="flex shrink-0 items-center border-t border-line1 bg-bg1 px-3 py-1.5 lg:hidden">
            <Button icon="sliders" size="sm" onClick={() => setPanelOpen(true)} aria-haspopup="dialog" aria-expanded={panelOpen}>
              {panelTitle}
            </Button>
          </div>
        ) : null}
        {composer ? <ComposerSlot drop={composerDrop}>{composer}</ComposerSlot> : null}
      </div>
    </div>
  );
}
