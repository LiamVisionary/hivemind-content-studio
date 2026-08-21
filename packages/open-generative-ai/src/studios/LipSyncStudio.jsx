// Lip Sync Studio — React redesign of components/LipSyncStudio.js.
// Pairs a portrait image OR a source video with an audio track and produces a
// lipsynced video via muapi.processLipSync. Audio is upload-only (no TTS in the
// original). Model catalog + resolution live in the left panel; the input slots,
// prompt and Generate live in the docked composer.
//
// Port rules honored here:
// - src/lib/** consumed unchanged. processLipSync payload rules preserved exactly:
//   prompt only when model.hasPrompt, resolution only when the model has any,
//   seed:-1 only when model.hasSeed (muapi omits -1 seeds); image_url XOR video_url
//   by mode; audio_url always. onRequestId → savePendingJob the moment a request id
//   is handed back; removePendingJob on BOTH success and error.
// - Crash-safe pending-job resume (pendingJobs 'lipsync') runs once per mount and is
//   StrictMode-idempotent (a mountedOnce ref claims the pass before polling).
// - Preferences persist to 'lipsync_generation_preferences' via
//   normalizeLipSyncPreferences, extracted to ./lipsync/lipsyncPrefs.js so node:test can
//   import it directly (this file is .jsx and therefore not importable).
// - History persists to 'lipsync_history' (slice 0..30), same entry shape.
// - Every media src goes through useMediaSrc (E2E decrypt, fail-open); the download
//   filename resolves from the unencrypted entry.url so E2E blob URLs still match.
// - alert() → toast.error(); the error no longer hijacks the Generate button label.
//   Result video autoplays MUTED with native controls (an explicit unmute affordance)
//   instead of the old muted=false autoplay browsers block. (Documented deviation.)
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'react-hot-toast';

import { muapi } from '../lib/muapi.js';
import { lipsyncModels, imageLipSyncModels, videoLipSyncModels, getResolutionsForLipSyncModel } from '../lib/models.js';
import { savePendingJob, removePendingJob, getPendingJobs } from '../lib/pendingJobs.js';
import { resolveMediaSrc } from '../lib/e2eMedia.js';
import { downloadMedia } from '../lib/downloadMedia.js';
import { t } from '../lib/i18n.js';

import { useMediaSrc } from '../hooks/hooks.js';
import { registerPromptInserter } from '../app/promptTarget.js';
import { Icon } from '../ui/icons.jsx';
import {
  Button, Card, EmptyState, IconButton, Pill, ProgressBar, SectionLabel, Segmented, Spinner, StudioLayout, cx,
} from '../ui/kit.jsx';
import { ChipButton, Menu } from '../ui/Menu.jsx';
import { Modal } from '../ui/Modal.jsx';

import { UploadPicker } from './UploadPicker.jsx';
import { AuthModal } from '../dialogs/AuthModal.jsx';
import { LIPSYNC_PREFERENCES_KEY, normalizeLipSyncPreferences } from './lipsync/lipsyncPrefs.js';

const LIPSYNC_HISTORY_KEY = 'lipsync_history';

function createEngine() {
  let persisted = null;
  try {
    persisted = normalizeLipSyncPreferences(JSON.parse(localStorage.getItem(LIPSYNC_PREFERENCES_KEY) || 'null'));
  } catch { /* corrupted prefs — boot with defaults */ }
  const inputMode = persisted?.inputMode || 'image';
  const initialModels = inputMode === 'image' ? imageLipSyncModels : videoLipSyncModels;
  const initialModel = initialModels.find((model) => model.id === persisted?.modelId) || initialModels[0];
  const selectedModel = initialModel.id;
  const initialResolutions = getResolutionsForLipSyncModel(selectedModel);
  const selectedResolution = initialResolutions.includes(persisted?.resolution)
    ? persisted.resolution
    : (initialModel.inputs?.resolution?.default || initialResolutions[0] || '');
  let history = [];
  try {
    const saved = JSON.parse(localStorage.getItem(LIPSYNC_HISTORY_KEY) || '[]');
    if (Array.isArray(saved)) history = saved;
  } catch { /* ignore */ }
  return {
    inputMode,
    selectedModel,
    selectedResolution,
    uploadedImageUrl: null,
    uploadedVideoUrl: null,
    uploadedAudioUrl: null,
    videoFileName: '',
    audioFileName: '',
    videoUploading: false,
    audioUploading: false,
    prompt: '',
    history,
    generating: false,
    viewerUrl: null,
    authOpen: false,
    resumeRemaining: 0,
  };
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

function AudioPreview({ url }) {
  const src = useMediaSrc(url);
  // eslint-disable-next-line jsx-a11y/media-has-caption
  return <audio controls src={src} className="w-full" style={{ height: 34 }} />;
}

// Video / audio upload slot with a tri-state (empty → uploading → ready). Ready state
// shows the filename with an explicit remove control (the old code inverted the tile's
// click to clear, which read as "open/preview") and, for audio, an audition player.
function FileSlot({ kind, label, icon, url, fileName, uploading, onOpen, onClear }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink2">{label}</span>
      {url ? (
        <div className="flex flex-col gap-2 rounded-md border border-line1 bg-bg2 p-2">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-honey-tint text-honey">
              <Icon name={icon} size={14} />
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-ink1" title={fileName}>{fileName || 'Ready'}</span>
            <IconButton icon="x" label="Remove" size="sm" onClick={onClear} />
          </div>
          {kind === 'audio' ? <AudioPreview url={url} /> : null}
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          disabled={uploading}
          className="flex h-[52px] items-center justify-center gap-2 rounded-md border border-dashed border-line1 bg-bg2 px-3 text-xs font-medium text-ink2 transition-colors hover:border-line2 hover:text-ink1 disabled:opacity-50"
        >
          {uploading ? <Spinner size={14} className="text-honey" /> : <Icon name={icon} size={16} />}
          <span>{uploading ? 'Uploading…' : `Upload ${label.toLowerCase()}`}</span>
        </button>
      )}
    </div>
  );
}

function LipSyncModelMenu({ models, selectedId, onSelect }) {
  const selected = models.find((m) => m.id === selectedId);
  return (
    <Menu
      width="w-[300px]"
      panelClassName="max-h-[min(420px,60vh)]"
      trigger={(open, toggle) => (
        <ChipButton icon="video" value={selected?.name || '—'} active={open} onClick={toggle} className="w-full max-w-full justify-between" />
      )}
    >
      {(close) =>
        models.map((m) => (
          <button
            key={m.id}
            type="button"
            role="menuitemradio"
            aria-checked={m.id === selectedId}
            onClick={() => { onSelect(m); close(); }}
            className={cx(
              'flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors duration-150',
              m.id === selectedId ? 'bg-honey-tint text-ink1' : 'text-ink2 hover:bg-bg2 hover:text-ink1',
            )}
          >
            <span className="flex w-full items-center gap-2 text-[13px] font-medium">
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              {m.id === selectedId ? <Icon name="check" size={14} className="shrink-0 text-honey" /> : null}
            </span>
            {m.description ? <span className="text-[11px] leading-snug text-ink3">{m.description}</span> : null}
          </button>
        ))
      }
    </Menu>
  );
}

function LipSyncVideoCard({ entry, active, onOpen, onDownload }) {
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
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video src={src} preload="metadata" muted playsInline className="aspect-square w-full object-cover" />
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-bg0/60 text-ink1 opacity-80 transition-opacity group-hover:opacity-100">
          <Icon name="play" size={16} />
        </span>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-bg0/90 to-transparent p-2 pt-6 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        <div className="truncate text-[11px] text-ink1">{entry.prompt || '—'}</div>
        <div className="truncate font-mono text-[10px] text-ink3">{entry.model || ''}</div>
      </div>
      <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        <button
          type="button"
          title={t('lipsync.download')}
          aria-label="Download clip"
          className="grid h-7 w-7 place-items-center rounded-md border border-line1 bg-bg0/80 text-ink1 transition-colors hover:border-line2 hover:bg-bg1"
          onClick={(e) => { e.stopPropagation(); onDownload(); }}
        >
          <Icon name="download" size={13} />
        </button>
      </div>
    </div>
  );
}

function LipSyncViewer({ url, entry, generating, onClose, onNew, onRegenerate, onDownload }) {
  const src = useMediaSrc(url);
  return (
    <Modal
      open
      onClose={onClose}
      title="Lip sync result"
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onNew}>{t('lipsync.new')}</Button>
          <Button variant="neutral" loading={generating} onClick={onRegenerate}>{t('lipsync.regenerate')}</Button>
          <Button variant="primary" onClick={onDownload}>{t('lipsync.download')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid place-items-center overflow-hidden rounded-lg border border-line1 bg-bg0">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={src} controls loop autoPlay muted playsInline className="max-h-[56vh] w-auto max-w-full object-contain" />
        </div>
        <div className="flex flex-col gap-1.5">
          <MetaRow label="Prompt" value={entry?.prompt} />
          <MetaRow label="Model" value={entry?.model} />
          <MetaRow label="Created" value={entry?.timestamp} />
          <MetaRow label="Id" value={entry?.id} />
        </div>
      </div>
    </Modal>
  );
}

export function LipSyncStudio({ active = true } = {}) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = createEngine();
  const s = engineRef.current;
  const [, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);

  const promptRef = useRef(null);
  const videoInputRef = useRef(null);
  const audioInputRef = useRef(null);
  const authRetryRef = useRef(null);
  const mountedOnceRef = useRef(false);

  const getCurrentModels = () => (s.inputMode === 'image' ? imageLipSyncModels : videoLipSyncModels);
  const getCurrentModel = () => lipsyncModels.find((m) => m.id === s.selectedModel);

  const persist = () => {
    const prefs = normalizeLipSyncPreferences({ inputMode: s.inputMode, modelId: s.selectedModel, resolution: s.selectedResolution });
    if (!prefs) return;
    try { localStorage.setItem(LIPSYNC_PREFERENCES_KEY, JSON.stringify(prefs)); } catch { /* quota */ }
  };

  const addToHistory = (entry) => {
    s.history.unshift(entry);
    try { localStorage.setItem(LIPSYNC_HISTORY_KEY, JSON.stringify(s.history.slice(0, 30))); } catch { /* quota */ }
    bump();
  };

  // Re-derive model / resolution when the mode changes (old updateUIForMode). On
  // mount (preserveSelection) it keeps the persisted model; on a mode toggle it
  // snaps to the first model of the new mode.
  const applyMode = ({ preserveSelection = false } = {}) => {
    const models = getCurrentModels();
    const target = preserveSelection ? (models.find((m) => m.id === s.selectedModel) || models[0]) : models[0];
    s.selectedModel = target.id;
    const resolutions = getResolutionsForLipSyncModel(s.selectedModel);
    if (resolutions.length > 0) {
      s.selectedResolution = preserveSelection && resolutions.includes(s.selectedResolution)
        ? s.selectedResolution
        : (target.inputs?.resolution?.default || resolutions[0]);
    }
    persist();
  };

  const setMode = (mode) => {
    if (mode === s.inputMode) return;
    s.inputMode = mode;
    // Switching modes clears the OTHER mode's upload (preserved contract).
    if (mode === 'image') {
      s.uploadedVideoUrl = null;
      s.videoFileName = '';
    } else {
      s.uploadedImageUrl = null;
    }
    applyMode({ preserveSelection: false });
    bump();
  };

  const selectModel = (m) => {
    s.selectedModel = m.id;
    const resolutions = getResolutionsForLipSyncModel(s.selectedModel);
    if (resolutions.length > 0) {
      s.selectedResolution = m.inputs?.resolution?.default || resolutions[0];
    }
    persist();
    bump();
  };

  const uploadTo = async (file, { setUploading, setUrl, setName, retry, failLabel }) => {
    const apiKey = localStorage.getItem('muapi_key');
    if (!apiKey) {
      authRetryRef.current = retry;
      s.authOpen = true;
      bump();
      return;
    }
    setUploading(true);
    bump();
    try {
      const url = await muapi.uploadFile(file);
      setUrl(url);
      setName(file.name);
    } catch (err) {
      toast.error(`${failLabel}: ${err.message}`);
    } finally {
      setUploading(false);
      bump();
    }
  };

  const handleVideoFile = async (e) => {
    const file = e.target.files[0];
    if (videoInputRef.current) videoInputRef.current.value = '';
    if (!file) return;
    await uploadTo(file, {
      setUploading: (v) => { s.videoUploading = v; },
      setUrl: (u) => { s.uploadedVideoUrl = u; },
      setName: (n) => { s.videoFileName = n; },
      retry: () => videoInputRef.current?.click(),
      failLabel: 'Video upload failed',
    });
  };

  const handleAudioFile = async (e) => {
    const file = e.target.files[0];
    if (audioInputRef.current) audioInputRef.current.value = '';
    if (!file) return;
    await uploadTo(file, {
      setUploading: (v) => { s.audioUploading = v; },
      setUrl: (u) => { s.uploadedAudioUrl = u; },
      setName: (n) => { s.audioFileName = n; },
      retry: () => audioInputRef.current?.click(),
      failLabel: 'Audio upload failed',
    });
  };

  const downloadFile = downloadMedia;

  const generate = async () => {
    const model = getCurrentModel();
    const prompt = s.prompt.trim();

    // Validation (aborts preserved exactly).
    if (!s.uploadedAudioUrl) { toast.error(t('lipsync.noAudioAlert')); return; }
    if (s.inputMode === 'image' && !s.uploadedImageUrl) { toast.error(t('lipsync.noImageAlert')); return; }
    if (s.inputMode === 'video' && !s.uploadedVideoUrl) { toast.error(t('lipsync.noVideoAlert')); return; }

    const apiKey = localStorage.getItem('muapi_key');
    if (!apiKey) {
      authRetryRef.current = () => generate();
      s.authOpen = true;
      bump();
      return;
    }

    s.generating = true;
    bump();

    let capturedRequestId = null;
    const historyMeta = { prompt, model: s.selectedModel };

    const onRequestId = (rid) => {
      capturedRequestId = rid;
      savePendingJob({ requestId: rid, studioType: 'lipsync', historyMeta, maxAttempts: 900, interval: 2000, submittedAt: Date.now() });
    };

    try {
      const lipsyncParams = {
        model: s.selectedModel,
        audio_url: s.uploadedAudioUrl,
        onRequestId,
      };

      if (s.inputMode === 'image') {
        lipsyncParams.image_url = s.uploadedImageUrl;
      } else {
        lipsyncParams.video_url = s.uploadedVideoUrl;
      }

      if (prompt && model?.hasPrompt) lipsyncParams.prompt = prompt;

      const resolutions = getResolutionsForLipSyncModel(s.selectedModel);
      if (resolutions.length > 0) lipsyncParams.resolution = s.selectedResolution;

      if (model?.hasSeed) lipsyncParams.seed = -1;

      const res = await muapi.processLipSync(lipsyncParams);

      if (res && res.url) {
        if (capturedRequestId) removePendingJob(capturedRequestId);
        const genId = res.id || capturedRequestId || Date.now().toString();
        addToHistory({ id: genId, url: res.url, prompt, model: s.selectedModel, timestamp: new Date().toISOString() });
        s.viewerUrl = res.url;
      } else {
        throw new Error('No video URL returned by API');
      }
    } catch (e) {
      if (capturedRequestId) removePendingJob(capturedRequestId);
      console.error(e);
      toast.error(`Error: ${e.message}`);
    } finally {
      s.generating = false;
      bump();
    }
  };

  const newClip = () => {
    s.viewerUrl = null;
    s.prompt = '';
    s.uploadedImageUrl = null;
    s.uploadedVideoUrl = null;
    s.uploadedAudioUrl = null;
    s.videoFileName = '';
    s.audioFileName = '';
    bump();
    promptRef.current?.focus();
  };

  // --- Mount: pending-job resume (StrictMode-idempotent) + one-time mode sync ---
  useEffect(() => {
    if (mountedOnceRef.current) return undefined;
    mountedOnceRef.current = true;

    // Sync model/resolution with the persisted selection and re-persist (old
    // queueMicrotask(updateUIForMode({ preserveSelection: true }))).
    applyMode({ preserveSelection: true });

    (async () => {
      const pending = getPendingJobs('lipsync');
      if (!pending.length) return;
      const apiKey = localStorage.getItem('muapi_key');
      if (!apiKey) return; // can't poll without a key; jobs remain for next time
      s.resumeRemaining = pending.length;
      bump();
      pending.forEach(async (job) => {
        const elapsedAttempts = Math.floor((Date.now() - job.submittedAt) / job.interval);
        const attemptsLeft = Math.max(1, job.maxAttempts - elapsedAttempts);
        try {
          const result = await muapi.pollForResult(job.requestId, apiKey, attemptsLeft, job.interval);
          const url = result.outputs?.[0] || result.url || result.output?.url;
          if (url) addToHistory({ id: job.requestId, url, ...job.historyMeta, timestamp: new Date().toISOString() });
        } catch (e) {
          console.warn('[LipSyncStudio] Pending job failed:', job.requestId, e.message);
        } finally {
          removePendingJob(job.requestId);
          s.resumeRemaining -= 1;
          bump();
        }
      });
    })();

    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Explore dock / hub bridges insert into this studio's prompt — only while it is
  // the visible studio (studios stay mounted-hidden after first visit).
  useEffect(() => {
    if (!active) return undefined;
    return registerPromptInserter((text) => {
      const current = s.prompt;
      const needsNewline = current && !current.endsWith('\n');
      s.prompt = `${current}${needsNewline ? '\n' : ''}${text}`;
      bump();
      promptRef.current?.focus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Prompt textarea auto-grow.
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = window.innerWidth < 768 ? 150 : 200;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  });

  const model = getCurrentModel();
  const resolutions = getResolutionsForLipSyncModel(s.selectedModel);
  const viewerEntry = s.viewerUrl ? s.history.find((e) => e.url === s.viewerUrl) : null;

  const panel = (
    <>
      <div className="flex flex-col gap-2">
        <SectionLabel>Model</SectionLabel>
        <LipSyncModelMenu models={getCurrentModels()} selectedId={s.selectedModel} onSelect={selectModel} />
      </div>

      {resolutions.length > 0 ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>Resolution</SectionLabel>
          <Segmented
            size="sm"
            value={s.selectedResolution}
            onChange={(v) => { s.selectedResolution = v; persist(); bump(); }}
            options={resolutions}
          />
        </div>
      ) : null}

      {model?.description ? <p className="text-xs leading-relaxed text-ink3">{model.description}</p> : null}
    </>
  );

  const composer = (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink3">{t('lipsync.input')}</span>
        <Segmented
          value={s.inputMode}
          onChange={setMode}
          options={[
            { value: 'image', label: t('lipsync.portraitImage') },
            { value: 'video', label: t('lipsync.video') },
          ]}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {s.inputMode === 'image' ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink2">{t('lipsync.portraitImage')}</span>
            <div>
              <UploadPicker
                values={s.uploadedImageUrl ? [s.uploadedImageUrl] : []}
                onChange={(urls) => { s.uploadedImageUrl = urls[0] || null; bump(); }}
                uploadFn={(file) => muapi.uploadFile(file)}
                requireApiKey={() => true}
                maxImages={1}
                accept="image/*"
                label={t('lipsync.portraitImage')}
              />
            </div>
          </div>
        ) : (
          <FileSlot
            kind="video"
            label={t('lipsync.video')}
            icon="video"
            url={s.uploadedVideoUrl}
            fileName={s.videoFileName}
            uploading={s.videoUploading}
            onOpen={() => videoInputRef.current?.click()}
            onClear={() => { s.uploadedVideoUrl = null; s.videoFileName = ''; bump(); }}
          />
        )}

        <FileSlot
          kind="audio"
          label="Audio"
          icon="mic"
          url={s.uploadedAudioUrl}
          fileName={s.audioFileName}
          uploading={s.audioUploading}
          onOpen={() => audioInputRef.current?.click()}
          onClear={() => { s.uploadedAudioUrl = null; s.audioFileName = ''; bump(); }}
        />
      </div>

      {model?.hasPrompt ? (
        <textarea
          ref={promptRef}
          rows={2}
          placeholder={t('lipsync.promptPlaceholder')}
          value={s.prompt}
          onChange={(e) => { s.prompt = e.target.value; bump(); }}
          className="max-h-[150px] min-h-[52px] w-full resize-none overflow-y-auto rounded-lg border border-line1 bg-bg1 px-3 py-2.5 text-[15px] leading-relaxed text-ink1 outline-none transition-colors placeholder:text-ink3 focus:border-honey/40 md:max-h-[200px]"
        />
      ) : null}

      <div className="flex items-center gap-2">
        <Pill tone="neutral" className="hidden font-mono sm:inline-flex">
          <Icon name="cloud" size={12} />
          {model?.name || '—'}
        </Pill>
        <div className="flex-1" />
        <Button variant="primary" size="lg" loading={s.generating} onClick={generate} className="min-w-[130px]">
          {s.generating ? t('common.generating') : t('common.generate')}
        </Button>
      </div>

      <input ref={videoInputRef} type="file" accept="video/*" className="hidden" onChange={handleVideoFile} />
      <input ref={audioInputRef} type="file" accept="audio/*" className="hidden" onChange={handleAudioFile} />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StudioLayout panel={panel} panelTitle="Lip sync settings" composer={composer}>
        <div className="flex flex-col gap-4 p-4 md:p-5">
          {s.generating ? (
            <Card className="flex items-center gap-3 p-4">
              <Spinner size={16} className="text-honey" />
              <span className="text-[13px] text-ink2">{t('common.generating')}</span>
              <div className="flex-1"><ProgressBar value={null} /></div>
            </Card>
          ) : null}

          {s.history.length === 0 && !s.generating ? (
            <EmptyState
              icon="mic"
              title="No lip sync clips yet"
              hint="Pick a model, attach a portrait or video plus an audio track, then press Generate."
              className="flex-1"
            />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <SectionLabel>{t('lipsync.history')}</SectionLabel>
                <span className="font-mono text-[11px] text-ink3">{s.history.length}</span>
              </div>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
                {s.history.map((entry, idx) => (
                  <LipSyncVideoCard
                    key={entry.id || `${entry.url}-${idx}`}
                    entry={entry}
                    active={s.viewerUrl ? s.viewerUrl === entry.url : idx === 0}
                    onOpen={() => { s.viewerUrl = entry.url; bump(); }}
                    onDownload={() => downloadFile(entry.url, `lipsync-${entry.id || idx}.mp4`)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </StudioLayout>

      {s.viewerUrl ? (
        <LipSyncViewer
          url={s.viewerUrl}
          entry={viewerEntry}
          generating={s.generating}
          onClose={() => { s.viewerUrl = null; bump(); }}
          onNew={newClip}
          onRegenerate={() => { s.viewerUrl = null; bump(); void generate(); }}
          onDownload={() => downloadFile(s.viewerUrl, `lipsync-${viewerEntry?.id || 'clip'}.mp4`)}
        />
      ) : null}

      {s.authOpen ? (
        <AuthModal
          onClose={() => { s.authOpen = false; authRetryRef.current = null; bump(); }}
          onSaved={() => {
            s.authOpen = false;
            bump();
            const retry = authRetryRef.current;
            authRetryRef.current = null;
            if (retry) retry();
          }}
        />
      ) : null}

      {s.resumeRemaining > 0
        ? createPortal(
          <div className="fixed left-1/2 top-4 z-[200] flex -translate-x-1/2 items-center gap-2.5 rounded-lg border border-line1 bg-bg1 px-4 py-2.5 text-[13px] text-ink1 shadow-pop">
            <Spinner size={14} className="text-honey" />
            <span>{`Resuming ${s.resumeRemaining} pending generation${s.resumeRemaining > 1 ? 's' : ''}…`}</span>
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}
