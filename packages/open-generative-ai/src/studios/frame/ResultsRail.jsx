// The right edge — everything this tab has already made, newest at the top.
//
// It replaces the scrolling grid of gallery cards. The grid competed with the
// picture for the window; a 96px rail does not, and it keeps the run you are
// looking at one click from every other one. The Video studio uses the same
// rail at 108px, where the cards are numbered shots rather than loose stills.
//
// Nothing here is a link to the Library — the Library is still the Library.
// This is only what this tab made, in this session.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../../ui/icons.jsx';
import { cx } from '../../ui/kit.jsx';

/** The mono cap over a group of cards: RESULTS, SEQUENCE, EARLIER. */
export function RailHeading({ children }) {
  return (
    <span className="shrink-0 select-none pt-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-inkSoft">
      {children}
    </span>
  );
}

/**
 * One card in the rail.
 *
 * @param {string} src      resolved media src (already through e2eMedia)
 * @param {string} poster   for video cards, a still to show instead of the clip
 * @param {string} aspect   CSS aspect-ratio, e.g. '9 / 16'. Drives the card's height.
 * @param {bool}   selected the one on the stage
 * @param {string} caption  the shot label a video card carries ("01 · 5s")
 * @param {node}   badge    a corner mark (running, excluded, failed)
 * @param {string} label    accessible name — required, the card is a button
 */
export function RailCard({
  src = '',
  poster = '',
  aspect = '1 / 1',
  selected = false,
  caption = '',
  badge = null,
  label,
  width = 48,
  onClick,
  onDoubleClick,
  onContextMenu,
  draggable = false,
  lazy = false,
  onDragStart,
  className = '',
  children = null,
  ...rest
}) {
  const media = poster || src;
  return (
    <button
      type="button"
      // What the frame counts to decide whether the rail has anything in it.
      // Below sm the rail lies across the composer, and a strip that is only a
      // heading and the words "Nothing yet" is 40px of a phone spent saying
      // nothing — so the frame hides itself when no card carries this.
      data-rail-card=""
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      title={label}
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      {...rest}
      className={cx(
        'group relative shrink-0 overflow-hidden rounded-[8px] bg-bg2 transition-shadow',
        selected ? 'bg-bg3 shadow-[0_0_0_1.5px_rgb(var(--honey-rgb))]' : 'hover:shadow-[0_0_0_1.5px_var(--line-2)]',
        className,
      )}
      style={{ width, aspectRatio: aspect }}
    >
      {/* EAGER on purpose. This rail does not scroll far, and Chrome defers a
          lazy image in a short non-scrolling panel and then never re-evaluates
          it without a scroll or resize — the cards come up blank and stay
          blank. Callers that really do have a long rail can opt back in. */}
      {media ? (
        <img src={media} alt="" loading={lazy ? 'lazy' : 'eager'} className="h-full w-full object-cover" />
      ) : null}
      {caption ? (
        <span
          className={cx(
            'pointer-events-none absolute bottom-1 left-1.5 font-mono text-[9px]',
            selected ? 'text-honey' : 'text-inkSoft',
          )}
        >
          {caption}
        </span>
      ) : null}
      {badge}
      {children}
    </button>
  );
}

/** The dashed "+" card that ends the Video studio's sequence. */
export function RailAdd({ label, onClick, width = 72, aspect = '16 / 9' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid shrink-0 place-items-center rounded-[7px] border border-dashed border-white/[0.13] text-inkSoft transition-colors hover:border-honey/50 hover:text-honey"
      style={{ width, aspectRatio: aspect }}
    >
      <Icon name="plus" size={14} />
    </button>
  );
}

/** A hairline between groups in the rail. */
export function RailDivider() {
  return <span className="mt-1 h-px w-11 shrink-0 bg-line1" />;
}

/** "+4" — how much more there is, and the door to it. */
export function RailOverflow({ count, onClick, label = 'Show every result in the Library', width = 48 }) {
  if (!count) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      data-rail-card=""
      className="grid h-[30px] shrink-0 place-items-center rounded-[8px] font-mono text-[10px] text-inkSoft transition-colors hover:bg-white/5 hover:text-ink1"
      style={{ width }}
    >
      {`+${count}`}
    </button>
  );
}

/** What the rail says before anything has been made. */
export function RailEmpty({ children }) {
  return (
    <span className="px-1 pt-2 text-center font-mono text-[9px] leading-relaxed text-ink3">{children}</span>
  );
}

/* ---------------- the per-card actions, as one popover ---------------- */

/**
 * The shell every rail card's actions open into.
 *
 * Portaled to <body> and fixed-positioned rather than anchored inside the card:
 * the frame's rail is overflow-y-auto, and a popover rendered inside it is
 * clipped at the 96/108px edge and scrolls away with the column. Coordinates
 * are measured after mount, placed to the LEFT of the rail, and clamped to the
 * viewport — the same idiom kit.jsx's HintBubble uses.
 *
 * Lives here rather than in a studio because all three rails need exactly this:
 * Video wrote it, Image had grown its own copy of the same fifty lines, and
 * Restore would have been the third. One definition, so a fix to the placement
 * maths cannot land in two rails out of three.
 */
export function RailMenu({ anchor, label, onClose, width = 'w-60', children }) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const node = panelRef.current;
    if (!anchor || !node) return undefined;
    const place = () => {
      const target = anchor.getBoundingClientRect();
      const panel = node.getBoundingClientRect();
      const margin = 8;
      const leftOfRail = target.left - panel.width - margin;
      const next = {
        left: leftOfRail >= margin
          ? leftOfRail
          : Math.max(margin, Math.min(target.right + margin, window.innerWidth - panel.width - margin)),
        top: Math.min(
          Math.max(target.top, margin),
          Math.max(margin, window.innerHeight - panel.height - margin),
        ),
      };
      setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
    };
    place();
    // Fixed coordinates do not follow the anchor: scrolling the rail under an
    // open menu would leave it stranded where the card used to be.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor]);

  useEffect(() => {
    const onDown = (event) => {
      if (panelRef.current?.contains(event.target)) return;
      // A press on the card itself is that card's own business — it toggles.
      if (anchor?.contains?.(event.target)) return;
      onClose();
    };
    // Capture, and stop there: the frame's drawer also listens for Escape on
    // window, and the topmost transient layer is the one that owns the key.
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      style={{ position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      className={cx('hive-scale-in z-[90] rounded-lg border border-line1 bg-bg1 p-1.5 shadow-pop', width)}
    >
      {children}
    </div>,
    document.body,
  );
}

/** The two lines of context a 48/72px card cannot carry: what it is, and what made it. */
export function RailMenuSubject({ text, model }) {
  return (
    <div className="px-2.5 pb-2 pt-1">
      <p className="line-clamp-2 text-[12px] leading-snug text-ink2">{text || '—'}</p>
      {model ? <p className="truncate font-mono text-[10px] text-ink3">{model}</p> : null}
    </div>
  );
}
