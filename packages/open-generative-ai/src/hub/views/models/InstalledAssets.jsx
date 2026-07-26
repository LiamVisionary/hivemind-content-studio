// Installed tab — every weight file on disk: LoRAs, checkpoints, embeddings and the
// support files (VAEs, encoders, upscalers) the workflows load.
//
// The old surface put base model, tag, sort, density, favourites and
// missing-previews behind a slide-out drawer plus a hamburger. The filters that
// actually get used live in one row here; the rest are gone rather than hidden.
import { useMemo, useState } from 'react';
import {
  ASSET_KINDS, ASSET_SORTS, assetBaseModels, filterAssets, formatBytes, librarySummary, sortAssets,
} from '../../../lib/modelLibrary.js';
import { EmptyState, NativeSelect, Pill, Segmented, TextInput, cx } from '../../../ui/kit.jsx';
import { Icon } from '../../../ui/icons.jsx';
import { AssetPreview } from './AssetPreview.jsx';

function AssetCard({ asset, onOpen }) {
  const [hover, setHover] = useState(false);
  const label = asset.displayName || asset.name;
  return (
    <button
      type="button"
      onClick={() => onOpen(asset)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      title={asset.name}
      className="group flex min-w-0 flex-col overflow-hidden rounded-md border border-line1 bg-bg2 text-left transition-colors duration-150 hover:border-line2 hover:bg-bg3"
    >
      <AssetPreview asset={asset} playMotion={hover} className="aspect-[4/3] w-full" />
      <div className="flex min-w-0 flex-col gap-1 p-2">
        <div className="truncate text-xs font-semibold text-ink1">{label}</div>
        {/* Quantised variants of one checkpoint share a display name ("Big Love" ×4),
            so the filename is what actually tells them apart. */}
        {label !== asset.name ? (
          <div className="truncate font-mono text-[10px] text-ink3">{asset.name}</div>
        ) : null}
        <div className="flex items-center justify-between gap-2 text-[10px] text-ink3">
          <span className="truncate">{asset.baseModel}</span>
          <span className="shrink-0 font-mono">{asset.size || formatBytes(asset.sizeBytes)}</span>
        </div>
        {asset.triggerWords?.length ? (
          <div className="truncate font-mono text-[10px] text-honey/80">{asset.triggerWords.join(', ')}</div>
        ) : null}
      </div>
    </button>
  );
}

function AssetRow({ asset, onOpen }) {
  const label = asset.displayName || asset.name;
  return (
    <button
      type="button"
      onClick={() => onOpen(asset)}
      title={asset.name}
      className="grid w-full grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-line1 bg-bg2 p-1.5 text-left transition-colors hover:border-line2 hover:bg-bg3"
    >
      <AssetPreview asset={asset} className="h-9 w-9 rounded-sm" />
      <div className="min-w-0">
        <div className="truncate text-xs font-semibold text-ink1">{label}</div>
        <div className="truncate text-[10px] text-ink3">{asset.name}</div>
      </div>
      <div className="flex shrink-0 items-center gap-3 pr-1 text-[10px] text-ink3">
        <span className="hidden sm:inline">{asset.baseModel}</span>
        <span className="font-mono">{asset.size || formatBytes(asset.sizeBytes)}</span>
      </div>
    </button>
  );
}

export function InstalledAssets({ assets, onOpenAsset }) {
  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const [baseModel, setBaseModel] = useState('');
  const [sort, setSort] = useState('name');
  const [dense, setDense] = useState(false);

  const summary = useMemo(() => librarySummary(assets), [assets]);
  const baseModels = useMemo(() => assetBaseModels(assets), [assets]);
  const visible = useMemo(
    () => sortAssets(filterAssets(assets, { kind, query, baseModel }), sort),
    [assets, kind, query, baseModel, sort],
  );

  // Counts ride along in the kind switch: it is the only place they change anything.
  const kindOptions = ASSET_KINDS.map((option) => ({
    value: option.value,
    label: option.value === 'all'
      ? `${option.label} ${summary.total}`
      : `${option.label} ${summary.byKind[option.value] || 0}`,
  }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line1 px-4 py-2.5 md:px-5">
        <Segmented options={kindOptions} value={kind} onChange={setKind} size="sm" />
        <div className="relative min-w-[180px] flex-1">
          <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink3" />
          <TextInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, trigger word, creator…"
            className="pl-8"
          />
        </div>
        <NativeSelect value={baseModel} onChange={(event) => setBaseModel(event.target.value)} className="w-[150px]">
          <option value="">Any base model</option>
          {baseModels.map((value) => <option key={value} value={value}>{value}</option>)}
        </NativeSelect>
        <NativeSelect value={sort} onChange={(event) => setSort(event.target.value)} className="w-[140px]">
          {ASSET_SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </NativeSelect>
        <Segmented
          options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]}
          value={dense ? 'list' : 'grid'}
          onChange={(value) => setDense(value === 'list')}
          size="sm"
        />
      </div>

      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Pill tone="neutral" className="h-5 px-2 text-[10px]">{visible.length} of {summary.total} shown</Pill>
          <Pill tone="neutral" className="h-5 px-2 text-[10px]">{formatBytes(summary.totalBytes)} on disk</Pill>
          {baseModel || query || kind !== 'all' ? (
            <button
              type="button"
              onClick={() => { setQuery(''); setBaseModel(''); setKind('all'); }}
              className="text-[11px] font-medium text-ink3 transition-colors hover:text-ink1"
            >
              Clear filters
            </button>
          ) : null}
        </div>

        {visible.length ? (
          <div className={cx(
            dense
              ? 'flex flex-col gap-1.5'
              : 'grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]',
          )}
          >
            {visible.map((asset) => (dense
              ? <AssetRow key={asset.id} asset={asset} onOpen={onOpenAsset} />
              : <AssetCard key={asset.id} asset={asset} onOpen={onOpenAsset} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon="database"
            title={summary.total ? 'Nothing matches those filters' : 'No models installed yet'}
            hint={summary.total
              ? 'Widen the search, or clear the base-model filter.'
              : 'Download a model from Discover and it lands in the ComfyUI models folder.'}
          />
        )}
      </div>
    </div>
  );
}
