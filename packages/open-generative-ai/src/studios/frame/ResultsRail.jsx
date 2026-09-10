// The right edge — everything this tab has already made, newest at the top.
//
// It replaces the scrolling grid of gallery cards. The grid competed with the
// picture for the window; a 96px rail does not, and it keeps the run you are
// looking at one click from every other one. The Video studio uses the same
// rail at 108px, where the cards are numbered shots rather than loose stills.
//
// Nothing here is a link to the Library — the Library is still the Library.
// This is only what this tab made, in this session.
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
