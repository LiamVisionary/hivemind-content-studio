// Reference upload picker (React port of the retired vanilla studio).
//
// CONTROLLED API — other studios code against exactly this:
//   <UploadPicker
//     values={string[]}            // selected uploaded URLs (source of truth)
//     onChange={(urls) => void}    // fires on upload / history pick / chip remove
//     uploadFn={async (file) => url | { url, thumbnail? }}   // optional override
//     requireApiKey={() => boolean}
//     maxImages={number}           // 1 = single mode (replace), >1 = multi
//     accept={string}              // file input accept, default 'image/*'
//     disabled={boolean}
//     compact={boolean}            // square icon trigger instead of labelled button
//     label={string}               // trigger label (non-compact)
//     ignored={boolean}            // dims attached chips (e.g. option makes refs unused)
//     chipClassName={string}       // className hook for each attached chip
//     keepOpenOnSelect={boolean}   // single mode: don't close the panel on a pick
//   />
//
// Ported behaviors (see specs/small-components.json):
// - default upload path: muapi.uploadFile, or uploadFileToHivemindStudio in studio mode
// - missing-key gate opens AuthModal; the picked files are retained and processed
//   after the key is saved (same retry-continuation semantics)
// - single mode uploads files[0] and replaces; multi mode uploads remaining slots
//   in parallel and reopens the panel
// - Promise.all([uploadFn(file), generateThumbnail(file)]); uploadFn results are
//   polymorphic (string url | { url, thumbnail })
// - history persisted via uploadHistory (localStorage 'muapi_uploads' capped at 20;
//   encrypted composer uploads in studio mode) gated by isPersistentUploadReference
// - history delete also fires deleteHivemindStudioUpload fire-and-forget (remote
//   reference cleanup, warn on failure) and drops the URL from the selection
// - upload failure: console.error + toast (replaces alert), file input reset
// Restore-a-past-generation is silent by construction: the parent sets `values`
// directly, which never fires onChange (replaces the old setImages({silent}) API).
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { AuthModal } from '../dialogs/AuthModal.jsx';
import { useMediaSrc } from '../hooks/hooks.js';
import {
  deleteHivemindStudioUpload,
  fetchHivemindReferences,
  isHivemindStudioEnabled,
  uploadFileToHivemindStudio,
} from '../lib/hivemindStudio.js';
import { muapi } from '../lib/muapi.js';
import { muapiKeyMissing } from '../lib/modelRunner.js';
import {
  generateThumbnail,
  getUploadHistory,
  isPersistentUploadReference,
  removeUpload,
  saveUpload,
} from '../lib/uploadHistory.js';
import { useDismissable } from '../ui/Menu.jsx';
import { ConfirmModal, Modal } from '../ui/Modal.jsx';
import { Icon } from '../ui/icons.jsx';
import { Button, SectionLabel, Spinner, cx } from '../ui/kit.jsx';
import { toastFailure } from '../ui/failureToast.jsx';

// What a dropped/picked file has to be to get in. MIME first; some browsers
// hand over an empty type for HEIC/AVIF (and for anything dragged out of a
// few apps), so the extension is the fallback — the server accepts the same
// set (control_api.py upload_media_studio_reference).
const KIND_EXTENSIONS = {
  image: /\.(avif|heic|heif|png|jpe?g|webp|gif|bmp|tiff?)$/i,
  video: /\.(mp4|mov|m4v|webm|mkv)$/i,
  audio: /\.(mp3|wav|m4a|aac|ogg|flac|opus|webm)$/i,
};
// Server ceilings (control_api.py: _MAX_PRIVATE_IMAGE_BYTES / _MAX_PRIVATE_VIDEO_BYTES).
// Audio shares the image bucket there. Kept here so the refusal is a plain
// sentence up front instead of an HTTP 413 after the upload.
export const UPLOAD_LIMIT_MB = { image: 32, video: 100, audio: 32 };

// 'image' | 'video' | 'audio' | '' from an accept string like 'image/*'.
export function acceptKind(accept) {
  const prefix = String(accept || '').split('/')[0].trim();
  return ['image', 'video', 'audio'].includes(prefix) ? prefix : '';
}

// Whether one file passes the picker's accept filter: by MIME when the browser
// supplies one, by extension otherwise. An unscoped accept takes anything.
export function fileMatchesAccept(file, accept) {
  if (!accept || accept === '*' || accept === '*/*') return true;
  const kind = acceptKind(accept);
  if (!kind) return true;
  const type = String(file?.type || '').toLowerCase();
  if (type) return type.startsWith(`${kind}/`);
  return KIND_EXTENSIONS[kind].test(String(file?.name || ''));
}

export function fileTooLarge(file, accept) {
  const kind = acceptKind(accept) || 'image';
  const limitMb = UPLOAD_LIMIT_MB[kind] || UPLOAD_LIMIT_MB.image;
  return Number(file?.size) > limitMb * 1024 * 1024 ? limitMb : 0;
}

const KIND_NOUN = { image: 'images', video: 'video clips', audio: 'audio clips' };

export function Thumb({ src, alt = '', className = '' }) {
  const resolved = useMediaSrc(src);
  // Empty while an E2E reference is still decrypting — show a skeleton, not a
  // broken image.
  if (!resolved) {
    return <div className={cx('h-full w-full animate-pulse bg-bg3', className)} aria-label="Decrypting" />;
  }
  return <img src={resolved} alt={alt} className={cx('h-full w-full object-cover', className)} />;
}

// Full-size view of an attached reference/frame. Resolves E2E-sealed sources
// the same way Thumb does, but at the original resolution (never the cached
// thumbnail). Shared with FrameSlotsPicker.
export function ReferencePreview({ url, name, onClose }) {
  const resolved = useMediaSrc(url);
  return (
    <Modal open onClose={onClose} title={name || 'Reference'} size="xl">
      {resolved ? (
        <img src={resolved} alt={name || 'Reference'} className="mx-auto max-h-[70vh] w-full rounded-md object-contain" />
      ) : (
        <div className="grid h-56 w-full animate-pulse place-items-center rounded-md bg-bg3" aria-label="Decrypting" />
      )}
    </Modal>
  );
}

function AttachedChip({ url, name, thumbnail, onRemove, onPreview, disabled, ignored, className = '' }) {
  return (
    <span
      className={cx(
        'group/chip relative inline-flex h-9 shrink-0 items-center gap-1.5 overflow-hidden rounded-md border border-line1 bg-bg2 pr-1 transition-all duration-150',
        ignored ? 'opacity-40 grayscale' : 'hover:border-line2',
        className,
      )}
      title={name || url}
    >
      <button
        type="button"
        onClick={onPreview}
        disabled={disabled}
        aria-label="View full size"
        title="View full size"
        className="group/preview relative h-9 w-9 shrink-0 overflow-hidden border-r border-line1 bg-bg3"
      >
        <Thumb src={thumbnail || url} alt={name || 'Reference'} />
        <span className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover/preview:bg-black/40 group-hover/preview:opacity-100">
          <Icon name="eye" size={12} className="text-white" />
        </span>
      </button>
      {name ? <span className="max-w-[96px] truncate text-[11px] text-ink2">{name}</span> : null}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Remove reference"
        title="Remove reference"
        className="grid h-5 w-5 shrink-0 place-items-center rounded-sm text-ink3 transition-colors hover:bg-bg3 hover:text-ink1 disabled:opacity-40"
      >
        <Icon name="x" size={11} />
      </button>
    </span>
  );
}

export function UploadPicker({
  values = [],
  onChange,
  uploadFn,
  requireApiKey,
  maxImages = 1,
  accept = 'image/*',
  disabled = false,
  compact = false,
  label,
  ignored = false,
  chipClassName = '',
  keepOpenOnSelect = false,
  // Extra actions for the panel's footer — the image composer folds "who is
  // who" and "remove all" in here so attaching is ONE chip rather than three.
  footer = null,
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // dragenter/dragleave fire for every child (chips, the trigger), so a plain
  // boolean flickered as the pointer crossed them. Count enters instead.
  const dragDepthRef = useRef(0);
  // Recent reference awaiting the delete confirm (null = closed).
  const [deleteEntry, setDeleteEntry] = useState(null);
  const [history, setHistory] = useState(() => getUploadHistory());
  // Past uploads saved server-side (sealed) so they reappear even when the
  // browser's composer state is empty. Merged (deduped) into the displayed grid.
  const [serverRefs, setServerRefs] = useState([]);
  // Full-size preview of an attached chip's image.
  const [previewUrl, setPreviewUrl] = useState(null);
  const fileInputRef = useRef(null);
  const pendingFilesRef = useRef(null);
  // The dismissable region wraps the TRIGGER as well as the panel: with it on the
  // panel alone, clicking the open trigger dismissed on pointerdown and the click
  // re-opened it, so the panel could never be closed from its own button.
  // Suspended while a preview is up so closing the preview (scrim click or
  // Escape) doesn't also tear down the panel underneath it.
  const rootRef = useDismissable(panelOpen && !previewUrl && !deleteEntry, () => setPanelOpen(false));

  useEffect(() => {
    let alive = true;
    fetchHivemindReferences().then((refs) => { if (alive) setServerRefs(refs); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const isMulti = maxImages > 1;
  const studioMode = isHivemindStudioEnabled();
  const doUpload =
    uploadFn || (studioMode ? uploadFileToHivemindStudio : (file) => muapi.uploadFile(file));
  // Old default was () => true; studio-mode default uploads go to the local
  // reference store and need no Muapi key, so the default follows the upload path.
  const needsKey =
    typeof requireApiKey === 'function' ? requireApiKey : () => !studioMode;

  // Trim when the max shrinks (old setMaxImages semantics: slice + notify).
  useEffect(() => {
    if (values.length > maxImages) onChange?.(values.slice(0, maxImages));
  }, [maxImages, values, onChange]);

  const refreshHistory = () => setHistory(getUploadHistory());

  const processFiles = async (files) => {
    setUploading(true);
    try {
      if (maxImages === 1) {
        // Single mode: first file only, replace the selection.
        const file = files[0];
        const [uploadResult, thumbnail] = await Promise.all([doUpload(file), generateThumbnail(file)]);
        const uploadedUrl = typeof uploadResult === 'string' ? uploadResult : uploadResult?.url;
        const displayThumbnail =
          typeof uploadResult === 'string' ? thumbnail : uploadResult?.thumbnail || thumbnail;
        const entry = {
          id: Date.now().toString(),
          name: file.name,
          uploadedUrl,
          thumbnail: displayThumbnail,
          timestamp: new Date().toISOString(),
        };
        if (isPersistentUploadReference(uploadedUrl)) saveUpload(entry);
        refreshHistory();
        onChange?.([uploadedUrl]);
      } else {
        // Multi mode: upload all files (up to remaining slots) in parallel.
        const slots = maxImages - values.length;
        const toUpload = files.slice(0, Math.max(slots, 1));
        const results = await Promise.all(
          toUpload.map(async (file) => {
            const [uploadResult, thumbnail] = await Promise.all([doUpload(file), generateThumbnail(file)]);
            const uploadedUrl = typeof uploadResult === 'string' ? uploadResult : uploadResult?.url;
            const displayThumbnail =
              typeof uploadResult === 'string' ? thumbnail : uploadResult?.thumbnail || thumbnail;
            return {
              id: Date.now().toString() + Math.random(),
              name: file.name,
              uploadedUrl,
              thumbnail: displayThumbnail,
              timestamp: new Date().toISOString(),
            };
          }),
        );
        const next = [...values];
        results.forEach((entry) => {
          if (isPersistentUploadReference(entry.uploadedUrl)) saveUpload(entry);
          if (next.length < maxImages) next.push(entry.uploadedUrl);
        });
        refreshHistory();
        onChange?.(next);
        setPanelOpen(true); // reopen so the user sees the selection state
      }
    } catch (err) {
      console.error('[UploadPicker] Upload failed:', err);
      toastFailure(err, { operation: 'Image upload' });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // The one gate every file goes through — picked or dropped. Refusals are
  // said out loud: a silent filter made a dropped HEIC look like nothing
  // happened.
  const admitFiles = (candidates) => {
    const kind = acceptKind(accept) || 'image';
    const noun = KIND_NOUN[kind] || 'images';
    const admitted = [];
    let wrongKind = 0;
    let tooLarge = 0;
    let limitMb = 0;
    for (const file of candidates) {
      if (!fileMatchesAccept(file, accept)) { wrongKind += 1; continue; }
      const over = fileTooLarge(file, accept);
      if (over) { tooLarge += 1; limitMb = over; continue; }
      admitted.push(file);
    }
    if (wrongKind) {
      toast.error(`Only ${noun} can be attached here — ${wrongKind === 1 ? 'one file was' : `${wrongKind} files were`} skipped.`);
    }
    if (tooLarge) {
      toast.error(`${tooLarge === 1 ? 'One file is' : `${tooLarge} files are`} larger than the ${limitMb} MB limit for ${noun} and ${tooLarge === 1 ? 'was' : 'were'} skipped.`);
    }
    return admitted;
  };

  const handleFiles = (fileList) => {
    if (disabled) return;
    const files = admitFiles(Array.from(fileList || []).filter(Boolean));
    if (!files.length) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (needsKey() && muapiKeyMissing()) {
      // Abort and gate behind AuthModal — the files are retained and processed
      // once the key is saved (retry continuation).
      pendingFilesRef.current = files;
      if (fileInputRef.current) fileInputRef.current.value = '';
      setAuthOpen(true);
      return;
    }
    void processFiles(files);
  };

  const onDragEnter = (event) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    if (!disabled) setDragOver(true);
  };
  const onDragLeave = () => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (!dragDepthRef.current) setDragOver(false);
  };
  const onDrop = (event) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);
    if (disabled) return;
    handleFiles(Array.from(event.dataTransfer?.files || []));
  };

  const removeValue = (url) => onChange?.(values.filter((u) => u !== url));

  const toggleFromHistory = (entry) => {
    const url = entry.uploadedUrl;
    const idx = values.indexOf(url);
    if (!isMulti) {
      // Tapping the already-selected reference clears it, and the panel stays open
      // so a replacement can be picked in the same pass.
      if (idx !== -1) {
        onChange?.([]);
        return;
      }
      onChange?.([url]);
      // Models with more than one frame slot keep the panel open — closing after
      // the first pick would make filling the rest a separate trip.
      if (!keepOpenOnSelect) setPanelOpen(false);
      return;
    }
    if (idx !== -1) {
      onChange?.(values.filter((u) => u !== url));
    } else {
      if (values.length >= maxImages) return; // at max — can't select more
      onChange?.([...values, url]);
    }
  };

  const deleteHistoryEntry = (entry) => {
    removeUpload(entry.id);
    // Remote reference cleanup (studio uploads) — fire and forget; a plain
    // muapi/data URL resolves to a no-op inside deleteHivemindStudioUpload.
    Promise.resolve(deleteHivemindStudioUpload(entry.uploadedUrl)).catch((error) => {
      console.warn('[UploadPicker] Remote reference cleanup failed:', error);
    });
    setServerRefs((refs) => refs.filter((r) => r.uploadedUrl !== entry.uploadedUrl));
    refreshHistory();
    if (values.includes(entry.uploadedUrl)) {
      onChange?.(values.filter((u) => u !== entry.uploadedUrl));
    }
  };

  const knownUrls = new Set(history.map((entry) => entry.uploadedUrl));
  const mergedHistory = [...history, ...serverRefs.filter((entry) => !knownUrls.has(entry.uploadedUrl))];
  const historyByUrl = new Map(mergedHistory.map((entry) => [entry.uploadedUrl, entry]));
  const count = values.length;
  const canAddMore = count < maxImages;
  const triggerLabel = label || (isMulti ? `Add up to ${maxImages} images` : 'Reference image');
  // The tooltip/aria-label must carry the picker's role (label prop) — a compact
  // picker renders no visible text, so this is its only name. Two compact pickers
  // side by side (start/end frame) otherwise both announce "Reference image".
  const triggerTitle =
    count === 0
      ? triggerLabel
      : count > 1
        ? canAddMore
          ? `${count} of ${maxImages} images selected — click to manage`
          : `${count} images selected`
        : isMulti && canAddMore
          ? `1 image selected — click to add more (up to ${maxImages})`
          : triggerLabel;

  return (
    <div
      ref={rootRef}
      data-upload-picker=""
      className={cx('relative inline-flex max-w-full flex-wrap items-center gap-1.5', disabled && 'opacity-60')}
      onDragEnter={onDragEnter}
      onDragOver={(e) => { e.preventDefault(); }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        multiple={isMulti}
        className="hidden"
        disabled={disabled}
        onChange={(e) => handleFiles(e.target.files)}
      />

      {/* Attached chips */}
      {values.map((url) => {
        const entry = historyByUrl.get(url);
        return (
          <AttachedChip
            key={url}
            url={url}
            name={entry?.name}
            thumbnail={entry?.thumbnail}
            onRemove={() => removeValue(url)}
            onPreview={() => setPreviewUrl(url)}
            disabled={disabled}
            ignored={ignored}
            className={chipClassName}
          />
        );
      })}

      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        title={triggerTitle}
        aria-label={triggerTitle}
        onClick={() => setPanelOpen((v) => !v)}
        className={cx(
          'inline-flex h-9 shrink-0 select-none items-center justify-center gap-1.5 rounded-md border text-xs font-medium transition-colors duration-150',
          compact ? 'w-9' : 'px-2.5',
          dragOver
            ? 'border-honey bg-honey-tint text-honey'
            : count > 0
              ? 'border-honey/40 bg-bg2 text-ink2 hover:border-honey/60 hover:text-ink1'
              : 'border-line1 bg-bg2 text-ink2 hover:border-line2 hover:text-ink1',
          disabled && 'cursor-not-allowed',
        )}
      >
        {uploading ? (
          <Spinner size={14} className="text-honey" />
        ) : (
          <Icon name={count > 0 && isMulti && canAddMore ? 'plus' : 'upload'} size={14} />
        )}
        {compact ? null : (
          <span className="max-w-[140px] truncate">
            {count > 0 ? (isMulti ? `${count}/${maxImages}` : 'Replace') : triggerLabel}
          </span>
        )}
      </button>

      {/* History / upload panel */}
      {panelOpen ? (
        <div className="hive-scale-in absolute bottom-[calc(100%+8px)] left-0 z-50 w-[288px] rounded-lg border border-line1 bg-bg1 p-3 shadow-pop">
          <div className="mb-2.5 flex items-center justify-between gap-2 border-b border-line1 pb-2.5">
            <div className="min-w-0">
              <SectionLabel>Reference images</SectionLabel>
              {isMulti ? (
                <span className="mt-0.5 block text-[11px] text-ink3">Select up to {maxImages} images</span>
              ) : null}
            </div>
            <Button
              size="sm"
              icon="upload"
              onClick={() => {
                setPanelOpen(false);
                fileInputRef.current?.click();
              }}
            >
              {isMulti ? 'Upload files' : 'Upload new'}
            </Button>
          </div>

          {mergedHistory.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-ink3">
              <Icon name="upload" size={22} />
              <span className="text-xs">No uploads yet</span>
            </div>
          ) : (
            <div className="grid max-h-56 grid-cols-3 gap-2 overflow-y-auto pr-0.5">
              {mergedHistory.map((entry) => {
                const selIdx = values.indexOf(entry.uploadedUrl);
                const isSelected = selIdx !== -1;
                const atMax = isMulti && !isSelected && values.length >= maxImages;
                return (
                  <div
                    key={entry.id}
                    role="button"
                    tabIndex={0}
                    title={isSelected
                      ? `${entry.name || 'Reference'} — click to unselect`
                      : entry.name}
                    onClick={() => {
                      if (!atMax) toggleFromHistory(entry);
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && !atMax) {
                        e.preventDefault();
                        toggleFromHistory(entry);
                      }
                    }}
                    className={cx(
                      'group/cell relative aspect-square overflow-hidden rounded-md border transition-all duration-150',
                      isSelected ? 'border-honey' : 'border-line1 hover:border-line2',
                      atMax ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
                    )}
                  >
                    <Thumb src={entry.thumbnail || entry.uploadedUrl} alt={entry.name} />
                    {isSelected ? (
                      <span className="absolute left-1 top-1 grid h-5 min-w-[20px] place-items-center rounded-full bg-honey px-1 text-[10px] font-bold text-on-honey">
                        {isMulti ? selIdx + 1 : <Icon name="check" size={11} />}
                      </span>
                    ) : null}
                    <span className="absolute inset-x-0 bottom-0 flex justify-end bg-gradient-to-t from-black/60 to-transparent p-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/cell:opacity-100">
                      <button
                        type="button"
                        aria-label="Remove from history"
                        title="Remove from history"
                        onClick={(e) => {
                          e.stopPropagation();
                          // One click on a 20px button used to DELETE the sealed
                          // reference from the server — it asks first now.
                          setDeleteEntry(entry);
                        }}
                        className="grid h-5 w-5 place-items-center rounded-sm bg-danger/80 text-white transition-colors hover:bg-danger"
                      >
                        <Icon name="x" size={10} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {footer ? (
            <div className="mt-2.5 flex flex-col gap-2 border-t border-line1 pt-2.5">{footer}</div>
          ) : null}

          {isMulti && count > 0 ? (
            <div className="mt-2.5 flex items-center justify-between border-t border-line1 pt-2.5">
              <span className="text-xs text-ink2">
                {count} of {maxImages} selected
              </span>
              <Button size="sm" variant="primary" onClick={() => setPanelOpen(false)}>
                Done
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {deleteEntry ? (
        <ConfirmModal
          open
          title="Delete this reference?"
          body="It is removed from this browser and from the studio's saved references."
          confirmLabel="Delete"
          onClose={() => setDeleteEntry(null)}
          onConfirm={() => {
            deleteHistoryEntry(deleteEntry);
            setDeleteEntry(null);
          }}
        />
      ) : null}

      {previewUrl ? (
        <ReferencePreview
          url={previewUrl}
          name={historyByUrl.get(previewUrl)?.name}
          onClose={() => setPreviewUrl(null)}
        />
      ) : null}

      {authOpen ? (
        <AuthModal
          onClose={() => setAuthOpen(false)}
          onSaved={() => {
            const pending = pendingFilesRef.current;
            pendingFilesRef.current = null;
            if (pending?.length) void processFiles(pending);
            else fileInputRef.current?.click();
          }}
        />
      ) : null}
    </div>
  );
}
