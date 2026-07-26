// Hive primitive kit — the only building blocks components should use.
// See DESIGN.md. All plain JSX, no external deps.
import { createContext, useContext, useId, useState } from 'react';
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

// A Button whose label collapses into a hover hint wherever a pointer can hover,
// so a crowded action row reads as icons instead of a wall of words. Touch devices
// keep the label visible — they have no hover to reveal it. The label always
// reaches assistive tech through aria-label, hidden or not.
export function ActionButton({ icon, label, className = '', ...rest }) {
  return (
    <Button icon={icon} aria-label={label} data-hint={label} className={className} {...rest}>
      <span className="hive-hint-label">{label}</span>
    </Button>
  );
}

export function IconButton({ icon, label, size = 'md', active = false, className = '', ...rest }) {
  const dims = size === 'sm' ? 'h-ctl-sm w-[28px]' : size === 'lg' ? 'h-ctl-lg w-[44px]' : 'h-ctl-md w-[36px]';
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cx(
        'grid shrink-0 place-items-center rounded-md transition-colors duration-150',
        dims,
        active ? 'bg-honey-tint text-honey' : 'text-ink2 hover:bg-bg2 hover:text-ink1',
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 14 : 17} />
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
  'w-full rounded-md border border-line1 bg-bg2 px-3 text-[13px] text-ink1 placeholder:text-ink3 transition-colors duration-150 hover:border-line2 focus:border-honey/60 focus:shadow-none disabled:opacity-40';

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

export function Slider({ value, min = 0, max = 100, step = 1, onChange, onCommit, mono = true, format }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <input
        type="range"
        className="hive-range flex-1"
        style={{ '--fill': `${pct}%` }}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={onCommit ? (e) => onCommit(Number(e.target.value)) : undefined}
        onTouchEnd={onCommit ? (e) => onCommit(Number(e.target.value)) : undefined}
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

export function SectionLabel({ children, className = '' }) {
  return (
    <div className={cx('text-[11px] font-semibold uppercase tracking-[0.08em] text-ink3', className)}>
      {children}
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
      className={cx('animate-[hive-spin_0.7s_linear_infinite]', className)}
      aria-label="Loading"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function ProgressBar({ value = null, className = '' }) {
  // value 0..1, or null for indeterminate
  return (
    <div className={cx('h-1 w-full overflow-hidden rounded-full bg-bg3', className)}>
      {value == null ? (
        <div className="h-full w-1/4 rounded-full bg-honey animate-[hive-indeterminate_1.2s_ease-in-out_infinite]" />
      ) : (
        <div
          className="h-full rounded-full bg-honey transition-[width] duration-200"
          style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }}
        />
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

// Workspace-first studio frame: left params panel, main canvas, optional bottom composer.
// On < lg the panel collapses into a toggleable sheet.
export function StudioLayout({ panel, panelTitle = 'Settings', composer, children }) {
  const [panelOpen, setPanelOpen] = useState(false);
  return (
    <div className="relative flex min-h-0 flex-1">
      {panel ? (
        <>
          <aside className="hidden w-[320px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line1 bg-bg1 p-4 lg:flex">
            {panel}
          </aside>
          {/* Mobile: floating toggle + sheet */}
          <div className="absolute bottom-24 left-3 z-30 lg:hidden">
            <Button icon="sliders" size="md" onClick={() => setPanelOpen(true)}>
              {panelTitle}
            </Button>
          </div>
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
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
        {composer ? <div className="shrink-0 border-t border-line1 bg-bg1/80 p-3 backdrop-blur-sm">{composer}</div> : null}
      </div>
    </div>
  );
}
