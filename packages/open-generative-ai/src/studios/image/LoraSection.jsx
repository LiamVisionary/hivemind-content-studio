// LoRA panel — selected list + catalog grid + Civitai download entry.
// Presentational: all catalog/race/selection logic lives in ImageStudio.jsx.
// The one piece of state it reads directly is the Civitai download in flight, so
// an update-and-replace can draw its progress on the card being replaced.
import { useRef, useState } from 'react';
import { useCivitaiDownloads, useMediaSrc, useWindowEvent } from '../../hooks/hooks.js';
import {
  cancelCivitaiDownload,
  civitaiDownloadPercent,
  describeCivitaiDownload,
} from '../../lib/civitaiDownloadStore.js';
import { localAI } from '../../lib/localInferenceClient.js';
import { loraVersionLabel } from '../../lib/loraSelection.js';
import { Icon } from '../../ui/icons.jsx';
import { Button, SectionLabel, Spinner, cx } from '../../ui/kit.jsx';
import { LoraGroupsMenu } from './LoraGroupsMenu.jsx';
import { PendingLoraCard } from './PendingLoraCard.jsx';

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
  baseModelId,
  status,
  message,
  loras,
  selection,
  onToggleLora,
  onToggleEnabled,
  onSetStrength,
  onCommitStrength,
  onClearAll,
  onDownload,
  onUpdateLora,
  onLoadGroup,
  getSelection,
}) {
  const mutedCount = selection.filter((lora) => lora.enabled === false).length;
  // Several downloads run at once: each plain one gets its own card up front, and
  // each replace draws on the card it supersedes.
  const downloads = useCivitaiDownloads();
  const pendingDownloads = downloads.filter((item) => !item.replaces || item.status === 'error');
  const updatingByLora = new Map(
    downloads.filter((item) => item.replaces && item.status === 'running').map((item) => [item.replaces, item]),
  );
  // Which card is showing its two update choices. Only one at a time, and it is
  // drawn inside the card: a floating menu gets clipped by the settings panel.
  const [updateChoicesFor, setUpdateChoicesFor] = useState('');
  // A click whose press STARTED on an inner control belongs to that control, not to
  // the card behind it. Drag-selecting the weight and releasing over the row makes
  // the browser fire `click` on their common ancestor — the row — so the input's own
  // stopPropagation never sees it and the LoRA got muted mid-edit.
  const pressOrigin = useRef(null);
  const notePress = (e) => { pressOrigin.current = e.target; };
  const pressStartedOnControl = () => {
    const origin = pressOrigin.current;
    pressOrigin.current = null;
    return Boolean(origin?.closest?.('input, button, [role="group"]'));
  };
  useWindowEvent('keydown', (e) => {
    if (e.key === 'Escape' && updateChoicesFor) setUpdateChoicesFor('');
  });

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
          {selection.map((lora) => {
            const enabled = lora.enabled !== false;
            const label = lora.displayName || lora.name;
            // Click the row to mute/unmute (ComfyUI-style bypass) — the weight
            // and the slot survive, so temporary A/Bs don't cost you the tuning.
            const toggle = () => onToggleEnabled?.(lora);
            return (
              <div
                key={lora.id}
                role="button"
                tabIndex={0}
                aria-pressed={enabled}
                title={enabled ? `Click to mute ${label}` : `Muted — click to re-enable ${label}`}
                onMouseDown={notePress}
                onClick={() => { if (!pressStartedOnControl()) toggle(); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
                }}
                className={cx(
                  'grid cursor-pointer grid-cols-[36px_minmax(0,1fr)_64px_28px] items-center gap-2 rounded-md border p-1.5 transition-colors',
                  enabled
                    ? 'border-honey/30 bg-honey-tint hover:border-honey/50'
                    : 'border-line1 bg-bg2 opacity-55 hover:opacity-80',
                )}
              >
                <LoraPreview lora={lora} className={cx('h-9 w-9 rounded-sm', !enabled && 'grayscale')} />
                <div className="min-w-0">
                  <div className={cx('truncate text-xs font-semibold', enabled ? 'text-ink1' : 'text-ink3 line-through')}>
                    {label}
                  </div>
                  <div className="truncate text-[10px] text-ink3">{enabled ? lora.name : 'Muted — not sent to the model'}</div>
                </div>
                <input
                  key={`${lora.id}:${lora.strength ?? 1}`}
                  type="number"
                  min="-10"
                  max="10"
                  step="0.05"
                  defaultValue={String(lora.strength ?? 1)}
                  title={`Weight for ${label}`}
                  aria-label={`Weight for ${label}`}
                  className="h-7 w-full rounded-sm border border-line1 bg-bg2 px-1 text-center font-mono text-xs text-ink1 focus:border-honey/60"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => onSetStrength(lora.id, e.target.value)}
                  onBlur={(e) => onCommitStrength(lora.id, e.target.value)}
                />
                <button
                  type="button"
                  title={`Unload ${label}`}
                  aria-label={`Unload ${label}`}
                  className="grid h-7 w-7 place-items-center rounded-sm bg-danger-tint text-danger transition-colors hover:border hover:border-danger/40"
                  onClick={(e) => { e.stopPropagation(); onToggleLora(lora); }}
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            );
          })}
          {mutedCount > 0 ? (
            <p className="text-[10px] text-ink3">
              {mutedCount} muted — click a row to bring it back.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon="download"
          onClick={onDownload}
          title="Download from Civitai — LoRAs land here, other model types are filed by type"
        >
          Download LoRA
        </Button>
        {selection.length > 0 ? (
          <Button size="sm" variant="danger" onClick={onClearAll} title="Unload all LoRAs">
            Unload all
          </Button>
        ) : null}
        {/* Groups sit with the other stack-level actions, above the catalog grid,
            so saving/loading a whole stack never needs the panel expanded. */}
        {onLoadGroup ? (
          <LoraGroupsMenu
            selection={selection}
            getSelection={getSelection}
            loras={loras}
            baseModelId={baseModelId}
            baseLabel={baseLabel}
            onLoad={onLoadGroup}
          />
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
          {/* The grid renders whenever the panel is open: an in-flight download owns
              the first card even before its file exists, and an empty grid is
              invisible, so no `loras.length` gate here. */}
          <div className="grid grid-cols-2 gap-2">
            {pendingDownloads.map((item) => (
              <PendingLoraCard key={item.key} download={item} />
            ))}
            {loras.map((lora) => {
              const selected = selection.some((item) => item.id === lora.id);
              const label = lora.displayName || lora.name;
              const version = loraVersionLabel(lora);
              const update = lora.update;
              const updatingDownload = updatingByLora.get(lora.id) || null;
              const updating = Boolean(updatingDownload);
              const updatePercent = civitaiDownloadPercent(updatingDownload);
              const choosing = updateChoicesFor === lora.id;
              // With the choices open the card's job is to dismiss them, not to
              // toggle selection out from under the click.
              const toggle = () => (choosing ? setUpdateChoicesFor('') : onToggleLora(lora));
              return (
                // Not a <button>: the card holds the update menu, which cannot nest
                // inside one. Same role/keyboard pattern as the selected rows above.
                <div
                  key={lora.id}
                  role="button"
                  tabIndex={0}
                  data-lora-id={lora.id}
                  aria-pressed={selected}
                  title={selected ? `Unload ${label}` : `Use ${label}`}
                  onMouseDown={notePress}
                  onClick={() => { if (!pressStartedOnControl()) toggle(); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
                  }}
                  className={cx(
                    // No overflow-hidden: it would clip the update menu. The preview
                    // clips itself, so the card corners still look right.
                    'relative min-w-0 cursor-pointer rounded-md border text-left transition-colors duration-150',
                    selected
                      ? 'border-honey bg-honey-tint'
                      : 'border-line1 bg-bg2 hover:border-line2 hover:bg-bg3',
                    updating && 'border-honey/60',
                  )}
                >
                  <LoraPreview lora={lora} className="aspect-[4/3] w-full rounded-t-[5px]" />
                  <div className="p-2 pb-5">
                    <div className="truncate text-xs font-semibold text-ink1">{label}</div>
                    <div className="mt-0.5 truncate text-[10px] text-ink3">{lora.triggerWords?.[0] || lora.baseModel}</div>
                  </div>

                  {/* Bottom-right: installed version, or the update affordance when
                      Civitai has a newer one. An update in flight replaces both. */}
                  <div className="absolute bottom-1 right-1.5 flex items-center gap-1">
                    {updating ? (
                      <span className="inline-flex items-center gap-1 font-mono text-[10px] text-honey">
                        <Spinner size={10} />
                        {`Updating ${updatePercent}%`}
                      </span>
                    ) : (
                      <>
                        {version ? (
                          // Civitai version names run long ("Z-Image (Asian edition)"),
                          // so the label is capped — and capped harder when it has to
                          // share the row with the Update button.
                          <span
                            className={cx(
                              'truncate font-mono text-[10px] text-ink3',
                              update ? 'max-w-[52px]' : 'max-w-[80px]',
                            )}
                            title={`Installed version ${version}`}
                          >
                            {version}
                          </span>
                        ) : null}
                        {update ? (
                          <button
                            type="button"
                            aria-label={`Update ${label}`}
                            aria-expanded={choosing}
                            title={`Civitai has ${update.latestVersionName || 'a newer version'}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setUpdateChoicesFor(choosing ? '' : lora.id);
                            }}
                            className={cx(
                              'inline-flex items-center gap-0.5 rounded-sm border px-1 py-px text-[10px] font-semibold transition-colors',
                              choosing
                                ? 'border-honey bg-honey text-on-honey'
                                : 'border-honey/50 bg-honey-tint text-honey hover:border-honey',
                            )}
                          >
                            <Icon name="download" size={9} />
                            Update
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>

                  <span
                    className={cx(
                      'absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full border text-ink1',
                      selected ? 'border-honey bg-honey text-on-honey' : 'border-line2 bg-bg0/70',
                    )}
                  >
                    <Icon name={selected ? 'check' : 'plus'} size={12} />
                  </span>

                  {/* The two update choices, drawn over the card. Inside the card
                      rather than in a floating menu, which the settings panel clips. */}
                  {choosing && update ? (
                    <div
                      role="group"
                      aria-label={`Update options for ${label}`}
                      onClick={(e) => e.stopPropagation()}
                      className="hive-scale-in absolute inset-x-1 bottom-1 z-20 flex flex-col gap-1 rounded-md border border-line2 bg-bg1 p-1 shadow-pop"
                    >
                      <div className="truncate px-1 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink3">
                        {update.latestVersionName ? `New ${update.latestVersionName}` : 'Newer version'}
                      </div>
                      <button
                        type="button"
                        onClick={() => { setUpdateChoicesFor(''); onUpdateLora?.(lora, update, { replace: true }); }}
                        className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[10px] font-medium text-ink1 transition-colors hover:bg-honey-tint hover:text-honey"
                      >
                        <Icon name="refresh" size={11} className="shrink-0" />
                        Update and replace
                      </button>
                      <button
                        type="button"
                        onClick={() => { setUpdateChoicesFor(''); onUpdateLora?.(lora, update, { replace: false }); }}
                        className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[10px] font-medium text-ink1 transition-colors hover:bg-honey-tint hover:text-honey"
                      >
                        <Icon name="plus" size={11} className="shrink-0" />
                        Download update as new
                      </button>
                    </div>
                  ) : null}

                  {/* An update-and-replace reports on the card it will replace. The
                      installed file stays on disk (and usable) until it lands. */}
                  {updating ? (
                    <>
                      <div
                        className="absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-[5px] bg-bg3"
                        role="status"
                        aria-label={`Updating ${label}: ${describeCivitaiDownload(updatingDownload)}`}
                      >
                        <div
                          className="h-full bg-honey transition-[width] duration-300"
                          style={{ width: `${updatePercent}%` }}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void cancelCivitaiDownload(localAI, updatingDownload.key); }}
                        disabled={updatingDownload.cancelling}
                        title={`Cancel the update — ${label} stays installed`}
                        aria-label={`Cancel the update of ${label}`}
                        className="absolute left-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full border border-line2 bg-bg0/80 text-ink2 transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-40"
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
