// Discover tab — search Civitai and install straight into the ComfyUI models tree.
//
// Downloads go through the shared civitaiDownloadStore, the same one the studio LoRA
// panel uses: progress survives leaving this view, a second click on a running
// download joins it instead of starting another, and the gateway files each model by
// type (loras / checkpoints / embeddings…).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCivitaiDownloads } from '../../../hooks/hooks.js';
import { isCivitaiUrl } from '../../../lib/civitaiDownload.js';
import {
  cancelCivitaiDownload, civitaiDownloadPercent, describeCivitaiDownload, startCivitaiDownload,
} from '../../../lib/civitaiDownloadStore.js';
import { localAI } from '../../../lib/localInferenceClient.js';
import {
  CIVITAI_PERIODS, CIVITAI_SORTS, CIVITAI_TYPES, DEFAULT_CIVITAI_FILTERS,
  civitaiSearchParams, formatBytes, formatCount, isCivitaiResultInstalled,
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

function ResultCard({ item, installed, download, onDownload }) {
  const [hover, setHover] = useState(false);
  const running = download?.status === 'running';
  const failed = download?.status === 'error';
  const done = installed || download?.status === 'success';
  const status = describeCivitaiDownload(download);
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
          hover && item.previewKind === 'video' ? (
            <video src={item.previewUrl} muted loop autoPlay playsInline className="h-full w-full object-cover" />
          ) : (
            <img
              src={item.previewKind === 'video' ? `${item.previewUrl}${item.previewUrl.includes('?') ? '&' : '?'}anim=0` : item.previewUrl}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          )
        ) : (
          <Icon name="image" size={18} className="text-ink3" />
        )}
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
          <span className="inline-flex items-center gap-1"><Icon name="download" size={9} />{formatCount(item.downloads)}</span>
          <span className="inline-flex items-center gap-1"><Icon name="check" size={9} />{formatCount(item.likes)}</span>
          {item.sizeBytes ? <span className="font-mono">{formatBytes(item.sizeBytes)}</span> : null}
        </div>

        {running || failed ? (
          <div className="flex flex-col gap-1">
            <ProgressBar value={failed ? 1 : civitaiDownloadPercent(download) / 100} />
            <div className="flex items-center justify-between gap-2">
              <span className={cx('min-w-0 truncate text-[10px]', failed ? 'text-danger' : 'text-ink3')}>{status}</span>
              {running ? (
                <button
                  type="button"
                  onClick={() => void cancelCivitaiDownload(localAI, download.key)}
                  disabled={download.cancelling}
                  className="shrink-0 text-[10px] font-medium text-ink3 transition-colors hover:text-danger disabled:opacity-40"
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="mt-auto flex items-center gap-1.5 pt-0.5">
            <Button
              size="sm"
              variant={done ? 'neutral' : 'primary'}
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
    try {
      const result = await localAI.searchCivitai(civitaiSearchParams(nextQuery, nextFilters));
      setItems(result.items);
      setInstalled({
        versionIds: new Set(result.installedVersionIds),
        fileIds: new Set(result.installedFileIds),
      });
      setState({
        status: 'done',
        message: result.items.length
          ? `${result.items.length} result${result.items.length === 1 ? '' : 's'}`
          : 'No results. Widen the filters or try a different term.',
      });
    } catch (error) {
      setItems([]);
      setState({ status: 'error', message: error.message });
    }
  }, []);

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

  if (!searchable) {
    return (
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <EmptyState
          icon="cloud"
          title="Civitai browsing needs the local bridge"
          hint="This build talks to models it manages itself. Run the app through Unified Studio to browse and install from Civitai."
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
          <NativeSelect value={filters.types} onChange={(event) => setFilter('types', event.target.value)} className="w-[150px]">
            {CIVITAI_TYPES.map((value) => <option key={value} value={value}>{value === 'TextualInversion' ? 'Embedding' : value}</option>)}
          </NativeSelect>
          <NativeSelect value={filters.baseModels} onChange={(event) => setFilter('baseModels', event.target.value)} className="w-[170px]">
            <option value="">Any base model</option>
            {baseModelOptions.map((value) => <option key={value} value={value}>{value}</option>)}
          </NativeSelect>
          <NativeSelect value={filters.sort} onChange={(event) => setFilter('sort', event.target.value)} className="w-[160px]">
            {CIVITAI_SORTS.map((value) => <option key={value} value={value}>{value}</option>)}
          </NativeSelect>
          <NativeSelect value={filters.period} onChange={(event) => setFilter('period', event.target.value)} className="w-[120px]">
            {CIVITAI_PERIODS.map((value) => <option key={value} value={value}>{value === 'AllTime' ? 'All time' : value}</option>)}
          </NativeSelect>
          <NativeSelect value={filters.nsfw} onChange={(event) => setFilter('nsfw', event.target.value)} className="w-[130px]">
            <option value="">Any rating</option>
            <option value="false">Safe only</option>
            <option value="true">Include NSFW</option>
          </NativeSelect>
          <NativeSelect value={filters.limit} onChange={(event) => setFilter('limit', event.target.value)} className="w-[110px]">
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
                  <span className="min-w-0 truncate text-xs font-medium text-ink1">{download.url}</span>
                  <Pill tone={download.status === 'error' ? 'danger' : download.status === 'success' ? 'ok' : 'honey'} dot>
                    {download.status}
                  </Pill>
                </div>
                <ProgressBar value={civitaiDownloadPercent(download) / 100} />
                <div className="mt-1 text-[10px] text-ink3">{describeCivitaiDownload(download)}</div>
              </div>
            ))}
          </div>
        ) : null}

        {items.length ? (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
            {items.map((item) => (
              <ResultCard
                key={`${item.id}-${item.versionId}`}
                item={item}
                installed={isCivitaiResultInstalled(item, installed)}
                download={byUrl.get(item.url) || null}
                onDownload={(result) => startCivitaiDownload(localAI, result.url, { onComplete: onInstalled })}
              />
            ))}
          </div>
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
