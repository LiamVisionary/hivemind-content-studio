// Inspo — browse what people made on Civitai, and take the prompt.
//
// The Models view's Discover tab browses models to INSTALL. This browses the
// gallery: images and videos other people generated, kept only when they came
// with a prompt worth reusing, with one button that loads that prompt (and the
// steps/CFG/seed/size that came with it) straight into the studio it belongs in.
//
// Two things shape this surface, both upstream facts rather than choices:
//
//   * A prompt is not guaranteed. Civitai's `withMeta=true` INCLUDES metadata,
//     it does not filter by it, and roughly half of any page has nothing usable
//     — so the gateway over-fetches and filters, and the footer reports how many
//     raw results it read. A thin page is Civitai being thin, not a bug here.
//   * The artwork is proxied. Every preview comes through /local-ai/model-preview
//     like the model browser's card art, so browsing inspiration never opens a
//     connection from this page to Civitai's CDN. The only thing that leaves is
//     the search itself, from the Mac, on the owner's own key.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { loadStudioSetup } from '../../app/promptTarget.js';
import {
  DEFAULT_INSPO_FILTERS, INSPO_KINDS, INSPO_PERIODS, INSPO_SORTS,
  inspoCredits, inspoSearchParams, inspoSection, inspoSettings, inspoToStudioSetup, mergeInspoResults,
} from '../../lib/civitaiInspo.js';
import { zh } from '../../lib/i18n.js';
import { localAI } from '../../lib/localInferenceClient.js';
import { formatCount } from '../../lib/modelLibrary.js';
import { Icon } from '../../ui/icons.jsx';
import { Modal } from '../../ui/Modal.jsx';
import { Button, EmptyState, NativeSelect, Segmented, Spinner, TextInput, cx } from '../../ui/kit.jsx';
import { HubToolbar } from '../components/HubToolbar.jsx';

const FILTER_STORAGE = 'inspo_filters_v1';

function readSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_STORAGE) || 'null');
    if (!saved || typeof saved !== 'object') return null;
    return { ...DEFAULT_INSPO_FILTERS, ...saved };
  } catch {
    return null;
  }
}

/** Send a result's prompt and settings to the studio it belongs in. Shared by
 *  the card and the detail dialog so both do exactly the same thing. */
function sendToStudio(item) {
  const section = inspoSection(item);
  loadStudioSetup(section, inspoToStudioSetup(item));
  window.dispatchEvent(new CustomEvent('navigate', { detail: { page: section } }));
  toast.success(section === 'video'
    ? (zh() ? '提示词已载入视频工作室。' : 'Prompt loaded into the Video studio.')
    : (zh() ? '提示词已载入图片工作室。' : 'Prompt loaded into the Image studio.'));
}

function Preview({ item, playing, className = '' }) {
  // Poster frames for VIDEO results are transcoded by Civitai on demand, and a
  // cold one takes many seconds to arrive (measured 2026-08-28: a fresh grid of
  // 24 filled over ~20s, none failed). Without something behind them the whole
  // tab reads as broken while they land, so a placeholder is rendered until the
  // image decodes over it.
  const [ready, setReady] = useState(false);
  // A video card holds its still until hovered — the still is ~280 KB against
  // ~1.8 MB of motion, so a grid of clips costs about what a grid of stills does.
  if (item.kind === 'video' && playing) {
    return <video src={item.previewUrl} muted loop autoPlay playsInline className={className} />;
  }
  const src = item.kind === 'video' ? (item.stillUrl || item.previewUrl) : item.previewUrl;
  return (
    <>
      {!ready ? (
        <span className="absolute inset-0 grid place-items-center text-ink3">
          <Icon name={item.kind === 'video' ? 'video' : 'image'} size={18} />
        </span>
      ) : null}
      <img src={src} alt="" loading="lazy" onLoad={() => setReady(true)} className={className} />
    </>
  );
}

function ResultCard({ item, onOpen, nsfwAllowed }) {
  const [hover, setHover] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const blurred = Boolean(item.nsfw) && nsfwAllowed && !revealed;
  const credits = inspoCredits(item);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line1 bg-bg2 transition-colors duration-150 hover:border-line2"
    >
      <button
        type="button"
        onClick={() => (blurred ? setRevealed(true) : onOpen(item))}
        aria-label={blurred ? 'Reveal this preview' : 'Open this result'}
        className="relative flex aspect-[3/4] items-center justify-center overflow-hidden bg-bg3"
      >
        {item.previewUrl ? (
          <Preview
            item={item}
            playing={hover && !blurred}
            className={cx('h-full w-full object-cover transition-[filter] duration-200', blurred && 'scale-105 blur-lg')}
          />
        ) : (
          <Icon name="image" size={18} className="text-ink3" />
        )}
        {blurred ? (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bg0/40 text-ink1">
            <Icon name="eye" size={16} />
            <span className="text-[10px] font-semibold">Click to reveal</span>
          </span>
        ) : null}
        {item.nsfw ? (
          <span className="absolute left-1 top-1 rounded-sm bg-bg0/80 px-1 py-px text-[9px] font-semibold uppercase text-warn">18+</span>
        ) : null}
        {item.kind === 'video' ? (
          <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-bg0/80 text-ink1">
            <Icon name="video" size={11} />
          </span>
        ) : null}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2.5">
        {/* The prompt IS the content here — it leads the card, not the metadata. */}
        <p className="line-clamp-3 min-w-0 break-words text-[11px] leading-relaxed text-ink1" title={item.prompt}>
          {item.prompt}
        </p>
        <div className="truncate text-[10px] text-ink3" title={credits}>
          {[credits, item.username && `by ${item.username}`].filter(Boolean).join(' · ')}
        </div>
        <div className="mt-auto flex items-center gap-1.5 pt-0.5">
          <Button
            size="sm"
            variant="neutral"
            icon="sparkles"
            className="flex-1"
            onClick={() => sendToStudio(item)}
          >
            {zh() ? '使用提示词' : 'Use prompt'}
          </Button>
          <button
            type="button"
            onClick={() => onOpen(item)}
            title={zh() ? '详情' : 'Details'}
            aria-label="Show the full prompt and settings"
            className="grid h-ctl-sm w-7 shrink-0 place-items-center rounded-sm text-ink3 transition-colors hover:bg-bg3 hover:text-ink1"
          >
            <Icon name="expand" size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailDialog({ item, onClose }) {
  const settings = inspoSettings(item);
  const loras = (item.resources || []).filter((entry) => String(entry?.type || '').toLowerCase() === 'lora');
  const copy = (text, label) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success(`${label} copied.`),
      () => toast.error('Could not copy to the clipboard.'),
    );
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={item.kind === 'video' ? 'Civitai video' : 'Civitai image'}
      size="xl"
      footer={
        <>
          {item.pageUrl ? (
            <Button
              variant="neutral"
              icon="external"
              className="mr-auto"
              onClick={() => window.open(item.pageUrl, '_blank', 'noopener,noreferrer')}
            >
              {zh() ? '在 Civitai 打开' : 'Open on Civitai'}
            </Button>
          ) : null}
          <Button variant="neutral" icon="copy" onClick={() => copy(item.prompt, 'Prompt')}>
            {zh() ? '复制提示词' : 'Copy prompt'}
          </Button>
          <Button variant="primary" icon="sparkles" onClick={() => { sendToStudio(item); onClose(); }}>
            {item.kind === 'video'
              ? (zh() ? '载入视频工作室' : 'Use in Video studio')
              : (zh() ? '载入图片工作室' : 'Use in Image studio')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid place-items-center overflow-hidden rounded-lg border border-line1 bg-bg0">
          {item.kind === 'video' ? (
            /* nodownload: the studio keeps exactly one download path so names
               stay consistent, and Chrome names a native blob download after
               the URL's UUID. Saving somebody else's Civitai clip is not a
               thing this surface offers anyway — "Open on Civitai" is. */
            <video src={item.previewUrl} controls controlsList="nodownload" muted loop autoPlay playsInline className="max-h-[46vh] w-auto max-w-full" />
          ) : (
            <img src={item.previewUrl} alt="" className="max-h-[46vh] w-auto max-w-full object-contain" />
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">{zh() ? '提示词' : 'Prompt'}</span>
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line1 bg-bg2 p-2.5 font-mono text-xs leading-relaxed text-ink1">
            {item.prompt}
          </p>
        </div>

        {item.negativePrompt ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">{zh() ? '负面提示词' : 'Negative prompt'}</span>
            <p className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line1 bg-bg2 p-2.5 font-mono text-xs leading-relaxed text-ink2">
              {item.negativePrompt}
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-ink2">
          {item.width && item.height ? (
            <span><span className="text-ink3">Size</span> <span className="font-mono">{item.width}×{item.height}</span></span>
          ) : null}
          {settings.map(([label, value]) => (
            <span key={label}><span className="text-ink3">{label}</span> <span className="font-mono">{String(value)}</span></span>
          ))}
        </div>

        {/* Named so it is obvious the model is NOT coming across with the
            prompt — the id is Civitai's and means nothing to this machine. */}
        {item.baseModel || item.modelName || loras.length ? (
          <div className="rounded-md border border-line1 bg-bg2 p-2.5 text-[11px] text-ink2">
            <div className="mb-1 font-medium text-ink1">{zh() ? '原作使用' : 'Made with'}</div>
            {item.baseModel ? <div>{zh() ? '基础模型' : 'Base model'}: <span className="font-mono">{item.baseModel}</span></div> : null}
            {item.modelName ? <div>{zh() ? '检查点' : 'Checkpoint'}: <span className="font-mono">{item.modelName}</span></div> : null}
            {loras.map((entry, index) => (
              <div key={`${entry.modelVersionId}-${index}`}>
                LoRA: <span className="font-mono">{entry.modelVersionName || entry.modelVersionId}</span>
                {entry.weight != null ? <span className="text-ink3"> @ {entry.weight}</span> : null}
              </div>
            ))}
            <div className="mt-1.5 text-ink3">
              {zh()
                ? '仅载入提示词与参数：模型不会被切换，可在“模型”页安装这些资源。'
                : 'Only the prompt and settings are loaded — your model is not switched. Install these from the Models page to match it exactly.'}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function InspoView({ active }) {
  const [filters, setFilters] = useState(() => readSaved() || DEFAULT_INSPO_FILTERS);
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState('');
  const [scanned, setScanned] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState(null);
  const [baseModelOptions, setBaseModelOptions] = useState([]);
  const [state, setState] = useState({ status: 'idle', message: '' });
  const loadedRef = useRef(false);
  const supported = localAI.supportsCivitaiImages();

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_STORAGE, JSON.stringify(filters));
    } catch { /* quota */ }
  }, [filters]);

  const setFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }));

  const search = useCallback(async (nextFilters) => {
    setState({ status: 'loading', message: zh() ? '正在搜索 Civitai…' : 'Searching Civitai…' });
    setNextCursor('');
    try {
      const result = await localAI.searchCivitaiImages(inspoSearchParams(nextFilters));
      setItems(result.items);
      setNextCursor(result.nextCursor || '');
      setScanned(result.scanned || 0);
      if (result.baseModelOptions.length) setBaseModelOptions(result.baseModelOptions);
      setState({
        status: 'done',
        message: result.items.length
          ? `${result.items.length} with prompts${result.scanned ? ` · read ${result.scanned}` : ''}`
          : 'Nothing with a usable prompt here. Widen the period, or try the other media type.',
      });
    } catch (error) {
      setItems([]);
      setState({ status: 'error', message: error.message });
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await localAI.searchCivitaiImages(inspoSearchParams(filters, nextCursor));
      setItems((current) => mergeInspoResults(current, result.items));
      setNextCursor(result.nextCursor || '');
      setScanned((current) => current + (result.scanned || 0));
    } catch (error) {
      setState({ status: 'error', message: error.message });
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, filters]);

  // First activation only — the hub keeps every view mounted forever.
  useEffect(() => {
    if (!active || loadedRef.current || !supported) return;
    loadedRef.current = true;
    void search(filters);
    void localAI.listCivitaiBaseModels().then((list) => {
      if (list.length) setBaseModelOptions(list);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, supported]);

  const switchKind = useCallback((kind) => {
    if (kind === filters.kind) return;
    const next = { ...filters, kind };
    setFilters(next);
    void search(next);
  }, [filters, search]);

  const nsfwAllowed = filters.nsfw === 'true' || filters.nsfw === '';
  const kindOptions = useMemo(
    () => INSPO_KINDS.map((entry) => ({ value: entry.value, label: zh() ? entry.zh : entry.label })),
    [],
  );

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar
        kicker="Civitai"
        title={zh() ? '灵感' : 'Inspo'}
        right={
          <>
            {state.status === 'loading' ? <Spinner size={14} className="text-honey" /> : null}
            {/* This reads as a tab, so it behaves like one: switching media
                type searches immediately. The dropdowns below stay manual —
                they compose into one query and share the Search button, the
                same way the model browser's filters do. */}
            <Segmented options={kindOptions} value={filters.kind} onChange={(value) => switchKind(value)} />
            <Button icon="refresh" onClick={() => void search(filters)}>{zh() ? '刷新' : 'Refresh'}</Button>
          </>
        }
      />

      {!supported ? (
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
          <EmptyState
            icon="cloud"
            title="The inspiration finder needs the hosted bridge"
            hint="Browsing Civitai runs on the Mac that holds the stack and its Civitai key. This build has no bridge to it."
          />
        </div>
      ) : (
        <>
          <form
            onSubmit={(event) => { event.preventDefault(); void search(filters); }}
            className="flex flex-wrap items-center gap-2 border-b border-line1 px-4 py-2.5 md:px-5"
          >
            <div className="relative min-w-[180px] flex-1">
              <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink3" />
              <TextInput
                value={filters.username || ''}
                onChange={(event) => setFilter('username', event.target.value)}
                placeholder={zh() ? '按创作者筛选（可选）' : 'Filter by creator (optional)'}
                aria-label="Civitai creator"
                className="pl-8"
              />
            </div>
            <NativeSelect aria-label="Base model" value={filters.baseModels} onChange={(event) => setFilter('baseModels', event.target.value)} className="w-[170px]">
              <option value="">{zh() ? '任意基础模型' : 'Any base model'}</option>
              {baseModelOptions.map((value) => <option key={value} value={value}>{value}</option>)}
            </NativeSelect>
            <NativeSelect aria-label="Sort" value={filters.sort} onChange={(event) => setFilter('sort', event.target.value)} className="w-[160px]">
              {INSPO_SORTS.map((value) => <option key={value} value={value}>{value}</option>)}
            </NativeSelect>
            <NativeSelect aria-label="Period" value={filters.period} onChange={(event) => setFilter('period', event.target.value)} className="w-[120px]">
              {INSPO_PERIODS.map((value) => <option key={value} value={value}>{value === 'AllTime' ? 'All time' : value}</option>)}
            </NativeSelect>
            <NativeSelect aria-label="Rating" value={filters.nsfw} onChange={(event) => setFilter('nsfw', event.target.value)} className="w-[150px]">
              <option value="false">Safe only</option>
              <option value="true">Include NSFW</option>
              <option value="">Any rating</option>
            </NativeSelect>
            <Button type="submit" variant="primary" icon="search" loading={state.status === 'loading'}>
              {zh() ? '搜索' : 'Search'}
            </Button>
          </form>

          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
            <div className="mb-3 flex items-center gap-2">
              <span className={cx('text-[11px]', state.status === 'error' ? 'text-danger' : 'text-ink3')}>
                {state.message || 'Every result here came with a prompt you can load.'}
              </span>
            </div>

            {items.length ? (
              <>
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
                  {items.map((item) => (
                    <ResultCard key={item.id} item={item} onOpen={setSelected} nsfwAllowed={nsfwAllowed} />
                  ))}
                </div>
                {nextCursor ? (
                  <div className="mt-4 flex justify-center">
                    <Button icon="chevronDown" loading={loadingMore} onClick={() => void loadMore()}>
                      {zh() ? '加载更多' : 'Load more'}
                    </Button>
                  </div>
                ) : null}
                {/* Said plainly, because the count above is post-filter and would
                    otherwise look like Civitai is nearly empty. */}
                <p className="mt-4 text-center text-[10px] text-ink3">
                  {scanned
                    ? `Read ${formatCount(scanned)} Civitai results to find these ${items.length}. The rest were posted without a prompt.`
                    : null}
                </p>
              </>
            ) : state.status !== 'loading' ? (
              <EmptyState
                icon={state.status === 'error' ? 'warning' : 'sparkles'}
                title={state.status === 'error' ? 'Civitai search failed' : 'Nothing to show yet'}
                hint={state.status === 'error' ? state.message : 'Search to see images and videos that came with their prompt.'}
                action={state.status === 'error' ? <Button onClick={() => void search(filters)}>Retry</Button> : null}
              />
            ) : null}
          </div>
        </>
      )}

      {selected ? <DetailDialog item={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
