// Before/after compare viewer — two stacked copies of the SAME transform with a
// movable reveal divider (clip-path on the "after" wrapper, so the reveal is
// independent of zoom/pan). Reveal mode drags the divider; Pan mode drags the
// image; wheel and pinch zoom anchor at the pointer. Media resolves through
// useMediaSrc (E2E decrypt), same as every other viewer.
//
// Interaction model adapted from Mix-Studio (BlackMixture/Mix-Studio, GPL-3.0)
// public/app.js compare viewer. See THIRD_PARTY_NOTICES.md.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMediaSrc } from '../../hooks/hooks.js';
import {
  WHEEL_ZOOM_IN,
  WHEEL_ZOOM_OUT,
  actualSizeZoom,
  clampPan,
  clampSplit,
  clampZoom,
  fitSize,
  zoomAroundAnchor,
} from '../../lib/compareMath.js';
import { Icon } from '../../ui/icons.jsx';
import { cx } from '../../ui/kit.jsx';

function ModeButton({ active, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'rounded-sm px-2 py-1 text-[11px] font-semibold transition-colors',
        active ? 'bg-honey text-bg0' : 'text-ink2 hover:text-ink1',
      )}
    >
      {label}
    </button>
  );
}

export function CompareViewer({ beforeUrl, afterUrl, beforeLabel = 'Original', afterLabel = 'Upscaled', onClose }) {
  const beforeSrc = useMediaSrc(beforeUrl);
  const afterSrc = useMediaSrc(afterUrl);

  const stageRef = useRef(null);
  const [stage, setStage] = useState({ width: 1, height: 1 });
  const [natural, setNatural] = useState(null); // after-image natural dims
  const [beforeNatural, setBeforeNatural] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [split, setSplit] = useState(50);
  const [mode, setMode] = useState('reveal');
  const [interacting, setInteracting] = useState(false);

  // One gesture state ref for drag + pinch (pointer events cover mouse/touch).
  const gesture = useRef({ pointers: new Map(), panStart: null, pinchStart: null });

  const fit = useMemo(
    () => (natural ? fitSize(natural.width, natural.height, stage.width, stage.height) : null),
    [natural, stage],
  );

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setStage({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const setZoomAnchored = (nextZoomRaw, anchor = { x: 0, y: 0 }) => {
    const nextZoom = clampZoom(nextZoomRaw);
    setPan((prev) => {
      if (!fit) return prev;
      const moved = zoomAroundAnchor(prev, zoom, nextZoom, anchor);
      return clampPan(moved, fit, nextZoom, stage);
    });
    setZoom(nextZoom);
  };

  const resetFit = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const goActualSize = () => {
    if (!fit || !natural) return;
    setZoomAnchored(actualSizeZoom(natural.width, fit.width));
  };

  // Anchor = pointer offset from the stage center (the transform origin).
  const anchorFromEvent = (e) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: e.clientX - rect.left - rect.width / 2,
      y: e.clientY - rect.top - rect.height / 2,
    };
  };

  const splitFromEvent = (e) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return split;
    return clampSplit(((e.clientX - rect.left) / rect.width) * 100);
  };

  const onWheel = (e) => {
    e.preventDefault();
    setZoomAnchored(zoom * (e.deltaY < 0 ? WHEEL_ZOOM_IN : WHEEL_ZOOM_OUT), anchorFromEvent(e));
  };

  const onPointerDown = (e) => {
    // Capture can throw (released/synthetic pointers); dragging still works
    // while the pointer stays over the stage, so never abort the gesture.
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* non-critical */ }
    gesture.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setInteracting(true);
    const pointers = [...gesture.current.pointers.values()];
    if (pointers.length === 2) {
      // Pinch supersedes any drag in progress.
      const [a, b] = pointers;
      gesture.current.pinchStart = {
        distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        zoom,
      };
      gesture.current.panStart = null;
    } else if (mode === 'reveal') {
      setSplit(splitFromEvent(e));
    } else {
      gesture.current.panStart = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    }
  };

  const onPointerMove = (e) => {
    const g = gesture.current;
    if (!g.pointers.has(e.pointerId)) return;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pointers = [...g.pointers.values()];
    if (g.pinchStart && pointers.length >= 2) {
      const [a, b] = pointers;
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const rect = stageRef.current?.getBoundingClientRect();
      const mid = rect
        ? { x: (a.x + b.x) / 2 - rect.left - rect.width / 2, y: (a.y + b.y) / 2 - rect.top - rect.height / 2 }
        : { x: 0, y: 0 };
      setZoomAnchored(g.pinchStart.zoom * (distance / g.pinchStart.distance), mid);
      return;
    }
    if (mode === 'reveal' && pointers.length === 1) {
      setSplit(splitFromEvent(e));
      return;
    }
    if (g.panStart && fit) {
      setPan(clampPan({ x: e.clientX - g.panStart.x, y: e.clientY - g.panStart.y }, fit, zoom, stage));
    }
  };

  const onPointerUp = (e) => {
    const g = gesture.current;
    g.pointers.delete(e.pointerId);
    if (g.pointers.size < 2) g.pinchStart = null;
    if (!g.pointers.size) {
      g.panStart = null;
      setInteracting(false);
    }
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose?.(); return; }
      if (e.key === '+' || e.key === '=') setZoomAnchored(zoom * WHEEL_ZOOM_IN);
      else if (e.key === '-') setZoomAnchored(zoom * WHEEL_ZOOM_OUT);
      else if (e.key === '0' || e.key === 'f') resetFit();
      else if (e.key === '1') goActualSize();
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        if (mode === 'reveal') setSplit((prev) => clampSplit(prev + dir * 2));
        else if (fit) setPan((prev) => clampPan({ x: prev.x - dir * 28, y: prev.y }, fit, zoom, stage));
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && mode === 'pan' && fit) {
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        setPan((prev) => clampPan({ x: prev.x, y: prev.y - dir * 28 }, fit, zoom, stage));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const transform = `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`;
  const imageLayer = (src, alt, onLoad) => (
    <div className="absolute inset-0 grid place-items-center">
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={onLoad}
        style={fit ? {
          width: `${fit.width}px`,
          height: `${fit.height}px`,
          maxWidth: 'none',
          transform,
          transition: interacting ? 'none' : 'transform 120ms ease-out',
        } : undefined}
        className="select-none"
      />
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[110] flex flex-col bg-bg0/95 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="Compare original and upscaled">
      <div className="flex shrink-0 items-center gap-2 border-b border-line1 px-4 py-2.5">
        <span className="text-sm font-semibold text-ink1">Compare</span>
        <span className="hidden font-mono text-[11px] text-ink3 sm:inline">
          {beforeNatural ? `${beforeLabel} ${beforeNatural.width}×${beforeNatural.height}` : beforeLabel}
          {' → '}
          {natural ? `${afterLabel} ${natural.width}×${natural.height}` : afterLabel}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center rounded-md border border-line1 bg-bg1 p-0.5">
            <ModeButton active={mode === 'reveal'} label="Reveal" onClick={() => setMode('reveal')} />
            <ModeButton active={mode === 'pan'} label="Pan" onClick={() => setMode('pan')} />
          </div>
          <div className="flex items-center rounded-md border border-line1 bg-bg1 p-0.5">
            <ModeButton label="−" onClick={() => setZoomAnchored(zoom * WHEEL_ZOOM_OUT)} />
            <span className="min-w-11 px-1 text-center font-mono text-[11px] text-ink2">{Math.round(zoom * 100)}%</span>
            <ModeButton label="+" onClick={() => setZoomAnchored(zoom * WHEEL_ZOOM_IN)} />
            <ModeButton label="Fit" onClick={resetFit} />
            <ModeButton label="1:1" onClick={goActualSize} />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close compare"
            className="grid h-7 w-7 place-items-center rounded-md text-ink3 transition-colors hover:bg-bg2 hover:text-ink1"
          >
            <Icon name="x" size={15} />
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className={cx('relative min-h-0 flex-1 overflow-hidden', mode === 'reveal' ? 'cursor-col-resize' : 'cursor-grab')}
        style={{ touchAction: 'none' }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => (zoom > 1 ? resetFit() : goActualSize())}
      >
        {imageLayer(beforeSrc, beforeLabel, (e) => setBeforeNatural({ width: e.target.naturalWidth, height: e.target.naturalHeight }))}
        {/* The reveal clips the AFTER wrapper — clipping the wrapper (not the img)
            keeps the divider fixed on screen while zoom/pan move the images. */}
        <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
          {imageLayer(afterSrc, afterLabel, (e) => setNatural({ width: e.target.naturalWidth, height: e.target.naturalHeight }))}
        </div>
        <div
          className="pointer-events-none absolute inset-y-0 w-px bg-honey shadow-[0_0_6px_rgba(0,0,0,0.55)]"
          style={{ left: `${split}%` }}
        >
          <span className="absolute right-2 top-2 whitespace-nowrap rounded-sm bg-bg0/80 px-1.5 py-0.5 text-[10px] font-semibold text-ink2">{beforeLabel}</span>
          <span className="absolute left-2 top-2 whitespace-nowrap rounded-sm bg-bg0/80 px-1.5 py-0.5 text-[10px] font-semibold text-honey">{afterLabel}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
