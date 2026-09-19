// Turntable — one dial that means the same thing before and after the render.
//
// BEFORE: the puck is where the camera STARTS, and the arc is what it will
// sweep. Arming writes the freeze/orbit/no-cuts block into the prompt and pins
// the start picture as the end frame too, which is the step everyone forgets
// and the one that closes the loop.
//
// AFTER: the same puck scrubs the rendered clip. Drag it to 214° and the player
// seeks to the moment the camera passed 214°, so a turntable becomes a camera
// you can turn — and "grab this angle" is how you take a still of a subject
// from a side no photograph of it exists from.
//
// The mapping from angle to timestamp ASSUMES the model held the orbit it was
// asked for. It usually does, and when it does not you can see that in the
// player as you drag — which is why the review side is a scrubber over the real
// clip rather than a computed readout. The strip under it says so.
//
// The recipe, the arithmetic and the COLMAP README live in lib/turntable.js;
// this file is the surface.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  CAMERA_FRAMINGS,
  CAMERA_LENSES,
  TURNTABLE_ARCS,
  TURNTABLE_DIRECTIONS,
  TURNTABLE_ELEVATIONS,
  TURNTABLE_EXPORT_WIDTHS,
  TURNTABLE_FRAME_COUNTS,
  TURNTABLE_POSITIONS,
  TURNTABLE_SPEEDS,
  TURNTABLE_SUBJECTS,
  angleLabel,
  applyTurntable,
  colmapRecipe,
  degreesPerFrame,
  frameFileName,
  normalizeAngle,
  normalizeTurntable,
  orbitSampleTimes,
  turntableLoopReadiness,
  turntableSentence,
  turntableTimeFor,
} from '../../lib/turntable.js';
import { resolveMediaSrc } from '../../lib/e2eMedia.js';
import { resolvePlaintextMedia, saveBytes } from '../../lib/downloadMedia.js';
import { zipStore } from '../../lib/zipStore.js';
import { Icon } from '../../ui/icons.jsx';
import { ChipButton } from '../../ui/Menu.jsx';
import { Modal } from '../../ui/Modal.jsx';
import {
  Button, Field, NativeSelect, ProgressBar, SectionLabel, Segmented, Toggle, cx,
} from '../../ui/kit.jsx';
import { toastFailure } from '../../ui/failureToast.jsx';

const options = (list) => list.map(([value, label]) => (
  <option key={String(value)} value={value}>{label}</option>
));

/* ------------------------------------------------------------------ */
/* The dial                                                            */
/* ------------------------------------------------------------------ */

const DIAL = 240;
const CENTRE = DIAL / 2;
const RING = 86;

// The subject stands at the centre FACING THE BOTTOM of the dial, so 0° — the
// camera in front of its face — is at six o'clock, and the angle grows
// clockwise on screen, which walks the camera toward the subject's right. Both
// halves of that convention are stated in lib/turntable.js; these two functions
// are the only place it becomes pixels.
function pointAt(angle, radius = RING) {
  const radians = (normalizeAngle(angle) * Math.PI) / 180;
  return { x: CENTRE - radius * Math.sin(radians), y: CENTRE + radius * Math.cos(radians) };
}

function angleFrom(x, y) {
  return normalizeAngle((Math.atan2(-(x - CENTRE), y - CENTRE) * 180) / Math.PI);
}

function sweepPath(startAngle, arc, direction) {
  const signed = direction === 'ccw' ? -arc : arc;
  const from = pointAt(startAngle);
  const to = pointAt(startAngle + signed);
  const large = arc > 180 ? 1 : 0;
  // Screen-clockwise is the positive sweep in this projection.
  const sweep = direction === 'ccw' ? 0 : 1;
  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} A ${RING} ${RING} 0 ${large} ${sweep} ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
}

/**
 * Controlled. `angle` is the puck; `rig` draws the arc around it. Dragging and
 * the arrow keys both move it, because a dial that can only be dragged is a
 * dial a keyboard cannot reach.
 */
function OrbitDial({ rig, angle, onAngle, reviewing }) {
  const ref = useRef(null);
  const puck = pointAt(angle);
  const full = rig.arc >= 360;
  const start = pointAt(rig.startAngle);

  const move = useCallback((event) => {
    const svg = ref.current;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * DIAL;
    const y = ((event.clientY - box.top) / box.height) * DIAL;
    onAngle(Math.round(angleFrom(x, y)));
  }, [onAngle]);

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${DIAL} ${DIAL}`}
      className="w-full max-w-[240px] touch-none select-none"
      role="slider"
      tabIndex={0}
      aria-label={reviewing ? 'Camera angle to review' : 'Camera starting angle'}
      aria-valuemin={0}
      aria-valuemax={359}
      aria-valuenow={Math.round(angle)}
      aria-valuetext={`${Math.round(angle)} degrees — ${angleLabel(angle)}`}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); move(event); }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event); }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 15 : 1;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); onAngle(normalizeAngle(angle - step)); }
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); onAngle(normalizeAngle(angle + step)); }
      }}
    >
      <circle cx={CENTRE} cy={CENTRE} r={RING} className="fill-none stroke-line1" strokeWidth="1" />

      {/* The swept arc. A full turn cannot be drawn as one elliptical arc
          command, so it is the ring itself. */}
      {full ? (
        <circle cx={CENTRE} cy={CENTRE} r={RING} className="fill-none stroke-honey/45" strokeWidth="5" />
      ) : (
        <path d={sweepPath(rig.startAngle, rig.arc, rig.direction)} className="fill-none stroke-honey/45" strokeWidth="5" strokeLinecap="round" />
      )}

      {TURNTABLE_POSITIONS.map(([degrees]) => {
        const outer = pointAt(degrees, RING + 7);
        const inner = pointAt(degrees, RING - 5);
        return (
          <line
            key={degrees}
            x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}
            className="stroke-line2" strokeWidth="1"
          />
        );
      })}

      {/* The subject, facing the bottom of the dial — the flat side is its
          back, the notch is the way it looks. */}
      <circle cx={CENTRE} cy={CENTRE - 6} r="11" className="fill-bg3 stroke-line2" strokeWidth="1" />
      <path
        d={`M ${CENTRE - 7} ${CENTRE + 4} L ${CENTRE} ${CENTRE + 15} L ${CENTRE + 7} ${CENTRE + 4} Z`}
        className="fill-ink3"
      />

      {/* Where the sweep begins, kept visible while the puck is somewhere else. */}
      <circle cx={start.x} cy={start.y} r="4" className="fill-bg1 stroke-honey" strokeWidth="1.5" />

      <line x1={CENTRE} y1={CENTRE} x2={puck.x} y2={puck.y} className="stroke-honey/30" strokeWidth="1" strokeDasharray="3 3" />
      <circle cx={puck.x} cy={puck.y} r="9" className="fill-honey stroke-bg1" strokeWidth="2" />
      <text
        x={CENTRE} y={DIAL - 6} textAnchor="middle"
        className="fill-ink3 text-[9px]"
      >
        {reviewing ? 'drag to turn the camera' : 'drag to set where it starts'}
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* The chip                                                            */
/* ------------------------------------------------------------------ */

export function TurntableChip({ armed, onOpen }) {
  return (
    <ChipButton
      icon="refresh"
      label="Turntable"
      value={armed ? 'armed' : ''}
      active={Boolean(armed)}
      chevron={false}
      onClick={onOpen}
      title="Freeze the subject and orbit the camera around it in one shot — a capture you can turn, grab any angle from, and reconstruct into a 3D splat"
    />
  );
}

/* ------------------------------------------------------------------ */
/* The dialog                                                          */
/* ------------------------------------------------------------------ */

const clock = (seconds) => {
  const total = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(total / 60)}:${String(Math.floor(total % 60)).padStart(2, '0')}`;
};

/**
 * Everything the panel is and does, as its two halves.
 *
 * A hook rather than one component because ui/Modal.jsx reaches the screen
 * through `createPortal(…, document.body)`, and the test harness has no real
 * document to portal into — so the dialog below can never be server-rendered.
 * With the parts split out, the panel CAN be, which is the difference between
 * a test that proves the tree builds and a regex over the source that passes
 * whether or not the file executes.
 */
function useTurntableParts({
  // Defaults to open because the panel is only ever mounted while it is; the
  // dialog passes the real flag so a closed one does not decrypt a clip.
  open = true,
  onClose,
  rig: rigProp,
  onRigChange,
  prompt = '',
  armed = false,
  canPinEndFrame = false,
  modelName = '',
  startFrameUrl = '',
  resultUrl = '',
  durationSeconds = 0,
  onApply,
  onRemove,
  onUseFrame,
}) {
  const rig = useMemo(() => normalizeTurntable(rigProp), [rigProp]);
  const set = (patch) => onRigChange({ ...rig, ...patch });

  // One dial, two jobs. Before a clip exists there is nothing to review, so the
  // puck is the start angle and nothing else; once one does, the review side is
  // where the dial earns its keep, so that is what it opens on.
  //
  // Decided as the INITIAL state rather than in an effect, and the difference is
  // not cosmetic: the panel is mounted only while open, so it is the same
  // decision either way — but an effect makes it invisible to a server render,
  // and a state the tests cannot see is a state nothing checks.
  const [reviewing, setReviewing] = useState(() => Boolean(resultUrl));
  const [reviewAngle, setReviewAngle] = useState(() => normalizeTurntable(rigProp).startAngle);

  const angle = reviewing ? reviewAngle : rig.startAngle;
  const setAngle = (next) => (reviewing ? setReviewAngle(next) : set({ startAngle: next }));

  /* ---------------- the clip under review ---------------- */

  const videoRef = useRef(null);
  const [playerSrc, setPlayerSrc] = useState('');
  const [playerSeconds, setPlayerSeconds] = useState(Number(durationSeconds) || 0);

  useEffect(() => {
    if (!open || !resultUrl) { setPlayerSrc(''); return undefined; }
    let alive = true;
    // Generated output is sealed; this decrypts it in-page for the <video>.
    void resolveMediaSrc(resultUrl).then((src) => { if (alive) setPlayerSrc(src); }).catch(() => {});
    return () => { alive = false; };
  }, [open, resultUrl]);

  const reviewTime = turntableTimeFor(rig, reviewAngle, playerSeconds);
  const unswept = reviewTime === null;

  useEffect(() => {
    const video = videoRef.current;
    if (!reviewing || !video || unswept) return;
    // Seeking a paused <video> is what makes the dial feel like a camera: no
    // decode pipeline of our own, just the browser's own scrubber driven by an
    // angle instead of by a timeline.
    if (Math.abs(video.currentTime - reviewTime) > 0.01) video.currentTime = reviewTime;
  }, [reviewing, reviewTime, unswept, playerSrc]);

  /* ---------------- arming ---------------- */

  const loop = turntableLoopReadiness({ canPin: canPinEndFrame, hasStartFrame: Boolean(startFrameUrl) });
  const sentence = useMemo(() => turntableSentence(rig), [rig]);
  const nextPrompt = useMemo(() => applyTurntable(prompt, rig), [prompt, rig]);

  /* ---------------- grabbing and exporting ---------------- */

  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const cancelRef = useRef(false);
  const [frameCount, setFrameCount] = useState(TURNTABLE_FRAME_COUNTS[1]);
  const [exportWidth, setExportWidth] = useState(TURNTABLE_EXPORT_WIDTHS[1]);

  const loadClip = async () => {
    const resolved = await resolvePlaintextMedia(resultUrl);
    if (!resolved.ok) {
      throw new Error(resolved.blocked
        ? 'That clip is still sealed on this device, so its frames cannot be cut here.'
        : 'That clip could not be read back for framing.');
    }
    return resolved.blob;
  };

  const grabAngle = async () => {
    if (busy || unswept) return;
    setBusy('grab');
    try {
      const blob = await loadClip();
      const { grabFrame } = await import('../../lib/clipPrep.js');
      const frame = await grabFrame(blob, reviewTime);
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('the grabbed frame could not be read'));
        reader.readAsDataURL(frame.blob);
      });
      onUseFrame?.(dataUrl, Math.round(reviewAngle));
      toast.success(`Frame at ${Math.round(reviewAngle)}° is now the start frame`);
    } catch (error) {
      toastFailure(error, { operation: 'Grabbing that angle' });
    } finally {
      setBusy('');
    }
  };

  const saveAngle = async () => {
    if (busy || unswept) return;
    setBusy('save');
    try {
      const blob = await loadClip();
      const { grabFrame } = await import('../../lib/clipPrep.js');
      const frame = await grabFrame(blob, reviewTime);
      await saveBytes(frame.blob, `turntable-${String(Math.round(reviewAngle)).padStart(3, '0')}deg.png`);
    } catch (error) {
      toastFailure(error, { operation: 'Saving that angle' });
    } finally {
      setBusy('');
    }
  };

  const exportFrames = async () => {
    if (busy) return;
    cancelRef.current = false;
    setBusy('export');
    setProgress(0);
    try {
      const blob = await loadClip();
      const { grabFrames, probeClip } = await import('../../lib/clipPrep.js');
      const probed = await probeClip(blob).catch(() => null);
      const duration = Number(probed?.duration) || playerSeconds;
      const times = orbitSampleTimes(duration, frameCount);
      if (!times.length) throw new Error('That clip is too short to cut an orbit out of.');

      // ONE pass over the clip. Asking grabFrame for each timestamp separately
      // re-opens and re-decodes the file per frame, which at 180 frames is
      // minutes rather than seconds. JPEG and capped on the long edge for the
      // same reason: COLMAP gains nothing from a 180-frame PNG set that runs to
      // hundreds of megabytes.
      const frames = await grabFrames(blob, times, {
        width: exportWidth || null,
        onProgress: (done, total) => {
          setProgress(done / total);
          return !cancelRef.current;
        },
      });
      if (cancelRef.current) { setBusy(''); return; }

      const entries = [];
      for (const frame of frames) {
        entries.push({
          name: frameFileName(frame.index, times.length),
          bytes: new Uint8Array(await frame.blob.arrayBuffer()),
        });
      }

      entries.push({
        name: 'README.md',
        bytes: new TextEncoder().encode(colmapRecipe({
          rig,
          frameCount: frames.length,
          durationSeconds: duration,
          modelName,
          loopClosed: loop.canPin && Boolean(startFrameUrl),
        })),
      });

      const zipped = zipStore(entries);
      await saveBytes(new Blob([zipped], { type: 'application/zip' }), `turntable-${frames.length}-frames.zip`);
      toast.success(`${frames.length} frames and the COLMAP recipe saved`);
    } catch (error) {
      toastFailure(error, { operation: 'Exporting the orbit frames' });
    } finally {
      setBusy('');
      setProgress(0);
    }
  };

  const exporting = busy === 'export';
  const step = degreesPerFrame(rig, frameCount);

  const footer = (
        <>
          <span className="mr-auto min-w-0 text-[11px] text-ink3">
            {armed
              ? 'Armed — the capture is in the prompt. Changing the dial and writing again replaces it.'
              : `${rig.arc}° ${rig.direction === 'ccw' ? 'counter-clockwise' : 'clockwise'} from ${Math.round(rig.startAngle)}° · ${angleLabel(rig.startAngle)}`}
          </span>
          {armed ? (
            // Closes, like arming does. What Remove changes is the prompt, and
            // the prompt is behind this panel — leaving it open showed only the
            // footer relabelling itself.
            <Button variant="ghost" onClick={() => { onRemove?.(); onClose?.(); }}>Remove</Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            onClick={() => { onApply?.(nextPrompt, { pinEndFrame: loop.canPin }); onClose?.(); }}
            title={loop.canPin
              ? 'Writes the freeze and the orbit into the prompt, and pins the start picture as the end frame so the sweep closes'
              : 'Writes the freeze and the orbit into the prompt. This lane takes no end frame, so nothing is pinned.'}
          >
            {armed ? 'Update the capture' : 'Arm the capture'}
          </Button>
        </>
  );

  const body = (
      <div className="flex flex-col gap-4">
        {/* ---------------- dial + player ---------------- */}
        <div className="flex flex-wrap items-start gap-5">
          <div className="flex w-full max-w-[240px] flex-col items-center gap-2">
            <OrbitDial rig={rig} angle={angle} onAngle={setAngle} reviewing={reviewing} />
            <div className="text-center">
              <div className="font-mono text-lg text-ink1">{`${Math.round(angle)}°`}</div>
              <div className="text-[11px] text-ink3">{angleLabel(angle)}</div>
            </div>
            {resultUrl ? (
              <Segmented
                size="sm"
                value={reviewing ? 'review' : 'plan'}
                onChange={(value) => setReviewing(value === 'review')}
                options={[
                  { value: 'plan', label: 'Set up' },
                  { value: 'review', label: 'Review' },
                ]}
              />
            ) : null}
          </div>

          <div className="min-w-[260px] flex-1">
            {reviewing && resultUrl ? (
              <div className="flex flex-col gap-2">
                <div className="overflow-hidden rounded-lg border border-line1 bg-bg1">
                  {playerSrc ? (
                    <video
                      ref={videoRef}
                      src={playerSrc}
                      muted
                      playsInline
                      preload="auto"
                      className="block max-h-[260px] w-full bg-black object-contain"
                      onLoadedMetadata={(event) => {
                        const seconds = Number(event.currentTarget.duration);
                        if (Number.isFinite(seconds) && seconds > 0) setPlayerSeconds(seconds);
                      }}
                    />
                  ) : (
                    <div className="grid h-[200px] place-items-center text-xs text-ink3">Opening the clip…</div>
                  )}
                </div>
                {unswept ? (
                  <p className="text-[11px] leading-snug text-honey">
                    {`The camera never reaches ${Math.round(reviewAngle)}° — a ${rig.arc}° sweep leaves the rest of the circle uncaptured. Turn the dial back into the lit arc, or render a wider one.`}
                  </p>
                ) : (
                  <p className="text-[11px] leading-snug text-ink3">
                    {`${clock(reviewTime)} of ${clock(playerSeconds)}. The angle assumes the model held the orbit it was asked for — drag along the arc and watch whether it did.`}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="image"
                    disabled={Boolean(busy) || unswept}
                    onClick={grabAngle}
                    title="Take this frame as the start frame for the next generation"
                  >
                    Use this angle
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="download"
                    disabled={Boolean(busy) || unswept}
                    onClick={saveAngle}
                  >
                    Save the frame
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {/* One column on a phone: at 375px the two-column grid
                    truncated every label to "Medium-wide / th…". */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="What is frozen">
                    <NativeSelect value={rig.subject} onChange={(e) => set({ subject: e.target.value })}>
                      {options(TURNTABLE_SUBJECTS)}
                    </NativeSelect>
                  </Field>
                  <Field label="Sweep">
                    <NativeSelect value={rig.arc} onChange={(e) => set({ arc: Number(e.target.value) })}>
                      {options(TURNTABLE_ARCS)}
                    </NativeSelect>
                  </Field>
                  <Field label="Direction" hint="Seen from above">
                    <NativeSelect value={rig.direction} onChange={(e) => set({ direction: e.target.value })}>
                      {options(TURNTABLE_DIRECTIONS)}
                    </NativeSelect>
                  </Field>
                  <Field label="Height">
                    <NativeSelect value={rig.elevation} onChange={(e) => set({ elevation: e.target.value })}>
                      {options(TURNTABLE_ELEVATIONS)}
                    </NativeSelect>
                  </Field>
                  <Field label="Framing">
                    <NativeSelect value={rig.framing} onChange={(e) => set({ framing: e.target.value })}>
                      {options(CAMERA_FRAMINGS.filter(([value]) => value))}
                    </NativeSelect>
                  </Field>
                  <Field label="Lens">
                    <NativeSelect value={rig.lens} onChange={(e) => set({ lens: e.target.value })}>
                      {options(CAMERA_LENSES.filter(([value]) => value))}
                    </NativeSelect>
                  </Field>
                  <Field label="Speed">
                    <NativeSelect value={rig.speed} onChange={(e) => set({ speed: e.target.value })}>
                      {options(TURNTABLE_SPEEDS)}
                    </NativeSelect>
                  </Field>
                </div>
                <div className="flex items-start justify-between gap-3 rounded-md border border-line1 bg-bg1 px-3 py-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[13px] text-ink1">Nail the light down</span>
                    <span className="text-[11px] leading-snug text-ink3">
                      Holds the lighting, the background and the distance constant. Needed for a reconstruction; turn it off for a look-around.
                    </span>
                  </span>
                  <Toggle
                    checked={rig.lockLighting}
                    onChange={(value) => set({ lockLighting: value })}
                    label="Hold the lighting and background constant"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ---------------- the loop ---------------- */}
        <div
          className={cx(
            'flex items-start gap-2 rounded-md border px-3 py-2',
            loop.ready ? 'border-line1 bg-bg1' : 'border-honey/40 bg-honey-tint',
          )}
        >
          <Icon name={loop.ready ? 'check' : 'info'} size={14} className="mt-0.5 shrink-0 text-honey" />
          <p className="min-w-0 text-[11px] leading-snug text-ink2">
            {loop.ready
              ? 'Arming pins the start picture as the end frame too, so the far side of the orbit comes back to the near side. That one pin is the difference between a capture that reconstructs and one that drifts.'
              : `${loop.reason} ${loop.fix}`}
          </p>
        </div>

        {/* ---------------- what it writes ---------------- */}
        <div className="flex flex-col gap-1.5">
          <SectionLabel>What it writes into the prompt</SectionLabel>
          <p className="rounded-md border border-line1 bg-bg1 px-3 py-2 text-[12px] leading-relaxed text-ink2">
            {sentence}
          </p>
        </div>

        {/* ---------------- the handoff ---------------- */}
        {resultUrl ? (
          <div className="flex flex-col gap-2 rounded-md border border-line1 bg-bg1 p-3">
            <SectionLabel>Reconstruct it</SectionLabel>
            <p className="text-[11px] leading-snug text-ink3">
              Cuts evenly spaced frames out of this clip, on this device, and saves them as one zip with the COLMAP settings written beside them. Feed the reconstruction to Postshot, Brush, or any splat trainer.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Frames" className="w-28">
                <NativeSelect
                  value={frameCount}
                  disabled={exporting}
                  onChange={(e) => setFrameCount(Number(e.target.value))}
                >
                  {TURNTABLE_FRAME_COUNTS.map((count) => (
                    <option key={count} value={count}>{count}</option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Long edge" className="w-32">
                <NativeSelect
                  value={exportWidth}
                  disabled={exporting}
                  onChange={(e) => setExportWidth(Number(e.target.value))}
                >
                  {TURNTABLE_EXPORT_WIDTHS.map((width) => (
                    <option key={width} value={width}>{width ? `${width}px` : 'Full size'}</option>
                  ))}
                </NativeSelect>
              </Field>
              <span className="flex-1 pb-2 text-[11px] text-ink3">
                {`One frame every ${step.toFixed(1)}° — ${step <= 5 ? 'comfortable overlap for a matcher' : 'sparse; raise the frame count if the reconstruction comes out thin'}`}
              </span>
              {exporting ? (
                <Button size="sm" variant="ghost" icon="x" onClick={() => { cancelRef.current = true; }}>Stop</Button>
              ) : (
                <Button size="sm" variant="secondary" icon="layers" disabled={Boolean(busy)} onClick={exportFrames}>
                  Export frames
                </Button>
              )}
            </div>
            {exporting ? (
              <ProgressBar value={progress} label={`Cutting frame ${Math.round(progress * frameCount)} of ${frameCount}`} />
            ) : null}
          </div>
        ) : null}
      </div>
  );

  return { body, footer };
}

export function TurntableDialog(props) {
  const { body, footer } = useTurntableParts(props);
  return (
    <Modal open={props.open} onClose={props.onClose} size="xl" title="Turntable" footer={footer}>
      {body}
    </Modal>
  );
}

/** The dialog's contents without the modal chrome — what the tests mount, and
 *  the only way to prove this tree actually builds (see useTurntableParts). */
export function TurntablePanel(props) {
  const { body, footer } = useTurntableParts(props);
  return (
    <div>
      {body}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-line1 pt-3">{footer}</div>
    </div>
  );
}
