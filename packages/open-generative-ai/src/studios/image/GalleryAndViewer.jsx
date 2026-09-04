// Result gallery cards + viewer modal for the Image studio.
// Every media src is resolved through useMediaSrc (E2E decrypt, fail-open).
import { memo, useEffect, useRef } from 'react';
import { useMediaSrc } from '../../hooks/hooks.js';
import { t, zh } from '../../lib/i18n.js';
import { Icon } from '../../ui/icons.jsx';
import { Modal } from '../../ui/Modal.jsx';
import { ActionButton, IconButton, Pill, cx } from '../../ui/kit.jsx';


// "Created" as a readable local date, not the raw ISO string.
export function formatCreated(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toLocaleString();
}

// Gallery cards: the one this key activates. Space joins Enter (a div with
// role="button" gets neither for free).
export const activatesCard = (key) => key === 'Enter' || key === ' ';

// Memoised on its own entry and active flag: the studio re-renders for reasons
// that have nothing to do with a finished picture (a keystroke in the composer,
// a settings change), and each card carries a decrypt hook. Every handler takes
// the entry so the caller can pass ONE stable function per action instead of a
// fresh closure per card — without that, memo() would never hold.
export const GalleryCard = memo(function GalleryCard({ entry, active, canReuse, onOpen, onDownload, onReuse, onUpscale }) {
  const src = useMediaSrc(entry.url);
  return (
    <div
      className={cx(
        'group relative cursor-pointer overflow-hidden rounded-lg border bg-bg2 transition-colors duration-150',
        active ? 'border-honey' : 'border-line1 hover:border-line2',
      )}
      onClick={() => onOpen(entry)}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        try {
          e.dataTransfer.setData('application/x-hivemind-output', JSON.stringify({ url: entry.url, section: 'image', mediaType: 'image/*' }));
          e.dataTransfer.setData('text/uri-list', entry.url);
          e.dataTransfer.effectAllowed = 'copy';
        } catch { /* non-critical */ }
      }}
      onKeyDown={(e) => { if (activatesCard(e.key)) { e.preventDefault(); onOpen(entry); } }}
    >
      {/* No loading="lazy" on result art. Chrome defers a lazy image until a scroll
          or resize re-triggers evaluation, and these strips frequently do not
          scroll — so the deferral is never revisited and the result never appears.
          Same failure the LoRA panel hit. Hub archive lists keep lazy: those really
          do scroll, and they can hold hundreds of entries. */}
      {/* Square tile, whole picture: a 16:9 or 9:16 output is letterboxed on
          bg-bg3 rather than centre-cropped. */}
      <img
        src={src}
        alt={entry.prompt?.substring(0, 30) || 'Generated'}
        className="aspect-square w-full bg-bg3 object-contain"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-bg0/90 to-transparent p-2 pt-6 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
        <div className="truncate text-[11px] text-ink1">{entry.prompt || '—'}</div>
        <div className="truncate font-mono text-[10px] text-ink3">{entry.model || ''}</div>
      </div>
      {/* focus-within: a keyboard user tabbing onto these buttons sees them. */}
      <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          title={t('common.download')}
          aria-label="Download image"
          className="grid h-7 w-7 place-items-center rounded-md border border-line1 bg-bg0/80 text-ink1 transition-colors hover:border-line2 hover:bg-bg1"
          onClick={(e) => { e.stopPropagation(); onDownload(entry); }}
        >
          <Icon name="download" size={13} />
        </button>
        {onUpscale ? (
          <button
            type="button"
            title="Upscale (hi-res)"
            aria-label="Upscale image"
            className="grid h-7 w-7 place-items-center rounded-md border border-line1 bg-bg0/80 text-ink1 transition-colors hover:border-line2 hover:bg-bg1"
            onClick={(e) => { e.stopPropagation(); onUpscale(entry, 'fast'); }}
          >
            <Icon name="wand" size={13} />
          </button>
        ) : null}
        {canReuse ? (
          <button
            type="button"
            title="Reuse as reference image"
            aria-label="Reuse as reference image"
            className="grid h-7 w-7 place-items-center rounded-md border border-line1 bg-bg0/80 text-ink1 transition-colors hover:border-line2 hover:bg-bg1"
            onClick={(e) => { e.stopPropagation(); onReuse(entry); }}
          >
            <Icon name="plus" size={13} />
          </button>
        ) : null}
      </div>
    </div>
  );
});

function MetaRow({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-20 shrink-0 text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">{label}</span>
      <span className="min-w-0 break-words font-mono text-xs leading-relaxed text-ink1">{String(value)}</span>
    </div>
  );
}

export function ViewerModal({
  url, entry, onClose, onBackToSetup, onRegenerate, onDownload, onUpscale, onCompare, onExpand, onInpaint, onAngles, onSequence,
  onUseAsVideoFrame, videoFrameBusy, onPostToCivitai,
  // Walking the gallery from inside the viewer: position = { index, total } (0-based).
  onPrev, onNext, position = null,
}) {
  const src = useMediaSrc(url);
  const bodyRef = useRef(null);
  const hasPrev = typeof onPrev === 'function';
  const hasNext = typeof onNext === 'function';

  // Arrow keys walk the gallery — only while this viewer is the TOPMOST dialog
  // (Expand / Edit area / Compare open on top of it and own the keyboard then),
  // and never while typing in a field.
  useEffect(() => {
    if (!hasPrev && !hasNext) return undefined;
    const onKey = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const tag = String(e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      const dialogs = document.querySelectorAll('[role="dialog"]');
      const top = dialogs[dialogs.length - 1];
      const mine = bodyRef.current?.closest?.('[role="dialog"]');
      if (!mine || top !== mine) return;
      if (e.key === 'ArrowLeft' && hasPrev) { e.preventDefault(); onPrev(); }
      if (e.key === 'ArrowRight' && hasNext) { e.preventDefault(); onNext(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasPrev, hasNext, onPrev, onNext]);

  const counter = position && position.total > 1 ? `${position.index + 1} of ${position.total}` : '';
  return (
    <Modal open onClose={onClose} title={counter ? `Generated image · ${counter}` : 'Generated image'} size="xl"
      footer={
        <>
          {/* Going back is a direction, not one of the actions — it leads the row
              from the left (mr-auto) while everything you can DO stays right. */}
          <ActionButton variant="neutral" icon="chevronLeft" label={t('common.backToSetup')} className="mr-auto" onClick={onBackToSetup} />
          <ActionButton variant="neutral" icon="refresh" label={t('common.regenerate')} onClick={onRegenerate} />
          {onUpscale ? (
            <>
              <ActionButton variant="neutral" icon="wand" label="Upscale" onClick={() => onUpscale('fast')} />
              <ActionButton variant="neutral" icon="sparkles" label="Upscale (max quality)" onClick={() => onUpscale('max')} />
            </>
          ) : null}
          {/* Compare appears for entries that pair with a source (upscales,
              expansions, masked edits, angles, steps). */}
          {onCompare ? (
            <ActionButton variant="neutral" icon="eye" label="Compare" onClick={onCompare} />
          ) : null}
          {/* Canvas expansion — present only when the local krea2 lane exists. */}
          {onExpand ? (
            <ActionButton variant="neutral" icon="external" label="Expand" onClick={onExpand} />
          ) : null}
          {/* Masked edit — same gate as Expand (krea2 soft-inpaint lane). */}
          {onInpaint ? (
            <ActionButton variant="neutral" icon="layers" label="Edit area" onClick={onInpaint} />
          ) : null}
          {/* Viewpoint variants + staged edit chains — Klein/Qwen edit lanes. */}
          {onAngles ? (
            <ActionButton variant="neutral" icon="camera" label="Angles" onClick={onAngles} />
          ) : null}
          {onSequence ? (
            <ActionButton variant="neutral" icon="stack" label="Steps" onClick={onSequence} />
          ) : null}
          {onUseAsVideoFrame ? (
            <ActionButton
              variant="neutral"
              icon="video"
              loading={videoFrameBusy}
              label={videoFrameBusy ? 'Sending…' : 'Use as video starting frame'}
              onClick={onUseAsVideoFrame}
            />
          ) : null}
          {/* Sits beside Download because it is the same decision one step
              further: this one leaves the machine, and unencrypted. */}
          {onPostToCivitai ? (
            <ActionButton variant="neutral" icon="upload" label="Post to Civitai" onClick={onPostToCivitai} />
          ) : null}
          {/* A cloud result the studio could not keep exists on screen and on a
              CDN link that expires — say so beside the button that saves it,
              rather than letting the owner discover it after a relaunch. */}
          {entry?.saved === false ? (
            <Pill tone="warn">{zh() ? '未保存 — 下载以保留' : 'Not saved — download to keep'}</Pill>
          ) : null}
          <ActionButton variant="primary" icon="download" label={t('common.download')} onClick={onDownload} />
        </>
      }
    >
      <div ref={bodyRef} className="flex flex-col gap-4">
        <div className="relative grid place-items-center overflow-hidden rounded-lg border border-line1 bg-bg0">
          <img
            src={src}
            alt={entry?.prompt || 'Generated image'}
            className="max-h-[52vh] w-auto max-w-full object-contain"
            draggable
            onDragStart={(e) => {
              try {
                e.dataTransfer.setData('application/x-hivemind-output', JSON.stringify({ url, section: 'image', mediaType: 'image/*' }));
                e.dataTransfer.setData('text/uri-list', url);
                e.dataTransfer.effectAllowed = 'copy';
              } catch { /* non-critical */ }
            }}
          />
          {hasPrev || hasNext ? (
            <>
              <IconButton
                icon="chevronLeft"
                label="Previous image (←)"
                disabled={!hasPrev}
                onClick={onPrev}
                className="absolute left-2 top-1/2 -translate-y-1/2 border border-line1 bg-bg1/90 shadow-card disabled:opacity-30"
              />
              <IconButton
                icon="chevronRight"
                label="Next image (→)"
                disabled={!hasNext}
                onClick={onNext}
                className="absolute right-2 top-1/2 -translate-y-1/2 border border-line1 bg-bg1/90 shadow-card disabled:opacity-30"
              />
            </>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <MetaRow label="Prompt" value={entry?.prompt} />
          <MetaRow label="Model" value={entry?.model} />
          <MetaRow label="Aspect" value={entry?.aspect_ratio} />
          <MetaRow label="Seed" value={entry?.seed} />
          {/* Created as a readable local time; the raw id rides in the title
              attribute rather than as a row of its own. */}
          <div title={entry?.id ? `Id ${entry.id}` : undefined}>
            <MetaRow label="Created" value={formatCreated(entry?.timestamp)} />
          </div>
        </div>
      </div>
    </Modal>
  );
}
