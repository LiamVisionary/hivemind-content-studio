// The Video studio's right edge: the SEQUENCE, and everything loose under it.
//
// It is the new face of TimelineStrip.jsx — the horizontal Scene strip that
// used to sit *under* the player, plus the 200px History grid that used to sit
// under that. Both competed with the clip for the window. A 108px column does
// not, and it puts the shot you are watching one click from every other one.
//
// What moved, and where it went:
//   Scene strip cards        → the SEQUENCE group (72x41, captioned "01 · 5s")
//   the strip's "+" card     → RailAdd at the end of that group
//   the "Scene" chip         → the SAME "+" card while the scene is closed; it
//                              opens the scene instead of appending, so there
//                              is still exactly one door into the sequence
//   History tiles            → the EARLIER group, newest first
//   the three hover buttons  → one context menu per card (right-click,
//     on a card                long-press, or the "…" door that appears on
//                              hover and on keyboard focus), because 72px has
//                              no room for three buttons and a hover overlay
//                              was never reachable on a touch device anyway
//
// What did NOT move. The operations a 72px card genuinely cannot express —
// Auto-continue, Shot | Full cut, export the cut, close the scene, and the
// build-error note — stay in TimelineStrip, which the composer's "more" menu
// still opens. This rail's segment menu carries the per-shot ones (export,
// drop-from-the-cut, remove) so the common path never needs the full strip.
//
// Drag is unchanged in vocabulary and only rotated in geometry: cards carry
// TIMELINE_SEGMENT_DRAG_TYPE (plus the output payload when they are filled) and
// the drop regions are still before | on | after — measured down the card
// rather than across it, because the strip is a column now. timelineDropPlan on
// the studio side reads the same {id, region} it always did.
//
// This file renders and forwards; it decides nothing. Every action is a handler
// the studio already owns, so the arming path, the quiet full-cut build, the
// replace confirm and the delete-with-file lookup all keep working as they are.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useMediaPoster } from '../../hooks/hooks.js';
import { t } from '../../lib/i18n.js';
import { HIVEMIND_OUTPUT_DRAG_TYPE } from '../../lib/referenceDrop.js';
import { Icon } from '../../ui/icons.jsx';
import { MenuItem } from '../../ui/Menu.jsx';
import { Spinner, cx } from '../../ui/kit.jsx';
import {
  RailAdd, RailCard, RailDivider, RailEmpty, RailHeading, RailOverflow,
} from '../frame/ResultsRail.jsx';
import { TIMELINE_SEGMENT_DRAG_TYPE } from './TimelineStrip.jsx';

// The design's rail: 108px wide, 72x41 cards. Written as a ratio rather than a
// height so the card scales with the width if the rail ever changes.
const CARD_W = 72;
const CARD_ASPECT = '72 / 41';

// How many EARLIER cards stand in the column before the rest collapse into
// "+N" — the same truncation the explore dock and the Image rail use. Nothing
// is lost behind it: "+N" opens the Library, which holds every run ever.
// The loose clips under EARLIER. The artboard draws a handful, but the result
// row this replaced offered every past clip, and the session history is capped
// at 30 by saveStudioGenerationHistory — so the rail carries all of them rather
// than stranding the older ones behind the Library.
const EARLIER_LIMIT = 30;

// Long enough not to fire on a tap, short enough to feel like a press.
const LONG_PRESS_MS = 500;

// Which drop region the pointer is in. Identical semantics to the horizontal
// strip's dropRegionFor — outer quarters are the gaps, the middle half is the
// card — read down the card instead of across it.
function dropRegionFor(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const y = (event.clientY - rect.top) / Math.max(rect.height, 1);
  if (y < 0.25) return 'before';
  if (y > 0.75) return 'after';
  return 'on';
}

const dragIsSegment = (dataTransfer) => Array.from(dataTransfer?.types || [])
  .includes(TIMELINE_SEGMENT_DRAG_TYPE);
const dragIsDroppable = (dataTransfer) => {
  const types = Array.from(dataTransfer?.types || []);
  return types.includes(TIMELINE_SEGMENT_DRAG_TYPE)
    || types.includes(HIVEMIND_OUTPUT_DRAG_TYPE)
    || types.includes('Files');
};

// One drop contract for both card and end targets. `region: 'end'` is the
// append target and has no sub-regions; everything else is measured.
function resolveRegion(target, event) {
  const region = target.region === 'end' ? 'end' : dropRegionFor(event);
  // A segment drag has no "on" meaning — snap it to the nearest gap.
  return region === 'on' && dragIsSegment(event.dataTransfer) ? 'after' : region;
}

// The one payload that carries an in-app output between routes. Imported rather
// than typed out: three of the four producers hard-coded the literal and drifted.
function writeOutputDrag(event, url) {
  try {
    event.dataTransfer.setData(
      HIVEMIND_OUTPUT_DRAG_TYPE,
      JSON.stringify({ url, section: 'video', mediaType: 'video/*' }),
    );
    event.dataTransfer.setData('text/uri-list', url);
  } catch { /* non-critical */ }
}

// The rail scrolls itself to the card that just landed. Stable identity on
// purpose: as a ref callback it then runs when the card mounts or when the
// active card changes, not on every re-render — the same function the History
// strip used, moved here with it.
function scrollCardIntoView(node) {
  if (!node || typeof node.scrollIntoView !== 'function') return;
  try { node.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* older engines */ }
}

const shotNumber = (index) => String(index + 1).padStart(2, '0');

// The studio hands over the SMOOTHED 0..1 bar the stage reads, so the rail's
// caption and the stage's readout can never disagree by a frame.
const pctOf = (value) => Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);

// "01 · 5s". The seconds come from the studio (History row, else the sealed
// per-generation context); a clip with neither is captioned by its number alone
// rather than by a made-up duration.
function shotCaption(index, seconds) {
  const secs = Number(seconds);
  return Number.isFinite(secs) && secs > 0
    ? `${shotNumber(index)} · ${Math.round(secs)}s`
    : shotNumber(index);
}

/** The honey bar that opens in a gap while a drop would insert there. */
function InsertBar({ active }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'shrink-0 rounded-full bg-honey transition-all duration-150 ease-swift',
        active ? 'my-0.5 h-[3px] w-11 opacity-100' : 'h-0 w-11 opacity-0',
      )}
    />
  );
}

/** The 2px foot of a card being rendered into — the artboard's mid-shot state. */
function CardProgress({ value }) {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-white/[0.12]">
      <span className="absolute inset-y-0 left-0 bg-honey" style={{ width: `${pctOf(value)}%` }} />
    </span>
  );
}

/** The poster frame, or what stands in for one while it decrypts. */
function SegmentFace({ url }) {
  const { poster, resolved, pending } = useMediaPoster(url, { kind: 'video' });
  // loading="eager", and drawn here rather than through RailCard's own `src`
  // prop, which hard-codes loading="lazy": a short rail has
  // scrollHeight === clientHeight, no scroll event can ever fire, and Chrome
  // never revisits a deferred lazy image — the frame simply never appears.
  if (poster) return <img src={poster} alt="" loading="eager" className="h-full w-full object-cover" />;
  if (!resolved || pending) return <span className="absolute inset-0 animate-pulse bg-bg2" aria-label="Decrypting" />;
  return (
    <span className="absolute inset-0 grid place-items-center bg-bg0 text-ink3">
      <Icon name="film" size={14} />
    </span>
  );
}

/**
 * One shot in the SEQUENCE.
 *
 * Memoised on its own segment, and every handler takes the segment as an
 * argument so the rail passes ONE stable function per action instead of a fresh
 * closure per card. That is not a nicety: each card holds a poster hook, the
 * studio re-renders on every keystroke in the composer, and without memo those
 * renders re-decrypt every frame in the column.
 */
const SequenceCard = memo(function SequenceCard({
  seg, index, seconds, selected, pending, progress, overRegion, dragging, label,
  onSelect, onMenu, onDragStartCard, onDragEndCard,
  onDragOverCard, onDragLeaveCard, onDropCard,
}) {
  const holderRef = useRef(null);
  const timerRef = useRef(0);
  // A long press ends in a click; without this the menu would open and the
  // shot would be selected behind it.
  const heldRef = useRef(false);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // The column scrolls itself to the shot that just landed or just started —
  // the History strip's behaviour, kept, now that the strip is vertical and a
  // long sequence really can put the live shot out of sight.
  useEffect(() => {
    if (selected || pending) scrollCardIntoView(holderRef.current);
  }, [selected, pending]);

  const endPress = () => clearTimeout(timerRef.current);
  const startPress = (event) => {
    if (event.button !== 0) return; // a right-click has its own door
    heldRef.current = false;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      heldRef.current = true;
      onMenu(seg, holderRef.current);
    }, LONG_PRESS_MS);
  };

  const replaceHover = overRegion === 'on' && Boolean(seg.url);
  const fillHover = overRegion === 'on' && !seg.url;
  return (
    <>
      <InsertBar active={overRegion === 'before'} />
      <div
        ref={holderRef}
        className={cx(
          'group relative shrink-0',
          // The same 40% the horizontal strip used, for the same two reasons:
          // a card being dragged, and a shot the cut is not using.
          (dragging || seg.excluded) && 'opacity-40',
        )}
      >
        <RailCard
          // No src/caption to the primitive on purpose — the face and the
          // caption are drawn below, over a possible progress overlay.
          width={CARD_W}
          aspect={CARD_ASPECT}
          // One honey ring, three meanings, told apart by the face under it:
          // the shot on the player, the shot being rendered into, and the shot
          // a drop is about to land on. Routed through `selected` rather than a
          // className so it cannot lose to the primitive's own :hover ring.
          selected={selected || pending || overRegion === 'on'}
          label={label}
          className={cx(!seg.url && 'border border-dashed border-white/[0.13]')}
          draggable
          onDragStart={(event) => { endPress(); onDragStartCard(seg, event); }}
          onDragEnd={onDragEndCard}
          onDragOver={(event) => onDragOverCard(seg, event)}
          onDragLeave={(event) => onDragLeaveCard(seg, event)}
          onDrop={(event) => onDropCard(seg, event)}
          onClick={() => {
            if (heldRef.current) { heldRef.current = false; return; }
            onSelect(seg);
          }}
          onContextMenu={(event) => { event.preventDefault(); endPress(); onMenu(seg, holderRef.current); }}
          onPointerDown={startPress}
          onPointerUp={endPress}
          onPointerLeave={endPress}
          onPointerCancel={endPress}
        >
          {seg.url ? <SegmentFace url={seg.url} /> : null}
          {/* An empty slot is "write the next shot", so it says which shot it
              is waiting for — and swaps the clapper for a spinner while this
              exact slot is the one being generated into. */}
          {!seg.url ? (
            <span className={cx('absolute inset-0 grid place-items-center', pending && 'bg-bg1')}>
              {pending
                ? <Spinner size={12} className="text-honey" />
                : <Icon name="clapper" size={12} className="text-ink3" />}
            </span>
          ) : null}
          <span
            className={cx(
              'pointer-events-none absolute bottom-1 left-1.5 font-mono text-[9px]',
              selected || pending ? 'text-honey' : 'text-inkSoft',
            )}
          >
            {pending
              ? `${shotNumber(index)} · ${pctOf(progress)}%`
              : shotCaption(index, seconds)}
          </span>
          {pending ? <CardProgress value={progress} /> : null}
          {/* A clip drag hovering an EMPTY slot fills it — the honey wash says
              so before the drop, the way the 132px card's tinted face did. */}
          {fillHover ? (
            <span className="pointer-events-none absolute inset-0 bg-honey-tint/40" />
          ) : null}
          {/* Two states a caption cannot carry: a clip drag hovering the middle
              of a FILLED card (which asks to replace it, behind a confirm the
              studio owns), and a shot the full cut is not using. Both were words
              across the bottom of a 132px card; at 72px they are a mark in a
              corner. Top-LEFT: the "…" door owns the other one and would cover
              them the moment a pointer came near the card. */}
          {replaceHover ? (
            <span className="pointer-events-none absolute left-1 top-1 grid h-[14px] w-[14px] place-items-center rounded-full bg-honey text-on-honey">
              <Icon name="refresh" size={9} />
            </span>
          ) : null}
          {seg.excluded ? (
            <span className="pointer-events-none absolute left-1 top-1 grid h-[14px] w-[14px] place-items-center rounded-full bg-bg0/85 text-ink2">
              <Icon name="minus" size={9} />
            </span>
          ) : null}
        </RailCard>
        {/* The menu's visible door. A nested <button> inside RailCard's button
            would be invalid, so it is a sibling floated over the card's corner.
            Kept mounted (not hover-gated in the DOM) so it is tabbable — the
            old hover overlay used group-focus-within for exactly that reason. */}
        <button
          type="button"
          title="Shot actions"
          aria-label={`Shot actions — ${label}`}
          aria-haspopup="menu"
          onClick={() => onMenu(seg, holderRef.current)}
          className={cx(
            'absolute right-0.5 top-0.5 grid h-[18px] w-[18px] place-items-center rounded-full bg-bg0/80 text-ink1',
            'opacity-0 transition-opacity duration-150 hover:bg-bg1 focus-visible:opacity-100',
            'group-focus-within:opacity-100 group-hover:opacity-100',
          )}
        >
          <Icon name="more" size={11} />
        </button>
      </div>
      <InsertBar active={overRegion === 'after'} />
    </>
  );
});

/**
 * One loose clip under EARLIER. Same card, no drop target and no shot number:
 * it is not in the cut, so it has no place in it to point at.
 */
const EarlierCard = memo(function EarlierCard({ entry, selected, label, onOpen, onMenu }) {
  const holderRef = useRef(null);
  const timerRef = useRef(0);
  const heldRef = useRef(false);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  useEffect(() => {
    if (selected) scrollCardIntoView(holderRef.current);
  }, [selected]);

  const endPress = () => clearTimeout(timerRef.current);
  const startPress = (event) => {
    if (event.button !== 0) return;
    heldRef.current = false;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      heldRef.current = true;
      onMenu(entry, holderRef.current);
    }, LONG_PRESS_MS);
  };

  return (
    <div ref={holderRef} className="group relative shrink-0">
      <RailCard
        width={CARD_W}
        aspect={CARD_ASPECT}
        selected={selected}
        label={label}
        draggable
        // Every tile is draggable, which is how a clip reaches the sequence,
        // the references or the composer. effectAllowed stays 'copy': a loose
        // clip is never MOVED out of History.
        onDragStart={(event) => {
          endPress();
          writeOutputDrag(event, entry.url);
          try { event.dataTransfer.effectAllowed = 'copy'; } catch { /* non-critical */ }
        }}
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
        <SegmentFace url={entry.url} />
      </RailCard>
      <button
        type="button"
        title="Clip actions"
        aria-label={`Clip actions — ${label}`}
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
 * The shell every card's actions open into.
 *
 * Portaled to <body> and fixed-positioned rather than anchored inside the card:
 * the frame's rail is overflow-y-auto, and a popover rendered inside it is
 * clipped at the 108px edge and scrolls away with the column. Coordinates are
 * measured after mount, placed to the LEFT of the rail, and clamped to the
 * viewport — the same idiom kit.jsx's HintBubble uses.
 */
function RailMenu({ anchor, label, onClose, children }) {
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
      className="hive-scale-in z-[90] w-60 rounded-lg border border-line1 bg-bg1 p-1.5 shadow-pop"
    >
      {children}
    </div>,
    document.body,
  );
}

/** The prompt-and-model header a 72px card cannot carry. */
function MenuSubject({ text, model }) {
  return (
    <div className="px-2.5 pb-2 pt-1">
      <p className="line-clamp-2 text-[12px] leading-snug text-ink2">{text || '—'}</p>
      {model ? <p className="truncate font-mono text-[10px] text-ink3">{model}</p> : null}
    </div>
  );
}

/**
 * VideoRail — the Video studio's `rail` slot for StudioFrame (railWidth 108).
 *
 * The frame owns the column itself (the scrolling aside, its gap and padding),
 * so this returns the column's contents: SEQUENCE, the "+", a divider, EARLIER,
 * and the overflow into the Library.
 *
 * @param {array}  segments        s.timelineSegments
 * @param {string} selectedId      s.timelineSelectedId
 * @param {bool}   showCombined    s.timelineShowCombined — the joined cut is on the
 *                                 player, so NO shot is the selected one
 * @param {string} pendingSegmentId the slot being rendered into, '' when none
 * @param {bool}   timelineOn      s.timelineOn — false means the scene is closed and
 *                                 the "+" opens it rather than appending to it
 * @param {bool}   generating      s.generating
 * @param {number} progress        0..1, the smoothed bar the stage reads
 * @param {func}   secondsFor      (seg) => number — the caption's "· 5s"; optional
 * @param {func}   promptFor       (seg) => string — never a private prompt
 * @param {func}   onSelect        (seg) => …  timelineSelect
 * @param {func}   onAdd           () => …     timelineAdd
 * @param {func}   onOpenTimeline  () => …     openTimelineView (the old Scene chip)
 * @param {func}   onRemove        (seg) => …  timelineRemoveRequest
 * @param {func}   onDrop          ({id, region}, dataTransfer) => …  timelineHandleDrop
 * @param {func}   onExportSegment (seg) => …  optional
 * @param {func}   onToggleExcluded (seg) => … optional
 * @param {func}   onOpenSceneTools () => …    opens the full TimelineStrip; optional
 * @param {array}  history         s.generationHistory, newest first
 * @param {string} resultUrl       s.resultUrl — which loose clip is on the player
 * @param {func}   onOpenHistory   (entry) => …  openHistoryEntry
 * @param {func}   onDownloadHistory (entry) => …  keyed on entry.id, never the index
 * @param {func}   onRemoveHistory (entry) => …  opens the Delete video confirm
 * @param {func}   onContinueHistory (entry) => …  continueSceneFrom
 * @param {func}   canContinue     (entry) => bool — chainCapableEntryFor(entry.model)
 * @param {number} limit           EARLIER cards before the "+N" collapse
 * @param {func}   onOpenLibrary   optional; defaults to the navigate event
 */
export function VideoRail({
  segments = [],
  selectedId = '',
  showCombined = false,
  pendingSegmentId = '',
  timelineOn = false,
  generating = false,
  progress = 0,
  secondsFor,
  promptFor,
  onSelect,
  onAdd,
  onOpenTimeline,
  onRemove,
  onDrop,
  onExportSegment,
  onToggleExcluded,
  onOpenSceneTools,
  history = [],
  resultUrl = '',
  onOpenHistory,
  onDownloadHistory,
  onRemoveHistory,
  onContinueHistory,
  canContinue,
  limit = EARLIER_LIMIT,
  onOpenLibrary,
}) {
  // Transient drag paint state, exactly as the horizontal strip kept it: which
  // target the pointer is over, and which card is being dragged (dimmed).
  const [over, setOver] = useState(null); // { id, region } | { id: '', region: 'end' }
  const [draggingId, setDraggingId] = useState('');
  // Suppress the click that follows a completed drag (CastStrip idiom).
  const dragHappenedRef = useRef(false);
  // { kind: 'segment'|'clip', item, anchor } — ONE menu for the whole rail, not
  // one per card: a menu per card would give every card a piece of state and
  // break the memo above.
  const [menu, setMenu] = useState(null);

  const closeMenu = useCallback(() => setMenu(null), []);
  const openSegmentMenu = useCallback((seg, anchor) => {
    setMenu((prev) => (prev && prev.item === seg && prev.anchor === anchor
      ? null
      : { kind: 'segment', item: seg, anchor }));
  }, []);
  const openClipMenu = useCallback((entry, anchor) => {
    setMenu((prev) => (prev && prev.item === entry && prev.anchor === anchor
      ? null
      : { kind: 'clip', item: entry, anchor }));
  }, []);

  const onDragStartCard = useCallback((seg, event) => {
    dragHappenedRef.current = true;
    setDraggingId(seg.id);
    try {
      event.dataTransfer.setData(TIMELINE_SEGMENT_DRAG_TYPE, JSON.stringify({ id: seg.id }));
      // A filled card is also one of our outputs, so it can leave the rail and
      // land in the composer or the references like any loose clip.
      if (seg.url) writeOutputDrag(event, seg.url);
      event.dataTransfer.effectAllowed = 'copyMove';
    } catch { /* non-critical */ }
  }, []);

  const onDragEndCard = useCallback(() => {
    setDraggingId('');
    setOver(null);
    // The click event fires after dragend; clear the flag a beat later.
    setTimeout(() => { dragHappenedRef.current = false; }, 0);
  }, []);

  const handleDragOver = useCallback((target, event) => {
    if (!dragIsDroppable(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const snapped = resolveRegion(target, event);
    setOver((prev) => (prev && prev.id === target.id && prev.region === snapped
      ? prev
      : { id: target.id, region: snapped }));
    event.dataTransfer.dropEffect = dragIsSegment(event.dataTransfer) ? 'move' : 'copy';
  }, []);

  const handleDragLeave = useCallback((target, event) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setOver((current) => (current && current.id === target.id ? null : current));
  }, []);

  const handleDrop = useCallback((target, event) => {
    if (!dragIsDroppable(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const snapped = resolveRegion(target, event);
    setOver(null);
    onDrop?.({ id: target.id || '', region: snapped }, event.dataTransfer);
  }, [onDrop]);

  const onDragOverCard = useCallback((seg, event) => handleDragOver({ id: seg.id, region: 'card' }, event), [handleDragOver]);
  const onDragLeaveCard = useCallback((seg, event) => handleDragLeave({ id: seg.id, region: 'card' }, event), [handleDragLeave]);
  const onDropCard = useCallback((seg, event) => handleDrop({ id: seg.id, region: 'card' }, event), [handleDrop]);

  const selectSegment = useCallback((seg) => {
    if (dragHappenedRef.current) return;
    onSelect?.(seg);
  }, [onSelect]);

  const filled = segments.filter((seg) => seg.url).length;
  // EARLIER is what is NOT in the cut: a clip already standing in the sequence
  // would otherwise appear twice in one column, once numbered and once loose.
  const sequenceUrls = new Set(segments.map((seg) => seg.url).filter(Boolean));
  const loose = history.filter((entry) => entry?.url && !sequenceUrls.has(entry.url));
  const shownLoose = loose.slice(0, Math.max(limit, 0));
  const hiddenLoose = loose.length - shownLoose.length;

  const openLibrary = () => {
    if (onOpenLibrary) { onOpenLibrary(); return; }
    // The same exit the canvas's empty state used — one of the app's four
    // outbound navigate dispatches.
    try {
      window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'history' } }));
    } catch { /* no window */ }
  };

  // While the scene is closed there are no slots to render into, so a run in
  // flight still needs a seat in the column — otherwise the rail reads "nothing
  // yet" while the stage is at 40%. aria-hidden: StageProgress announces it.
  const looseRender = generating && !pendingSegmentId;

  const menuSegment = menu?.kind === 'segment' ? menu.item : null;
  const menuClip = menu?.kind === 'clip' ? menu.item : null;

  return (
    <>
      <RailHeading>
        Sequence
        {filled ? <span className="ml-1 tracking-normal text-ink3">{filled}</span> : null}
      </RailHeading>

      {/* data-upload-picker is a wire contract: the window-level restore zone
          (OutputRestoreDropZone) skips anything inside it, so a clip dropped on
          the sequence is placed by timelineDropPlan instead of being restored
          as a past run. `contents` keeps the cards as flex items of the frame's
          own column, so the 8px rhythm the design draws is unbroken. */}
      <div className="contents" data-upload-picker="">
        {segments.map((seg, index) => {
          const pending = Boolean(pendingSegmentId) && pendingSegmentId === seg.id;
          return (
            <SequenceCard
              key={seg.id}
              seg={seg}
              index={index}
              seconds={secondsFor ? secondsFor(seg) : 0}
              // The joined cut on the player is not any one shot, so nothing is
              // ringed while it is showing.
              selected={selectedId === seg.id && !showCombined}
              pending={pending}
              // Only the slot being rendered into reads the ticking bar. Handed
              // to every card it would defeat the memo above on every tick.
              progress={pending ? progress : 0}
              overRegion={over && over.id === seg.id ? over.region : ''}
              dragging={draggingId === seg.id}
              label={seg.url
                ? `Shot ${index + 1} — ${promptFor?.(seg) || seg.model || 'clip'}`
                : `Shot ${index + 1} — empty segment, the next generated clip lands here`}
              onSelect={selectSegment}
              onMenu={openSegmentMenu}
              onDragStartCard={onDragStartCard}
              onDragEndCard={onDragEndCard}
              onDragOverCard={onDragOverCard}
              onDragLeaveCard={onDragLeaveCard}
              onDropCard={onDropCard}
            />
          );
        })}

        {looseRender ? (
          <span
            aria-hidden="true"
            title={t('common.generating')}
            className="relative grid shrink-0 place-items-center overflow-hidden rounded-[8px] bg-bg1 shadow-[0_0_0_1.5px_rgb(var(--honey-rgb))]"
            style={{ width: CARD_W, aspectRatio: CARD_ASPECT }}
          >
            <Spinner size={12} className="text-honey" />
            <span className="absolute bottom-1 left-1.5 font-mono text-[9px] text-honey">
              {`${pctOf(progress)}%`}
            </span>
            <CardProgress value={progress} />
          </span>
        ) : null}

        {!segments.length && !history.length && !generating ? (
          <RailEmpty>Nothing yet</RailEmpty>
        ) : null}

        {/* The append target as well as the button: a clip dropped here is
            added to the end. While the scene is closed this is where the old
            right-aligned "Scene" chip went — one door, two jobs, so a sequence
            can still only be opened one way. */}
        <InsertBar active={over?.region === 'end'} />
        <div
          className="shrink-0"
          onDragOver={(event) => handleDragOver({ id: '', region: 'end' }, event)}
          onDragLeave={(event) => handleDragLeave({ id: '', region: 'end' }, event)}
          onDrop={(event) => handleDrop({ id: '', region: 'end' }, event)}
        >
          <RailAdd
            width={CARD_W}
            aspect={CARD_ASPECT}
            label={timelineOn
              ? 'Add the next shot — or drop a clip here'
              : 'Arrange clips into one scene: generate shot by shot, drag clips in, preview the full cut'}
            onClick={() => {
              if (dragHappenedRef.current) return;
              if (timelineOn) onAdd?.();
              else onOpenTimeline?.();
            }}
          />
        </div>
      </div>

      {shownLoose.length ? (
        <>
          <RailDivider />
          <RailHeading>Earlier</RailHeading>
          {shownLoose.map((entry, idx) => (
            <EarlierCard
              key={entry.id || `${entry.url}-${idx}`}
              entry={entry}
              // Unchanged from the History grid: the clip on the player when
              // one is showing, otherwise the newest.
              selected={resultUrl ? resultUrl === entry.url : idx === 0}
              label={entry.prompt_private
                ? `Private prompt (hidden) · ${entry.model || ''}`
                : `${entry.prompt || 'Generated clip'}${entry.model ? ` · ${entry.model}` : ''}`}
              onOpen={onOpenHistory}
              onMenu={openClipMenu}
            />
          ))}
          {/* Renders nothing at 0. Everything it hides is still in the Library,
              which is where this leads. */}
          <RailOverflow
            count={hiddenLoose}
            width={CARD_W}
            onClick={openLibrary}
            label="Show every clip in the Library"
          />
        </>
      ) : null}

      {menuSegment ? (
        <RailMenu anchor={menu.anchor} label="Shot actions" onClose={closeMenu}>
          <MenuSubject
            text={promptFor?.(menuSegment) || ''}
            model={menuSegment.model || ''}
          />
          {menuSegment.url && onExportSegment ? (
            <MenuItem
              icon="download"
              onClick={() => { closeMenu(); onExportSegment(menuSegment); }}
            >
              Export this shot
            </MenuItem>
          ) : null}
          {menuSegment.url && onToggleExcluded ? (
            // Non-destructive sibling of Remove: the card stays in the scene and
            // the file is untouched, it just stops feeding the full cut.
            <MenuItem
              icon={menuSegment.excluded ? 'plus' : 'minus'}
              onClick={() => { closeMenu(); onToggleExcluded(menuSegment); }}
            >
              {menuSegment.excluded ? 'Put back in the cut' : 'Drop from the cut — the clip is kept'}
            </MenuItem>
          ) : null}
          {/* An EMPTY slot goes immediately; a filled one opens the confirm that
              owns the delete-the-file toggle. Both are timelineRemoveRequest. */}
          <MenuItem
            icon="x"
            onClick={() => { closeMenu(); onRemove?.(menuSegment); }}
          >
            Remove this segment
          </MenuItem>
          {onOpenSceneTools ? (
            // Where the rest of the strip lives: Auto-continue, Shot | Full cut,
            // export the cut, and close the scene — the operations a 72px card
            // cannot express, still one press from the card they act on.
            <MenuItem
              icon="layers"
              onClick={() => { closeMenu(); onOpenSceneTools(); }}
            >
              Scene tools…
            </MenuItem>
          ) : null}
        </RailMenu>
      ) : null}

      {menuClip ? (
        <RailMenu anchor={menu.anchor} label="Clip actions" onClose={closeMenu}>
          {/* Where the tile's hover gradient went. A prompt marked private is
              never printed here either. */}
          <MenuSubject
            text={menuClip.prompt_private ? 'Private prompt (hidden)' : (menuClip.prompt || '')}
            model={menuClip.model || ''}
          />
          <MenuItem icon="play" onClick={() => { closeMenu(); onOpenHistory?.(menuClip); }}>
            Put on the player
          </MenuItem>
          {canContinue?.(menuClip) && onContinueHistory ? (
            <MenuItem icon="arrowRight" onClick={() => { closeMenu(); onContinueHistory(menuClip); }}>
              Continue scene from this clip
            </MenuItem>
          ) : null}
          <MenuItem icon="download" onClick={() => { closeMenu(); onDownloadHistory?.(menuClip); }}>
            {t('common.download')}
          </MenuItem>
          <MenuItem
            icon="trash"
            className="text-danger hover:text-danger"
            onClick={() => { closeMenu(); onRemoveHistory?.(menuClip); }}
          >
            Remove from the strip
          </MenuItem>
        </RailMenu>
      ) : null}
    </>
  );
}
