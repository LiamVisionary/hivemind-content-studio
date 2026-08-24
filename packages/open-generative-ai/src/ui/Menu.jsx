// Popover menu + composer chip — replaces the old <details> popovers.
// Outside-click + esc dismissal, single-open semantics per instance.
import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.jsx';
import { cx } from './kit.jsx';

// A modal is portaled to document.body, so it is never INSIDE the popover that
// opened it — without this, typing a name into a dialog raised from a panel
// dismissed the panel underneath, unmounting the dialog mid-keystroke. A layer
// above must not dismiss the layer below: clicks inside a dialog are its own,
// and Escape belongs to the topmost thing on screen.
const inModal = (node) => Boolean(node?.closest?.('[role="dialog"]'));
const modalOpen = () => Boolean(document.querySelector('[role="dialog"]'));

export function useDismissable(open, close) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (inModal(e.target)) return;
      if (ref.current && !ref.current.contains(e.target)) close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && !modalOpen()) close();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

/**
 * ChipButton — labelled current-value chip for composer bars.
 * <ChipButton icon="cpu" label="Model" value="Seedance Lite" onClick={...} active />
 */
export function ChipButton({
  icon, label, value, onClick, active = false, disabled = false, className = '', chevron = true,
  // An armed chip whose settings no longer agree with the composer. Drawn as a
  // dashed honey outline rather than a new colour, so "on" and "on but stale"
  // stay one family and only the edge changes.
  warn = false,
  // title / aria-* / data-* ride through: every tooltip written for a chip used
  // to be dropped here silently.
  ...rest
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...rest}
      className={cx(
        'inline-flex h-ctl-md max-w-[240px] shrink-0 items-center gap-2 rounded-md border px-3 text-[13px] transition-colors duration-150',
        active
          ? 'border-honey/50 bg-honey-tint text-ink1'
          : 'border-line1 bg-bg2 text-ink1 hover:border-line2 hover:bg-bg3',
        warn && 'border-dashed border-honey',
        disabled && 'opacity-40',
        className,
      )}
    >
      {icon ? <Icon name={icon} size={15} className={cx('shrink-0', warn ? 'text-honey' : 'text-ink3')} /> : null}
      {label ? <span className="shrink-0 text-xs font-medium text-ink3">{label}</span> : null}
      {value ? <span className="truncate font-medium">{value}</span> : null}
      {chevron ? <Icon name="chevronDown" size={13} className="shrink-0 text-ink3" /> : null}
    </button>
  );
}

/**
 * Menu — anchored popover. Anchor renders via `trigger(open, toggle)`.
 * <Menu trigger={(open, toggle) => <ChipButton ... active={open} onClick={toggle} />} align="start" up>
 *   <MenuItem selected onClick={...}>…</MenuItem>
 * </Menu>
 */
export function Menu({ trigger, children, align = 'start', up = false, width = 'w-64', panelClassName = '' }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(open, () => setOpen(false));
  const panelRef = useRef(null);
  const [side, setSide] = useState(align);
  // A popover anchored at the left of a chip near the right edge (or wider than a
  // phone) used to run off-screen; flip to the other edge when it would.
  useEffect(() => {
    if (!open) { setSide(align); return; }
    const panel = panelRef.current;
    const anchor = ref.current;
    if (!panel || !anchor) return;
    // Measure with the UNSCALED width (offsetWidth) against the anchor's box: the
    // panel is mid scale-in when this runs, so its own bounding rect under-reports.
    const anchorRect = anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    const margin = 8;
    const fits = width < window.innerWidth - 2 * margin;
    if (align !== 'end' && fits && anchorRect.left + width > window.innerWidth - margin) setSide('end');
    else if (align === 'end' && fits && anchorRect.right - width < margin) setSide('start');
    else setSide(align);
  }, [open, align, ref]);
  return (
    <div ref={ref} className="relative inline-block">
      {trigger(open, () => setOpen((v) => !v))}
      {open ? (
        <div
          ref={panelRef}
          className={cx(
            'hive-scale-in absolute z-50 max-h-[min(420px,60vh)] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-line1 bg-bg1 p-1.5 shadow-pop',
            width,
            up ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]',
            side === 'end' ? 'right-0' : 'left-0',
            panelClassName,
          )}
          role="menu"
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({ selected = false, disabled = false, icon, meta, children, className = '', ...rest }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors duration-150',
        selected ? 'bg-honey-tint text-ink1' : 'text-ink2 hover:bg-bg2 hover:text-ink1',
        disabled && 'opacity-40',
        className,
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} size={15} className="shrink-0 text-ink3" /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {meta ? <span className="shrink-0 font-mono text-[11px] text-ink3">{meta}</span> : null}
      {selected ? <Icon name="check" size={14} className="shrink-0 text-honey" /> : null}
    </button>
  );
}

export function MenuHeading({ children }) {
  return (
    <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink3">
      {children}
    </div>
  );
}
