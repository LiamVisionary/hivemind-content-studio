// Region boxes: drag out an area of the frame, say what belongs there, and the
// composer turns the box into placement language (see lib/regionPrompt.js).
//
// The box is the input device, not the payload — nothing here is sent to a
// node. Each row shows the exact phrase its box will contribute, so the control
// is legible instead of magic.
//
// Region text is prompt content, so like couple mode's character fields it
// lives in session state only and never reaches localStorage.
//
// Region editor concept adapted from Mix-Studio (BlackMixture/Mix-Studio,
// GPL-3.0) — their canvas is a node-UI editor; this is our own React control
// over the same normalized region model. See THIRD_PARTY_NOTICES.md.
import { useRef, useState } from 'react';

import { MAX_REGIONS, MIN_REGION_SIZE, REGION_COLORS, positionPhrase } from '../../lib/regionPrompt.js';
import { Button, IconButton, TextInput, cx } from '../../ui/kit.jsx';

const clamp01 = (value) => Math.min(1, Math.max(0, value));

// Below this a drag was a click, and a click means "put a box here" rather than
// "make a two-pixel sliver".
const CLICK_SLOP = 0.02;
const DEFAULT_W = 0.28;
const DEFAULT_H = 0.42;

export function RegionBoxEditor({ regions, onChange, aspect = 1, disabled = false }) {
  const frameRef = useRef(null);
  const dragRef = useRef(null);
  const idRef = useRef(1);
  const [draft, setDraft] = useState(null);
  // The box being moved or resized right now: local to this editor, so a drag
  // repaints the boxes and nothing else. `onChange` — which re-renders the whole
  // studio through its `bump()` — is called once, on pointer-up.
  const [live, setLive] = useState(null); // { id, x, y, w, h }
  const [selectedId, setSelectedId] = useState(null);

  const atCap = regions.length >= MAX_REGIONS;

  const pointOf = (event) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect?.height) return { x: 0, y: 0 };
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  const patch = (id, next) => onChange(regions.map((r) => (r.id === id ? { ...r, ...next } : r)));

  const startDraw = (event) => {
    if (disabled || atCap || event.button === 2) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const origin = pointOf(event);
    // The box lives on the ref as well as in state: state is for painting the
    // dashed preview, the ref is what pointerup reads. A tap fast enough to
    // land pointerdown and pointerup in one React batch would otherwise commit
    // a draft that had not been set yet, and silently create nothing.
    dragRef.current = { mode: 'draw', origin, box: { ...origin, w: 0, h: 0 } };
    setDraft({ ...origin, w: 0, h: 0 });
    setSelectedId(null);
  };

  const startMove = (event, region) => {
    if (disabled) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const origin = pointOf(event);
    dragRef.current = { mode: 'move', id: region.id, origin, box: { ...region } };
    setSelectedId(region.id);
  };

  const startResize = (event, region) => {
    if (disabled) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { mode: 'resize', id: region.id, origin: pointOf(event), box: { ...region } };
    setSelectedId(region.id);
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
      setDraft(drag.box);
      return;
    }
    const dx = point.x - drag.origin.x;
    const dy = point.y - drag.origin.y;
    const next = drag.mode === 'move'
      ? {
        x: clamp01(Math.min(drag.box.x + dx, 1 - drag.box.w)),
        y: clamp01(Math.min(drag.box.y + dy, 1 - drag.box.h)),
      }
      : {
        w: Math.min(1 - drag.box.x, Math.max(MIN_REGION_SIZE, drag.box.w + dx)),
        h: Math.min(1 - drag.box.y, Math.max(MIN_REGION_SIZE, drag.box.h + dy)),
      };
    // Held on the ref as well as in state, for the same reason `draw` is: the
    // ref is what pointer-up commits, and a drag fast enough to batch with the
    // release would otherwise commit a box that had not been set yet.
    drag.next = next;
    setLive({ id: drag.id, ...next });
  };

  const endDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.mode !== 'draw') {
      setLive(null);
      // One commit for the whole gesture, not one per pointer-move.
      if (drag.next) patch(drag.id, drag.next);
      return;
    }
    const box = drag.box;
    setDraft(null);
    if (!box) return;
    // A click drops a default box centered where you clicked; a real drag keeps
    // what you drew.
    const drawn = box.w > CLICK_SLOP || box.h > CLICK_SLOP;
    const w = drawn ? Math.max(MIN_REGION_SIZE, box.w) : DEFAULT_W;
    const h = drawn ? Math.max(MIN_REGION_SIZE, box.h) : DEFAULT_H;
    const x = drawn ? box.x : clamp01(Math.min(drag.origin.x - w / 2, 1 - w));
    const y = drawn ? box.y : clamp01(Math.min(drag.origin.y - h / 2, 1 - h));
    const id = `region-${idRef.current}`;
    idRef.current += 1;
    onChange([...regions, {
      id,
      description: '',
      x: clamp01(x),
      y: clamp01(y),
      w: Math.min(w, 1 - clamp01(x)),
      h: Math.min(h, 1 - clamp01(y)),
      color: REGION_COLORS[regions.length % REGION_COLORS.length],
    }]);
    setSelectedId(id);
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div
        ref={frameRef}
        onPointerDown={startDraw}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{ aspectRatio: String(aspect || 1) }}
        className={cx(
          'relative w-full select-none overflow-hidden rounded-lg border border-line1 bg-bg2',
          'bg-[linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.05)_1px,transparent_1px)]',
          'bg-[length:33.333%_33.333%]',
          disabled ? 'opacity-50' : atCap ? 'cursor-not-allowed' : 'cursor-crosshair',
        )}
      >
        {regions.map((region0, index) => {
          // Mid-drag the live box wins; everything else still reads the region.
          const region = live && live.id === region0.id ? { ...region0, ...live } : region0;
          return (
          <div
            key={region.id}
            onPointerDown={(event) => startMove(event, region)}
            style={{
              left: `${region.x * 100}%`,
              top: `${region.y * 100}%`,
              width: `${region.w * 100}%`,
              height: `${region.h * 100}%`,
              borderColor: region.color,
              backgroundColor: `${region.color}22`,
            }}
            className={cx(
              'absolute rounded border-2 touch-none',
              disabled ? '' : 'cursor-move',
              selectedId === region.id ? 'ring-2 ring-white/40' : '',
            )}
          >
            <span
              className="absolute -top-px left-0 rounded-br rounded-tl px-1 text-[10px] font-semibold text-black"
              style={{ backgroundColor: region.color }}
            >
              {index + 1}
            </span>
            <span
              onPointerDown={(event) => startResize(event, region)}
              className={cx(
                'absolute -bottom-1 -right-1 h-3 w-3 rounded-sm border border-black/40 touch-none',
                disabled ? '' : 'cursor-nwse-resize',
              )}
              style={{ backgroundColor: region.color }}
            />
          </div>
          );
        })}
        {draft ? (
          <div
            style={{
              left: `${draft.x * 100}%`,
              top: `${draft.y * 100}%`,
              width: `${draft.w * 100}%`,
              height: `${draft.h * 100}%`,
            }}
            className="pointer-events-none absolute rounded border-2 border-dashed border-white/70 bg-white/10"
          />
        ) : null}
        {!regions.length && !draft ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-ink3">
            Drag out an area — or just click — to place a region.
          </div>
        ) : null}
      </div>

      {regions.length ? (
        <div className="flex flex-col gap-2">
          {regions.map((region, index) => (
            <div key={region.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span
                  className="h-3 w-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: region.color }}
                  aria-hidden="true"
                />
                <TextInput
                  placeholder={`Region ${index + 1} — e.g. a wolf in the snow`}
                  value={region.description}
                  disabled={disabled}
                  onFocus={() => setSelectedId(region.id)}
                  onChange={(event) => patch(region.id, { description: event.target.value })}
                />
                <IconButton
                  icon="trash"
                  size="sm"
                  label={`Remove region ${index + 1}`}
                  disabled={disabled}
                  onClick={() => onChange(regions.filter((r) => r.id !== region.id))}
                />
              </div>
              <p className="pl-5 text-[11px] leading-relaxed text-ink3">
                {region.description.trim()
                  ? `→ ${region.description.trim()}, ${positionPhrase(region)}`
                  : 'Empty regions are skipped.'}
              </p>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-ink3">
              {regions.length} of {MAX_REGIONS} regions
            </span>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => { onChange([]); setSelectedId(null); }}>
              Clear all
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
