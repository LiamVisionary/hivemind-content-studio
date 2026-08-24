// Discover tab — search Civitai and install straight into the ComfyUI models tree.
//
// Downloads go through the shared civitaiDownloadStore, the same one the studio LoRA
// panel uses: progress survives leaving this view, a second click on a running
// download joins it instead of starting another, and the gateway files each model by
// type (loras / checkpoints / embeddings…). Results paginate on Civitai's cursor
// ("Load more" appends); the rating filter is Safe by default and NSFW previews stay
// blurred until clicked even when they are allowed.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCivitaiDownloads } from '../../../hooks/hooks.js';
import { isCivitaiUrl } from '../../../lib/civitaiDownload.js';
import {
  cancelCivitaiDownload, civitaiDownloadName, civitaiDownloadPercent, clearCivitaiDownload,
  describeCivitaiDownload, startCivitaiDownload,
} from '../../../lib/civitaiDownloadStore.js';
import { localAI } from '../../../lib/localInferenceClient.js';
import {
  CIVITAI_PERIODS, CIVITAI_SORTS, CIVITAI_TYPES, DEFAULT_CIVITAI_FILTERS,
  civitaiSearchParams, formatBytes, formatCount, isCivitaiResultInstalled, mergeCivitaiResults,
} from '../../../lib/modelLibrary.js';
import { Icon } from '../../../ui/icons.jsx';
import { Button, EmptyState, NativeSelect, Pill, ProgressBar, Spinner, TextInput, cx } from '../../../ui/kit.jsx';

const SEARCH_STORAGE = 'models_discover_search_v1';

function readSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(SEARCH_STORAGE) || 'null');
    if (!saved || typeof saved !== 'object') return null;
    return {
      query: typeof saved.query === 'string' ? saved.query : '',
      filters: { ...DEFAULT_CIVITAI_FILTERS, ...(saved.filters && typeof saved.filters === 'object' ? saved.filters : {}) },
    };
  } catch {
    return null;
  }
}

// Failed / finished download controls shared by result cards and URL cards:
// a failed transfer offers Retry and Dismiss instead of sitting on "failed"
// until the page reloads.
function DownloadOutcome({ download, onRetry }) {
  const failed = download?.status === 'error';
  const cancelled = download?.status === 'cancelled';
  const status = describeCivitaiDownload(download);
  return (
    <div className="flex flex-col gap-1">
      <ProgressBar value={failed ? 1 : civitaiDownloadPercent(download) / 100} tone={failed ? 'danger' : 'honey'} label={status || undefined} />
      <div className={cx('min-w-0 break-words text-[10px]', failed ? 'text-danger' : 'text-ink3')}>{status}</div>
      {failed || cancelled ? (
        <div className="flex items-center gap-1.5">
          <Button size="sm" icon="refresh" onClick={onRetry}>Retry</Button>
          <Button size="sm" variant="ghost" onClick={() => clearCivitaiDownload(download.key)}>Dismiss</Button>
        </div>
      ) : null}
    </div>
  );
}

function ResultCard({ item, installed, download, onDownload, nsfwAllowed }) {
  const [hover, setHover] = useState(false);
  // NSFW previews arrive blurred even when the filter lets them through; one
  // click reveals that card only.
  const [revealed, setRevealed] = useState(false);
  const running = download?.status === 'running';
  const failed = download?.status === 'error';
  const cancelled = download?.status === 'cancelled';
  const done = installed || download?.status === 'success';
  const status = describeCivitaiDownload(download);
  const blurred = Boolean(item.nsfw) && nsfwAllowed && !revealed;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={cx(
        'flex min-w-0 flex-col overflow-hidden rounded-md border bg-bg2 transition-colors duration-150',
        done ? 'border-ok/40' : 'border-line1 hover:border-line2',
      )}
    >
      <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-bg3">
        {item.previewUrl ? (
          hover && item.previewKind === 'video' && !blurred ? (
            <video src={item.previewUrl} muted loop autoPlay playsInline className="h-full w-full object-cover" />
          ) : (
            <img
              src={item.previewKind === 'video' ? `${item.previewUrl}${item.previewUrl.includes('?') ? '&' : '?'}anim=0` : item.previewUrl}
              alt=""
              loading="lazy"
              className={cx('h-full w-full object-cover transition-[filter] duration-200', blurred && 'scale-105 blur-lg')}
            />
          )
        ) : (
          <Icon name="image" size={18} className="text-ink3" />
        )}
        {blurred ? (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bg0/40 text-ink1"
            aria-label={`Reveal the preview for ${item.name}`}
          >
            <Icon name="eye" size={16} />
            <span className="text-[10px] font-semibold">Click to reveal</span>
          </button>
        ) : null}
        {item.nsfw ? (
          <span className="absolute left-1 top-1 rounded-sm bg-bg0/80 px-1 py-px text-[9px] font-semibold uppercase text-warn">18+</span>
        ) : null}
        {done ? (
          <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-ok text-bg0">
            <Icon name="check" size={11} />
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2.5">
        <div className="truncate text-xs font-semibold text-ink1" title={item.name}>{item.name}</div>
        <div className="truncate text-[10px] text-ink3">
          {[item.type, item.baseModel, item.creator && `by ${item.creator}`].filter(Boolean).join(' · ')}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-ink3">
          <span className="inline-flex items-center gap-1" title="Downloads"><Icon name="download" size={9} />{formatCount(item.downloads)}</span>
          <span className="inline-flex items-center gap-1" title="Likes"><Icon name="heart" size={9} />{formatCount(item.likes)}</span>
          {item.sizeBytes ? <span className="font-mono">{formatBytes(item.sizeBytes)}</span> : null}
        </div>

        {running ? (
          <div className="flex flex-col gap-1">
            <ProgressBar value={civitaiDownloadPercent(download) / 100} label={status || undefined} />
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[10px] text-ink3">{status}</span>
              <button
                type="button"
                onClick={() => void cancelCivitaiDownload(localAI, download.key)}
                disabled={download.cancelling}
                className="shrink-0 text-[10px] font-medium text-ink3 transition-colors hover:text-danger disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : failed || cancelled ? (
          <DownloadOutcome download={download} onRetry={() => { clearCivitaiDownload(download.key); onDownload(item); }} />
        ) : (
          <div className="mt-auto flex items-center gap-1.5 pt-0.5">
            <Button
              size="sm"
              variant="neutral"
              icon={done ? 'check' : 'download'}
              disabled={done || !item.versionId}
              onClick={() => onDownload(item)}
              className="flex-1"
            >
              {done ? 'Installed' : 'Download'}
            </Button>
            {item.url ? (
              <button
                type="button"
                onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}
                title="Open on Civitai"
                aria-label={`Open ${item.name} on Civitai`}
                className="grid h-ctl-sm w-7 shrink-0 place-items-center rounded-sm text-ink3 transition-colors hover:bg-bg3 hover:text-ink1"
              >
                <Icon name="external" size={13} />
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export function CivitaiBrowser({ onInstalled, baseModelOptions }) {
  // Lazy initialisers: the last search is restored once, not re-read per render.
  const [query, setQuery] = useState(() => readSaved()?.query || '');
  const [filters, setFilters] = useState(() => readSaved()?.filters || DEFAULT_CIVITAI_FILTERS);
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [installed, setInstalled] = useState({ versionIds: new Set(), fileIds: new Set() });
  const [state, setState] = useState({ status: 'idle', message: '' });
  const downloads = useCivitaiDownloads();
  const searchable = localAI.supportsCivitaiSearch();

  useEffect(() => {
    try {
      localStorage.setItem(SEARCH_STORAGE, JSON.stringify({ query, filters }));
    } catch { /* quota */ }
  }, [query, filters]);

  const setFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }));

  const search = useCallback(async (nextQuery, nextFilters) => {
    setState({ status: 'loading', message: 'Searching Civitai…' });
    setNextCursor('');
    try {
      const result = await localAI.searchCivitai(civitaiSearchParams(nextQuery, nextFilters));
      setItems(result.items);
      setNextCursor(result.nextCursor || '');
      setInstalled({
        versionIds: new Set(result.installedVersionIds),
        fileIds: new Set(result.installedFileIds),
      });
      setState({
        status: 'done',
        message: result.items.length
          ? `${result.items.length} result${result.items.length === 1 ? '' : 's'}${result.nextCursor ? ' · more available' : ''}`
          : 'No results. Widen the filters or try a different term.',
      });
    } catch (error) {
      setItems([]);
      setState({ status: 'error', message: error.message });
    }
  }, []);

  // The next page, appended and deduped; the filters are the ones the current
  // results were searched with.
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await localAI.searchCivitai(civitaiSearchParams(query, filters, nextCursor));
      setItems((current) => mergeCivitaiResults(current, result.items));
      setNextCursor(result.nextCursor || '');
      setInstalled({
        versionIds: new Set(result.installedVersionIds),
        fileIds: new Set(result.installedFileIds),
      });
    } catch (error) {
      setState({ status: 'error', message: error.message });
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, query, filters]);

  // A pasted Civitai URL is a download instruction, not a search term — the old
  // surface had a separate box for it, which only ever confused the two.
  const pastedUrl = isCivitaiUrl(query.trim());
  const submit = (event) => {
    event?.preventDefault?.();
    if (pastedUrl) {
      startCivitaiDownload(localAI, query.trim(), { onComplete: onInstalled });
      setState({ status: 'done', message: 'Download started — progress is on the card below.' });
      return;
    }
    void search(query, filters);
  };

  const byUrl = useMemo(() => new Map(downloads.map((item) => [item.url, item])), [downloads]);
  const urlDownloads = useMemo(
    () => downloads.filter((item) => !items.some((result) => result.url === item.url)),
    [downloads, items],
  );
  const nsfwAllowed = filters.nsfw === 'true' || filters.nsfw === '';

  if (!searchable) {
    return (
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <EmptyState
          icon="cloud"
          title="Civitai browsing needs the hosted bridge"
          hint="This build talks to models it manages itself. Browsing and installing from Civitai needs the hosted bridge — the Mac running the stack."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form onSubmit={submit} className="flex flex-col gap-2 border-b border-line1 px-4 py-2.5 md:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink3" />
            <TextInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search Civitai, or paste a model URL to install it"
              aria-label="Search Civitai"
              className="pl-8"
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            icon={pastedUrl ? 'download' : 'search'}
            loading={state.status === 'loading'}
          >
            {pastedUrl ? 'Install URL' : 'Search'}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect aria-label="Type" value={filters.types} onChange={(event) => setFilter('types', event.target.value)} className="w-[150px]">
            {CIVITAI_TYPES.map((value) => <option key={value} value={value}>{value === 'TextualInversion' ? 'Embedding' : value}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Base model" value={filters.baseModels} onChange={(event) => setFilter('baseModels', event.target.value)} className="w-[170px]">
            <option value="">Any base model</option>
            {baseModelOptions.map((value) => <option key={value} value={value}>{value}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Sort" value={filters.sort} onChange={(event) => setFilter('sort', event.target.value)} className="w-[160px]">
            {CIVITAI_SORTS.map((value) => <option key={value} value={value}>{value}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Period" value={filters.period} onChange={(event) => setFilter('period', event.target.value)} className="w-[120px]">
            {CIVITAI_PERIODS.map((value) => <option key={value} value={value}>{value === 'AllTime' ? 'All time' : value}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Rating" value={filters.nsfw} onChange={(event) => setFilter('nsfw', event.target.value)} className="w-[150px]">
            <option value="false">Safe only</option>
            <option value="true">Include NSFW</option>
            <option value="">Any rating</option>
          </NativeSelect>
          <NativeSelect aria-label="Results per page" value={filters.limit} onChange={(event) => setFilter('limit', event.target.value)} className="w-[110px]">
            {['20', '40', '60', '100'].map((value) => <option key={value} value={value}>{value} results</option>)}
          </NativeSelect>
        </div>
      </form>

      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <div className="mb-3 flex items-center gap-2">
          {state.status === 'loading' ? <Spinner size={13} className="text-honey" /> : null}
          <span className={cx('text-[11px]', state.status === 'error' ? 'text-danger' : 'text-ink3')}>
            {state.message || 'Search Civitai to find LoRAs, checkpoints and embeddings.'}
          </span>
        </div>

        {/* Downloads started from a pasted URL have no result card to live on. */}
        {urlDownloads.length ? (
          <div className="mb-4 flex flex-col gap-2">
            {urlDownloads.map((download) => (
              <div key={download.key} className="rounded-md border border-line1 bg-bg2 p-2.5">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-xs font-medium text-ink1" title={download.url}>{civitaiDownloadName(download)}</span>
                  <Pill tone={download.status === 'error' ? 'danger' : download.status === 'success' ? 'ok' : download.status === 'cancelled' ? 'warn' : 'honey'} dot>
                    {download.status}
                  </Pill>
                </div>
                {download.status === 'error' || download.status === 'cancelled' ? (
                  <DownloadOutcome
                    download={download}
                    onRetry={() => { clearCivitaiDownload(download.key); startCivitaiDownload(localAI, download.url, { onComplete: onInstalled }); }}
                  />
                ) : (
                  <>
                    <ProgressBar value={civitaiDownloadPercent(download) / 100} tone={download.status === 'success' ? 'ok' : 'honey'} />
                    <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-ink3">
                      <span className="min-w-0 truncate">{describeCivitaiDownload(download)}</span>
                      {download.status === 'success' ? (
                        <button type="button" onClick={() => clearCivitaiDownload(download.key)} className="shrink-0 font-medium text-ink3 hover:text-ink1">Dismiss</button>
                      ) : download.status === 'running' ? (
                        <button
                          type="button"
                          onClick={() => void cancelCivitaiDownload(localAI, download.key)}
                          disabled={download.cancelling}
                          className="shrink-0 font-medium text-ink3 transition-colors hover:text-danger disabled:opacity-40"
                        >
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        ) : null}

        {items.length ? (
          <>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
              {items.map((item) => (
                <ResultCard
                  key={`${item.id}-${item.versionId}`}
                  item={item}
                  installed={isCivitaiResultInstalled(item, installed)}
                  download={byUrl.get(item.url) || null}
                  nsfwAllowed={nsfwAllowed}
                  onDownload={(result) => startCivitaiDownload(localAI, result.url, { onComplete: onInstalled })}
                />
              ))}
            </div>
            {nextCursor ? (
              <div className="mt-4 flex justify-center">
                <Button icon="chevronDown" loading={loadingMore} onClick={() => void loadMore()}>Load more</Button>
              </div>
            ) : null}
          </>
        ) : state.status !== 'loading' ? (
          <EmptyState
            icon="search"
            title={state.status === 'error' ? 'Civitai search failed' : 'Nothing to show yet'}
            hint={state.status === 'error'
              ? state.message
              : 'Search by name, or paste a civitai.com model URL to install it directly.'}
          />
        ) : null}
      </div>
    </div>
  );
}
