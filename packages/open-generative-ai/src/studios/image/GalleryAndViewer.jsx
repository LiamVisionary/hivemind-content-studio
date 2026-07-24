// Result gallery cards + viewer modal for the Image studio.
// Every media src is resolved through useMediaSrc (E2E decrypt, fail-open).
import { useMediaSrc } from '../../hooks/hooks.js';
import { t } from '../../lib/i18n.js';
import { Icon } from '../../ui/icons.jsx';
import { Modal } from '../../ui/Modal.jsx';
import { Button, cx } from '../../ui/kit.jsx';

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
      <img
        src={src}
        alt={entry.prompt?.substring(0, 30) || 'Generated'}
        loading="lazy"
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

export function ViewerModal({ url, entry, onClose, onBackToSetup, onRegenerate, onDownload, onNew, onUpscale }) {
  const src = useMediaSrc(url);
  return (
    <Modal open onClose={onClose} title="Generated image" size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onNew}>{t('common.newItem')}</Button>
          <Button variant="neutral" onClick={onBackToSetup}>{t('common.backToSetup')}</Button>
          <Button variant="neutral" onClick={onRegenerate}>{t('common.regenerate')}</Button>
          {onUpscale ? (
            <>
              <Button variant="neutral" icon="wand" onClick={() => onUpscale('fast')}>Upscale</Button>
              <Button variant="neutral" icon="sparkles" onClick={() => onUpscale('max')}>Upscale Max</Button>
            </>
          ) : null}
          <Button variant="primary" icon="download" onClick={onDownload}>{t('common.download')}</Button>
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
