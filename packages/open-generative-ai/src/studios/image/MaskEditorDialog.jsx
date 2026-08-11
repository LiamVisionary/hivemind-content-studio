// Masked-edit ("Edit area") dialog — paint the region to change, describe the
// change, and the gateway's soft-inpaint graph regenerates only that area
// (plus a small grown collar) while compositing the rest back untouched.
//
// One canvas at the image's NATURAL resolution holds the mask as white strokes
// on transparency: displayed at 45% opacity over the image, composited onto
// black at export so the gateway's red-channel ImageToMask reads it directly.
// Brush interaction model adapted from Mix-Studio (GPL-3.0) public/app.js.
import { useEffect, useRef, useState } from 'react';
import { useMediaSrc } from '../../hooks/hooks.js';
import { Modal } from '../../ui/Modal.jsx';
import { ActionButton, cx } from '../../ui/kit.jsx';

const BRUSH_MIN = 12;
const BRUSH_MAX = 160;

export function MaskEditorDialog({ entry, busy, onClose, onSubmit }) {
  const src = useMediaSrc(entry?.url);
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const drawing = useRef(null);
  const [ready, setReady] = useState(false);
  const [hasPaint, setHasPaint] = useState(false);
  const [brush, setBrush] = useState(56);
  const [expand, setExpand] = useState(14);
  const [influence, setInfluence] = useState(78);
  const [prompt, setPrompt] = useState('');

  const sizeCanvasToImage = () => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || !img.naturalWidth) return;
    if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
    }
    setReady(true);
  };

  // Pointer position in natural-resolution canvas space.
  const canvasPoint = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const strokeTo = (point, begin) => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    // Brush size is chosen against the DISPLAYED image, so scale it up to
    // natural resolution — otherwise a large photo gets a hairline brush.
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / Math.max(1, rect.width);
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = brush * scale;
    if (begin) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, (brush * scale) / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    setHasPaint(true);
  };

  const onPointerDown = (e) => {
    if (!ready || busy) return;
    // Capture can throw (released/synthetic pointers) — losing capture only
    // means a stroke ends at the canvas edge, never worth aborting the stroke.
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* non-critical */ }
    drawing.current = e.pointerId;
    strokeTo(canvasPoint(e), true);
  };
  const onPointerMove = (e) => {
    if (drawing.current !== e.pointerId) return;
    strokeTo(canvasPoint(e), false);
  };
  const onPointerUp = (e) => {
    if (drawing.current === e.pointerId) drawing.current = null;
  };

  const clearMask = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    setHasPaint(false);
  };

  useEffect(() => { clearMask(); setReady(false); }, [src]);

  const exportMask = () => {
    const canvas = canvasRef.current;
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    return out.toDataURL('image/png');
  };

  return (
    <Modal open onClose={busy ? undefined : onClose} title="Edit area (inpaint)" size="xl" dismissable={!busy}
      footer={
        <>
          <ActionButton variant="neutral" label="Cancel" onClick={onClose} disabled={busy} />
          <ActionButton variant="neutral" label="Clear mask" onClick={clearMask} disabled={busy || !hasPaint} />
          <ActionButton
            variant="primary"
            icon="layers"
            loading={busy}
            label={busy ? 'Editing…' : 'Edit the painted area'}
            disabled={busy || !hasPaint}
            onClick={() => onSubmit({
              maskDataUrl: exportMask(),
              prompt,
              maskExpand: expand,
              maskInfluence: influence,
            })}
          />
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-ink3">
          Paint the area to change. Only that area (plus a small blending collar)
          regenerates — everything else keeps its exact pixels.
        </p>
        <div className="grid place-items-center overflow-hidden rounded-lg border border-line1 bg-bg0">
          <div className="relative">
            <img
              ref={imgRef}
              src={src}
              alt={entry?.prompt || 'Source'}
              draggable={false}
              onLoad={sizeCanvasToImage}
              className="max-h-[46vh] w-auto max-w-full select-none object-contain"
            />
            <canvas
              ref={canvasRef}
              className={cx('absolute inset-0 h-full w-full opacity-45', busy ? 'cursor-wait' : 'cursor-crosshair')}
              style={{ touchAction: 'none' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">Brush {brush}px</span>
            <input type="range" min={BRUSH_MIN} max={BRUSH_MAX} step={4} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
          </label>
          <label className="flex flex-col gap-1" title="How far the change may bleed past your strokes to blend shadows and texture">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">Blend collar {expand}px</span>
            <input type="range" min={6} max={32} step={1} value={expand} onChange={(e) => setExpand(Number(e.target.value))} />
          </label>
          <label className="flex flex-col gap-1" title="How strongly the painted area changes — 100% fully repaints it">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">Strength {influence}%</span>
            <input type="range" min={25} max={100} step={1} value={influence} onChange={(e) => setInfluence(Number(e.target.value))} />
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">What should appear there?</span>
          <textarea
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. a red leather jacket — the scene-preservation clause is added automatically"
            className="w-full resize-none rounded-md border border-line1 bg-bg0 px-2.5 py-2 text-[13px] leading-relaxed text-ink1 outline-none placeholder:text-ink3 focus:border-honey/50"
          />
        </label>
      </div>
    </Modal>
  );
}
