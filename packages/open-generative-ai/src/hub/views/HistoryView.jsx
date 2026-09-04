// History view — the owner-only private archive: every output the studios and
// Canvas made (the media gateway's encrypted output index) + the prompt library.
//
// Preserved behaviors: parallel prompts + paginated outputs load, Set-deduped
// infinite scroll (loadMoreCanvasHistory), per-card lazy provenance read
// (inspectCanvasHistoryEntry with allowBridge:false — it never boots the Canvas
// iframe; IntersectionObserver rootMargins 320/900px), E2E decrypt choreography
// (MediaThumb / click-to-load video), and every route. history_id/prompt_id keys
// keep decrypted blob <img> srcs alive across the 10s poll. Destructive deletes
// go through ConfirmModal and stay open when the delete fails.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMediaSealFailure, useMediaSrc } from '../../hooks/hooks.js';
import { registerMediaDownloadName } from '../../lib/e2eMedia.js';
import { mediaDownloadName } from '../../lib/downloadNames.js';
import { downloadMedia } from '../../lib/downloadMedia.js';
import { basenameOf } from '../../lib/generationSetupStore.js';
import { requestVaultUnlock } from '../../lib/vaultSession.js';
import { ConfirmModal } from '../../ui/Modal.jsx';
import { Icon } from '../../ui/icons.jsx';
import { Menu, MenuItem } from '../../ui/Menu.jsx';
import { EmptyState, NativeSelect, Pill, Segmented, Spinner, TextInput, cx } from '../../ui/kit.jsx';
import {
  canvasEntryModelLabel, copyCanvasPrompt, copyText, deleteCanvasOutput, deletePrompt,
  inspectCanvasHistoryEntry, insertPromptIntoComposer, loadCanvasOutputInCanvas,
  loadCanvasOutputInStudio, loadMoreCanvasHistory, loadRunIntoSimpleComposer, setCanvasFilters,
  setHistoryFilter, setHistoryQuery, setPromptFavorite, titleCase, useHub, SEALED_PROMPT_TEXT,
} from '../hubData.js';
import { HubToolbar } from '../components/HubToolbar.jsx';
import { Lightbox } from '../components/Lightbox.jsx';
import { MediaThumb, VaultLockedTile } from '../components/MediaThumb.jsx';

const FILTERS = () => [
  { value: '', label: 'All' },
  { value: 'prompts', label: 'Prompts' },
  { value: 'canvas', label: 'Outputs' },
  { value: 'favorites', label: 'Favorites' },
];

function useOnVisible(cb, { once = false, rootMargin = '0px', resetKey } = {}) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        if (once) observer.unobserve(entry.target);
        cb();
      });
    }, { rootMargin });
    observer.observe(el);
    return () => observer.disconnect();
    // resetKey re-arms the observer after each page appends (mirrors the old
    // observeRenderedHistory rebuilding the sentinel observer every render) so a
    // continuously-visible sentinel keeps paginating instead of firing once.
  }, [cb, once, rootMargin, resetKey]);
  return ref;
}

// Pagination appends forever — 48 more cards each time the sentinel is seen —
// and every mounted card holds a decrypted blob. So a card further than two
// screens from the viewport is unmounted, which releases its hold on the media
// cache and lets the byte budget evict it. The placeholder keeps the height the
// card had, so nothing under the cursor jumps when one leaves.
//
// `grid` on the wrapper rather than a plain block: a one-child grid stretches
// that child to the cell, which is what the card got when it WAS the grid item.
const WINDOW_MARGIN = '200% 0px';

function Windowed({ children }) {
  const ref = useRef(null);
  const heightRef = useRef(0);
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') return undefined;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry.isIntersecting) {
        setMounted(true);
        return;
      }
      // Measured on the way out, while the real card is still rendered.
      const height = entry.boundingClientRect?.height || 0;
      if (height) heightRef.current = height;
      setMounted(false);
    }, { rootMargin: WINDOW_MARGIN });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="grid" style={mounted ? undefined : { height: heightRef.current || undefined }} aria-hidden={mounted ? undefined : true}>
      {mounted ? children : null}
    </div>
  );
}

function CanvasVideoInner({ url }) {
  const src = useMediaSrc(url);
  // useMediaSrc fails open to the raw envelope URL when this tab can't decrypt;
  // a <video> pointed at that never leaves readyState 0 and reads as a broken
  // generation. Say so instead.
  const sealFailure = useMediaSealFailure(url);
  if (sealFailure) return <VaultLockedTile reason={sealFailure} />;
  return <video src={src} controls controlsList="nodownload" preload="metadata" className="h-full w-full object-cover" />;
}

// Which videos the owner has opened this session. Module-level, mirroring the
// decrypted-blob cache in e2eMedia.js, so a card that remounts (filter switch,
// pagination rebuild) comes back as a player instead of reverting to the button
// and forcing a second decrypt of media the browser already holds.
const openedVideos = new Set();

function CanvasVideo({ url }) {
  const [load, setLoad] = useState(() => openedVideos.has(url));
  if (load) return <CanvasVideoInner url={url} />;
  return (
    <button
      type="button"
      onClick={() => { openedVideos.add(url); setLoad(true); }}
      className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-ink3 transition-colors hover:text-ink1"
      aria-label="Load encrypted video preview"
    >
      <Icon name="play" size={22} />
      <b className="text-[11px] font-semibold">Load video</b>
    </button>
  );
}

// The full-size preview for an image output: resolves (decrypts) the same URL
// the thumb did — the blob cache makes that free — inside the shared Lightbox.
function OutputLightbox({ entry, onClose }) {
  const src = useMediaSrc(entry.media_url);
  const sealFailure = useMediaSealFailure(entry.media_url);
  const title = outputKindLabel(entry);
  if (sealFailure) {
    return (
      <Lightbox title={title} onClose={onClose}>
        <div className="aspect-square w-64 overflow-hidden rounded-lg"><VaultLockedTile reason={sealFailure} /></div>
      </Lightbox>
    );
  }
  return <Lightbox src={src} kind="image" title={title} alt={title} onClose={onClose} />;
}

function HistoryMenu({ items }) {
  return (
    <Menu
      align="end"
      width="w-48"
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-label="Actions"
          aria-expanded={open}
          className={cx(
            'grid h-7 w-7 place-items-center rounded-md transition-colors',
            open ? 'bg-bg3 text-ink1' : 'text-ink3 hover:bg-bg2 hover:text-ink1',
          )}
        >
          <Icon name="more" size={15} />
        </button>
      )}
    >
      {(close) => items.map((item) => (
        <MenuItem
          key={item.label}
          icon={item.icon}
          className={item.danger ? 'text-danger hover:bg-danger-tint hover:text-danger' : ''}
          onClick={() => { item.onClick(); close(); }}
        >
          {item.label}
        </MenuItem>
      ))}
    </Menu>
  );
}

// "Video · minimax-h3" / "Image · z-image-turbo": what it is and what made it.
// The index holds Image/Video-studio and cloud outputs as well as Canvas ones,
// so "Canvas output" on every card was wrong for most of them.
function outputKindLabel(entry) {
  const isVideo = entry.media_type?.startsWith('video/');
  const kind = isVideo ? 'Video' : 'Image';
  const model = entry.models?.[0];
  return model ? `${kind} · ${model}` : kind;
}

const CanvasCard = memo(function CanvasCard({ entry, onDelete, onPreview }) {
  const isVideo = entry.media_type?.startsWith('video/');
  const downloadName = mediaDownloadName(
    entry.models?.[0], entry.history_id, entry.file_format, { fallback: isVideo ? 'video' : 'image' },
  );
  // Registered during render, not in an effect: child effects run BEFORE the
  // parent's, so MediaThumb/CanvasVideo would already have decrypted and cached an
  // unnamed blob by the time a parent effect fired. It is an idempotent Map write
  // against the same module cache those children read.
  registerMediaDownloadName(entry.media_url, downloadName);
  // Background provenance read for the model line + Model filter. allowBridge:false
  // means a genuine Canvas output quietly stays "—" here: scrolling History must
  // never be what boots the ComfyUI iframe; only an explicit action may.
  const known = Boolean(entry.models?.length);
  const inspect = useCallback(() => {
    if (known) return; // provenance already on the row — nothing to read
    void inspectCanvasHistoryEntry(entry.history_id, { allowBridge: false });
  }, [entry.history_id, known]);
  const ref = useOnVisible(inspect, { once: true, rootMargin: '320px 0px' });
  const kindLabel = outputKindLabel(entry);
  // The title already names the first model; the detail line carries the seed
  // (or the other models), and a plain "—" when nothing is known.
  const detail = entry.seeds?.length
    ? `${'seed'} ${entry.seeds.join(', ')}`
    : known ? (entry.models.length > 1 ? entry.models.slice(1).join(', ') : '') : canvasEntryModelLabel(entry);

  return (
    <article ref={ref} className="group relative flex flex-col overflow-hidden rounded-lg border border-line1 bg-bg2 transition-colors hover:border-line2">
      {/* Always visible where there is no hover (touch); hover-revealed elsewhere. */}
      <div className="absolute right-2 top-2 z-10 rounded-md bg-bg1/80 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <HistoryMenu
          items={[
            { label: 'Load in Studio', icon: 'sparkles', onClick: () => loadCanvasOutputInStudio(entry.history_id) },
            { label: 'Load in Canvas', icon: 'nodes', onClick: () => loadCanvasOutputInCanvas(entry.history_id) },
            // The players carry controlsList="nodownload", so this is the ONLY way
            // to save from History — and it is the one that names the file properly.
            { label: 'Download', icon: 'download', onClick: () => void downloadMedia(entry.media_url, downloadName) },
            { label: 'Copy prompt', icon: 'copy', onClick: () => copyCanvasPrompt(entry.history_id) },
            { label: 'Delete', icon: 'trash', danger: true, onClick: () => onDelete(entry) },
          ]}
        />
      </div>
      <div className="aspect-square">
        {isVideo ? (
          <CanvasVideo url={entry.media_url} />
        ) : (
          <button
            type="button"
            onClick={() => onPreview(entry)}
            aria-label="Open preview"
            className="block h-full w-full cursor-zoom-in"
          >
            <MediaThumb url={entry.media_url} alt={kindLabel} className="h-full w-full" />
          </button>
        )}
      </div>
      <div className="flex flex-col gap-0.5 p-2.5">
        <b className="truncate text-[12px] font-semibold text-ink1" title={kindLabel}>{kindLabel}</b>
        <small className="text-[11px] text-ink3">
          {entry.time_label || (entry.created_at ? new Date(entry.created_at).toLocaleString() : '—')}
        </small>
        {detail ? <small className="truncate font-mono text-[11px] text-ink3" title={detail}>{detail}</small> : null}
        <div className="mt-1 flex items-center gap-1.5">
          {entry.file_format ? <Pill tone="neutral" className="h-5 px-2 text-[10px]">{(entry.file_format || '').toUpperCase()}</Pill> : null}
          <Pill tone={entry.encrypted_at_rest ? 'honey' : 'neutral'} className="h-5 px-2 text-[10px]">
            {entry.encrypted_at_rest ? 'Encrypted at rest' : 'Private output'}
          </Pill>
        </div>
      </div>
    </article>
  );
});

const PromptCard = memo(function PromptCard({ entry, onDelete }) {
  // The prompt is sealed to a vault this tab has not opened. Saying so is half
  // the job — the other half is the way out, in the card itself.
  const sealed = entry.prompt === SEALED_PROMPT_TEXT;
  const meta = [
    titleCase(entry.lane || ''),
    entry.title,
    entry.updated_at ? new Date(entry.updated_at).toLocaleString() : '',
    entry.use_count > 1 ? `used ${entry.use_count}×` : '',
  ].filter(Boolean);
  const usePrompt = () => {
    if (entry.run_id && loadRunIntoSimpleComposer(entry.run_id)) return;
    insertPromptIntoComposer(entry.user_prompt || entry.prompt);
  };
  return (
    <article className={cx('relative flex flex-col gap-2 rounded-lg border bg-bg2 p-3.5', entry.favorite ? 'border-honey/40' : 'border-line1')}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setPromptFavorite(entry.prompt_id, !entry.favorite)}
          aria-label={entry.favorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-pressed={entry.favorite}
          className={cx('grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors', entry.favorite ? 'text-honey' : 'text-ink3 hover:text-ink1')}
        >
          <Icon name="star" size={16} />
        </button>
        {sealed ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Icon name="lock" size={14} className="shrink-0 text-honey" />
            <p className="min-w-0 text-[13px] leading-relaxed text-ink2">
              Sealed prompt — unlock your vault to read it.
            </p>
            <button
              type="button"
              onClick={requestVaultUnlock}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-honey/50 bg-honey-tint px-2.5 text-[11px] font-semibold text-honey transition-colors hover:border-honey"
            >
              <Icon name="unlock" size={13} />
              Unlock
            </button>
          </div>
        ) : (
          <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink1">{entry.prompt}</p>
        )}
        <HistoryMenu
          items={[
            // Using or copying a sealed prompt would hand over the placeholder
            // sentence, not the prompt — so those doors stay shut until it opens.
            ...(sealed ? [] : [
              // Lands in the Planner composer (not a studio) — say so.
              { label: 'Use in Planner', icon: 'sparkles', onClick: usePrompt },
              { label: 'Copy prompt', icon: 'copy', onClick: () => copyText(entry.prompt) },
            ]),
            { label: 'Delete', icon: 'trash', danger: true, onClick: () => onDelete(entry) },
          ]}
        />
      </div>
      {entry.user_prompt && entry.user_prompt !== entry.prompt ? (
        <details className="pl-9 text-xs text-ink3">
          <summary className="cursor-pointer select-none">Your original wording</summary>
          <p className="mt-1 leading-relaxed text-ink2">{entry.user_prompt}</p>
        </details>
      ) : null}
      {meta.length ? (
        <div className="flex flex-wrap gap-1.5 pl-9 text-[11px] text-ink3">
          {meta.map((item, i) => <span key={i}>{item}</span>)}
        </div>
      ) : null}
    </article>
  );
});

function GroupHeading({ kicker, title, right }) {
  return (
    <div className="flex items-end justify-between gap-2">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink3">{kicker}</p>
        <h3 className="text-sm font-semibold text-ink1">{title}</h3>
      </div>
      {right ? <small className="font-mono text-[11px] text-ink3">{right}</small> : null}
    </div>
  );
}

function SkeletonGrid({ count = 8 }) {
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]" aria-busy="true" aria-label="Loading outputs">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col overflow-hidden rounded-lg border border-line1 bg-bg2">
          <div className="aspect-square animate-pulse bg-bg3" />
          <div className="flex flex-col gap-1.5 p-2.5">
            <div className="h-3 w-1/2 animate-pulse rounded bg-bg3" />
            <div className="h-2.5 w-2/3 animate-pulse rounded bg-bg3" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Client-side text match. Prompts match on their text; outputs on the model
// name or the file name — both lists are already in memory.
function matchesQuery(haystack, needle) {
  if (!needle) return true;
  const text = haystack.filter(Boolean).join(' ').toLowerCase();
  return needle.split(/\s+/).every((token) => text.includes(token));
}

export function HistoryView({ active }) {
  const s = useHub();
  const [confirm, setConfirm] = useState(null); // { kind, entry }
  const [deleting, setDeleting] = useState(false);
  const [preview, setPreview] = useState(null); // output entry

  const loadMore = useCallback(() => { void loadMoreCanvasHistory(); }, []);
  const sentinelRef = useOnVisible(loadMore, { rootMargin: '900px 0px', resetKey: s.canvasHistory.length });

  const showCanvas = ['', 'canvas'].includes(s.historyFilter);
  const showPrompts = ['', 'prompts', 'favorites'].includes(s.historyFilter);
  const needle = s.historyQuery.trim().toLowerCase();
  const prompts = useMemo(() => {
    const base = s.historyFilter === 'favorites' ? s.prompts.filter((entry) => entry.favorite) : s.prompts;
    return base.filter((entry) => matchesQuery([entry.prompt, entry.user_prompt, entry.title, entry.lane], needle));
  }, [s.prompts, s.historyFilter, needle]);
  const outputs = useMemo(() => s.canvasHistory.filter((entry) => matchesQuery(
    [...(entry.models || []), entry.output_basename || basenameOf(entry.media_url), entry.file_format, entry.media_type],
    needle,
  )), [s.canvasHistory, needle]);
  const filtering = Boolean(needle);

  // Stable handlers so the memoised cards are not re-rendered by new closures.
  const confirmDeleteOutput = useCallback((entry) => setConfirm({ kind: 'canvas', entry }), []);
  const confirmDeletePrompt = useCallback((entry) => setConfirm({ kind: 'prompt', entry }), []);

  const runDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    let ok = true;
    if (confirm.kind === 'canvas') ok = await deleteCanvasOutput(confirm.entry.history_id);
    else ok = await deletePrompt(confirm.entry.prompt_id);
    setDeleting(false);
    if (ok) setConfirm(null);
  };

  const hasData = s.canvasHistory.length > 0 || s.prompts.length > 0;
  const refreshing = s.canvasLoading && s.canvasHistory.length > 0;

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar kicker="Private archive" title="Library">
        {refreshing ? <Spinner size={14} className="text-honey" /> : null}
        {s.apiOnline === false ? (
          <Pill tone="warn" dot title="The studio did not answer the latest poll">
            Offline · showing the last reading
          </Pill>
        ) : null}
        <div className="relative min-w-[200px]">
          <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink3" />
          <TextInput
            type="search"
            value={s.historyQuery}
            onChange={(e) => setHistoryQuery(e.target.value)}
            placeholder="Filter prompts and outputs"
            aria-label="Filter prompts and outputs"
            className="pl-8 text-xs"
          />
        </div>
        <Segmented options={FILTERS()} value={s.historyFilter} onChange={setHistoryFilter} />
        {showCanvas ? (
          <div className="flex items-center gap-2">
            <NativeSelect
              aria-label="Format"
              className="min-w-[7.5rem]"
              value={s.canvasFormat}
              onChange={(e) => setCanvasFilters({ format: e.target.value })}
            >
              <option value="">All formats</option>
              {s.canvasFormats.map((format) => <option key={format} value={format}>{format}</option>)}
            </NativeSelect>
            <NativeSelect
              aria-label="Model"
              className="min-w-[8.5rem]"
              value={s.canvasModel}
              onChange={(e) => setCanvasFilters({ model: e.target.value })}
            >
              <option value="">All models</option>
              {s.canvasModels.map((model) => <option key={model} value={model}>{model}</option>)}
            </NativeSelect>
          </div>
        ) : null}
      </HubToolbar>

      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <p className="mb-4 text-[11px] leading-relaxed text-ink3">
          Everything here stays on this machine, encrypted at rest. Outputs come from the studios and Canvas · productions planned in the Planner live under Runs.
        </p>

        <div className="flex flex-col gap-6">
          {showCanvas ? (
            !s.historyLoaded && !hasData ? (
              <section className="flex flex-col gap-3">
                <GroupHeading kicker="Studios & Canvas" title="Outputs" />
                <SkeletonGrid />
              </section>
            ) : outputs.length ? (
              <section className="flex flex-col gap-3">
                <GroupHeading
                  kicker="Studios & Canvas"
                  title="Outputs"
                  right={filtering ? `${outputs.length} of ${s.canvasHistory.length}` : `${s.canvasHistory.length} of ${s.canvasTotal}`}
                />
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
                  {outputs.map((entry) => (
                    <Windowed key={entry.history_id}>
                      <CanvasCard entry={entry} onDelete={confirmDeleteOutput} onPreview={setPreview} />
                    </Windowed>
                  ))}
                </div>
                {s.canvasHasMore && !filtering ? (
                  <div ref={sentinelRef} className="flex min-h-[1.5rem] items-center justify-center gap-2 py-4 text-xs text-ink3" aria-live="polite">
                    {s.canvasLoading ? <><Spinner size={14} className="text-honey" /> Loading more outputs…</> : null}
                  </div>
                ) : null}
              </section>
            ) : (
              <EmptyState
                icon="grid"
                title={filtering
                  ? 'No outputs match'
                  : 'No outputs yet'}
                hint={filtering
                  ? 'Try another word, or clear the filter.'
                  : 'Generate something in a studio and it appears here.'}
              />
            )
          ) : null}

          {showPrompts ? (
            !s.historyLoaded && !hasData ? (
              s.historyFilter ? (
                <section className="flex flex-col gap-3" aria-busy="true">
                  <GroupHeading kicker="Prompt library" title="Loading…" />
                  <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                    {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-24 animate-pulse rounded-lg border border-line1 bg-bg2" />)}
                  </div>
                </section>
              ) : null
            ) : prompts.length ? (
              <section className="flex flex-col gap-3">
                <GroupHeading
                  kicker="Prompt library"
                  title={s.historyFilter === 'favorites' ? 'Favorites' : 'Generation prompts'}
                  right={filtering ? `${prompts.length} of ${s.prompts.length}` : undefined}
                />
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                  {prompts.map((entry) => (
                    <PromptCard key={entry.prompt_id} entry={entry} onDelete={confirmDeletePrompt} />
                  ))}
                </div>
              </section>
            ) : (
              <EmptyState
                icon="history"
                title={filtering
                  ? 'No prompts match'
                  : s.historyFilter === 'favorites' ? 'No favorites yet' : 'No prompts yet'}
                hint={filtering
                  ? 'Try another word, or clear the filter.'
                  : s.historyFilter === 'favorites'
                    ? 'Star a prompt to keep it as a reusable ingredient.'
                    : 'Create a production and its final generation prompt will be recorded here.'}
              />
            )
          ) : null}
        </div>
      </div>

      {preview ? <OutputLightbox entry={preview} onClose={() => setPreview(null)} /> : null}

      <ConfirmModal
        open={Boolean(confirm)}
        onClose={() => (deleting ? null : setConfirm(null))}
        onConfirm={runDelete}
        busy={deleting}
        title={confirm?.kind === 'canvas' ? 'Delete this generated output?' : 'Delete this prompt?'}
        confirmLabel="Delete permanently"
        body={confirm?.kind === 'canvas'
          ? 'This permanently removes every same-name media copy, encrypted sidecar, history reference, workflow-index entry, and regenerable preview cache. This cannot be undone.'
          : 'This permanently removes the saved prompt from your library. This cannot be undone.'}
      />
    </div>
  );
}
