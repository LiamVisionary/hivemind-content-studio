// Reusable top-of-screen progress toast: title, live status line, progress bar, ×.
//
// NOT wired to the Civitai download any more — that progress (and its cancel button)
// belongs to the pending card in the LoRA grid, see studios/image/PendingLoraCard.jsx.
// Kept as the container for the next long-running background job that needs one:
// pass it any {status, job} entry shaped like a civitaiDownloadStore download.
import { useEffect } from 'react';
import { toast } from 'react-hot-toast';
import {
  civitaiDownloadPercent,
  civitaiDownloadType,
  describeCivitaiDownload,
} from '../lib/civitaiDownloadStore.js';
import { Icon } from '../ui/icons.jsx';
import { Spinner, cx } from '../ui/kit.jsx';

const TOAST_ID = 'civitai-download';
const SUCCESS_DISMISS_MS = 6000;

function CivitaiDownloadToast({ toastId, visible, download }) {
  const state = download || { status: 'idle' };

  // A finished download stops being news after a few seconds; failures stay put.
  useEffect(() => {
    if (state.status !== 'success') return undefined;
    const timer = setTimeout(() => toast.dismiss(toastId), SUCCESS_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [state.status, toastId]);

  const running = state.status === 'running';
  const failed = state.status === 'error';
  const percent = civitaiDownloadPercent(state);
  // The model type is only known once Civitai resolves the version, so the
  // running title stays generic and the finished one names what arrived.
  const title = running
    ? 'Downloading from Civitai…'
    : failed
      ? 'Civitai download failed'
      : `${civitaiDownloadType(state) || 'Model'} downloaded`;

  return (
    <div
      className={cx(
        'flex w-[360px] max-w-[calc(100vw-2rem)] items-start gap-3 rounded-md border border-line1 bg-bg3 px-3.5 py-3 shadow-pop transition-opacity duration-150',
        visible ? 'hive-scale-in opacity-100' : 'opacity-0',
      )}
      role="status"
      aria-live="polite"
    >
      <div className="mt-0.5 shrink-0">
        {running ? (
          <Spinner size={14} className="text-honey" />
        ) : (
          <Icon name={failed ? 'warning' : 'check'} size={15} className={failed ? 'text-danger' : 'text-ok'} />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="text-[13px] font-medium text-ink1">{title}</div>
        <div className={cx('break-words font-mono text-[11px]', failed ? 'text-danger' : 'text-ink3')}>
          {describeCivitaiDownload(state)}
        </div>
        {running ? (
          <div className="h-1 w-full overflow-hidden rounded-full bg-bg2">
            <div
              className="h-full rounded-full bg-honey transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => toast.dismiss(toastId)}
        aria-label="Dismiss"
        title="Dismiss (the download keeps running)"
        className="-mr-1 -mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink3 transition-colors hover:bg-bg2 hover:text-ink1"
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}

/** Park a long-running job at the top of the screen. Re-call it to update `download`. */
export function showCivitaiDownloadToast(download) {
  toast.custom((instance) => (
    <CivitaiDownloadToast toastId={instance.id} visible={instance.visible} download={download} />
  ), {
    id: TOAST_ID,
    duration: Infinity,
    // Per-toast override of the app's bottom-right Toaster: this one sits with the
    // other top-of-screen background banners (e.g. "Resuming N generations…").
    position: 'top-center',
  });
}

/** The dialog takes over the reporting whenever it is open. */
export function dismissCivitaiDownloadToast() {
  toast.dismiss(TOAST_ID);
}
