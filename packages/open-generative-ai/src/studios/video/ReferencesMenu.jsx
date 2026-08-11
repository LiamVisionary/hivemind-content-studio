// One control for every MiniMax H3 reference kind: pictures (<Picture N>),
// voice clips (<Audio N>) and motion clips (<Video N>). Each kind gets its own
// section with one ROW per attached reference — preview, what the model will
// call it, and a remove button — under a dotted "Add …" card. Everything is
// optional and the kinds mix freely; only audio may never be the sole
// reference, which the panel says rather than silently allowing.
//
// Ordering is load-bearing throughout: reference N is the prompt's <Kind N>,
// so rows render (and are sent) in attachment order and removing one renumbers
// the rest in place.
//
// E2E throughout: every attached source is an owner-sealed URL that decrypts
// in-browser for preview (useMediaSrc), and new uploads seal on the way up.
//
// CONTROLLED API:
//   <ReferencesMenu
//     images={[url]}                                  // <Picture N>
//     audios={[{ url, name }]}                        // <Audio N>
//     videos={[{ url, name, useAudio }]}              // <Video N>
//     prompt={string} onPromptChange={(next) => void}  // for the tag button
//     limits={{ images: 9, audios: 3, videos: 3 }}
//     onChange={{ images, audios, videos }}           // one setter per kind
//     uploadFn={async (file) => url | { url }}
//     requireApiKey={() => boolean}
//   />
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { AuthModal } from '../../dialogs/AuthModal.jsx';
import { useMediaSrc } from '../../hooks/hooks.js';
import {
  motionReferenceWarning,
  referenceKindForFile,
  referenceKindsInDrag,
  referenceLabels,
  withMotionRetentionTags,
} from '../../lib/h3References.js';
import {
  fetchHivemindReferences,
  isHivemindStudioEnabled,
  uploadFileToHivemindStudio,
} from '../../lib/hivemindStudio.js';
import { muapi } from '../../lib/muapi.js';
import { getUploadHistory, saveUpload } from '../../lib/uploadHistory.js';
import { useDismissable } from '../../ui/Menu.jsx';
import { Icon } from '../../ui/icons.jsx';
import { SectionLabel, Spinner, cx } from '../../ui/kit.jsx';
import { Thumb } from '../UploadPicker.jsx';
import { zh } from './videoLogic.jsx';

const KINDS = ['images', 'videos', 'audios'];

const KIND_META = {
  images: {
    accept: 'image/*',
    label: () => (zh() ? '图片参考' : 'Image references'),
    add: () => (zh() ? '添加图片参考' : 'Add image reference'),
    tag: (index) => `<Picture ${index + 1}>`,
    icon: 'image',
    hint: () => (zh()
      ? '主体、服装、场景、风格。'
      : 'Subjects, clothing, environments, style.'),
  },
  videos: {
    accept: 'video/*',
    label: () => (zh() ? '动作参考' : 'Motion references'),
    add: () => (zh() ? '添加视频参考' : 'Add video reference'),
    tag: (index) => `<Video ${index + 1}>`,
    icon: 'film',
    hint: () => (zh()
      ? '动作方式：手势幅度、体态、神情。提示词里 <Video N> 的 retention_analysis 决定是照搬动作还是只借用其举止。2-15 秒。'
      : "How a body moves: gesture, posture, mannerisms, expressiveness. The <Video N> retention_analysis tag in your prompt decides whether the motion is copied or only its manner is borrowed. 2-15s."),
  },
  audios: {
    accept: 'audio/*',
    label: () => (zh() ? '声音参考' : 'Voice references'),
    add: () => (zh() ? '添加声音参考' : 'Add voice reference'),
    tag: (index) => `<Audio ${index + 1}>`,
    icon: 'mic',
    hint: () => (zh()
      ? '克隆音色与语气。每段 2-15 秒，合计 15 秒，且不能作为唯一参考。'
      : 'Clones a voice — timbre and delivery. 2-15s each, 15s combined, and never the only reference.'),
  },
};

function fileLabel(item) {
  const name = String(item?.name || '').trim();
  if (!name) return '';
  return name.length > 34 ? `${name.slice(0, 31)}…` : name;
}

// Sealed sources decrypt in-browser, so previews take the resolved blob URL
// exactly like Thumb does — and render a skeleton while that is in flight.
function VideoRowPreview({ url }) {
  const resolved = useMediaSrc(url);
  if (!resolved) return <div className="h-full w-full animate-pulse bg-bg3" aria-label="Decrypting" />;
  return <video src={resolved} muted playsInline preload="metadata" className="h-full w-full object-cover" />;
}

function AudioRowPreview({ url }) {
  const resolved = useMediaSrc(url);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);
  return (
    <button
      type="button"
      disabled={!resolved}
      onClick={() => {
        const element = audioRef.current;
        if (!element) return;
        if (element.paused) { void element.play(); } else { element.pause(); }
      }}
      aria-label={playing ? (zh() ? '暂停' : 'Pause') : (zh() ? '试听' : 'Preview')}
      title={playing ? (zh() ? '暂停' : 'Pause') : (zh() ? '试听' : 'Preview')}
      className="grid h-full w-full place-items-center bg-bg3 text-ink2 transition-colors hover:text-honey disabled:opacity-50"
    >
      {resolved ? <Icon name={playing ? 'pause' : 'play'} size={14} /> : <Spinner size={12} />}
      {resolved ? (
        <audio
          ref={audioRef}
          src={resolved}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          className="hidden"
        />
      ) : null}
    </button>
  );
}

function ReferenceRow({ kind, index, item, label, onRemove, onToggleAudio }) {
  const meta = KIND_META[kind];
  const url = typeof item === 'string' ? item : item?.url;
  const name = fileLabel(item);
  const tag = label?.video || label || meta.tag(index);
  return (
    <div className="flex items-center gap-2 rounded-md border border-line1 bg-bg2 p-1 pr-1.5">
      <div className="h-9 w-9 shrink-0 overflow-hidden rounded border border-line1 bg-bg3">
        {kind === 'images' ? <Thumb src={url} alt={meta.tag(index)} /> : null}
        {kind === 'videos' ? <VideoRowPreview url={url} /> : null}
        {kind === 'audios' ? <AudioRowPreview url={url} /> : null}
      </div>
      <span className="min-w-0 flex-1">
        {/* A picture attached from the saved list carries no filename, so the
            model's label IS the row's name rather than being printed twice. */}
        {name ? <span className="block truncate text-[11px] font-semibold text-ink1">{name}</span> : null}
        <span className={cx('block truncate font-mono text-honey', name ? 'text-[10px]' : 'text-[11px]')}>
          {tag}
          {label?.audio ? <span className="text-ink3">{` + ${label.audio}`}</span> : null}
        </span>
      </span>
      {kind === 'videos' ? (
        <button
          type="button"
          onClick={onToggleAudio}
          title={zh()
            ? '同时使用该片段自带的声音（会额外占用一个 <Audio N> 标签）'
            : "Also condition on this clip's own soundtrack — it takes an <Audio N> label of its own"}
          className={cx(
            'shrink-0 rounded px-1.5 py-1 text-[10px] font-medium transition-colors',
            item?.useAudio ? 'bg-honey-tint text-honey' : 'text-ink3 hover:bg-bg3 hover:text-ink2',
          )}
        >
          {zh() ? '含原声' : 'sound'}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={zh() ? '移除参考' : 'Remove reference'}
        title={zh() ? '移除参考' : 'Remove reference'}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink3 transition-colors hover:bg-bg3 hover:text-ink1"
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

function ReferenceSection({
  kind, items, limit, labels, onAdd, onRemove, onToggleAudio, busy, recent, onPickRecent,
  dropTarget, onWriteTags,
}) {
  const meta = KIND_META[kind];
  const full = items.length >= limit;
  return (
    <div
      className={cx(
        'flex flex-col gap-1.5 rounded-lg border p-1.5 transition-colors',
        // The row a drop is heading for lights up, so the panel tells you where
        // the file lands before you let go of it.
        dropTarget ? 'border-honey bg-honey-tint' : 'border-transparent',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <SectionLabel>{meta.label()}</SectionLabel>
        <span className="flex items-baseline gap-2">
          {onWriteTags && items.length ? (
            <button
              type="button"
              onClick={onWriteTags}
              title={zh()
                ? '把每个动作参考的 retention_analysis 标签写进提示词（含"不要带过来"的说明）'
                : "Write each clip's retention_analysis line into the prompt, including what must not carry"}
              className="rounded px-1.5 py-0.5 text-[10px] font-medium text-ink3 transition-colors hover:bg-honey-tint hover:text-honey"
            >
              {zh() ? '写入标签' : 'Add tags to prompt'}
            </button>
          ) : null}
          <span className="text-[10px] text-ink3">{items.length}/{limit}</span>
        </span>
      </div>
      <p className="text-[10px] leading-snug text-ink3">{meta.hint()}</p>
      {items.map((item, index) => (
        <ReferenceRow
          key={(typeof item === 'string' ? item : item?.url) || index}
          kind={kind}
          index={index}
          item={item}
          label={labels[index]}
          onRemove={() => onRemove(index)}
          onToggleAudio={() => onToggleAudio?.(index)}
        />
      ))}
      <button
        type="button"
        disabled={full || busy}
        onClick={onAdd}
        className={cx(
          'flex h-10 items-center justify-center gap-1.5 rounded-md border border-dashed text-[11px] font-medium transition-colors',
          full || busy
            ? 'cursor-not-allowed border-line1 text-ink3 opacity-50'
            : 'border-line2 text-ink2 hover:border-honey/60 hover:bg-honey-tint hover:text-honey',
        )}
      >
        {busy ? <Spinner size={12} /> : <Icon name="plus" size={12} />}
        {full ? (zh() ? '已达上限' : 'All slots used') : meta.add()}
      </button>
      {!full && recent.length ? (
        <div className="flex flex-wrap gap-1">
          {recent.slice(0, 6).map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => onPickRecent(entry.uploadedUrl)}
              title={entry.name || entry.uploadedUrl}
              className="h-8 w-8 overflow-hidden rounded border border-line1 bg-bg3 transition-colors hover:border-honey/60"
            >
              {kind === 'images'
                ? <Thumb src={entry.uploadedUrl} alt="" />
                : <span className="grid h-full w-full place-items-center text-ink3"><Icon name={meta.icon} size={12} /></span>}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ReferencesMenu({
  images = [],
  audios = [],
  videos = [],
  prompt = '',
  onPromptChange,
  limits = { images: 9, audios: 3, videos: 3 },
  onChange = {},
  uploadFn,
  requireApiKey,
  disabled = false,
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [busyKind, setBusyKind] = useState('');
  const [authOpen, setAuthOpen] = useState(false);
  const [recent, setRecent] = useState({ images: [], videos: [], audios: [] });
  const [dragKinds, setDragKinds] = useState([]);
  const fileInputRef = useRef(null);
  const pendingKindRef = useRef('images');
  // dragenter/dragleave fire for every child element, so a plain boolean
  // flickers as the pointer crosses rows. Count enters instead.
  const dragDepthRef = useRef(0);
  const rootRef = useDismissable(panelOpen, () => setPanelOpen(false));

  const studioMode = isHivemindStudioEnabled();
  const doUpload = uploadFn || (studioMode ? uploadFileToHivemindStudio : (file) => muapi.uploadFile(file));
  const needsKey = typeof requireApiKey === 'function' ? requireApiKey : () => !studioMode;

  useEffect(() => {
    if (!panelOpen) return undefined;
    let alive = true;
    // One request for every kind, partitioned here — the route returns the
    // owner's whole saved-reference list and tags each entry with its medium.
    fetchHivemindReferences({ kind: '' })
      .then((refs) => {
        if (!alive) return;
        const history = getUploadHistory();
        const of = (kind) => refs.filter((entry) => entry.kind === kind);
        setRecent({
          // Pictures also come from this browser's own upload history; clips and
          // voice notes are only ever the owner's saved server-side references.
          images: [...history.filter((entry) => entry.uploadedUrl), ...of('image')],
          videos: of('video'),
          audios: of('audio'),
        });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [panelOpen]);

  const values = { images, videos, audios };
  const labels = referenceLabels({ images, videos, audios });
  const motionWarning = motionReferenceWarning({ prompt, videos });
  const total = images.length + videos.length + audios.length;

  const emit = (kind, next) => onChange[kind]?.(next);

  const attach = (kind, url, name = '') => {
    if (!url) return;
    const current = values[kind];
    if (current.length >= limits[kind]) return;
    if (kind === 'images') emit('images', [...current, url]);
    else if (kind === 'videos') emit('videos', [...current, { url, name, useAudio: false }]);
    else emit('audios', [...current, { url, name }]);
  };

  const openPicker = (kind) => {
    if (needsKey() && !localStorage.getItem('muapi_key')) {
      setAuthOpen(true);
      return;
    }
    pendingKindRef.current = kind;
    if (fileInputRef.current) {
      fileInputRef.current.accept = KIND_META[kind].accept;
      fileInputRef.current.click();
    }
  };

  const uploadInto = async (kind, file) => {
    setBusyKind(kind);
    try {
      const uploaded = await doUpload(file);
      const url = typeof uploaded === 'string' ? uploaded : uploaded?.url;
      if (!url) throw new Error('Upload returned no URL');
      // Only pictures join the shared upload history — it backs the picture
      // grids elsewhere in the studio, which cannot render a clip.
      if (kind === 'images') saveUpload({ uploadedUrl: url, name: file.name });
      return { url, name: file.name };
    } finally {
      setBusyKind('');
    }
  };

  const handleFile = async (file) => {
    if (!file) return;
    const kind = pendingKindRef.current;
    try {
      const uploaded = await uploadInto(kind, file);
      attach(kind, uploaded.url, uploaded.name);
    } catch (err) {
      console.error('[ReferencesMenu] upload failed:', err);
      toast.error(`${zh() ? '参考上传失败' : 'Reference upload failed'}: ${err.message}`);
    }
  };

  // Dropping anywhere in the panel files each item in ITS row — you never have
  // to hit a target. The counts are tracked locally because several files can
  // land in one drop, before React has re-rendered with the first one attached.
  const handleDrop = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragKinds([]);
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    if (needsKey() && !localStorage.getItem('muapi_key')) {
      setAuthOpen(true);
      return;
    }
    const taken = { images: images.length, videos: videos.length, audios: audios.length };
    const added = { images: [], videos: [], audios: [] };
    const rejected = [];
    for (const file of files) {
      const kind = referenceKindForFile(file);
      if (!kind) { rejected.push(file.name); continue; }
      if (taken[kind] >= limits[kind]) { rejected.push(file.name); continue; }
      taken[kind] += 1;
      try {
        added[kind].push(await uploadInto(kind, file));
      } catch (err) {
        console.error('[ReferencesMenu] dropped upload failed:', err);
        rejected.push(file.name);
        taken[kind] -= 1;
      }
    }
    if (added.images.length) emit('images', [...images, ...added.images.map((item) => item.url)]);
    if (added.videos.length) {
      emit('videos', [...videos, ...added.videos.map((item) => ({ ...item, useAudio: false }))]);
    }
    if (added.audios.length) emit('audios', [...audios, ...added.audios]);
    if (rejected.length) {
      toast.error(zh()
        ? `无法作为参考使用：${rejected.join('、')}`
        : `Not usable as a reference: ${rejected.join(', ')}`);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ''; }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => setPanelOpen((open) => !open)}
        title={zh() ? '参考：图片、声音、动作' : 'References: pictures, voice, motion'}
        className={cx(
          'flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors',
          total > 0
            ? 'border-honey/40 bg-honey-tint text-honey'
            : 'border-line1 bg-bg1 text-ink2 hover:border-line2 hover:text-ink1',
          disabled ? 'cursor-not-allowed opacity-50' : '',
        )}
      >
        <Icon name="layers" size={13} />
        {zh() ? '参考' : 'References'}
        {total > 0 ? <span className="tabular-nums">{total}</span> : null}
      </button>

      {panelOpen ? (
        <div
          // The window-level "drag an output back in to restore its settings"
          // zone skips anything inside [data-upload-picker], so marking the
          // panel keeps a reference drop from being read as a settings restore.
          data-upload-picker=""
          onDragEnter={(event) => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault();
            dragDepthRef.current += 1;
            setDragKinds(referenceKindsInDrag(event.dataTransfer));
          }}
          onDragOver={(event) => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDragLeave={() => {
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (!dragDepthRef.current) setDragKinds([]);
          }}
          onDrop={(event) => { dragDepthRef.current = 0; void handleDrop(event); }}
          className={cx(
            'absolute bottom-full left-0 z-40 mb-2 flex max-h-[70vh] w-[320px] flex-col gap-3 overflow-y-auto rounded-lg border bg-bg1 p-2.5 shadow-xl',
            dragDepthRef.current ? 'border-honey/60' : 'border-line1',
          )}
        >
          {KINDS.map((kind) => (
            <ReferenceSection
              key={kind}
              kind={kind}
              items={values[kind]}
              limit={limits[kind]}
              labels={labels[kind]}
              busy={busyKind === kind}
              recent={recent[kind] || []}
              dropTarget={dragKinds.includes(kind)}
              onWriteTags={kind === 'videos' && onPromptChange
                ? () => onPromptChange(withMotionRetentionTags(prompt, videos))
                : null}
              onPickRecent={(url) => attach(kind, url)}
              onAdd={() => openPicker(kind)}
              onRemove={(index) => emit(kind, values[kind].filter((_, i) => i !== index))}
              onToggleAudio={(index) => emit('videos', videos.map((item, i) => (
                i === index ? { ...item, useAudio: !item.useAudio } : item
              )))}
            />
          ))}
          {motionWarning ? (
            <p className="rounded-md border border-honey/40 bg-honey-tint px-2 py-1.5 text-[10px] leading-snug text-honey">
              {motionWarning.kind === 'unnamed'
                ? (zh()
                  ? `提示词里没有出现 ${motionWarning.labels.join('、')}。动作参考若无人指认，模型可能直接照搬片中人物的长相与场景。`
                  : `Your prompt never names ${motionWarning.labels.join(', ')}. An unnamed motion clip tends to bring its own performer — face, clothing and setting — into the shot.`)
                : (zh()
                  ? '写清楚动作参考里哪些东西不能带过来（长相、服装、场景、取景），否则它可能取代你的角色。'
                  : "Say what must NOT carry from the motion clip — its performer's appearance, clothing, setting and framing — or it can replace your subject entirely.")}
            </p>
          ) : null}
          <p className="border-t border-line1 pt-2 text-[10px] leading-snug text-ink3">
            {zh()
              ? '参考模式会取代首尾帧。提示词请用上面显示的标签指代每个参考。'
              : 'Attaching any reference switches the run to Reference mode, replacing the start/end frames. Name each one in your prompt by the label shown above.'}
          </p>
        </div>
      ) : null}

      {authOpen ? (
        <AuthModal
          onClose={() => setAuthOpen(false)}
          onSaved={() => { setAuthOpen(false); openPicker(pendingKindRef.current); }}
        />
      ) : null}
    </div>
  );
}
