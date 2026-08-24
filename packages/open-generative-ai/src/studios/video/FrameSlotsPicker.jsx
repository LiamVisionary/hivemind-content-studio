// One control for the LTX 2.3 first/middle/end keyframes: a single trigger that
// opens ONE popover with Start / Middle / End rows sharing a single recent-uploads
// grid. Replaces the three separate UploadPickers.
//
// E2E throughout: thumbnails decrypt in-browser via useMediaSrc (the shared Thumb),
// new uploads seal to the owner vault, and "recent uploads" includes the owner's
// saved server-side references (also sealed) so past uploads reappear.
//
// CONTROLLED API:
//   <FrameSlotsPicker
//     slots={[{ key, label, url }]}     // each frame slot + its currently-selected URL
//     onSlotChange={(key, url|null) => void}
//     uploadFn={async (file) => url | { url, thumbnail? }}
//     requireApiKey={() => boolean}
//     label={string}                    // trigger label (default "Frames")
//     disabled={boolean}
//     autoOpen={boolean}                // mount with the panel already open
//     inactiveNote={string}             // frames stay editable but are not sent
//                                       // (e.g. character references replace them)
//   />
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { AuthModal } from '../../dialogs/AuthModal.jsx';
import {
  fetchHivemindReferences,
  isHivemindStudioEnabled,
  uploadFileToHivemindStudio,
} from '../../lib/hivemindStudio.js';
import { muapi } from '../../lib/muapi.js';
import {
  generateThumbnail,
  getUploadHistory,
  isPersistentUploadReference,
  saveUpload,
} from '../../lib/uploadHistory.js';
import { ChipButton, useDismissable } from '../../ui/Menu.jsx';
import { Icon } from '../../ui/icons.jsx';
import { Button, SectionLabel, cx } from '../../ui/kit.jsx';
import { ReferencePreview, Thumb } from '../UploadPicker.jsx';
import { zh } from './videoLogic.js';

export function FrameSlotsPicker({
  slots = [],
  onSlotChange,
  uploadFn,
  requireApiKey,
  label = 'Frames',
  disabled = false,
  autoOpen = false,
  inactiveNote = '',
}) {
  // Mounted open when a start-frame pick switched to a model with keyframe slots:
  // this control replaced the plain picker the user had open, so the remaining
  // frames can be set in the same pass instead of after reopening.
  const [panelOpen, setPanelOpen] = useState(autoOpen && !disabled);
  const [uploading, setUploading] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [history, setHistory] = useState(() => getUploadHistory());
  const [serverRefs, setServerRefs] = useState([]);
  const [activeKey, setActiveKey] = useState(slots[0]?.key || 'start');
  // Full-size preview of a set slot, keyed by slot so clearing it mid-view
  // closes the preview with it.
  const [previewSlotKey, setPreviewSlotKey] = useState(null);
  const fileInputRef = useRef(null);
  const pendingFileRef = useRef(null);
  // The dismissable region wraps the TRIGGER as well as the panel: with it on the
  // panel alone, clicking the open trigger dismissed on pointerdown and the click
  // re-opened it, so the panel could never be closed from its own button.
  // Suspended while a preview is up so closing the preview (scrim click or
  // Escape) doesn't also tear down the panel underneath it.
  const rootRef = useDismissable(panelOpen && !previewSlotKey, () => setPanelOpen(false));

  const studioMode = isHivemindStudioEnabled();
  const doUpload =
    uploadFn || (studioMode ? uploadFileToHivemindStudio : (file) => muapi.uploadFile(file));
  const needsKey = typeof requireApiKey === 'function' ? requireApiKey : () => !studioMode;

  useEffect(() => {
    let alive = true;
    fetchHivemindReferences().then((refs) => { if (alive) setServerRefs(refs); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // On open, focus the first empty slot so picking a recent upload fills Start
  // first (not whichever row happened to be active last time).
  useEffect(() => {
    if (!panelOpen) return;
    setActiveKey(slots.find((slot) => !slot.url)?.key || slots[0]?.key || 'start');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen]);

  const refreshHistory = () => setHistory(getUploadHistory());
  const knownUrls = new Set(history.map((entry) => entry.uploadedUrl));
  const mergedHistory = [...history, ...serverRefs.filter((entry) => !knownUrls.has(entry.uploadedUrl))];

  const assign = (key, url) => onSlotChange?.(key, url || null);

  const uploadForActive = async (file) => {
    setUploading(true);
    try {
      const [uploadResult, thumbnail] = await Promise.all([doUpload(file), generateThumbnail(file)]);
      const uploadedUrl = typeof uploadResult === 'string' ? uploadResult : uploadResult?.url;
      const displayThumbnail =
        typeof uploadResult === 'string' ? thumbnail : uploadResult?.thumbnail || thumbnail;
      if (isPersistentUploadReference(uploadedUrl)) {
        saveUpload({
          id: Date.now().toString(),
          name: file.name,
          uploadedUrl,
          thumbnail: displayThumbnail,
          timestamp: new Date().toISOString(),
        });
      }
      refreshHistory();
      assign(activeKey, uploadedUrl);
    } catch (err) {
      console.error('[FrameSlotsPicker] Upload failed:', err);
      toast.error(`${zh() ? '图片上传失败' : 'Image upload failed'}: ${err.message}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFile = (file) => {
    if (!file || disabled) return;
    if (needsKey() && !localStorage.getItem('muapi_key')) {
      pendingFileRef.current = file;
      if (fileInputRef.current) fileInputRef.current.value = '';
      setAuthOpen(true);
      return;
    }
    void uploadForActive(file);
  };

  const setCount = slots.filter((slot) => slot.url).length;
  const activeSlot = slots.find((slot) => slot.key === activeKey);
  const activeLabel = activeSlot?.label || 'frame';
  const previewSlot = previewSlotKey ? slots.find((slot) => slot.key === previewSlotKey) : null;
  // Copy derives from the slots actually offered, so the two-slot start/end
  // variant (H3 FL2VA) never claims a middle frame it doesn't have.
  const slotNames = slots.map((slot) => String(slot.label || slot.key).replace(/\s*[（(].*$/, '').toLowerCase());
  const slotSummary = slotNames.length > 1
    ? `${slotNames.slice(0, -1).join(', ')} and ${slotNames[slotNames.length - 1]}`
    : slotNames[0] || 'frame';
  const triggerTitle = (setCount
    ? `${setCount} keyframe${setCount > 1 ? 's' : ''} set`
    : `Set ${slotNames.join(' / ')} frames`) + (inactiveNote ? ` — ${inactiveNote}` : '');

  return (
    <div ref={rootRef} className={cx('relative inline-flex', disabled && 'opacity-60')}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        disabled={disabled}
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      {/* The same chip primitive as every other composer control (the count
          rides in `value`, the way Shots and Check show theirs), so the row
          reads as one family rather than four trigger styles. */}
      <ChipButton
        icon="film"
        label={label}
        value={setCount > 0 ? String(setCount) : ''}
        active={panelOpen || setCount > 0}
        chevron={false}
        disabled={disabled}
        title={triggerTitle}
        aria-label={triggerTitle}
        aria-expanded={panelOpen}
        onClick={() => setPanelOpen((v) => !v)}
        className={cx(inactiveNote && 'opacity-70 grayscale', uploading && 'animate-pulse')}
      />

      {panelOpen ? (
        <div className="hive-scale-in absolute bottom-[calc(100%+8px)] left-0 z-50 w-[304px] max-w-[calc(100vw-1.5rem)] rounded-lg border border-line1 bg-bg1 p-3 shadow-pop">
          <div className="mb-2.5 border-b border-line1 pb-2.5">
            <SectionLabel>{zh() ? '关键帧' : 'Keyframes'}</SectionLabel>
            <span className="mt-0.5 block text-[11px] text-ink3">{zh() ? `${slotSummary} — 均为可选` : `${slotSummary[0].toUpperCase()}${slotSummary.slice(1)} frames — all optional`}</span>
            {inactiveNote ? (
              <span className="mt-1 block text-[11px] font-medium text-honey">{inactiveNote}</span>
            ) : null}
          </div>

          {/* Slot rows */}
          <div className="flex flex-col gap-1.5">
            {slots.map((slot) => {
              const isActive = slot.key === activeKey;
              return (
                <div
                  key={slot.key}
                  className={cx(
                    'flex items-center gap-2 rounded-md border p-1.5 transition-colors',
                    isActive ? 'border-honey/50 bg-honey-tint' : 'border-line1 hover:border-line2',
                  )}
                >
                  {slot.url ? (
                    // A set frame's thumbnail opens the full-size preview; the
                    // text half of the row still selects the slot.
                    <button
                      type="button"
                      title="View full size"
                      onClick={() => setPreviewSlotKey(slot.key)}
                      className="group/thumb relative h-10 w-10 shrink-0 overflow-hidden rounded border border-line1 bg-bg3"
                    >
                      <Thumb src={slot.url} alt={slot.label} />
                      <span className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover/thumb:bg-black/40 group-hover/thumb:opacity-100">
                        <Icon name="eye" size={13} className="text-white" />
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      title={`Select ${slot.label} — then pick a recent upload below`}
                      onClick={() => setActiveKey(slot.key)}
                      className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded border border-line1 bg-bg3 text-ink3"
                    >
                      <Icon name="image" size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setActiveKey(slot.key)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={`Select ${slot.label} — then pick a recent upload below`}
                  >
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-ink1">{slot.label}</span>
                      <span className="block text-[11px] text-ink3">
                        {slot.url
                          ? (zh() ? '已选择 — 点击图片查看' : 'Selected — tap image to view')
                          : isActive ? (zh() ? '在下方选择或上传' : 'Pick below or upload') : (zh() ? '空' : 'Empty')}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    title={`Upload an image for the ${slot.label.toLowerCase()} frame`}
                    onClick={() => {
                      setActiveKey(slot.key);
                      fileInputRef.current?.click();
                    }}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-ink3 transition-colors hover:bg-bg3 hover:text-ink1"
                  >
                    <Icon name="upload" size={13} />
                  </button>
                  {slot.url ? (
                    <button
                      type="button"
                      title={`Clear the ${slot.label.toLowerCase()} frame`}
                      onClick={() => assign(slot.key, null)}
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-ink3 transition-colors hover:bg-bg3 hover:text-ink1"
                    >
                      <Icon name="x" size={13} />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>

          {/* Recent uploads (shared) */}
          <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line1 pt-2.5">
            <SectionLabel>{zh() ? '最近上传' : 'Recent uploads'}</SectionLabel>
            <Button size="sm" icon="upload" onClick={() => fileInputRef.current?.click()}>
              {zh() ? '上传新图片' : 'Upload new'}
            </Button>
          </div>
          {mergedHistory.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-5 text-ink3">
              <Icon name="upload" size={20} />
              <span className="text-xs">{zh() ? '还没有上传' : 'No uploads yet'}</span>
            </div>
          ) : (
            <>
              <div className="mt-2 grid max-h-40 grid-cols-4 gap-2 overflow-y-auto pr-0.5">
                {mergedHistory.map((entry) => {
                  const usedIn = slots.filter((slot) => slot.url === entry.uploadedUrl).map((slot) => slot.label[0]);
                  // Tapping the image already in the selected slot clears that slot,
                  // so a frame can be dropped without hunting for the row's ✕.
                  const inActiveSlot = activeSlot?.url === entry.uploadedUrl;
                  return (
                    <button
                      type="button"
                      key={entry.id}
                      title={`${entry.name || 'Reference'} — ${inActiveSlot
                        ? `click to clear the ${activeLabel.toLowerCase()} frame`
                        : `click to use as the ${activeLabel.toLowerCase()} frame`}`}
                      onClick={() => assign(activeKey, inActiveSlot ? null : entry.uploadedUrl)}
                      className={cx(
                        'group/cell relative aspect-square overflow-hidden rounded-md border transition-colors',
                        usedIn.length ? 'border-honey' : 'border-line1 hover:border-honey/60',
                      )}
                    >
                      <Thumb src={entry.thumbnail || entry.uploadedUrl} alt={entry.name} />
                      {usedIn.length ? (
                        <span className="absolute left-0.5 top-0.5 grid h-4 place-items-center rounded-full bg-honey px-1 text-[9px] font-bold uppercase text-on-honey">
                          {usedIn.join('')}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 text-[11px] text-ink3">
                {zh() ? '正在设置 ' : 'Selecting '}<span className="font-medium text-ink2">{activeLabel}</span>
                {zh() ? ' — 点击最近上传即可指定' : ' — tap a recent upload to assign it'}
                {activeSlot?.url ? (zh() ? '，或点击高亮的那张以清除' : ', or tap the highlighted one to clear it') : ''}.
              </div>
            </>
          )}
        </div>
      ) : null}

      {previewSlot?.url ? (
        <ReferencePreview
          url={previewSlot.url}
          name={previewSlot.label}
          onClose={() => setPreviewSlotKey(null)}
        />
      ) : null}

      {authOpen ? (
        <AuthModal
          onClose={() => setAuthOpen(false)}
          onSaved={() => {
            const pending = pendingFileRef.current;
            pendingFileRef.current = null;
            if (pending) void uploadForActive(pending);
            else fileInputRef.current?.click();
          }}
        />
      ) : null}
    </div>
  );
}
