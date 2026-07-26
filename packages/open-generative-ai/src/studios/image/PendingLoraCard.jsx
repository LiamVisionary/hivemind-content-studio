// One in-flight Civitai download, rendered as a card among the LoRA cards.
//
// Stateless about *which* downloads exist: LoraSection maps the store's pending
// list onto these, so several downloads show several cards. Cancel stops the
// transfer server-side (the .part file is removed); a finished/failed card clears
// itself. An update-and-replace has no card here — it draws on the card it
// replaces — unless it failed, which needs somewhere to be said.
import { useEffect } from 'react';
import {
  cancelCivitaiDownload,
  civitaiDownloadName,
  civitaiDownloadPercent,
  clearCivitaiDownload,
  describeCivitaiDownload,
} from '../../lib/civitaiDownloadStore.js';
import { localAI } from '../../lib/localInferenceClient.js';
import { Icon } from '../../ui/icons.jsx';
import { Spinner, cx } from '../../ui/kit.jsx';

const SUCCESS_CLEAR_MS = 5000;

export function PendingLoraCard({ download }) {
  const { key, status } = download;

  // The real card takes over once the list refreshes; a cancel just disappears.
  useEffect(() => {
    if (status === 'success') {
      const timer = setTimeout(() => clearCivitaiDownload(key), SUCCESS_CLEAR_MS);
      return () => clearTimeout(timer);
    }
    if (status === 'cancelled') {
      const timer = setTimeout(() => clearCivitaiDownload(key), 1200);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [status, key]);

  const running = status === 'running';
  const failed = status === 'error';
  const done = status === 'success';
  const percent = civitaiDownloadPercent(download);
  const indeterminate = running && !download.job?.total_bytes;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Civitai download: ${describeCivitaiDownload(download)}`}
      className={cx(
        'relative min-w-0 overflow-hidden rounded-md border text-left',
        failed ? 'border-danger/40 bg-danger-tint' : done ? 'border-ok/40 bg-bg2' : 'border-honey/40 bg-bg2',
      )}
    >
      <div className="grid aspect-[4/3] w-full place-items-center bg-bg3">
        {running ? (
          <div className="flex flex-col items-center gap-1.5">
            <Spinner size={18} className="text-honey" />
            <span className="font-mono text-[11px] text-ink2">
              {indeterminate ? '—' : `${percent}%`}
            </span>
          </div>
        ) : (
          <Icon
            name={failed ? 'warning' : done ? 'check' : 'x'}
            size={20}
            className={failed ? 'text-danger' : done ? 'text-ok' : 'text-ink3'}
          />
        )}
      </div>

      <div className="p-2">
        <div className="truncate text-xs font-semibold text-ink1">{civitaiDownloadName(download)}</div>
        {/* Card width truncates; the title keeps a long Civitai error readable. */}
        <div
          title={describeCivitaiDownload(download)}
          className={cx('mt-0.5 truncate text-[10px]', failed ? 'text-danger' : 'text-ink3')}
        >
          {describeCivitaiDownload(download)}
        </div>
      </div>

      {/* Indeterminate until Civitai reports a size, so the bar never fakes progress. */}
      <div className="h-1 w-full overflow-hidden bg-bg3">
        {indeterminate ? (
          <div className="h-full w-1/4 rounded-full bg-honey animate-[hive-indeterminate_1.2s_ease-in-out_infinite]" />
        ) : (
          <div
            className={cx(
              'h-full transition-[width] duration-300',
              failed ? 'bg-danger' : done ? 'bg-ok' : 'bg-honey',
            )}
            style={{ width: `${done ? 100 : percent}%` }}
          />
        )}
      </div>

      <button
        type="button"
        onClick={() => (running ? void cancelCivitaiDownload(localAI, key) : clearCivitaiDownload(key))}
        disabled={download.cancelling}
        title={running ? 'Cancel this download' : 'Dismiss'}
        aria-label={running ? 'Cancel this download' : 'Dismiss'}
        className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full border border-line2 bg-bg0/80 text-ink2 transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-40"
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
