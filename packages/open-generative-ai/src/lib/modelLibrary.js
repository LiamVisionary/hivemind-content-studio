// Model manager data shaping — pure functions, no DOM and no fetching.
//
// Two different things are called "models" in this app and the Models view shows
// both: RUNNABLE models (local workflows the studios can generate with) and
// INSTALLED assets (the weight files on disk: LoRAs, checkpoints, embeddings).
// Everything here is presentation logic for those two lists.

export const ASSET_KINDS = [
  { value: 'all', label: 'All' },
  { value: 'lora', label: 'LoRAs' },
  { value: 'checkpoint', label: 'Checkpoints' },
  { value: 'embedding', label: 'Embeddings' },
  { value: 'other', label: 'Other' },
];

export const ASSET_SORTS = [
  { value: 'name', label: 'Name' },
  { value: 'recent', label: 'Recently added' },
  { value: 'size', label: 'Largest first' },
  { value: 'base', label: 'Base model' },
];

export function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let size = bytes;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export function assetLabel(asset) {
  return String(asset?.displayName || asset?.name || asset?.id || '').trim();
}

// Everything a search box should match: the two names, the creator, the base model,
// the trigger words and the tags. Filenames matter here — a LoRA is often known only
// by the file someone downloaded.
export function assetHaystack(asset) {
  return [
    asset?.displayName,
    asset?.name,
    asset?.id,
    asset?.creator,
    asset?.baseModel,
    asset?.folder,
    ...(asset?.triggerWords || []),
    ...(asset?.tags || []),
  ].filter(Boolean).join(' ').toLowerCase();
}

export function filterAssets(assets, { kind = 'all', query = '', baseModel = '' } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  return (assets || []).filter((asset) => {
    if (kind !== 'all' && asset.kind !== kind) return false;
    if (baseModel && asset.baseModel !== baseModel) return false;
    if (needle && !assetHaystack(asset).includes(needle)) return false;
    return true;
  });
}

export function sortAssets(assets, sort = 'name') {
  const byName = (a, b) => assetLabel(a).localeCompare(assetLabel(b), undefined, { sensitivity: 'base' });
  const sorted = [...(assets || [])];
  if (sort === 'size') sorted.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0) || byName(a, b));
  else if (sort === 'recent') sorted.sort((a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')) || byName(a, b));
  else if (sort === 'base') sorted.sort((a, b) => String(a.baseModel || '').localeCompare(String(b.baseModel || '')) || byName(a, b));
  else sorted.sort(byName);
  return sorted;
}

export function librarySummary(assets) {
  const list = assets || [];
  const byKind = { lora: 0, checkpoint: 0, embedding: 0, other: 0 };
  let totalBytes = 0;
  for (const asset of list) {
    if (byKind[asset.kind] !== undefined) byKind[asset.kind] += 1;
    totalBytes += Number(asset.sizeBytes || 0);
  }
  return { total: list.length, byKind, totalBytes };
}

// Base models present in the library, so the filter never offers an empty option.
export function assetBaseModels(assets) {
  return [...new Set((assets || []).map((asset) => asset.baseModel).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// Civitai page for an installed asset, version-pinned when the sidecar knows it.
export function civitaiAssetUrl(asset) {
  const modelId = String(asset?.civitaiModelId || '').trim();
  if (!modelId) return '';
  const versionId = String(asset?.versionId || '').trim();
  return `https://civitai.com/models/${encodeURIComponent(modelId)}${versionId ? `?modelVersionId=${encodeURIComponent(versionId)}` : ''}`;
}

/* ---------------- runnable models ---------------- */

export function modelTypeLabel(model) {
  return String(model?.type || '').toLowerCase() === 'video' ? 'Video' : 'Image';
}

// The short capability line under a runnable model's name. Only facts the catalog
// actually carries — an absent field means the chip is absent, not "0".
export function modelCapabilityChips(model) {
  if (!model) return [];
  const chips = [];
  const width = Number(model.defaultWidth) || 0;
  const height = Number(model.defaultHeight) || 0;
  if (width && height) chips.push(width === height ? `${width}²` : `${width}×${height}`);
  if (Number(model.defaultSteps) > 0) chips.push(`${Number(model.defaultSteps)} steps`);
  if (model.supportsLoras) chips.push('LoRAs');
  if (model.supportsImage || Number(model.maxReferenceImages) > 0) chips.push('References');
  if (model.promptHelper) chips.push('Prompt helper');
  return chips;
}

export function filterModels(models, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return models || [];
  return (models || []).filter((model) => [
    model.name,
    model.id,
    model.family,
    model.description,
    ...(model.tags || []),
    ...(model.compatibleBaseModels || []),
  ].filter(Boolean).join(' ').toLowerCase().includes(needle));
}

// Featured first, then alphabetical — the same order the studio pickers use.
export function sortModels(models) {
  return [...(models || [])].sort((a, b) => (
    Number(Boolean(b.featured)) - Number(Boolean(a.featured))
    || String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
  ));
}

/* ---------------- Civitai browse ---------------- */

export const CIVITAI_TYPES = ['LORA', 'Checkpoint', 'TextualInversion', 'Controlnet', 'VAE', 'Upscaler'];
export const CIVITAI_SORTS = ['Most Downloaded', 'Highest Rated', 'Most Liked', 'Newest'];
export const CIVITAI_PERIODS = ['AllTime', 'Year', 'Month', 'Week', 'Day'];

export const DEFAULT_CIVITAI_FILTERS = {
  types: 'LORA',
  baseModels: '',
  sort: 'Most Downloaded',
  period: 'Month',
  nsfw: '',
  limit: '40',
};

export function civitaiSearchParams(query, filters) {
  const params = { primaryFileOnly: true };
  const trimmed = String(query || '').trim();
  if (trimmed) params.query = trimmed;
  for (const key of ['types', 'baseModels', 'sort', 'period', 'limit']) {
    if (filters?.[key]) params[key] = filters[key];
  }
  // Empty means "whatever Civitai defaults to" — only an explicit choice is sent.
  if (filters?.nsfw === 'true' || filters?.nsfw === 'false') params.nsfw = filters.nsfw;
  return params;
}

export function isCivitaiResultInstalled(item, installed) {
  const versionIds = installed?.versionIds instanceof Set ? installed.versionIds : new Set(installed?.versionIds || []);
  const fileIds = installed?.fileIds instanceof Set ? installed.fileIds : new Set(installed?.fileIds || []);
  return Boolean(
    (item?.versionId && versionIds.has(String(item.versionId)))
    || (item?.fileId && fileIds.has(String(item.fileId))),
  );
}

export function formatCount(value) {
  const count = Number(value) || 0;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}k`;
  return String(count);
}
