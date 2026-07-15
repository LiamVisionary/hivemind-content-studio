export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const PRIVATE_DIR = join(process.env.HOME || '', '.comfy-private.noindex');
const FAVORITES_PATH = join(PRIVATE_DIR, 'mobile_favorites.json');
const LEGACY_WORKFLOW_FAVORITES_PATH = join(PRIVATE_DIR, 'mobile_workflow_favorites.json');

function emptyStore() {
  return { version: 2, imageFavorites: [], workflowFavorites: [] };
}

function safeString(value, max = 500) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function imageIdFromRecord(record) {
  const image = record?.representativeImage || {};
  const source = safeString(image.source, 40) || 'output';
  const path = safeString(image.path, 500);
  return path ? `${source}/${path}` : '';
}

const SEED_KEY_RE = /(^|[_-])(seed|noise_seed|rand_seed|random_seed)([_-]|$)/i;
const SEED_NODE_RE = /(randomnoise|random_noise|noise|ksampler|sampler)/i;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function normalizeForGrouping(value, parentKey = '') {
  if (Array.isArray(value)) return value.map((item) => normalizeForGrouping(item, parentKey));
  if (!value || typeof value !== 'object') return value;

  const obj = value;
  const nodeType = safeString(obj.type || obj.class_type || obj.title, 120);
  const isSeedLikeNode = SEED_NODE_RE.test(nodeType);
  const result = {};
  for (const [key, child] of Object.entries(obj)) {
    if (SEED_KEY_RE.test(key)) {
      result[key] = '__SEED_IGNORED__';
      continue;
    }
    // ComfyUI editor workflows often store seeds as unnamed widget_values.
    // For known sampler/noise nodes, the first numeric widget is the seed/noise seed.
    if (key === 'widgets_values' && isSeedLikeNode && Array.isArray(child)) {
      let replaced = false;
      result[key] = child.map((item) => {
        if (!replaced && typeof item === 'number') {
          replaced = true;
          return '__SEED_IGNORED__';
        }
        return normalizeForGrouping(item, key);
      });
      continue;
    }
    result[key] = normalizeForGrouping(child, key || parentKey);
  }
  return result;
}

function canonicalizeRecord(record) {
  const workflowHash = sha256(stableStringify(normalizeForGrouping(record.workflow)));
  const inputHash = safeString(record.inputHash, 128);
  return {
    ...record,
    workflowHash,
    groupKey: `${workflowHash.slice(0, 24)}:${inputHash.slice(0, 24)}`,
  };
}

function mergeWorkflowFavorites(records) {
  const byKey = new Map();
  for (const raw of Array.isArray(records) ? records : []) {
    if (!raw || typeof raw !== 'object' || !raw.workflow) continue;
    const record = canonicalizeRecord(raw);
    const existing = byKey.get(record.groupKey);
    if (!existing) {
      byKey.set(record.groupKey, {
        ...record,
        imageIds: uniqueStrings(record.imageIds || [imageIdFromRecord(record)]),
        favoriteCount: Math.max(1, uniqueStrings(record.imageIds || [imageIdFromRecord(record)]).length),
      });
      continue;
    }
    const imageIds = uniqueStrings([...(existing.imageIds || []), ...(record.imageIds || [imageIdFromRecord(record)])]);
    byKey.set(record.groupKey, {
      ...existing,
      updatedAt: Math.max(existing.updatedAt || 0, record.updatedAt || 0),
      createdAt: Math.min(existing.createdAt || record.createdAt || Date.now(), record.createdAt || existing.createdAt || Date.now()),
      favoriteCount: Math.max(1, imageIds.length),
      imageIds,
      // Keep the newest representative image so the card reflects the latest favorite.
      representativeImage: (record.updatedAt || 0) >= (existing.updatedAt || 0) ? record.representativeImage : existing.representativeImage,
      title: (record.updatedAt || 0) >= (existing.updatedAt || 0) ? record.title : existing.title,
    });
  }
  return Array.from(byKey.values());
}

function uniqueStrings(values, max = 2000) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => safeString(value, 700))
    .filter(Boolean))).slice(0, max);
}

async function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function readStore() {
  const parsed = await readJsonFile(FAVORITES_PATH);
  if (parsed && typeof parsed === 'object') {
    return {
      version: 2,
      imageFavorites: uniqueStrings(parsed.imageFavorites),
      workflowFavorites: mergeWorkflowFavorites(parsed.workflowFavorites),
    };
  }

  const legacy = await readJsonFile(LEGACY_WORKFLOW_FAVORITES_PATH);
  const workflowFavorites = mergeWorkflowFavorites(Array.isArray(legacy?.favorites) ? legacy.favorites : []);
  const imageFavorites = uniqueStrings(workflowFavorites.map(imageIdFromRecord));
  return { version: 2, imageFavorites, workflowFavorites };
}

async function writeStore(store) {
  await mkdir(dirname(FAVORITES_PATH), { recursive: true });
  const normalized = {
    version: 2,
    imageFavorites: uniqueStrings(store.imageFavorites),
    workflowFavorites: mergeWorkflowFavorites(Array.isArray(store.workflowFavorites) ? store.workflowFavorites : []).slice(0, 500),
  };
  const tmp = `${FAVORITES_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(normalized, null, 2));
  await rename(tmp, FAVORITES_PATH);

  // Compatibility for older/debug tooling that still reads the workflow-specific file.
  const legacyTmp = `${LEGACY_WORKFLOW_FAVORITES_PATH}.tmp`;
  await writeFile(legacyTmp, JSON.stringify({ version: 1, favorites: normalized.workflowFavorites }, null, 2));
  await rename(legacyTmp, LEGACY_WORKFLOW_FAVORITES_PATH);
}

function sanitizeRecord(input) {
  const now = Date.now();
  const groupKey = safeString(input?.groupKey, 128);
  if (!groupKey) throw new Error('Missing groupKey');
  const workflow = input?.workflow;
  if (!workflow || typeof workflow !== 'object' || !Array.isArray(workflow.nodes)) {
    throw new Error('Missing workflow');
  }
  const representativeImage = input?.representativeImage || {};
  const existingImageIds = Array.isArray(input?.imageIds) ? input.imageIds : [];
  const record = canonicalizeRecord({
    groupKey,
    workflowHash: safeString(input?.workflowHash, 128),
    inputHash: safeString(input?.inputHash, 128),
    title: safeString(input?.title, 160) || 'Favorited workflow',
    createdAt: Number.isFinite(input?.createdAt) ? input.createdAt : now,
    updatedAt: now,
    favoriteCount: Number.isFinite(input?.favoriteCount) ? input.favoriteCount : 1,
    inputRefs: Array.isArray(input?.inputRefs) ? input.inputRefs.slice(0, 24).map((x) => safeString(x, 500)).filter(Boolean) : [],
    representativeImage: {
      filename: safeString(representativeImage.filename, 260),
      path: safeString(representativeImage.path, 500),
      source: safeString(representativeImage.source, 40) || 'output',
      promptId: safeString(representativeImage.promptId, 160),
      src: safeString(representativeImage.src, 1000),
    },
    workflow,
  });
  const imageId = imageIdFromRecord(record);
  return {
    ...record,
    imageIds: uniqueStrings([...existingImageIds, imageId]),
  };
}

export async function GET() {
  const store = await readStore();
  await writeStore(store);
  const favorites = store.workflowFavorites
    .filter((record) => record && store.imageFavorites.some((id) => uniqueStrings(record.imageIds || [imageIdFromRecord(record)]).includes(id)))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return Response.json({ favorites });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const record = sanitizeRecord(body);
    const store = await readStore();
    const existingIndex = store.workflowFavorites.findIndex((item) => item.groupKey === record.groupKey);
    if (existingIndex >= 0) {
      const existing = store.workflowFavorites[existingIndex];
      store.workflowFavorites[existingIndex] = {
        ...existing,
        ...record,
        createdAt: existing.createdAt || record.createdAt,
        favoriteCount: (existing.favoriteCount || 1) + 1,
        imageIds: uniqueStrings([...(existing.imageIds || [imageIdFromRecord(existing)]), ...record.imageIds]),
        updatedAt: Date.now(),
      };
    } else {
      store.workflowFavorites.unshift(record);
    }
    store.imageFavorites = uniqueStrings([...store.imageFavorites, ...record.imageIds]);
    store.workflowFavorites.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    await writeStore(store);
    return Response.json({ ok: true, favorite: store.workflowFavorites.find((item) => item.groupKey === record.groupKey) || record });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : 'Failed to save favorite' }, { status: 400 });
  }
}

export async function DELETE(request) {
  const url = new URL(request.url);
  const groupKey = url.searchParams.get('groupKey');
  if (!groupKey) return Response.json({ ok: false, error: 'Missing groupKey' }, { status: 400 });
  const store = await readStore();
  const removed = store.workflowFavorites.filter((item) => item.groupKey === groupKey);
  const removedImageIds = new Set(removed.flatMap((item) => uniqueStrings(item.imageIds || [imageIdFromRecord(item)])));
  store.workflowFavorites = store.workflowFavorites.filter((item) => item.groupKey !== groupKey);
  store.imageFavorites = store.imageFavorites.filter((id) => !removedImageIds.has(id));
  await writeStore(store);
  return Response.json({ ok: true, removed: removed.length });
}
