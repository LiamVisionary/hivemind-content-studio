// Per-card rental control for the LoRA catalog grid.
//
// Bottom-left of a card, opposite the version/update cluster. Dev mode gets
// the full flow: an unregistered LoRA shows "Rental+", which opens the
// SFW-or-NSFW question in an in-card overlay (the same pattern as the update
// menu — a floating menu would be clipped by the settings panel); a registered
// one shows its rating badge and the overlay adds withdraw/re-rate. Outside
// dev mode the badge is read-only information: the LoRA rides along on newly
// rented machines.
//
// The rating is stored per entry so a later NSFW mode can hide "nsfw" rentals
// by default — today it is categorization only.
import { useState } from 'react';
import { addRentalLora, removeRentalLora, rentalLoraUploadPercent } from '../../lib/rentalLoras.js';
import { Icon } from '../../ui/icons.jsx';
import { Spinner, cx } from '../../ui/kit.jsx';

const RATING_LABEL = { sfw: 'SFW', nsfw: 'NSFW' };

export function LoraRentalControl({ lora, entry, devMode, baseModels, choosing, onToggleChooser }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const label = lora.displayName || lora.name;
  const status = entry?.status || '';

  const choose = async (rating) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await addRentalLora(lora, rating, baseModels);
      onToggleChooser(false);
    } catch (err) {
      setError(err?.message || 'Adding to rentals failed');
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await removeRentalLora(lora.id);
      onToggleChooser(false);
    } catch (err) {
      setError(err?.message || 'Removing from rentals failed');
    } finally {
      setBusy(false);
    }
  };

  const pill = (() => {
    if (status === 'uploading') {
      return (
        <span
          className="inline-flex max-w-[110px] items-center gap-1 rounded-sm border border-honey/50 bg-honey-tint px-1 py-px font-mono text-[10px] text-honey"
          title={`Uploading ${label} to the rental bucket`}
        >
          <Spinner size={9} />
          {`Rental ${rentalLoraUploadPercent(entry)}%`}
        </span>
      );
    }
    if (status === 'error') {
      if (!devMode) return null;
      return (
        <button
          type="button"
          title={`Rental upload failed: ${entry?.error || 'unknown error'} — click to retry`}
          aria-label={`Retry adding ${label} to rentals`}
          onClick={(e) => { e.stopPropagation(); onToggleChooser(!choosing); }}
          className="inline-flex items-center gap-0.5 rounded-sm border border-danger/50 bg-danger-tint px-1 py-px text-[10px] font-semibold text-danger"
        >
          <Icon name="warning" size={9} />
          Rental
        </button>
      );
    }
    if (status === 'ready') {
      const rating = RATING_LABEL[entry?.rating] || 'SFW';
      const body = (
        <>
          <Icon name="cloud" size={9} />
          {rating}
        </>
      );
      if (!devMode) {
        return (
          <span
            className="inline-flex items-center gap-0.5 rounded-sm border border-line2 bg-bg1/80 px-1 py-px text-[10px] font-semibold text-ink3"
            title={`Available on rented machines (rated ${rating})`}
          >
            {body}
          </span>
        );
      }
      return (
        <button
          type="button"
          title={`In rentals, rated ${rating} — click to change or remove`}
          aria-label={`Rental options for ${label}`}
          aria-expanded={choosing}
          onClick={(e) => { e.stopPropagation(); onToggleChooser(!choosing); }}
          className={cx(
            'inline-flex items-center gap-0.5 rounded-sm border px-1 py-px text-[10px] font-semibold transition-colors',
            choosing
              ? 'border-honey bg-honey text-on-honey'
              : 'border-line2 bg-bg1/80 text-ink2 hover:border-honey/60 hover:text-honey',
          )}
        >
          {body}
        </button>
      );
    }
    if (!devMode) return null;
    return (
      <button
        type="button"
        title={`Use ${label} in rentals — new machines download it during provisioning`}
        aria-label={`Add ${label} to rentals`}
        aria-expanded={choosing}
        onClick={(e) => { e.stopPropagation(); onToggleChooser(!choosing); }}
        className={cx(
          'inline-flex items-center gap-0.5 rounded-sm border px-1 py-px text-[10px] font-semibold transition-colors',
          choosing
            ? 'border-honey bg-honey text-on-honey'
            : 'border-line1 bg-bg1/80 text-ink3 hover:border-honey/60 hover:text-honey',
        )}
      >
        <Icon name="cloud" size={9} />
        Rental
      </button>
    );
  })();

  return (
    <>
      {pill ? <div className="absolute bottom-1 left-1.5 z-10">{pill}</div> : null}

      {choosing ? (
        <div
          role="group"
          aria-label={`Rental options for ${label}`}
          onClick={(e) => e.stopPropagation()}
          className="hive-scale-in absolute inset-x-1 bottom-1 z-20 flex flex-col gap-1 rounded-md border border-line2 bg-bg1 p-1 shadow-pop"
        >
          <div className="truncate px-1 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink3">
            {status === 'ready' ? 'In rentals — change rating' : 'Use in rentals — rate it first'}
          </div>
          {entry?.error ? (
            <div className="px-1 text-[9px] leading-snug text-danger">{entry.error}</div>
          ) : null}
          {error ? (
            <div className="px-1 text-[9px] leading-snug text-danger">{error}</div>
          ) : null}
          <div className="flex gap-1">
            {['sfw', 'nsfw'].map((rating) => (
              <button
                key={rating}
                type="button"
                disabled={busy}
                onClick={() => void choose(rating)}
                className={cx(
                  'flex-1 rounded-sm border px-1.5 py-1 text-center text-[10px] font-semibold transition-colors disabled:opacity-40',
                  entry?.rating === rating && status === 'ready'
                    ? 'border-honey bg-honey-tint text-honey'
                    : 'border-line1 bg-bg2 text-ink1 hover:border-honey/60 hover:text-honey',
                )}
              >
                {RATING_LABEL[rating]}
              </button>
            ))}
          </div>
          {status === 'ready' || status === 'error' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void withdraw()}
              className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[10px] font-medium text-ink1 transition-colors hover:bg-danger-tint hover:text-danger disabled:opacity-40"
            >
              <Icon name="x" size={11} className="shrink-0" />
              Remove from rentals
            </button>
          ) : null}
          {busy ? (
            <div className="flex items-center gap-1 px-1 text-[9px] text-ink3">
              <Spinner size={9} />
              Saving…
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
