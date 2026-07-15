import type { FileItem, WorkflowFavoriteRecord } from '@/api/client';
import type { Workflow } from '@/api/types';

const MEDIA_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|webm|mov)$/i;
const SEED_KEY_RE = /(^|[_-])(seed|noise_seed|rand_seed|random_seed)([_-]|$)/i;
const INPUT_KEY_RE = /(image|img|mask|video|clip|file|filename)/i;
const SEED_NODE_RE = /(randomnoise|random_noise|noise|ksampler|sampler)/i;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizeForGrouping(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForGrouping(item, parentKey));
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const nodeType = String(source.type || source.class_type || source.title || '');
  const isSeedLikeNode = SEED_NODE_RE.test(nodeType);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (SEED_KEY_RE.test(key)) {
      result[key] = '__SEED_IGNORED__';
    } else if (key === 'widgets_values' && isSeedLikeNode && Array.isArray(child)) {
      let replaced = false;
      result[key] = child.map((item) => {
        if (!replaced && typeof item === 'number') {
          replaced = true;
          return '__SEED_IGNORED__';
        }
        return normalizeForGrouping(item, key);
      });
    } else {
      result[key] = normalizeForGrouping(child, key || parentKey);
    }
  }
  return result;
}

function collectInputRefsFromValue(value: unknown, refs: Set<string>, parentKey = ''): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed && (MEDIA_EXT_RE.test(trimmed) || (INPUT_KEY_RE.test(parentKey) && trimmed.includes('/')))) {
      refs.add(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectInputRefsFromValue(item, refs, parentKey));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectInputRefsFromValue(child, refs, key);
  }
}

function filePath(file?: FileItem): string {
  if (!file) return '';
  return file.id.replace(/^(output|input|temp)\//, '');
}

function fileSource(file?: FileItem): string {
  if (!file) return 'output';
  return file.id.split('/')[0] || 'output';
}

export async function buildWorkflowFavoriteRecord(params: {
  workflow: Workflow;
  prompt?: Record<string, unknown>;
  file?: FileItem;
  src?: string;
  promptId?: string;
  title?: string;
}): Promise<WorkflowFavoriteRecord> {
  const refs = new Set<string>();
  if (params.prompt) collectInputRefsFromValue(params.prompt, refs);
  collectInputRefsFromValue(params.workflow, refs);

  const normalizedPrompt = params.prompt
    ? normalizeForGrouping(params.prompt)
    : normalizeForGrouping(params.workflow);
  const workflowHash = await sha256(stableStringify(normalizedPrompt));
  const inputRefs = Array.from(refs).sort();
  const inputHash = await sha256(stableStringify(inputRefs));
  const groupKey = `${workflowHash.slice(0, 24)}:${inputHash.slice(0, 24)}`;
  const path = filePath(params.file);
  const now = Date.now();

  return {
    groupKey,
    workflowHash,
    inputHash,
    title: params.title || params.file?.name || 'Favorited workflow',
    createdAt: now,
    updatedAt: now,
    favoriteCount: 1,
    inputRefs,
    representativeImage: {
      filename: params.file?.name || '',
      path,
      source: fileSource(params.file),
      promptId: params.promptId,
      src: params.src,
    },
    workflow: params.workflow,
  };
}
