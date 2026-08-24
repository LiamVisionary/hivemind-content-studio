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
import { ActionButton, Button, Field, Slider, TextArea, TextInput, cx } from '../../ui/kit.jsx';

const BRUSH_MIN = 12;
const BRUSH_MAX = 160;

export function MaskEditorDialog({ entry, busy, onClose, onSubmit, onSmartSelect }) {
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
  // Smart select (SAM3): name the thing, or tap it. Taps are collected in
  // image-fraction coordinates so the gateway never needs the display size.
  const [selecting, setSelecting] = useState(false);
  const [pointMode, setPointMode] = useState(false);
  const [selectText, setSelectText] = useState('');
  const [selectError, setSelectError] = useState('');

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

  // Paint SAM3's silhouette into the same canvas the brush uses, so a smart
  // selection and hand-painted strokes are one mask and every downstream
  // control (collar, strength, the inpaint graph) works unchanged.
  const paintReturnedMask = (maskDataUrl) => new Promise((resolve, reject) => {
    const canvas = canvasRef.current;
    if (!canvas) { resolve(false); return; }
    const mask = new Image();
    mask.onload = () => {
      const ctx = canvas.getContext('2d');
      // The mask arrives white-on-black; 'lighten' keeps existing strokes and
      // adds the new region, and drops the black background on the way in.
      ctx.save();
      ctx.globalCompositeOperation = 'lighten';
      ctx.drawImage(mask, 0, 0, canvas.width, canvas.height);
      ctx.restore();
      setHasPaint(true);
      resolve(true);
    };
    mask.onerror = () => reject(new Error('Could not read the returned mask'));
    mask.src = maskDataUrl;
  });

  const runSmartSelect = async (points) => {
    if (!onSmartSelect || selecting || busy) return;
    setSelecting(true);
    setSelectError('');
    try {
      const result = await onSmartSelect({ prompt: points ? '' : selectText.trim(), points });
      if (result?.maskBase64) await paintReturnedMask(result.maskBase64);
    } catch (error) {
      setSelectError(error?.message || 'Smart select failed');
    } finally {
      setSelecting(false);
    }
  };

  const onPointerDown = (e) => {
    if (!ready || busy) return;
    if (pointMode) {
      // A tap is a selection, not a stroke: send it as a fraction of the image.
      const canvas = canvasRef.current;
      const point = canvasPoint(e);
      void runSmartSelect([{
        x: point.x / canvas.width,
        y: point.y / canvas.height,
        // Alt/right-click taps say "not this" — the donor's negative points.
        foreground: !(e.altKey || e.button === 2),
      }]);
      return;
    }
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
          Paint the area to change{onSmartSelect ? ', or name it below and let SAM3 select it for you' : ''}.
          Only that area (plus a small blending collar) regenerates — everything
          else keeps its exact pixels.
        </p>

        {onSmartSelect ? (
          <div className="flex flex-col gap-1.5 rounded-lg border border-line1 bg-bg1 p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">Smart select</span>
              <Button
                size="sm"
                variant="neutral"
                icon={pointMode ? 'check' : undefined}
                aria-pressed={pointMode}
                onClick={() => setPointMode((on) => !on)}
                disabled={busy || selecting}
                title="Tap the thing on the image instead of naming it (alt-tap to exclude)"
                className={cx(pointMode && 'border-honey/60 bg-honey-tint text-honey hover:border-honey')}
              >
                {pointMode ? 'Tap to select: on' : 'Tap to select'}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <TextInput
                type="text"
                aria-label="Name the object to select"
                value={selectText}
                onChange={(e) => setSelectText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && selectText.trim()) void runSmartSelect(null); }}
                placeholder="e.g. the jacket"
                disabled={busy || selecting}
                className="flex-1"
              />
              <ActionButton
                variant="neutral"
                label={selecting ? 'Selecting…' : 'Select'}
                loading={selecting}
                disabled={busy || selecting || !selectText.trim()}
                onClick={() => void runSmartSelect(null)}
              />
            </div>
            <p className="text-[11px] leading-relaxed text-ink3">
              {pointMode
                ? 'Tap the object on the image; alt-tap something to exclude it. The silhouette is added to your mask.'
                : 'The selection is added to whatever you have already painted, so you can refine it with the brush.'}
            </p>
            {selectError ? <p className="text-[11px] text-danger">{selectError}</p> : null}
          </div>
        ) : null}
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
              className={cx('absolute inset-0 h-full w-full opacity-45', (busy || selecting) ? 'cursor-wait' : 'cursor-crosshair')}
              style={{ touchAction: 'none' }}
              onContextMenu={(e) => { if (pointMode) e.preventDefault(); }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Brush">
            <Slider min={BRUSH_MIN} max={BRUSH_MAX} step={4} value={brush} format={(v) => `${v}px`} onChange={setBrush} disabled={busy} />
          </Field>
          <Field label="Blend collar" hint="How far the change may bleed past your strokes to blend shadows and texture">
            <Slider min={6} max={32} step={1} value={expand} format={(v) => `${v}px`} onChange={setExpand} disabled={busy} />
          </Field>
          <Field label="Strength" hint="How strongly the painted area changes — 100% fully repaints it">
            <Slider min={25} max={100} step={1} value={influence} format={(v) => `${v}%`} onChange={setInfluence} disabled={busy} />
          </Field>
        </div>
        <Field label="What should appear there?">
          <TextArea
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={busy}
            placeholder="e.g. a red leather jacket — the scene-preservation clause is added automatically"
          />
        </Field>
      </div>
    </Modal>
  );
}
