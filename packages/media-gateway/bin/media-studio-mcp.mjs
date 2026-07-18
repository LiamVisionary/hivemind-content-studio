#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hostHeaderValidation, localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import express from 'express';
import * as z from 'zod/v4';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
const mediaStateRoot = process.env.HIVEMIND_MEDIA_STATE_DIR || join(homedir(), '.hivemindos/media-studio');
const tokenPath = process.env.MEDIA_STUDIO_TOKEN_FILE || process.env.ZIMG_TOKEN_FILE || join(mediaStateRoot, 'secure/zimg-token');
const backendTokenPath = process.env.MEDIA_STUDIO_BACKEND_TOKEN_FILE || process.env.ZIMG_TOKEN_FILE || join(mediaStateRoot, 'secure/zimg-token');
const backendBase = (
  process.env.MEDIA_STUDIO_MCP_BACKEND_URL
  || process.env.MEDIA_STUDIO_BACKEND_URL
  || process.env.ZIMG_MCP_BACKEND_URL
  || process.env.ZIMG_BACKEND_URL
  || 'http://127.0.0.1:8787'
).replace(/\/+$/, '');
const localStudioBase = (
  process.env.MEDIA_STUDIO_MCP_STUDIO_URL
  || process.env.MEDIA_STUDIO_URL
  || process.env.ZIMG_MCP_STUDIO_URL
  || process.env.ZIMG_STUDIO_URL
  || 'http://127.0.0.1:8788'
).replace(/\/+$/, '');
const studioBase = (
  process.env.MEDIA_STUDIO_MCP_PUBLIC_STUDIO_URL
  || process.env.MEDIA_STUDIO_PUBLIC_URL
  || runtimePublicStudioBase()
  || localStudioBase
).replace(/\/+$/, '');
const comfyDir = process.env.COMFY_DIR || join(homedir(), 'comfy', 'ComfyUI');
const comfyInputDir = process.env.COMFY_INPUT_DIR || join(homedir(), '.comfy-private.noindex', 'input');
const maxInlineImageBytes = Number(process.env.MEDIA_STUDIO_MCP_MAX_INLINE_IMAGE_BYTES || 50 * 1024 * 1024);
const maxInlineVideoBytes = Number(process.env.MEDIA_STUDIO_MCP_MAX_INLINE_VIDEO_BYTES || 18 * 1024 * 1024);
const machinePrivate = process.env.MEDIA_STUDIO_MCP_MACHINE_PRIVATE !== '0';
const ltxErosApiWorkflowPath = process.env.MEDIA_STUDIO_LTX_EROS_API_WORKFLOW || process.env.ZIMG_LTX_EROS_API_WORKFLOW || join(comfyDir, 'workflows', 'civitai', 'ltx23-eros-anchor', 'ltx23-eros-anchor.user-image-api.json');
const ltxErosMobileWorkflowDir = process.env.MEDIA_STUDIO_LTX_EROS_MOBILE_WORKFLOW_DIR || process.env.ZIMG_LTX_EROS_MOBILE_WORKFLOW_DIR || join(comfyDir, 'user', 'default', 'workflows');
const workflowRegistryPath = process.env.MEDIA_STUDIO_WORKFLOW_REGISTRY || join(projectRoot, 'workflow-registry.json');

const toolCatalog = [
  ['media_status', 'Check the Media Studio backend and report MCP facade configuration.'],
  ['media_generation_schema', 'Return supported programmatic generation fields, defaults, and workflow registry shape.'],
  ['media_list_workflows', 'List registered image/video/audio workflows that agents can launch.'],
  ['media_generate_image', 'Queue an image generation job through the existing Media Studio API and optionally wait for completion.'],
  ['media_generate_video', 'Queue a registered video workflow. Defaults to the preferred local video workflow when the user just asks for a video.'],
  ['media_get_job', 'Poll one generation job by id.'],
  ['media_list_history', 'List recent redacted generation history records.'],
  ['media_list_models', 'List installed Comfy/Media Studio models with optional filters.'],
  ['media_list_loras', 'List installed and currently selected LoRAs.'],
  ['media_select_loras', 'Replace the current image-generation LoRA selection.'],
  ['media_equip_model', 'Equip a model in the Studio model manager.'],
  ['media_unequip_model', 'Unequip a model in the Studio model manager.'],
];

const defaultLtxErosPrompt = 'photorealistic close-up selfie video of an adult woman, black bob haircut, warm smile, looking into the camera, soft sunlight stripes across face and shoulders, natural blinking, subtle head movement, lips softly singing along to the audio, realistic skin texture, handheld phone camera, smooth natural motion, high quality, realistic lighting\n\n';

const ltxErosVariants = {
  'fast-q8-v12': {
    title: 'MLXBits 10Eros v1.2 q8 distilled',
    marker: 'Eros/native_mlx_ltx__fast-q8-v12',
    mobileWorkflow: 'LTX 2.3 Eros MLX Fast q8 v1.2 Mobile.json',
    benchmarkSeconds: 193.11,
    defaults: {
      image: 'e39e3b884e724eb8bb19e6176a408f42.png',
      prompt: defaultLtxErosPrompt,
      width: 480,
      height: 832,
      frames: 233,
      frame_rate: 24,
      seed: 42,
    },
  },
  'exact-v1-merged-q8': {
    title: 'Exact-v1 bf16 LoRA merged q8 distilled',
    marker: 'Eros/native_mlx_ltx__exact-v1-merged-q8',
    mobileWorkflow: 'LTX 2.3 Eros MLX Exact v1 Merged q8 Mobile.json',
    benchmarkSeconds: 247.44,
    defaults: {
      image: 'e39e3b884e724eb8bb19e6176a408f42.png',
      prompt: defaultLtxErosPrompt,
      width: 480,
      height: 832,
      frames: 233,
      frame_rate: 24,
      seed: 42,
    },
  },
};

const ltxErosVariantAliases = {
  fast: 'fast-q8-v12',
  q8: 'fast-q8-v12',
  'q8-v12': 'fast-q8-v12',
  'fast-q8': 'fast-q8-v12',
  fast_q8_v12: 'fast-q8-v12',
  exact: 'exact-v1-merged-q8',
  merged: 'exact-v1-merged-q8',
  'exact-v1': 'exact-v1-merged-q8',
  'merged-q8': 'exact-v1-merged-q8',
  exact_v1_merged_q8: 'exact-v1-merged-q8',
};

const builtInVideoWorkflowRegistry = {
  'ltx23-eros-fast': {
    id: 'ltx23-eros-fast',
    media_type: 'video',
    title: 'LTX 2.3 Eros Fast',
    description: 'Image-to-video workflow using the fast MLXBits 10Eros v1.2 q8 distilled route on Apple Silicon, with normal ComfyUI fallback elsewhere.',
    family: 'ltx-2.3',
    builder: 'ltx-eros',
    variant: 'fast-q8-v12',
    default: true,
    requires: { prompt: false, image: false },
    accepts: ['prompt', 'image_path', 'image_base64', 'image_url', 'video_path', 'video_base64', 'video_url', 'video_mode', 'duration_seconds', 'width', 'height', 'frames', 'frame_rate', 'seed'],
  },
  'ltx23-eros-exact': {
    id: 'ltx23-eros-exact',
    media_type: 'video',
    title: 'LTX 2.3 Eros Exact',
    description: 'Image-to-video workflow using the exact-v1 bf16 LoRA merged q8 distilled route on Apple Silicon, with normal ComfyUI fallback elsewhere.',
    family: 'ltx-2.3',
    builder: 'ltx-eros',
    variant: 'exact-v1-merged-q8',
    default: false,
    requires: { prompt: false, image: false },
    accepts: ['prompt', 'image_path', 'image_base64', 'image_url', 'video_path', 'video_base64', 'video_url', 'video_mode', 'duration_seconds', 'width', 'height', 'frames', 'frame_rate', 'seed'],
  },
};

const workflowAliases = {
  default: 'ltx23-eros-fast',
  video: 'ltx23-eros-fast',
  fast: 'ltx23-eros-fast',
  ltx: 'ltx23-eros-fast',
  'ltx-eros': 'ltx23-eros-fast',
  'ltx23-eros': 'ltx23-eros-fast',
  exact: 'ltx23-eros-exact',
  fastregular: 'ltx23-regular-fp8',
  'fast-regular': 'ltx23-regular-fp8',
  'regular-fast': 'ltx23-regular-fp8',
  regular: 'ltx23-regular-fp8',
  ingredients: 'ltx23-ic-ingredients-lora',
  'ic-ingredients': 'ltx23-ic-ingredients-lora',
  'ltx23-ingredients': 'ltx23-ic-ingredients-lora',
  'reference-sheet': 'ltx23-ic-ingredients-lora',
};

function token() {
  if (process.env.MEDIA_STUDIO_TOKEN) return process.env.MEDIA_STUDIO_TOKEN.trim();
  if (process.env.ZIMG_TOKEN) return process.env.ZIMG_TOKEN.trim();
  try {
    return readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return '';
  }
}

function backendToken() {
  if (process.env.MEDIA_STUDIO_BACKEND_TOKEN) return process.env.MEDIA_STUDIO_BACKEND_TOKEN.trim();
  if (process.env.ZIMG_TOKEN) return process.env.ZIMG_TOKEN.trim();
  try {
    return readFileSync(backendTokenPath, 'utf8').trim();
  } catch {
    return '';
  }
}

function generationUsage() {
  return {
    endpoint: '/api/generate',
    pattern: 'async-by-default; call media_get_job or media_list_history to poll',
    privacy: 'The backend stores private prompt labels in history instead of raw prompts.',
    required: {
      prompt: { type: 'string' },
    },
    optional: {
      backend: {
        type: 'string',
        default: 'default Media Studio image route',
        examples: ['mlx-bigloves-klein3-edit', 'mlx-mxfp8-bigloves-klein3-edit'],
      },
      width: { type: 'integer', note: 'Forwarded to the active workflow/runner when supported.' },
      height: { type: 'integer', note: 'Forwarded to the active workflow/runner when supported.' },
      steps: { type: 'integer', note: 'Forwarded to the active workflow/runner when supported.' },
      cfg: { type: 'number', note: 'Alias accepted by some routes.' },
      cfgScale: { type: 'number', note: 'Alias accepted by some routes.' },
      guidance: { type: 'number', note: 'Used by native edit routes and forwarded when supported.' },
      seed: { type: 'integer|string', default: 'random/runner default when omitted, blank, or -1' },
      negative_prompt: { type: 'string', note: 'Used for generation only; not persisted in history.' },
      reference_description: { type: 'string', note: 'For Ingredients IC-LoRA, describe every labeled panel in the supplied reference sheet. The server wraps this with the required Reference Sheet and Target headings.' },
      image_path: { type: 'string', note: 'Absolute path or Comfy input filename for edit backends.' },
      image_base64: { type: 'string', note: 'Inline source image as raw base64 or data:image/...;base64,... data URL. Wins over image_path.' },
      image_url: { type: 'string', note: 'Optional HTTP(S) source image fetched server-side. image_base64 wins when both are supplied.' },
      video_path: { type: 'string', note: 'Source video for LTX shot extension. A video source takes precedence over image inputs.' },
      video_base64: { type: 'string', note: 'Inline source video as raw base64 or data:video/...;base64,... data URL. Wins over video_path.' },
      video_url: { type: 'string', note: 'Optional HTTP(S) source video fetched server-side. video_base64 wins when both are supplied.' },
      video_mode: { type: 'string', enum: ['extend'], default: 'extend' },
      loras: {
        type: 'array',
        note: 'If omitted, the backend uses the currently selected LoRAs.',
        item: { id: 'models/loras/name.safetensors or name.safetensors', strength: 'number' },
      },
    },
    video: {
      tool: 'media_generate_video',
      endpoint: '/comfy/api/prompt',
      default_workflow_id: defaultVideoWorkflowId(),
      workflow_ids: Object.keys(videoWorkflowRegistry()),
      note: 'Agents should call this when the user asks for a video. It picks the default registered workflow unless workflow_id is supplied.',
      defaults: workflowDefaults(defaultVideoWorkflowId()),
    },
  };
}

function defaultVideoWorkflowId() {
  const workflows = videoWorkflowRegistry();
  return Object.values(workflows).find((workflow) => workflow.default)?.id || Object.keys(workflows)[0];
}

function normalizeWorkflowId(value, { mediaType = 'video' } = {}) {
  const raw = String(value || defaultVideoWorkflowId()).trim().toLowerCase().replaceAll('_', '-');
  const workflows = videoWorkflowRegistry();
  const id = workflows[raw] ? raw : workflowAliases[raw];
  const workflow = id ? workflows[id] : null;
  if (!workflow || (mediaType && workflow.media_type !== mediaType)) {
    throw new Error(`unknown ${mediaType || 'media'} workflow_id: ${value || ''}`);
  }
  return workflow.id;
}

function workflowDefaults(workflowId) {
  const workflow = videoWorkflowRegistry()[workflowId];
  if (!workflow) return {};
  if (workflow.builder === 'ltx-eros') {
    return { ...ltxErosVariants[workflow.variant].defaults };
  }
  return { ...(workflow.defaults || {}) };
}

function publicWorkflowDefaults(workflowId) {
  const defaults = workflowDefaults(workflowId);
  const publicKeys = [
    'width', 'height', 'frames', 'frame_rate', 'duration_seconds', 'seed',
    'steps', 'cfg', 'guidance', 'strength',
  ];
  return Object.fromEntries(publicKeys
    .filter((key) => ['string', 'number', 'boolean'].includes(typeof defaults[key]))
    .map((key) => [key, defaults[key]]));
}

function publicWorkflow(workflow) {
  return {
    id: workflow.id,
    media_type: workflow.media_type,
    title: workflow.title,
    description: workflow.description,
    family: workflow.family,
    builder: workflow.builder,
    default: Boolean(workflow.default),
    requires: workflow.requires,
    accepts: workflow.accepts,
    defaults: publicWorkflowDefaults(workflow.id),
    ...(workflow.prompt_contract ? { prompt_contract: workflow.prompt_contract } : {}),
  };
}

function listRegisteredWorkflows({ media_type, query } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return Object.values(videoWorkflowRegistry())
    .filter((workflow) => !media_type || workflow.media_type === media_type)
    .filter((workflow) => {
      if (!q) return true;
      return JSON.stringify(publicWorkflow(workflow)).toLowerCase().includes(q);
    })
    .map(publicWorkflow);
}

function externalWorkflowRegistry() {
  if (!existsSync(workflowRegistryPath)) return {};
  const data = loadJsonFile(workflowRegistryPath, 'Media Studio workflow registry');
  const items = Array.isArray(data) ? data : (Array.isArray(data.workflows) ? data.workflows : Object.values(data.workflows || {}));
  const out = {};
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    if (!id) continue;
    out[id] = {
      media_type: 'video',
      requires: { prompt: false, image: false },
      accepts: ['prompt', 'image_path', 'image_base64', 'image_url', 'width', 'height', 'frames', 'frame_rate', 'seed'],
      ...item,
      id,
    };
  }
  return out;
}

function videoWorkflowRegistry() {
  return { ...builtInVideoWorkflowRegistry, ...externalWorkflowRegistry() };
}

function loadJsonFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function baseFromMcpEndpoint(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    if (parsed.pathname === '/mcp') parsed.pathname = '/';
    else if (parsed.pathname.endsWith('/mcp')) parsed.pathname = parsed.pathname.slice(0, -4) || '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function runtimePublicStudioBase() {
  const runtime = runtimeManifest();
  const entrypoints = runtime?.entrypoints || {};
  for (const value of [
    entrypoints.tailnetStudio,
    entrypoints.tailnet,
    entrypoints.tailnetMcp,
    entrypoints.remote,
  ]) {
    const base = String(value || '').includes('/mcp') ? baseFromMcpEndpoint(value) : String(value || '').replace(/\/+$/, '');
    if (base) return base;
  }
  return '';
}

function resolveWorkflowFile(path) {
  if (!path) return '';
  return isAbsolute(path) ? path : resolve(projectRoot, path);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeLtxErosVariant(value) {
  const raw = String(value || 'fast-q8-v12').trim().toLowerCase().replaceAll('_', '-');
  return ltxErosVariants[raw] ? raw : ltxErosVariantAliases[raw];
}

function ltxErosVariantSpec(value) {
  const id = normalizeLtxErosVariant(value);
  if (!id) throw new Error(`unknown LTX Eros variant: ${value || ''}`);
  return { id, ...ltxErosVariants[id] };
}

function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function positiveFloat(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function safeCopyName(path) {
  const ext = extname(path).toLowerCase() || '.png';
  const stem = basename(path, ext).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'image';
  return `mcp_ltx_${Date.now()}_${stem}${ext}`;
}

function extensionForMime(mime) {
  const normalized = String(mime || '').split(';')[0].trim().toLowerCase();
  return {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
  }[normalized] || '';
}

function detectImageExtension(buffer, mime, sourceName) {
  if (buffer?.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buffer?.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer?.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buffer?.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return '.gif';
  const fromMime = extensionForMime(mime);
  if (fromMime) return fromMime;
  const fromName = extname(String(sourceName || '')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(fromName)) return fromName === '.jpeg' ? '.jpg' : fromName;
  return '';
}

function stageImageBuffer(buffer, { mime = '', sourceName = '' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('inline image is empty');
  if (buffer.length > maxInlineImageBytes) {
    throw new Error(`inline image is too large; max ${Math.round(maxInlineImageBytes / 1024 / 1024)} MB`);
  }
  const ext = detectImageExtension(buffer, mime, sourceName);
  if (!ext) throw new Error(`inline image must be a supported image type; received ${mime || 'unknown type'}`);
  mkdirSync(comfyInputDir, { recursive: true });
  const stagedName = `mcp_inline_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}${ext}`;
  writeFileSync(join(comfyInputDir, stagedName), buffer);
  return stagedName;
}

function extensionForVideoMime(mime) {
  const normalized = String(mime || '').split(';')[0].trim().toLowerCase();
  return {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'video/x-matroska': '.mkv',
    'video/x-msvideo': '.avi',
    'video/x-m4v': '.m4v',
  }[normalized] || '';
}

function detectVideoExtension(buffer, mime, sourceName) {
  if (buffer?.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    return String(mime || '').toLowerCase().includes('quicktime') ? '.mov' : '.mp4';
  }
  if (buffer?.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return String(mime || '').toLowerCase().includes('webm') ? '.webm' : '.mkv';
  }
  if (buffer?.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'AVI ') return '.avi';
  const fromMime = extensionForVideoMime(mime);
  if (fromMime) return fromMime;
  const fromName = extname(String(sourceName || '')).toLowerCase();
  return ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'].includes(fromName) ? fromName : '';
}

function stageVideoBuffer(buffer, { mime = '', sourceName = '' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('inline video is empty');
  if (buffer.length > maxInlineVideoBytes) {
    throw new Error(`inline video is too large; max ${Math.round(maxInlineVideoBytes / 1024 / 1024)} MB (use video_url or video_path for larger clips)`);
  }
  const ext = detectVideoExtension(buffer, mime, sourceName);
  if (!ext) throw new Error(`inline video must be MP4, MOV, WebM, MKV, AVI, or M4V; received ${mime || 'unknown type'}`);
  mkdirSync(comfyInputDir, { recursive: true });
  const stagedName = `mcp_video_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}${ext}`;
  writeFileSync(join(comfyInputDir, stagedName), buffer);
  return stagedName;
}

function decodeBase64Image(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('image_base64 is empty');
  const dataUrl = text.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is);
  const mime = dataUrl ? String(dataUrl[1] || '').trim().toLowerCase() : '';
  if (mime && !mime.startsWith('image/')) throw new Error(`image_base64 data URL must be image/*, got ${mime}`);
  let encoded = (dataUrl ? dataUrl[2] : text).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('image_base64 is not valid base64');
  encoded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  return { buffer: Buffer.from(encoded, 'base64'), mime };
}

function stageBase64Image(value) {
  const decoded = decodeBase64Image(value);
  return stageImageBuffer(decoded.buffer, { mime: decoded.mime });
}

function decodeBase64Video(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('video_base64 is empty');
  const dataUrl = text.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is);
  const mime = dataUrl ? String(dataUrl[1] || '').trim().toLowerCase() : '';
  if (mime && !mime.startsWith('video/')) throw new Error(`video_base64 data URL must be video/*, got ${mime}`);
  let encoded = (dataUrl ? dataUrl[2] : text).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('video_base64 is not valid base64');
  encoded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  return { buffer: Buffer.from(encoded, 'base64'), mime };
}

function stageBase64Video(value) {
  const decoded = decodeBase64Video(value);
  return stageVideoBuffer(decoded.buffer, { mime: decoded.mime });
}

async function stageImageUrl(value) {
  const source = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(source.protocol)) throw new Error('image_url must be http or https');
  const response = await fetch(source, {
    headers: { Accept: 'image/*' },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`image_url fetch failed: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length && length > maxInlineImageBytes) {
    throw new Error(`image_url is too large; max ${Math.round(maxInlineImageBytes / 1024 / 1024)} MB`);
  }
  const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());
  return stageImageBuffer(buffer, { mime, sourceName: basename(source.pathname) });
}

async function stageVideoUrl(value) {
  const source = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(source.protocol)) throw new Error('video_url must be http or https');
  const response = await fetch(source, {
    headers: { Accept: 'video/*,application/octet-stream' },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`video_url fetch failed: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length && length > maxInlineVideoBytes) {
    throw new Error(`video_url is too large; max ${Math.round(maxInlineVideoBytes / 1024 / 1024)} MB (use video_path for larger local clips)`);
  }
  const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());
  return stageVideoBuffer(buffer, { mime, sourceName: basename(source.pathname) });
}

async function stageInlineImageFromArgs(args = {}) {
  const params = args.params && typeof args.params === 'object' ? args.params : {};
  const imageBase64 = args.image_base64 ?? params.image_base64;
  if (imageBase64 !== undefined && imageBase64 !== null && String(imageBase64).trim() !== '') {
    return stageBase64Image(imageBase64);
  }
  const imageUrl = args.image_url ?? params.image_url;
  if (imageUrl !== undefined && imageUrl !== null && String(imageUrl).trim() !== '') {
    return stageImageUrl(imageUrl);
  }
  return null;
}

async function stageInlineVideoFromArgs(args = {}) {
  const params = args.params && typeof args.params === 'object' ? args.params : {};
  const videoBase64 = args.video_base64 ?? params.video_base64;
  if (videoBase64 !== undefined && videoBase64 !== null && String(videoBase64).trim() !== '') {
    return stageBase64Video(videoBase64);
  }
  const videoUrl = args.video_url ?? params.video_url;
  if (videoUrl !== undefined && videoUrl !== null && String(videoUrl).trim() !== '') {
    return stageVideoUrl(videoUrl);
  }
  return null;
}

async function imageSourceFromArgs(args = {}, defaults = {}) {
  const staged = await stageInlineImageFromArgs(args);
  if (staged) return staged;
  return argOrDefault(args, defaults, 'image_path') ?? defaults.image;
}

async function videoSourceFromArgs(args = {}) {
  const staged = await stageInlineVideoFromArgs(args);
  if (staged) return staged;
  return args.video_path ?? args.params?.video_path;
}

async function imageSourceFromPrefixedArgs(args = {}, prefix) {
  const source = {
    image_base64: args[`${prefix}_image_base64`],
    image_url: args[`${prefix}_image_url`],
    image_path: args[`${prefix}_image_path`],
  };
  const staged = await stageInlineImageFromArgs(source);
  return staged || source.image_path;
}

function inputRelativeName(path) {
  const inputRoot = resolve(comfyInputDir);
  const absolute = resolve(path);
  const rel = relative(inputRoot, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

function stageLtxErosImage(imagePathOrName, fallbackName) {
  const value = String(imagePathOrName || fallbackName || '').trim();
  if (!value) throw new Error('image_path is required for LTX Eros video generation');
  if (!isAbsolute(value)) return value;
  const source = resolve(value);
  if (!existsSync(source)) throw new Error(`image_path not found: ${value}`);
  const alreadyInput = inputRelativeName(source);
  if (alreadyInput) return alreadyInput;
  mkdirSync(comfyInputDir, { recursive: true });
  const stagedName = safeCopyName(source);
  copyFileSync(source, join(comfyInputDir, stagedName));
  return stagedName;
}

function stageLtxVideo(videoPathOrName) {
  const value = String(videoPathOrName || '').trim();
  if (!value) return null;
  if (!isAbsolute(value)) return value;
  const source = resolve(value);
  if (!existsSync(source)) throw new Error(`video_path not found: ${value}`);
  const alreadyInput = inputRelativeName(source);
  if (alreadyInput) return alreadyInput;
  const ext = detectVideoExtension(null, '', source);
  if (!ext) throw new Error('video_path must point to MP4, MOV, WebM, MKV, AVI, or M4V video');
  mkdirSync(comfyInputDir, { recursive: true });
  const stem = basename(source, ext).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'video';
  const stagedName = `mcp_video_${Date.now()}_${stem}${ext}`;
  copyFileSync(source, join(comfyInputDir, stagedName));
  return stagedName;
}

function stagedVideoHasAudio(videoName) {
  const value = String(videoName || '').trim();
  if (!value) return true;
  const path = isAbsolute(value) ? resolve(value) : resolve(comfyInputDir, value);
  const result = spawnSync(process.env.FFPROBE || 'ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    path,
  ], { encoding: 'utf8', timeout: 15000 });
  // Preserve the established source-audio path when probing is unavailable.
  // A successful probe with no selected stream is the only mute verdict.
  if (result.error || result.status !== 0) return true;
  return String(result.stdout || '').trim() !== '';
}

function apiPromptNode(prompt, id) {
  const node = prompt?.[String(id)];
  if (!node || typeof node !== 'object') throw new Error(`LTX Eros API workflow is missing node ${id}`);
  node.inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : {};
  return node;
}

function setApiInput(prompt, id, key, value) {
  apiPromptNode(prompt, id).inputs[key] = value;
}

function normalizeSlot(slot) {
  if (!slot) return null;
  if (typeof slot === 'string') {
    const [node, ...rest] = slot.split('.');
    const input = rest.join('.');
    return node && input ? { node, input } : null;
  }
  if (Array.isArray(slot) && slot.length >= 2) return { node: slot[0], input: slot[1] };
  if (typeof slot === 'object' && slot.node && slot.input) return slot;
  return null;
}

function setMappedApiInput(prompt, slot, value) {
  const normalized = normalizeSlot(slot);
  if (!normalized || value === undefined || value === null || value === '') return;
  setApiInput(prompt, normalized.node, normalized.input, value);
}

function argOrDefault(args, defaults, key) {
  if (args[key] !== undefined) return args[key];
  if (args.params && typeof args.params === 'object' && args.params[key] !== undefined) return args.params[key];
  return defaults[key];
}

function normalizedLtxFrameCount(value, fallback = 233) {
  const numeric = Number(value);
  const requested = Number.isFinite(numeric) ? Math.round(numeric) : fallback;
  const clamped = Math.max(9, Math.min(721, requested));
  return Math.max(9, Math.round((clamped - 1) / 8) * 8 + 1);
}

function videoFrameCount(args, settings, defaults = {}) {
  const direct = args.frames ?? args.params?.frames ?? settings.frames ?? defaults.frames;
  if (direct !== undefined && direct !== null && direct !== '') {
    return normalizedLtxFrameCount(direct);
  }
  const duration = Number(args.duration_seconds ?? args.params?.duration_seconds ?? settings.duration_seconds ?? defaults.duration_seconds);
  const frameRate = Number(args.frame_rate ?? args.params?.frame_rate ?? settings.frame_rate ?? settings.frameRate ?? defaults.frame_rate ?? 24);
  if (Number.isFinite(duration) && duration > 0 && Number.isFinite(frameRate) && frameRate > 0) {
    return normalizedLtxFrameCount(Math.round(duration * frameRate) + 1);
  }
  return normalizedLtxFrameCount(defaults.frames ?? 233);
}

function videoAnchorFrame(entry, frames, frameRate) {
  const role = String(entry.role || '').trim().toLowerCase();
  let frame = entry.frame ?? entry.frame_idx;
  if (frame === undefined && entry.time_seconds !== undefined) frame = Number(entry.time_seconds) * frameRate;
  if (frame === undefined && role === 'middle') frame = Math.floor((frames - 1) / 2);
  if (frame === undefined && role === 'end') frame = frames - 1;
  if (frame === undefined) frame = 0;
  const numeric = Number(frame);
  return Math.max(0, Math.min(frames - 1, Math.round(Number.isFinite(numeric) ? numeric : 0)));
}

async function normalizeVideoKeyframes(args, settings, defaults = {}) {
  const frames = videoFrameCount(args, settings, defaults);
  const frameRate = Number(args.frame_rate ?? args.params?.frame_rate ?? settings.frame_rate ?? settings.frameRate ?? defaults.frame_rate ?? 24) || 24;
  const ordered = [];
  if (settings.imageName) {
    ordered.push({ image_path: settings.imageName, frame: 0, strength: 1, role: 'start' });
  }
  for (const role of ['middle', 'end']) {
    const source = await imageSourceFromPrefixedArgs(args, role);
    if (!source) continue;
    ordered.push({
      image_path: stageLtxErosImage(source),
      frame: videoAnchorFrame({ role }, frames, frameRate),
      strength: 1,
      role,
    });
  }
  for (const entry of Array.isArray(args.keyframes) ? args.keyframes : []) {
    if (!entry || typeof entry !== 'object') continue;
    const source = await imageSourceFromArgs(entry, {});
    if (!source) throw new Error('each video keyframe requires image_path, image_base64, or image_url');
    const role = String(entry.role || '').trim().toLowerCase();
    const rawStrength = Number(entry.strength ?? 1);
    ordered.push({
      image_path: stageLtxErosImage(source),
      frame: videoAnchorFrame(entry, frames, frameRate),
      strength: Math.max(0, Math.min(1, Number.isFinite(rawStrength) ? rawStrength : 1)),
      ...(role ? { role } : {}),
    });
  }
  const byFrame = new Map();
  for (const anchor of ordered) byFrame.set(anchor.frame, anchor);
  if (byFrame.size > 20) throw new Error('video generation supports at most 20 unique image anchor frames');
  return [...byFrame.values()].sort((left, right) => left.frame - right.frame);
}

function nextPromptNodeId(promptGraph) {
  let next = Math.max(0, ...Object.keys(promptGraph).map((value) => Number(value)).filter(Number.isFinite)) + 1;
  return () => String(next++);
}

function promptNodesByClass(promptGraph, classType) {
  return Object.entries(promptGraph).filter(([, node]) => node?.class_type === classType);
}

function compileLtxImageAnchors(promptGraph, keyframes) {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return;
  const nextId = nextPromptNodeId(promptGraph);
  const existingLoad = promptNodesByClass(promptGraph, 'LoadImage')[0];
  const imageRefs = [];
  for (const [index, anchor] of keyframes.entries()) {
    let nodeId;
    if (index === 0 && existingLoad) {
      nodeId = existingLoad[0];
      existingLoad[1].inputs = { ...(existingLoad[1].inputs || {}), image: anchor.image_path };
    } else {
      nodeId = nextId();
      promptGraph[nodeId] = { class_type: 'LoadImage', inputs: { image: anchor.image_path } };
    }
    imageRefs.push([nodeId, 0]);
  }

  for (const [, node] of promptNodesByClass(promptGraph, 'LTXVImgToVideoInplaceKJ')) {
    const inputs = node.inputs = { ...(node.inputs || {}) };
    for (const key of Object.keys(inputs)) {
      if (key.startsWith('num_images.')) delete inputs[key];
    }
    inputs.num_images = String(keyframes.length);
    keyframes.forEach((anchor, index) => {
      const slot = index + 1;
      inputs[`num_images.image_${slot}`] = imageRefs[index];
      inputs[`num_images.index_${slot}`] = anchor.frame;
      inputs[`num_images.strength_${slot}`] = anchor.strength;
    });
  }

  const guideEntry = promptNodesByClass(promptGraph, 'LTXVAddGuide')[0];
  if (!guideEntry) return;
  const [guideId, guideNode] = guideEntry;
  const consumers = [];
  for (const [nodeId, node] of Object.entries(promptGraph)) {
    if (nodeId === guideId || !node?.inputs) continue;
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && String(value[0]) === guideId) consumers.push({ node, key, output: value[1] });
    }
  }
  guideNode.inputs = {
    ...(guideNode.inputs || {}),
    image: imageRefs[0],
    frame_idx: keyframes[0].frame,
    strength: keyframes[0].strength,
  };
  let previousId = guideId;
  for (let index = 1; index < keyframes.length; index += 1) {
    const nodeId = nextId();
    const anchor = keyframes[index];
    promptGraph[nodeId] = {
      class_type: 'LTXVAddGuide',
      inputs: {
        ...(guideNode.inputs || {}),
        positive: [previousId, 0],
        negative: [previousId, 1],
        latent: [previousId, 2],
        image: imageRefs[index],
        frame_idx: anchor.frame,
        strength: anchor.strength,
      },
    };
    previousId = nodeId;
  }
  if (previousId !== guideId) {
    for (const consumer of consumers) consumer.node.inputs[consumer.key] = [previousId, consumer.output];
  }
}

function normalizedLtxExtensionFrames(durationSeconds, frameRate) {
  const duration = positiveFloat(durationSeconds, 4, { min: 1 / 24, max: 30 });
  const fps = positiveFloat(frameRate, 24, { min: 1, max: 120 });
  return Math.max(8, Math.min(720, Math.ceil(duration * fps / 8) * 8));
}

function unwrappedExtensionModelRef(promptGraph, modelRef) {
  let current = modelRef;
  const imageConditionedModelClasses = new Set(['LTXLatentAnchorAware']);
  for (let depth = 0; depth < 8 && Array.isArray(current); depth += 1) {
    const node = promptGraph[String(current[0])];
    if (!node || !imageConditionedModelClasses.has(node.class_type)) break;
    current = node.inputs?.model;
  }
  return current;
}

function compileLtxVideoExtension(promptGraph, settings) {
  const conditioning = promptNodesByClass(promptGraph, 'LTXVConditioning')[0];
  const checkpoint = promptNodesByClass(promptGraph, 'CheckpointLoaderSimple')[0];
  const audioVae = promptNodesByClass(promptGraph, 'LTXVAudioVAELoader')[0];
  const guider = promptNodesByClass(promptGraph, 'STGGuiderAdvanced')[0];
  const samplerRuns = promptNodesByClass(promptGraph, 'SamplerCustomAdvanced');
  const samplerRun = samplerRuns[0];
  if (!conditioning || !checkpoint || !audioVae || !guider || !samplerRun) {
    throw new Error('selected LTX workflow does not expose the video VAE, audio VAE, conditioning, guider, and sampler nodes required for joint audio-video extension');
  }
  const guiderInputs = cloneJson(guider[1].inputs || {});
  const samplerInputs = samplerRun[1].inputs || {};
  const modelRef = unwrappedExtensionModelRef(promptGraph, guiderInputs.model);
  const refinementSamplerRun = samplerRuns.find(([, node]) => {
    const guiderRef = node?.inputs?.guider;
    return Array.isArray(guiderRef) && promptGraph[String(guiderRef[0])]?.class_type === 'CFGGuider';
  }) || samplerRun;
  const refinementSamplerInputs = refinementSamplerRun[1].inputs || {};
  const refinementGuiderRef = refinementSamplerInputs.guider;
  const refinementGuider = Array.isArray(refinementGuiderRef)
    ? promptGraph[String(refinementGuiderRef[0])]
    : null;
  const refinementGuiderClass = refinementGuider?.class_type || 'STGGuiderAdvanced';
  const refinementGuiderInputs = cloneJson(refinementGuider?.inputs || guiderInputs);
  const refinementModelRef = unwrappedExtensionModelRef(
    promptGraph,
    refinementGuiderInputs.model || modelRef,
  );
  if (!Array.isArray(modelRef) || !Array.isArray(samplerInputs.sampler) || !Array.isArray(samplerInputs.sigmas) || !Array.isArray(samplerInputs.noise)) {
    throw new Error('selected LTX workflow has incomplete sampler wiring for video extension');
  }
  if (!Array.isArray(refinementModelRef) || !Array.isArray(refinementSamplerInputs.sampler) || !Array.isArray(refinementSamplerInputs.sigmas) || !Array.isArray(refinementSamplerInputs.noise)) {
    throw new Error('selected LTX workflow has incomplete refinement sampler wiring for audio extension');
  }
  for (const [nodeId, node] of Object.entries(promptGraph)) {
    if (['VHS_VideoCombine', 'SaveVideo'].includes(node?.class_type)) delete promptGraph[nodeId];
  }
  const nextId = nextPromptNodeId(promptGraph);
  const loadId = nextId();
  const sourceVideoEncodeId = nextId();
  const videoGuiderId = nextId();
  const videoExtendId = nextId();
  const sourceDurationId = nextId();
  const totalDurationId = nextId();
  const sourceSilenceId = nextId();
  const sourceAudioId = nextId();
  const sourceAudioEncodeId = nextId();
  const extensionAudioId = nextId();
  const combinedAudioId = nextId();
  const baseVideoMaskId = nextId();
  const maskedVideoId = nextId();
  const avLatentId = nextId();
  const avMaskId = nextId();
  const audioGuiderId = nextId();
  const audioSampleId = nextId();
  const separateId = nextId();
  const decodeVideoId = nextId();
  const decodeAudioId = nextId();
  const saveId = nextId();
  promptGraph[loadId] = {
    class_type: 'VHS_LoadVideo',
    inputs: {
      video: settings.videoName,
      force_rate: settings.frameRate,
      custom_width: 0,
      custom_height: 0,
      frame_load_cap: 721,
      skip_first_frames: 0,
      select_every_nth: 1,
      format: 'LTXV',
    },
  };
  promptGraph[sourceVideoEncodeId] = {
    class_type: 'VAEEncode',
    inputs: { pixels: [loadId, 0], vae: [checkpoint[0], 2] },
  };
  promptGraph[videoGuiderId] = {
    class_type: 'STGGuiderAdvanced',
    inputs: {
      ...guiderInputs,
      model: modelRef,
      positive: [conditioning[0], 0],
      negative: [conditioning[0], 1],
    },
  };
  promptGraph[videoExtendId] = {
    class_type: 'LTXVExtendSampler',
    inputs: {
      model: modelRef,
      vae: [checkpoint[0], 2],
      latents: [sourceVideoEncodeId, 0],
      num_new_frames: settings.extensionFrames,
      frame_overlap: 16,
      guider: [videoGuiderId, 0],
      sampler: samplerInputs.sampler,
      sigmas: samplerInputs.sigmas,
      noise: samplerInputs.noise,
      strength: 1,
    },
  };
  promptGraph[sourceDurationId] = {
    class_type: 'ComfyMathExpression',
    inputs: {
      'values.a': [loadId, 1],
      expression: `a / ${settings.frameRate}`,
    },
  };
  promptGraph[totalDurationId] = {
    class_type: 'ComfyMathExpression',
    inputs: {
      'values.a': [loadId, 1],
      expression: `(a + ${settings.extensionFrames}) / ${settings.frameRate}`,
    },
  };
  promptGraph[sourceSilenceId] = {
    class_type: 'EmptyAudio',
    inputs: {
      duration: [sourceDurationId, 0],
      sample_rate: 48000,
      channels: 2,
    },
  };
  promptGraph[sourceAudioId] = {
    class_type: 'AudioMerge',
    inputs: {
      audio1: [sourceSilenceId, 0],
      audio2: [loadId, 2],
      merge_method: 'add',
    },
  };
  promptGraph[sourceAudioEncodeId] = {
    class_type: 'LTXVAudioVAEEncode',
    inputs: {
      audio: [sourceAudioId, 0],
      audio_vae: [audioVae[0], 0],
    },
  };
  promptGraph[extensionAudioId] = {
    class_type: 'LTXVEmptyLatentAudio',
    inputs: {
      frames_number: settings.extensionFrames,
      frame_rate: Math.round(settings.frameRate),
      batch_size: 1,
      audio_vae: [audioVae[0], 0],
    },
  };
  promptGraph[combinedAudioId] = {
    class_type: 'LTXVAddLatents',
    inputs: {
      latents1: [sourceAudioEncodeId, 0],
      latents2: [extensionAudioId, 0],
    },
  };
  promptGraph[baseVideoMaskId] = {
    class_type: 'SolidMask',
    inputs: { value: 0, width: 64, height: 64 },
  };
  promptGraph[maskedVideoId] = {
    class_type: 'LTXVSetVideoLatentNoiseMasks',
    inputs: {
      samples: [videoExtendId, 0],
      masks: [baseVideoMaskId, 0],
    },
  };
  promptGraph[avLatentId] = {
    class_type: 'LTXVConcatAVLatent',
    inputs: {
      video_latent: [maskedVideoId, 0],
      audio_latent: [combinedAudioId, 0],
    },
  };
  promptGraph[avMaskId] = {
    class_type: 'LTXVSetAudioVideoMaskByTime',
    inputs: {
      av_latent: [avLatentId, 0],
      positive: [conditioning[0], 0],
      negative: [conditioning[0], 1],
      model: modelRef,
      vae: [checkpoint[0], 2],
      audio_vae: [audioVae[0], 0],
      start_time: settings.sourceHasAudio ? [sourceDurationId, 0] : 0,
      end_time: [totalDurationId, 0],
      video_fps: settings.frameRate,
      mask_video: false,
      mask_audio: true,
      mask_init_value_video: 0,
      mask_init_value_audio: 0,
      slope_len: 3,
    },
  };
  promptGraph[audioGuiderId] = {
    class_type: refinementGuiderClass,
    inputs: {
      ...refinementGuiderInputs,
      model: refinementModelRef,
      positive: [avMaskId, 0],
      negative: [avMaskId, 1],
    },
  };
  promptGraph[audioSampleId] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      guider: [audioGuiderId, 0],
      sampler: refinementSamplerInputs.sampler,
      sigmas: refinementSamplerInputs.sigmas,
      noise: refinementSamplerInputs.noise,
      latent_image: [avMaskId, 2],
    },
  };
  promptGraph[separateId] = {
    class_type: 'LTXVSeparateAVLatent',
    inputs: { av_latent: [audioSampleId, 1] },
  };
  promptGraph[decodeVideoId] = {
    class_type: 'VAEDecode',
    inputs: { samples: [videoExtendId, 0], vae: [checkpoint[0], 2] },
  };
  promptGraph[decodeAudioId] = {
    class_type: 'LTXVAudioVAEDecode',
    inputs: { samples: [separateId, 1], audio_vae: [audioVae[0], 0] },
  };
  promptGraph[saveId] = {
    class_type: 'VHS_VideoCombine',
    inputs: {
      images: [decodeVideoId, 0],
      audio: [decodeAudioId, 0],
      frame_rate: settings.frameRate,
      loop_count: 0,
      filename_prefix: `LTX23/extend_av_${Date.now()}`,
      format: 'video/h264-mp4',
      pix_fmt: 'yuv420p',
      crf: 10,
      save_metadata: false,
      trim_to_audio: false,
      pingpong: false,
      save_output: true,
    },
  };
}

function editorNode(workflow, id) {
  return (workflow?.nodes || []).find((node) => String(node?.id) === String(id));
}

function setEditorWidget(workflow, id, keyOrIndex, value) {
  const node = editorNode(workflow, id);
  if (!node) return;
  if (Array.isArray(node.widgets_values)) {
    const index = typeof keyOrIndex === 'number' ? keyOrIndex : 0;
    node.widgets_values[index] = value;
    return;
  }
  if (node.widgets_values && typeof node.widgets_values === 'object') {
    node.widgets_values[keyOrIndex] = value;
  }
}

function updateLtxErosEditorWorkflow(workflow, spec, settings) {
  const out = cloneJson(workflow);
  out.title = spec.title;
  out.extra = out.extra && typeof out.extra === 'object' ? out.extra : {};
  out.extra.name = spec.title;
  out.extra.workflow_name = spec.mobileWorkflow;
  out.extra.title = spec.title;
  out.extra.nativeMlxLtx = {
    ...(out.extra.nativeMlxLtx && typeof out.extra.nativeMlxLtx === 'object' ? out.extra.nativeMlxLtx : {}),
    enabled: true,
    variant: spec.id,
    benchmarkSeconds: spec.benchmarkSeconds,
    defaults: {
      ...(out.extra.nativeMlxLtx?.defaults && typeof out.extra.nativeMlxLtx.defaults === 'object' ? out.extra.nativeMlxLtx.defaults : {}),
      ...(settings.imageName ? { image: settings.imageName } : {}),
      prompt: settings.prompt,
      width: settings.width,
      height: settings.height,
      frames: settings.frames,
      frame_rate: settings.frameRate,
      seed: settings.seed,
    },
    keyframes: Array.isArray(settings.keyframes) ? settings.keyframes : [],
    ...(settings.videoName ? { video: {
      mode: 'extend',
      path: settings.videoName,
      ...(!settings.sourceHasAudio ? { source_has_audio: false } : {}),
      duration_seconds: settings.durationSeconds,
      frame_rate: settings.frameRate,
      steps: 30,
      cfg_scale: 3,
      stg_scale: 1,
    } } : {}),
    fallback: 'ComfyUI LTX graph on non-Apple-Silicon or when the native MLX LTX route is disabled',
  };
  setEditorWidget(out, 597, 'filename_prefix', spec.marker);
  setEditorWidget(out, 597, 'frame_rate', settings.frameRate);
  if (settings.imageName) setEditorWidget(out, 773, 0, settings.imageName);
  setEditorWidget(out, 824, 0, settings.prompt);
  setEditorWidget(out, 809, 0, settings.width);
  setEditorWidget(out, 811, 0, settings.height);
  setEditorWidget(out, 542, 0, settings.frameRate);
  setEditorWidget(out, 812, 0, settings.seed);
  return out;
}

async function buildLtxErosPromptBody(args = {}, workflow) {
  const spec = ltxErosVariantSpec(workflow?.variant || args.variant);
  const defaults = spec.defaults;
  const prompt = String(args.prompt ?? defaults.prompt).trim();
  if (!prompt) throw new Error('prompt is required for LTX Eros video generation');
  const rawVideo = await videoSourceFromArgs(args);
  const videoName = rawVideo ? stageLtxVideo(rawVideo) : null;
  const sourceHasAudio = videoName ? stagedVideoHasAudio(videoName) : null;
  const imageName = videoName ? null : stageLtxErosImage(await imageSourceFromArgs(args, defaults), defaults.image);
  const frameRate = positiveFloat(args.frame_rate ?? args.params?.frame_rate, defaults.frame_rate, { min: 1, max: 120 });
  const durationSeconds = positiveFloat(args.duration_seconds ?? args.params?.duration_seconds, defaults.duration_seconds || 4, { min: 1 / 24, max: 30 });
  const settings = {
    prompt: prompt.endsWith('\n') ? prompt : `${prompt}\n\n`,
    imageName,
    videoName,
    videoMode: videoName ? 'extend' : null,
    sourceHasAudio,
    audioMode: videoName ? (sourceHasAudio ? 'extend' : 'generate') : null,
    durationSeconds,
    width: positiveInt(args.width, defaults.width, { min: 64, max: 4096 }),
    height: positiveInt(args.height, defaults.height, { min: 64, max: 4096 }),
    frames: positiveInt(args.frames, defaults.frames, { min: 9, max: 721 }),
    frameRate,
    extensionFrames: normalizedLtxExtensionFrames(durationSeconds, frameRate),
    seed: positiveInt(args.seed, defaults.seed, { min: 0, max: 1_000_000_000 }),
  };
  settings.keyframes = videoName ? [] : await normalizeVideoKeyframes(args, settings, defaults);
  const apiWorkflow = loadJsonFile(ltxErosApiWorkflowPath, 'LTX Eros API workflow');
  const promptGraph = cloneJson(apiWorkflow.prompt || apiWorkflow);
  setApiInput(promptGraph, 597, 'filename_prefix', spec.marker);
  setApiInput(promptGraph, 597, 'frame_rate', ['826', 0]);
  if (settings.imageName) setApiInput(promptGraph, 773, 'image', settings.imageName);
  setApiInput(promptGraph, 824, 'value', settings.prompt);
  setApiInput(promptGraph, 809, 'value', settings.width);
  setApiInput(promptGraph, 811, 'value', settings.height);
  setApiInput(promptGraph, 542, 'value', settings.frameRate);
  setApiInput(promptGraph, 812, 'noise_seed', settings.seed);
  if (videoName) compileLtxVideoExtension(promptGraph, settings);
  else compileLtxImageAnchors(promptGraph, settings.keyframes);

  const mobileWorkflowPath = join(ltxErosMobileWorkflowDir, spec.mobileWorkflow);
  const mobileWorkflow = updateLtxErosEditorWorkflow(
    loadJsonFile(mobileWorkflowPath, 'LTX Eros Mobile workflow'),
    spec,
    settings,
  );
  return {
    spec,
    workflow: publicWorkflow(workflow || videoWorkflowRegistry()[defaultVideoWorkflowId()]),
    settings,
    body: {
      prompt: promptGraph,
      client_id: `media-studio-mcp-${randomUUID()}`,
      extra_data: {
        extra_pnginfo: {
          workflow: mobileWorkflow,
        },
      },
    },
  };
}

async function buildVideoPromptBody(args = {}) {
  const workflowId = normalizeWorkflowId(args.workflow_id || args.workflow, { mediaType: 'video' });
  const workflow = videoWorkflowRegistry()[workflowId];
  if (workflow.builder === 'ltx-eros') {
    return buildLtxErosPromptBody(args, workflow);
  }
  if (workflow.builder === 'comfy-api') {
    return buildComfyApiPromptBody(args, workflow);
  }
  throw new Error(`unsupported video workflow builder: ${workflow.builder}`);
}

function contractedVideoPrompt(args, defaults, workflow) {
  const rawPrompt = argOrDefault(args, defaults, 'prompt');
  const contract = workflow.prompt_contract && typeof workflow.prompt_contract === 'object'
    ? workflow.prompt_contract
    : null;
  if (!contract || contract.type !== 'ltx23-ingredients') return rawPrompt;
  if (rawPrompt === undefined || rawPrompt === null || String(rawPrompt).trim() === '') {
    throw new Error(`workflow ${workflow.id} requires prompt`);
  }
  const prompt = String(rawPrompt).trim();
  const referenceHeading = String(contract.reference_heading || '### Reference Sheet Description');
  const targetHeading = String(contract.target_heading || '### Target Description');
  if (prompt.includes(referenceHeading) && prompt.includes(targetHeading)) return prompt;
  const parameter = String(contract.reference_description_param || 'reference_description');
  const referenceDescription = argOrDefault(args, defaults, parameter);
  if (referenceDescription === undefined || referenceDescription === null || String(referenceDescription).trim() === '') {
    throw new Error(
      `workflow ${workflow.id} requires ${parameter}, unless prompt already contains both ${referenceHeading} and ${targetHeading}`,
    );
  }
  return `${referenceHeading}\n${String(referenceDescription).trim()}\n${targetHeading}\n${prompt}`;
}

async function buildComfyApiPromptBody(args = {}, workflow) {
  const apiWorkflowPath = resolveWorkflowFile(workflow.api_workflow || workflow.workflow || workflow.apiWorkflow);
  const apiWorkflow = loadJsonFile(apiWorkflowPath, `${workflow.id} API workflow`);
  const promptGraph = cloneJson(apiWorkflow.prompt || apiWorkflow);
  const defaults = workflowDefaults(workflow.id);
  const slots = workflow.slots || {};
  const settings = {};

  const promptText = contractedVideoPrompt(args, defaults, workflow);
  if (promptText !== undefined) {
    settings.prompt = String(promptText);
    setMappedApiInput(promptGraph, slots.prompt, settings.prompt);
  }
  const negativePrompt = argOrDefault(args, defaults, 'negative_prompt');
  if (negativePrompt !== undefined) setMappedApiInput(promptGraph, slots.negative_prompt, String(negativePrompt));

  const rawVideo = await videoSourceFromArgs(args);
  if (rawVideo && !(workflow.accepts || []).some((field) => String(field).startsWith('video_'))) {
    throw new Error(`workflow ${workflow.id} does not declare video input support`);
  }
  if (rawVideo) {
    settings.videoName = stageLtxVideo(rawVideo);
    settings.videoMode = String(args.video_mode ?? args.params?.video_mode ?? 'extend').trim().toLowerCase();
    if (settings.videoMode !== 'extend') throw new Error('video_mode must be extend');
    settings.sourceHasAudio = stagedVideoHasAudio(settings.videoName);
    settings.audioMode = settings.sourceHasAudio ? 'extend' : 'generate';
  }

  const rawImage = settings.videoName ? undefined : await imageSourceFromArgs(args, defaults);
  if (!settings.videoName && rawImage !== undefined && slots.image_path) {
    settings.imageName = stageLtxErosImage(rawImage, defaults.image);
    setMappedApiInput(promptGraph, slots.image_path, settings.imageName);
  }
  if (workflow.requires?.image && !settings.imageName && !settings.videoName) {
    throw new Error(`workflow ${workflow.id} requires image_path, image_base64, or image_url`);
  }
  if (workflow.requires?.prompt && !settings.prompt) {
    throw new Error(`workflow ${workflow.id} requires prompt`);
  }

  for (const [key, slot] of Object.entries({
    width: slots.width,
    height: slots.height,
    frames: slots.frames,
    frame_rate: slots.frame_rate,
    seed: slots.seed,
    duration_seconds: slots.duration_seconds,
    steps: slots.steps,
    cfg: slots.cfg,
    guidance: slots.guidance,
  })) {
    const value = argOrDefault(args, defaults, key);
    if (value !== undefined) {
      settings[key] = value;
      setMappedApiInput(promptGraph, slot, value);
    }
  }
  settings.frameRate = Number(settings.frame_rate ?? defaults.frame_rate ?? 24) || 24;
  settings.durationSeconds = positiveFloat(
    args.duration_seconds ?? args.params?.duration_seconds ?? settings.duration_seconds,
    defaults.duration_seconds || 4,
    { min: 1 / 24, max: 30 },
  );
  const explicitFrames = args.frames ?? args.params?.frames;
  const explicitDuration = args.duration_seconds ?? args.params?.duration_seconds;
  if (slots.frames && explicitFrames === undefined && explicitDuration !== undefined) {
    settings.frames = normalizedLtxFrameCount(Math.round(settings.durationSeconds * settings.frameRate) + 1);
    setMappedApiInput(promptGraph, slots.frames, settings.frames);
  }
  settings.extensionFrames = normalizedLtxExtensionFrames(settings.durationSeconds, settings.frameRate);
  settings.keyframes = settings.videoName ? [] : await normalizeVideoKeyframes(args, settings, defaults);
  if (settings.videoName) compileLtxVideoExtension(promptGraph, settings);
  else compileLtxImageAnchors(promptGraph, settings.keyframes);

  const extraPngInfo = {};
  const mobileWorkflowPath = resolveWorkflowFile(workflow.mobile_workflow || workflow.editor_workflow || workflow.mobileWorkflow);
  if (mobileWorkflowPath && existsSync(mobileWorkflowPath)) {
    const editorWorkflow = loadJsonFile(mobileWorkflowPath, `${workflow.id} editor workflow`);
    editorWorkflow.extra = editorWorkflow.extra && typeof editorWorkflow.extra === 'object' ? editorWorkflow.extra : {};
    const existingNative = editorWorkflow.extra.nativeMlxLtx && typeof editorWorkflow.extra.nativeMlxLtx === 'object'
      ? editorWorkflow.extra.nativeMlxLtx
      : {};
    const nativeSpec = workflow.native_mlx && typeof workflow.native_mlx === 'object' ? workflow.native_mlx : {};
    editorWorkflow.extra.nativeMlxLtx = {
      ...existingNative,
      enabled: nativeSpec.enabled !== false,
      variant: nativeSpec.variant || existingNative.variant,
      ...(nativeSpec.pipeline || existingNative.pipeline ? { pipeline: nativeSpec.pipeline || existingNative.pipeline } : {}),
      defaults: {
        ...(existingNative.defaults && typeof existingNative.defaults === 'object' ? existingNative.defaults : {}),
        ...(settings.imageName ? { image: settings.imageName } : {}),
        ...(settings.prompt !== undefined ? { prompt: settings.prompt } : {}),
        ...(settings.width !== undefined ? { width: settings.width } : {}),
        ...(settings.height !== undefined ? { height: settings.height } : {}),
        frames: videoFrameCount(args, settings, defaults),
        frame_rate: Number(settings.frame_rate ?? defaults.frame_rate ?? 24),
        ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
      },
      keyframes: settings.keyframes,
      ...(settings.videoName ? { video: {
        mode: 'extend',
        path: settings.videoName,
        ...(!settings.sourceHasAudio ? { source_has_audio: false } : {}),
        duration_seconds: settings.durationSeconds,
        frame_rate: settings.frameRate,
        steps: 30,
        cfg_scale: 3,
        stg_scale: 1,
      } } : {}),
      ...(Array.isArray(nativeSpec.loras) ? { loras: nativeSpec.loras } : {}),
      ...(nativeSpec.ic_lora || existingNative.icLora ? { icLora: {
        ...(existingNative.icLora && typeof existingNative.icLora === 'object' ? existingNative.icLora : {}),
        ...(nativeSpec.ic_lora && typeof nativeSpec.ic_lora === 'object' ? nativeSpec.ic_lora : {}),
        ...(settings.imageName ? { reference_image: settings.imageName } : {}),
      } } : {}),
    };
    extraPngInfo.workflow = editorWorkflow;
    extraPngInfo.nativeMlxLtx = editorWorkflow.extra.nativeMlxLtx;
  }

  return {
    spec: {
      id: workflow.id,
      title: workflow.title,
      benchmarkSeconds: workflow.benchmark_seconds,
      native: false,
      apiWorkflowPath,
      mobileWorkflowPath: mobileWorkflowPath || undefined,
    },
    workflow: publicWorkflow(workflow),
    settings,
    body: {
      prompt: promptGraph,
      client_id: `media-studio-mcp-${randomUUID()}`,
      ...(Object.keys(extraPngInfo).length ? { extra_data: { extra_pnginfo: extraPngInfo } } : {}),
    },
  };
}

function runtimeManifest() {
  const path = join(projectRoot, 'studio.runtime.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function redactTokenFromUrl(value) {
  if (!value || typeof value !== 'string') return value;
  try {
    const relative = value.startsWith('/');
    const parsed = new URL(value, localStudioBase);
    parsed.searchParams.delete('token');
    return relative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
  } catch {
    return value.replace(/([?&])token=[^&#]+/i, '$1token=[redacted]');
  }
}

function sameOrigin(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.protocol === b.protocol && a.host === b.host;
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function absolutize(value) {
  if (!value || typeof value !== 'string') return value;
  try {
    const wasRelative = value.startsWith('/');
    const parsed = new URL(value, localStudioBase);
    const publicBase = new URL(studioBase);
    if (
      wasRelative
      || isLoopbackHost(parsed.hostname)
      || sameOrigin(parsed.toString(), localStudioBase)
      || sameOrigin(parsed.toString(), backendBase)
    ) {
      parsed.protocol = publicBase.protocol;
      parsed.username = '';
      parsed.password = '';
      parsed.host = publicBase.host;
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function normalizeRecord(record, { includeUrls = false } = {}) {
  const out = JSON.parse(JSON.stringify(record || {}));
  if (Array.isArray(out.image_urls)) {
    out.image_urls = includeUrls ? out.image_urls : out.image_urls.map(redactTokenFromUrl);
    if (includeUrls) {
      out.studio_image_urls = out.image_urls.map(absolutize);
      out.media_urls = out.studio_image_urls;
    }
  }
  if (out.job_url) out.job_url = redactTokenFromUrl(out.job_url);
  if (out.page_url) {
    out.page_url = redactTokenFromUrl(out.page_url);
    if (includeUrls) out.studio_page_url = absolutize(out.page_url);
  }
  if (out.history_url) out.history_url = redactTokenFromUrl(out.history_url);
  return out;
}

async function requestJson(path, { method = 'GET', body, query, timeoutMs = 60000 } = {}) {
  const url = new URL(path, backendBase);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const headers = { Accept: 'application/json' };
  const authToken = backendToken();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const init = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  if (!response.ok) {
    const message = data?.error || data?.message || text || `HTTP ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.response = data;
    throw err;
  }
  return data;
}

function ok(data) {
  const structuredContent = data && typeof data === 'object' && !Array.isArray(data)
    ? { ok: true, ...data }
    : { ok: true, result: data };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function fail(error) {
  const structuredContent = {
    ok: false,
    error: String(error?.message || error),
    status: error?.status,
    response: error?.response,
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function machineOperationReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: true,
      privacy: 'machine-redacted',
      prompts_redacted: true,
      media_redacted: true,
    };
  }
  const receipt = {};
  const allowed = [
    'id', 'job_id', 'jobId', 'prompt_id', 'comfy_prompt_id', 'status', 'state',
    'ok', 'backend', 'provider', 'model', 'workflow_id', 'audio_mode', 'wait_timed_out',
    'elapsed_seconds', 'duration_ms', 'count', 'created_at', 'updated_at',
  ];
  for (const key of allowed) {
    const item = value[key];
    if (['string', 'number', 'boolean'].includes(typeof item) || item === null) receipt[key] = item;
  }
  for (const key of ['job', 'submission', 'workflow', 'receipt', 'result']) {
    if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) {
      receipt[key] = machineOperationReceipt(value[key]);
    }
  }
  receipt.ok = value.ok !== false;
  receipt.privacy = 'machine-redacted';
  receipt.prompts_redacted = true;
  receipt.media_redacted = true;
  return receipt;
}

function machineFailureReceipt(error) {
  return {
    ok: false,
    privacy: 'machine-redacted',
    status: error?.status,
    error_type: 'MediaStudioError',
    prompts_redacted: true,
    media_redacted: true,
  };
}

function authorizedHttpRequest(req) {
  const expectedTokens = [...new Set([token(), backendToken()].filter(Boolean))];
  if (!expectedTokens.length) return false;
  const auth = String(req.headers.authorization || '');
  if (expectedTokens.some((expected) => auth === `Bearer ${expected}`)) return true;
  if (expectedTokens.includes(String(req.headers['x-token'] || ''))) return true;
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (expectedTokens.includes(String(url.searchParams.get('token') || ''))) return true;
  } catch {}
  return false;
}

function createMediaStudioMcpExpressApp({ host }) {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  const localhostHosts = ['127.0.0.1', 'localhost', '::1'];
  if (localhostHosts.includes(host)) {
    app.use(localhostHostValidation());
  } else if (host && host !== '0.0.0.0' && host !== '::') {
    app.use(hostHeaderValidation([host]));
  } else {
    console.warn(`Warning: Server is binding to ${host} without DNS rebinding protection. Use token authentication and a trusted proxy.`);
  }
  return app;
}

function tool(handler, { privateReceipt = false } = {}) {
  return async (args) => {
    try {
      const result = await handler(args || {});
      return ok(machinePrivate && privateReceipt ? machineOperationReceipt(result) : result);
    } catch (error) {
      if (machinePrivate && privateReceipt) return fail(machineFailureReceipt(error));
      return fail(error);
    }
  };
}

async function waitForJob(jobId, { timeoutS = 900, pollMs = 1200, includeUrls = false } = {}) {
  const started = Date.now();
  while (true) {
    const job = normalizeRecord(await requestJson(`/api/job/${encodeURIComponent(jobId)}`), { includeUrls });
    if (!['queued', 'running'].includes(job.status)) return job;
    if (Date.now() - started > timeoutS * 1000) return { ...job, wait_timed_out: true };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function getWrapperJobIfPresent(jobId, { includeUrls = false } = {}) {
  try {
    return normalizeRecord(await requestJson(`/api/job/${encodeURIComponent(jobId)}`), { includeUrls });
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

async function getComfyHistoryIfPresent(promptId) {
  try {
    const data = await requestJson(`/comfy/api/history/${encodeURIComponent(promptId)}`, { timeoutMs: 30000 });
    return data?.[promptId] || Object.values(data || {})[0] || null;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

function comfyHistoryToJob(promptId, history, { includeUrls = false } = {}) {
  if (!history) return null;
  const status = history?.status || {};
  const completed = Boolean(status.completed);
  const statusText = String(status.status_str || (completed ? 'success' : 'running')).toLowerCase();
  const outputs = [];
  for (const nodeOut of Object.values(history.outputs || {})) {
    for (const values of Object.values(nodeOut || {})) {
      if (!Array.isArray(values)) continue;
      for (const item of values) {
        if (item && typeof item === 'object' && item.filename) outputs.push(item);
      }
    }
  }
  const authToken = backendToken();
  const imageUrls = outputs.map((item) => {
    const query = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
    return `/image/${encodeURIComponent(basename(String(item.filename)))}` + query;
  });
  return normalizeRecord({
    id: promptId,
    status: completed ? (statusText.includes('error') ? 'error' : 'success') : 'running',
    backend: 'comfy-ltx-eros-video',
    comfy_status: status,
    outputs,
    image_urls: imageUrls,
  }, { includeUrls });
}

async function waitForLtxErosPrompt(promptId, { timeoutS = 1800, pollMs = 1500, includeUrls = false } = {}) {
  const started = Date.now();
  while (true) {
    const wrapperJob = await getWrapperJobIfPresent(promptId, { includeUrls });
    if (wrapperJob) {
      if (!['queued', 'running'].includes(wrapperJob.status)) return wrapperJob;
      if (Date.now() - started > timeoutS * 1000) return { ...wrapperJob, wait_timed_out: true };
    } else {
      const history = await getComfyHistoryIfPresent(promptId);
      const comfyJob = comfyHistoryToJob(promptId, history, { includeUrls });
      if (comfyJob?.status && comfyJob.status !== 'running') return comfyJob;
      if (Date.now() - started > timeoutS * 1000) {
        return comfyJob ? { ...comfyJob, wait_timed_out: true } : { id: promptId, status: 'queued', wait_timed_out: true };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function filterRows(rows, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  return rows.filter((item) => {
    if (filters.category && item.category !== filters.category) return false;
    if (filters.folder && item.folder !== filters.folder) return false;
    if (filters.role && item.role !== filters.role) return false;
    if (filters.baseModel && item.baseModel !== filters.baseModel) return false;
    if (query) {
      const haystack = JSON.stringify({
        id: item.id,
        name: item.name,
        displayName: item.displayName,
        baseModel: item.baseModel,
        tags: item.tags,
        triggerWords: item.triggerWords,
      }).toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function buildServer() {
  const server = new McpServer({
    name: 'media-studio',
    version: '1.0.0',
  });

  server.registerResource(
    'media-generation-schema',
    'media://schema/generate',
    {
      title: 'Media Studio Generation Schema',
      description: 'Programmatic generation fields and workflow registry accepted by the Studio API.',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [{
        uri: 'media://schema/generate',
        mimeType: 'application/json',
        text: JSON.stringify(generationUsage(), null, 2),
      }],
    }),
  );

  server.registerResource(
    'media-video-workflows',
    'media://workflows/video',
    {
      title: 'Media Studio Video Workflows',
      description: 'Registered video workflows agents can launch through media_generate_video.',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [{
        uri: 'media://workflows/video',
        mimeType: 'application/json',
        text: JSON.stringify({ workflows: listRegisteredWorkflows({ media_type: 'video' }) }, null, 2),
      }],
    }),
  );

  server.registerTool('media_status', {
    title: 'Media Studio Status',
    description: 'Check the Media Studio backend and report MCP facade configuration.',
    inputSchema: {},
  }, tool(async () => {
    const health = await requestJson('/healthz', { timeoutMs: 8000 });
    return {
      backend: backendBase,
      studio: studioBase,
      localStudio: localStudioBase,
      publicStudio: studioBase,
      tokenConfigured: Boolean(token()),
      runtime: runtimeManifest(),
      health,
    };
  }));

  server.registerTool('media_generation_schema', {
    title: 'Media Studio Generation Schema',
    description: 'Return the supported programmatic generation fields and defaults.',
    inputSchema: {},
  }, tool(async () => generationUsage()));

  server.registerTool('media_list_workflows', {
    title: 'List Media Workflows',
    description: 'List registered workflows. Agents should inspect this when choosing a workflow for vague media requests.',
    inputSchema: {
      media_type: z.string().optional().describe('Optional media type filter, currently video.'),
      query: z.string().optional(),
    },
  }, tool(async (args) => {
    const workflows = listRegisteredWorkflows(args);
    return {
      count: workflows.length,
      default_video_workflow_id: defaultVideoWorkflowId(),
      workflows,
    };
  }));

  server.registerTool('media_generate_image', {
    title: 'Generate Image',
    description: 'Queue an image generation job. Returns a job snapshot; set wait=true only for short jobs.',
    inputSchema: {
      prompt: z.string().min(1).describe('Private prompt to render. The backend redacts prompts in stored history.'),
      backend: z.string().optional().describe('Optional backend route, such as mlx-mxfp8-bigloves-klein3-edit.'),
      width: z.number().int().min(64).max(4096).optional(),
      height: z.number().int().min(64).max(4096).optional(),
      steps: z.number().int().min(1).max(150).optional(),
      cfg: z.number().min(0).max(50).optional(),
      cfgScale: z.number().min(0).max(50).optional(),
      guidance: z.number().min(0).max(50).optional(),
      seed: z.union([z.number().int(), z.string()]).optional(),
      negative_prompt: z.string().max(2000).optional(),
      image_path: z.string().optional().describe('Existing local image path or Comfy input filename for edit backends.'),
      image_base64: z.string().optional().describe('Inline source image as raw base64 or data:image/...;base64,... data URL. Wins over image_path.'),
      image_url: z.string().optional().describe('Optional HTTP(S) source image fetched by Media Studio. Ignored when image_base64 is supplied.'),
      loras: z.array(z.object({
        id: z.string(),
        strength: z.number().optional(),
      })).optional(),
      wait: z.boolean().default(false).describe('Poll until the job reaches success/error or timeout_s.'),
      timeout_s: z.number().min(1).max(1800).default(900),
      include_urls: z.boolean().default(false).describe('Include token-bearing absolute Studio URLs in results.'),
    },
  }, tool(async (args) => {
    const includeUrls = machinePrivate ? false : args.include_urls;
    const stagedImage = await stageInlineImageFromArgs(args);
    const body = Object.fromEntries(Object.entries(args).filter(([key, value]) => (
      !['wait', 'timeout_s', 'include_urls', 'image_base64', 'image_url'].includes(key) && value !== undefined
    )));
    if (stagedImage) body.image_path = stagedImage;
    const queued = normalizeRecord(await requestJson('/api/generate', {
      method: 'POST',
      body,
      timeoutMs: 30000,
    }), { includeUrls });
    if (!args.wait || !queued.id) return { job: queued };
    const job = await waitForJob(queued.id, { timeoutS: args.timeout_s, includeUrls });
    return { job };
  }, { privateReceipt: true }));

  server.registerTool('media_generate_video', {
    title: 'Generate Video',
    description: 'Queue a registered video workflow. If workflow_id is omitted, the default local video workflow is used.',
    inputSchema: {
      workflow_id: z.string().optional().describe(`Registered workflow id. Defaults to ${defaultVideoWorkflowId()}. Use media_list_workflows to discover options.`),
      prompt: z.string().min(1).optional().describe('Optional positive video prompt. Long natural-language prompts are preserved without a client-side character cap.'),
      reference_description: z.string().optional().describe('Ingredients IC-LoRA only: panel-by-panel description of the reference sheet. Omit only when prompt already contains the required Reference Sheet Description and Target Description headings.'),
      negative_prompt: z.string().max(2000).optional().describe('Optional negative video prompt mapped through the registered workflow when supported.'),
      image_path: z.string().optional().describe('Absolute local image path or existing Comfy input filename. Absolute paths are copied into the private Comfy input folder before queueing if the workflow needs Comfy access.'),
      image_base64: z.string().optional().describe('Inline source image as raw base64 or data:image/...;base64,... data URL. Wins over image_path.'),
      image_url: z.string().optional().describe('Optional HTTP(S) source image fetched by Media Studio. Ignored when image_base64 is supplied.'),
      video_path: z.string().optional().describe('Source video path or existing Comfy input filename. Supplying video switches LTX generation to shot extension.'),
      video_base64: z.string().optional().describe('Inline source video as raw base64 or data:video/...;base64,... data URL. Wins over video_path.'),
      video_url: z.string().optional().describe('Optional HTTP(S) source video fetched by Media Studio. Ignored when video_base64 is supplied.'),
      video_mode: z.enum(['extend']).default('extend').describe('How LTX uses the source video. Extend preserves the source clip and generates a seamless continuation.'),
      middle_image_path: z.string().optional(),
      middle_image_base64: z.string().optional(),
      middle_image_url: z.string().optional(),
      end_image_path: z.string().optional(),
      end_image_base64: z.string().optional(),
      end_image_url: z.string().optional(),
      keyframes: z.array(z.object({
        image_path: z.string().optional(),
        image_base64: z.string().optional(),
        image_url: z.string().optional(),
        frame: z.number().optional(),
        frame_idx: z.number().optional(),
        time_seconds: z.number().optional(),
        role: z.enum(['start', 'middle', 'end']).optional(),
        strength: z.number().min(0).max(1).optional(),
      })).max(20).optional().describe('Arbitrary image anchors. Later anchors targeting the same normalized frame win.'),
      params: z.record(z.string(), z.any()).optional().describe('Additional workflow parameters for registry-defined slots, e.g. steps, cfg, guidance, or model-specific controls.'),
      width: z.number().int().min(64).max(4096).optional(),
      height: z.number().int().min(64).max(4096).optional(),
      frames: z.number().int().min(9).max(721).optional(),
      frame_rate: z.number().min(1).max(120).optional(),
      duration_seconds: z.number().min(1 / 24).max(30).optional().describe('For video input, seconds of new footage to append. For image input, requested output duration.'),
      seed: z.number().int().min(0).max(1000000000).optional(),
      wait: z.boolean().default(false).describe('Poll until native wrapper success/error, or until Comfy fallback appears in history.'),
      timeout_s: z.number().min(1).max(3600).default(1800),
      include_urls: z.boolean().default(false).describe('Include token-bearing absolute Studio URLs in wrapper-native results.'),
    },
  }, tool(async (args) => {
    const includeUrls = machinePrivate ? false : args.include_urls;
    const { spec, workflow, settings, body } = await buildVideoPromptBody(args);
    const submission = await requestJson('/comfy/api/prompt', {
      method: 'POST',
      body,
      timeoutMs: 60000,
    });
    const promptId = submission.prompt_id || submission.id;
    if (!promptId) {
      throw new Error(`LTX Eros workflow did not return a prompt id: ${JSON.stringify(submission)}`);
    }
    const queuedJob = await getWrapperJobIfPresent(promptId, { includeUrls });
    const job = args.wait
      ? await waitForLtxErosPrompt(promptId, { timeoutS: args.timeout_s, includeUrls })
      : (queuedJob || {
          id: promptId,
          status: submission.status || 'queued',
          backend: submission.backend || 'comfy-ltx-eros-video',
          comfy_prompt_id: promptId,
        });
    return {
      submission,
      job,
      workflow: {
        ...workflow,
        route: submission.native_mlx ? 'native-mlx-apple-silicon' : 'comfyui-fallback',
        ...(spec.native !== false ? { native_variant: spec.id, native_title: spec.title } : {}),
        image: settings.imageName,
        video: settings.videoName,
        video_mode: settings.videoMode,
        audio_mode: settings.audioMode,
        extension_frames: settings.extensionFrames,
        extension_output_frames: settings.extensionFrames,
        extension_latent_frames: settings.videoName ? Math.ceil(settings.extensionFrames / 8) : null,
        width: settings.width,
        height: settings.height,
        frames: settings.frames,
        frame_rate: settings.frameRate ?? settings.frame_rate,
        seed: settings.seed,
        settings,
        benchmark_seconds: spec.benchmarkSeconds,
        api_workflow: spec.apiWorkflowPath || ltxErosApiWorkflowPath,
        mobile_workflow: spec.mobileWorkflow ? join(ltxErosMobileWorkflowDir, spec.mobileWorkflow) : spec.mobileWorkflowPath,
      },
    };
  }, { privateReceipt: true }));

  server.registerTool('media_get_job', {
    title: 'Get Job',
    description: 'Poll one generation job by id.',
    inputSchema: {
      id: z.string().min(1),
      include_urls: z.boolean().default(false).describe('Include token-bearing absolute Studio URLs in results.'),
    },
  }, tool(async ({ id, include_urls }) => {
    const includeUrls = machinePrivate ? false : include_urls;
    const wrapperJob = await getWrapperJobIfPresent(id, { includeUrls });
    if (wrapperJob) return { job: wrapperJob };
    const comfyJob = comfyHistoryToJob(id, await getComfyHistoryIfPresent(id), { includeUrls });
    if (comfyJob) return { job: comfyJob };
    const error = new Error('not found');
    error.status = 404;
    throw error;
  }, { privateReceipt: true }));

  server.registerTool('media_list_history', {
    title: 'List History',
    description: 'List recent redacted generation history records.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(25),
      include_urls: z.boolean().default(false).describe('Include token-bearing absolute Studio URLs in results.'),
    },
  }, tool(async ({ limit, include_urls }) => {
    const includeUrls = machinePrivate ? false : include_urls;
    const data = await requestJson('/api/history', { timeoutMs: 30000 });
    const history = (data.history || []).slice(0, limit).map((item) => normalizeRecord(item, { includeUrls }));
    return { count: history.length, history };
  }, { privateReceipt: true }));

  server.registerTool('media_list_models', {
    title: 'List Models',
    description: 'List installed Comfy/Media Studio models with optional filters.',
    inputSchema: {
      category: z.string().optional(),
      folder: z.string().optional(),
      role: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(80),
      include_bundles: z.boolean().default(false),
    },
  }, tool(async (args) => {
    const data = await requestJson('/api/models', { timeoutMs: 45000 });
    const filtered = filterRows(data.models || [], args);
    return {
      count: filtered.length,
      models: filtered.slice(0, args.limit),
      equipped: data.equipped || [],
      ram: data.ram,
      civitaiInstalled: data.civitaiInstalled,
      ...(args.include_bundles ? { bundles: data.bundles || {} } : {}),
    };
  }));

  server.registerTool('media_list_loras', {
    title: 'List LoRAs',
    description: 'List installed and currently selected LoRAs.',
    inputSchema: {
      baseModel: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
  }, tool(async (args) => {
    const data = await requestJson('/api/loras', { timeoutMs: 45000 });
    const filtered = filterRows(data.loras || [], args);
    return {
      count: filtered.length,
      loras: filtered.slice(0, args.limit),
      selected: data.selected || [],
      baseModels: data.baseModels || [],
    };
  }));

  server.registerTool('media_select_loras', {
    title: 'Select LoRAs',
    description: 'Replace the current generation LoRA selection.',
    inputSchema: {
      loras: z.array(z.object({
        id: z.string(),
        strength: z.number().optional(),
      })).default([]),
    },
  }, tool(async ({ loras }) => requestJson('/api/loras/select', {
    method: 'POST',
    body: { loras },
    timeoutMs: 30000,
  })));

  server.registerTool('media_equip_model', {
    title: 'Equip Model',
    description: 'Equip a model in the Studio model manager.',
    inputSchema: {
      id: z.string().min(1).describe('Model id from media_list_models, e.g. diffusion_models/name.safetensors.'),
    },
  }, tool(async ({ id }) => requestJson('/api/models/equip', {
    method: 'POST',
    body: { id },
    timeoutMs: 30000,
  })));

  server.registerTool('media_unequip_model', {
    title: 'Unequip Model',
    description: 'Unequip a model in the Studio model manager.',
    inputSchema: {
      id: z.string().min(1).describe('Model id from media_list_models.'),
    },
  }, tool(async ({ id }) => requestJson('/api/models/unequip', {
    method: 'POST',
    body: { id },
    timeoutMs: 30000,
  })));

  return server;
}

async function startStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Media Studio MCP running on stdio; backend=${backendBase}`);
}

async function startHttp({ host, port }) {
  const app = createMediaStudioMcpExpressApp({ host });
  app.post('/mcp', async (req, res) => {
    if (!authorizedHttpRequest(req)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error('MCP request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });
  app.get('/mcp', (_req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  });
  app.delete('/mcp', (_req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  });
  const listener = app.listen(port, host, () => {
    console.error(`Media Studio MCP listening at http://${host}:${port}/mcp; backend=${backendBase}`);
  });
  listener.on('error', (error) => {
    console.error('Failed to start MCP HTTP server:', error);
    process.exit(1);
  });
}

function usage() {
  console.log(`Usage: media-studio-mcp [--stdio|--http] [--host 127.0.0.1] [--port 8795] [--print-tools]

Environment:
  MEDIA_STUDIO_MCP_BACKEND_URL   Backend API URL, default ${backendBase}
  MEDIA_STUDIO_MCP_STUDIO_URL    Local Studio URL, default ${localStudioBase}
  MEDIA_STUDIO_MCP_PUBLIC_STUDIO_URL
                                  Public Studio URL for include_urls output links, default ${studioBase}
  MEDIA_STUDIO_TOKEN             Existing backend token override
  MEDIA_STUDIO_TOKEN_FILE        Existing backend token file, default ${tokenPath}
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  if (args.includes('--print-tools')) {
    console.log(JSON.stringify({
      name: 'media-studio',
      backend: backendBase,
      studio: studioBase,
      localStudio: localStudioBase,
      publicStudio: studioBase,
      tools: toolCatalog.map(([name, description]) => ({ name, description })),
      resources: [
        { uri: 'media://schema/generate', name: 'media-generation-schema' },
        { uri: 'media://workflows/video', name: 'media-video-workflows' },
      ],
    }, null, 2));
    return;
  }
  const hostIndex = args.indexOf('--host');
  const portIndex = args.indexOf('--port');
  const host = hostIndex >= 0 ? args[hostIndex + 1] : (process.env.MEDIA_STUDIO_MCP_HOST || process.env.ZIMG_MCP_HOST || '127.0.0.1');
  const port = Number(portIndex >= 0 ? args[portIndex + 1] : (process.env.MEDIA_STUDIO_MCP_PORT || process.env.ZIMG_MCP_PORT || 8795));
  if (args.includes('--http') || process.env.MEDIA_STUDIO_MCP_TRANSPORT === 'http' || process.env.ZIMG_MCP_TRANSPORT === 'http') {
    await startHttp({ host, port });
    return;
  }
  await startStdio();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
