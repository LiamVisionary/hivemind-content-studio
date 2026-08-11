// Result gallery cards + viewer modal for the Image studio.
// Every media src is resolved through useMediaSrc (E2E decrypt, fail-open).
import { useMediaSrc } from '../../hooks/hooks.js';
import { t } from '../../lib/i18n.js';
import { Icon } from '../../ui/icons.jsx';
import { Modal } from '../../ui/Modal.jsx';
import { ActionButton, Button, cx } from '../../ui/kit.jsx';

export function GalleryCard({ entry, active, canReuse, onOpen, onDownload, onReuse, onUpscale }) {
  const src = useMediaSrc(entry.url);
  return (
    <div
      className={cx(
        'group relative cursor-pointer overflow-hidden rounded-lg border bg-bg2 transition-colors duration-150',
        active ? 'border-honey' : 'border-line1 hover:border-line2',
      )}
      onClick={onOpen}
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
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
    >
      {/* No loading="lazy" on result art. Chrome defers a lazy image until a scroll
          or resize re-triggers evaluation, and these strips frequently do not
          scroll — so the deferral is never revisited and the result never appears.
          Same failure the LoRA panel hit. Hub archive lists keep lazy: those really
          do scroll, and they can hold hundreds of entries. */}
      <img
        src={src}
        alt={entry.prompt?.substring(0, 30) || 'Generated'}
        className="aspect-square w-full object-cover"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-bg0/90 to-transparent p-2 pt-6 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        <div className="truncate text-[11px] text-ink1">{entry.prompt || '—'}</div>
        <div className="truncate font-mono text-[10px] text-ink3">{entry.model || ''}</div>
      </div>
      <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        <button
          type="button"
          title={t('common.download')}
          aria-label="Download image"
          className="grid h-7 w-7 place-items-center rounded-md border border-line1 bg-bg0/80 text-ink1 transition-colors hover:border-line2 hover:bg-bg1"
          onClick={(e) => { e.stopPropagation(); onDownload(); }}
        >
          <Icon name="download" size={13} />
        </button>
        {onUpscale ? (
          <button
            type="button"
            title="Upscale (hi-res)"
            aria-label="Upscale image"
            className="grid h-7 w-7 place-items-center rounded-md border border-line1 bg-bg0/80 text-ink1 transition-colors hover:border-line2 hover:bg-bg1"
            onClick={(e) => { e.stopPropagation(); onUpscale('fast'); }}
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
            onClick={(e) => { e.stopPropagation(); onReuse(); }}
          >
            <Icon name="plus" size={13} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function MetaRow({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-20 shrink-0 text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">{label}</span>
      <span className="min-w-0 break-words font-mono text-xs leading-relaxed text-ink1">{String(value)}</span>
    </div>
  );
}

export function ViewerModal({ url, entry, onClose, onBackToSetup, onRegenerate, onDownload, onUpscale, onCompare, onExpand, onInpaint, onAngles, onSequence, onUseAsVideoFrame, videoFrameBusy }) {
  const src = useMediaSrc(url);
  return (
    <Modal open onClose={onClose} title="Generated image" size="xl"
      footer={
        <>
          {/* Going back is a direction, not one of the actions — it leads the row
              from the left (mr-auto) while everything you can DO stays right. */}
          <ActionButton variant="neutral" icon="chevronLeft" label={t('common.backToSetup')} className="mr-auto" onClick={onBackToSetup} />
          <ActionButton variant="neutral" icon="refresh" label={t('common.regenerate')} onClick={onRegenerate} />
          {onUpscale ? (
            <>
              <ActionButton variant="neutral" icon="wand" label="Upscale" onClick={() => onUpscale('fast')} />
              <ActionButton variant="neutral" icon="sparkles" label="Upscale Max" onClick={() => onUpscale('max')} />
            </>
          ) : null}
          {/* Only upscaled entries know their source, so Compare appears only there. */}
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
          <ActionButton variant="primary" icon="download" label={t('common.download')} onClick={onDownload} />
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid place-items-center overflow-hidden rounded-lg border border-line1 bg-bg0">
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
        </div>
        <div className="flex flex-col gap-1.5">
          <MetaRow label="Prompt" value={entry?.prompt} />
          <MetaRow label="Model" value={entry?.model} />
          <MetaRow label="Aspect" value={entry?.aspect_ratio} />
          <MetaRow label="Seed" value={entry?.seed} />
          <MetaRow label="Created" value={entry?.timestamp} />
          <MetaRow label="Id" value={entry?.id} />
        </div>
      </div>
    </Modal>
  );
}
