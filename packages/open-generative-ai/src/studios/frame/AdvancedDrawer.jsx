// Advanced — every control the recipe line does not carry.
//
// The old settings panel was always on screen, so it had to be quiet; this is
// opened deliberately, so it can be dense. Same controls, same order of
// importance, one press away instead of permanently taking 320px off the stage.
//
// The drawer's chrome (the panel, its header, its scroll) belongs to
// StudioFrame. What is here is the vocabulary INSIDE it: a run-on card at the
// top, then labelled sections of rows.
import { Icon } from '../../ui/icons.jsx';
import { cx } from '../../ui/kit.jsx';

/** The drawer's scrolling body. Sections stack inside it. */
export function DrawerBody({ children }) {
  return <div className="flex flex-col pb-5">{children}</div>;
}

/**
 * A labelled group of rows: OUTPUT, LOOK, CONTROL, SAMPLING, SHOT, CAST…
 * `hint` prints on the right of the label — the one-line summary of what the
 * section is currently set to, so a shut section still answers for itself.
 */
export function DrawerSection({ label, hint = null, children, className = '' }) {
  return (
    <section className={cx('px-[19px] pb-[18px]', className)}>
      {label ? (
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-inkSoft">{label}</span>
          {hint ? <span className="truncate text-[10.5px] text-ink3">{hint}</span> : null}
        </div>
      ) : null}
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

/**
 * One row: a name on the left, its control on the right.
 * `stack` puts the control on its own line beneath the name — for sliders and
 * anything wider than about half the drawer.
 */
export function DrawerRow({ label, hint = '', children, stack = false, title = '', className = '' }) {
  if (stack) {
    return (
      <div className={cx('flex flex-col gap-1.5 py-2.5', className)} title={title || undefined}>
        {label ? (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[12.5px] text-inkSoft">{label}</span>
            {hint ? <span className="font-mono text-[12.5px] text-ink1">{hint}</span> : null}
          </div>
        ) : null}
        {children}
      </div>
    );
  }
  return (
    <div className={cx('flex items-center justify-between gap-3 py-2.5', className)} title={title || undefined}>
      {label ? <span className="min-w-0 text-[12.5px] text-inkSoft">{label}</span> : null}
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** A read-only value at the right of a row, in the mono the design uses. */
export function DrawerValue({ children, tone = 'ink' }) {
  return (
    <span className={cx('font-mono text-[12.5px]', tone === 'honey' ? 'text-honey' : 'text-ink1')}>{children}</span>
  );
}

/**
 * The card at the top of the drawer: where this run goes, and what it costs.
 * It is the same decision the recipe line's last token makes — this is its
 * fuller face, with the reason underneath.
 */
export function DrawerRunOn({ icon = 'cpu', title, subtitle = '', onClick, disabled = false }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <div className="px-[19px] pb-4 pt-1">
      <Tag
        {...(onClick ? { type: 'button', onClick, disabled } : {})}
        className={cx(
          'flex w-full items-center gap-[9px] rounded-[11px] bg-white/[0.04] px-[13px] py-[11px] text-left',
          onClick && !disabled && 'transition-colors hover:bg-white/[0.07]',
          disabled && 'opacity-50',
        )}
      >
        <Icon name={icon} size={16} className="shrink-0 text-inkSoft" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink1">{title}</span>
          {subtitle ? <span className="block truncate text-[11px] text-inkSoft">{subtitle}</span> : null}
        </span>
        {onClick ? <Icon name="chevronDown" size={14} className="shrink-0 text-inkSoft" /> : null}
      </Tag>
    </div>
  );
}

/** A hairline between sections that belong to the same idea. */
export function DrawerDivider() {
  return <div className="mx-[19px] mb-[18px] h-px bg-line1" />;
}

/**
 * The small segmented control the drawer uses for two-to-four short choices
 * (Draft/High/Best, Standard/High detail). The kit's Segmented is sized for the
 * old panel's 320px rows with labels; this one is mono and compact, matching
 * the "How many 1 2 3 4" pill in the design.
 */
export function DrawerChoice({ options, value, onChange, disabled = false, mono = true, ariaLabel }) {
  return (
    <span
      role="radiogroup"
      aria-label={ariaLabel}
      className={cx('inline-flex items-center gap-px rounded-[8px] bg-white/[0.04] p-0.5', disabled && 'opacity-40')}
    >
      {options.map((option) => {
        const item = typeof option === 'object' ? option : { value: option, label: String(option) };
        const on = String(item.value) === String(value);
        return (
          <button
            key={String(item.value)}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled || item.disabled}
            title={item.title || undefined}
            onClick={() => onChange(item.value)}
            className={cx(
              'inline-flex h-6 min-w-[26px] items-center justify-center rounded-[6px] px-2 text-[11px] transition-colors',
              mono && 'font-mono',
              on ? 'bg-bg3 text-ink1' : 'text-inkSoft hover:text-ink1',
              (disabled || item.disabled) && 'cursor-not-allowed opacity-50',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </span>
  );
}
