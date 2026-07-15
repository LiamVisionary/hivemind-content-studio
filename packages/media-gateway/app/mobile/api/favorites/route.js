export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PRIVATE_DIR = join(process.env.HOME || '', '.comfy-private.noindex');
const FAVORITES_PATH = join(PRIVATE_DIR, 'mobile_favorites.json');
const LEGACY_WORKFLOW_FAVORITES_PATH = join(PRIVATE_DIR, 'mobile_workflow_favorites.json');

function safeString(value, max = 700) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function uniqueStrings(values, max = 2000) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => safeString(value))
    .filter(Boolean))).slice(0, max);
}

function imageIdFromRecord(record) {
  const image = record?.representativeImage || {};
  const source = safeString(image.source, 40) || 'output';
  const path = safeString(image.path, 500);
  return path ? `${source}/${path}` : '';
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
      workflowFavorites: Array.isArray(parsed.workflowFavorites) ? parsed.workflowFavorites : [],
    };
  }
  const legacy = await readJsonFile(LEGACY_WORKFLOW_FAVORITES_PATH);
  const workflowFavorites = Array.isArray(legacy?.favorites) ? legacy.favorites : [];
  return {
    version: 2,
    imageFavorites: uniqueStrings(workflowFavorites.map(imageIdFromRecord)),
    workflowFavorites,
  };
}

async function writeStore(store) {
  await mkdir(dirname(FAVORITES_PATH), { recursive: true });
  const normalized = {
    version: 2,
    imageFavorites: uniqueStrings(store.imageFavorites),
    workflowFavorites: Array.isArray(store.workflowFavorites) ? store.workflowFavorites.slice(0, 500) : [],
  };
  const tmp = `${FAVORITES_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(normalized, null, 2));
  await rename(tmp, FAVORITES_PATH);

  const legacyTmp = `${LEGACY_WORKFLOW_FAVORITES_PATH}.tmp`;
  await writeFile(legacyTmp, JSON.stringify({ version: 1, favorites: normalized.workflowFavorites }, null, 2));
  await rename(legacyTmp, LEGACY_WORKFLOW_FAVORITES_PATH);
}

function removeImageIdsFromWorkflowRecords(workflowFavorites, removedIds) {
  const removed = new Set(removedIds);
  return workflowFavorites
    .map((record) => {
      const imageIds = uniqueStrings(record.imageIds || [imageIdFromRecord(record)]).filter((id) => !removed.has(id));
      return { ...record, imageIds, favoriteCount: Math.max(1, imageIds.length) };
    })
    .filter((record) => record.imageIds.length > 0);
}

export async function GET() {
  const store = await readStore();
  return Response.json({ favorites: store.imageFavorites });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const ids = uniqueStrings(body?.ids ?? (body?.id ? [body.id] : []));
    const op = body?.op || 'set';
    const store = await readStore();
    if (op === 'add') {
      store.imageFavorites = uniqueStrings([...store.imageFavorites, ...ids]);
    } else if (op === 'remove') {
      const removeSet = new Set(ids);
      store.imageFavorites = store.imageFavorites.filter((id) => !removeSet.has(id));
      store.workflowFavorites = removeImageIdsFromWorkflowRecords(store.workflowFavorites, ids);
    } else if (op === 'set') {
      const nextSet = new Set(ids);
      const removed = store.imageFavorites.filter((id) => !nextSet.has(id));
      store.imageFavorites = ids;
      store.workflowFavorites = removeImageIdsFromWorkflowRecords(store.workflowFavorites, removed);
    } else {
      return Response.json({ ok: false, error: 'Unsupported op' }, { status: 400 });
    }
    await writeStore(store);
    return Response.json({ ok: true, favorites: store.imageFavorites });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : 'Failed to update favorites' }, { status: 400 });
  }
}
