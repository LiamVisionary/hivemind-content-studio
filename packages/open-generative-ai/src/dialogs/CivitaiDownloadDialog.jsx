// Civitai download dialog (React port of components/CivitaiDownloadDialog.js).
// Flow preserved: re-entrancy guard, downloadCivitaiLora(api, url, { onUpdate }),
// success -> await onComplete(job); errors surface as a message + red bar.
//
// The job itself lives in civitaiDownloadStore, so closing the dialog does not stop
// progress tracking. This dialog is only the URL entry point now: as soon as the
// gateway hands back a job id it closes and the pending LoRA card owns the progress
// bar and the cancel button. Failures that happen *before* the job exists (bad URL,
// Civitai auth) stay here, because there is no card yet to show them on.
import { useState } from 'react';
import {
  civitaiDownloadPercent,
  describeCivitaiDownload,
  getCivitaiDownload,
  startCivitaiDownload,
} from '../lib/civitaiDownloadStore.js';
import { useCivitaiDownloads } from '../hooks/hooks.js';
import { Button, Field, TextInput, cx } from '../ui/kit.jsx';
import { Modal } from '../ui/Modal.jsx';

export function CivitaiDownloadDialog({ api, onComplete, onStarted, onClose }) {
  const [url, setUrl] = useState('');
  // Only the download this dialog started: others may be running in parallel and
  // are none of its business.
  const [startedKey, setStartedKey] = useState('');
  const downloads = useCivitaiDownloads();
  const download = downloads.find((item) => item.key === startedKey) || null;

  const running = download?.status === 'running';
  const trimmedUrl = url.trim();
  const failed = download?.status === 'error';

  const submit = (event) => {
    event.preventDefault();
    if (running) return; // re-entrancy guard for this dialog's own submit
    const key = startCivitaiDownload(api, trimmedUrl, {
      onComplete,
      onStarted: (job, context) => {
        // The card takes it from here — get out of the way of the grid it lives in.
        onStarted?.(job, context);
        onClose?.();
      },
    });
    setStartedKey(key);
    // A URL already downloading joins that download instead of starting a second;
    // it has announced itself long ago, so close on its behalf.
    if (getCivitaiDownload(key)?.job?.id) onClose?.();
  };

  const percent = civitaiDownloadPercent(download);
  const showProgress = running || failed;
  const statusText = showProgress ? describeCivitaiDownload(download) : null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Download from Civitai"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {running ? 'Close' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="civitai-download-form"
            loading={running}
            // Explicit: Button spreads `rest` after its own disabled, so a
            // loading-only button would still read as clickable.
            disabled={running}
          >
            Download
          </Button>
        </>
      }
    >
      <form id="civitai-download-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Civitai model URL"
          hint="Any civitai.com model or model-version link — LoRAs, checkpoints, VAEs and the rest are filed by type."
        >
          <TextInput
            type="url"
            required
            inputMode="url"
            autoComplete="off"
            autoFocus
            placeholder="https://civitai.com/models/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="font-mono text-xs"
          />
        </Field>

        {showProgress ? (
          <div className="flex flex-col gap-2 rounded-md border border-line1 bg-bg2 px-3.5 py-3">
            <div
              role="status"
              aria-live="polite"
              className={cx('font-mono text-xs', failed ? 'text-danger' : 'text-ink2')}
            >
              {statusText}
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-bg3">
              <div
                className={cx('h-full rounded-full transition-[width] duration-300', failed ? 'bg-danger' : 'bg-honey')}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        ) : null}

        <p className="text-[11px] leading-relaxed text-ink3">
          You can close this window — the download keeps running in the background, and its progress
          and cancel button live on the LoRA card until it finishes.
        </p>
      </form>
    </Modal>
  );
}
