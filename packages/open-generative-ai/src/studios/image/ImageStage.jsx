// The Image studio's stage — the picture you just made, as large as the window
// allows, and everything you can do to it.
//
// It replaces two surfaces at once. The gallery grid (a wall of 200px tiles,
// ImageStudio.jsx:3317) is now the 96px rail; the one thing you are actually
// looking at is here instead, at its OWN aspect ratio rather than letterboxed
// into a square tile. And GenerationProgressCard, which used to head that
// scrolling column, is now the readout along the stage's lower edge — the place
// you are already looking while a render runs.
//
// Prop-driven on purpose: it imports nothing from ImageStudio.jsx. Every gate
// arrives as "did I get a handler" (undefined = do not offer), which is exactly
// the contract ViewerModal already used, so the call site's conditions move
// across unchanged instead of being restated here.
//
// What this file does NOT own: the ViewerModal, CompareViewer, ExpandDialog,
// MaskEditorDialog, AngleVariationsDialog, SequenceEditDialog and
// CivitaiPostDialog all stay mounted by ImageStudio.jsx. The stage only opens
// them, through the handlers below.
import { useState, useSyncExternalStore } from 'react';

import { useMediaSrc } from '../../hooks/hooks.js';
import { formatElapsed } from '../../lib/genProgress.js';
import { t } from '../../lib/i18n.js';
import { HIVEMIND_OUTPUT_DRAG_TYPE } from '../../lib/referenceDrop.js';
import { Icon } from '../../ui/icons.jsx';
import { Menu, MenuItem } from '../../ui/Menu.jsx';
import { Button, Pill } from '../../ui/kit.jsx';
import { StageDownloadAction } from '../frame/DownloadAction.jsx';
import { Stage, StageAction, StageEmpty, StageProgress } from '../frame/Stage.jsx';
import { activatesCard, formatTook } from './GalleryAndViewer.jsx';

// Aspect strings are recorded as 'W:H' — sometimes a ratio ('9:16'), sometimes
// the actual pixels ('1024:1024', ImageStudio.jsx:1748). Both parse the same
// way. Anything else (an old entry, a model that never reported one) falls back
// to a square, which is what the stage plate was before an image loads.
function parseAspect(raw) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(raw || ''));
  if (!match) return '';
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) return '';
  return `${width} / ${height}`;
}

// The decrypted pixels are the truth. Recorded metadata can disagree with what
// actually came back — an edit lane snaps to its own buckets, an upscale
// changes the size but not the recorded ratio — which is the same reason
// ExpandDialog re-probes natural dimensions rather than trusting the entry.
// Until the image loads we hold the recorded ratio so the plate does not jump.
function useResultAspect(url, entry, override) {
  const [natural, setNatural] = useState(null);
  const measured = natural && natural.url === url && natural.width > 0 && natural.height > 0
    ? `${natural.width} / ${natural.height}`
    : '';
  const onLoad = (event) => {
    const img = event.currentTarget;
    if (!img?.naturalWidth || !img?.naturalHeight) return;
    setNatural({ url, width: img.naturalWidth, height: img.naturalHeight });
  };
  return [override || measured || parseAspect(entry?.aspect_ratio) || '1 / 1', onLoad];
}

/**
 * The live readout, drawn over the stage while a render is in flight.
 *
 * It subscribes to the studio's progress store directly — the same
 * useSyncExternalStore contract GenerationProgressCard used, and for the same
 * reason: the bar moves on a 300ms timer and on every bridge message, and
 * routing that through the studio's bump() re-rendered the settings panel, the
 * composer and every decrypting thumbnail several times a second. Keeping the
 * subscription in this leaf means the ticking numbers re-render this readout
 * and nothing else.
 */
function StageProgressReadout({ store, heading, fallbackLabel, onCancel, cancelLabel }) {
  const progress = useSyncExternalStore(store.subscribe, store.get, store.get);
  const pct = Math.max(0, Math.min(1, Number(progress.pct) || 0));
  const eta = Number(progress.estimateSec) > 0 ? formatElapsed(progress.estimateSec * 1000) : null;
  const elapsed = formatElapsed(Date.now() - (progress.startedAt || Date.now()));
  return (
    <StageProgress
      phase={heading}
      percent={pct * 100}
      subject={progress.label || fallbackLabel}
      timing={`${elapsed}${eta ? ` / ~${eta}` : ''}`}
      onCancel={onCancel}
      cancelLabel={cancelLabel}
    />
  );
}

/**
 * The strip along the stage's lower edge when nothing is rendering.
 *
 * The gallery tile carried the prompt and model on hover and the duration badge
 * always (deliberately: it is the number people compare across runs while
 * tuning). A 48px rail card cannot hold any of that, so it lives here — and
 * without hover-gating, because the stage shows ONE picture rather than a wall
 * of them and there is nothing to reveal it from.
 */
function StageMeta({ entry }) {
  const took = formatTook(entry?.generationMs);
  if (!entry?.prompt && !entry?.model && !took) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-bg0/90 to-transparent px-[18px] pb-3.5 pt-8">
      {entry?.prompt ? <span className="truncate text-[12px] text-ink1">{entry.prompt}</span> : null}
      <div className="flex items-baseline justify-between gap-3 font-mono text-[10.5px] text-inkSoft">
        <span className="min-w-0 truncate">{entry?.model || ''}</span>
        {took ? (
          <span className="inline-flex shrink-0 items-center gap-1" title={t('image.generationTime')}>
            <Icon name="clock" size={9} />
            {took}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The floating action column, pinned clear of the results rail.
 *
 * Download and full size are the two doors the design draws; `more` carries
 * every other action the viewer footer offers today, each under the same
 * condition the studio evaluates at its call site. A handler that arrives
 * undefined is an action this model/lane cannot do — the item is not rendered,
 * exactly as the viewer does not render its button.
 *
 * Exported so the orchestrator can hoist it into StudioFrame's `stageActions`
 * slot for the artboard's exact geometry; ImageStage draws it itself otherwise,
 * and passing both would render it twice.
 */
export function ImageStageActions({
  entry,
  onOpen,
  onDownload,
  // () => the A1111 meta for THIS entry, or omitted when the studio has no
  // recorded context for it. The arrow's stamped save is offered as unavailable
  // rather than writing an empty recipe into somebody's file.
  downloadSettings = null,
  downloadFilename = '',
  onReuse,
  onBackToSetup,
  onRegenerate,
  onCompare,
  onExpandCanvas,
  onInpaint,
  onAngles,
  onSequence,
  onUpscale,
  onUseAsVideoFrame,
  videoFrameBusy = false,
  onPostToCivitai,
}) {
  if (!entry) return null;
  return (
    <div className="flex flex-col items-end gap-1.5">
      {/* A cloud result the studio could not persist lives only on an expiring
          CDN link. Said beside the button that saves it, not discovered after a
          relaunch — the same placement the viewer footer uses. */}
      {entry.saved === false ? (
        <Pill tone="warn" className="mb-0.5">Not saved — download to keep</Pill>
      ) : null}
      {/* A split door: the press saves the file the way it always did, the
          arrow opens the three ways of taking it somewhere else. */}
      <StageDownloadAction
        studio="image"
        url={entry.url}
        filename={downloadFilename}
        settings={downloadSettings ? () => downloadSettings(entry) : null}
        onDownload={() => onDownload?.(entry)}
      />
      <StageAction icon="expand" label="Open full size" onClick={() => onOpen?.(entry)} />
      <Menu
        align="end"
        width="w-60"
        trigger={(open, toggle) => (
          <StageAction icon="more" label="More actions" active={open} onClick={toggle} aria-haspopup="menu" aria-expanded={open} />
        )}
      >
        {(close) => (
          <>
            {/* Reuse needs the current model to accept an image at all
                (currentModelSupportsImage, ImageStudio.jsx:2859) — the same
                gate the gallery tile's + button carried. */}
            {onReuse ? (
              <MenuItem icon="plus" onClick={() => { close(); onReuse(entry); }}>Reuse as reference image</MenuItem>
            ) : null}
            <MenuItem icon="chevronLeft" onClick={() => { close(); onBackToSetup?.(entry); }}>{t('common.backToSetup')}</MenuItem>
            <MenuItem icon="refresh" onClick={() => { close(); onRegenerate?.(entry); }}>{t('common.regenerate')}</MenuItem>
            {/* Both upscale modes need the local lane. Fast is R-ESRGAN in
                seconds; max adds a diffusion refine and can take minutes. */}
            {onUpscale ? (
              <>
                <MenuItem icon="wand" onClick={() => { close(); onUpscale(entry, 'fast'); }}>Upscale</MenuItem>
                <MenuItem icon="sparkles" onClick={() => { close(); onUpscale(entry, 'max'); }}>Upscale (max quality)</MenuItem>
              </>
            ) : null}
            {/* Compare exists only for entries paired with an input: upscales,
                expansions, masked edits, angle shots and sequence steps all set
                sourceUrl. */}
            {onCompare ? (
              <MenuItem icon="eye" onClick={() => { close(); onCompare(entry); }}>Compare</MenuItem>
            ) : null}
            {/* Canvas expansion and masked edit share the krea2 local lane. */}
            {onExpandCanvas ? (
              <MenuItem icon="external" onClick={() => { close(); onExpandCanvas(entry); }}>Expand canvas</MenuItem>
            ) : null}
            {onInpaint ? (
              <MenuItem icon="layers" onClick={() => { close(); onInpaint(entry); }}>Edit area</MenuItem>
            ) : null}
            {/* Viewpoint variants and staged edit chains — the Klein/Qwen edit
                dialects, not the krea2 one. */}
            {onAngles ? (
              <MenuItem icon="camera" onClick={() => { close(); onAngles(entry); }}>Angles</MenuItem>
            ) : null}
            {onSequence ? (
              <MenuItem icon="stack" onClick={() => { close(); onSequence(entry); }}>Steps</MenuItem>
            ) : null}
            {/* The Image → Video handoff. Stays disabled mid-flight rather than
                vanishing, so the label can report what it is doing. */}
            {onUseAsVideoFrame ? (
              <MenuItem
                icon="video"
                disabled={videoFrameBusy}
                onClick={() => { close(); onUseAsVideoFrame(entry); }}
              >
                {videoFrameBusy ? 'Sending…' : 'Use as video starting frame'}
              </MenuItem>
            ) : null}
            {/* Beside the rest because it is the same decision one step
                further: this one leaves the machine, and unencrypted. */}
            {onPostToCivitai ? (
              <MenuItem icon="upload" onClick={() => { close(); onPostToCivitai(entry); }}>Post to Civitai</MenuItem>
            ) : null}
          </>
        )}
      </Menu>
    </div>
  );
}

/**
 * ImageStage — the middle of the Image route.
 *
 * @param {object} entry        the result on show: the viewed entry, else the newest
 * @param {string} aspect       CSS aspect override; otherwise read off the pixels
 * @param {number} historyCount s.history.length — what decides the empty state
 * @param {bool}   generating   s.generating
 * @param {object} progressStore s.progressStore (the useSyncExternalStore source)
 * @param {bool}   floatActions draw the action column here (false = the frame's slot)
 */
export function ImageStage({
  entry = null,
  aspect = '',
  historyCount = 0,
  generating = false,
  progressStore = null,
  progressHeading = '',
  progressFallbackLabel = '',
  onCancel,
  cancelLabel = t('common.cancel'),
  onOpenLibrary,
  onOpen,
  onDownload,
  downloadSettings = null,
  downloadFilename = '',
  onReuse,
  onBackToSetup,
  onRegenerate,
  onCompare,
  onExpandCanvas,
  onInpaint,
  onAngles,
  onSequence,
  onUpscale,
  onUseAsVideoFrame,
  videoFrameBusy = false,
  onPostToCivitai,
  floatActions = true,
}) {
  const src = useMediaSrc(entry?.url);
  const [resultAspect, onImageLoad] = useResultAspect(entry?.url, entry, aspect);

  // The recorded condition is `s.history.length === 0 && !s.generating`. The
  // `!entry` half is the same test said the other way round — the studio passes
  // the newest entry, so it is null exactly when history is empty — and it also
  // keeps a blank plate off the screen if a caller ever passes a count without
  // an entry.
  if (!generating && (historyCount === 0 || !entry)) {
    return (
      <StageEmpty
        icon="image"
        title="Nothing here yet"
        hint="Describe the image below and press Generate. Everything you have made before is in the Library."
        action={(
          <Button
            size="sm"
            variant="neutral"
            icon="history"
            onClick={() => {
              if (onOpenLibrary) { onOpenLibrary(); return; }
              // The navigate CustomEvent is the shell's wire contract, so the
              // default keeps working even unwired.
              window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'history' } }));
            }}
          >
            Open Library
          </Button>
        )}
      />
    );
  }

  const overlay = generating && progressStore ? (
    <StageProgressReadout
      store={progressStore}
      heading={progressHeading}
      fallbackLabel={progressFallbackLabel}
      onCancel={onCancel}
      cancelLabel={cancelLabel}
    />
  ) : (entry ? <StageMeta entry={entry} /> : null);

  return (
    <div className="relative grid h-full w-full place-items-center">
      <Stage aspect={resultAspect} busy={generating} overlay={overlay}>
        {entry ? (
          // Clicking the picture opens the viewer, the way clicking a gallery
          // tile did — the whole thing is the door, and Space joins Enter
          // because a role="button" gets neither for free. Drag-out is a
          // feature, not a side effect: this payload is how an output reaches a
          // reference well or the Video studio, and it is byte-identical to the
          // gallery tile's and the viewer's.
          <div
            className="h-full w-full cursor-pointer"
            role="button"
            tabIndex={0}
            aria-label="Open full size"
            onClick={() => onOpen?.(entry)}
            onKeyDown={(e) => { if (activatesCard(e.key)) { e.preventDefault(); onOpen?.(entry); } }}
            draggable
            onDragStart={(e) => {
              try {
                e.dataTransfer.setData(HIVEMIND_OUTPUT_DRAG_TYPE, JSON.stringify({ url: entry.url, section: 'image', mediaType: 'image/*' }));
                e.dataTransfer.setData('text/uri-list', entry.url);
                e.dataTransfer.effectAllowed = 'copy';
              } catch { /* non-critical */ }
            }}
          >
            {/* No loading="lazy": the stage does not scroll, and Chrome never
                revisits a deferral it was never scrolled past. */}
            <img
              src={src}
              alt={entry.prompt || 'Generated image'}
              onLoad={onImageLoad}
              className="h-full w-full object-contain"
            />
          </div>
        ) : null}
      </Stage>
      {/* Clear of the rail, over the stage's own top-right corner — where the
          artboard floats it. Suppressed while the first render of a session is
          still running, because there is no picture to act on yet. */}
      {floatActions && entry ? (
        <div className="absolute right-0 top-0 z-20">
          <ImageStageActions
            entry={entry}
            onOpen={onOpen}
            onDownload={onDownload}
            downloadSettings={downloadSettings}
            downloadFilename={downloadFilename}
            onReuse={onReuse}
            onBackToSetup={onBackToSetup}
            onRegenerate={onRegenerate}
            onCompare={onCompare}
            onExpandCanvas={onExpandCanvas}
            onInpaint={onInpaint}
            onAngles={onAngles}
            onSequence={onSequence}
            onUpscale={onUpscale}
            onUseAsVideoFrame={onUseAsVideoFrame}
            videoFrameBusy={videoFrameBusy}
            onPostToCivitai={onPostToCivitai}
          />
        </div>
      ) : null}
    </div>
  );
}
