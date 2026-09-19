// "Circle a spot" — drag a circle on a location picture to choose where the
// clip happens.
//
// The whole control is one gesture: press on the picture and drag. What comes
// back is a normalized ellipse (lib/sceneSpot.js), and the studio burns it into
// a copy of the picture that becomes the reference actually sent — because a
// mark in the pixels is the only way to point at part of a reference H3 takes
// no coordinates for.
//
// Two things are shown alongside the picture rather than hidden behind a
// tooltip, because both change what the model is told: the colour of the ring
// (named in the prompt, so it can never disagree with what was drawn) and
// whether the picture is a map (which decides whether the clip is told to
// translate it into a ground-level scene). The sentence the prompt will get is
// printed under them, live — the same principle as the region boxes, where the
// control is legible instead of magic.
import { useEffect, useRef, useState } from 'react';
import { useMediaSrc } from '../../hooks/hooks.js';
import {
  MIN_SPOT,
  SPOT_COLORS,
  SPOT_VIEWS,
  normalizeSpot,
  spotColor,
  spotDefinitionSentence,
} from '../../lib/sceneSpot.js';
import { Modal } from '../../ui/Modal.jsx';
import { Button, FailureCallout, Spinner, cx } from '../../ui/kit.jsx';

const clamp01 = (value) => Math.min(1, Math.max(0, value));

// Below this a drag was a click. A click still means "circle here" — an
// accidental tap that cleared the circle would be the worse failure — so it
// drops a default-sized ring centred on the point instead of a sliver.
const CLICK_SLOP = 0.03;
const TAP_SIZE = 0.26;

/** A handle-sized square at a corner of the box, for resizing. */
function ResizeHandle({ onPointerDown }) {
  return (
    <span
      onPointerDown={onPointerDown}
      // 12.25px of dot, with a 16px invisible skirt on every side so a thumb can
      // find it. The skirt is a pseudo-element rather than a padded parent on
      // purpose: the pointer handler and `touch-action: none` stay on the one
      // element, so the drag cannot be stolen by the page's own scroll.
      className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-full border-2 border-bg0 bg-honey shadow after:absolute after:-inset-4 after:content-['']"
      style={{ touchAction: 'none' }}
    />
  );
}

export function SpotCircleDialog({ url, label = '', spot: initial = null, busy = false, onClose, onSubmit }) {
  const src = useMediaSrc(url);
  const frameRef = useRef(null);
  const dragRef = useRef(null);
  const [spot, setSpot] = useState(() => normalizeSpot(initial) || null);
  const [color, setColor] = useState(() => spotColor(initial?.color).id);
  const [view, setView] = useState(() => (initial?.view === 'map' ? 'map' : 'photo'));
  // A reference whose bytes are gone (deleted at the source, or a vault that
  // cannot open it). Without this the frame collapses to the alt text's line
  // height and the picture is still DRAWABLE — a circle placed on a strip of
  // nothing, which would be burned into whatever the upload returned.
  const [broken, setBroken] = useState(false);

  // A picture swapped under the dialog (it never is today, but the dialog is
  // mounted from a list) must not keep the previous picture's circle.
  useEffect(() => { setSpot(normalizeSpot(initial) || null); setBroken(false); }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  const pointOf = (event) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect?.height) return { x: 0, y: 0 };
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  // The live box lives on the ref as well as in state: state paints it, the ref
  // is what pointerup reads. A tap fast enough to batch pointerdown and
  // pointerup into one render would otherwise commit a box that had not been
  // set yet — the same trap the region editor hit.
  const begin = (mode) => (event) => {
    if (busy) return;
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* non-critical */ }
    const origin = pointOf(event);
    dragRef.current = { mode, origin, box: mode === 'draw' ? { ...origin, w: 0, h: 0 } : { ...spot } };
    if (mode === 'draw') setSpot({ ...origin, w: 0, h: 0 });
  };

  const onPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = pointOf(event);
    if (drag.mode === 'draw') {
      drag.box = {
        x: Math.min(drag.origin.x, point.x),
        y: Math.min(drag.origin.y, point.y),
        w: Math.abs(point.x - drag.origin.x),
        h: Math.abs(point.y - drag.origin.y),
      };
    } else if (drag.mode === 'move') {
      drag.box = {
        ...drag.box,
        x: clamp01(Math.min(drag.box.x + (point.x - drag.origin.x), 1 - drag.box.w)),
        y: clamp01(Math.min(drag.box.y + (point.y - drag.origin.y), 1 - drag.box.h)),
      };
      drag.origin = point;
    } else {
      drag.box = {
        ...drag.box,
        w: clamp01(Math.max(MIN_SPOT, point.x - drag.box.x)),
        h: clamp01(Math.max(MIN_SPOT, point.y - drag.box.y)),
      };
    }
    setSpot({ ...drag.box });
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    let box = drag.box;
    // A tap, not a drag: put a ring of a usable size where the finger landed
    // rather than a two-pixel smear nobody meant.
    if (drag.mode === 'draw' && box.w < CLICK_SLOP && box.h < CLICK_SLOP) {
      box = {
        x: clamp01(drag.origin.x - TAP_SIZE / 2),
        y: clamp01(drag.origin.y - TAP_SIZE / 2),
        w: TAP_SIZE,
        h: TAP_SIZE,
      };
    }
    setSpot(normalizeSpot({ ...box, color, view }) || null);
  };

  // The spot as it would be SAVED: the drawn box plus the two choices below it,
  // and the un-circled picture it came from. Null while what is drawn is too
  // small to be a place, which is what disables the press.
  const armed = spot && !broken ? normalizeSpot({ ...spot, color, view, source: url }) : null;
  // What the prompt will actually say, in the words it will say it — the
  // definition's first sentence is the one that carries the instruction.
  const sentence = armed && label
    ? spotDefinitionSentence({ labels: [label], spot: armed })
    : '';

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title="Circle a spot"
      size="xl"
      dismissable={!busy}
      // Words, not icons: a dialog's actions are decisions, and on a fine
      // pointer ActionButton collapses to its icon (`.hive-hint-label`), which
      // left Cancel and Clear as two unlabelled grey squares.
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="neutral" onClick={() => setSpot(null)} disabled={busy || !spot}>Clear</Button>
          <Button variant="primary" loading={busy} disabled={busy || !armed} onClick={() => onSubmit(armed)}>
            {busy ? 'Drawing it in…' : 'Use this spot'}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-ink3">
          Drag a circle around the part of this picture where the clip should happen. The circle is drawn into
          the copy that gets sent, and the prompt is told it marks the location and must never appear in the video.
        </p>

        {broken ? (
          <FailureCallout
            title="That picture could not be opened"
            detail="Its file is missing, or the vault could not decrypt it. Remove the scene reference and attach the picture again — a circle can only be drawn on a picture you can see."
          />
        ) : null}

        <div className={cx('grid place-items-center overflow-hidden rounded-lg border border-line1 bg-bg0', broken && 'hidden')}>
          <div
            ref={frameRef}
            className={cx('relative select-none', busy ? 'cursor-wait' : 'cursor-crosshair')}
            style={{ touchAction: 'none' }}
            onPointerDown={begin('draw')}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {src ? (
              <img
                src={src}
                alt={label ? `Scene reference ${label}` : 'Scene reference'}
                draggable={false}
                onError={() => setBroken(true)}
                // dvh: this picture sits inside a sheet already capped in dvh,
                // and `vh` is iOS's larger viewport — 48vh of it overflowed.
                className="block max-h-[48dvh] w-auto max-w-full select-none object-contain"
              />
            ) : (
              <div className="grid h-[38dvh] w-[38dvh] place-items-center text-ink3">
                <Spinner size={18} label="Decrypting" />
              </div>
            )}
            {spot ? (
              <span
                onPointerDown={begin('move')}
                className="absolute cursor-move rounded-[50%] border-[3px]"
                style={{
                  left: `${spot.x * 100}%`,
                  top: `${spot.y * 100}%`,
                  width: `${spot.w * 100}%`,
                  height: `${spot.h * 100}%`,
                  borderColor: spotColor(color).hex,
                  touchAction: 'none',
                }}
              >
                {!busy ? <ResizeHandle onPointerDown={begin('resize')} /> : null}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">Circle</span>
            {SPOT_COLORS.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={busy}
                aria-pressed={color === option.id}
                aria-label={option.label()}
                title={option.id === 'red'
                  ? 'Red — the mark to reach for first, and the one almost nothing in a photo already is'
                  : `${option.label()} — for a picture that is already red`}
                onClick={() => setColor(option.id)}
                className={cx(
                  'h-5 w-5 rounded-full border-2 transition-transform disabled:opacity-50',
                  color === option.id ? 'scale-110 border-ink1' : 'border-line1 hover:scale-105',
                )}
                style={{ backgroundColor: option.hex }}
              />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">This picture is</span>
            {SPOT_VIEWS.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={busy}
                aria-pressed={view === option.id}
                title={option.hint()}
                onClick={() => setView(option.id)}
                className={cx(
                  'rounded px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-50',
                  view === option.id ? 'bg-honey-tint text-honey' : 'text-ink3 hover:bg-bg3 hover:text-ink2',
                )}
              >
                {option.label()}
              </button>
            ))}
          </div>
        </div>

        {/* The exact words the circle contributes. It is the part that does the
            work — the ring alone is just something in a photograph. */}
        <div className="rounded-lg border border-line1 bg-bg1 p-2.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">
            {sentence ? 'What the prompt will be told' : 'Nothing circled yet'}
          </span>
          <p className="mt-1 text-[11px] leading-relaxed text-ink2">
            {sentence || (broken
              ? 'With the picture unreadable there is nothing to circle — and nothing to tell the model about.'
              : 'Drag a circle on the picture above — or tap it to drop one — and this is where you will see what it tells the model.')}
          </p>
        </div>
      </div>
    </Modal>
  );
}
