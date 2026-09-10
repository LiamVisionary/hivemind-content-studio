// The Video studio's stage: the clip you just made, as large as the window
// allows, with everything that used to sit around it folded onto the frame.
//
// What this replaces (VideoStudio.jsx ~5395-6020, the old scrolling canvas
// column): the progress Card, the centred player and its row of six buttons,
// and the EmptyState. Those stacked vertically and pushed each other down the
// page; here the picture owns the window and the readouts are drawn ON it —
// the player bar along the bottom, the progress overlay in the same place while
// a render is in flight, the actions in a floating column out in the gutter.
//
// It is PROP-DRIVEN on purpose. Every value is read from the engine by
// VideoStudio.jsx and every press calls a handler that already exists there;
// nothing about generation, persistence, the chain or the timeline is decided
// in this file. That is what lets the studio's mutable engine keep being the
// single source of truth while its presentation is replaced wholesale.
//
// Two things here are load-bearing and must not be "tidied":
//   - the <video> keeps `controls` AND `controlsList="nodownload"`. The native
//     controls are the real transport (volume, speed, fullscreen, keyboard) and
//     nothing else offers them; the nodownload token is what keeps the browser
//     from opening a second save path that can never agree with downloadNames.js.
//     downloadNameSingleSource.test.js scans every player under src/ that shows
//     controls — and it scans the source as TEXT, so do not write the offending
//     tag shape in a comment either; that is what this sentence is avoiding.
//   - the empty state's first sentence is asserted verbatim by
//     videoComposerToolbar.test.js. It is the one line that tells a first-timer
//     what to do, so it is also the one line worth pinning.
import { useCallback, useRef, useState } from 'react';

import { useMediaSrc } from '../../hooks/hooks.js';
import { Menu, MenuHeading, MenuItem } from '../../ui/Menu.jsx';
import { Icon } from '../../ui/icons.jsx';
import { Pill } from '../../ui/kit.jsx';
import { StageDownloadAction } from '../frame/DownloadAction.jsx';
import { Stage, StageAction, StageEmpty, StagePlayerBar, StageProgress } from '../frame/Stage.jsx';

// Copy that is localised in VideoStudio.jsx today travels in as `labels`, so a
// caller can hand over its `t(...)` values without this file joining the i18n
// key table. The defaults keep the file readable — and renderable — on its own.
const DEFAULT_LABELS = {
  newPrompt: 'New',
  download: 'Download',
  regenerate: 'Regenerate',
  backToSetup: 'Back to setup',
  extend: 'Extend',
  cancel: 'Cancel',
};

// The verbatim empty-state copy. Kept as module constants rather than inline
// defaults so the sentence the test pins is impossible to miss when editing.
export const VIDEO_EMPTY_TITLE = 'Create your first video';
export const VIDEO_EMPTY_HINT = 'Describe a shot or drop in a starting picture, then press Generate. Your first clip lands right here.';

/** m:ss, the player bar's only number format. */
function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const joinDot = (...parts) => parts.filter(Boolean).join(' · ');

/**
 * The clip itself. A leaf because `useMediaSrc` decrypts through the vault and
 * a hook cannot be called conditionally — mounting the leaf is the condition.
 */
function StageClip({ url, unmuted, hasAudio, onNode, onTiming }) {
  const src = useMediaSrc(url);
  const report = (event) => {
    const node = event.currentTarget;
    onTiming({
      time: Number(node.currentTime) || 0,
      duration: Number.isFinite(node.duration) ? node.duration : 0,
      // The shot's own shape, straight off the decoded stream: a 9:16 clip
      // letterboxed into a 16:9 hole is a worse look at the clip.
      aspect: node.videoWidth && node.videoHeight ? `${node.videoWidth} / ${node.videoHeight}` : '',
    });
  };
  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={onNode}
        src={src}
        controls controlsList="nodownload"
        loop
        autoPlay
        // `unmuted` — the clip reached the canvas through a user gesture (a rail
        // click, Regenerate, a segment pick), so it may play with sound; one
        // that lands on its own stays muted, which is what autoplay policy
        // allows. H3 renders dialogue and soundscape, and a result that always
        // started silent gave no cue that there was any.
        muted={!unmuted}
        playsInline
        onLoadedMetadata={report}
        onDurationChange={report}
        onTimeUpdate={report}
        className="h-full w-full bg-bg0 object-contain"
      />
      {hasAudio ? (
        <Pill tone="neutral" className="pointer-events-none absolute left-3 top-3 gap-1 bg-bg0/80">
          <Icon name="sound" size={11} />
          Sound
        </Pill>
      ) : null}
    </>
  );
}

/** The decrypted latent/preview frame the lane sends mid-render. */
function StagePreview({ url }) {
  const src = useMediaSrc(url);
  return <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover opacity-60" />;
}

/**
 * VideoStage — what fills StudioFrame's `stage` slot.
 *
 * Exactly one of three things is on screen: a clip, a render in flight, or the
 * empty state. They are mutually exclusive in the engine already (generate()
 * clears s.resultUrl before it sets s.generating), so the branches here mirror
 * the conditions the canvas column used rather than inventing new ones.
 */
export function VideoStage({
  /* ---- the clip ---- */
  clipUrl = '',
  clipModel = '',
  clipUnmuted = false,
  clipHasAudio = false,
  // Fallback shape until the stream reports its own; the studio's 16:9 default.
  clipAspect = '16 / 9',
  // "shot 03" — the sequence position this clip holds, when it holds one.
  shotLabel = '',
  // Optional shared ref, so VideoStageActions' Expand can reach this element.
  videoRef = null,

  /* ---- the render in flight ---- */
  generating = false,
  progressTitle = '',
  progressPhase = '',
  progressSteps = '',
  // 0..1 — the SMOOTHED s.progressDisplay, never the raw stage percent.
  progressValue = null,
  progressModelName = '',
  progressDetail = '',
  progressPreviewUrl = '',
  progressElapsed = '',
  progressEta = '',
  elapsedLabel = 'elapsed',
  // Composed by VideoStudio.jsx and passed in as finished sentences —
  // renderCostBudget.test.js pins the queue template to that file.
  queueNote = '',
  overtimeNote = '',
  onCancel = null,

  /* ---- nothing yet ---- */
  hasHistory = false,
  emptyTitle = VIDEO_EMPTY_TITLE,
  emptyHint = VIDEO_EMPTY_HINT,
  // The second, quieter nothing: clips exist, none is on the stage. The old
  // column simply went blank here because the history grid was underneath it;
  // the grid is the rail now, so the stage says what the rail is for.
  idleTitle = 'Nothing on the stage',
  idleHint = 'Pick a shot from the sequence on the right, or write the next one and press Generate.',

  labels = {},
}) {
  const copy = { ...DEFAULT_LABELS, ...labels };
  const nodeRef = useRef(null);
  const [timing, setTiming] = useState({ time: 0, duration: 0, aspect: '' });

  // One ref, two readers: the scrubber below seeks with it and the action
  // column's Expand puts the same element full-screen. Assigning through keeps
  // the caller's ref optional — nothing here requires it.
  const attachNode = useCallback((node) => {
    nodeRef.current = node;
    if (typeof videoRef === 'function') videoRef(node);
    else if (videoRef && typeof videoRef === 'object') videoRef.current = node;
  }, [videoRef]);

  const onTiming = useCallback((next) => {
    setTiming((prev) => (prev.time === next.time && prev.duration === next.duration && prev.aspect === next.aspect
      ? prev
      : next));
  }, []);

  // The bar is a READOUT and a shortcut, not the transport — the native
  // controls underneath still own play, volume, speed and fullscreen. It draws
  // where the eye already is (the artboard's chrome strip) and seeks on click.
  const seek = useCallback((event) => {
    const node = nodeRef.current;
    const total = Number(node?.duration);
    if (!node || !Number.isFinite(total) || total <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    node.currentTime = Math.max(0, Math.min(total, ratio * total));
  }, []);

  /* ---- mid-render ------------------------------------------------------- */

  if (generating) {
    const pct = Number.isFinite(progressValue) ? Math.max(0, Math.min(1, progressValue)) * 100 : null;
    return (
      <Stage aspect={clipAspect} busy overlay={(
        <>
          {/* The render's own frame: the preview when the lane sends one, and
              otherwise the artboard's wipe — the same percentage a third time,
              painted across the frame so a glance at the picture is enough. */}
          {progressPreviewUrl ? <StagePreview url={progressPreviewUrl} /> : (
            <span
              className="pointer-events-none absolute inset-0 bg-white/[0.03]"
              style={pct === null ? undefined : { clipPath: `inset(0 ${100 - pct}% 0 0)` }}
            />
          )}
          {/* Title and the two notices that explain a bar which is not moving.
              Pinned top-left rather than folded into the readout's one truncated
              line, because each is a whole sentence and a clipped explanation
              explains nothing. */}
          {progressTitle || queueNote || overtimeNote ? (
            <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[min(420px,72%)] flex-col gap-1">
              {progressTitle ? (
                <span className="w-fit rounded-full bg-bg0/75 px-2.5 py-1 text-[11px] font-medium text-ink1 backdrop-blur">
                  {progressTitle}
                </span>
              ) : null}
              {/* This machine renders one clip at a time, so a second tab is a
                  queue, not a stall — saying which place it is in is what keeps
                  a motionless bar from reading as a hang. */}
              {queueNote ? (
                <span className="rounded-md bg-bg0/75 px-2.5 py-1 text-[11px] leading-snug text-inkSoft backdrop-blur">{queueNote}</span>
              ) : null}
              {overtimeNote ? (
                <span className="rounded-md bg-bg0/75 px-2.5 py-1 text-[11px] leading-snug text-inkSoft backdrop-blur">{overtimeNote}</span>
              ) : null}
            </div>
          ) : null}
          <StageProgress
            // The artboard puts the step counter beside the phase; it used to
            // sit in the footer line with the aspect and the duration.
            phase={joinDot(progressPhase, progressSteps)}
            percent={pct}
            // What is being made: which shot, on which model, at what shape.
            subject={joinDot(shotLabel, progressModelName, progressDetail)}
            // What is LEFT, not the estimate again — past it the honest word is
            // "finishing", not a countdown that went negative.
            timing={joinDot(progressElapsed ? `${elapsedLabel} ${progressElapsed}` : '', progressEta)}
            onCancel={onCancel || undefined}
            cancelLabel={copy.cancel}
          />
        </>
      )}
      />
    );
  }

  /* ---- a clip ----------------------------------------------------------- */

  if (clipUrl) {
    const aspect = timing.aspect || clipAspect;
    return (
      // Keyed on the clip so a landing render scales in: the moment the whole
      // app exists for should look like something arrived.
      <Stage key={clipUrl} aspect={aspect} className="hive-scale-in" overlay={(
        // Zero-height carrier: it lifts the bar clear of the browser's own
        // control strip (~40px) instead of stacking two dark bands on the same
        // edge. StagePlayerBar pins itself to this box's bottom.
        <div className="absolute inset-x-0 bottom-12 h-0">
          <StagePlayerBar
            time={`${clock(timing.time)} / ${clock(timing.duration)}`}
            progress={timing.duration ? (timing.time / timing.duration) * 100 : 0}
            meta={joinDot(shotLabel, clipModel)}
            onSeek={seek}
          />
        </div>
      )}
      >
        <StageClip
          url={clipUrl}
          unmuted={clipUnmuted}
          hasAudio={clipHasAudio}
          onNode={attachNode}
          onTiming={onTiming}
        />
      </Stage>
    );
  }

  /* ---- nothing yet ------------------------------------------------------ */

  return (
    <Stage aspect={clipAspect}>
      <StageEmpty
        icon="clapper"
        title={hasHistory ? idleTitle : emptyTitle}
        hint={hasHistory ? idleHint : emptyHint}
      />
    </Stage>
  );
}

/**
 * VideoStageActions — the floating column in StudioFrame's `stageActions` slot.
 *
 * The old canvas answered a finished clip with a row of six grey buttons and a
 * More menu. The artboard answers it with three doors: save, full-bleed, and
 * everything else. Nothing was dropped in the move — every action the row and
 * its menu carried is here, each still behind the same condition it had, plus
 * the handlers the surrounding studios offer for a clip (start frame, head
 * swap, restore, send elsewhere) which the caller wires or omits.
 *
 * It renders nothing without a clip, which is also why it disappears while a
 * render is in flight: generate() clears s.resultUrl first. The artboard's
 * rendering state drops this column for exactly that reason.
 */
export function VideoStageActions({
  clipUrl = '',
  // The one Advanced-free next step for a chain-capable lane, and the two flags
  // that gate the two long-running jobs.
  canContinue = false,
  chainLength = 0,
  joining = false,
  smoothing = false,
  canSmooth = false,
  isSeedanceResult = false,

  onDownload = null,
  // () => the A1111 meta for THIS clip, or null when the studio has no recorded
  // context for it — the arrow's stamped save is then offered as unavailable
  // rather than writing an empty recipe into somebody's file.
  downloadSettings = null,
  downloadFilename = '',
  onExpand = null,
  videoRef = null,

  onContinueScene = null,
  onNewPrompt = null,
  onRegenerate = null,
  onBackToSetup = null,
  onExtend = null,
  onSmoothClip = null,
  onJoinChain = null,
  onUseAsStartFrame = null,
  onHeadSwap = null,
  onRestore = null,
  onPostToCivitai = null,
  onDelete = null,
  // [{ id, label, meta, onSelect }] — the studios this clip can be handed to.
  sendTargets = [],

  labels = {},
}) {
  const copy = { ...DEFAULT_LABELS, ...labels };
  if (!clipUrl) return null;

  // Full-bleed is the browser's own fullscreen on the element VideoStage shares
  // through `videoRef`; a caller that would rather open its own viewer passes
  // onExpand and wins. Neither given, the door is not drawn — a button that
  // cannot do anything is worse than no button. The test is what the CALLER
  // handed over, never ref.current: the ref is still empty on the render that
  // first paints this column, and a door that appears one bump later reads as a
  // glitch.
  const canExpand = Boolean(onExpand) || Boolean(videoRef);
  const expand = () => {
    if (onExpand) { onExpand(); return; }
    try { void videoRef?.current?.requestFullscreen?.(); } catch { /* denied by policy */ }
  };

  return (
    <>
      {/* A split door: the press saves the clip the way it always did, the arrow
          opens the three ways of taking it somewhere else. */}
      {onDownload ? (
        <StageDownloadAction
          studio="video"
          url={clipUrl}
          filename={downloadFilename}
          settings={downloadSettings}
          onDownload={onDownload}
          label={copy.download}
        />
      ) : null}
      {canExpand ? (
        <StageAction icon="expand" label="Open full-bleed" onClick={expand} />
      ) : null}
      <Menu
        align="end"
        width="w-[248px]"
        trigger={(open, toggle) => (
          <StageAction
            icon="more"
            label="More actions for this clip"
            onClick={toggle}
            active={open}
            aria-expanded={open}
            aria-haspopup="menu"
          />
        )}
      >
        {(close) => (
          <>
            {/* Where this clip goes next. Continue scene leads on a chain-capable
                lane and New leads where it cannot — the same ternary the result
                row drew, now two rows instead of one primary button. */}
            {canContinue && onContinueScene ? (
              <MenuItem
                icon="arrowRight"
                onClick={() => { close(); onContinueScene(); }}
                title="The next shot picks up exactly where this clip ends — motion and room tone carry across the cut"
              >
                Continue scene
              </MenuItem>
            ) : null}
            {onNewPrompt ? (
              <MenuItem icon="plus" onClick={() => { close(); onNewPrompt(); }}>{copy.newPrompt}</MenuItem>
            ) : null}
            {onRegenerate ? (
              <MenuItem
                icon="refresh"
                onClick={() => { close(); onRegenerate(); }}
                title="Run the settings recorded against this clip again"
              >
                {copy.regenerate}
              </MenuItem>
            ) : null}
            {onBackToSetup ? (
              <MenuItem icon="chevronLeft" onClick={() => { close(); onBackToSetup(); }}>{copy.backToSetup}</MenuItem>
            ) : null}

            {onUseAsStartFrame || onExtend || canSmooth || chainLength >= 2 || onHeadSwap || onRestore ? (
              <MenuHeading>This clip</MenuHeading>
            ) : null}
            {onUseAsStartFrame ? (
              <MenuItem
                icon="image"
                onClick={() => { close(); onUseAsStartFrame(); }}
                title="Take this clip's last frame as the next shot's starting picture"
              >
                Use as start frame
              </MenuItem>
            ) : null}
            {isSeedanceResult && onExtend ? (
              <MenuItem
                icon="arrowRight"
                onClick={() => { close(); onExtend(); }}
                title="Extend this video using Seedance 2.0 Extend"
              >
                {copy.extend}
              </MenuItem>
            ) : null}
            {canSmooth && onSmoothClip ? (
              <MenuItem
                icon="film"
                disabled={smoothing}
                onClick={() => { close(); onSmoothClip(); }}
                title="Doubles the frame rate so motion reads smoother; the audio passes through untouched (RIFE interpolation, on this device)"
              >
                Smooth motion 2×
              </MenuItem>
            ) : null}
            {chainLength >= 2 && onJoinChain ? (
              <MenuItem
                icon="layers"
                disabled={joining}
                onClick={() => { close(); onJoinChain(); }}
                title="Join the whole chained episode into one MP4, losslessly, on this device — the clips never leave it"
              >
                {`Join ${chainLength} shots`}
              </MenuItem>
            ) : null}
            {onHeadSwap ? (
              <MenuItem
                icon="persona"
                onClick={() => { close(); onHeadSwap(); }}
                title="Replace the head in this clip — paint or track the area, then attach the face to use"
              >
                Head swap
              </MenuItem>
            ) : null}
            {onRestore ? (
              <MenuItem
                icon="wand"
                onClick={() => { close(); onRestore(); }}
                title="Send this clip to Restore for upscaling and detail recovery"
              >
                Restore
              </MenuItem>
            ) : null}

            {sendTargets.length ? <MenuHeading>Send to</MenuHeading> : null}
            {sendTargets.map((target) => (
              <MenuItem
                key={target.id}
                icon={target.icon || 'external'}
                meta={target.meta}
                onClick={() => { close(); target.onSelect?.(); }}
              >
                {target.label}
              </MenuItem>
            ))}

            {/* Publishing is the one action here that sends the clip off this
                machine in the clear, so the row says so. */}
            {onPostToCivitai ? (
              <MenuItem
                icon="upload"
                meta="leaves device"
                onClick={() => { close(); onPostToCivitai(); }}
                title="Publish this clip to Civitai — it leaves this device unencrypted"
              >
                Post to Civitai
              </MenuItem>
            ) : null}
            {onDelete ? (
              <MenuItem
                icon="trash"
                className="text-danger hover:text-danger"
                onClick={() => { close(); onDelete(); }}
                title="Remove this clip from the session strip"
              >
                Delete
              </MenuItem>
            ) : null}
          </>
        )}
      </Menu>
    </>
  );
}
