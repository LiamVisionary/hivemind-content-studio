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
import { useDismissable } from '../../ui/Menu.jsx';
import { Icon } from '../../ui/icons.jsx';
import { Button, SectionLabel, Spinner, cx } from '../../ui/kit.jsx';
import { Thumb } from '../UploadPicker.jsx';

export function FrameSlotsPicker({
  slots = [],
  onSlotChange,
  uploadFn,
  requireApiKey,
  label = 'Frames',
  disabled = false,
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [history, setHistory] = useState(() => getUploadHistory());
  const [serverRefs, setServerRefs] = useState([]);
  const [activeKey, setActiveKey] = useState(slots[0]?.key || 'start');
  const fileInputRef = useRef(null);
  const pendingFileRef = useRef(null);
  const panelRef = useDismissable(panelOpen, () => setPanelOpen(false));

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
      toast.error(`Image upload failed: ${err.message}`);
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

  return (
    <div className={cx('relative inline-flex', disabled && 'opacity-60')}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        disabled={disabled}
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      <button
        type="button"
        disabled={disabled}
        title={setCount ? `${setCount} keyframe${setCount > 1 ? 's' : ''} set` : 'Set start / middle / end frames'}
        onClick={() => setPanelOpen((v) => !v)}
        className={cx(
          'inline-flex h-9 shrink-0 select-none items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors duration-150',
          setCount > 0
            ? 'border-honey/40 bg-bg2 text-ink2 hover:border-honey/60 hover:text-ink1'
            : 'border-line1 bg-bg2 text-ink2 hover:border-line2 hover:text-ink1',
          disabled && 'cursor-not-allowed',
        )}
      >
        {uploading ? <Spinner size={14} className="text-honey" /> : <Icon name="film" size={14} />}
        <span>{label}</span>
        {setCount > 0 ? (
          <span className="grid h-4 min-w-4 place-items-center rounded-full bg-honey px-1 text-[10px] font-bold text-on-honey">
            {setCount}
          </span>
        ) : null}
      </button>

      {panelOpen ? (
        <div
          ref={panelRef}
          className="hive-scale-in absolute bottom-[calc(100%+8px)] left-0 z-50 w-[304px] rounded-lg border border-line1 bg-bg1 p-3 shadow-pop"
        >
          <div className="mb-2.5 border-b border-line1 pb-2.5">
            <SectionLabel>Keyframes</SectionLabel>
            <span className="mt-0.5 block text-[11px] text-ink3">Start, middle, and end frames — all optional</span>
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
                  <button
                    type="button"
                    onClick={() => setActiveKey(slot.key)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={`Select ${slot.label} — then pick a recent upload below`}
                  >
                    <span className="h-10 w-10 shrink-0 overflow-hidden rounded border border-line1 bg-bg3">
                      {slot.url ? (
                        <Thumb src={slot.url} alt={slot.label} />
                      ) : (
                        <span className="grid h-full w-full place-items-center text-ink3">
                          <Icon name="image" size={14} />
                        </span>
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-ink1">{slot.label}</span>
                      <span className="block text-[11px] text-ink3">
                        {slot.url ? 'Selected' : isActive ? 'Pick below or upload' : 'Empty'}
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
            <SectionLabel>Recent uploads</SectionLabel>
            <Button size="sm" icon="upload" onClick={() => fileInputRef.current?.click()}>
              Upload new
            </Button>
          </div>
          {mergedHistory.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-5 text-ink3">
              <Icon name="upload" size={20} />
              <span className="text-xs">No uploads yet</span>
            </div>
          ) : (
            <>
              <div className="mt-2 grid max-h-40 grid-cols-4 gap-2 overflow-y-auto pr-0.5">
                {mergedHistory.map((entry) => {
                  const usedIn = slots.filter((slot) => slot.url === entry.uploadedUrl).map((slot) => slot.label[0]);
                  return (
                    <button
                      type="button"
                      key={entry.id}
                      title={entry.name || `Assign to ${activeKey}`}
                      onClick={() => assign(activeKey, entry.uploadedUrl)}
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
                Selecting <span className="font-medium text-ink2">{slots.find((s) => s.key === activeKey)?.label || 'a frame'}</span> — tap a recent upload to assign it.
              </div>
            </>
          )}
        </div>
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
