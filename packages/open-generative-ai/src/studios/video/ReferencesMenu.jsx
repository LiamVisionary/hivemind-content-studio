// One control for every MiniMax H3 reference kind: pictures (<Picture N>),
// voice clips and motion clips. Each kind gets its own
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
//     videos={[{ url, name, useAudio, compact }]}     // <Video N>
//     prompt={string} onWeave={() => void}  // for the Weave button
//     limits={{ images: 9, audios: 3, videos: 3 }}
//     onChange={{ images, audios, videos }}           // one setter per kind
//     persona={{ id, name } | null}                   // the loaded Hive Persona ID
//     onPersonaChange={(next|null) => void}
//     onOpenClip={(index) => void}                  // head replacement, from a clip's thumbnail
//     uploadFn={async (file) => url | { url }}
//     requireApiKey={() => boolean}
//   />
//
// A Hive Persona ID is a NAME for the set of references above — see PersonaBar.
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { AuthModal } from '../../dialogs/AuthModal.jsx';
import { ClipPrepDialog } from '../../dialogs/ClipPrepDialog.jsx';
import { measureAll, peekMediaDuration } from '../../lib/mediaDuration.js';
import { useMediaSrc } from '../../hooks/hooks.js';
import {
  isSoundOnlyReference,
  motionReferenceRows,
  motionReferenceWarning,
  referenceAttachIndex,
  referenceKindsInDrag,
  referenceLabels,
  referenceBudgetReport,
  referenceRowKeys,
  referenceUrl,
  referenceVideoCompactLocked,
  unscriptedTimeWarning,
} from '../../lib/h3References.js';
import {
  attachDroppedReferences,
  referenceUploader,
} from '../../lib/referenceDrop.js';
import {
  backfillHivemindReferencePoster,
  fetchHivemindReferences,
  isHivemindStudioEnabled,
  uploadFileToHivemindStudio,
} from '../../lib/hivemindStudio.js';
import { peekResolvedMediaSrc, resolveMediaSrc, revokeResolvedMedia } from '../../lib/e2eMedia.js';
import { captureImagePoster, captureVideoPoster } from '../../lib/mediaPoster.js';
import { warmReferencePosters } from '../../lib/referencePosterWarmup.js';
import { muapi } from '../../lib/muapi.js';
import { muapiKeyMissing } from '../../lib/modelRunner.js';
import { getUploadHistory } from '../../lib/uploadHistory.js';
import { ChipButton, useDismissable } from '../../ui/Menu.jsx';
import { Icon } from '../../ui/icons.jsx';
import { IconButton, SectionLabel, Spinner, cx } from '../../ui/kit.jsx';
import { PersonaBar } from './PersonaBar.jsx';
import { ReferenceThumb } from './ReferenceThumb.jsx';
import { KIND_META, describeReferenceRejection, plainReferenceLabel } from './referenceKinds.js';
import { zh } from './videoLogic.js';
import { toastFailure } from '../../ui/failureToast.jsx';

// Scene sits directly under the character pictures because that is where its
// <Picture N> labels continue from: one row, numbered in order of supply, shown
// as two sections because what each contributes is a different promise.
const KINDS = ['images', 'scene', 'videos', 'audios'];

/** A place or a staging sheet — the two things a non-subject picture can be. */
export const SCENE_ROLES = Object.freeze([
  { id: 'attribute_transfer', label: () => (zh() ? '地点' : 'A place') },
  { id: 'weak_reference', label: () => (zh() ? '分镜' : 'Staging') },
]);

function fileLabel(item) {
  const name = String(item?.name || '').trim();
  if (!name) return '';
  return name.length > 34 ? `${name.slice(0, 31)}…` : name;
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

// One switch of the motion row's control strip: pressed = on, in the same
// honey tint the other toggles use; disabled switches say why in their title.
function RowSwitch({ on, disabled = false, title, onClick, children }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={!disabled && Boolean(on)}
      onClick={onClick}
      title={title}
      className={cx(
        'rounded px-2 py-1 text-[10px] font-medium transition-colors',
        disabled
          ? 'cursor-not-allowed text-ink3 opacity-50'
          : (on ? 'bg-honey-tint text-honey' : 'text-ink3 hover:bg-bg3 hover:text-ink2'),
      )}
    >
      {children}
    </button>
  );
}

function ReferenceRow({
  kind, index, item, label, posterUrl, onPosterCaptured, onRemove, onToggleAudio, onToggleMotion, onToggleCompact,
  compactLocked = false, onPrep, onOpen, role = '', onRole,
}) {
  const meta = KIND_META[kind];
  const url = typeof item === 'string' ? item : item?.url;
  const name = fileLabel(item);
  const soundOnly = kind === 'videos' && isSoundOnlyReference(item);
  const motionOn = kind === 'videos' && !soundOnly;
  const soundOn = kind === 'videos' && (soundOnly || Boolean(item?.useAudio));
  // What the model will call this row: a motion clip is its <Video N> (plus
  // its soundtrack's <Audio N> when that is on); a sound-only row is just the
  // <Audio N> its soundtrack takes.
  const primaryTag = typeof label === 'string' ? label : (label?.video || label?.audio || meta.tag(index));
  const secondaryTag = typeof label === 'object' && label?.video && label?.audio ? label.audio : '';
  const removeButton = (
    <IconButton
      icon="x"
      size="xs"
      label={zh() ? '移除参考' : 'Remove reference'}
      onClick={onRemove}
      className="shrink-0 text-ink3"
    />
  );
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line1 bg-bg2 p-1 pr-1.5">
      <div className="flex items-center gap-2">
        {/* A motion clip's thumbnail is the door to head replacement: click it
            and the clip opens with scrubbing and the mask editor over it. The
            other kinds have nothing to open, so their tile stays a plain
            preview rather than a button that does nothing. */}
        <div className={cx(
          'group/thumb relative h-9 w-9 shrink-0 overflow-hidden rounded border border-line1 bg-bg3',
          onOpen ? 'cursor-pointer' : '',
        )}>
          {kind === 'images' || kind === 'scene' || kind === 'videos' ? (
            <ReferenceThumb
              url={url}
              posterUrl={posterUrl}
              kind={kind === 'videos' ? 'video' : 'image'}
              alt={plainReferenceLabel(meta.tag(index))}
              icon={meta.icon}
              onPosterCaptured={onPosterCaptured}
            />
          ) : null}
          {kind === 'audios' ? <AudioRowPreview url={url} /> : null}
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              title={zh()
                ? '打开该片段：拖动播放并遮罩要替换的头部'
                : 'Open this clip — scrub it and mask the head to replace'}
              aria-label={zh() ? '打开并遮罩该片段' : 'Open and mask this clip'}
              className="absolute inset-0 grid place-items-center bg-bg0/70 text-ink1 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/thumb:opacity-100"
            >
              <Icon name="expand" size={13} />
            </button>
          ) : null}
        </div>
        <span className="min-w-0 flex-1">
          {/* A picture attached from the saved list carries no filename, so the
              model's label IS the row's name rather than being printed twice. */}
          {name ? <span className="block truncate text-[11px] font-semibold text-ink1">{name}</span> : null}
          {/* The row's NAME is plain words; the model's token for it is the
              hover title, where somebody writing tags by hand can find it. */}
          <span
            className={cx('block truncate text-honey', name ? 'text-[10px]' : 'text-[11px]')}
            title={[primaryTag, secondaryTag].filter(Boolean).join(' + ')}
          >
            {plainReferenceLabel(primaryTag)}
            {secondaryTag ? <span className="text-ink3">{` + ${plainReferenceLabel(secondaryTag)}`}</span> : null}
            {soundOnly ? <span className="ml-1 font-sans text-ink3">{zh() ? '仅声音' : 'sound only'}</span> : null}
            {kind === 'scene' ? (
              <span className="ml-1 font-sans text-ink3">
                {(role || 'attribute_transfer') === 'weak_reference'
                  ? (zh() ? '分镜方向' : 'staging direction')
                  : (zh() ? '地点' : 'the place')}
              </span>
            ) : null}
            {!soundOnly && item?.compact && !compactLocked ? <span className="ml-1 font-sans text-ink3">{zh() ? '小尺寸' : 'small'}</span> : null}
          </span>
        </span>
        {/* Motion rows carry their switches on a strip of their own below;
            pictures and voice clips have nothing to switch, so the remove
            button stays on the line. */}
        {kind !== 'videos' && kind !== 'scene' ? removeButton : null}
      </div>
      {/* A scene picture's one decision, on the row itself: is this the PLACE,
          or is it staging direction? It is the difference between "the room,
          its light and its layout carry" and "read the order of the action and
          copy none of it", and it used to be reachable only from a chip in
          another control. */}
      {kind === 'scene' ? (
        <div className="flex items-center gap-1 pl-11">
          {SCENE_ROLES.map((option) => (
            <RowSwitch
              key={option.id}
              on={(role || 'attribute_transfer') === option.id}
              title={KIND_META.scene.hint()}
              onClick={() => onRole?.(option.id)}
            >
              {option.label()}
            </RowSwitch>
          ))}
          <span className="flex-1" />
          {removeButton}
        </div>
      ) : null}
      {kind === 'videos' ? (
        <div className="hive-edge-fade flex items-center gap-1 overflow-x-auto pl-11">
          {/* What of the clip is used. MOTION is its movement;
              SOUND is its soundtrack. Both on = the clip with its
              own sound; sound alone = a voice reference whose pixels are never
              sent; one of the two always stays on. */}
          <RowSwitch
            on={motionOn}
            onClick={onToggleMotion}
            title={motionOn
              ? (zh()
                ? '使用该片段的动作。关闭后只使用声音：片段成为音色参考，画面不会发送。'
                : "Use this clip's movement. Switch off for sound only: the clip becomes a voice reference and its pixels are never sent.")
              : (zh()
                ? '重新使用该片段的动作'
                : "Use this clip's movement again")}
          >
            {zh() ? '动作' : 'Motion'}
          </RowSwitch>
          <RowSwitch
            on={soundOn}
            onClick={onToggleAudio}
            title={soundOnly
              ? (zh()
                ? '仅声音：该片段的原声是音色参考。关闭后恢复为动作参考。'
                : "Sound only: this clip's soundtrack is a voice reference. Switch off to go back to motion.")
              : (zh()
                ? '同时使用该片段自带的声音（会额外占用一个声音位）'
                : "Also condition on this clip's own soundtrack — it takes a voice slot of its own")}
          >
            {zh() ? '声音' : 'Sound'}
          </RowSwitch>
          {/* Staging size. A MOTION clip carries the same movement staged 384 px
              wide as at the node's full canvas, for about a third of the
              sequence rows and half the step time (referenceVideoCanvas has
              the numbers). Held off while no picture is attached, because then
              this clip is the character reference and identity needs pixels —
              and off for a sound-only row, which sends no pixels at all. */}
          <RowSwitch
            on={!compactLocked && motionOn && Boolean(item?.compact)}
            disabled={compactLocked || !motionOn}
            onClick={onToggleCompact}
            title={!motionOn
              ? (zh() ? '仅声音的参考不发送画面。' : 'A sound-only reference sends no pixels.')
              : compactLocked
                ? (zh()
                  ? '没有附加图片时，该片段就是角色参考——身份需要像素，紧凑模式不可用。'
                  : 'Off while no picture is attached: this clip is the character reference, and identity needs pixels.')
                : (zh()
                  ? '以小尺寸（384 px）送入该片段——动作相同，开销约为三分之一。片段作为角色参考时不可用。'
                  : 'Stage this clip small (384 px) — same motion, 3x cheaper. Off when the clip is the character reference.')}
          >
            {zh() ? '小尺寸（更省）' : 'Small (cheaper)'}
          </RowSwitch>
          <span className="flex-1" />
          {onPrep ? (
            <button
              type="button"
              onClick={onPrep}
              title={zh()
                ? '在本机裁剪、压缩这段参考——更短更小的参考会释放完整的生成时长'
                : 'Trim, crop and compress this reference on this device — a shorter, smaller reference frees the full generation range'}
              className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] font-medium text-ink3 transition-colors hover:bg-bg3 hover:text-ink1"
            >
              <Icon name="scissors" size={11} />
              {zh() ? '裁剪' : 'Trim'}
            </button>
          ) : null}
          {removeButton}
        </div>
      ) : null}
    </div>
  );
}

export function ReferenceSection({
  kind, items, limit, labels, onAdd, onRemove, onToggleAudio, onToggleMotion, onToggleCompact, onOpen, compactLocked = false,
  busy, recent, onPickRecent, dropTarget, posters = {}, onPosterCaptured, onPrep,
  // Character pictures and scene pictures share ONE row of slots (they are one
  // <Picture N> sequence), so both sections count against the same total.
  used = null, roles = {}, onRole,
}) {
  const meta = KIND_META[kind];
  const taken = used == null ? items.length : used;
  const full = taken >= limit;
  const rowKeys = referenceRowKeys(items);
  return (
    <div
      className={cx(
        'flex flex-col gap-1.5 rounded-lg border p-1.5 transition-colors',
        // The row a drop is heading for lights up, so the panel tells you where
        // the file lands before you let go of it.
        dropTarget ? 'border-honey bg-honey-tint' : 'border-transparent',
      )}
    >
      {/* No Weave button here: the weave lives in Prompt Check and on the
          cast strip, and a third copy read as three different features. The
          kind's long explanation is the Add button's title, not a paragraph
          under every heading. */}
      <div className="flex items-baseline justify-between gap-2">
        <SectionLabel>{meta.label()}</SectionLabel>
        {/* A shared row says both numbers: how many are in THIS section, and
            how much of the one picture budget is spoken for. "2 of 4/9" read as
            arithmetic nobody could parse. */}
        <span
          className="text-[10px] text-ink3"
          title={used == null ? undefined : (zh()
            ? '角色图与场景图共用同一组图片位'
            : 'Character pictures and scene pictures share one row of slots')}
        >
          {used == null ? `${items.length}/${limit}` : `${items.length} · ${taken}/${limit}`}
        </span>
      </div>
      {items.map((item, index) => (
        <ReferenceRow
          key={rowKeys[index]}
          kind={kind}
          index={index}
          item={item}
          label={labels[index]}
          posterUrl={posters[typeof item === 'string' ? item : item?.url] || null}
          onPosterCaptured={onPosterCaptured}
          onRemove={() => onRemove(index)}
          onToggleAudio={() => onToggleAudio?.(index)}
          onToggleMotion={() => onToggleMotion?.(index)}
          onToggleCompact={() => onToggleCompact?.(index)}
          compactLocked={compactLocked}
          onOpen={kind === 'videos' && onOpen ? () => onOpen(index) : null}
          onPrep={onPrep ? () => onPrep(index) : null}
          role={roles[typeof item === 'string' ? item : item?.url] || ''}
          onRole={onRole ? (next) => onRole(typeof item === 'string' ? item : item?.url, next) : null}
        />
      ))}
      <button
        type="button"
        disabled={full || busy}
        onClick={onAdd}
        title={meta.hint()}
        className={cx(
          'flex h-9 items-center justify-center gap-1.5 rounded-md border border-dashed text-[11px] font-medium transition-colors',
          full || busy
            ? 'cursor-not-allowed border-line1 text-ink3 opacity-50'
            : 'border-line2 text-ink2 hover:border-honey/60 hover:bg-honey-tint hover:text-honey',
        )}
      >
        {busy ? <Spinner size={12} /> : <Icon name="plus" size={12} />}
        {full ? (zh() ? '已达上限' : 'All slots used') : meta.add()}
      </button>
      {!full && recent.length ? (
        // Saved clips and voice notes get a wider tile with their filename:
        // six identical film icons told you nothing about which clip was which,
        // which is the one thing this list exists to answer.
        <div className={cx('flex gap-1', kind === 'images' || kind === 'scene' ? 'flex-wrap' : 'flex-col')}>
          {recent.slice(0, 6).map((entry) => (kind === 'images' || kind === 'scene' ? (
            <button
              key={entry.id}
              type="button"
              onClick={() => onPickRecent(entry.uploadedUrl)}
              title={entry.name || entry.uploadedUrl}
              className="h-8 w-8 overflow-hidden rounded border border-line1 bg-bg3 transition-colors hover:border-honey/60"
            >
              <ReferenceThumb
                url={entry.uploadedUrl}
                posterUrl={entry.posterUrl || posters[entry.uploadedUrl] || null}
                kind="image"
                onPosterCaptured={onPosterCaptured}
              />
            </button>
          ) : (
            <button
              key={entry.id}
              type="button"
              onClick={() => onPickRecent(entry.uploadedUrl)}
              title={entry.name || entry.uploadedUrl}
              className="flex items-center gap-1.5 overflow-hidden rounded border border-line1 bg-bg2 p-0.5 pr-1.5 text-left transition-colors hover:border-honey/60"
            >
              <span className="h-8 w-8 shrink-0 overflow-hidden rounded bg-bg3">
                {kind === 'videos'
                  ? <ReferenceThumb url={entry.uploadedUrl} posterUrl={entry.posterUrl || posters[entry.uploadedUrl] || null} icon={meta.icon} onPosterCaptured={onPosterCaptured} />
                  : <span className="grid h-full w-full place-items-center text-ink3"><Icon name={meta.icon} size={12} /></span>}
              </span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-ink2">
                {entry.name || (zh() ? '已保存的参考' : 'Saved reference')}
              </span>
            </button>
          )))}
        </div>
      ) : null}
    </div>
  );
}

export function ReferencesMenu({
  images = [],
  // Which of `images` are places or staging sheets rather than people, and what
  // each one IS. They live at the END of `images`, because order of supply is
  // the <Picture N> numbering and a prompt whose first picture is a storyboard
  // reads worse to anyone reviewing it.
  scene = [],
  sceneRoles = {},
  onSceneRole = null,
  audios = [],
  videos = [],
  prompt = '',
  // The explicit weave: the studio's own pass that recasts the prompt onto
  // whoever is in these rows, plus the scaffold (a placeholder shot and a
  // dialogue line to fill in). The panel never edits the prompt itself.
  onWeave = null,
  // Open an attached motion clip for head replacement — scrubbing, the mask
  // editor, and the framing dials. Null on a workflow family that has no
  // inpaint graph, which is what keeps the thumbnail a plain tile there.
  onOpenClip = null,
  // What the run is set to produce, so the panel can say when the clip is
  // longer than the prompt accounts for.
  durationSeconds = 0,
  limits = { images: 9, audios: 3, videos: 3 },
  onChange = {},
  persona = null,
  onPersonaChange,
  personaSeed = null,
  uploadFn,
  requireApiKey,
  disabled = false,
  // A counter the studio bumps to open the panel from elsewhere (the cast
  // strip's "Pictures or clips of a person").
  openRequest = 0,
  // A per-model reference kind that is not one of H3's rows: the LTX graph's
  // reference VIEWS, which get stitched into one sheet. It used to be a whole
  // section of the settings panel with a jump button pointing at it, so "use
  // this person" was a chip on one model and a panel section on another.
  // Rendered inside this panel as its own kind so there is ONE control.
  views = null,
  // Some models have views and no H3 rows at all; then the rows, the persona
  // bar and the H3 budget have nothing to say and the panel is just the views.
  viewsOnly = false,
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  useEffect(() => { if (openRequest) setPanelOpen(true); }, [openRequest]);
  // Which video reference row Clip Prep is open on, or -1 for closed.
  const [prepIndex, setPrepIndex] = useState(-1);
  // Measured lengths of the attached clips, keyed by url. Metadata-only reads,
  // so this costs a container header per reference rather than a decode.
  const [durations, setDurations] = useState({});
  const [busyKind, setBusyKind] = useState('');
  const [authOpen, setAuthOpen] = useState(false);
  const [recent, setRecent] = useState({ images: [], videos: [], audios: [] });
  // Every reference URL the owner still has. A Hive Persona ID outlives the
  // files it points at, so loading one checks against this rather than
  // attaching a URL whose file was deleted months ago. Null until the listing
  // has been read — "could not check" must never be read as "all gone".
  const [known, setKnown] = useState(null);
  // reference url -> sealed poster url, from the saved-reference listing. The
  // ATTACHED rows read it too: an attached clip is one of these references, and
  // without the map each row would decrypt the whole clip to draw 36 pixels.
  const [posters, setPosters] = useState({});
  const [dragKinds, setDragKinds] = useState([]);
  // One backfill attempt per clip per session, whatever re-renders happen.
  const backfilledRef = useRef(new Set());
  // The background warm-up runs once per mount, and keeps going after the panel
  // is closed — it exists so nobody ever waits for a thumbnail, including the
  // person who opened the panel first.
  const warmupRef = useRef(false);
  const liveRef = useRef(true);
  useEffect(() => () => { liveRef.current = false; }, []);
  const fileInputRef = useRef(null);
  const pendingKindRef = useRef('images');
  // dragenter/dragleave fire for every child element, so a plain boolean
  // flickers as the pointer crosses rows. Count enters instead.
  const dragDepthRef = useRef(0);
  const rootRef = useDismissable(panelOpen, () => setPanelOpen(false));
  // Same rule as ui/Menu.jsx: anchored left of the chip, flipped to the right
  // edge when it would run off-screen, so the panel stays inside the viewport.
  const panelRef = useRef(null);
  const [side, setSide] = useState('start');
  useEffect(() => {
    if (!panelOpen) { setSide('start'); return; }
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const margin = 8;
    setSide(rect.right > window.innerWidth - margin && rect.width < window.innerWidth - 2 * margin ? 'end' : 'start');
  }, [panelOpen]);

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
        setPosters(Object.fromEntries(refs
          .filter((entry) => entry.posterUrl)
          .map((entry) => [entry.uploadedUrl, entry.posterUrl])));
        // Pictures can also come from this browser's own upload history, which
        // the server listing does not cover — counting only the listing would
        // report perfectly good references as deleted. An empty listing means
        // the route is unavailable (standalone mode), not an empty library.
        setKnown(refs.length
          ? new Set([...refs.map((entry) => entry.uploadedUrl), ...history.map((entry) => entry.uploadedUrl)])
          : null);
        if (!warmupRef.current) {
          warmupRef.current = true;
          void startPosterWarmup(refs);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen]);

  // Decrypt ONE reference, reduce it to a thumbnail, and let go of it again.
  // Holding every decrypted original would mean 286 MB of live blobs after a
  // pass over a real library — worse than the problem this fixes. Only release
  // what this brought in: a tile on screen may be displaying one already cached.
  const capturePosterFor = async (url, kind) => {
    const wasCached = Boolean(peekResolvedMediaSrc(url));
    const src = await resolveMediaSrc(url);
    // resolveMediaSrc fails open by returning the original url — which means
    // the vault is locked or it is not sealed. Nothing to decode either way.
    if (!src || src === url) return null;
    try {
      return kind === 'video' ? await captureVideoPoster(src) : await captureImagePoster(src);
    } finally {
      if (!wasCached) revokeResolvedMedia(url);
    }
  };

  const startPosterWarmup = (refs) => warmReferencePosters(refs, {
    capture: capturePosterFor,
    publish: async (url, dataUrl) => {
      const blob = await (await fetch(dataUrl)).blob();
      return backfillHivemindReferencePoster(url, blob);
    },
    onPoster: (url, posterUrl) => {
      backfilledRef.current.add(url);
      if (liveRef.current) setPosters((previous) => ({ ...previous, [url]: posterUrl }));
    },
    pause: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    // Housekeeping yields to everything: a closed tab or an unmounted studio
    // ends the pass, and the next mount picks up whatever is still missing.
    shouldStop: () => !liveRef.current || (typeof document !== 'undefined' && document.hidden),
  }).catch(() => {});

  // A clip sealed before posters existed just got decoded in the browser — the
  // only place it CAN be decoded — so hand that frame back for next time.
  const onPosterCaptured = useCallback(async (url, dataUrl) => {
    if (!url || !dataUrl || backfilledRef.current.has(url)) return;
    backfilledRef.current.add(url);
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const posterUrl = await backfillHivemindReferencePoster(url, blob);
      if (posterUrl) setPosters((previous) => ({ ...previous, [url]: posterUrl }));
    } catch { /* a thumbnail is a nicety; the local decode already drew it */ }
  }, []);

  // One row of picture slots, shown as two sections. The panel owns the split
  // so a caller keeps handing it (and getting back) the single ordered list the
  // model is actually sent.
  const sceneSet = new Set(scene);
  const characterImages = images.filter((url) => !sceneSet.has(url));
  const orderedImages = [...characterImages, ...scene];
  const values = { images: characterImages, scene, videos, audios };
  // `onWeave` is accepted for compatibility and not rendered: the weave has one
  // home (Prompt Check, and the cast strip's own readout).
  void onWeave;
  const allLabels = referenceLabels({ images: orderedImages, videos, audios });
  const labels = {
    images: allLabels.images.slice(0, characterImages.length),
    scene: allLabels.images.slice(characterImages.length),
    videos: allLabels.videos,
    audios: allLabels.audios,
  };
  const motionWarning = motionReferenceWarning({ prompt, videos, images: orderedImages });
  const timeWarning = unscriptedTimeWarning({ prompt, durationSeconds, videos, audios });
  const total = orderedImages.length + videos.length + audios.length;
  // H3 rations references four ways at once; only the per-kind count was ever
  // visible here. See referenceBudgetReport for what the other three are.
  const budget = referenceBudgetReport({ images: orderedImages, videos, audios, durations });

  // Measure whatever is newly attached. Keyed on the url LIST rather than the
  // arrays themselves — those are rebuilt every render, and depending on them
  // would remeasure forever. Toggling a soundtrack changes the budget but not
  // any duration, so it deliberately does not appear here.
  const clipUrlKey = [...videos, ...audios].map(referenceUrl).join('|');
  useEffect(() => {
    const entries = [
      ...videos.map((item) => ({ url: referenceUrl(item), kind: 'videos' })),
      ...audios.map((item) => ({ url: referenceUrl(item), kind: 'audios' })),
    ].filter((entry) => entry.url);
    // Anything already measured this session is free; only the rest is work.
    const known = {};
    for (const entry of entries) {
      const cached = peekMediaDuration(entry.url);
      if (cached != null) known[entry.url] = cached;
    }
    if (Object.keys(known).length) setDurations((prev) => ({ ...prev, ...known }));
    const pending = entries.filter((entry) => peekMediaDuration(entry.url) == null);
    if (!pending.length) return undefined;
    let alive = true;
    void measureAll(pending, (url, seconds) => {
      if (alive) setDurations((prev) => ({ ...prev, [url]: seconds }));
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipUrlKey]);

  // The character row and the scene row are two halves of ONE list: either one
  // emits the whole thing, in supply order, so the labels the model is sent can
  // never disagree with the labels the panel drew.
  const emit = (kind, next) => {
    if (kind === 'images') return onChange.images?.([...next, ...scene]);
    if (kind === 'scene') return onChange.scene?.(next);
    return onChange[kind]?.(next);
  };

  const attach = (kind, url, name = '') => {
    if (!url) return;
    const current = values[kind];
    // The same source twice is never the intent — it would send the model one
    // picture as both <Picture 2> and <Picture 5>, burning a slot on a copy —
    // and it collided the rows' React keys. Say which label already holds it,
    // because a saved tile gives no other clue that it is already in the row.
    const attached = referenceAttachIndex(current, url);
    if (attached >= 0) {
      const label = labels[kind][attached];
      const tag = label?.video || label || KIND_META[kind].tag(attached);
      toast(zh() ? `已作为 ${tag} 附加` : `Already attached as ${tag}`);
      return;
    }
    if ((kind === 'images' || kind === 'scene' ? orderedImages.length : current.length) >= limits[kind === 'scene' ? 'images' : kind]) return;
    if (kind === 'images' || kind === 'scene') emit(kind, [...current, url]);
    else if (kind === 'videos') emit('videos', [...current, { url, name, useAudio: false, compact: false }]);
    else emit('audios', [...current, { url, name }]);
  };

  const openPicker = (kind) => {
    if (needsKey() && muapiKeyMissing()) {
      setAuthOpen(true);
      return;
    }
    pendingKindRef.current = kind;
    if (fileInputRef.current) {
      fileInputRef.current.accept = KIND_META[kind].accept;
      fileInputRef.current.click();
    }
  };

  // The shared uploader (composer drops use the same one), wrapped in this
  // panel's per-row busy state.
  const upload = referenceUploader(doUpload);
  const uploadInto = async (kind, file) => {
    setBusyKind(kind);
    try {
      return await upload(kind, file);
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
      toastFailure(err, { operation: zh() ? '参考上传' : 'Reference upload' });
    }
  };

  // Dropping anywhere in the panel files each item in ITS row — you never have
  // to hit a target. Same routing the composer uses (lib/referenceDrop.js), so
  // a file lands in the same row and is refused in the same words either way.
  const handleDrop = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragKinds([]);
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    if (needsKey() && muapiKeyMissing()) {
      setAuthOpen(true);
      return;
    }
    const { added, rejected } = await attachDroppedReferences({
      files,
      taken: { images: images.length, videos: videos.length, audios: audios.length },
      limits,
      upload: uploadInto,
    });
    if (added.images.length) emit('images', [...images, ...added.images.map((item) => item.url)]);
    if (added.videos.length) {
      emit('videos', [...videos, ...added.videos.map((item) => ({ ...item, useAudio: false, compact: false }))]);
    }
    if (added.audios.length) emit('audios', [...audios, ...added.audios]);
    for (const rejection of rejected) {
      if (rejection.error) console.error('[ReferencesMenu] dropped upload failed:', rejection.error);
      toast.error(describeReferenceRejection(rejection));
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
      {/* The same chip primitive as the rest of the row. A loaded persona names
          the value: what is attached is a character, not "four references". */}
      <ChipButton
        icon={persona?.name ? 'persona' : 'layers'}
        label={zh() ? '参考' : 'References'}
        value={persona?.name ? `${persona.name} · ${total}` : (total > 0 ? String(total) : '')}
        active={panelOpen || total > 0}
        chevron={false}
        disabled={disabled}
        aria-expanded={panelOpen}
        onClick={() => setPanelOpen((open) => !open)}
        title={viewsOnly
          ? (zh()
            ? '参考：这个人的多个视角，会拼接成一张参考图'
            : 'References — several views of the same person or thing, stitched into one reference sheet')
          : (zh()
            ? '参考：角色图片、声音片段、动作片段——附加任意一种即切换到参考模式（取代首尾帧）'
            : 'References — pictures of a person, voice clips, motion clips. Attaching any switches the run to Reference mode, which replaces the start/end frames')}
      />

      {panelOpen ? (
        <div
          ref={panelRef}
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
            'absolute bottom-full z-40 mb-2 flex max-h-[70vh] w-[320px] max-w-[calc(100vw-1.5rem)] flex-col gap-3 overflow-y-auto rounded-lg border bg-bg1 p-2.5 shadow-pop',
            side === 'end' ? 'right-0' : 'left-0',
            dragDepthRef.current ? 'border-honey/60' : 'border-line1',
          )}
        >
          {views}

          {/* The character these rows add up to, above the rows themselves. */}
          {/* A persona is a PERSON. Its pictures are the character half of the
              row; a location plate saved into somebody's identity is a plate
              that follows them into every later clip. */}
          {viewsOnly ? null : (
          <PersonaBar
            images={characterImages}
            videos={videos}
            audios={audios}
            persona={persona}
            onPersonaChange={onPersonaChange}
            seed={personaSeed}
            limits={limits}
            posters={posters}
            known={known}
            onPosterCaptured={onPosterCaptured}
            // Importing a persona re-uploads its media, and it goes up the same
            // way a dragged file does — the panel owns that path, not the bar.
            uploadFn={doUpload}
            onLoad={(next) => {
              emit('images', next.images);
              emit('videos', next.videos);
              emit('audios', next.audios);
            }}
          />
          )}

          {(viewsOnly ? [] : KINDS).map((kind) => (
            <ReferenceSection
              key={kind}
              kind={kind}
              items={values[kind]}
              limit={limits[kind === 'scene' ? 'images' : kind]}
              used={kind === 'images' || kind === 'scene' ? orderedImages.length : null}
              roles={kind === 'scene' ? sceneRoles : undefined}
              onRole={kind === 'scene' ? onSceneRole : null}
              labels={labels[kind]}
              busy={busyKind === kind}
              recent={recent[kind] || []}
              dropTarget={dragKinds.includes(kind)}
              posters={posters}
              onPosterCaptured={onPosterCaptured}
              onPickRecent={(url) => attach(kind, url)}
              onAdd={() => openPicker(kind)}
              onRemove={(index) => emit(kind, values[kind].filter((_, i) => i !== index))}
              // MOTION and SOUND are what the clip contributes; one of them
              // always stays on. Sound off on a sound-only row hands the clip
              // back to motion; motion off on a silent row switches its sound
              // on, so "sound only" is one click either way.
              onToggleAudio={(index) => emit('videos', videos.map((item, i) => {
                if (i !== index) return item;
                if (isSoundOnlyReference(item)) return { ...item, motion: true, useAudio: false };
                return { ...item, useAudio: !item.useAudio };
              }))}
              onToggleMotion={(index) => emit('videos', videos.map((item, i) => {
                if (i !== index) return item;
                if (isSoundOnlyReference(item)) return { ...item, motion: true };
                return { ...item, motion: false, useAudio: true, compact: false };
              }))}
              onToggleCompact={(index) => emit('videos', videos.map((item, i) => (
                i === index && !isSoundOnlyReference(item) ? { ...item, compact: !item.compact } : item
              )))}
              // No picture attached means the clip is the character reference
              // (the info line below says exactly that), and identity needs
              // pixels — so the compact switch is held off rather than offered.
              compactLocked={kind === 'videos' && referenceVideoCompactLocked({ images: orderedImages })}
              // Head replacement's one door: the motion clip's own thumbnail.
              // Only offered when the studio supplied a handler, so a workflow
              // family with no inpaint graph shows a plain preview tile.
              onOpen={kind === 'videos' ? onOpenClip : null}
              onPrep={kind === 'videos' ? (index) => setPrepIndex(index) : null}
            />
          ))}
          {/* The reference budget. Advisory by design: nothing here removes a
              reference, because dropping one renumbers every label after it and
              would silently invalidate tags already written into the prompt.
              The fix is almost always a trim, which costs no slot at all. */}
          {budget.counts.total && !budget.ok ? (
            <div className="rounded-md border border-danger bg-bg2 px-2 py-1.5 text-[10px] leading-snug text-ink2">
              <span className="font-mono">
                {budget.counts.total}/{budget.counts.limit} {zh() ? '个参考' : 'refs'}
                {' · '}
                {budget.counts.audioClips}/3 {zh() ? '音频' : 'audio'}
                {budget.seconds.video ? ` · ${budget.seconds.video}/${budget.seconds.limit}s video` : ''}
                {budget.seconds.audio ? ` · ${budget.seconds.audio}/${budget.seconds.limit}s audio` : ''}
              </span>
              {budget.unmeasured ? (
                <span className="text-ink3">
                  {zh() ? ` · ${budget.unmeasured} 个待测量` : ` · measuring ${budget.unmeasured}`}
                </span>
              ) : null}
              {budget.problems.map((problem) => (
                <span key={`${problem.code}${problem.url || ''}`} className="mt-1 block text-danger">
                  {problem.code === 'over-total' && (zh()
                    ? `超出 ${problem.count}/${problem.limit} 个参考${problem.soundtracks ? `（含 ${problem.soundtracks} 条自带原声，各占一个名额）` : ''}。`
                    : `${problem.count} references attached; H3 takes ${problem.limit}.${problem.soundtracks ? ` ${problem.soundtracks} of them ${problem.soundtracks === 1 ? 'is a' : 'are'} split soundtrack${problem.soundtracks === 1 ? '' : 's'}, which counts as its own reference — switching one off gives a slot back.` : ''}`)}
                  {problem.code === 'over-audio-clips' && (zh()
                    ? `音频参考 ${problem.count} 个，上限 3 个（自带原声也算）。`
                    : `${problem.count} audio clips; H3 takes 3 — and a clip's split soundtrack is one of them.`)}
                  {problem.code === 'audio-without-visual' && (zh()
                    ? '声音参考不能单独发送，至少还需要一张图片或一段视频。'
                    : 'Audio cannot be sent on its own — attach at least one picture or clip alongside it.')}
                  {problem.code === 'clip-too-short' && (zh()
                    ? `有片段只有 ${problem.seconds} 秒，最短 ${problem.limit} 秒。`
                    : `A clip runs ${problem.seconds}s; the minimum is ${problem.limit}s.`)}
                  {problem.code === 'clip-too-long' && (zh()
                    ? `有片段长 ${problem.seconds} 秒，单段上限 ${problem.limit} 秒——用该行的「裁剪」。`
                    : `A clip runs ${problem.seconds}s; ${problem.limit}s is the per-clip maximum — use Trim on its row.`)}
                  {problem.code === 'over-video-seconds' && (zh()
                    ? `视频参考合计 ${problem.seconds} 秒，上限 ${problem.limit} 秒（这是所有片段的总和，不是每段的额度）。`
                    : `Video references total ${problem.seconds}s against a ${problem.limit}s budget — that ${problem.limit}s is the total across every clip, not a per-clip allowance.`)}
                  {problem.code === 'over-audio-seconds' && (zh()
                    ? `音频合计 ${problem.seconds} 秒，上限 ${problem.limit} 秒${problem.soundtracks ? '。自带原声会同时占用视频与音频两份时长' : ''}。`
                    : `Audio totals ${problem.seconds}s against a ${problem.limit}s budget.${problem.soundtracks ? ' A split soundtrack spends from the video AND audio totals at once, so switching one off frees the most.' : ''}`)}
                </span>
              ))}
            </div>
          ) : null}
          {timeWarning ? (
            <p className="rounded-md border border-honey/40 bg-honey-tint px-2 py-1.5 text-[10px] leading-snug text-honey">
              {timeWarning.kind === 'no-line'
                ? (zh()
                  ? '已附加声音参考，但提示词里没有任何 <d>…</d> 台词。克隆的声音无话可说时，模型会自己编。'
                  : "A voice reference is attached but the prompt has no <d>…</d> line. A cloned voice with nothing to say tends to invent something.")
                : (zh()
                  ? `台词约 ${timeWarning.spoken} 秒，片长 ${timeWarning.duration} 秒——约 ${timeWarning.gap} 秒无人指定。请缩短片长、增加台词，或在镜头描述与 overall_soundscape 里写明这段时间发生什么（并声明没有其他说话声）。`
                  : `Dialogue runs about ${timeWarning.spoken}s; the clip is ${timeWarning.duration}s. Roughly ${timeWarning.gap}s is unaccounted for — shorten the clip, write more line, or say what fills the time and that nobody else speaks.`)}
            </p>
          ) : null}
          {motionReferenceRows(videos).length && !orderedImages.length ? (
            // No picture: the clip is the character reference, and the model is
            // told so — the exclusion advice below is for the picture+clip case.
            <p className="rounded-md border border-line1 px-2 py-1.5 text-[10px] leading-snug text-ink3">
              {zh()
                ? '没有附加图片：第一段动作参考就是角色参考——片中人物的长相、发型、服装与动作方式会带入成片。附加图片后，视频仅作动作参考。'
                : "No picture attached: the first motion clip is the character reference — its performer's face, hair, wardrobe and manner carry into the clip. Attach a picture and the clip becomes motion-only."}
            </p>
          ) : null}
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
        </div>
      ) : null}

      {authOpen ? (
        <AuthModal
          onClose={() => setAuthOpen(false)}
          onSaved={() => { setAuthOpen(false); openPicker(pendingKindRef.current); }}
        />
      ) : null}

      {/* Clip Prep works on the row it was opened from. The prepared blob is
          uploaded like any other reference, so it is sealed on the way in and
          the row keeps pointing at a real reference rather than a local blob:
          URL that dies with the tab. A grabbed FRAME becomes a picture row
          instead — the same trim is usually where the start image comes from. */}
      {prepIndex >= 0 && videos[prepIndex] ? (
        <ClipPrepDialog
          sourceUrl={referenceUrl(videos[prepIndex])}
          sourceName={fileLabel(videos[prepIndex])}
          clipSeconds={durationSeconds}
          onClose={() => setPrepIndex(-1)}
          onApply={async ({ kind, blob, name }) => {
            const index = prepIndex;
            setPrepIndex(-1);
            try {
              const file = new File([blob], name, { type: blob.type });
              if (kind === 'image') {
                const uploaded = await uploadInto('images', file);
                attach('images', uploaded.url, uploaded.name);
                return;
              }
              const uploaded = await uploadInto('videos', file);
              // Replace in place so the reference keeps its <Video N> label and
              // its soundtrack and compact switches — renumbering the rows under
              // someone who only trimmed a clip would silently repoint their prompt.
              emit('videos', videos.map((item, i) => (
                i === index ? { ...item, url: uploaded.url, name: uploaded.name } : item
              )));
            } catch (err) {
              console.error('[ReferencesMenu] prepared clip upload failed:', err);
              toastFailure(err, { operation: zh() ? '片段上传' : 'Prepared clip upload' });
            }
          }}
        />
      ) : null}
    </div>
  );
}
