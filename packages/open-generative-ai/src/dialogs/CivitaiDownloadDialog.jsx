// Civitai LoRA download dialog (React port of components/CivitaiDownloadDialog.js).
// Flow preserved: re-entrancy guard, downloadCivitaiLora(api, url, { onUpdate }),
// success -> await onComplete(job); error -> message + red bar. The poll loop is
// tied to an AbortController that fires on unmount, so closing the dialog stops
// monitoring (the server-side download itself keeps running).
import { useEffect, useRef, useState } from 'react';
import { downloadCivitaiLora, formatDownloadBytes } from '../lib/civitaiDownload.js';
import { Button, Field, TextInput, cx } from '../ui/kit.jsx';
import { Modal } from '../ui/Modal.jsx';

export function CivitaiDownloadDialog({ api, onComplete, onClose }) {
  const [url, setUrl] = useState('');
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef(null);

  // Abort the polling loop when the dialog unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const submit = async (event) => {
    event.preventDefault();
    if (running) return; // re-entrancy guard
    setRunning(true);
    setError(null);
    setJob(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const finished = await downloadCivitaiLora(api, url, {
        onUpdate: setJob,
        signal: controller.signal,
      });
      await onComplete?.(finished);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  const percent = Math.max(0, Math.min(100, Number(job?.percent) || 0));
  const showProgress = running || job || error;

  let statusText = null;
  if (error) {
    statusText = error;
  } else if (job?.status === 'success') {
    const filename = job.result?.filename || 'LoRA';
    const base = job.result?.baseModel ? ` · ${job.result.baseModel}` : '';
    statusText = `${filename} downloaded${base}`;
  } else if (job?.status === 'error') {
    statusText = job.error || 'Download failed.';
  } else if (job) {
    statusText = job.total_bytes
      ? `Downloading ${percent}% · ${formatDownloadBytes(job.downloaded_bytes)} / ${formatDownloadBytes(job.total_bytes)}`
      : 'Preparing download…';
  } else if (running) {
    statusText = 'Resolving Civitai URL…';
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Download LoRA"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="civitai-download-form" loading={running}>
            Download
          </Button>
        </>
      }
    >
      <form id="civitai-download-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Civitai LoRA URL" hint="Paste a civitai.com model or model-version link.">
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
              className={cx('font-mono text-xs', error ? 'text-danger' : 'text-ink2')}
            >
              {statusText}
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-bg3">
              <div
                className={cx(
                  'h-full rounded-full transition-[width] duration-300',
                  error ? 'bg-danger' : 'bg-honey',
                )}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
