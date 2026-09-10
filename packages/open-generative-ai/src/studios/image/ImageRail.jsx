// The Image studio's right edge: every picture this tab has made, newest first.
//
// It replaces the auto-fill grid of 200px GalleryCards that used to own the
// canvas (the `gallery-grid` at ImageStudio.jsx:3317). The grid competed with
// the picture for the window; a 96px rail does not, and it keeps the run you
// are looking at one click from every other one.
//
// Nothing the grid could do was dropped. The click still opens the viewer, the
// tile is still the same draggable output payload, the duration badge is still
// always-on — and the three hover-only overlay buttons (download, upscale,
// reuse) move into ONE context menu, because 48px has no room for three 28px
// buttons and because a hover overlay was never reachable on a touch device in
// the first place. The menu opens on right-click, on long-press, and from a
// "…" door that appears on hover or keyboard focus, so all three input kinds
// reach the same actions.
//
// This file renders and forwards; it decides nothing. Every action is a handler
// the studio already owns (galleryActionsRef → open/download/reuse/upscale), so
// the memo contract, the seal-keyed download name and the reference cap all
// keep working exactly as they did.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useMediaSrc } from '../../hooks/hooks.js';
import { t } from '../../lib/i18n.js';
import { HIVEMIND_OUTPUT_DRAG_TYPE } from '../../lib/referenceDrop.js';
import { Icon } from '../../ui/icons.jsx';
import { MenuItem } from '../../ui/Menu.jsx';
import { Pill, Spinner, cx } from '../../ui/kit.jsx';
import { RailCard, RailEmpty, RailHeading, RailOverflow } from '../frame/ResultsRail.jsx';
import { formatTook } from './GalleryAndViewer.jsx';

// The design's rail: 96px wide, 48px cards. The card width is fixed and the
// HEIGHT is the entry's own aspect, which is what makes the column readable at
// a glance — a portrait run and a landscape run do not look alike.
const CARD_W = 48;

// How many cards stand in the rail before the rest collapse into "+N".
//
// The artboard draws eight, but eight is a DRAWING, not a cap: the grid this
// replaced rendered the whole of s.history with a Reuse button on every card, so
// truncating at eight would quietly take "use that one from earlier as a
// reference" away from everything older. The rail scrolls, the cards are 48px,
// and the session history is capped at 50 by saveStudioGenerationHistory — so
// the rail holds all of it and "+N" stays for the day that cap moves.
const RAIL_LIMIT = 50;

// Long enough not to fire on a tap, short enough to feel like a press.
const LONG_PRESS_MS = 500;

// Written out rather than imported from cloudAdopt.js's UNSAVED_RESULT_LABEL on
// purpose: spriteAndCloudPersistence.test.js greps the RESULT SURFACES for this
// exact sentence, and the rail is now one of them. The Pill sits directly above
// Download in the menu — a problem is never shown without the action that fixes
// it (DESIGN.md §4).
const UNSAVED_RESULT_LABEL = 'Not saved — download to keep';

// A card's height comes from `aspect_ratio` ("9:16", or "1536:1024" for an
// expansion, which is a pixel pair used as a ratio). Clamped to a band: an
// entry that recorded something absurd would otherwise make a 400px tall card
// and push the rest of the session off the rail.
export function railCardAspect(entry) {
  const [w, h] = String(entry?.aspect_ratio || '').split(':').map(Number);
  const ratio = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : 1;
  return `${Math.min(Math.max(ratio, 0.5), 2)} / 1`;
}

// The card is a button, so this is its accessible name AND its hover tooltip —
// which is where the old bottom gradient's prompt+model overlay went. A 48px
// tile cannot hold two lines of text; the title can hold both.
export function railCardLabel(entry) {
  const prompt = String(entry?.prompt || '').trim();
  const model = String(entry?.model || '').trim();
  const head = prompt.length > 80 ? `${prompt.slice(0, 79)}…` : (prompt || 'Generated image');
  return model ? `${head} · ${model}` : head;
}

// The one payload that carries an in-app output between routes. Imported rather
// than typed out: three of the four producers hard-coded the literal and drifted.
// text/uri-list rides alongside it so a drop outside the app still means something.
function writeOutputDrag(event, url) {
  try {
    event.dataTransfer.setData(
      HIVEMIND_OUTPUT_DRAG_TYPE,
      JSON.stringify({ url, section: 'image', mediaType: 'image/*' }),
    );
    event.dataTransfer.setData('text/uri-list', url);
    event.dataTransfer.effectAllowed = 'copy';
  } catch { /* non-critical */ }
}

/**
 * One result in the rail.
 *
 * Memoised on its own entry, and every handler takes the entry as an argument
 * so the studio can pass ONE stable function per action instead of a fresh
 * closure per card. That is not a nicety: each card holds a decrypt hook, the
 * studio re-renders on every keystroke in the composer, and without memo those
 * renders re-decrypt every thumbnail in the rail.
 */
const ImageRailCard = memo(function ImageRailCard({
  entry, selected, onOpen, onMenu,
}) {
  const src = useMediaSrc(entry.url);
  const holderRef = useRef(null);
  const timerRef = useRef(0);
  // A long press ends in a click; without this the menu would open and the
  // viewer would open behind it.
  const heldRef = useRef(false);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const endPress = () => clearTimeout(timerRef.current);
  const startPress = (event) => {
    if (event.button !== 0) return; // a right-click has its own door
    heldRef.current = false;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      heldRef.current = true;
      onMenu(entry, holderRef.current);
    }, LONG_PRESS_MS);
  };

  const took = formatTook(entry.generationMs);
  return (
    <div ref={holderRef} className="group relative shrink-0">
      <RailCard
        // No src/caption/badge to the primitive on purpose — see the <img> below.
        aspect={railCardAspect(entry)}
        width={CARD_W}
        selected={selected}
        label={railCardLabel(entry)}
        draggable
        onDragStart={(event) => { endPress(); writeOutputDrag(event, entry.url); }}
        onClick={() => {
          if (heldRef.current) { heldRef.current = false; return; }
          onOpen(entry);
        }}
        onContextMenu={(event) => { event.preventDefault(); endPress(); onMenu(entry, holderRef.current); }}
        onPointerDown={startPress}
        onPointerUp={endPress}
        onPointerLeave={endPress}
        onPointerCancel={endPress}
      >
        {/* loading="eager", and drawn here rather than through RailCard's own
            src prop, which hard-codes loading="lazy". A rail of eight cards has
            scrollHeight === clientHeight, so no scroll event can ever fire, and
            Chrome never revisits a deferred lazy image: the picture simply never
            appears (zero network requests, currentSrc ''). The old gallery card
            carried the same note. */}
        {src ? (
          <img src={src} alt="" loading="eager" className="h-full w-full object-cover" />
        ) : null}
        {/* Always on, not hover-only: how long this one took is the number a
            person compares down the column while tuning settings. */}
        {took ? (
          <span
            className={cx(
              'pointer-events-none absolute bottom-1 left-1.5 font-mono text-[9px]',
              selected ? 'text-honey' : 'text-inkSoft',
            )}
          >
            {took}
          </span>
        ) : null}
        {/* A cloud result the studio could not keep. The sentence is in the
            menu, next to Download; out here it is a mark you can see without
            opening anything. Top-LEFT: the "…" door owns the other corner and
            would cover it the moment you reached for it. */}
        {entry?.saved === false ? (
          <span className="pointer-events-none absolute left-1 top-1 h-1.5 w-1.5 rounded-full bg-warn shadow-[0_0_0_2px_rgba(0,0,0,0.55)]" />
        ) : null}
      </RailCard>
      {/* The menu's visible door. A nested <button> inside RailCard's button
          would be invalid, so it is a sibling floated over the card's corner.
          Kept mounted (not hover-gated in the DOM) so it is tabbable: the old
          overlay used group-focus-within for exactly that reason. */}
      <button
        type="button"
        title="More actions"
        aria-label={`More actions — ${railCardLabel(entry)}`}
        aria-haspopup="menu"
        onClick={() => onMenu(entry, holderRef.current)}
        className={cx(
          'absolute right-0.5 top-0.5 grid h-[18px] w-[18px] place-items-center rounded-full bg-bg0/80 text-ink1',
          'opacity-0 transition-opacity duration-150 hover:bg-bg1 focus-visible:opacity-100',
          'group-focus-within:opacity-100 group-hover:opacity-100',
        )}
      >
        <Icon name="more" size={11} />
      </button>
    </div>
  );
});

/**
 * The per-result actions, as one context menu.
 *
 * Portaled to <body> and fixed-positioned rather than anchored inside the card:
 * the frame's rail is overflow-y-auto, and a popover rendered inside it is
 * clipped at the 96px edge and scrolls away with the column. Coordinates are
 * measured after mount, placed to the LEFT of the rail, and clamped to the
 * viewport — the same idiom kit.jsx's HintBubble uses.
 */
function RailActionsMenu({ entry, anchor, canReuse, onClose, onOpen, onDownload, onReuse, onUpscale }) {
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
    // window, and the topmost transient layer is the one that owns the key —
    // the same rule the dialogs use ("act only if I am the last one open").
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

  const run = (action, ...args) => {
    onClose();
    action?.(entry, ...args);
  };

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label="Result actions"
      style={{ position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      className="hive-scale-in z-[90] w-56 rounded-lg border border-line1 bg-bg1 p-1.5 shadow-pop"
    >
      {/* Where the card's hover gradient went: the prompt and the model that
          made this one, which no longer fit on a 48px tile. */}
      <div className="px-2.5 pb-2 pt-1">
        <p className="line-clamp-2 text-[12px] leading-snug text-ink2">{entry.prompt || '—'}</p>
        {entry.model ? <p className="truncate font-mono text-[10px] text-ink3">{entry.model}</p> : null}
      </div>
      <MenuItem icon="eye" onClick={() => run(onOpen)}>View</MenuItem>
      {/* The filename is model-prefixed and keyed on entry.id, never the index:
          the vault seal keys off the id, and an index shifts as runs arrive. */}
      <MenuItem icon="download" onClick={() => run(onDownload)}>{t('common.download')}</MenuItem>
      {onUpscale ? (
        // Fast (R-ESRGAN) only from a card, as before — the max-quality variant
        // costs minutes and lives in the viewer, next to the picture it judges.
        <MenuItem icon="wand" onClick={() => run(onUpscale, 'fast')}>Upscale (hi-res)</MenuItem>
      ) : null}
      {canReuse ? (
        <MenuItem icon="plus" onClick={() => run(onReuse)}>Reuse as reference image</MenuItem>
      ) : null}
      {entry?.saved === false ? (
        <div className="px-2 pb-1 pt-1.5">
          <Pill tone="warn">{UNSAVED_RESULT_LABEL}</Pill>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

/**
 * ImageRail — the Image studio's `rail` slot for StudioFrame (railWidth 96).
 *
 * The frame owns the column itself (the scrolling aside, its gap and padding),
 * so this returns the column's contents: heading, cards, overflow.
 *
 * @param {array}  entries      s.history, newest first
 * @param {string} selectedUrl  s.viewerUrl — '' when nothing is open in the viewer
 * @param {bool}   generating   s.generating
 * @param {bool}   canReuse     refsSupported (currentModelSupportsImage())
 * @param {number} limit        cards before the "+N" collapse
 * @param {func}   onOpen       (entry) => …  the studio's openGalleryEntry
 * @param {func}   onDownload   (entry) => …  downloadGalleryEntry
 * @param {func}   onReuse      (entry) => …  reuseGalleryEntry
 * @param {func}   onUpscale    (entry, mode) => …  upscaleGalleryEntry, or undefined
 * @param {func}   onOpenLibrary  optional; defaults to the same navigate event
 *                                the old empty state's "Open Library" fired
 */
export function ImageRail({
  entries = [],
  selectedUrl = '',
  generating = false,
  canReuse = false,
  limit = RAIL_LIMIT,
  onOpen,
  onDownload,
  onReuse,
  onUpscale,
  onOpenLibrary,
}) {
  // { entry, anchor } — one menu for the whole rail, not one per card: a menu
  // per card would give every card a piece of state and break the memo above.
  const [menu, setMenu] = useState(null);
  const openMenu = useCallback((entry, anchor) => {
    // Pressing the "…" of the card whose menu is already open closes it; a
    // right-click or long-press on another card moves the menu there.
    setMenu((prev) => (prev && prev.entry === entry && prev.anchor === anchor ? null : { entry, anchor }));
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const shown = entries.slice(0, Math.max(limit, 0));
  const hidden = entries.length - shown.length;
  const openLibrary = () => {
    if (onOpenLibrary) { onOpenLibrary(); return; }
    // The same exit the canvas's empty state used — one of the app's four
    // outbound navigate dispatches.
    try {
      window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'history' } }));
    } catch { /* no window */ }
  };

  return (
    <>
      <RailHeading>
        Results
        {entries.length ? (
          <span className="ml-1 tracking-normal text-ink3" title={t('common.history')}>{entries.length}</span>
        ) : null}
      </RailHeading>

      {/* A run in flight gets a place in the column before it has a picture, so
          the rail does not read "nothing yet" while the stage is at 40%. The
          readout itself stays on the stage — this is only the seat, and it is
          aria-hidden so it does not announce a second time over StageProgress. */}
      {generating ? (
        <span
          aria-hidden="true"
          title={t('common.generating')}
          className="grid shrink-0 animate-pulse place-items-center rounded-[8px] bg-bg2"
          style={{ width: CARD_W, aspectRatio: '1 / 1' }}
        >
          <Spinner size={13} />
        </span>
      ) : null}

      {shown.map((entry, idx) => (
        <ImageRailCard
          key={entry.id || `${entry.url}-${idx}`}
          entry={entry}
          // Unchanged from the grid: the viewer's entry when one is open,
          // otherwise the newest — which is what the stage is showing.
          selected={selectedUrl ? selectedUrl === entry.url : idx === 0}
          onOpen={onOpen}
          onMenu={openMenu}
        />
      ))}

      {/* Renders nothing at 0. Everything it hides is still in the viewer's
          ← / → walk and in the Library, which is where this leads. */}
      <RailOverflow count={hidden} width={CARD_W} onClick={openLibrary} label="Show every result in the Library" />

      {!entries.length && !generating ? (
        <RailEmpty>Nothing yet</RailEmpty>
      ) : null}

      {menu ? (
        <RailActionsMenu
          entry={menu.entry}
          anchor={menu.anchor}
          canReuse={canReuse}
          onClose={closeMenu}
          onOpen={onOpen}
          onDownload={onDownload}
          onReuse={onReuse}
          onUpscale={onUpscale}
        />
      ) : null}
    </>
  );
}
