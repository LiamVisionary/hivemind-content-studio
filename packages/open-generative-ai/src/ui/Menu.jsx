// Popover menu + composer chip — replaces the old <details> popovers.
// Outside-click + esc dismissal, single-open semantics per instance.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.jsx';
import { cx } from './kit.jsx';

// A modal is portaled to document.body, so it is never INSIDE the popover that
// opened it — without this, typing a name into a dialog raised from a panel
// dismissed the panel underneath, unmounting the dialog mid-keystroke. A layer
// above must not dismiss the layer below: clicks inside a dialog are its own,
// and Escape belongs to the topmost thing on screen.
const inModal = (node) => Boolean(node?.closest?.('[role="dialog"]'));
const modalOpen = () => Boolean(document.querySelector('[role="dialog"]'));

// A surface that SCROLLS clips every menu opened inside it: a scroll box cuts off
// whatever overflows it, however high its z-index. The studio frame's Advanced
// drawer is one — its Runs on menu is 360px wide and the drawer is 320, so the
// list lost its right-hand column at the drawer's edge. A surface like that
// provides an element OUTSIDE its scroll box here, and a Menu inside it draws
// its panel into that element at fixed coordinates taken from the trigger.
// Every other Menu keeps its panel where it always was.
//
// Not document.body: the Image and Video studios persist settings from a
// capture-phase listener on their own root, and a panel outside that root
// would change the model without the change ever being saved.
export const MenuLayer = createContext(null);

export function useDismissable(open, close, panelRef = null) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (inModal(e.target)) return;
      // A panel drawn into a MenuLayer is not inside the wrapper, and it is
      // still the menu.
      if (panelRef?.current?.contains(e.target)) return;
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
  }, [open, close, panelRef]);
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
export function Menu({
  trigger, children, align = 'start', up = false, width = 'w-64', panelClassName = '',
  // Optional controlled mode: pass `open` (plus `onOpenChange`) when something
  // OUTSIDE the trigger has to open this menu — a route that folded a retired
  // page into it, say. Omit both and the menu keeps its own state as before.
  open: openProp, onOpenChange,
}) {
  const [selfOpen, setSelfOpen] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? Boolean(openProp) : selfOpen;
  const setOpen = (next) => {
    const value = typeof next === 'function' ? next(open) : next;
    if (!controlled) setSelfOpen(value);
    onOpenChange?.(value);
  };
  const panelRef = useRef(null);
  const ref = useDismissable(open, () => setOpen(false), panelRef);
  // The element a clipping surface asked this menu to draw in (see MenuLayer).
  const layer = useContext(MenuLayer);
  const [side, setSide] = useState(align);
  // `up` is a PREFERENCE, not a position. A menu anchored low on the window —
  // every control in the studios' floating composer is — opened downward and ran
  // off the bottom, which is the vertical twin of the horizontal overflow the
  // side-flip below already fixed. So the same rule now runs on both axes: keep
  // the asked-for side while it fits, otherwise take whichever has more room.
  const [drop, setDrop] = useState(up ? 'up' : 'down');
  // When neither side can hold the panel, it is clamped to the room it has and
  // scrolls inside — better than a list whose last item is under the screen edge.
  const [roomCap, setRoomCap] = useState(null);
  // Where a panel drawn into a layer sits, in viewport pixels. Null until it has
  // been measured, and the panel stays invisible until then.
  const [pinnedAt, setPinnedAt] = useState(null);
  // A popover anchored at the left of a chip near the right edge (or wider than a
  // phone) used to run off-screen; flip to the other edge when it would.
  useEffect(() => {
    if (!open) { setSide(align); setDrop(up ? 'up' : 'down'); setRoomCap(null); setPinnedAt(null); return undefined; }
    const panel = panelRef.current;
    const anchor = ref.current;
    if (!panel || !anchor) return undefined;
    // Measure with the UNSCALED box (offsetWidth/offsetHeight) against the
    // anchor's rect: the panel is mid scale-in when this runs, so its own
    // bounding rect under-reports.
    const anchorRect = anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    const margin = 8;
    const fits = width < window.innerWidth - 2 * margin;
    const chosenSide = align !== 'end' && fits && anchorRect.left + width > window.innerWidth - margin ? 'end'
      : align === 'end' && fits && anchorRect.right - width < margin ? 'start'
        : align;
    setSide(chosenSide);

    // 6px is the gap the panel's own bottom-/top-[calc(100%+6px)] leaves.
    const gap = 6;
    const height = panel.offsetHeight;
    const roomBelow = window.innerHeight - anchorRect.bottom - gap - margin;
    const roomAbove = anchorRect.top - gap - margin;
    const wanted = up ? 'up' : 'down';
    const roomFor = (where) => (where === 'up' ? roomAbove : roomBelow);
    const chosen = height <= roomFor(wanted) || roomFor(wanted) >= roomFor(wanted === 'up' ? 'down' : 'up')
      ? wanted
      : (wanted === 'up' ? 'down' : 'up');
    setDrop(chosen);
    // Only ever NARROWS: `height` is already clamped by the panel's own max-h, so
    // a cap is set exactly when even that does not fit, and the class governs
    // otherwise.
    setRoomCap(height > roomFor(chosen) ? Math.max(140, Math.round(roomFor(chosen))) : null);

    if (!layer) return undefined;
    // In a layer the panel is fixed, so the same two decisions become viewport
    // coordinates. Fixed coordinates do not follow the trigger on their own, so a
    // scroll of the drawer under an open menu re-pins it instead of stranding it
    // where the trigger used to be.
    const pin = () => {
      const at = anchor.getBoundingClientRect();
      const left = chosenSide === 'end' ? at.right - width : at.left;
      const next = {
        left: Math.round(Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - width - margin))),
        top: chosen === 'up' ? null : Math.round(at.bottom + gap),
        bottom: chosen === 'up' ? Math.round(window.innerHeight - at.top + gap) : null,
      };
      setPinnedAt((prev) => (prev && prev.left === next.left && prev.top === next.top && prev.bottom === next.bottom ? prev : next));
    };
    pin();
    window.addEventListener('scroll', pin, true);
    window.addEventListener('resize', pin);
    return () => {
      window.removeEventListener('scroll', pin, true);
      window.removeEventListener('resize', pin);
    };
  }, [open, align, up, ref, layer]);

  const panel = open ? (
    <div
      ref={panelRef}
      className={cx(
        // dvh rather than vh: `vh` is iOS's LARGE viewport, so a 60vh menu
        // could stand taller than the screen it was being clamped to. And a
        // flick that reaches the end of a menu must stop there rather than
        // scrolling whatever is behind it.
        'hive-scale-in max-h-[min(420px,60dvh)] max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-lg border border-line1 bg-bg1 p-1.5 shadow-pop touch:p-2',
        width,
        layer
          // Over the drawer (z-40) and the frame's floating surfaces, and under
          // a Modal (z-[100]) that a row in here can raise.
          ? 'fixed z-[60]'
          : cx(
            'absolute z-50',
            drop === 'up' ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]',
            side === 'end' ? 'right-0' : 'left-0',
          ),
        panelClassName,
      )}
      style={layer
        ? {
          left: pinnedAt?.left ?? 0,
          top: pinnedAt?.top ?? undefined,
          bottom: pinnedAt?.bottom ?? undefined,
          visibility: pinnedAt ? undefined : 'hidden',
          ...(roomCap ? { maxHeight: `${roomCap}px` } : null),
        }
        : (roomCap ? { maxHeight: `${roomCap}px` } : undefined)}
      role="menu"
    >
      {typeof children === 'function' ? children(() => setOpen(false)) : children}
    </div>
  ) : null;

  return (
    <div ref={ref} className="relative inline-block">
      {trigger(open, () => setOpen((v) => !v))}
      {panel && layer ? createPortal(panel, layer) : panel}
    </div>
  );
}

/**
 * One row of a menu.
 *
 * `note` is a second line under the label, for a choice whose label cannot say
 * what it does ("Continue the scene" vs "Cut to a new shot" — the difference is
 * what CARRIES). It lives inside the button rather than beside it so the
 * sentence is part of the target: a description drawn next to a row is the half
 * people aim at, and clicking it would do nothing. A row with a note wraps
 * instead of truncating, and its icon rides on the label's line.
 */
export function MenuItem({ selected = false, disabled = false, icon, meta, note, children, className = '', ...rest }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cx(
        // A 33px row is a cursor's row. Menus are where most of this app's
        // settings live — the composer's whole `more` surface, every recipe
        // token's popover, the mobile navigation's Labs and Advanced — so one
        // touch rule here is worth more than any number of local ones.
        'flex w-full gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors duration-150',
        'touch:py-3 touch:text-[14px]',
        note ? 'items-start' : 'items-center',
        selected ? 'bg-honey-tint text-ink1' : 'text-ink2 hover:bg-bg2 hover:text-ink1',
        disabled && 'opacity-40',
        className,
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} size={15} className={cx('shrink-0 text-ink3', note && 'mt-0.5')} /> : null}
      {note ? (
        <span className="min-w-0 flex-1">
          <span className="block">{children}</span>
          <span className="mt-0.5 block text-[11px] leading-snug text-ink3">{note}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{children}</span>
      )}
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
