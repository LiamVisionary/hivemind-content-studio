// History view — the owner-only private archive: encrypted Canvas outputs +
// the prompt library. Baseline for the phase-2 agent, wired fully to hubData.
//
// Preserved behaviors: parallel prompts + paginated Canvas load, Set-deduped
// infinite scroll (loadMoreCanvasHistory), per-card lazy provenance inspection
// (inspectCanvasHistoryEntry, IntersectionObserver rootMargins 320/900px),
// E2E decrypt choreography (MediaThumb / click-to-load video), and every route.
// The old change-guard hacks (JSON filter key, whole-HTML string compare) are
// gone: controlled value-bound <select>s never close under the pointer, and
// history_id/prompt_id keys keep decrypted blob <img> srcs alive across the 10s
// poll. Destructive deletes go through ConfirmModal (was a native <dialog>).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMediaSealFailure, useMediaSrc } from '../../hooks/hooks.js';
import { registerMediaDownloadName } from '../../lib/e2eMedia.js';
import { mediaDownloadName } from '../../lib/downloadNames.js';
import { downloadMedia } from '../../lib/downloadMedia.js';
import { ConfirmModal } from '../../ui/Modal.jsx';
import { Icon } from '../../ui/icons.jsx';
import { Menu, MenuItem } from '../../ui/Menu.jsx';
import { EmptyState, IconButton, NativeSelect, Pill, Spinner, cx } from '../../ui/kit.jsx';
import {
  canvasEntryModelLabel, copyCanvasPrompt, copyText, deleteCanvasOutput, deletePrompt,
  inspectCanvasHistoryEntry, insertPromptIntoComposer, loadCanvasOutputInCanvas,
  loadCanvasOutputInStudio, loadMoreCanvasHistory, loadRunIntoSimpleComposer, setCanvasFilters,
  setHistoryFilter, setPromptFavorite, titleCase, useHub,
} from '../hubData.js';
import { HubToolbar } from '../components/HubToolbar.jsx';
import { MediaThumb, VaultLockedTile } from '../components/MediaThumb.jsx';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'prompts', label: 'Prompts' },
  { value: 'canvas', label: 'Canvas' },
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
          <Icon name="sliders" size={15} />
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

function CanvasCard({ entry, onDelete }) {
  const isVideo = entry.media_type?.startsWith('video/');
  const downloadName = mediaDownloadName(
    entry.models?.[0], entry.history_id, entry.file_format, { fallback: isVideo ? 'video' : 'image' },
  );
  // Registered during render, not in an effect: child effects run BEFORE the
  // parent's, so MediaThumb/CanvasVideo would already have decrypted and cached an
  // unnamed blob by the time a parent effect fired. It is an idempotent Map write
  // against the same module cache those children read.
  registerMediaDownloadName(entry.media_url, downloadName);
  const inspect = useCallback(() => { void inspectCanvasHistoryEntry(entry.history_id); }, [entry.history_id]);
  const ref = useOnVisible(inspect, { once: true, rootMargin: '320px 0px' });

  return (
    <article ref={ref} className="group relative flex flex-col overflow-hidden rounded-lg border border-line1 bg-bg2 transition-colors hover:border-line2">
      <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
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
        {isVideo ? <CanvasVideo url={entry.media_url} /> : <MediaThumb url={entry.media_url} alt="Private Canvas output" className="h-full w-full" />}
      </div>
      <div className="flex flex-col gap-0.5 p-2.5">
        <b className="text-[12px] font-semibold text-ink1">Canvas output</b>
        <small className="text-[11px] text-ink3">
          {entry.time_label || (entry.created_at ? new Date(entry.created_at).toLocaleString() : 'Imported from Canvas')}
        </small>
        <small className="truncate text-[11px] text-ink3">{canvasEntryModelLabel(entry)}</small>
        <div className="mt-1 flex items-center gap-1.5">
          {entry.file_format ? <Pill tone="neutral" className="h-5 px-2 text-[10px]">{(entry.file_format || '').toUpperCase()}</Pill> : null}
          <Pill tone={entry.encrypted_at_rest ? 'honey' : 'neutral'} className="h-5 px-2 text-[10px]">
            {entry.encrypted_at_rest ? 'Encrypted at rest' : 'Private output'}
          </Pill>
        </div>
      </div>
    </article>
  );
}

function PromptCard({ entry, onDelete }) {
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
          <Icon name="sparkles" size={16} />
        </button>
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink1">{entry.prompt}</p>
        <HistoryMenu
          items={[
            { label: 'Load in Studio', icon: 'sparkles', onClick: usePrompt },
            { label: 'Copy prompt', icon: 'copy', onClick: () => copyText(entry.prompt) },
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
}

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

export function HistoryView({ active }) {
  const s = useHub();
  const [confirm, setConfirm] = useState(null); // { kind, entry }
  const [deleting, setDeleting] = useState(false);

  const loadMore = useCallback(() => { void loadMoreCanvasHistory(); }, []);
  const sentinelRef = useOnVisible(loadMore, { rootMargin: '900px 0px', resetKey: s.canvasHistory.length });

  const showCanvas = ['', 'canvas'].includes(s.historyFilter);
  const showPrompts = ['', 'prompts', 'favorites'].includes(s.historyFilter);
  const prompts = s.historyFilter === 'favorites' ? s.prompts.filter((entry) => entry.favorite) : s.prompts;

  const runDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    let ok = true;
    if (confirm.kind === 'canvas') ok = await deleteCanvasOutput(confirm.entry.history_id);
    else await deletePrompt(confirm.entry.prompt_id);
    setDeleting(false);
    if (ok) setConfirm(null);
  };

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar kicker="Private archive" title="History">
        <div className="inline-flex items-center gap-0.5 rounded-md border border-line1 bg-bg1 p-0.5">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setHistoryFilter(filter.value)}
              className={cx(
                'h-7 rounded-[7px] px-2.5 text-xs font-medium transition-colors duration-150',
                s.historyFilter === filter.value ? 'bg-bg3 text-ink1 shadow-card' : 'text-ink2 hover:text-ink1',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
        {showCanvas ? (
          <div className="flex items-center gap-2">
            <NativeSelect className="w-32" value={s.canvasFormat} onChange={(e) => setCanvasFilters({ format: e.target.value })}>
              <option value="">All formats</option>
              {s.canvasFormats.map((format) => <option key={format} value={format}>{format}</option>)}
            </NativeSelect>
            <NativeSelect className="w-36" value={s.canvasModel} onChange={(e) => setCanvasFilters({ model: e.target.value })}>
              <option value="">All models</option>
              {s.canvasModels.map((model) => <option key={model} value={model}>{model}</option>)}
            </NativeSelect>
          </div>
        ) : null}
      </HubToolbar>

      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <p className="mb-4 max-w-3xl text-[11px] leading-relaxed text-ink3">
          Owner-only prompts and Canvas outputs live here. Canvas records are imported without prompt graphs, tokens, filesystem paths, or media copies; encrypted source files remain in their original private storage.
        </p>

        <div className="flex flex-col gap-6">
          {showCanvas ? (
            s.canvasHistory.length ? (
              <section className="flex flex-col gap-3">
                <GroupHeading kicker="Canvas" title="Encrypted outputs" right={`${s.canvasHistory.length} of ${s.canvasTotal}`} />
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
                  {s.canvasHistory.map((entry) => (
                    <CanvasCard key={entry.history_id} entry={entry} onDelete={(e) => setConfirm({ kind: 'canvas', entry: e })} />
                  ))}
                </div>
                {s.canvasHasMore ? (
                  <div ref={sentinelRef} className="flex min-h-[1.5rem] items-center justify-center gap-2 py-4 text-xs text-ink3" aria-live="polite">
                    {s.canvasLoading ? <><Spinner size={14} className="text-honey" /> Loading more outputs…</> : null}
                  </div>
                ) : null}
              </section>
            ) : (
              <EmptyState icon="grid" title="No Canvas outputs indexed yet" hint="The source folders remain untouched. Refresh after a Canvas generation finishes." />
            )
          ) : null}

          {showPrompts ? (
            prompts.length ? (
              <section className="flex flex-col gap-3">
                <GroupHeading kicker="Prompt library" title={s.historyFilter === 'favorites' ? 'Favorites' : 'Generation prompts'} />
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                  {prompts.map((entry) => (
                    <PromptCard key={entry.prompt_id} entry={entry} onDelete={(e) => setConfirm({ kind: 'prompt', entry: e })} />
                  ))}
                </div>
              </section>
            ) : (
              <EmptyState
                icon="history"
                title={s.historyFilter === 'favorites' ? 'No favorites yet' : 'No prompts yet'}
                hint={s.historyFilter === 'favorites' ? 'Star a prompt to keep it as a reusable ingredient.' : 'Create a production and its final generation prompt will be recorded here.'}
              />
            )
          ) : null}
        </div>
      </div>

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
