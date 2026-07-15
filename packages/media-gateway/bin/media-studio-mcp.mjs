#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
    accepts: ['prompt', 'image_path', 'image_base64', 'image_url', 'width', 'height', 'frames', 'frame_rate', 'seed'],
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
    accepts: ['prompt', 'image_path', 'image_base64', 'image_url', 'width', 'height', 'frames', 'frame_rate', 'seed'],
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

function generationUsage() {
  return {
    endpoint: '/api/generate',
    pattern: 'async-by-default; call media_get_job or media_list_history to poll',
    privacy: 'The backend stores private prompt labels in history instead of raw prompts.',
    required: {
      prompt: { type: 'string', maxLength: 1200 },
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
      image_path: { type: 'string', note: 'Absolute path or Comfy input filename for edit backends.' },
      image_base64: { type: 'string', note: 'Inline source image as raw base64 or data:image/...;base64,... data URL. Wins over image_path.' },
      image_url: { type: 'string', note: 'Optional HTTP(S) source image fetched server-side. image_base64 wins when both are supplied.' },
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
    defaults: workflowDefaults(workflow.id),
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

async function imageSourceFromArgs(args = {}, defaults = {}) {
  const staged = await stageInlineImageFromArgs(args);
  if (staged) return staged;
  return argOrDefault(args, defaults, 'image_path') ?? defaults.image;
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
      image: settings.imageName,
      prompt: settings.prompt,
      width: settings.width,
      height: settings.height,
      frames: settings.frames,
      frame_rate: settings.frameRate,
      seed: settings.seed,
    },
    fallback: 'ComfyUI LTX graph on non-Apple-Silicon or when the native MLX LTX route is disabled',
  };
  setEditorWidget(out, 597, 'filename_prefix', spec.marker);
  setEditorWidget(out, 597, 'frame_rate', settings.frameRate);
  setEditorWidget(out, 773, 0, settings.imageName);
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
  const imageName = stageLtxErosImage(await imageSourceFromArgs(args, defaults), defaults.image);
  const settings = {
    prompt: prompt.endsWith('\n') ? prompt : `${prompt}\n\n`,
    imageName,
    width: positiveInt(args.width, defaults.width, { min: 64, max: 4096 }),
    height: positiveInt(args.height, defaults.height, { min: 64, max: 4096 }),
    frames: positiveInt(args.frames, defaults.frames, { min: 9, max: 721 }),
    frameRate: positiveFloat(args.frame_rate, defaults.frame_rate, { min: 1, max: 120 }),
    seed: positiveInt(args.seed, defaults.seed, { min: 0, max: 1_000_000_000 }),
  };
  const apiWorkflow = loadJsonFile(ltxErosApiWorkflowPath, 'LTX Eros API workflow');
  const promptGraph = cloneJson(apiWorkflow.prompt || apiWorkflow);
  setApiInput(promptGraph, 597, 'filename_prefix', spec.marker);
  setApiInput(promptGraph, 597, 'frame_rate', ['826', 0]);
  setApiInput(promptGraph, 773, 'image', settings.imageName);
  setApiInput(promptGraph, 824, 'value', settings.prompt);
  setApiInput(promptGraph, 809, 'value', settings.width);
  setApiInput(promptGraph, 811, 'value', settings.height);
  setApiInput(promptGraph, 542, 'value', settings.frameRate);
  setApiInput(promptGraph, 812, 'noise_seed', settings.seed);

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

async function buildComfyApiPromptBody(args = {}, workflow) {
  const apiWorkflowPath = resolveWorkflowFile(workflow.api_workflow || workflow.workflow || workflow.apiWorkflow);
  const apiWorkflow = loadJsonFile(apiWorkflowPath, `${workflow.id} API workflow`);
  const promptGraph = cloneJson(apiWorkflow.prompt || apiWorkflow);
  const defaults = workflowDefaults(workflow.id);
  const slots = workflow.slots || {};
  const settings = {};

  const promptText = argOrDefault(args, defaults, 'prompt');
  if (promptText !== undefined) {
    settings.prompt = String(promptText);
    setMappedApiInput(promptGraph, slots.prompt, settings.prompt);
  }
  const negativePrompt = argOrDefault(args, defaults, 'negative_prompt');
  if (negativePrompt !== undefined) setMappedApiInput(promptGraph, slots.negative_prompt, String(negativePrompt));

  const rawImage = await imageSourceFromArgs(args, defaults);
  if (rawImage !== undefined && slots.image_path) {
    settings.imageName = stageLtxErosImage(rawImage, defaults.image);
    setMappedApiInput(promptGraph, slots.image_path, settings.imageName);
  }

  for (const [key, slot] of Object.entries({
    width: slots.width,
    height: slots.height,
    frames: slots.frames,
    frame_rate: slots.frame_rate,
    seed: slots.seed,
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

  const extraPngInfo = {};
  const mobileWorkflowPath = resolveWorkflowFile(workflow.mobile_workflow || workflow.editor_workflow || workflow.mobileWorkflow);
  if (mobileWorkflowPath && existsSync(mobileWorkflowPath)) {
    extraPngInfo.workflow = loadJsonFile(mobileWorkflowPath, `${workflow.id} editor workflow`);
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
  const authToken = token();
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

function authorizedHttpRequest(req) {
  const expected = token();
  if (!expected) return false;
  const auth = String(req.headers.authorization || '');
  if (auth === `Bearer ${expected}`) return true;
  if (String(req.headers['x-token'] || '') === expected) return true;
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.searchParams.get('token') === expected) return true;
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

function tool(handler) {
  return async (args) => {
    try {
      return ok(await handler(args || {}));
    } catch (error) {
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

function comfyHistoryToJob(promptId, history) {
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
  return {
    id: promptId,
    status: completed ? (statusText.includes('error') ? 'error' : 'success') : 'running',
    backend: 'comfy-ltx-eros-video',
    comfy_status: status,
    outputs,
  };
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
      const comfyJob = comfyHistoryToJob(promptId, history);
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
      prompt: z.string().min(1).max(1200).describe('Private prompt to render. The backend redacts prompts in stored history.'),
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
    const stagedImage = await stageInlineImageFromArgs(args);
    const body = Object.fromEntries(Object.entries(args).filter(([key, value]) => (
      !['wait', 'timeout_s', 'include_urls', 'image_base64', 'image_url'].includes(key) && value !== undefined
    )));
    if (stagedImage) body.image_path = stagedImage;
    const queued = normalizeRecord(await requestJson('/api/generate', {
      method: 'POST',
      body,
      timeoutMs: 30000,
    }), { includeUrls: args.include_urls });
    if (!args.wait || !queued.id) return { job: queued };
    const job = await waitForJob(queued.id, { timeoutS: args.timeout_s, includeUrls: args.include_urls });
    return { job };
  }));

  server.registerTool('media_generate_video', {
    title: 'Generate Video',
    description: 'Queue a registered video workflow. If workflow_id is omitted, the default local video workflow is used.',
    inputSchema: {
      workflow_id: z.string().optional().describe(`Registered workflow id. Defaults to ${defaultVideoWorkflowId()}. Use media_list_workflows to discover options.`),
      prompt: z.string().min(1).max(4000).optional().describe('Optional positive video prompt. If omitted, the workflow default prompt is used.'),
      image_path: z.string().optional().describe('Absolute local image path or existing Comfy input filename. Absolute paths are copied into the private Comfy input folder before queueing if the workflow needs Comfy access.'),
      image_base64: z.string().optional().describe('Inline source image as raw base64 or data:image/...;base64,... data URL. Wins over image_path.'),
      image_url: z.string().optional().describe('Optional HTTP(S) source image fetched by Media Studio. Ignored when image_base64 is supplied.'),
      params: z.record(z.string(), z.any()).optional().describe('Additional workflow parameters for registry-defined slots, e.g. steps, cfg, guidance, or model-specific controls.'),
      width: z.number().int().min(64).max(4096).optional(),
      height: z.number().int().min(64).max(4096).optional(),
      frames: z.number().int().min(9).max(721).optional(),
      frame_rate: z.number().min(1).max(120).optional(),
      seed: z.number().int().min(0).max(1000000000).optional(),
      wait: z.boolean().default(false).describe('Poll until native wrapper success/error, or until Comfy fallback appears in history.'),
      timeout_s: z.number().min(1).max(3600).default(1800),
      include_urls: z.boolean().default(false).describe('Include token-bearing absolute Studio URLs in wrapper-native results.'),
    },
  }, tool(async (args) => {
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
    const queuedJob = await getWrapperJobIfPresent(promptId, { includeUrls: args.include_urls });
    const job = args.wait
      ? await waitForLtxErosPrompt(promptId, { timeoutS: args.timeout_s, includeUrls: args.include_urls })
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
  }));

  server.registerTool('media_get_job', {
    title: 'Get Job',
    description: 'Poll one generation job by id.',
    inputSchema: {
      id: z.string().min(1),
      include_urls: z.boolean().default(false).describe('Include token-bearing absolute Studio URLs in results.'),
    },
  }, tool(async ({ id, include_urls }) => ({
    job: normalizeRecord(await requestJson(`/api/job/${encodeURIComponent(id)}`), { includeUrls: include_urls }),
  })));

  server.registerTool('media_list_history', {
    title: 'List History',
    description: 'List recent redacted generation history records.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(25),
      include_urls: z.boolean().default(false).describe('Include token-bearing absolute Studio URLs in results.'),
    },
  }, tool(async ({ limit, include_urls }) => {
    const data = await requestJson('/api/history', { timeoutMs: 30000 });
    const history = (data.history || []).slice(0, limit).map((item) => normalizeRecord(item, { includeUrls: include_urls }));
    return { count: history.length, history };
  }));

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
