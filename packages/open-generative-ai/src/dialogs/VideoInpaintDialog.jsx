// Head replacement — scrub an attached reference clip, say which pixels may
// change, and hand the studio everything the minimax-h3-inpaint workflow needs.
//
// WHY THE MASK IS ONE STATIC REGION. The obvious design is a mask per frame,
// tracking the head. It is not what this wants. H3 denoises the whole clip
// JOINTLY in one pass, conditioned on the reference pictures, so the head's
// consistency across time comes from the model — the mask only decides where it
// is allowed to paint. And a tight per-frame silhouette actively hurts: it is
// cut from the OLD head, so it forces a differently-shaped new head into the old
// one's outline. The donor workflow this is built from agrees in practice — even
// on its tracked path it dilates the mask by 30px and crops at 1.75x.
//
// So the mask is a permission area, and the one thing a static area can get
// wrong is failing to cover where the head TRAVELS. That is the only failure
// this dialog has to protect against, which is what the coverage strip is: the
// painted region drawn over frames sampled across the whole clip, so a head that
// walks out of the box is visible before anything is generated rather than after.
//
// SAM3 is the answer when the travel is so wide that a covering box would
// swallow the frame. It tracks the subject per frame inside the graph itself
// (comfy-core's native SAM3_VideoTrack); the preview here runs on a single
// grabbed frame, which is enough to confirm it selects the right thing.
//
// Everything is on this device until Apply: the sealed clip is decrypted through
// resolveMediaSrc (the vault key lives in this browser and nowhere else),
// frames are grabbed by mediabunny, and the mask is a canvas. The only thing
// that leaves is what Apply returns.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';

import { resolveMediaSrc } from '../lib/e2eMedia.js';
import { isLocalAIAvailable, localAI } from '../lib/localInferenceClient.js';
import { describeHostedPrice, hostedSam3Mask, hostedSam3Quote, hostedSam3Status } from '../lib/hostedSam3.js';
import {
  CROP_MODES,
  INPAINT_DEFAULTS,
  coverageTimestamps,
  describeCoverage,
  inpaintDials,
  maskCoversFrames,
  usableInpaintSeconds,
} from '../lib/videoInpaint.js';
import { Button, CollapsibleSection, Field, SectionLabel, Segmented, Slider, Spinner, TextInput, cx } from '../ui/kit.jsx';
import { Icon } from '../ui/icons.jsx';
import { Modal } from '../ui/Modal.jsx';

const BRUSH_MIN = 16;
const BRUSH_MAX = 320;
const COVERAGE_TILES = 6;
// The colour the mask is PAINTED in. Never the colour it is sent in — see
// exportMask, which rebuilds it as white-on-black from this canvas's alpha.
const MASK_INK = '#22d3ee';

function clock(value) {
  const total = Math.max(0, Number(value) || 0);
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  return `${mins}:${String(secs).padStart(2, '0')}.${Math.floor((total % 1) * 10)}`;
}

export function VideoInpaintDialog({
  open = true,
  sourceUrl,
  sourceName = '',
  // How many reference pictures are attached. The new head comes from those —
  // this dialog never collects them, because they are already the panel's job.
  referenceCount = 0,
  // What arming head replacement will NOT send: {motion, voice} counts. The
  // inpaint graph has no slots for either, and the gateway refuses a run
  // carrying references it cannot place rather than dropping them — so this is
  // said here, before Apply, instead of surfacing as a failed submit.
  otherReferences = null,
  initial = null,
  onClose,
  onApply,
}) {
  const [blob, setBlob] = useState(null);
  const [source, setSource] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);

  const [mode, setMode] = useState(initial?.maskSource || INPAINT_DEFAULTS.maskSource);
  const [brush, setBrush] = useState(96);
  const [erasing, setErasing] = useState(false);
  const [hasPaint, setHasPaint] = useState(false);
  // The canvas is drawn on imperatively, so nothing React watches changes when
  // a stroke lands. This counter is what the exported-mask memo depends on.
  const [paintVersion, setPaintVersion] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);

  const [sam3Prompt, setSam3Prompt] = useState(initial?.sam3Prompt || INPAINT_DEFAULTS.sam3Prompt);
  const [sam3Threshold, setSam3Threshold] = useState(initial?.sam3Threshold ?? INPAINT_DEFAULTS.sam3Threshold);
  const [sam3Error, setSam3Error] = useState('');
  // The hosted route, for a machine with no local SAM3: whether it is
  // available, what it would cost, and the mask it produced. The mask is a
  // CLIP rather than a still, so it arms mask_source 'sequence'.
  const [hosted, setHosted] = useState(null);
  const [hostedPrice, setHostedPrice] = useState(null);
  const [hostedMask, setHostedMask] = useState(null);

  const [cropMode, setCropMode] = useState(initial?.cropMode || INPAINT_DEFAULTS.cropMode);
  const [cropScale, setCropScale] = useState(initial?.cropScale ?? INPAINT_DEFAULTS.cropScale);
  const [cropMegapixels, setCropMegapixels] = useState(initial?.cropMegapixels ?? INPAINT_DEFAULTS.cropMegapixels);
  const [maskExpand, setMaskExpand] = useState(initial?.maskExpand ?? INPAINT_DEFAULTS.maskExpand);

  const [busy, setBusy] = useState('');
  const [coverage, setCoverage] = useState([]);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const drawing = useRef(null);
  // Object URLs outlive the render that made them; a coverage strip per open
  // would otherwise leak the whole session.
  const objectUrls = useRef([]);
  const track = useCallback((url) => { objectUrls.current.push(url); return url; }, []);
  useEffect(() => () => {
    objectUrls.current.forEach((url) => { try { URL.revokeObjectURL(url); } catch { /* already gone */ } });
    objectUrls.current = [];
  }, []);

  // Decrypt and probe once per source.
  useEffect(() => {
    let cancelled = false;
    if (!open || !sourceUrl) return undefined;
    setBlob(null); setSource(null); setLoadError(''); setCoverage([]);
    (async () => {
      try {
        const src = await resolveMediaSrc(sourceUrl);
        const loaded = await (await fetch(src)).blob();
        if (cancelled) return;
        const { probeClip } = await import('../lib/clipPrep.js');
        const probed = await probeClip(loaded);
        if (cancelled) return;
        setBlob(loaded);
        setSource(probed);
        setPreviewUrl(track(URL.createObjectURL(loaded)));
      } catch (error) {
        if (!cancelled) setLoadError(error?.message || 'could not read that clip');
      }
    })();
    return () => { cancelled = true; };
  }, [open, sourceUrl, track, attempt]);

  // Is there a hosted route, and what does it cost? Asked once the clip has been
  // measured, because the price is quoted from its frames and its size. Both
  // calls swallow their own failures: an unreachable service is a button that is
  // not offered, never a dialog that will not open.
  useEffect(() => {
    let cancelled = false;
    if (!open || !source) return undefined;
    (async () => {
      const state = await hostedSam3Status();
      if (cancelled) return;
      setHosted(state);
      if (!state.available) return;
      const price = await hostedSam3Quote({
        frames: usableInpaintSeconds(source.duration).frames,
        width: source.width,
        height: source.height,
      });
      if (!cancelled) setHostedPrice(price);
    })();
    return () => { cancelled = true; };
  }, [open, source]);

  // The canvas is the CLIP's own resolution, not the displayed size, so the
  // exported mask lines up with the footage whatever the dialog is sized to.
  const sizeCanvas = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
  };

  const canvasPoint = (event) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const strokeTo = (point, begin) => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    // Brush size is chosen against the DISPLAYED clip, so it scales up to the
    // clip's own resolution — otherwise a 4K source gets a hairline brush.
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / Math.max(1, rect.width);
    const width = brush * scale;
    ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
    // Painted in CYAN, not white. The mask the graph reads is white-on-black,
    // but that is built from this canvas's ALPHA at export time (exportMask), so
    // the colour here is free to be the one you can actually see. White at 45%
    // over bright footage is invisible, which makes the coverage check — the
    // one thing a static region can get wrong — useless exactly where it
    // matters. Cyan is the donor workflow's own choice for the same reason.
    ctx.strokeStyle = MASK_INK;
    ctx.fillStyle = MASK_INK;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = width;
    if (begin) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, width / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    setPaintVersion((value) => value + 1);
    // Erasing can take the LAST stroke away, and a mask with nothing on it is
    // not a mask — so an erase re-reads the canvas rather than assuming.
    setHasPaint(erasing ? maskCoversFrames(canvas) : true);
  };

  const onPointerDown = (event) => {
    if (mode !== 'manual' || busy || !source) return;
    sizeCanvas();
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* synthetic pointer */ }
    drawing.current = event.pointerId;
    strokeTo(canvasPoint(event), true);
  };
  const onPointerMove = (event) => {
    if (drawing.current !== event.pointerId) return;
    strokeTo(canvasPoint(event), false);
  };
  const onPointerUp = (event) => {
    if (drawing.current === event.pointerId) drawing.current = null;
  };

  const clearMask = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    setHasPaint(false);
    setPaintVersion((value) => value + 1);
    setCoverage([]);
  };

  const scrubTo = (seconds) => {
    const video = videoRef.current;
    if (video) video.currentTime = seconds;
    setAt(seconds);
  };

  // The mask as the GRAPH reads it: white where painted, black everywhere else,
  // at the clip's own resolution. Built from the canvas's ALPHA rather than by
  // compositing it onto black — the strokes are cyan so they can be seen, and
  // compositing those onto black would hand ImageToMask('red') a channel of
  // zeroes, i.e. an empty mask that looked perfectly fine on screen.
  const exportMask = () => {
    const canvas = canvasRef.current;
    if (!canvas?.width) return '';
    const source = canvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, canvas.width, canvas.height);
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext('2d');
    const image = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < source.data.length; i += 4) {
      // A feathered edge stays feathered: the alpha IS the mask value.
      const value = source.data[i + 3];
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return out.toDataURL('image/png');
  };

  // The same mask as an OVERLAY: the ink, kept transparent where unpainted, so
  // it can be laid straight over a coverage tile without a blend mode that
  // disappears on light footage.
  const exportOverlay = () => {
    const canvas = canvasRef.current;
    return canvas?.width ? canvas.toDataURL('image/png') : '';
  };

  // SAM3 on ONE frame. The real thing tracks every frame inside the graph; this
  // only has to answer "is it selecting the right thing?", and a single frame
  // answers that for a fraction of the cost.
  const runSam3Preview = async () => {
    if (!blob || !source) return;
    // Named rather than left to the call's own failure: "Smart select is
    // available through Unified Studio" is a sentence about a bridge, and what
    // it means here is "this preview needs SAM3 reachable from this browser".
    if (!isLocalAIAvailable()) {
      setSam3Error('this browser has no local SAM3 to preview with.');
      return;
    }
    setBusy('sam3'); setSam3Error('');
    try {
      const { grabFrame } = await import('../lib/clipPrep.js');
      const frame = await grabFrame(blob, at);
      const imageBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('could not read that frame'));
        reader.readAsDataURL(frame.blob);
      });
      const result = await localAI.smartMask({
        image_base64: imageBase64,
        prompt: sam3Prompt.trim() || INPAINT_DEFAULTS.sam3Prompt,
        confidence: sam3Threshold,
      });
      if (!result?.maskBase64) throw new Error('SAM3 returned no mask');
      await paintReturnedMask(result.maskBase64);
    } catch (error) {
      setSam3Error(error?.message || 'SAM3 is not reachable from here');
    } finally {
      setBusy('');
    }
  };

  // Track on the hosted service. The whole clip, tracked frame by frame, coming
  // back as a mask CLIP — which is what a lane with no SAM3 checkpoint needs and
  // what the graph's "sequence" branch loads.
  const runHostedTracking = async () => {
    if (!blob || !source || !hostedPrice) return;
    setBusy('hosted'); setSam3Error('');
    try {
      const videoBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',', 2)[1] || '');
        reader.onerror = () => reject(new Error('could not read that clip'));
        reader.readAsDataURL(blob);
      });
      const result = await hostedSam3Mask({
        videoBase64,
        frames: usable.frames,
        width: source.width,
        height: source.height,
        prompt: sam3Prompt.trim() || INPAINT_DEFAULTS.sam3Prompt,
        detectionThreshold: sam3Threshold,
        // The figure on the button, sent back as the ceiling: a price that moved
        // since the quote is refused rather than quietly charged.
        approvedUsd: hostedPrice.priceUsd,
      });
      setHostedMask(result);
      toast.success(result.chargedUsd
        ? `Tracked — ${describeHostedPrice(result.chargedUsd)}`
        : 'Tracked');
    } catch (error) {
      setSam3Error(error?.message || 'hosted masking failed');
    } finally {
      setBusy('');
    }
  };

  const paintReturnedMask = (maskDataUrl) => new Promise((resolve, reject) => {
    const canvas = canvasRef.current;
    if (!canvas) { resolve(false); return; }
    const mask = new Image();
    mask.onload = () => {
      const ctx = canvas.getContext('2d');
      // SAM3 hands back white-on-black. This canvas is ink-on-transparency, so
      // the mask is re-inked on the way in: its brightness becomes alpha, and
      // the ink is drawn through it. Drawn with 'lighten' straight in, its black
      // background would have painted over strokes already there.
      const stencil = document.createElement('canvas');
      stencil.width = canvas.width;
      stencil.height = canvas.height;
      const pen = stencil.getContext('2d');
      pen.drawImage(mask, 0, 0, canvas.width, canvas.height);
      const pixels = pen.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < pixels.data.length; i += 4) {
        pixels.data[i + 3] = pixels.data[i];
        pixels.data[i] = 0x22;
        pixels.data[i + 1] = 0xd3;
        pixels.data[i + 2] = 0xee;
      }
      pen.putImageData(pixels, 0, 0);
      ctx.drawImage(stencil, 0, 0);
      setHasPaint(true);
      setPaintVersion((value) => value + 1);
      resolve(true);
    };
    mask.onerror = () => reject(new Error('could not read the returned mask'));
    mask.src = maskDataUrl;
  });

  // The coverage check. Frames from across the WHOLE clip with the painted
  // region drawn over each, so a head that leaves the box is visible here.
  const runCoverage = async () => {
    if (!blob || !source) return;
    setBusy('coverage'); setCoverage([]);
    try {
      const { grabFrame } = await import('../lib/clipPrep.js');
      // The mask rides as an OVERLAY on the tiles rather than being baked into
      // them, so the strip stays honest when the mask is edited afterwards
      // instead of quietly showing the region as it was when it was built.
      const tiles = [];
      for (const stamp of coverageTimestamps(usable, COVERAGE_TILES)) {
        // Sequential, not parallel: six concurrent decodes of a 4K clip is how
        // a tab runs out of memory mid-check.
        const frame = await grabFrame(blob, stamp, { width: 320 });
        tiles.push({ at: stamp, url: track(URL.createObjectURL(frame.blob)) });
        setCoverage([...tiles]);
      }
    } catch (error) {
      toast.error(error?.message || 'could not read frames for the coverage check');
    } finally {
      setBusy('');
    }
  };

  const usable = useMemo(() => usableInpaintSeconds(source?.duration), [source?.duration]);
  // The tile overlay is the INK; the graph's white-on-black is built only at
  // Apply, where it is the thing being sent.
  const maskUrl = useMemo(() => (hasPaint ? exportOverlay() : ''), [hasPaint, paintVersion]);
  // SAM3 mode needs nothing pressed: the render lane tracks for itself, which is
  // the default and what every provisioned rental carries the checkpoint for.
  // The hosted route is an upgrade on top — for a lane that has no SAM3, or for
  // anyone who would rather see the mask decided before they spend a render on
  // it — so it never gates Apply.
  const ready = Boolean(source && !busy && (mode === 'sam3' || hasPaint));

  const noReference = referenceCount < 1;

  const apply = () => {
    onApply?.({
      // A hosted run produced a mask CLIP, which is its own branch: the graph
      // loads it per frame instead of tracking on the lane.
      maskSource: mode === 'sam3' && hostedMask ? 'sequence' : mode,
      maskVideoBase64: mode === 'sam3' && hostedMask ? hostedMask.maskVideoBase64 : '',
      // SAM3 tracks inside the graph, so a painted mask is only sent when it IS
      // the mask. Sending one alongside SAM3 would be silently ignored, which is
      // worse than not sending it.
      maskDataUrl: mode === 'manual' ? exportMask() : '',
      seconds: usable.seconds,
      dials: inpaintDials({
        maskSource: mode,
        sam3Prompt,
        sam3Threshold,
        cropMode,
        cropScale,
        cropMegapixels,
        maskExpand,
      }),
      settings: { sam3Prompt, sam3Threshold, cropMode, cropScale, cropMegapixels, maskExpand },
    });
  };

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      dismissable={!busy}
      title="Replace head"
      size="xl"
      footer={(
        <div className="flex w-full items-center justify-between gap-3">
          <div className="min-w-0 text-xs text-ink3">
            {source ? (
              <>
                {source.width}×{source.height}
                {' · '}{clock(usable.seconds)} of {clock(source.duration)}
                {usable.trimmed ? ' · trimmed to H3’s frame grid' : ''}
              </>
            ) : 'Reading clip…'}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={Boolean(busy)}>Cancel</Button>
            <Button variant="primary" onClick={apply} disabled={!ready}>Use this mask</Button>
          </div>
        </div>
      )}
    >
      {loadError ? (
        <div className="flex items-start gap-3 rounded-md border border-danger bg-danger-tint px-3.5 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink1">Couldn&apos;t read that clip</div>
            <div className="mt-0.5 break-words font-mono text-xs text-danger">{loadError}</div>
          </div>
          <Button size="sm" variant="neutral" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : !source ? (
        <div className="flex items-center gap-3 py-2 text-sm text-ink3">
          <Spinner /> Decrypting and reading the clip on this device…
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* The new head is the reference pictures' job, not this dialog's —
              but a run with none of them is refused by the workflow, so it is
              said here, where it can still be fixed, rather than at submit. */}
          {noReference ? (
            <div className="flex items-start gap-2 rounded-md border border-warn bg-warn-tint px-3 py-2 text-xs text-ink2">
              <Icon name="warning" size={13} className="mt-0.5 shrink-0 text-warn" />
              <span>
                Attach at least one reference picture of the new head in the references panel.
                The mask says <em>where</em>; the pictures say <em>who</em>.
              </span>
            </div>
          ) : null}

          {otherReferences && (otherReferences.motion || otherReferences.voice) ? (
            <div className="flex items-start gap-2 rounded-md border border-line1 bg-bg2 px-3 py-2 text-xs text-ink2">
              <Icon name="info" size={13} className="mt-0.5 shrink-0 text-ink3" />
              <span>
                While this is armed, your other motion and voice references are not sent.
                The movement and the voice both come from this clip — its soundtrack is kept
                untouched, which is what the new head lip-syncs to.
              </span>
            </div>
          ) : null}

          <div className="relative overflow-hidden rounded-lg border border-line1 bg-bg0">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={videoRef}
              src={previewUrl}
              className="block max-h-[46vh] w-full bg-black object-contain"
              onLoadedMetadata={sizeCanvas}
              onTimeUpdate={(event) => setAt(event.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              playsInline
              controls={false}
            />
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              className={cx(
                'absolute inset-0 h-full w-full touch-none opacity-55',
                mode === 'manual' ? (erasing ? 'cursor-cell' : 'cursor-crosshair') : 'pointer-events-none',
              )}
            />
          </div>

          {/* Scrub. The playhead is how you check the region against the whole
              clip by hand; the coverage strip below is the same check at a glance. */}
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="neutral"
              icon={playing ? 'pause' : 'play'}
              onClick={() => {
                const video = videoRef.current;
                if (!video) return;
                if (video.paused) void video.play(); else video.pause();
              }}
            >
              {playing ? 'Pause' : 'Play'}
            </Button>
            <input
              type="range"
              min={0}
              max={Math.max(0.01, usable.seconds)}
              step={1 / 24}
              value={Math.min(at, usable.seconds)}
              onChange={(event) => scrubTo(Number(event.target.value))}
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-bg3 accent-honey"
              aria-label="Scrub the clip"
            />
            <span className="w-24 shrink-0 text-right font-mono text-[11px] text-ink3">
              {clock(at)} / {clock(usable.seconds)}
            </span>
          </div>

          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'manual', label: 'Paint the area' },
              { value: 'sam3', label: 'Track with SAM3' },
            ]}
          />

          {mode === 'manual' ? (
            <div className="flex flex-col gap-3">
              <p className="text-xs leading-relaxed text-ink3">
                Paint over the head, generously. This one region applies to every frame,
                which is usually right — the model paints the head consistently on its own,
                and a loose area lets it place a differently-shaped head naturally.
                The only thing to get right is that the head stays inside it for the whole clip.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-[180px] flex-1">
                  <Slider
                    value={brush}
                    min={BRUSH_MIN}
                    max={BRUSH_MAX}
                    onChange={setBrush}
                    format={(value) => `${value}px brush`}
                  />
                </div>
                <Button
                  size="sm"
                  variant={erasing ? 'primary' : 'neutral'}
                  onClick={() => setErasing((value) => !value)}
                >
                  Erase
                </Button>
                <Button size="sm" variant="ghost" onClick={clearMask} disabled={!hasPaint}>Clear</Button>
                <Button
                  size="sm"
                  variant="neutral"
                  icon="grid"
                  onClick={runCoverage}
                  loading={busy === 'coverage'}
                  disabled={!hasPaint || Boolean(busy)}
                >
                  Check coverage
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-xs leading-relaxed text-ink3">
                SAM3 follows the subject frame by frame inside the render. Use it when the
                shot moves so much that a single covering region would swallow most of the
                frame. The preview below runs on the frame you are scrubbed to — enough to
                confirm it is selecting the right thing.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="What to track" className="min-w-[200px] flex-1">
                  <TextInput
                    value={sam3Prompt}
                    onChange={(event) => setSam3Prompt(event.target.value)}
                    placeholder="head"
                  />
                </Field>
                <div className="min-w-[160px] flex-1">
                  <Field label="Detection threshold">
                    <Slider
                      value={sam3Threshold}
                      min={0.05}
                      max={0.95}
                      step={0.05}
                      onChange={setSam3Threshold}
                      format={(value) => value.toFixed(2)}
                    />
                  </Field>
                </div>
                <Button
                  size="sm"
                  variant="neutral"
                  icon="wand"
                  onClick={runSam3Preview}
                  loading={busy === 'sam3'}
                  disabled={Boolean(busy)}
                >
                  Preview on this frame
                </Button>
                {/* The hosted route. Offered only when it is reachable, switched
                    on AND paid for — a button that cannot work is worse than no
                    button — and the price is on its face, because a mask that
                    silently costs money is one nobody would have asked for. */}
                {hosted?.available && hostedPrice ? (
                  <Button
                    size="sm"
                    variant={hostedMask ? 'primary' : 'neutral'}
                    icon="cloud"
                    onClick={runHostedTracking}
                    loading={busy === 'hosted'}
                    disabled={Boolean(busy)}
                  >
                    {hostedMask ? 'Tracked · redo' : `Track the whole clip · ${describeHostedPrice(hostedPrice.priceUsd)}`}
                  </Button>
                ) : null}
              </div>
              {hostedMask ? (
                <div className="flex items-start gap-2 rounded-md border border-line1 bg-bg2 px-3 py-2 text-xs text-ink2">
                  <Icon name="check" size={13} className="mt-0.5 shrink-0 text-honey" />
                  <span>
                    This clip is tracked. The mask travels with the run, so the render lane
                    does not need SAM3 of its own.
                  </span>
                </div>
              ) : hosted?.available && hostedPrice ? (
                <p className="text-[11px] leading-relaxed text-ink3">
                  Your render lane tracks this itself when it carries the SAM3 checkpoint —
                  that costs nothing and is the default. Track it here instead when the lane
                  has no SAM3, or to settle the mask before spending a render on it.
                  The clip is uploaded to HivemindOS for this, and only for this.
                </p>
              ) : null}
              {sam3Error ? (
                <div className="rounded-md border border-line1 bg-bg2 px-3 py-2 text-xs text-ink2">
                  <span className="font-medium text-ink1">Preview unavailable.</span>{' '}
                  {sam3Error} The render itself still tracks with SAM3 on the lane —
                  only this preview needs SAM3 reachable from here.
                </div>
              ) : null}
            </div>
          )}

          {coverage.length ? (
            <div className="flex flex-col gap-1.5">
              <SectionLabel>{describeCoverage(coverage.length, usable.seconds)}</SectionLabel>
              <div className="grid grid-cols-6 gap-1.5">
                {coverage.map((tile) => (
                  <div key={tile.at} className="relative overflow-hidden rounded border border-line1 bg-bg0">
                    <img src={tile.url} alt={`Frame at ${clock(tile.at)}`} className="block w-full" />
                    {maskUrl ? (
                      <img
                        src={maskUrl}
                        alt=""
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 h-full w-full opacity-70"
                      />
                    ) : null}
                    <span className="absolute bottom-0 right-0 bg-bg0/80 px-1 font-mono text-[9px] text-ink3">
                      {clock(tile.at)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <CollapsibleSection title="Framing and cost" storageKey="inpaint-framing">
            <div className="flex flex-col gap-3 rounded-md border border-line1 bg-bg2 p-3">
              <p className="text-xs leading-relaxed text-ink3">
                The model renders a WINDOW around the masked subject, not the whole frame,
                and the window is resampled to the size below — that, times the clip&apos;s
                frames, is what the card&apos;s memory budget is spent on.
              </p>
              <Field label="Window">
                <Segmented
                  value={cropMode}
                  onChange={setCropMode}
                  size="sm"
                  options={CROP_MODES.map((entry) => ({ value: entry.id, label: entry.label }))}
                />
              </Field>
              <Field label="Window size" hint={CROP_MODES.find((entry) => entry.id === cropMode)?.hint || ''}>
                <Slider
                  value={cropScale}
                  min={1}
                  max={3}
                  step={0.05}
                  onChange={setCropScale}
                  format={(value) => `${value.toFixed(2)}× the subject`}
                />
              </Field>
              <Field label="Render size">
                <Slider
                  value={cropMegapixels}
                  min={0.2}
                  max={1.6}
                  step={0.1}
                  onChange={setCropMegapixels}
                  format={(value) => `${value.toFixed(1)} MP`}
                />
              </Field>
              <Field label="Grow the mask" hint="The model needs room beyond the head's own outline.">
                <Slider
                  value={maskExpand}
                  min={0}
                  max={120}
                  step={2}
                  onChange={setMaskExpand}
                  format={(value) => `${value}px`}
                />
              </Field>
            </div>
          </CollapsibleSection>
        </div>
      )}
    </Modal>
  );
}
