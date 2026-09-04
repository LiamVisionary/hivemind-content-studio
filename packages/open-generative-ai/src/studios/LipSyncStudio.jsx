// Lip Sync Studio — React redesign of the retired vanilla studio.
// Pairs a portrait image OR a source video with an audio track and produces a
// lipsynced video through runVideo's processLipSync method. Audio is upload-only
// (no TTS in the original). Model catalog + resolution live in the left panel;
// the input slots, prompt and Generate live in the docked composer.
//
// Port rules honored here:
// - src/lib/** consumed unchanged. processLipSync payload rules preserved exactly:
//   prompt only when model.hasPrompt, resolution only when the model has any,
//   seed:-1 only when model.hasSeed (muapi omits -1 seeds); image_url XOR video_url
//   by mode; audio_url always. onRequestId → savePendingJob the moment a request id
//   is handed back; removePendingJob on BOTH success and error.
// - Crash-safe pending-job resume (pendingJobs 'lipsync') runs once per mount and is
//   StrictMode-idempotent (a mountedOnce ref claims the pass before polling).
// - Preferences persist to 'lipsync_generation_preferences' via the shared
//   normalizer in lib/studioPreferences.js — one definition, which the
//   persistence test exercises directly.
// - History ('lipsync_history', slice 0..30, same entry shape) goes through the
//   studio history helpers in lib/hivemindStudio.js: in studio mode they are
//   no-ops, so a prompt never lands on disk in the clear — the same rule the
//   Image and Video studios follow. Standalone keeps plain localStorage.
// - Every media src goes through useMediaSrc (E2E decrypt, fail-open); the download
//   filename is model-derived (downloadNames.js) through the one shared downloader.
// - alert() → toast.error(); the error no longer hijacks the Generate button label.
//   Result video autoplays MUTED with native controls (an explicit unmute affordance)
//   instead of the old muted=false autoplay browsers block. (Documented deviation.)
// - A portrait picked from the studio's sealed references only exists on this
//   machine; MUAPI fetches by URL, so — exactly like the Image studio — the owner
//   is asked before a decrypted copy is uploaded (lib/cloudReferenceUpload.js).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'react-hot-toast';

import { muapi } from '../lib/muapi.js';
import { adoptCloudOutput } from '../lib/cloudAdopt.js';
import { muapiRow, needsBrowserKey, runVideo } from '../lib/modelRunner.js';
import { lipsyncModels, imageLipSyncModels, videoLipSyncModels, getResolutionsForLipSyncModel } from '../lib/cloudCatalog.js';
import { savePendingJob, removePendingJob, getPendingJobs } from '../lib/pendingJobs.js';
import { downloadMedia } from '../lib/downloadMedia.js';
import { videoDownloadName } from '../lib/downloadNames.js';
import { formatElapsed } from '../lib/genProgress.js';
import { loadStudioGenerationHistory, saveStudioGenerationHistory } from '../lib/hivemindStudio.js';
import { referencesNeedingApproval, resolveCloudReferences } from '../lib/cloudReferenceUpload.js';
import { toastMuapiError, toastMuapiKeyNeeded } from './lipsync/muapiErrorToast.jsx';
import { t } from '../lib/i18n.js';

import { useMediaSrc } from '../hooks/hooks.js';
import { registerPromptInserter, registerStudioSetupLoader } from '../app/promptTarget.js';
import { rememberGenerationSetup } from '../lib/generationSetupStore.js';
import { Icon } from '../ui/icons.jsx';
import {
  Button, Card, EmptyState, IconButton, Pill, ProgressBar, SectionLabel, Segmented, Spinner, StudioLayout, cx,
} from '../ui/kit.jsx';
import { ChipButton, Menu } from '../ui/Menu.jsx';
import { ConfirmModal, Modal } from '../ui/Modal.jsx';

import { UploadPicker } from './UploadPicker.jsx';
import { MetaRow } from './lipsync/MetaRow.jsx';
import { AuthModal } from '../dialogs/AuthModal.jsx';
import { LIPSYNC_PREFERENCES_KEY, normalizeLipSyncPreferences } from '../lib/studioPreferences.js';

const LIPSYNC_HISTORY_KEY = 'lipsync_history';
const LIPSYNC_HISTORY_LIMIT = 30;

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
    imageUploading: false,
    prompt: '',
    history: loadStudioGenerationHistory(LIPSYNC_HISTORY_KEY),
    generating: false,
    startedAt: 0,
    viewerUrl: null,
    authOpen: false,
    resumeRemaining: 0,
    confirmDelete: null,
    // A portrait held only on this machine that the owner has not yet agreed to
    // upload to MUAPI, and the ones already agreed to (per session) — same shape
    // as the Image studio's cloudRefConfirm / cloudRefApproved.
    cloudRefConfirm: null,
    cloudRefApproved: new Set(),
    cloudRefUploads: new Map(),
  };
}

function AudioPreview({ url }) {
  const src = useMediaSrc(url);
  // eslint-disable-next-line jsx-a11y/media-has-caption
  return <audio controls src={src} className="w-full" style={{ height: 34 }} />;
}

// Video / audio upload slot with a tri-state (empty → uploading → ready). Ready state
// shows the filename with an explicit remove control (the old code inverted the tile's
// click to clear, which read as "open/preview") and, for audio, an audition player.
function FileSlot({ kind, label, emptyLabel, icon, url, fileName, uploading, onOpen, onClear }) {
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
          <span>{uploading ? 'Uploading…' : emptyLabel}</span>
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

function LipSyncVideoCard({ entry, active, onOpen, onDownload, onDelete }) {
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
      <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
        <IconButton
          icon="download"
          size="sm"
          label={t('common.download')}
          className="border border-line1 bg-bg0/80 text-ink1 hover:border-line2 hover:bg-bg1"
          onClick={(e) => { e.stopPropagation(); onDownload(); }}
        />
        <IconButton
          icon="trash"
          size="sm"
          label="Remove from history"
          className="border border-line1 bg-bg0/80 text-ink1 hover:border-danger hover:bg-danger-tint hover:text-danger"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        />
      </div>
    </div>
  );
}

function LipSyncViewer({ url, entry, generating, onClose, onNew, onRegenerate, onDownload }) {
  const src = useMediaSrc(url);
  let created = '';
  if (entry?.timestamp) {
    const when = new Date(entry.timestamp);
    created = Number.isNaN(when.getTime()) ? String(entry.timestamp) : when.toLocaleString();
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Lip sync result"
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onNew}>{t('common.new')}</Button>
          <Button
            variant="neutral"
            icon="refresh"
            loading={generating}
            onClick={onRegenerate}
            title="Runs again with the current inputs"
          >
            {t('common.regenerate')}
          </Button>
          {/* The clip the studio could not keep exists here and on a provider
              link that expires. Say it beside the button that saves it. */}
          {entry?.saved === false ? (
            <Pill tone="warn">Not saved — download to keep</Pill>
          ) : null}
          <Button variant="primary" icon="download" onClick={onDownload}>{t('common.download')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid place-items-center overflow-hidden rounded-lg border border-line1 bg-bg0">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={src} controls controlsList="nodownload" loop autoPlay muted playsInline className="max-h-[56vh] w-auto max-w-full object-contain" />
        </div>
        <div className="flex flex-col gap-1.5">
          <MetaRow label="Prompt" value={entry?.prompt} mono={false} />
          <MetaRow label="Model" value={entry?.model} />
          <MetaRow label="Created" value={created} mono={false} />
          {entry?.id ? (
            <div className="flex items-baseline gap-3">
              <span className="w-20 shrink-0 text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">Request id</span>
              <span className="min-w-0 break-all font-mono text-[11px] leading-relaxed text-ink3">{String(entry.id)}</span>
            </div>
          ) : null}
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

  const saveHistory = () => saveStudioGenerationHistory(LIPSYNC_HISTORY_KEY, s.history, LIPSYNC_HISTORY_LIMIT);

  const addToHistory = (entry) => {
    // Seal what made this clip, keyed on the kept output — the same store the
    // Image and Video studios write to, so a clip found in the Library a week
    // later can still say which model and which prompt produced it. In studio
    // mode this list is memory-only by design (a prompt never lands on disk in
    // the clear); the vault is where the settings actually survive.
    if (entry?.url && entry.saved !== false) {
      void rememberGenerationSetup({
        url: entry.url,
        section: 'lipsync',
        mediaType: 'video/*',
        context: { model: entry.model || '', prompt: entry.prompt || '' },
        downloadName: videoDownloadName(entry.model, entry.id),
      });
    }
    s.history.unshift(entry);
    s.history = s.history.slice(0, LIPSYNC_HISTORY_LIMIT);
    saveHistory();
    bump();
  };

  const removeFromHistory = (entry) => {
    s.history = s.history.filter((item) => item !== entry);
    if (s.viewerUrl === entry.url) s.viewerUrl = null;
    saveHistory();
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
    if (needsBrowserKey(muapiRow(s.selectedModel))) {
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
      toastMuapiError(err, { prefix: failLabel });
    } finally {
      setUploading(false);
      bump();
    }
  };

  const uploadVideo = (file) => uploadTo(file, {
    setUploading: (v) => { s.videoUploading = v; },
    setUrl: (u) => { s.uploadedVideoUrl = u; },
    setName: (n) => { s.videoFileName = n; },
    retry: () => videoInputRef.current?.click(),
    failLabel: 'Video upload failed',
  });

  const uploadAudio = (file) => uploadTo(file, {
    setUploading: (v) => { s.audioUploading = v; },
    setUrl: (u) => { s.uploadedAudioUrl = u; },
    setName: (n) => { s.audioFileName = n; },
    retry: () => audioInputRef.current?.click(),
    failLabel: 'Audio upload failed',
  });

  // A portrait dropped on the composer: same upload the picker does, minus the
  // picker's thumbnail/history bookkeeping (the chip still shows the result).
  const uploadPortrait = (file) => uploadTo(file, {
    setUploading: (v) => { s.imageUploading = v; },
    setUrl: (u) => { s.uploadedImageUrl = u; },
    setName: () => {},
    retry: () => uploadPortrait(file),
    failLabel: 'Portrait upload failed',
  });

  const handleVideoFile = async (e) => {
    const file = e.target.files[0];
    if (videoInputRef.current) videoInputRef.current.value = '';
    if (!file) return;
    await uploadVideo(file);
  };

  const handleAudioFile = async (e) => {
    const file = e.target.files[0];
    if (audioInputRef.current) audioInputRef.current.value = '';
    if (!file) return;
    await uploadAudio(file);
  };

  // Files dropped anywhere on the composer, filed by what they are. The window-
  // level restore zone used to catch these and answer "No saved settings found".
  const composerDrop = {
    accepts: (dataTransfer) => Array.from(dataTransfer?.types || []).includes('Files'),
    hint: 'Drop a portrait, clip or audio file',
    onDrop: (dataTransfer) => {
      const files = Array.from(dataTransfer?.files || []);
      if (!files.length) return;
      const kindOf = (file) => {
        const mime = String(file.type || '').toLowerCase();
        if (mime.startsWith('audio/')) return 'audio';
        if (mime.startsWith('video/')) return 'video';
        if (mime.startsWith('image/')) return 'image';
        // An empty MIME (HEIC on some platforms): go by the extension.
        if (/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name)) return 'audio';
        if (/\.(mp4|mov|webm|m4v|mkv)$/i.test(file.name)) return 'video';
        if (/\.(png|jpe?g|webp|heic|heif|avif|gif|bmp|tiff?)$/i.test(file.name)) return 'image';
        return '';
      };
      const picked = { audio: null, video: null, image: null };
      files.forEach((file) => { const kind = kindOf(file); if (kind && !picked[kind]) picked[kind] = file; });
      if (!picked.audio && !picked.video && !picked.image) {
        toast.error('Only an image, a video or an audio file can be attached here.');
        return;
      }
      if (picked.audio) void uploadAudio(picked.audio);
      if (picked.image) {
        if (s.inputMode === 'image') void uploadPortrait(picked.image);
        else toast('Switch Input to Portrait image to attach a picture.');
      }
      if (picked.video) {
        if (s.inputMode === 'video') void uploadVideo(picked.video);
        else toast('Switch Input to Video to attach a clip.');
      }
    },
    busy: s.videoUploading || s.audioUploading || s.imageUploading,
  };

  const generate = async () => {
    const model = getCurrentModel();
    const prompt = s.prompt.trim();

    // Validation (aborts preserved exactly).
    if (!s.uploadedAudioUrl) { toast.error(t('lipsync.noAudioAlert')); return; }
    if (s.inputMode === 'image' && !s.uploadedImageUrl) { toast.error(t('lipsync.noImageAlert')); return; }
    if (s.inputMode === 'video' && !s.uploadedVideoUrl) { toast.error(t('lipsync.noVideoAlert')); return; }
    if (s.generating) return;

    // The shared store counts as having the key; only a machine with neither
    // store nor browser copy is asked for one.
    if (needsBrowserKey(muapiRow(s.selectedModel))) {
      authRetryRef.current = () => generate();
      s.authOpen = true;
      bump();
      return;
    }

    // A portrait held only on this machine (a sealed studio reference, an inline
    // data URL) cannot be fetched by MUAPI: it has to be decrypted here and a
    // plaintext copy uploaded. Stop and ask first; confirming re-enters generate().
    if (s.inputMode === 'image') {
      const awaitingApproval = referencesNeedingApproval([s.uploadedImageUrl], s.cloudRefApproved);
      if (awaitingApproval.length) {
        s.cloudRefConfirm = { sources: awaitingApproval, model: model?.name || s.selectedModel };
        bump();
        return;
      }
    }

    s.generating = true;
    s.startedAt = Date.now();
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
        // Approved above: a local portrait is decrypted and uploaded once (cached
        // per source); an already-public URL passes straight through.
        const [imageUrl] = await resolveCloudReferences([s.uploadedImageUrl], { cache: s.cloudRefUploads });
        lipsyncParams.image_url = imageUrl;
      } else {
        lipsyncParams.video_url = s.uploadedVideoUrl;
      }

      if (prompt && model?.hasPrompt) lipsyncParams.prompt = prompt;

      const resolutions = getResolutionsForLipSyncModel(s.selectedModel);
      if (resolutions.length > 0) lipsyncParams.resolution = s.selectedResolution;

      if (model?.hasSeed) lipsyncParams.seed = -1;

      // Through the one dispatcher, like every other studio: the row decides the
      // transport and `method` names the MUAPI call, so this run gets the same
      // pre-press readiness refusal a T2V or a still already gets.
      const res = await runVideo({
        row: muapiRow(s.selectedModel),
        extra: { muapi: { ...lipsyncParams, method: 'processLipSync' } },
      });

      if (res && res.url) {
        if (capturedRequestId) removePendingJob(capturedRequestId);
        const genId = res.id || capturedRequestId || Date.now().toString();
        // The kept copy, not the provider's link: three minutes of waiting used
        // to survive exactly as long as this tab did, because a MUAPI URL is
        // gone within the day and this studio's own list is memory-only in
        // studio mode. The adopted output is sealed and lists in the Library.
        const kept = res.savedUrl || res.url;
        addToHistory({
          id: genId, url: kept, prompt, model: s.selectedModel,
          saved: Boolean(res.savedUrl), timestamp: new Date().toISOString(),
        });
        s.viewerUrl = kept;
      } else {
        throw new Error('No video URL returned by API');
      }
    } catch (e) {
      if (capturedRequestId) removePendingJob(capturedRequestId);
      console.error(e);
      toastMuapiError(e, { prefix: 'Lip sync failed' });
    } finally {
      s.generating = false;
      s.startedAt = 0;
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

    // Resume the jobs this studio had in flight when the page went away.
    // Named rather than an IIFE so the "Add key" toast can run it again the
    // moment a key is saved, instead of asking for a reload.
    const resumePendingJobs = async () => {
      const pending = getPendingJobs('lipsync');
      if (!pending.length) return;
      if (needsBrowserKey(muapiRow(s.selectedModel))) {
        // Can't poll without a key anywhere — but the jobs stay queued (nothing
        // is dropped), and the toast carries the button that fixes it rather
        // than naming a page to go and find.
        toastMuapiKeyNeeded(
          `${pending.length} pending lip sync ${pending.length === 1 ? 'job is' : 'jobs are'} waiting for a MUAPI key.`,
          {
            onAddKey: () => {
              authRetryRef.current = () => { void resumePendingJobs(); };
              s.authOpen = true;
              bump();
            },
          },
        );
        return;
      }
      s.resumeRemaining = pending.length;
      bump();
      pending.forEach(async (job) => {
        const elapsedAttempts = Math.floor((Date.now() - job.submittedAt) / job.interval);
        const attemptsLeft = Math.max(1, job.maxAttempts - elapsedAttempts);
        try {
          // No key argument: the client resolves its own route, and on a
          // machine that holds the key this browser has none to pass.
          const result = await muapi.pollForResult(job.requestId, '', attemptsLeft, job.interval);
          const url = result.outputs?.[0] || result.url || result.output?.url;
          if (url) {
            // A clip recovered after a reload gets the same keeping a fresh one
            // gets — otherwise the crash-safe resume hands back the one result
            // that is still one relaunch from gone.
            const savedUrl = await adoptCloudOutput(url, {
              kind: 'video', model: job.historyMeta?.model || '', provider: 'muapi',
            });
            addToHistory({
              id: job.requestId, url: savedUrl || url, ...job.historyMeta,
              saved: Boolean(savedUrl), timestamp: new Date().toISOString(),
            });
          } else toast.error('A pending lip sync finished without a video.');
          removePendingJob(job.requestId);
        } catch (e) {
          console.warn('[LipSyncStudio] Pending job failed:', job.requestId, e.message);
          const described = toastMuapiError(e, {
            prefix: "Couldn't recover a pending lip sync — it may have expired",
            onAddKey: () => {
              authRetryRef.current = () => { void resumePendingJobs(); };
              s.authOpen = true;
              bump();
            },
          });
          // A key the provider refused is not a dead job: keep it queued so the
          // resume can run again once the key is fixed. Anything else really is
          // over, and holding it would retry the same failure forever.
          if (!described.keyRejected) removePendingJob(job.requestId);
        } finally {
          s.resumeRemaining -= 1;
          bump();
        }
      });
    };
    void resumePendingJobs();

    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Explore dock / hub bridges insert into this studio's prompt — only while it is
  // the visible studio (studios stay mounted-hidden after first visit). A model
  // with no prompt field has nowhere to put the text: say so instead of taking
  // it into a box that is not on screen.
  useEffect(() => {
    if (!active) return undefined;
    const offInsert = registerPromptInserter((text) => {
      if (!getCurrentModel()?.hasPrompt) {
        toast('This lip sync model has no prompt field — pick one with a prompt to insert text.');
        return;
      }
      const current = s.prompt;
      const needsNewline = current && !current.endsWith('\n');
      s.prompt = `${current}${needsNewline ? '\n' : ''}${text}`;
      bump();
      promptRef.current?.focus();
    });
    // Dragging a kept clip back in, or "Load in Studio" from the Library. The
    // inputs are files that were uploaded for THAT run and are not restorable —
    // the model and the prompt are, and they are what the run is remembered by.
    const offSetup = registerStudioSetupLoader('lipsync', (setup) => {
      const context = setup?.format === 'studio-full-context' ? setup.context : null;
      if (!context) return;
      const model = lipsyncModels.find((entry) => entry.id === context.model);
      if (model) {
        s.inputMode = videoLipSyncModels.some((entry) => entry.id === model.id) ? 'video' : 'image';
        s.selectedModel = model.id;
        applyMode({ preserveSelection: true });
      }
      if (typeof context.prompt === 'string') s.prompt = context.prompt;
      bump();
    });
    return () => { offInsert?.(); offSetup?.(); };
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

  // Elapsed readout on the progress card: MUAPI gives no progress, so time is
  // the only honest thing to show while a clip is out.
  useEffect(() => {
    if (!s.generating) return undefined;
    const id = window.setInterval(bump, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.generating]);

  const model = getCurrentModel();
  const resolutions = getResolutionsForLipSyncModel(s.selectedModel);
  const viewerEntry = s.viewerUrl ? s.history.find((e) => e.url === s.viewerUrl) : null;
  const downloadEntry = (entry) => downloadMedia(entry.url, videoDownloadName(entry.model, entry.id));

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

      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink3">
        <Icon name="cloud" size={12} className="mt-px shrink-0" />
        Runs on MUAPI (cloud) — files you attach are uploaded there.
      </p>
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
            { value: 'video', label: t('common.video') },
          ]}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {s.inputMode === 'image' ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink2">{t('lipsync.portraitImage')}</span>
            <div className="flex items-center gap-2">
              <UploadPicker
                values={s.uploadedImageUrl ? [s.uploadedImageUrl] : []}
                onChange={(urls) => { s.uploadedImageUrl = urls[0] || null; bump(); }}
                uploadFn={(file) => muapi.uploadFile(file)}
                requireApiKey={() => needsBrowserKey(muapiRow(s.selectedModel))}
                maxImages={1}
                accept="image/*"
                label={t('lipsync.portraitImage')}
              />
              {s.imageUploading ? <Spinner size={14} className="text-honey" /> : null}
            </div>
          </div>
        ) : (
          <FileSlot
            kind="video"
            label={t('common.video')}
            emptyLabel="Upload video"
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
          emptyLabel="Upload audio"
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
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void generate(); }
          }}
          className="max-h-[150px] min-h-[52px] w-full resize-none overflow-y-auto rounded-lg border border-line1 bg-bg1 px-3 py-2.5 text-[15px] leading-relaxed text-ink1 outline-none transition-colors placeholder:text-ink3 focus:border-honey/40 md:max-h-[200px]"
        />
      ) : null}

      <div className="flex items-center gap-2">
        <Pill tone="neutral" className="hidden font-mono sm:inline-flex">
          <Icon name="cloud" size={12} />
          {model?.name || '—'}
        </Pill>
        <div className="flex-1" />
        <Button
          variant="primary"
          size="lg"
          loading={s.generating}
          onClick={generate}
          title="Generate (⌘/Ctrl+Enter)"
          className="min-w-[130px]"
        >
          {s.generating ? t('common.generating') : t('common.generate')}
        </Button>
      </div>

      <input ref={videoInputRef} type="file" accept="video/*" className="hidden" onChange={handleVideoFile} />
      <input ref={audioInputRef} type="file" accept="audio/*" className="hidden" onChange={handleAudioFile} />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StudioLayout panel={panel} panelTitle="Lip sync settings" composer={composer} composerDrop={composerDrop}>
        <div className="flex flex-col gap-4 p-4 md:p-5">
          {/* Where this one runs, said before you attach a face rather than in the
              consent dialog that appears once you already have. */}
          <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
            <p className="min-w-[240px] flex-1 text-[13px] leading-relaxed text-ink2">
              Lip sync runs on MUAPI; your files are uploaded there. It needs a MUAPI account.
            </p>
            <Button
              size="sm"
              icon="key"
              onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'passbook' } }))}
            >
              Manage keys
            </Button>
          </Card>

          {s.generating ? (
            <Card className="flex items-center gap-3 p-4">
              <Spinner size={16} className="text-honey" />
              <span className="text-[13px] text-ink2">{t('common.generating')}</span>
              <div className="flex-1"><ProgressBar value={null} label={t('common.generating')} /></div>
              <span className="shrink-0 font-mono text-[11px] text-ink3">{formatElapsed(Date.now() - s.startedAt)}</span>
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
                <SectionLabel>{t('common.history')}</SectionLabel>
                <span className="font-mono text-[11px] text-ink3">{s.history.length}</span>
              </div>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
                {s.history.map((entry, idx) => (
                  <LipSyncVideoCard
                    key={entry.id || `${entry.url}-${idx}`}
                    entry={entry}
                    active={s.viewerUrl ? s.viewerUrl === entry.url : idx === 0}
                    onOpen={() => { s.viewerUrl = entry.url; bump(); }}
                    onDownload={() => downloadEntry(entry)}
                    onDelete={() => { s.confirmDelete = entry; bump(); }}
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
          onDownload={() => (viewerEntry ? downloadEntry(viewerEntry) : downloadMedia(s.viewerUrl, videoDownloadName(s.selectedModel, 'clip')))}
        />
      ) : null}

      <ConfirmModal
        open={Boolean(s.confirmDelete)}
        onClose={() => { s.confirmDelete = null; bump(); }}
        onConfirm={() => { const entry = s.confirmDelete; s.confirmDelete = null; if (entry) removeFromHistory(entry); }}
        title="Remove this clip from history?"
        body="It leaves this studio’s list only — no file is deleted."
        confirmLabel="Remove"
        cancelLabel="Cancel"
      />

      {s.cloudRefConfirm ? (
        <ConfirmModal
          open
          title="Upload this portrait to MUAPI?"
          body={`This portrait is stored privately on this machine. ${s.cloudRefConfirm.model} runs in the cloud and reads it by URL, so continuing uploads a decrypted copy to MUAPI — those bytes leave your machine and are out of your control.`}
          confirmLabel="Upload and generate"
          cancelLabel="Cancel"
          onClose={() => { s.cloudRefConfirm = null; bump(); }}
          onConfirm={() => {
            s.cloudRefConfirm.sources.forEach((source) => s.cloudRefApproved.add(source));
            s.cloudRefConfirm = null;
            bump();
            void generate();
          }}
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
