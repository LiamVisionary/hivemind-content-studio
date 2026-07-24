// LoRA panel — selected list + catalog grid + Civitai download entry.
// Presentational: all catalog/race/selection logic lives in ImageStudio.jsx.
import { useMediaSrc } from '../../hooks/hooks.js';
import { Icon } from '../../ui/icons.jsx';
import { Button, SectionLabel, Spinner, cx } from '../../ui/kit.jsx';

function LoraPreview({ lora, className = '' }) {
  const src = useMediaSrc(lora.previewUrl || '');
  return (
    <div className={cx('flex items-center justify-center overflow-hidden bg-bg3 text-[10px] font-semibold text-ink3', className)}>
      {lora.previewUrl ? (
        <img
          src={src}
          alt={`${lora.displayName || lora.name} preview`}
          loading="lazy"
          className="h-full w-full object-cover"
          onError={(e) => { e.currentTarget.remove(); }}
        />
      ) : (
        <span>LoRA</span>
      )}
    </div>
  );
}

export function LoraSection({
  open,
  onToggleOpen,
  baseLabel,
  status,
  message,
  loras,
  selection,
  onToggleLora,
  onSetStrength,
  onCommitStrength,
  onClearAll,
  onDownload,
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>LoRAs</SectionLabel>
        <button
          type="button"
          onClick={onToggleOpen}
          className="inline-flex items-center gap-1 text-xs font-medium text-ink2 transition-colors hover:text-ink1"
        >
          {open ? 'Hide' : 'Show'}
          <Icon name="chevronDown" size={13} className={cx('transition-transform duration-150', open && 'rotate-180')} />
        </button>
      </div>
      <p className="text-xs leading-relaxed text-ink3">{baseLabel}</p>

      {/* Selected LoRAs always visible so active adapters are never hidden state. */}
      {selection.length > 0 ? (
        <div className="flex flex-col gap-1.5" aria-label="Selected LoRAs">
          {selection.map((lora) => (
            <div
              key={lora.id}
              className="grid grid-cols-[36px_minmax(0,1fr)_64px_28px] items-center gap-2 rounded-md border border-honey/30 bg-honey-tint p-1.5"
            >
              <LoraPreview lora={lora} className="h-9 w-9 rounded-sm" />
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-ink1">{lora.displayName || lora.name}</div>
                <div className="truncate text-[10px] text-ink3">{lora.name}</div>
              </div>
              <input
                key={`${lora.id}:${lora.strength ?? 1}`}
                type="number"
                min="-10"
                max="10"
                step="0.05"
                defaultValue={String(lora.strength ?? 1)}
                title={`Weight for ${lora.displayName || lora.name}`}
                aria-label={`Weight for ${lora.displayName || lora.name}`}
                className="h-7 w-full rounded-sm border border-line1 bg-bg2 px-1 text-center font-mono text-xs text-ink1 focus:border-honey/60"
                onChange={(e) => onSetStrength(lora.id, e.target.value)}
                onBlur={(e) => onCommitStrength(lora.id, e.target.value)}
              />
              <button
                type="button"
                title={`Unload ${lora.displayName || lora.name}`}
                aria-label={`Unload ${lora.displayName || lora.name}`}
                className="grid h-7 w-7 place-items-center rounded-sm bg-danger-tint text-danger transition-colors hover:border hover:border-danger/40"
                onClick={() => onToggleLora(lora)}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button size="sm" icon="download" onClick={onDownload} title="Download LoRA from Civitai">
          Download LoRA
        </Button>
        {selection.length > 0 ? (
          <Button size="sm" variant="danger" onClick={onClearAll} title="Unload all LoRAs">
            Unload all
          </Button>
        ) : null}
      </div>

      {open ? (
        <>
          {message ? (
            <div
              data-state={status}
              className={cx(
                'flex items-center gap-2 rounded-md border border-line1 bg-bg2 px-3 py-2.5 text-xs',
                status === 'error' ? 'text-danger' : 'text-ink3',
              )}
            >
              {status === 'loading' ? <Spinner size={12} /> : null}
              <span>{message}</span>
            </div>
          ) : null}
          {loras.length > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              {loras.map((lora) => {
                const selected = selection.some((item) => item.id === lora.id);
                return (
                  <button
                    key={lora.id}
                    type="button"
                    data-lora-id={lora.id}
                    aria-pressed={selected}
                    title={selected ? `Unload ${lora.displayName || lora.name}` : `Use ${lora.displayName || lora.name}`}
                    onClick={() => onToggleLora(lora)}
                    className={cx(
                      'relative min-w-0 overflow-hidden rounded-md border text-left transition-colors duration-150',
                      selected
                        ? 'border-honey bg-honey-tint'
                        : 'border-line1 bg-bg2 hover:border-line2 hover:bg-bg3',
                    )}
                  >
                    <LoraPreview lora={lora} className="aspect-[4/3] w-full" />
                    <div className="p-2">
                      <div className="truncate text-xs font-semibold text-ink1">{lora.displayName || lora.name}</div>
                      <div className="mt-0.5 truncate text-[10px] text-ink3">{lora.triggerWords?.[0] || lora.baseModel}</div>
                    </div>
                    <span
                      className={cx(
                        'absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full border text-ink1',
                        selected ? 'border-honey bg-honey text-on-honey' : 'border-line2 bg-bg0/70',
                      )}
                    >
                      <Icon name={selected ? 'check' : 'plus'} size={12} />
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
