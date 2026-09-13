// Four ways to look at a restoration, over two clips that must stay in step.
//
// The one hard requirement is SYNCHRONY. A restore is judged on detail that
// only exists for a frame or two — a licence plate, an eyelash, the grain the
// model decided was noise — so two players a third of a second apart do not
// show you a comparison, they show you two different moments and let you draw a
// conclusion from the difference. Everything here exists to keep them together:
// one player drives, the other follows on every seek, play, pause and rate
// change, and drifts are corrected rather than tolerated.
//
// The wipe divider is clip-path on the restored copy, so the reveal is a
// property of the frame rather than of the layout — the same trick the image
// CompareViewer uses, and it survives the players being different sizes while
// the browser is still working out the restored clip's dimensions.
//
// This is the STAGE now, not a card in a scrolling column: it fills the frame
// it is given and draws no chrome of its own. The four-way mode control moved
// out to the stage's floating action column (RestoreStage.jsx) — a segmented
// control across the top of the picture is exactly the bar the redesign took
// off every other route — and the sentence that used to sit under the frame
// explaining that the two clips stay in step is that door's tooltip.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../ui/icons.jsx';
import { cx } from '../../ui/kit.jsx';

// A third of a frame at 24fps. Below this, correcting the follower would be
// more visible than the drift it fixes.
const DRIFT_TOLERANCE_SECONDS = 0.014;

export function RestoreCompare({
  originalUrl, restoredUrl, mode,
  originalLabel = 'Original', restoredLabel = 'Restored',
  onTimeUpdate, className = '',
}) {
  const originalRef = useRef(null);
  const restoredRef = useRef(null);
  const [split, setSplit] = useState(0.5);
  const [playing, setPlaying] = useState(false);
  const draggingRef = useRef(false);
  const frameRef = useRef(null);

  // The restored clip leads, because it is the one being judged; the original
  // is the reference and is the one allowed to jump.
  const resync = useCallback(() => {
    const lead = restoredRef.current;
    const follow = originalRef.current;
    if (!lead || !follow) return;
    if (Math.abs(follow.currentTime - lead.currentTime) > DRIFT_TOLERANCE_SECONDS) {
      follow.currentTime = lead.currentTime;
    }
  }, []);

  useEffect(() => {
    const lead = restoredRef.current;
    if (!lead) return undefined;
    const onSeek = () => resync();
    const onTime = () => {
      resync();
      onTimeUpdate?.(lead.currentTime, lead.duration || 0);
    };
    const onPlay = () => {
      setPlaying(true);
      originalRef.current?.play?.().catch(() => { /* the follower is muted; a block here is harmless */ });
    };
    const onPause = () => {
      setPlaying(false);
      originalRef.current?.pause?.();
    };
    lead.addEventListener('seeked', onSeek);
    lead.addEventListener('timeupdate', onTime);
    lead.addEventListener('play', onPlay);
    lead.addEventListener('pause', onPause);
    return () => {
      lead.removeEventListener('seeked', onSeek);
      lead.removeEventListener('timeupdate', onTime);
      lead.removeEventListener('play', onPlay);
      lead.removeEventListener('pause', onPause);
    };
  }, [resync, onTimeUpdate, restoredUrl, originalUrl]);

  // timeupdate fires about four times a second, which is not often enough to
  // keep two clips visually locked while they play. This closes the gap.
  useEffect(() => {
    if (!playing) return undefined;
    let active = true;
    const tick = () => {
      if (!active) return;
      resync();
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      active = false;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [playing, resync]);

  const onDividerMove = useCallback((event) => {
    if (!draggingRef.current) return;
    const frame = event.currentTarget.getBoundingClientRect();
    const x = (event.touches?.[0]?.clientX ?? event.clientX) - frame.left;
    setSplit(Math.max(0, Math.min(1, x / Math.max(1, frame.width))));
  }, []);

  // Nothing at all yet. A clip that is LOADED but not yet restored is not this
  // case: the stage is the whole window now, so answering a freshly loaded clip
  // with a sentence in the middle of an empty frame would hide the very thing
  // that was just loaded. The original is shown instead, with the sentence as a
  // corner note, and the view is forced to it until there is something to
  // compare against.
  const missing = !restoredUrl && !originalUrl;
  const view = restoredUrl ? mode : 'original';
  return (
    <div className={cx('relative h-full w-full overflow-hidden bg-bg0', className)}>
      <div className="absolute inset-0">
        {missing ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-ink3">
            Nothing restored yet — render a preview to see the difference.
          </div>
        ) : view === 'split' ? (
          <div className="grid h-full grid-cols-2 gap-px bg-line1">
            <figure className="relative m-0 flex min-h-0 items-center justify-center bg-bg0">
              <video ref={originalRef} src={originalUrl} muted playsInline className="max-h-full max-w-full" />
              <figcaption className="absolute left-2 top-2 rounded bg-scrim px-2 py-0.5 text-[11px] text-ink1">{originalLabel}</figcaption>
            </figure>
            <figure className="relative m-0 flex min-h-0 items-center justify-center bg-bg0">
              <video ref={restoredRef} src={restoredUrl} controls controlsList="nodownload" playsInline className="max-h-full max-w-full" />
              <figcaption className="absolute left-2 top-2 rounded bg-scrim px-2 py-0.5 text-[11px] text-ink1">{restoredLabel}</figcaption>
            </figure>
          </div>
        ) : (
          <div
            className="relative h-full w-full select-none"
            onMouseMove={onDividerMove}
            onTouchMove={onDividerMove}
            onMouseUp={() => { draggingRef.current = false; }}
            onMouseLeave={() => { draggingRef.current = false; }}
            onTouchEnd={() => { draggingRef.current = false; }}
          >
            {/* The original sits underneath in every stacked mode, so the wipe
                only has to clip the restored copy on top of it. It takes the
                transport when it is the one being watched: the restored copy
                owns the controls in every other view, and `invisible` does not
                make a hidden player's bar reachable — which left the Original
                view a still frame with no way to play it. */}
            <video
              ref={originalRef}
              src={originalUrl}
              muted
              controls={view === 'original'}
              controlsList="nodownload"
              playsInline
              className={cx('absolute inset-0 h-full w-full object-contain', view === 'restored' && 'invisible')}
            />
            {/* Never mounted with an empty src: a <video src=""> resolves to the
                page's own URL and errors. */}
            {restoredUrl ? (
              <div
                className={cx('absolute inset-0', view === 'original' && 'invisible')}
                style={view === 'wipe' ? { clipPath: `inset(0 0 0 ${split * 100}%)` } : undefined}
              >
                <video
                  ref={restoredRef}
                  src={restoredUrl}
                  controls={view !== 'wipe'}
                  controlsList="nodownload"
                  playsInline
                  className="absolute inset-0 h-full w-full object-contain"
                />
              </div>
            ) : null}
            {/* The sentence that used to fill the frame, as a corner note over
                the clip it is about. */}
            {restoredUrl ? null : (
              <span className="absolute left-2 top-2 rounded bg-scrim px-2 py-0.5 text-[11px] text-ink2">
                Nothing restored yet — render a test to see the difference
              </span>
            )}
            {view === 'wipe' ? (
              <>
                <div
                  className="absolute inset-y-0 z-10 w-0.5 bg-honey"
                  style={{ left: `${split * 100}%` }}
                />
                <button
                  type="button"
                  aria-label="Drag to compare"
                  onMouseDown={() => { draggingRef.current = true; }}
                  onTouchStart={() => { draggingRef.current = true; }}
                  className="absolute top-1/2 z-10 -ml-4 -mt-4 flex h-8 w-8 cursor-ew-resize items-center justify-center rounded-full border border-line1 bg-bg1 text-ink1 shadow-overlay"
                  style={{ left: `${split * 100}%` }}
                >
                  <Icon name="expand" size={14} />
                </button>
                {/* The wipe hides the player's own controls, so playback gets
                    one button of its own rather than becoming unavailable. */}
                <button
                  type="button"
                  onClick={() => {
                    const lead = restoredRef.current;
                    if (!lead) return;
                    if (lead.paused) lead.play().catch(() => {});
                    else lead.pause();
                  }}
                  className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line1 bg-bg1/90 px-3 py-1.5 text-xs font-semibold text-ink1"
                >
                  <Icon name={playing ? 'pause' : 'play'} size={12} className="mr-1 inline" />
                  {playing ? 'Pause' : 'Play'}
                </button>
                <span className="absolute left-2 top-2 rounded bg-scrim px-2 py-0.5 text-[11px] text-ink1">{originalLabel}</span>
                <span className="absolute right-2 top-2 rounded bg-scrim px-2 py-0.5 text-[11px] text-ink1">{restoredLabel}</span>
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
