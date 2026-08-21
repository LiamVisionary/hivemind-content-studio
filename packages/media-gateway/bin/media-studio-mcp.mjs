#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hostHeaderValidation, localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import express from 'express';
import * as z from 'zod/v4';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
const repositoryRoot = resolve(projectRoot, '..', '..');
const ingredientsSheetComposerPath = join(__dirname, 'compose-ingredients-sheet.py');
const ltxAnchorCanvasCompilerPath = join(__dirname, 'compile-ltx-anchor-canvas.py');
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
// Reference audio clips are capped at 15s combined by the H3 model card, so
// even lossless stereo stays small; the cap guards against non-audio payloads.
const maxInlineAudioBytes = Number(process.env.MEDIA_STUDIO_MCP_MAX_INLINE_AUDIO_BYTES || 25 * 1024 * 1024);
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
  // v1.3 + DMD: the distillation deltas are merged into the base rather than
  // fused as a LoRA at runtime, which the build's card says avoids the
  // resampling drift and conditioning loss the distilled LoRA introduces during
  // the stage-2 upscale refine. Same --distilled flow and speed as v1.2.
  'dmd-q8-v13': {
    title: 'MLXBits 10Eros v1.3 DMD q8 distilled',
    marker: 'Eros/native_mlx_ltx__dmd-q8-v13',
    mobileWorkflow: 'LTX 2.3 Eros MLX DMD q8 v1.3 Mobile.json',
    benchmarkSeconds: 193.11,
    defaults: {
      prompt: defaultLtxErosPrompt,
      width: 480,
      height: 832,
      frames: 233,
      frame_rate: 24,
      seed: -1,
    },
  },
  // v1.2 + DMD: same DMD merge as v1.3 above, held at the v1.2 fine-tune so the
  // fine-tune and the distillation can be told apart rather than guessed at.
  // v1.2 rebuilt through our merge path — the control for build arithmetic.
  'eros-v12-q8-fast-rebuilt': {
    title: 'LTX 2.3 10Eros v1.2 q8 distilled (rebuilt)',
    marker: 'Eros/native_mlx_ltx__eros-v12-q8-fast-rebuilt',
    mobileWorkflow: 'LTX 2.3 Eros MLX v1.2 q8 Rebuilt Mobile.json',
    benchmarkSeconds: 193.11,
    defaults: { prompt: defaultLtxErosPrompt, width: 480, height: 832, frames: 121, frame_rate: 24, seed: -1 },
  },
  // v1.4 Fast: the eros-fast recipe (cond-safe distilled LoRA) on v1.4.
  'eros-v14-q8-fast': {
    title: 'LTX 2.3 10Eros v1.4 q8 distilled (cond-safe)',
    marker: 'Eros/native_mlx_ltx__eros-v14-q8-fast',
    mobileWorkflow: 'LTX 2.3 Eros MLX v1.4 q8 Fast Mobile.json',
    benchmarkSeconds: 193.11,
    defaults: {
      prompt: defaultLtxErosPrompt,
      width: 480,
      height: 832,
      frames: 121,
      frame_rate: 24,
      seed: -1,
    },
  },
  // v1.4 DMD: v1.4 merged with the DMD LoRA the author attaches to that release
  // and says it is "fully designed for use with". eros-v14-q8-fast above merges
  // v1.2's cond-safe LoRA instead, so this is the intended fast build for v1.4.
  'eros-v14-q8-dmd': {
    title: 'LTX 2.3 10Eros v1.4 DMD q8 distilled',
    marker: 'Eros/native_mlx_ltx__eros-v14-q8-dmd',
    mobileWorkflow: 'LTX 2.3 Eros MLX v1.4 DMD Mobile.json',
    benchmarkSeconds: 193.11,
    defaults: {
      prompt: defaultLtxErosPrompt,
      width: 480,
      height: 832,
      frames: 121,
      frame_rate: 24,
      seed: -1,
    },
  },
  // v1.4 dev package, converted locally. Runs the CFG two-stage dev pipeline.
  'eros-v14-q8-dev': {
    title: 'LTX 2.3 10Eros v1.4 q8 dev',
    marker: 'Eros/native_mlx_ltx__eros-v14-q8-dev',
    mobileWorkflow: 'LTX 2.3 Eros MLX v1.4 q8 dev Mobile.json',
    benchmarkSeconds: null,
    defaults: {
      prompt: defaultLtxErosPrompt,
      width: 480,
      height: 832,
      frames: 121,
      frame_rate: 24,
      seed: -1,
    },
  },
  'dmd-q8-v12': {
    title: 'MLXBits 10Eros v1.2 DMD q8 distilled',
    marker: 'Eros/native_mlx_ltx__dmd-q8-v12',
    mobileWorkflow: 'LTX 2.3 Eros MLX DMD q8 v1.2 Mobile.json',
    benchmarkSeconds: 193.11,
    defaults: {
      prompt: defaultLtxErosPrompt,
      width: 480,
      height: 832,
      frames: 233,
      frame_rate: 24,
      seed: -1,
    },
  },
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
      seed: -1,
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
      seed: -1,
    },
  },
};

const ltxErosVariantAliases = {
  fast: 'fast-q8-v12',
  q8: 'fast-q8-v12',
  'q8-v12': 'fast-q8-v12',
  'fast-q8': 'fast-q8-v12',
  fast_q8_v12: 'fast-q8-v12',
  'dmd-v12': 'dmd-q8-v12',
  'dmd-q8': 'dmd-q8-v13',
  dmd: 'dmd-q8-v13',
};

const builtInVideoWorkflowRegistry = {
  // The Lite half of the v1.4 pair, and the build the model's author intends:
  // the v1.4 card says the release is "fully designed for use with the DMD lora
  // I attached". DMD is a few-step distillation, so this runs the fast no-CFG
  // distilled route while ltx23-eros-v14 runs the slow two-stage dev one.
  'ltx23-eros-v14-dmd': {
    id: 'ltx23-eros-v14-dmd',
    media_type: 'video',
    title: 'LTX 2.3 Eros v1.4 DMD',
    description: "v1.4 merged with the DMD LoRA its author ships alongside it and says the model is fully designed for. Runs the fast 8-step distilled route. Note that v1.4 is a base-aligned fine-tune with deliberately near-zero anatomy of its own — the author's guidance is to add LoRAs for that, and to prompt it as a scene script rather than reusing v1.2-style prompts.",
    family: 'ltx-2.3',
    builder: 'ltx-eros',
    variant: 'eros-v14-q8-dmd',
    supports_loras: true,
    compatible_base_models: ['LTXV'],
    lora_injection: {
      class_type: 'LTX2LoraLoaderAdvanced',
      targets: [{ node: '719', input: 'model' }, { node: '722', input: 'model' }],
      name_input: 'lora_name',
      strength_input: 'strength_model',
      static_inputs: { video: 1, video_to_audio: 0, audio: 0, audio_to_video: 0, other: 1 },
    },
    default: false,
    requires: { prompt: false, image: false },
    accepts: ['prompt', 'negative_prompt', 'image_path', 'image_base64', 'image_url', 'video_path', 'video_base64', 'video_url', 'video_mode', 'duration_seconds', 'width', 'height', 'frames', 'frame_rate', 'seed', 'denoise', 'detailer_strength', 'loras'],
  },
  'ltx23-eros-dmd-v12': {
    id: 'ltx23-eros-dmd-v12',
    media_type: 'video',
    title: 'LTX 2.3 Eros DMD (v1.2)',
    description: 'Image-to-video on the 10Eros v1.2 DMD-merged q8 distilled route. Pairs with Eros Fast (v1.2, distilled LoRA) and Eros DMD (v1.3, DMD merge) so a prompt-adherence change can be attributed to the fine-tune or to the distillation rather than to both at once.',
    family: 'ltx-2.3',
    builder: 'ltx-eros',
    variant: 'dmd-q8-v12',
    supports_loras: true,
    compatible_base_models: ['LTXV'],
    lora_injection: {
      class_type: 'LTX2LoraLoaderAdvanced',
      targets: [{ node: '719', input: 'model' }, { node: '722', input: 'model' }],
      name_input: 'lora_name',
      strength_input: 'strength_model',
      static_inputs: { video: 1, video_to_audio: 0, audio: 0, audio_to_video: 0, other: 1 },
    },
    default: false,
    requires: { prompt: false, image: false },
    accepts: ['prompt', 'image_path', 'image_base64', 'image_url', 'video_path', 'video_base64', 'video_url', 'video_mode', 'duration_seconds', 'width', 'height', 'frames', 'frame_rate', 'seed', 'denoise', 'detailer_strength', 'loras'],
  },
};

const workflowAliases = {
  default: 'ltx23-eros-v14-dmd',
  video: 'ltx23-eros-v14-dmd',
  fast: 'ltx23-eros-v14-dmd',
  ltx: 'ltx23-eros-v14-dmd',
  'ltx-eros': 'ltx23-eros-v14-dmd',
  'ltx23-eros': 'ltx23-eros-v14-dmd',
  fastregular: 'ltx23-regular-fp8',
  'fast-regular': 'ltx23-regular-fp8',
  'regular-fast': 'ltx23-regular-fp8',
  regular: 'ltx23-regular-fp8',
  ingredients: 'ltx23-ic-ingredients-lora',
  'ic-ingredients': 'ltx23-ic-ingredients-lora',
  'ltx23-ingredients': 'ltx23-ic-ingredients-lora',
  'reference-sheet': 'ltx23-ic-ingredients-lora',
  'eros-ingredients': 'ltx23-eros-ic-ingredients-lora',
  'eros-ic-ingredients': 'ltx23-eros-ic-ingredients-lora',
  'ltx23-eros-ingredients': 'ltx23-eros-ic-ingredients-lora',
  'eros-v14-ingredients': 'ltx23-eros-v14-ic-ingredients-lora',
  'eros-v14-ic-ingredients': 'ltx23-eros-v14-ic-ingredients-lora',
  'eros-dmd-v12': 'ltx23-eros-dmd-v12',
  'dmd-v12': 'ltx23-eros-dmd-v12',
  'eros-v14-dmd': 'ltx23-eros-v14-dmd',
  'v14-dmd': 'ltx23-eros-v14-dmd',
  'dmd-v14': 'ltx23-eros-v14-dmd',
  'eros-dmd-ingredients': 'ltx23-eros-dmd-ic-ingredients-lora',
  'eros-dmd-ic-ingredients': 'ltx23-eros-dmd-ic-ingredients-lora',
  'ltx23-eros-dmd-ingredients': 'ltx23-eros-dmd-ic-ingredients-lora',
  minimax: 'minimax-h3',
  h3: 'minimax-h3',
  'minimax-video': 'minimax-h3',
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

// base64url DER SPKI, mirroring the gateway's own validator so a malformed
// header is ignored here rather than travelling on to be rejected there.
const SPKI_B64URL_RE = /^[A-Za-z0-9_-]{100,4000}$/;

// The key the CURRENT call should seal to, when the caller supplied one of its
// own. A fresh MCP server is built per HTTP request, but tool handlers reach
// requestJson() through many layers of async — async-local storage carries the
// caller's identity down without threading it through every tool signature.
const requesterContext = new AsyncLocalStorage();

export function normalizedRequesterPub(value) {
  const text = String(value || '').trim();
  return SPKI_B64URL_RE.test(text) ? text : '';
}

export function runWithRequester(pub, fn) {
  const normalized = normalizedRequesterPub(pub);
  return normalized ? requesterContext.run({ pub: normalized }, fn) : fn();
}

// Exposed for the requester-context test; the precedence it encodes is the
// difference between a clip belonging to its generator and belonging to us.
export function __testRequesterPublicKey() {
  return requesterPublicKey();
}

function requesterPublicKey() {
  // The requesting client's public key (base64url SPKI), presented with every
  // gateway call. Remote Comfy lanes seal generated media to this key, and the
  // gateway scopes history/status for keyed jobs to the same presenter —
  // possession of the matching decrypt key, not machine locality, grants
  // access to results. Optional: without it, jobs seal to the owner vault.
  //
  // A caller that presents its OWN key wins over this process's configured
  // identity. That ordering is the whole point: a browser generating through
  // this sidecar must have its media sealed to THAT BROWSER, not to the shared
  // agent key this process happens to hold. The env fallback below is for
  // agent-initiated calls, which present nothing and should seal to the agent.
  const scoped = requesterContext.getStore();
  if (scoped?.pub) return scoped.pub;
  if (process.env.MEDIA_STUDIO_E2E_PUB) return process.env.MEDIA_STUDIO_E2E_PUB.trim();
  const pubPath = process.env.MEDIA_STUDIO_E2E_PUB_FILE;
  if (!pubPath) return '';
  try {
    return readFileSync(pubPath, 'utf8').trim();
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
        examples: ['comfy-krea2-turbo-identity-edit', 'mlx-bigloves-klein3-edit', 'mlx-mxfp8-bigloves-klein3-edit'],
      },
      width: { type: 'integer', note: 'Forwarded to the active workflow/runner when supported.' },
      height: { type: 'integer', note: 'Forwarded to the active workflow/runner when supported.' },
      steps: { type: 'integer', note: 'Forwarded to the active workflow/runner when supported.' },
      cfg: { type: 'number', note: 'Alias accepted by some routes.' },
      cfgScale: { type: 'number', note: 'Alias accepted by some routes.' },
      guidance: { type: 'number', note: 'Used by native edit routes and forwarded when supported.' },
      seed: { type: 'integer|string', default: 'random/runner default when omitted, blank, or -1' },
      negative_prompt: { type: 'string', note: 'Used for generation only; not persisted in history.' },
      ref_boost: { type: 'number', default: 4, note: 'Krea2 identity reference-fidelity dial.' },
      identity_strength: { type: 'number', default: 1, note: 'Krea2 identity LoRA strength.' },
      grounding_px: { type: 'integer', default: 768, note: 'Krea2 identity vision-grounding size.' },
      reference_description: { type: 'string', note: 'For Ingredients IC-LoRA, describe every panel in the reference sheet. The server wraps this with the required Reference Sheet and Target headings.' },
      ingredient_images: { type: 'array', maxItems: 12, note: 'Ingredients IC-LoRA only. Independent image sources are composed server-side into one conditioning-only sheet and never become timeline anchors.' },
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
    ...(workflow.backend !== undefined ? { backend: workflow.backend } : {}),
    default: Boolean(workflow.default),
    requires: workflow.requires,
    accepts: workflow.accepts,
    supports_loras: Boolean(workflow.supports_loras),
    compatible_base_models: Array.isArray(workflow.compatible_base_models) ? workflow.compatible_base_models : [],
    ...(workflow.max_reference_images ? { max_reference_images: workflow.max_reference_images } : {}),
    // Reference-mode capacity, read off the wired slots rather than restated:
    // the studio sizes its References menu from this instead of hardcoding 9/3/3.
    ...(workflow.reference_image_slots || workflow.reference_video_slots || workflow.reference_audio_slots
      ? {
        reference_slots: {
          images: (workflow.reference_image_slots || []).length,
          videos: (workflow.reference_video_slots || []).length,
          audios: (workflow.reference_audio_slots || []).length,
        },
      }
      : {}),
    defaults: publicWorkflowDefaults(workflow.id),
    ...(workflow.beta ? { beta: true } : {}),
    // Reached by routing, never picked by hand: the studio sends a run here
    // when references are attached to the family's normal tier, and the MCP
    // routes an agent's reference_* call here the same way (routeReferenceArguments).
    ...(workflow.routing_only ? { routing_only: true } : {}),
    ...(workflow.prompt_helper ? { prompt_helper: workflow.prompt_helper } : {}),
    ...(workflow.prompt_contract ? { prompt_contract: workflow.prompt_contract } : {}),
    ...(workflow.ingredient_inputs ? { ingredient_inputs: workflow.ingredient_inputs } : {}),
    ...(Array.isArray(workflow.aspect_ratios) ? { aspect_ratios: workflow.aspect_ratios } : {}),
    // Capacity facts, published so the studio can refuse an impossible run in
    // the picker instead of letting it fail at submit. Both are needed to work
    // out a ceiling: the budget gives the packed rows the card holds, the grid
    // says which frame counts the graph can actually sample.
    ...(workflow.frame_grid ? { frame_grid: workflow.frame_grid } : {}),
    ...(Number(workflow.motion_reference_budget?.max_packed_rows) > 0
      ? { motion_reference_max_packed_rows: Number(workflow.motion_reference_budget.max_packed_rows) }
      : {}),
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

function mergeWorkflowDefinition(base, override) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return cloneJson(override);
  if (!override || typeof override !== 'object' || Array.isArray(override)) return cloneJson(override);
  const out = cloneJson(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeWorkflowDefinition(out[key], value);
    } else {
      out[key] = cloneJson(value);
    }
  }
  return out;
}

function externalWorkflowRegistry() {
  if (!existsSync(workflowRegistryPath)) return {};
  const data = loadJsonFile(workflowRegistryPath, 'Media Studio workflow registry');
  const items = Array.isArray(data) ? data : (Array.isArray(data.workflows) ? data.workflows : Object.values(data.workflows || {}));
  const definitions = new Map(items
    .filter((item) => item && typeof item === 'object' && String(item.id || '').trim())
    .map((item) => [String(item.id).trim(), item]));
  const out = {};
  const resolving = new Set();
  const resolveDefinition = (id) => {
    if (out[id]) return out[id];
    const item = definitions.get(id);
    if (!item) throw new Error(`workflow ${id} was not found in the registry`);
    if (resolving.has(id)) throw new Error(`workflow inheritance cycle detected at ${id}`);
    resolving.add(id);
    const parentId = String(item.inherits || '').trim();
    const resolved = parentId
      ? mergeWorkflowDefinition(resolveDefinition(parentId), item)
      : cloneJson(item);
    delete resolved.inherits;
    resolving.delete(id);
    out[id] = {
      media_type: 'video',
      requires: { prompt: false, image: false },
      accepts: ['prompt', 'image_path', 'image_base64', 'image_url', 'width', 'height', 'frames', 'frame_rate', 'seed'],
      ...resolved,
      id,
    };
    return out[id];
  };
  for (const id of definitions.keys()) resolveDefinition(id);
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

// Seeds are the one setting whose default must NOT be a number. Every video
// workflow shipped `seed: 42`, so an agent that called media_generate_video
// without naming a seed got the same clip back forever — and on a remote lane
// it got worse than that: an identical graph replays out of ComfyUI's cache in
// milliseconds and hands back a path the privacy sweeper has already deleted,
// surfacing as a bare `HTTP Error 404`. The Video Studio has always rolled its
// own seed client-side (see VideoStudio.jsx), which is exactly why this stayed
// invisible: only agent callers ever saw the frozen default.
//
// -1 is the documented "roll me one" value, matching the image workflows and
// the gateway's own native-runner check. It cannot simply be left in the
// defaults, because positiveInt(-1, …, {min: 0}) clamps it to a fixed 0.
const RANDOM_SEED_MAX = 1_000_000_000;

function resolveSeed(...candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const parsed = Number(candidate);
    if (!Number.isFinite(parsed)) continue;
    if (parsed < 0) break;  // an explicit -1 asks for randomness; stop falling back
    return Math.min(RANDOM_SEED_MAX, Math.round(parsed));
  }
  return Math.floor(Math.random() * RANDOM_SEED_MAX);
}

function positiveFloat(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

// Mirrors normalize_ltx_denoise_mode in the gateway: '' (off), 'light', 'strong'.
function normalizeLtxDenoiseMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  if (mode === 'light' || mode === 'strong') return mode;
  if (['1', 'true', 'yes', 'on'].includes(mode)) return 'light';
  return '';
}

// Strength for the optional IC-LoRA Detailer second pass. 0 (the default) means
// the gateway returns before doing any work, so a plain generation is unaffected.
// THE task, read once. Mirrors src/lib/videoTasks.js in the studio: the client
// decides the job and says so, and nothing here re-infers it from which media
// arrived. head_swap is still accepted so an older client keeps working.
function videoTaskFrom(args) {
  const raw = String(args?.task ?? args?.params?.task ?? '').trim().toLowerCase();
  if (['generate', 'extend', 'head-swap'].includes(raw)) return raw;
  return (args?.head_swap ?? args?.params?.head_swap) ? 'head-swap' : 'generate';
}

function normalizeLtxDetailerStrength(value) {
  const strength = Number(value);
  if (!Number.isFinite(strength) || strength <= 0) return 0;
  return Math.min(1.5, Math.max(0.05, strength));
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
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/avif': '.avif',
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
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.heif', '.avif'].includes(fromName)) return fromName === '.jpeg' ? '.jpg' : fromName;
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

function extensionForAudioMime(mime) {
  const normalized = String(mime || '').split(';')[0].trim().toLowerCase();
  return {
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/wave': '.wav',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/flac': '.flac',
    'audio/x-flac': '.flac',
    'audio/ogg': '.ogg',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac',
    // What real recorders label AAC-in-MP4. Kept in step with
    // control_api._INLINE_AUDIO_SUFFIXES, which is the gate that hard-fails.
    'audio/mp4a-latm': '.m4a',
    'audio/aacp': '.aac',
    'audio/x-hx-aac-adts': '.aac',
    'audio/webm': '.webm',
    'audio/opus': '.opus',
    'audio/3gpp': '.3gp',
    'audio/amr': '.amr',
    'audio/x-caf': '.caf',
  }[normalized] || '';
}

function detectAudioExtension(buffer, mime, sourceName) {
  if (buffer?.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') return '.wav';
  if (buffer?.length >= 4 && buffer.toString('ascii', 0, 4) === 'fLaC') return '.flac';
  if (buffer?.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') return '.ogg';
  if (buffer?.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3') return '.mp3';
  if (buffer?.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return '.mp3';
  if (buffer?.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return '.m4a';
  const fromMime = extensionForAudioMime(mime);
  if (fromMime) return fromMime;
  const fromName = extname(String(sourceName || '')).toLowerCase();
  return ['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac'].includes(fromName) ? fromName : '';
}

function stageAudioBuffer(buffer, { mime = '', sourceName = '' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('inline audio is empty');
  if (buffer.length > maxInlineAudioBytes) {
    throw new Error(`inline audio is too large; max ${Math.round(maxInlineAudioBytes / 1024 / 1024)} MB (reference clips are 15 seconds at most anyway)`);
  }
  const ext = detectAudioExtension(buffer, mime, sourceName);
  if (!ext) throw new Error(`inline audio must be WAV, MP3, FLAC, OGG, M4A, or AAC; received ${mime || 'unknown type'}`);
  mkdirSync(comfyInputDir, { recursive: true });
  const stagedName = `mcp_audio_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}${ext}`;
  writeFileSync(join(comfyInputDir, stagedName), buffer);
  return stagedName;
}

function decodeBase64Audio(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('audio_base64 is empty');
  const dataUrl = text.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is);
  const mime = dataUrl ? String(dataUrl[1] || '').trim().toLowerCase() : '';
  if (mime && !mime.startsWith('audio/')) throw new Error(`audio_base64 data URL must be audio/*, got ${mime}`);
  let encoded = (dataUrl ? dataUrl[2] : text).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('audio_base64 is not valid base64');
  encoded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  return { buffer: Buffer.from(encoded, 'base64'), mime };
}

function stageBase64Audio(value) {
  const decoded = decodeBase64Audio(value);
  return stageAudioBuffer(decoded.buffer, { mime: decoded.mime });
}

async function stageAudioUrl(value) {
  const source = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(source.protocol)) throw new Error('audio_url must be http or https');
  const response = await fetch(source, {
    headers: { Accept: 'audio/*,application/octet-stream' },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`audio_url fetch failed: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length && length > maxInlineAudioBytes) {
    throw new Error(`audio_url is too large; max ${Math.round(maxInlineAudioBytes / 1024 / 1024)} MB`);
  }
  const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());
  return stageAudioBuffer(buffer, { mime, sourceName: basename(source.pathname) });
}

// Resolves one reference_audios entry to a Comfy input filename: inline data
// and URLs are staged, an absolute path is copied in, and a bare name is
// trusted to already be in the input folder (same contract as ref images).
async function audioSourceFromEntry(entry = {}) {
  const audioBase64 = entry.audio_base64;
  if (audioBase64 !== undefined && audioBase64 !== null && String(audioBase64).trim() !== '') {
    return stageBase64Audio(audioBase64);
  }
  const audioUrl = entry.audio_url;
  if (audioUrl !== undefined && audioUrl !== null && String(audioUrl).trim() !== '') {
    return stageAudioUrl(audioUrl);
  }
  const audioPath = String(entry.audio_path ?? '').trim();
  if (!audioPath) return undefined;
  if (!isAbsolute(audioPath)) return audioPath;
  const source = resolve(audioPath);
  if (!existsSync(source)) throw new Error(`audio_path not found: ${audioPath}`);
  const alreadyInput = inputRelativeName(source);
  if (alreadyInput) return alreadyInput;
  if (!detectAudioExtension(null, '', source)) {
    throw new Error(`audio_path must be WAV, MP3, FLAC, OGG, M4A, or AAC: ${audioPath}`);
  }
  mkdirSync(comfyInputDir, { recursive: true });
  const stagedName = `mcp_audio_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}${extname(source).toLowerCase()}`;
  copyFileSync(source, join(comfyInputDir, stagedName));
  return stagedName;
}

// Resolves one reference_videos entry to a Comfy input filename, mirroring the
// reference-audio contract: inline data and URLs are staged, an absolute path is
// copied in, and a bare name is trusted to already be in the input folder.
async function referenceVideoSourceFromEntry(entry = {}) {
  const videoBase64 = entry.video_base64;
  if (videoBase64 !== undefined && videoBase64 !== null && String(videoBase64).trim() !== '') {
    return stageBase64Video(videoBase64);
  }
  const videoUrl = entry.video_url;
  if (videoUrl !== undefined && videoUrl !== null && String(videoUrl).trim() !== '') {
    return stageVideoUrl(videoUrl);
  }
  const videoPath = String(entry.video_path ?? '').trim();
  if (!videoPath) return undefined;
  return stageLtxVideo(videoPath);
}

function stagedMediaDuration(name) {
  const value = String(name || '').trim();
  if (!value) return null;
  const path = isAbsolute(value) ? resolve(value) : resolve(comfyInputDir, value);
  const result = spawnSync(process.env.FFPROBE || 'ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    path,
  ], { encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) return null;
  const seconds = Number(String(result.stdout || '').trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

// The reference-frame budget MiniMaxH3ReferenceToVideo actually works to.
//
// Its adapt_canvas() puts every reference video on a 768-short-edge canvas
// capped at 768*1344 pixels, rounds each axis to 32 — and never upscales. Both
// directions of missing that budget cost something:
//
//   too big   the node downscales what we sent, so the lane decoded, encoded
//             and shipped pixels that were thrown away
//   too small the node keeps OUR frames rather than upscaling to its canvas,
//             so the reference is permanently coarser than the model would
//             have used
//
// So the cap is the node's own area cap, not a round number. The previous rule
// (`scale=w=min(iw,1280)`) capped WIDTH, which its own comment called a long
// edge: it fired on landscape 4K and did nothing at all for portrait phone
// footage, where 1080 is already under 1280 — the common case now.
const REF_VIDEO_MAX_PIXELS = 768 * 1344;

// MiniMaxH3ReferenceToVideo reads a reference video's frames AS 24 fps — it
// never asks how fast they were shot — so a 30 fps download would play back
// 25% slow and drag every gesture with it. Re-encode to a true 24 fps, hold the
// model card's 15s ceiling, and land inside the reference-frame budget above.
// Audio is kept only when the caller wants the clip's own soundtrack in.
const REF_VIDEO_MAX_SECONDS = 15;
// The model card's floor; normalizeReferenceVideo refuses anything shorter,
// so a "trim to" lever below it would be advice the lane then rejects.
const REF_VIDEO_MIN_SECONDS = 2;
// Opt-in "compact" staging for MOTION references: fit the clip inside a
// 384-short-edge x 1152-long-edge box, never upscaled. The node keeps our
// frames rather than upscaling them, so the reference costs ~3.3x fewer
// sequence rows than its 768-short-edge canvas and sampling runs about twice
// as fast. Measured 2026-08-21 on the rented 5090, same seed, a 5s clip with
// three pictures and a 5s phone reference: the full (704x1504 at the node), 544
// and 384 renders sit 22-24dB PSNR / 0.86-0.88 SSIM from each other — the
// between-seed noise — and ~17dB / 0.80 from the no-video control: the same
// performance, the same motion. One scene, one seed, identity from pictures:
// not validated for a video that IS the identity reference, which is why this
// is a per-clip choice and not the default.
const REF_VIDEO_COMPACT_SHORT_EDGE = 384;
const REF_VIDEO_COMPACT_LONG_EDGE = 1152;

// ---- The motion-reference VRAM budget --------------------------------------
//
// Why a motion clip runs the card out when the same clip without one does not:
// Comfy's memory planner sizes the DiT load from the noise latent alone.
// comfy/model_base.py's MiniMaxH3 never sets memory_usage_factor_conds, so
// memory_required() sees the OUTPUT canvas and length and nothing else, while
// every reference — pictures, motion clips, soundtracks — rides in the
// conditioning as `minimax_refs` and gets loaded around as if it were free.
// The DynamicVRAM loader fills the card with the int8 DiT (19.5GiB of the
// 31.36GiB) and what is left has to hold the activations of the WHOLE packed
// sequence at once — about 98KB per row at block 0's qkv_proj — so the budget
// is on total packed rows, clip and references alike. 2026-08-21 (job
// 34a722c2) a 10s clip at 1216x704 with a 13.3s phone reference died there at
// 26.47GiB + 6.21GiB; the same job under `--vram-headroom 12` died the same
// way (27.55 + 6.46GiB), so the flag at 12 is not a remedy:
//
//   output video   latent_t(frames) × (W/16 × H/16) / 4  — a /16 VAE packed 1x2x2
//   output audio   2 × round(frames/24 × 40)            — the joint audio latent
//   each motion    latent_t(n) × (cw/16 × ch/16) / 4, where (cw, ch) is the
//   clip           node's adapt_canvas() of the STAGED clip's own dimensions —
//                  a 768-short-edge canvas capped at 768*1344, each axis rounded
//                  to 32, never upscaled past the source — NOT the output canvas
//                  (a portrait phone clip lands on 704x1504: 1,034 rows per
//                  latent frame, against 836 for a 1216x704 output), and n is
//                  its length trimmed to min(its own, the clip's) and then DOWN
//                  to the 17k+5 lattice; plus, with use_audio, its soundtrack
//                  encoded IN FULL (never trimmed to the clip): 2 × round(s × 40)
//   each picture   at most the output's rows per latent frame (ref_image_size
//                  "match" scales down to the output's pixel area)
//   each voice     2 × round(s × 40)
//   clip
//
// latent_t(n) = ((n − 5) / 17) × 5 + 2 is video_latent_t() in
// comfy_extras/nodes_minimax_h3.py; the other constants are the node's own.
// Text tokens are not counted: the caller cannot change them, and the
// measured points below include them. The old rule priced a reference at the
// OUTPUT canvas per frame and ignored the soundtrack, which is how the job
// above sat exactly at its ceiling and failed.
//
// The budget lives on the workflow (`motion_reference_budget.max_packed_rows`)
// rather than here, because the STUDIO has to know it too: this guard is the
// backstop, not the user experience. A duration that cannot render should never
// be offered in the picker, and the only way the picker and the guard agree is
// if they read the same number (motion_reference_duration_limits in
// media_studio.py mirrors this pricing). A workflow with no measured budget is
// not guarded — an unmeasured card is not the same as a card that cannot do it.
//
// Anchors, all on a rented RTX 5090 (31.36GiB usable), ComfyUI 0.32.0,
// cudaMallocAsync, DynamicVRAM, workflow minimax-h3-reference:
//   142,366 rows   10s clip at 1216x704, 7 pictures, 13.3s soundtracked phone
//                  reference (704x1504 at the node): OUT OF MEMORY, three times
//                  (jobs 34a722c2, b9f5b32d, 103f6173 — the last two under
//                  --vram-headroom 12 and 20 with IDENTICAL numbers, so that
//                  flag is no lever) — 155,006 rows with its text, 6.21GiB of
//                  qkv_proj
//    95,092 rows   the same with the reference trimmed to 4s: sampled, but in
//                  the thrash regime (73s a step against 28-31s for a plain
//                  clip, the card pegged) and OUT OF MEMORY at step 4 (job
//                  b2f76185) — so the edge for reference work is BELOW this,
//                  and the budget has to keep a run out of the thrash, not
//                  just out of the immediate failure
//    76,600 rows   the same 10s clip with 3 pictures and the reference trimmed
//                  to 6s and staged compact (384x832 at the node, 312 rows per
//                  latent frame): SAMPLED steadily, 48.5s a step, torch pool
//                  high-water 23.34GiB (job 69a108a5)
//    66,900 rows   5s clip at 1216x704, 3 pictures, 5s full-canvas reference:
//                  ran, 42.0s a step, torch 22.97GiB (job 1f9db575); the same
//                  reference staged at 544 and 384 wide ran at 30.2s and 22.3s
//                  a step (54k and 44k rows), three pictures alone at 15.1s (34k)
//    90,658 rows   a plain 15s clip at 1216x704, no references: ran, torch pool
//                  high-water 27.16GiB — ~7.7GiB of activations for ~92k rows
// So a clean fit with normal step times is proven up to ~77k rows and the
// thrash starts before 95k; 85,000 sits between. Reference rows also cost
// steeply in TIME (15s a step for pictures alone, 42s with a full-canvas 5s
// reference, 73s in the thrash). The 2026-08-15 "158 effective frames ran"
// point (~98k rows) was read off nvidia-smi on another box and is not trusted. Re-measure by reading torch's
// own peak (the OOM summary, or /system_stats torch_vram_total during
// sampling), never nvidia-smi under cudaMallocAsync and never the first run
// after an OOM — and never with workflow_id minimax-h3: references handed to
// a workflow without slots used to be dropped silently, which is what the
// 2026-08-21 "verified" probes had actually measured (see
// assertReferenceSlotsExist below).
const H3_CANVAS_MULTIPLE = 32;
const H3_REFERENCE_BASE_SHORT_EDGE = 768;
const H3_REFERENCE_MAX_PIXELS = REF_VIDEO_MAX_PIXELS;
const H3_VAE_STRIDE = 16;
const H3_LATENT_PIXELS_PER_ROW = 4;
const H3_AUDIO_LATENT_FPS = 40;
const H3_AUDIO_LATENT_ROWS_PER_FRAME = 2;
// The most rows one latent frame of reference video can ever cost:
// adapt_canvas() at its worst aspect (a ~7.6:1 panorama rounds to 2816x384).
// Pre-flight prices an un-staged clip at this, so it can only over-count.
const H3_REFERENCE_ROWS_PER_LATENT_FRAME_MAX = 1056;
// ...and the most a COMPACT-staged clip can cost: the whole 1152x384 box. It
// never upscales past the source, so this bounds every aspect ratio exactly.
const H3_REFERENCE_COMPACT_ROWS_PER_LATENT_FRAME_MAX = h3RowsPerLatentFrame(REF_VIDEO_COMPACT_LONG_EDGE, REF_VIDEO_COMPACT_SHORT_EDGE);

// video_latent_t() in comfy_extras/nodes_minimax_h3.py.
function h3VideoLatentFrames(frameCount) {
  const frames = Math.max(0, Math.round(Number(frameCount) || 0));
  return frames <= 5 ? 2 : Math.floor((frames - 5) / 17) * 5 + 2;
}

function h3RowsPerLatentFrame(width, height) {
  return (Math.floor(width / H3_VAE_STRIDE) * Math.floor(height / H3_VAE_STRIDE)) / H3_LATENT_PIXELS_PER_ROW;
}

function h3AudioLatentRows(seconds) {
  return Math.round(Math.max(0, Number(seconds) || 0) * H3_AUDIO_LATENT_FPS) * H3_AUDIO_LATENT_ROWS_PER_FRAME;
}

// Python's round(): half to even. The node rounds each canvas axis with it, and
// an even-pixel staged width of 16 mod 32 lands exactly on the half.
function roundHalfEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

// adapt_canvas() plus the never-upscale rule in MiniMaxH3ReferenceToVideo.execute.
function h3ReferenceCanvas(width, height) {
  const snap = (value) => Math.max(H3_CANVAS_MULTIPLE, roundHalfEven(value / H3_CANVAS_MULTIPLE) * H3_CANVAS_MULTIPLE);
  const ratio = width / height;
  let nominalWidth = ratio >= 1 ? H3_REFERENCE_BASE_SHORT_EDGE * ratio : H3_REFERENCE_BASE_SHORT_EDGE;
  let nominalHeight = ratio >= 1 ? H3_REFERENCE_BASE_SHORT_EDGE : H3_REFERENCE_BASE_SHORT_EDGE / ratio;
  if (nominalWidth * nominalHeight > H3_REFERENCE_MAX_PIXELS) {
    const scale = Math.sqrt(H3_REFERENCE_MAX_PIXELS / (nominalWidth * nominalHeight));
    nominalWidth *= scale;
    nominalHeight *= scale;
  }
  let canvasWidth = snap(nominalWidth);
  let canvasHeight = snap(nominalHeight);
  if (width * height < canvasWidth * canvasHeight) {
    canvasWidth = snap(width);
    canvasHeight = snap(height);
  }
  return { width: canvasWidth, height: canvasHeight };
}

function motionReferenceRowBudget(workflow) {
  const budget = Number(workflow?.motion_reference_budget?.max_packed_rows);
  return budget > 0 ? budget : null;
}

// Rows one motion clip adds to a clip of `clipFrames` frames. Dimensions and
// length are the STAGED file's when known; an unknown length is priced as the
// longest the lane will stage, an unknown canvas at the node's largest.
function motionReferenceVideoRows(workflow, reference, clipFrames, frameRate) {
  const seconds = Math.min(
    Number(reference?.seconds) > 0 ? Number(reference.seconds) : REF_VIDEO_MAX_SECONDS,
    REF_VIDEO_MAX_SECONDS,
  );
  const referenceFrames = Math.round(seconds * frameRate);
  const effectiveFrames = gridFrameCountAtMost(workflow, Math.min(referenceFrames, clipFrames));
  let rowsPerLatentFrame = reference?.compact
    ? H3_REFERENCE_COMPACT_ROWS_PER_LATENT_FRAME_MAX
    : H3_REFERENCE_ROWS_PER_LATENT_FRAME_MAX;
  if (Number(reference?.width) > 0 && Number(reference?.height) > 0) {
    const canvas = h3ReferenceCanvas(Number(reference.width), Number(reference.height));
    rowsPerLatentFrame = h3RowsPerLatentFrame(canvas.width, canvas.height);
  }
  const videoRows = h3VideoLatentFrames(effectiveFrames) * rowsPerLatentFrame;
  const audioRows = reference?.useAudio ? h3AudioLatentRows(seconds) : 0;
  return { videoRows, audioRows, rows: videoRows + audioRows, effectiveFrames, seconds };
}

// The whole packed sequence for a run — output, motion clips, pictures, voice
// clips — for a clip of `clipFrames` frames at the settings' canvas.
function packedSequenceRows(workflow, settings, clipFrames) {
  const width = Number(settings.width);
  const height = Number(settings.height);
  const frameRate = Number(settings.frameRate) || 24;
  // The node aligns the clip UP to the lattice before anything is encoded.
  const frames = normalizedGridFrameCount(workflow, clipFrames) ?? Math.round(Number(clipFrames) || 0);
  const outputRowsPerLatentFrame = h3RowsPerLatentFrame(width, height);
  const outputVideoRows = h3VideoLatentFrames(frames) * outputRowsPerLatentFrame;
  const outputAudioRows = h3AudioLatentRows(frames / frameRate);
  const videos = (Array.isArray(settings.referenceVideos) ? settings.referenceVideos : [])
    .filter(Boolean)
    .map((reference) => motionReferenceVideoRows(workflow, reference, frames, frameRate));
  const pictureRows = (Number(settings.referenceImageCount) || 0) * outputRowsPerLatentFrame;
  const audioSeconds = Array.isArray(settings.referenceAudioSeconds) ? settings.referenceAudioSeconds : [];
  let voiceRows = 0;
  for (let index = 0; index < (Number(settings.referenceAudioCount) || 0); index += 1) {
    const seconds = Number(audioSeconds[index]) > 0 ? Number(audioSeconds[index]) : REF_VIDEO_MAX_SECONDS;
    voiceRows += h3AudioLatentRows(Math.min(seconds, REF_VIDEO_MAX_SECONDS));
  }
  const referenceRows = videos.reduce((sum, item) => sum + item.rows, 0);
  return {
    total: outputVideoRows + outputAudioRows + referenceRows + pictureRows + voiceRows,
    frames,
    outputVideoRows,
    outputAudioRows,
    videos,
    pictureRows,
    voiceRows,
  };
}

function gridFrameCountBelow(workflow, frames) {
  const modulus = Math.round(Number(workflow?.frame_grid?.modulus));
  if (!Number.isFinite(modulus) || modulus <= 0) return null;
  const floor = normalizedGridFrameCount(workflow, 1);
  const next = frames - modulus;
  return next >= floor ? next : null;
}

// The longest clip that still fits with the references as attached — the first
// lever the refusal names. Walks the lattice down from the asked length.
function motionReferenceClipCeilingFrames(workflow, settings, budget) {
  let frames = normalizedGridFrameCount(workflow, settings.frames);
  if (frames === undefined) return null;
  while (frames !== null) {
    if (packedSequenceRows(workflow, settings, frames).total <= budget) return frames;
    frames = gridFrameCountBelow(workflow, frames);
  }
  return null;
}

// The longest the motion clips could be, trimmed, for the clip as asked — the
// other lever. A reference shorter than the clip keeps its own length.
function motionReferenceTrimCeilingSeconds(workflow, settings, budget) {
  const frameRate = Number(settings.frameRate) || 24;
  let frames = gridFrameCountAtMost(workflow, REF_VIDEO_MAX_SECONDS * frameRate);
  while (frames !== null) {
    const trimmed = {
      ...settings,
      referenceVideos: (settings.referenceVideos || []).filter(Boolean)
        .map((reference) => ({ ...reference, seconds: frames / frameRate })),
    };
    if (packedSequenceRows(workflow, trimmed, settings.frames).total <= budget) return frames / frameRate;
    frames = gridFrameCountBelow(workflow, frames);
  }
  return null;
}

function thousands(value) {
  return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// References handed to a workflow with no reference slots used to be dropped
// without a word: the staging blocks below are gated on the slots existing, so
// the graph sampled as plain text-to-video and the caller got a clip that had
// never seen a single picture or motion clip they sent. Two sessions measured
// "reference mode" VRAM ceilings against exactly that on 2026-08-21. Refuse,
// and name the sibling that does take them — reference mode is a routing-only
// workflow the studio reaches by itself, but an agent has to ask for it by id.
const REFERENCE_SLOT_KEYS = [
  ['reference_images', 'reference_image_slots', 'reference pictures'],
  ['reference_videos', 'reference_video_slots', 'reference videos'],
  ['reference_audios', 'reference_audio_slots', 'reference audio clips'],
];

function assertReferenceSlotsExist(workflow, args = {}) {
  const orphaned = REFERENCE_SLOT_KEYS
    .map(([argKey, slotKey, label]) => ({
      argKey,
      slotKey,
      label,
      count: Array.isArray(args[argKey]) ? args[argKey].filter(Boolean).length : 0,
    }))
    .filter((item) => item.count > 0 && !(Array.isArray(workflow[item.slotKey]) && workflow[item.slotKey].length));
  if (!orphaned.length) return;
  const sibling = Object.values(videoWorkflowRegistry()).find((candidate) =>
    candidate.id !== workflow.id
    && candidate.family && candidate.family === workflow.family
    && (candidate.media_type || 'video') === (workflow.media_type || 'video')
    && orphaned.every((item) => Array.isArray(candidate[item.slotKey]) && candidate[item.slotKey].length));
  const what = orphaned.map((item) => `${item.count} ${item.label}`).join(' and ');
  const error = new Error(
    `workflow ${workflow.id} has no slots for references: the ${what} sent with it would be dropped and the `
    + `clip would render without them. `
    + (sibling
      ? `Send them to workflow ${sibling.id}${sibling.title ? ` (${sibling.title})` : ''} instead.`
      : 'Pick a workflow that lists reference slots.'),
  );
  // Workflow ids and counts only — nothing the caller sent.
  error.machineSafe = true;
  throw error;
}

function assertMotionReferenceFitsTheCard(workflow, settings) {
  // Only runs with a motion clip attached: the cap is on reference VIDEO. Nine
  // pictures on a 15s clip were never the problem and keep the full range.
  const videos = Array.isArray(settings.referenceVideos) ? settings.referenceVideos.filter(Boolean) : [];
  if (!videos.length) return;
  const budget = motionReferenceRowBudget(workflow);
  if (!budget) return;
  const width = Number(settings.width);
  const height = Number(settings.height);
  const frames = Number(settings.frames);
  if (!(width > 0 && height > 0 && frames > 0)) return;
  const priced = packedSequenceRows(workflow, settings, frames);
  if (priced.total <= budget) return;
  const rate = Number(settings.frameRate) || 24;
  const seconds = (value) => (value / rate).toFixed(1);
  const clipCeiling = motionReferenceClipCeilingFrames(workflow, settings, budget);
  const trimCeiling = motionReferenceTrimCeilingSeconds(workflow, settings, budget);
  const soundtrackRows = priced.videos.reduce((sum, item) => sum + item.audioRows, 0);
  const plural = videos.length === 1 ? '' : 's';
  const levers = [];
  if (clipCeiling) levers.push(`shorten the clip to ${seconds(clipCeiling)}s`);
  if (trimCeiling && trimCeiling >= REF_VIDEO_MIN_SECONDS) {
    levers.push(
      `trim the reference video${plural} to ${trimCeiling.toFixed(1)}s or less — a reference shorter than `
      + 'the clip keeps its own length, so it costs only that',
    );
  }
  if (soundtrackRows) levers.push(`leave the soundtrack out (it alone costs ${thousands(soundtrackRows)} rows)`);
  if (videos.some((reference) => !reference.compact)) {
    levers.push('stage the reference video compact (canvas "compact": about a third of the rows, the same motion)');
  }
  levers.push('drop a reference video');
  const error = new Error(
    `a ${seconds(priced.frames)}s clip at ${width}x${height} does not fit this card with ${videos.length} `
    + `reference video${plural} attached: together they carry ${thousands(priced.total)} packed rows — the clip `
    + `itself, each reference encoded at its own canvas for min(its length, the clip's)`
    + `${soundtrackRows ? ' plus its soundtrack' : ''}${priced.pictureRows ? ', and the reference pictures' : ''} `
    + `— and the limit here is ${thousands(budget)}. Either ${levers.join(', or ')}. `
    + 'Reference pictures cost the same whatever the length.',
  );
  // Survives machine-private redaction. This message is made of the card's
  // capacity and the canvas the caller already chose — row counts, a duration,
  // a pixel size. It carries no prompt text and no media, which is what
  // redaction exists to protect. Without the flag the studio receives a bare
  // "MediaStudioError" and the one thing the user could act on is the one
  // thing that gets stripped.
  error.machineSafe = true;
  throw error;
}

// Aspect-preserving downscale into REF_VIDEO_MAX_PIXELS, never an upscale, both
// axes even (yuv420p needs it). Written as an ffmpeg expression rather than
// probed dimensions so one filter is right for portrait, landscape and square.
function referenceVideoScaleFilter(canvas = 'full') {
  // "compact" fits the clip inside REF_VIDEO_COMPACT_LONG_EDGE x
  // REF_VIDEO_COMPACT_SHORT_EDGE (either orientation); the node never
  // upscales, so that box bounds what the clip can cost.
  const s = canvas === 'compact'
    ? `min(1\\,min(${REF_VIDEO_COMPACT_SHORT_EDGE}/min(iw\\,ih)\\,${REF_VIDEO_COMPACT_LONG_EDGE}/max(iw\\,ih)))`
    : `min(1\\,sqrt(${REF_VIDEO_MAX_PIXELS}/(iw*ih)))`;
  return `scale=w=trunc(iw*${s}/2)*2:h=trunc(ih*${s}/2)*2`;
}

function normalizeReferenceVideo(stagedName, { keepAudio = false, maxSeconds = REF_VIDEO_MAX_SECONDS, canvas = 'full' } = {}) {
  const source = resolve(comfyInputDir, stagedName);
  const duration = stagedMediaDuration(stagedName);
  if (duration !== null && duration < REF_VIDEO_MIN_SECONDS) {
    throw new Error(
      `reference video is ${duration.toFixed(1)}s; MiniMax H3 reference videos must be at least ${REF_VIDEO_MIN_SECONDS} seconds`,
    );
  }
  mkdirSync(comfyInputDir, { recursive: true });
  const outputName = `mcp_refvideo_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}.mp4`;
  const result = spawnSync(process.env.FFMPEG || 'ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', source,
    '-t', String(maxSeconds),
    '-vf', `fps=24,${referenceVideoScaleFilter(canvas)}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    ...(keepAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
    join(comfyInputDir, outputName),
  ], { encoding: 'utf8', timeout: 300000 });
  if (result.error?.code === 'ENOENT') {
    throw new Error('ffmpeg is required to stage a reference video (it is resampled to 24 fps) but was not found');
  }
  if (result.status !== 0) {
    throw new Error(`reference video could not be converted to 24 fps: ${String(result.stderr || '').trim().slice(0, 300)}`);
  }
  return outputName;
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

// The motion-context clip (scene chaining) travels under its own arg names so
// it can never be confused with video_* — that trio means "extend/head-swap
// THIS footage" and flips LTX-only behavior all over the stack.
async function motionContextSourceFromArgs(args = {}) {
  const params = args.params && typeof args.params === 'object' ? args.params : {};
  const staged = await stageInlineVideoFromArgs({
    video_base64: args.motion_context_base64 ?? params.motion_context_base64,
    video_url: args.motion_context_url ?? params.motion_context_url,
  });
  if (staged) return staged;
  return args.motion_context_path ?? params.motion_context_path;
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

function ingredientPythonExecutable() {
  const configured = String(process.env.MEDIA_STUDIO_PYTHON || '').trim();
  if (configured) return configured;
  const projectPython = process.platform === 'win32'
    ? join(repositoryRoot, '.venv', 'Scripts', 'python.exe')
    : join(repositoryRoot, '.venv', 'bin', 'python');
  if (existsSync(projectPython)) return projectPython;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function ingredientImageAbsolutePath(imageName) {
  const absolute = resolve(comfyInputDir, String(imageName || ''));
  const rel = relative(resolve(comfyInputDir), absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(absolute)) {
    throw new Error(`staged ingredient image is unavailable: ${imageName}`);
  }
  return absolute;
}

function composeIngredientSheet(imageNames, { width, height } = {}) {
  if (!existsSync(ingredientsSheetComposerPath)) throw new Error('Ingredients sheet compositor is unavailable');
  const outputName = `mcp_ingredients_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}.png`;
  const outputPath = join(comfyInputDir, outputName);
  const geometryArgs = Number.isFinite(Number(width)) && Number.isFinite(Number(height))
    ? ['--width', String(width), '--height', String(height)]
    : [];
  const result = spawnSync(ingredientPythonExecutable(), [
    ingredientsSheetComposerPath,
    '--output',
    outputPath,
    ...geometryArgs,
    ...imageNames.map(ingredientImageAbsolutePath),
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`Ingredients sheet composition failed: ${result.error.message}`);
  if (result.status !== 0 || !existsSync(outputPath)) {
    throw new Error(`Ingredients sheet composition failed: ${String(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
  try {
    return { imageName: outputName, layout: JSON.parse(String(result.stdout || '').trim()) };
  } catch {
    throw new Error('Ingredients sheet compositor returned invalid metadata');
  }
}

function compileLtxAnchorCanvas(imageName, { width, height, prompt, seed }) {
  if (!existsSync(ltxAnchorCanvasCompilerPath)) throw new Error('LTX anchor canvas compiler is unavailable');
  const result = spawnSync(ingredientPythonExecutable(), [ltxAnchorCanvasCompilerPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input: JSON.stringify({
      source: ingredientImageAbsolutePath(imageName),
      image_name: imageName,
      width,
      height,
      prompt: String(prompt || ''),
      seed: Number(seed ?? 42),
    }),
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`LTX anchor canvas compilation failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`LTX anchor canvas compilation failed: ${String(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
  try {
    const compiled = JSON.parse(String(result.stdout || '').trim());
    if (!compiled.graph || !Array.isArray(compiled.output)) throw new Error('missing graph output');
    return compiled;
  } catch (error) {
    throw new Error(`LTX anchor canvas compiler returned invalid metadata: ${error.message}`);
  }
}

async function ingredientSheetFromArgs(args, workflow, dimensions = {}) {
  const raw = args.ingredient_images ?? args.params?.ingredient_images;
  if (raw === undefined) return null;
  if (workflow.prompt_contract?.type !== 'ltx23-ingredients') {
    throw new Error('ingredient_images is only supported by the Ingredients IC-LoRA workflow');
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 12) {
    throw new Error('ingredient_images must contain between 1 and 12 reference images');
  }
  const entries = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object') throw new Error(`ingredient_images[${index}] must be an object`);
    const source = await imageSourceFromArgs(item, {});
    if (!source) {
      throw new Error(`ingredient_images[${index}] requires image_path, image_base64, or image_url`);
    }
    entries.push({
      imageName: stageLtxErosImage(source),
      description: String(item.description || item.label || '').trim().slice(0, 1000),
    });
  }
  const composed = composeIngredientSheet(entries.map((entry) => entry.imageName), dimensions);
  // A single source is usually a finished multi-view sheet supplied as-is;
  // describing it as one positioned panel ("left panel: reference view 1")
  // misleads the model. Describe it as the whole sheet instead.
  const generatedDescription = entries.length === 1
    ? (entries[0].description
      ? `The reference sheet: ${entries[0].description}`
      : 'The reference sheet shows the same character from multiple angles; every panel depicts one identical person whose face, hair, and wardrobe must be preserved in the target shot.')
    : composed.layout.panels.map((panel, index) => {
      const description = entries[index].description || `reference view ${index + 1} of the same character or ingredient`;
      return `${panel.position} panel: ${description}`;
    }).join('\n');
  return {
    imageName: composed.imageName,
    layout: composed.layout,
    sourceCount: entries.length,
    referenceDescription: generatedDescription,
  };
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

function stagedVideoDimensions(videoName) {
  const value = String(videoName || '').trim();
  if (!value) return null;
  const path = isAbsolute(value) ? resolve(value) : resolve(comfyInputDir, value);
  const result = spawnSync(process.env.FFPROBE || 'ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=s=x:p=0',
    path,
  ], { encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) return null;
  const match = String(result.stdout || '').trim().match(/^(\d+)x(\d+)/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
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

// Drops a node from an API graph along with every link into it, then follows
// the break downstream: a consumer left with NO link inputs at all existed only
// to serve the pruned chain (a reference video's LoadVideo -> GetVideoComponents
// pair), so it goes too. A consumer that still holds other links — the reference
// conditioner, which merely loses one optional autogrow key — stays put.
// Lifts a pass-through node out of a graph: every consumer of its output is
// reconnected to whatever fed `throughInput`, then the node is dropped. Unlike
// pruneApiNode this keeps the chain intact — it is how an optional model
// wrapper (EasyCache) turns fully off instead of running as a no-op.
function bypassApiNode(prompt, nodeId, throughInput) {
  const id = String(nodeId ?? '').trim();
  const node = prompt?.[id];
  const upstream = node?.inputs?.[throughInput];
  if (!node || !Array.isArray(upstream)) return;
  delete prompt[id];
  for (const consumer of Object.values(prompt)) {
    if (!consumer?.inputs) continue;
    for (const [key, value] of Object.entries(consumer.inputs)) {
      if (Array.isArray(value) && String(value[0]) === id) consumer.inputs[key] = upstream;
    }
  }
}

function pruneApiNode(prompt, nodeId) {
  const id = String(nodeId ?? '').trim();
  if (!id || !prompt?.[id]) return;
  delete prompt[id];
  for (const [consumerId, node] of Object.entries(prompt)) {
    if (!prompt[consumerId] || !node?.inputs) continue;
    let unlinked = false;
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && String(value[0]) === id) {
        delete node.inputs[key];
        unlinked = true;
      }
    }
    if (!unlinked) continue;
    if (!Object.values(node.inputs).some((value) => Array.isArray(value))) {
      pruneApiNode(prompt, consumerId);
    }
  }
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
  // Multi-target slot: an array of slot DESCRIPTORS (objects or pairs) fans
  // one value out to several node inputs (e.g. LTX AV graphs need the frame
  // count on both the video latent and the audio latent). Legacy ["node",
  // "input"] pairs — string OR numeric node ids — contain scalars, so the
  // every() check routes them to normalizeSlot unchanged.
  if (Array.isArray(slot) && slot.length
      && slot.every((t) => Array.isArray(t) || (t && typeof t === 'object'))) {
    for (const target of slot) setMappedApiInput(prompt, target, value);
    return;
  }
  const normalized = normalizeSlot(slot);
  if (!normalized || value === undefined || value === null || value === '') return;
  setApiInput(prompt, normalized.node, normalized.input, value);
}

function applyApiInputOverrides(prompt, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return;
  for (const [nodeId, inputs] of Object.entries(overrides)) {
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) continue;
    const node = apiPromptNode(prompt, nodeId);
    node.inputs = { ...node.inputs, ...cloneJson(inputs) };
  }
}

function applyEditorWidgetOverrides(workflow, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return;
  for (const [nodeId, widgets] of Object.entries(overrides)) {
    if (!Array.isArray(widgets)) continue;
    const node = editorNode(workflow, nodeId);
    if (!node) throw new Error(`editor workflow is missing override node ${nodeId}`);
    node.widgets_values = cloneJson(widgets);
  }
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

// Registry entries whose model uses a different frame lattice than LTX declare
// frame_grid: {modulus, offset} (e.g. MiniMax H3 is 17k+5). Snap UP so the
// recorded frame count matches what the model actually renders.
function normalizedGridFrameCount(workflow, value) {
  const grid = workflow?.frame_grid;
  const modulus = Math.round(Number(grid?.modulus));
  if (!Number.isFinite(modulus) || modulus <= 0) return undefined;
  const offset = ((Math.round(Number(grid?.offset ?? 1)) % modulus) + modulus) % modulus;
  const numeric = Number(value);
  const floor = offset > 0 ? offset : modulus;
  const raw = Math.max(floor, Number.isFinite(numeric) ? Math.round(numeric) : floor);
  return raw + ((((offset - (raw % modulus)) % modulus) + modulus) % modulus);
}

// The largest lattice point that does NOT exceed `value`. A CAP has to snap
// down: normalizedGridFrameCount snaps up, so quoting it as a limit would name
// a length up to modulus-1 frames past the one that fits.
function gridFrameCountAtMost(workflow, value) {
  const snappedUp = normalizedGridFrameCount(workflow, value);
  if (snappedUp === undefined) return Math.max(1, Math.floor(Number(value) || 0));
  if (snappedUp <= value) return snappedUp;
  const modulus = Math.round(Number(workflow.frame_grid.modulus));
  return Math.max(snappedUp - modulus, normalizedGridFrameCount(workflow, 1));
}

// Chained runs snap to the NEAREST lattice point instead of up: the sampled
// count already carries the +context_length head that gets trimmed off, so
// snapping up would hand back clips up to modulus-1 frames longer than asked
// while nearest stays within half a step of the requested duration.
function nearestGridFrameCount(workflow, value) {
  const snappedUp = normalizedGridFrameCount(workflow, value);
  if (snappedUp === undefined) return undefined;
  const modulus = Math.round(Number(workflow.frame_grid.modulus));
  const offset = ((Math.round(Number(workflow.frame_grid.offset ?? 1)) % modulus) + modulus) % modulus;
  const floor = offset > 0 ? offset : modulus;
  const snappedDown = snappedUp - modulus;
  const numeric = Math.round(Number(value) || 0);
  if (snappedDown < floor) return snappedUp;
  return (numeric - snappedDown) < (snappedUp - numeric) ? snappedDown : snappedUp;
}

function videoFrameCount(args, settings, defaults = {}) {
  const direct = args.frames ?? args.params?.frames ?? settings.frames ?? defaults.frames;
  if (direct !== undefined && direct !== null && direct !== '') {
    return Math.max(normalizedLtxFrameCount(direct), Number(settings.minimumFrames) || 9);
  }
  const duration = Number(args.duration_seconds ?? args.params?.duration_seconds ?? settings.duration_seconds ?? defaults.duration_seconds);
  const frameRate = Number(args.frame_rate ?? args.params?.frame_rate ?? settings.frame_rate ?? settings.frameRate ?? defaults.frame_rate ?? 24);
  if (Number.isFinite(duration) && duration > 0 && Number.isFinite(frameRate) && frameRate > 0) {
    return Math.max(
      normalizedLtxFrameCount(Math.round(duration * frameRate) + 1),
      Number(settings.minimumFrames) || 9,
    );
  }
  return Math.max(normalizedLtxFrameCount(defaults.frames ?? 233), Number(settings.minimumFrames) || 9);
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
    const defaultStrength = Number(settings.defaultImageStrength ?? 1);
    ordered.push({
      image_path: settings.imageName,
      frame: 0,
      strength: Math.max(0, Math.min(1, Number.isFinite(defaultStrength) ? defaultStrength : 1)),
      role: 'start',
    });
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

function mergePromptGraphFragment(promptGraph, fragment, outputRef) {
  const nextId = nextPromptNodeId(promptGraph);
  const idMap = new Map(Object.keys(fragment).map((nodeId) => [String(nodeId), nextId()]));
  const remap = (value) => {
    if (Array.isArray(value)) {
      if (value.length === 2 && idMap.has(String(value[0])) && Number.isFinite(Number(value[1]))) {
        return [idMap.get(String(value[0])), Number(value[1])];
      }
      return value.map(remap);
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
    }
    return value;
  };
  for (const [sourceId, node] of Object.entries(fragment)) {
    promptGraph[idMap.get(String(sourceId))] = remap(cloneJson(node));
  }
  return remap(outputRef);
}

function normalizeWorkflowLoras(args, workflow) {
  const raw = args.loras ?? args.params?.loras;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('loras must be an array');
  if (raw.length > 20) throw new Error('video generation supports at most 20 LoRAs');
  if (raw.length && !workflow.supports_loras) throw new Error(`workflow ${workflow.id} does not support add-on LoRAs`);
  const byId = new Map();
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new Error('each LoRA must include an id and optional strength');
    const id = String(item.id || item.name || '').trim().replaceAll('\\', '/');
    if (!id || id.includes('\0') || id.startsWith('/') || /^[A-Za-z]:\//.test(id) || id.split('/').includes('..')) {
      throw new Error(`invalid LoRA id: ${id || '(missing)'}`);
    }
    const strength = Number(item.strength ?? 1);
    if (!Number.isFinite(strength) || strength < -10 || strength > 10) {
      throw new Error(`LoRA strength for ${id} must be between -10 and 10`);
    }
    byId.set(id, { id, strength });
  }
  return [...byId.values()];
}

function injectWorkflowLoras(promptGraph, loras, injection) {
  if (!loras.length) return;
  if (!injection || typeof injection !== 'object') throw new Error('workflow is missing its LoRA graph injection contract');
  const targets = Array.isArray(injection.targets) ? injection.targets : [];
  if (!targets.length) throw new Error('workflow LoRA graph injection contract has no targets');
  const targetInputs = targets.map((target) => {
    const node = promptGraph[String(target.node)];
    const input = String(target.input || 'model');
    if (!node?.inputs || !Array.isArray(node.inputs[input])) {
      throw new Error(`workflow LoRA target ${target.node}.${input} is unavailable`);
    }
    return { node, input, source: node.inputs[input] };
  });
  const sourceKey = JSON.stringify(targetInputs[0].source);
  if (targetInputs.some((target) => JSON.stringify(target.source) !== sourceKey)) {
    throw new Error('workflow LoRA targets do not share a model source');
  }
  const nextId = nextPromptNodeId(promptGraph);
  let source = targetInputs[0].source;
  for (const lora of loras) {
    const nodeId = nextId();
    promptGraph[nodeId] = {
      class_type: String(injection.class_type || 'LoraLoaderModelOnly'),
      inputs: {
        model: source,
        ...(injection.static_inputs && typeof injection.static_inputs === 'object' ? injection.static_inputs : {}),
        [String(injection.name_input || 'lora_name')]: lora.id,
        [String(injection.strength_input || 'strength_model')]: lora.strength,
      },
    };
    source = [nodeId, Number(injection.output_index || 0)];
  }
  for (const target of targetInputs) target.node.inputs[target.input] = source;
}

function mergeNativeWorkflowLoras(nativeLoras, selectedLoras) {
  const merged = new Map();
  for (const item of Array.isArray(nativeLoras) ? nativeLoras : []) {
    const name = String(item?.name || item?.id || '').trim();
    if (name) merged.set(name.replaceAll('\\', '/'), item);
  }
  for (const item of selectedLoras) merged.set(item.id, { name: item.id, strength: item.strength });
  return [...merged.values()];
}

function promptNodesByClass(promptGraph, classType) {
  return Object.entries(promptGraph).filter(([, node]) => node?.class_type === classType);
}

function compileLtxImageAnchors(promptGraph, keyframes) {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return;
  // LTX anchors only. A graph with none of the LTX conditioning nodes has
  // nothing to attach them to, and this used to strand a spare LoadImage in it
  // — H3 declares end_image_* for its own last_frame input, which is enough to
  // produce keyframes here, and the orphan node then failed validation.
  const anchorHosts = ['LTXVImgToVideoInplaceKJ', 'LTXVAddGuide', 'LTXVImgToVideoConditionOnly'];
  if (!anchorHosts.some((cls) => promptNodesByClass(promptGraph, cls).length)) return;
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

function compileLtxIcTimelineAnchors(promptGraph, keyframes) {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return;
  const icGuide = promptNodesByClass(promptGraph, 'LTXAddVideoICLoRAGuide')[0];
  if (!icGuide) throw new Error('Ingredients workflow is missing its IC-LoRA guide node');
  const [, icGuideNode] = icGuide;
  const vae = icGuideNode.inputs?.vae;
  if (!Array.isArray(vae)) throw new Error('Ingredients IC-LoRA guide is missing its VAE input');
  const sourceLatent = icGuideNode.inputs?.latent;
  if (!Array.isArray(sourceLatent)) throw new Error('Ingredients IC-LoRA guide is missing its source latent');

  const nextId = nextPromptNodeId(promptGraph);
  const imageRefs = keyframes.map((anchor) => {
    if (Array.isArray(anchor.image_ref)) return anchor.image_ref;
    const nodeId = nextId();
    promptGraph[nodeId] = { class_type: 'LoadImage', inputs: { image: anchor.image_path } };
    return [nodeId, 0];
  });

  // Match Lightricks' official workflow: image conditioning modifies the clean
  // target latent first, then the IC guide appends reference-sheet tokens.
  // Applying an image node after the IC guide treats reference tokens as target
  // pixels and can leak the sheet into the rendered frame.
  const anchorNodeId = nextId();
  if (keyframes.length === 1 && keyframes[0].frame === 0) {
    promptGraph[anchorNodeId] = {
      class_type: 'LTXVImgToVideoConditionOnly',
      inputs: {
        vae,
        image: imageRefs[0],
        latent: sourceLatent,
        strength: keyframes[0].strength,
        bypass: false,
      },
    };
  } else {
    promptGraph[anchorNodeId] = {
      class_type: 'LTXVImgToVideoInplaceKJ',
      inputs: {
        vae,
        latent: sourceLatent,
        num_images: String(keyframes.length),
        ...Object.fromEntries(keyframes.flatMap((anchor, index) => {
          const slot = index + 1;
          return [
            [`num_images.image_${slot}`, imageRefs[index]],
            [`num_images.index_${slot}`, anchor.frame],
            [`num_images.strength_${slot}`, anchor.strength],
          ];
        })),
      },
    };
  }
  icGuideNode.inputs.latent = [anchorNodeId, 0];
}

function configureLtxIcReferenceFrames(promptGraph, outputFrames, minimumFrames = 121) {
  const referenceFrames = Math.max(
    1,
    Math.round(Number(outputFrames) || 1),
    Math.round(Number(minimumFrames) || 121),
  );
  let configured = false;
  for (const [, guide] of promptNodesByClass(promptGraph, 'LTXAddVideoICLoRAGuide')) {
    const imageRef = guide.inputs?.image;
    if (!Array.isArray(imageRef)) continue;
    const repeat = promptGraph[String(imageRef[0])];
    if (repeat?.class_type !== 'RepeatImageBatch') continue;
    repeat.inputs = { ...(repeat.inputs || {}), amount: referenceFrames };
    configured = true;
  }
  if (!configured) throw new Error('Ingredients workflow is missing its reference-sheet repeat node');
  return referenceFrames;
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

// Scene chaining for MiniMax H3 (NikoDemon80/ComfyUI-H3-Motion-Context): pin
// the tail of a previous clip at the head of this render so motion AND room
// tone continue across the cut. The context node sits between the H3
// conditioning source and the guider; its trim_frames output drives a
// post-decode trim that removes the re-rendered context head, so the delivered
// clip starts where the previous one ended.
const H3_MOTION_CONTEXT_FRAMES = 22;

function compileH3MotionContextChain(promptGraph, settings) {
  const source = promptNodesByClass(promptGraph, 'MiniMaxH3ImageToVideo')[0]
    || promptNodesByClass(promptGraph, 'MiniMaxH3ReferenceToVideo')[0];
  const videoDecode = promptNodesByClass(promptGraph, 'VAEDecode')[0];
  const audioDecode = promptNodesByClass(promptGraph, 'VAEDecodeAudio')[0];
  const createVideo = promptNodesByClass(promptGraph, 'CreateVideo')[0];
  if (!source || !videoDecode || !createVideo) {
    throw new Error('selected workflow does not expose the MiniMax H3 conditioning, decode, and mux nodes required for scene chaining');
  }
  const [sourceId, sourceNode] = source;
  const sampler = promptNodesByClass(promptGraph, 'SamplerCustomAdvanced')[0];
  const latentRef = Array.isArray(sampler?.[1]?.inputs?.latent_image)
    ? sampler[1].inputs.latent_image
    : [sourceId, 1];
  const hasAudio = Boolean(audioDecode) && settings.motionContextHasAudio !== false;
  // Spectrum forecasts transformer steps from history; on a chained graph it
  // mispredicts the pinned context rows (upstream keeps it off in every
  // chained example), so chaining overrides even an explicit spectrum=true.
  for (const [, node] of promptNodesByClass(promptGraph, 'SpectrumApplyMiniMaxH3')) {
    node.inputs.enabled = false;
  }
  settings.spectrum = false;
  const nextId = nextPromptNodeId(promptGraph);
  const loadId = nextId();
  const componentsId = nextId();
  const contextId = nextId();
  const trimId = nextId();
  promptGraph[loadId] = {
    class_type: 'LoadVideo',
    inputs: { file: settings.motionContextName },
  };
  promptGraph[componentsId] = {
    class_type: 'GetVideoComponents',
    inputs: { video: [loadId, 0] },
  };
  promptGraph[contextId] = {
    class_type: 'MiniMaxH3MotionContext',
    inputs: {
      conditioning: [sourceId, 0],
      vae: sourceNode.inputs.vae,
      latent: latentRef,
      context_length: String(H3_MOTION_CONTEXT_FRAMES),
      // The successor clip literally hears its predecessor's tail. Without
      // the audio wires every join restarts the room tone from silence.
      audio_context_length: hasAudio ? H3_MOTION_CONTEXT_FRAMES : 0,
      context_frames: [componentsId, 0],
      ...(hasAudio ? {
        context_audio: [componentsId, 1],
        audio_vae: audioDecode[1].inputs.vae,
      } : {}),
    },
  };
  // Repoint every consumer of the source conditioning (the guider) at the
  // context node — except the context node itself, which reads the original.
  for (const [nodeId, node] of Object.entries(promptGraph)) {
    if (nodeId === contextId || !node?.inputs) continue;
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && String(value[0]) === String(sourceId) && Number(value[1]) === 0) {
        node.inputs[key] = [contextId, 0];
      }
    }
  }
  const fps = Number(createVideo[1].inputs?.fps);
  promptGraph[trimId] = {
    class_type: 'MiniMaxH3MotionContextTrim',
    inputs: {
      images: [videoDecode[0], 0],
      trim_frames: [contextId, 1],
      ...(audioDecode ? { audio: [audioDecode[0], 0] } : {}),
      fps: Number.isFinite(fps) && fps > 0 ? fps : 24,
      // H3 rounds its audio grid up ~8ms past the picture per clip; matching
      // the tail keeps that error from stacking across a chain.
      match_tail: true,
    },
  };
  createVideo[1].inputs.images = [trimId, 0];
  if (audioDecode) createVideo[1].inputs.audio = [trimId, 1];
}

function editorNode(workflow, id) {
  return (workflow?.nodes || []).find((node) => String(node?.id) === String(id));
}

// MiniMax H3 "Fast high-res": one sampling schedule, two canvases.
//
// H3's cost is rows x steps, and rows grow with the CANVAS AREA — so a render
// that spends every step at the delivered size pays full price for the early
// steps, which only decide composition and motion. This lane samples those on a
// small canvas, lifts the result to full size, and spends only the last few
// sigmas there. The total step count does not change; the steps just move to a
// canvas with a fraction of the rows.
//
// What makes it work on H3 rather than being an ordinary hires fix is a trained
// upscaler for H3's OWN 24-channel latent (Comfyui_Minimax_h3_latent_Upscaler,
// pinned in packages/gpu-rentals): the first pass's x0 estimate is enlarged in
// latent space, so the 5B-param VAE never decodes and re-encodes a video
// between the passes — which on a 5s clip costs more than the steps saved.
//
// The sound crosses untouched. H3 denoises a JOINT video+audio latent and the
// upscaler only understands the video half, so the pair is split before the
// upscale and rejoined after it, the audio latent passing through at its own
// size. Skipping that split feeds a nested tensor to a Conv3d and the job dies
// in the node rather than in validation.
//
// Returns the plan actually compiled, or null when the graph was left alone.
function compileH3FastHighRes(promptGraph, workflow, settings) {
  const cfg = workflow.fast_high_res && typeof workflow.fast_high_res === 'object'
    ? workflow.fast_high_res
    : {};
  const targetWidth = Math.round(Number(settings.width));
  const targetHeight = Math.round(Number(settings.height));
  const totalSteps = Math.round(Number(settings.steps));
  if (!(targetWidth > 0) || !(targetHeight > 0) || !(totalSteps > 0)) return null;

  const align = Math.max(8, Math.round(Number(cfg.align) || 32));
  const refineSteps = Math.max(1, Math.round(Number(cfg.refine_steps) || 3));
  const splitStep = totalSteps - refineSteps;
  // The first pass has to be a pass: at or below the refine count there is
  // nothing left to sample small, and SplitSigmas would hand it an empty
  // schedule.
  if (splitStep < 1) return null;

  // Same target-size arithmetic the node itself does, so the factor we record
  // is the factor it computes: area in megapixels at the requested aspect,
  // then both edges snapped to `align` (32 — the node's own recommendation,
  // because a looser grid leaves a light band along the bottom edge).
  const aspect = targetWidth / targetHeight;
  const firstPassPixels = (Number(cfg.first_pass_megapixels) || 0.2) * 1024 * 1024;
  const firstHeight = Math.max(align, Math.round(Math.sqrt(firstPassPixels / aspect) / align) * align);
  const firstWidth = Math.max(align, Math.round((Math.sqrt(firstPassPixels / aspect) * aspect) / align) * align);
  const factor = ((targetWidth / firstWidth) + (targetHeight / firstHeight)) / 2;
  // Two passes cost a second conditioning encode, a second sampler warmup and
  // the upscaler's own forward. Under a small target that overhead is the
  // whole saving, and at factor <= 1 the node refuses outright ("only supports
  // upscaling"), so the single-pass graph ships unchanged.
  if (!(factor >= (Number(cfg.min_upscale_factor) || 1.3))) return null;

  const conditioning = promptNodesByClass(promptGraph, 'MiniMaxH3ImageToVideo')[0];
  const samplers = promptNodesByClass(promptGraph, 'SamplerCustomAdvanced');
  if (!conditioning || samplers.length !== 1) return null;
  const [condId, condNode] = conditioning;
  const [samplerId, samplerNode] = samplers[0];
  const guiderRef = samplerNode.inputs?.guider;
  const sigmasRef = samplerNode.inputs?.sigmas;
  const latentRef = samplerNode.inputs?.latent_image;
  if (!Array.isArray(guiderRef) || !Array.isArray(sigmasRef) || !Array.isArray(latentRef)) return null;
  // The first pass must be sampling THIS conditioning node's latent; anything
  // else (a chained graph, a reference graph) is a topology this compiler has
  // not been measured against.
  if (String(latentRef[0]) !== String(condId)) return null;
  const guiderNode = promptGraph[String(guiderRef[0])];
  if (!guiderNode?.inputs?.model || !guiderNode?.inputs?.conditioning) return null;

  const nextId = nextPromptNodeId(promptGraph);
  const splitId = nextId();
  const fullCondId = nextId();
  const fullGuiderId = nextId();
  const separateId = nextId();
  const upscaleId = nextId();
  const rejoinId = nextId();
  const refineId = nextId();

  // Pass 1 renders small. Everything else about the conditioning — prompt,
  // anchor frames, length — is whatever the rest of the compiler already put
  // there, including a pruned first_frame on a text-to-video run.
  condNode.inputs.width = firstWidth;
  condNode.inputs.height = firstHeight;

  // One schedule, cut in two. Deriving the refine sigmas from the SAME
  // BasicScheduler rather than writing them out means the second pass re-noises
  // to exactly the level the first pass stopped at, at whatever step count and
  // shift the model is running — a hardcoded sigma list would only be right for
  // the one schedule it was copied from.
  promptGraph[splitId] = {
    class_type: 'SplitSigmas',
    _meta: { title: 'Fast high-res: split the schedule' },
    inputs: { sigmas: sigmasRef, step: splitStep },
  };
  samplerNode.inputs.sigmas = [splitId, 0];

  // The full-size conditioning. H3 bakes the canvas into its conditioning, so
  // the refine pass needs its own encode at the delivered size — reusing the
  // small one would ask the model to denoise rows it was not conditioned for.
  promptGraph[fullCondId] = {
    class_type: condNode.class_type,
    _meta: { title: 'Fast high-res: full-size conditioning' },
    inputs: { ...cloneJson(condNode.inputs), width: targetWidth, height: targetHeight },
  };
  promptGraph[fullGuiderId] = {
    class_type: guiderNode.class_type,
    _meta: { title: 'Fast high-res: refine guider' },
    inputs: { ...cloneJson(guiderNode.inputs), conditioning: [fullCondId, 0] },
  };

  // denoised_output (slot 1), not output (slot 0): the first pass stops at a
  // non-zero sigma, so its raw latent is still noisy. Slot 1 is the model's
  // clean-image estimate at that point, which is what an upscaler trained on
  // clean latents expects.
  promptGraph[separateId] = {
    class_type: 'LTXVSeparateAVLatent',
    _meta: { title: 'Fast high-res: split video from sound' },
    inputs: { av_latent: [samplerId, 1] },
  };
  promptGraph[upscaleId] = {
    class_type: 'MinimaxH3LatentUpscaler3D',
    _meta: { title: 'Fast high-res: neural latent upscale' },
    inputs: {
      latent: [separateId, 0],
      model_name: String(cfg.model_name || 'minimax_h3_latent_upscaler_3d_bf16.safetensors'),
      // `mode` is a DynamicCombo: the chosen key selects which nested inputs
      // exist, and those arrive under a `mode.` prefix.
      mode: 'target dimensions',
      'mode.width': targetWidth,
      'mode.height': targetHeight,
      align,
      device: 'cuda',
      precision: String(cfg.precision || 'bf16'),
    },
  };
  promptGraph[rejoinId] = {
    class_type: 'LTXVConcatAVLatent',
    _meta: { title: 'Fast high-res: rejoin sound' },
    inputs: { video_latent: [upscaleId, 0], audio_latent: [separateId, 1] },
  };
  promptGraph[refineId] = {
    class_type: samplerNode.class_type,
    _meta: { title: 'Fast high-res: full-size refine' },
    inputs: {
      ...cloneJson(samplerNode.inputs),
      guider: [fullGuiderId, 0],
      sigmas: [splitId, 1],
      latent_image: [rejoinId, 0],
    },
  };

  // Everything that read the finished clip now reads the refine pass. Only
  // slot 0 moves: the separate node deliberately holds slot 1 of the first
  // sampler, and the new nodes are skipped so the rewrite cannot eat its own
  // wiring.
  const added = new Set([splitId, fullCondId, fullGuiderId, separateId, upscaleId, rejoinId, refineId]);
  for (const [nodeId, node] of Object.entries(promptGraph)) {
    if (added.has(nodeId) || !node?.inputs) continue;
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && String(value[0]) === String(samplerId) && Number(value[1]) === 0) {
        node.inputs[key] = [refineId, 0];
      }
    }
  }

  return {
    first_pass: { width: firstWidth, height: firstHeight },
    output: { width: targetWidth, height: targetHeight },
    upscale_factor: Math.round(factor * 1000) / 1000,
    steps: { first_pass: splitStep, refine: refineSteps },
    // What the saving actually is, in units of a full-size step: the first
    // pass's steps cost their share of the rows, the refine steps cost all of
    // them. Reported so a caller can see the trade it made without a stopwatch.
    full_size_step_equivalents: Math.round(
      (splitStep * ((firstWidth * firstHeight) / (targetWidth * targetHeight)) + refineSteps) * 100,
    ) / 100,
  };
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
      ...(settings.denoise ? { denoise: settings.denoise } : {}),
      ...(settings.detailerStrength ? { detailer_strength: settings.detailerStrength } : {}),
    },
    keyframes: Array.isArray(settings.keyframes) ? settings.keyframes : [],
    ...(Array.isArray(settings.loras) && settings.loras.length ? { loras: settings.loras.map((item) => ({ name: item.id, strength: item.strength })) } : {}),
    // THIS is the live native spec. The other builder (updateLtxEditorWorkflow)
    // only runs when a per-variant Mobile.json exists on disk, and none do — so
    // anything added there is dead code. Head swap has to be emitted here.
    ...(settings.headSwap && settings.videoName && settings.imageName
      ? {
        pipeline: 'head-swap',
        head_swap: {
          source_video: settings.videoName,
          face_image: settings.imageName,
          region_px: settings.headSwapRegionPx,
          max_dimension: settings.headSwapMaxDimension,
          pipeline: settings.headSwapPipeline,
          lora_strength: settings.headSwapLoraStrength,
          backend: settings.headSwapBackend,
          face_enhancer: settings.headSwapFaceEnhancer,
          frames: settings.frames,
          frame_rate: settings.frameRate,
          seed: settings.seed,
        },
      }
      : {}),
    ...((settings.videoName && !settings.headSwap) ? { video: {
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
  // LTX 2.3 image is optional (requires.image is false): with no start frame,
  // generate text-to-video instead of forcing a default anchor. Only stage an
  // anchor when the caller actually supplies one — never fall back to defaults.image.
  // Head swap is the one job needing both media; every other video job treats an
  // attached clip as the sole input.
  const wantsHeadSwap = videoTaskFrom(args) === 'head-swap';
  const erosImageSource = (videoName && !wantsHeadSwap) ? null : await imageSourceFromArgs(args, {});
  const imageName = erosImageSource ? stageLtxErosImage(erosImageSource) : null;
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
    seed: resolveSeed(args.seed, defaults.seed),
    // Optional post-generation grain cleanup ('', 'light', 'strong'); the
    // gateway owns the filter itself, this only carries the choice through.
    denoise: normalizeLtxDenoiseMode(args.denoise ?? args.params?.denoise ?? defaults.denoise),
    // Optional IC-LoRA Detailer refinement pass; 0 = off, and off costs nothing.
    detailerStrength: normalizeLtxDetailerStrength(args.detailer_strength ?? args.params?.detailer_strength ?? defaults.detailer_strength),
    // BFS head swap: replace the face in the supplied video with the supplied
    // image. Needs both inputs; the meta builder enforces that.
    headSwap: videoTaskFrom(args) === 'head-swap',
    headSwapRegionPx: positiveInt(args.head_swap_region_px ?? args.params?.head_swap_region_px, 256, { min: 32, max: 2048 }),
    loras: normalizeWorkflowLoras(args, workflow),
  };
  settings.keyframes = videoName ? [] : await normalizeVideoKeyframes(args, settings, defaults);
  const apiWorkflow = loadJsonFile(ltxErosApiWorkflowPath, 'LTX Eros API workflow');
  const promptGraph = cloneJson(apiWorkflow.prompt || apiWorkflow);
  setApiInput(promptGraph, 597, 'filename_prefix', spec.marker);
  setApiInput(promptGraph, 597, 'frame_rate', ['826', 0]);
  // Always write node 773's LoadImage value: the staged anchor for image-to-video,
  // or '' to clear the workflow's baked-in default (codex_ltx23_user_ref.png) so a
  // text-to-video request isn't detected as anchored on a non-existent image.
  setApiInput(promptGraph, 773, 'image', settings.imageName || '');
  setApiInput(promptGraph, 824, 'value', settings.prompt);
  setApiInput(promptGraph, 809, 'value', settings.width);
  setApiInput(promptGraph, 811, 'value', settings.height);
  setApiInput(promptGraph, 542, 'value', settings.frameRate);
  setApiInput(promptGraph, 812, 'noise_seed', settings.seed);
  if (videoName) compileLtxVideoExtension(promptGraph, settings);
  else compileLtxImageAnchors(promptGraph, settings.keyframes);
  injectWorkflowLoras(promptGraph, settings.loras, workflow.lora_injection);

  const mobileWorkflowPath = join(ltxErosMobileWorkflowDir, spec.mobileWorkflow);
  // The mobile workflow is ComfyUI editor metadata (extra_pnginfo.workflow), not
  // what actually executes — generation runs body.prompt (the API graph above).
  // Its only functional contribution is extra.nativeMlxLtx, which drives native
  // MLX routing on the gateway and is synthesized fresh from spec+settings by
  // updateLtxErosEditorWorkflow. So when the per-variant Mobile.json isn't
  // installed, fall back to a minimal base object instead of throwing and failing
  // the whole generation (the editor graph is just less richly annotated).
  const mobileWorkflowBase = existsSync(mobileWorkflowPath)
    ? loadJsonFile(mobileWorkflowPath, 'LTX Eros Mobile workflow')
    : { nodes: [], extra: {} };
  const mobileWorkflow = updateLtxErosEditorWorkflow(mobileWorkflowBase, spec, settings);
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
          ...(args.studio_lane ? { studioLane: args.studio_lane } : {}),
        },
      },
    },
  };
}

// The reference_* arguments a call actually carries. An empty list is the
// same as leaving the argument out.
const REFERENCE_ARGUMENT_KEYS = ['reference_images', 'reference_videos', 'reference_audios'];
function suppliedReferenceArguments(args = {}) {
  return REFERENCE_ARGUMENT_KEYS.filter((key) => Array.isArray(args[key]) && args[key].length);
}

function workflowTakesReferences(workflow) {
  return ['reference_image_slots', 'reference_video_slots', 'reference_audio_slots']
    .some((key) => Array.isArray(workflow?.[key]) && workflow[key].length);
}

// The reference-mode sibling of a workflow: the first workflow of the same
// media type and family with reference slots wired. This is the server-side
// twin of the studio's referenceWorkflowForHivemindModel — same family, first
// in catalog order — so an agent calling the MCP and a user in the composer
// land on the same graph. minimax-h3-reference inherits minimax-h3 (same
// family, same lane, same weights) and is routing_only: it is only ever
// reached this way, never picked.
function referenceSiblingWorkflow(workflow, registry) {
  const family = String(workflow?.family || '').trim().toLowerCase();
  if (!family) return null;
  return Object.values(registry).find((entry) => entry.id !== workflow.id
    && entry.media_type === workflow.media_type
    && String(entry.family || '').trim().toLowerCase() === family
    && workflowTakesReferences(entry)) || null;
}

// reference_* on a workflow with no reference slots used to be dropped on the
// floor: every staging pass below is gated on the workflow's slots, so a
// minimax-h3 call with reference_images rendered plain text-to-video with no
// error and no hint (2026-08-21, rented lane — ComfyUI served the reference
// node from cache on a reseeded resubmission, proving no loader was in its
// ancestry, and several probes were read against the wrong graph). Such a call
// now goes where the studio would have sent it, or is refused by name.
function routeReferenceArguments(workflow, args, registry) {
  const supplied = suppliedReferenceArguments(args);
  if (!supplied.length || workflowTakesReferences(workflow)) return { workflow, routed: null };
  const sibling = referenceSiblingWorkflow(workflow, registry);
  if (sibling) return { workflow: sibling, routed: { from: workflow.id, for: supplied } };
  const error = new Error(
    `workflow ${workflow.id} takes no ${supplied.join(' / ')}: it has no reference slots, and no workflow `
    + `in its family (${workflow.family || 'none'}) has them either, so the references would be dropped on `
    + 'the floor. Send them to a workflow that lists reference_slots in media_list_workflows, or drop the argument.',
  );
  // Survives machine-private redaction: it names a workflow and an argument,
  // never the prompt or the media.
  error.machineSafe = true;
  throw error;
}

async function buildVideoPromptBody(args = {}) {
  const workflowId = normalizeWorkflowId(args.workflow_id || args.workflow, { mediaType: 'video' });
  const registry = videoWorkflowRegistry();
  const { workflow, routed } = routeReferenceArguments(registry[workflowId], args, registry);
  let built;
  if (workflow.builder === 'ltx-eros') {
    built = await buildLtxErosPromptBody(args, workflow);
  } else if (workflow.builder === 'comfy-api') {
    built = await buildComfyApiPromptBody(args, workflow);
  } else {
    throw new Error(`unsupported video workflow builder: ${workflow.builder}`);
  }
  if (routed) {
    // workflow.id is the graph that actually ran; say where the call came
    // from, and which arguments sent it there, so a routed run is never
    // mistaken for a direct one.
    built.workflow = { ...built.workflow, routed_from: routed.from, routed_for: routed.for };
  }
  return built;
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

function ltxTargetDescription(prompt) {
  const text = String(prompt || '').trim();
  const marker = '### Target Description';
  const index = text.lastIndexOf(marker);
  return index >= 0 ? text.slice(index + marker.length).trim() : text;
}

function assertWorkflowAspectRatio(workflow, width, height) {
  const allowed = Array.isArray(workflow.aspect_ratios) ? workflow.aspect_ratios : [];
  if (!allowed.length || !Number.isFinite(width) || !Number.isFinite(height) || height <= 0) return;
  const actual = width / height;
  const matches = allowed.some((value) => {
    const match = String(value).trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) return false;
    const expected = Number(match[1]) / Number(match[2]);
    return Math.abs(actual - expected) / expected <= 0.05;
  });
  if (!matches) {
    throw new Error(
      `workflow ${workflow.id} supports ${allowed.join(', ')} output; received ${width}x${height}`,
    );
  }
}

async function buildComfyApiPromptBody(args = {}, workflow) {
  const apiWorkflowPath = resolveWorkflowFile(workflow.api_workflow || workflow.workflow || workflow.apiWorkflow);
  const apiWorkflow = loadJsonFile(apiWorkflowPath, `${workflow.id} API workflow`);
  const promptGraph = cloneJson(apiWorkflow.prompt || apiWorkflow);
  applyApiInputOverrides(promptGraph, workflow.workflow_overrides?.api_inputs);
  const defaults = workflowDefaults(workflow.id);
  const slots = workflow.slots || {};
  const settings = { loras: normalizeWorkflowLoras(args, workflow) };
  const targetWidth = positiveInt(argOrDefault(args, defaults, 'width'), defaults.width, { min: 64, max: 4096 });
  const targetHeight = positiveInt(argOrDefault(args, defaults, 'height'), defaults.height, { min: 64, max: 4096 });
  assertWorkflowAspectRatio(workflow, targetWidth, targetHeight);
  // Refuse an impossible clip BEFORE a single byte is staged. The authoritative
  // check further down runs against the built graph — but by then every
  // reference picture and motion clip has been fetched, decoded, re-encoded to
  // 24 fps and written into the lane's input directory. That is twenty-odd
  // seconds of work for a run that was never going to start, and the user
  // watches a progress bar for all of it.
  //
  // Nothing the check needs is unknown this early: the canvas, the requested
  // length and whether a motion clip is attached all arrive with the request.
  // Motion-context chaining is the one path that rewrites the canvas later, so
  // it is left to the authoritative check rather than guessed at here.
  assertReferenceSlotsExist(workflow, args);
  const suppliedReferenceVideos = Array.isArray(args.reference_videos)
    ? args.reference_videos.filter(Boolean)
    : [];
  const chainsFromMotionContext = args.motion_context_path !== undefined
    || args.motion_context_base64 !== undefined
    || args.motion_context_url !== undefined;
  if (suppliedReferenceVideos.length && !chainsFromMotionContext) {
    const preflightFrameRate = Number(args.frame_rate ?? defaults.frame_rate ?? 24) || 24;
    const preflightDuration = positiveFloat(
      args.duration_seconds ?? args.params?.duration_seconds,
      defaults.duration_seconds || 4,
      { min: 1 / 24, max: 30 },
    );
    const explicitPreflightFrames = args.frames ?? args.params?.frames;
    const preflightFrames = explicitPreflightFrames !== undefined
      ? positiveInt(explicitPreflightFrames, 0, { min: 1, max: 100000 })
      : normalizedGridFrameCount(workflow, Math.round(preflightDuration * preflightFrameRate));
    // Only caller-sent hints are available this early — probing the sources
    // would mean fetching and decoding them, which is the work this pre-flight
    // exists to skip. An un-hinted clip is priced as the longest the lane will
    // stage, at the node's largest reference canvas, so the pre-flight can only
    // over-count; the authoritative check below re-runs against the real
    // staged files, with their true dimensions and lengths.
    assertMotionReferenceFitsTheCard(workflow, {
      width: targetWidth,
      height: targetHeight,
      frames: preflightFrames,
      frameRate: preflightFrameRate,
      referenceVideos: suppliedReferenceVideos.map((entry) => ({
        seconds: Number(entry?.duration_seconds) > 0 ? Number(entry.duration_seconds) : undefined,
        useAudio: entry?.use_audio === true,
        compact: entry?.canvas === 'compact',
      })),
      referenceImageCount: Array.isArray(args.reference_images) ? args.reference_images.filter(Boolean).length : 0,
      referenceAudioCount: Array.isArray(args.reference_audios) ? args.reference_audios.filter(Boolean).length : 0,
    });
  }
  const ingredientSheet = await ingredientSheetFromArgs(args, workflow, {
    width: targetWidth,
    height: targetHeight,
  });
  const promptArgs = ingredientSheet && !String(args.reference_description || '').trim()
    ? { ...args, reference_description: ingredientSheet.referenceDescription }
    : args;

  const promptText = contractedVideoPrompt(promptArgs, defaults, workflow);
  if (promptText !== undefined) {
    settings.prompt = String(promptText);
    setMappedApiInput(promptGraph, slots.prompt, settings.prompt);
  }
  const negativePrompt = argOrDefault(args, defaults, 'negative_prompt');
  if (negativePrompt !== undefined) {
    settings.negative_prompt = String(negativePrompt);
    setMappedApiInput(promptGraph, slots.negative_prompt, settings.negative_prompt);
  }
  // NAG strength for the native distilled lanes. Omitted means "runner default";
  // an explicit value <= 1 disables guidance for this request.
  const nagScale = args.nag_scale ?? args.params?.nag_scale;
  if (nagScale !== undefined && Number.isFinite(Number(nagScale))) {
    settings.nagScale = Number(nagScale);
  }

  const rawVideo = await videoSourceFromArgs(args);
  if (rawVideo && !(workflow.accepts || []).some((field) => String(field).startsWith('video_'))) {
    throw new Error(`workflow ${workflow.id} does not declare video input support`);
  }
  if (rawVideo) {
    settings.videoName = stageLtxVideo(rawVideo);
    settings.headSwap = videoTaskFrom(args) === 'head-swap';
    settings.videoMode = String(args.video_mode ?? args.params?.video_mode ?? 'extend').trim().toLowerCase();
    if (!settings.headSwap && settings.videoMode !== 'extend') throw new Error('video_mode must be extend');
    settings.sourceHasAudio = stagedVideoHasAudio(settings.videoName);
    settings.audioMode = settings.sourceHasAudio ? 'extend' : 'generate';
    if (settings.headSwap) {
      // Stage the face here rather than in the graph-slot pass below: that pass
      // only runs when the workflow declares an image_path slot, and head swap
      // does not use the Comfy graph at all — it needs the filename on the
      // native spec. Without this settings.imageName stayed empty, the native
      // builder emitted no defaults.image, the gateway could not find a face and
      // fell back to the Comfy graph, which failed validation.
      const faceSource = await imageSourceFromArgs(args, {});
      if (!faceSource) throw new Error('head swap requires a face image');
      settings.imageName = stageLtxErosImage(faceSource);
      settings.headSwapRegionPx = positiveInt(
        args.head_swap_region_px ?? args.params?.head_swap_region_px, 256, { min: 32, max: 2048 },
      );
      // The render is sized from the source clip, so these are the only levers
      // on how long a head swap takes.
      settings.headSwapMaxDimension = positiveInt(
        args.head_swap_max_dimension ?? args.params?.head_swap_max_dimension, 0, { min: 0, max: 4096 },
      );
      settings.headSwapPipeline = String(
        args.head_swap_pipeline ?? args.params?.head_swap_pipeline ?? 'single-stage',
      ).trim().toLowerCase() === 'fast' ? 'fast' : 'single-stage';
      // The author's identity knob. The BFS adapter itself is supplied by the
      // task server-side, so this is the only part of it the caller sets.
      const rawLoraStrength = Number(args.head_swap_lora_strength ?? args.params?.head_swap_lora_strength);
      settings.headSwapLoraStrength = Number.isFinite(rawLoraStrength)
        ? Math.min(2, Math.max(0.1, rawLoraStrength))
        : 1.0;
      // Which engine performs the swap. They are different tools, not tiers:
      // bfs regenerates the frame, facefusion swaps onto the original.
      settings.headSwapBackend = String(
        args.head_swap_backend ?? args.params?.head_swap_backend ?? 'bfs',
      ).trim().toLowerCase() === 'facefusion' ? 'facefusion' : 'bfs';
      settings.headSwapFaceEnhancer = Boolean(args.head_swap_face_enhancer ?? args.params?.head_swap_face_enhancer);
    }
  }

  const rawMotionContext = await motionContextSourceFromArgs(args);
  if (rawMotionContext && !(workflow.accepts || []).some((field) => String(field).startsWith('motion_context_'))) {
    throw new Error(`workflow ${workflow.id} does not support motion-context scene chaining`);
  }
  if (rawMotionContext && settings.videoName) {
    throw new Error('motion_context_* cannot be combined with video_* — the context clip seeds a NEW shot, it is not footage to extend');
  }
  if (rawMotionContext) {
    settings.motionContextName = stageLtxVideo(rawMotionContext);
    settings.motionContextHasAudio = stagedVideoHasAudio(settings.motionContextName);
    // A latent cannot be resized, so a chained clip must render on the context
    // clip's exact canvas no matter which aspect tier the caller sent.
    const contextDims = stagedVideoDimensions(settings.motionContextName);
    if (contextDims) settings.motionContextDimensions = contextDims;
  }

  let timelineImageName;
  if (!settings.videoName && ingredientSheet) {
    const timelineImage = await imageSourceFromArgs(args, {});
    if (timelineImage) timelineImageName = stageLtxErosImage(timelineImage);
  }
  // Image optional (requires.image is false unless declared): only an actual
  // ingredient sheet or a caller-supplied start frame becomes the anchor — no
  // default.image fallback, so a prompt-only request stays text-to-video.
  const rawImage = (settings.videoName && !settings.headSwap)
    ? undefined
    : (ingredientSheet?.imageName || await imageSourceFromArgs(args, {}));
  if ((!settings.videoName || settings.headSwap) && slots.image_path) {
    if (rawImage !== undefined) {
      settings.imageName = stageLtxErosImage(rawImage);
      setMappedApiInput(promptGraph, slots.image_path, settings.imageName);
    } else {
      // No anchor supplied → clear the workflow's baked-in default LoadImage value
      // (setMappedApiInput skips empty writes, so use setApiInput directly) so a
      // prompt-only request stays text-to-video instead of anchoring on a missing image.
      const imageSlot = normalizeSlot(slots.image_path);
      if (imageSlot && workflow.image_clear === 'prune') {
        // Real Comfy lanes validate LoadImage filenames at submit, so an empty
        // value is rejected there (only the native-MLX intercept tolerates it).
        // Drop the loader and every link to it; the downstream input must be
        // optional (e.g. MiniMaxH3ImageToVideo.first_frame).
        pruneApiNode(promptGraph, imageSlot.node);
      } else if (imageSlot) {
        setApiInput(promptGraph, imageSlot.node, imageSlot.input, '');
      }
    }
  }
  // End frame. The H3 checkpoint we ship is the fl2va (first-AND-last) build
  // and MiniMaxH3ImageToVideo takes an optional last_frame, so supplying one
  // turns a T2VA/I2VA run into FL2VA (or L2VA with no start frame). Pruned the
  // same way as the start frame when absent: a real Comfy lane rejects an
  // empty LoadImage filename at submit.
  if (slots.end_image_path) {
    const rawEnd = await imageSourceFromPrefixedArgs(args, 'end');
    if (rawEnd !== undefined) {
      settings.endImageName = stageLtxErosImage(rawEnd);
      setMappedApiInput(promptGraph, slots.end_image_path, settings.endImageName);
    } else {
      const endSlot = normalizeSlot(slots.end_image_path);
      if (endSlot && workflow.image_clear === 'prune') {
        pruneApiNode(promptGraph, endSlot.node);
      } else if (endSlot) {
        setApiInput(promptGraph, endSlot.node, endSlot.input, '');
      }
    }
  }
  // Reference mode: N discrete pictures, each into its own loader. Order is
  // load-bearing — the prompt names them <Picture 1>..<Picture N> by the same
  // index — and every unfilled slot is pruned, which drops its autogrow
  // ref_images.ref_image_N key along with the node.
  if (Array.isArray(workflow.reference_image_slots) && workflow.reference_image_slots.length) {
    const supplied = Array.isArray(args.reference_images) ? args.reference_images : [];
    if (supplied.length > workflow.reference_image_slots.length) {
      throw new Error(
        `workflow ${workflow.id} accepts at most ${workflow.reference_image_slots.length} reference images`,
      );
    }
    const staged = [];
    for (const [index, slot] of workflow.reference_image_slots.entries()) {
      const entry = supplied[index];
      const source = entry ? await imageSourceFromArgs(entry, {}) : undefined;
      if (source !== undefined) {
        staged.push(stageLtxErosImage(source));
        setMappedApiInput(promptGraph, slot, staged[staged.length - 1]);
        continue;
      }
      pruneApiNode(promptGraph, normalizeSlot(slot)?.node);
    }
    if (staged.length) settings.referenceImageNames = staged;
  }
  // Reference videos: MOTION references. Each is its own LoadVideo ->
  // GetVideoComponents pair, whose frames become ref_video_N and whose
  // soundtrack becomes the same-numbered ref_video_audio_N. Pruning an unfilled
  // slot cascades through the components node, so both autogrow keys go with it.
  // A caller who does not want the source clip's audio conditioned in keeps the
  // node but drops the audio link — that is also what stops a silent download
  // from spending an <Audio N> label on nothing.
  if (Array.isArray(workflow.reference_video_slots) && workflow.reference_video_slots.length) {
    const supplied = Array.isArray(args.reference_videos) ? args.reference_videos : [];
    if (supplied.length > workflow.reference_video_slots.length) {
      throw new Error(
        `workflow ${workflow.id} accepts at most ${workflow.reference_video_slots.length} reference videos`,
      );
    }
    const stagedVideos = [];
    for (const [index, slot] of workflow.reference_video_slots.entries()) {
      const entry = supplied[index];
      const source = entry ? await referenceVideoSourceFromEntry(entry) : undefined;
      if (source !== undefined) {
        const keepAudio = entry.use_audio === true && stagedVideoHasAudio(source);
        const canvas = entry.canvas === 'compact' ? 'compact' : 'full';
        const normalizedName = normalizeReferenceVideo(source, { keepAudio, canvas });
        stagedVideos.push({ name: normalizedName, audio: keepAudio, canvas });
        setMappedApiInput(promptGraph, slot, normalizedName);
        const audioLink = normalizeSlot(slot?.audio_link);
        if (!keepAudio && audioLink && promptGraph[audioLink.node]?.inputs) {
          delete promptGraph[audioLink.node].inputs[audioLink.input];
        }
        continue;
      }
      pruneApiNode(promptGraph, normalizeSlot(slot)?.node);
    }
    if (stagedVideos.length) {
      settings.referenceVideoNames = stagedVideos.map((item) => item.name);
      settings.referenceVideoAudio = stagedVideos.map((item) => item.audio);
      // Measured off the NORMALIZED file, which is already 24 fps, already held
      // to the model card's 15s ceiling and already inside the node's reference
      // canvas — so these are the length and the dimensions the node will
      // actually encode, and what the VRAM budget is priced on.
      settings.referenceVideos = stagedVideos.map((item) => {
        const dimensions = stagedVideoDimensions(item.name);
        return {
          name: item.name,
          useAudio: item.audio,
          compact: item.canvas === 'compact',
          seconds: stagedMediaDuration(item.name) ?? undefined,
          width: dimensions?.width,
          height: dimensions?.height,
        };
      });
    }
  }
  // Reference audio: voice/music cloning through the same autogrow contract.
  // Clip N is the prompt's <Audio N> (numbered independently of <Picture N>),
  // and every unfilled slot is pruned the same way — a real Comfy lane rejects
  // an empty LoadAudio filename at submit. The model card caps clips at 2-15s
  // each and 15s combined, and forbids audio as the sole reference, so an
  // audio-only request fails loudly here instead of as a lane-side error.
  if (Array.isArray(workflow.reference_audio_slots) && workflow.reference_audio_slots.length) {
    const supplied = Array.isArray(args.reference_audios) ? args.reference_audios : [];
    if (supplied.length > workflow.reference_audio_slots.length) {
      throw new Error(
        `workflow ${workflow.id} accepts at most ${workflow.reference_audio_slots.length} reference audio clips`,
      );
    }
    if (supplied.length && !settings.referenceImageNames?.length && !settings.referenceVideoNames?.length) {
      throw new Error(
        `workflow ${workflow.id} cannot take reference audio alone — supply at least one reference picture or video alongside it`,
      );
    }
    const stagedAudio = [];
    for (const [index, slot] of workflow.reference_audio_slots.entries()) {
      const entry = supplied[index];
      const source = entry ? await audioSourceFromEntry(entry) : undefined;
      if (source !== undefined) {
        stagedAudio.push(source);
        setMappedApiInput(promptGraph, slot, source);
        continue;
      }
      pruneApiNode(promptGraph, normalizeSlot(slot)?.node);
    }
    if (stagedAudio.length) settings.referenceAudioNames = stagedAudio;
  }
  // Every reference loader pruned leaves the conditioning node with nothing to
  // condition on — a graph that only fails once it reaches the GPU. Checked
  // after the audio pass so an audio-only request still gets the specific
  // "audio can never be the sole reference" refusal rather than this one.
  if (Array.isArray(workflow.reference_image_slots) && workflow.reference_image_slots.length
      && !settings.referenceImageNames?.length && !settings.referenceVideoNames?.length) {
    throw new Error(`workflow ${workflow.id} requires at least one reference picture or reference video`);
  }
  // The prompt has to name every reference by the label the model will give it,
  // and the numbering is NOT simply "one counter per argument list": the node
  // presents pictures, then each video (its own soundtrack claiming an <Audio N>
  // immediately BEFORE its <Video N>), then the standalone clips. So a video
  // with sound plus one voice clip numbers <Audio 1>, <Video 1>, <Audio 2>.
  // Callers get the resolved map back rather than having to re-derive that rule.
  if (settings.referenceImageNames?.length || settings.referenceVideoNames?.length
      || settings.referenceAudioNames?.length) {
    const labels = [];
    let audioOrdinal = 0;
    (settings.referenceImageNames || []).forEach((_, index) => {
      labels.push({ label: `<Picture ${index + 1}>`, kind: 'picture' });
    });
    (settings.referenceVideoNames || []).forEach((_, index) => {
      if (settings.referenceVideoAudio?.[index]) {
        audioOrdinal += 1;
        labels.push({ label: `<Audio ${audioOrdinal}>`, kind: 'video_soundtrack', video: index + 1 });
      }
      labels.push({ label: `<Video ${index + 1}>`, kind: 'video' });
    });
    (settings.referenceAudioNames || []).forEach(() => {
      audioOrdinal += 1;
      labels.push({ label: `<Audio ${audioOrdinal}>`, kind: 'audio' });
    });
    settings.referenceLabels = labels;
  }
  if (timelineImageName) settings.timelineImageName = timelineImageName;
  if (ingredientSheet) {
    settings.ingredientSheet = {
      sourceCount: ingredientSheet.sourceCount,
      columns: ingredientSheet.layout.columns,
      rows: ingredientSheet.layout.rows,
      conditioningOnly: true,
    };
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
    // Boolean toggle: argOrDefault returns false unchanged and
    // setMappedApiInput only skips undefined/null/'', so `false` reaches the
    // graph and actually disables the node.
    spectrum: slots.spectrum,
    easycache: slots.easycache,
    solattn_tau: slots.solattn_tau,
    interpolate: slots.interpolate,
  })) {
    // The seed slot never inherits a literal default: an omitted (or -1) seed
    // is a request for a fresh one, not for the workflow's baked-in number.
    // Workflows without a seed slot are left exactly as they were.
    const value = key === 'seed' && slot !== undefined
      ? resolveSeed(argOrDefault(args, defaults, key))
      : argOrDefault(args, defaults, key);
    if (value !== undefined) {
      settings[key] = value;
      setMappedApiInput(promptGraph, slot, value);
    }
  }
  // EasyCache reuses a cached transformer step whenever the latent has barely
  // moved. At a 0 threshold nothing ever qualifies, so rather than leave a
  // no-op wrapper (and its per-step subsampling bookkeeping) in every default
  // run, the node is lifted out of the model chain entirely and its consumers
  // are reconnected to whatever fed it. Off means off, byte for byte.
  if (slots.easycache && !(Number(settings.easycache) > 0)) {
    const cacheSlot = normalizeSlot(slots.easycache);
    if (cacheSlot) {
      delete settings.easycache;
      bypassApiNode(promptGraph, cacheSlot.node, 'model');
    }
  } else if (slots.easycache && slots.spectrum && settings.spectrum !== false) {
    // Measured on the rented 5090 (5s @ 960x544, one seed): the Spectrum node
    // REFUSES to run when a cache wrapper patches the same model ("Spectrum H3
    // disabled for this run because EasyCache or LazyCache is active"), so
    // asking for both silently gets EasyCache alone. They are alternatives, and
    // the choice is not about speed — 39.1s vs 41.9s against 60.3s unaccelerated
    // — but about fidelity: EasyCache lands 28-35 dB from the unaccelerated
    // render, Spectrum ~20 dB, i.e. a visibly different take at the same seed.
    throw new Error(
      'easycache and spectrum cannot both be on: the Spectrum forecaster disables itself whenever a '
      + 'cache wrapper patches the same model, so the pair silently runs as easycache alone. Pick one — '
      + 'spectrum is marginally faster, easycache stays much closer to the unaccelerated render — by '
      + 'sending spectrum:false alongside easycache.',
    );
  }
  // Sol-Attn sparsifies self-attention; tau 0 means "no sparsification", which
  // is a wrapper doing nothing, so it comes out of the chain the same way.
  if (slots.solattn_tau && !(Number(settings.solattn_tau) > 0)) {
    const solSlot = normalizeSlot(slots.solattn_tau);
    if (solSlot) {
      delete settings.solattn_tau;
      bypassApiNode(promptGraph, solSlot.node, 'model');
    }
  }
  // Frame interpolation runs on the decoded frames. A multiplier below 2 is no
  // interpolation at all: lift the node out and let the muxer take the decode
  // straight, then drop the model loader it was the only consumer of.
  if (slots.interpolate) {
    const interpolateSlot = normalizeSlot(slots.interpolate);
    const multiplier = Math.round(Number(settings.interpolate) || 0);
    if (interpolateSlot && multiplier >= 2) {
      settings.interpolate = multiplier;
      setMappedApiInput(promptGraph, interpolateSlot, multiplier);
    } else if (interpolateSlot) {
      delete settings.interpolate;
      const loader = promptGraph[interpolateSlot.node]?.inputs?.interp_model;
      bypassApiNode(promptGraph, interpolateSlot.node, 'images');
      if (Array.isArray(loader)) pruneApiNode(promptGraph, loader[0]);
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
    const durationFrames = Math.round(settings.durationSeconds * settings.frameRate);
    settings.frames = normalizedGridFrameCount(workflow, durationFrames)
      ?? normalizedLtxFrameCount(durationFrames + 1);
    setMappedApiInput(promptGraph, slots.frames, settings.frames);
  }
  // Interpolated frames are real frames, so the clip has to be MUXED at the
  // higher rate or a 2x pass plays back at half speed. This runs after the
  // frame-count maths on purpose: the model still samples its own 24 fps grid,
  // and folding the multiplier into settings.frameRate any earlier made a 5s
  // request generate 243 frames — ten seconds of content — before RIFE ever ran.
  if (Number(settings.interpolate) >= 2 && slots.frame_rate) {
    settings.outputFrameRate = settings.frameRate * Number(settings.interpolate);
    setMappedApiInput(promptGraph, slots.frame_rate, settings.outputFrameRate);
  }
  if (settings.motionContextName) {
    if (settings.imageName) {
      throw new Error('motion-context chaining replaces the start frame — the context clip provides the opening frames (an end_image_* target is still allowed)');
    }
    if (settings.motionContextDimensions && slots.width && slots.height) {
      settings.width = settings.motionContextDimensions.width;
      settings.height = settings.motionContextDimensions.height;
      setMappedApiInput(promptGraph, slots.width, settings.width);
      setMappedApiInput(promptGraph, slots.height, settings.height);
    }
    if (slots.frames) {
      // The context head is re-rendered and trimmed, so sample asked+context
      // frames. NEAREST lattice point (not up) keeps the delivered length
      // within half a grid step of the request.
      const baseFrames = Number.isFinite(Number(settings.frames)) && Number(settings.frames) > 0
        ? Math.round(Number(settings.frames))
        : Math.round(settings.durationSeconds * settings.frameRate);
      const sampledFrames = Math.max(
        normalizedGridFrameCount(workflow, H3_MOTION_CONTEXT_FRAMES + 1) ?? 0,
        nearestGridFrameCount(workflow, baseFrames + H3_MOTION_CONTEXT_FRAMES)
          ?? (baseFrames + H3_MOTION_CONTEXT_FRAMES),
      );
      settings.frames = sampledFrames;
      setMappedApiInput(promptGraph, slots.frames, settings.frames);
      settings.motionContext = {
        context_frames: H3_MOTION_CONTEXT_FRAMES,
        sampled_frames: sampledFrames,
        output_frames: Math.max(0, sampledFrames - H3_MOTION_CONTEXT_FRAMES),
      };
    }
  }
  // The authoritative check, against the dimensions and frame count the graph
  // will actually sample. The pre-flight at the top of this function catches
  // the same thing before any staging cost; this one covers the paths that
  // rewrite the canvas after the fact (motion-context chaining).
  assertMotionReferenceFitsTheCard(workflow, {
    ...settings,
    referenceImageCount: settings.referenceImageNames?.length || 0,
    referenceAudioCount: settings.referenceAudioNames?.length || 0,
    referenceAudioSeconds: (settings.referenceAudioNames || []).map((name) => stagedMediaDuration(name) ?? undefined),
  });
  settings.extensionFrames = normalizedLtxExtensionFrames(settings.durationSeconds, settings.frameRate);
  const usesIngredientConditioning = workflow.prompt_contract?.type === 'ltx23-ingredients';
  if (usesIngredientConditioning) {
    settings.minimumFrames = Number(workflow.native_mlx?.ic_lora?.target_min_frames) || 121;
    settings.frames = Math.max(normalizedLtxFrameCount(settings.frames), settings.minimumFrames);
    settings.durationSeconds = (settings.frames - 1) / settings.frameRate;
    setMappedApiInput(promptGraph, slots.frames, settings.frames);
    settings.ingredientReferenceFrames = configureLtxIcReferenceFrames(
      promptGraph,
      settings.frames,
      workflow.native_mlx?.ic_lora?.reference_min_frames ?? 121,
    );
  }
  const normalizedKeyframes = settings.videoName
    ? []
    : await normalizeVideoKeyframes(
        args,
        usesIngredientConditioning
          ? { ...settings, imageName: timelineImageName, defaultImageStrength: 0.9 }
          : settings,
        defaults,
      );
  let compiledKeyframes = normalizedKeyframes;
  if (!settings.videoName && usesIngredientConditioning) {
    compiledKeyframes = normalizedKeyframes.map((anchor) => {
      const canvas = compileLtxAnchorCanvas(anchor.image_path, {
        width: targetWidth,
        height: targetHeight,
        prompt: ltxTargetDescription(argOrDefault(args, defaults, 'prompt')),
        seed: settings.seed ?? defaults.seed ?? 42,
      });
      return {
        ...anchor,
        image_ref: mergePromptGraphFragment(promptGraph, canvas.graph, canvas.output),
        canvas_preparation: canvas.geometry,
      };
    });
    settings.anchorCanvasPreparations = compiledKeyframes.map((anchor) => anchor.canvas_preparation);
  }
  settings.keyframes = normalizedKeyframes;
  const fittedStart = settings.keyframes.find((anchor) => Number(anchor.frame) === 0);
  if (fittedStart) settings.timelineImageName = fittedStart.image_path;
  if (settings.videoName) compileLtxVideoExtension(promptGraph, settings);
  else if (usesIngredientConditioning) {
    compileLtxIcTimelineAnchors(promptGraph, compiledKeyframes);
  }
  else compileLtxImageAnchors(promptGraph, settings.keyframes);
  if (settings.motionContextName) compileH3MotionContextChain(promptGraph, settings);
  injectWorkflowLoras(promptGraph, settings.loras, workflow.lora_injection);
  // Fast high-res runs LAST of the graph rewrites: it clones the conditioning
  // node and the sampler, so every earlier step — the canvas, the frame count,
  // the anchor frames, the accelerator chain, the LoRAs — has to be settled
  // first or the clone carries a stale copy of it.
  if (argOrDefault(args, defaults, 'fast_high_res') === true
      && (workflow.accepts || []).includes('fast_high_res')) {
    const plan = compileH3FastHighRes(promptGraph, workflow, settings);
    // null means the compiler declined — too small a target for two passes to
    // pay, too few steps to split, or a graph topology it has not been measured
    // against. Record what was RENDERED, not what was asked for.
    settings.fastHighRes = plan || false;
  }

  const extraPngInfo = {};
  const mobileWorkflowPath = resolveWorkflowFile(workflow.mobile_workflow || workflow.editor_workflow || workflow.mobileWorkflow);
  if (mobileWorkflowPath && existsSync(mobileWorkflowPath)) {
    const editorWorkflow = loadJsonFile(mobileWorkflowPath, `${workflow.id} editor workflow`);
    applyEditorWidgetOverrides(editorWorkflow, workflow.workflow_overrides?.editor_widgets);
    editorWorkflow.extra = editorWorkflow.extra && typeof editorWorkflow.extra === 'object' ? editorWorkflow.extra : {};
    const existingNative = editorWorkflow.extra.nativeMlxLtx && typeof editorWorkflow.extra.nativeMlxLtx === 'object'
      ? editorWorkflow.extra.nativeMlxLtx
      : {};
    const nativeSpec = workflow.native_mlx && typeof workflow.native_mlx === 'object' ? workflow.native_mlx : {};
    editorWorkflow.extra.nativeMlxLtx = {
      ...existingNative,
      enabled: nativeSpec.enabled !== false,
      variant: nativeSpec.variant || existingNative.variant,
      // Head swap is a per-request mode, not a separate workflow: it overrides
      // whatever pipeline the workflow normally declares, and only when the two
      // inputs it needs (source footage + a face) are both present.
      ...(settings.headSwap && settings.videoName && settings.imageName
        ? {
          pipeline: 'head-swap',
          head_swap: {
            source_video: settings.videoName,
            face_image: settings.imageName,
            region_px: settings.headSwapRegionPx,
            max_dimension: settings.headSwapMaxDimension,
            pipeline: settings.headSwapPipeline,
            frames: videoFrameCount(args, settings, defaults),
            frame_rate: Number(settings.frame_rate ?? defaults.frame_rate ?? 24),
            ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
          },
        }
        : (nativeSpec.pipeline || existingNative.pipeline ? { pipeline: nativeSpec.pipeline || existingNative.pipeline } : {})),
      defaults: {
        ...(existingNative.defaults && typeof existingNative.defaults === 'object' ? existingNative.defaults : {}),
        ...(settings.imageName ? { image: settings.imageName } : {}),
        ...(settings.prompt !== undefined ? { prompt: settings.prompt } : {}),
        ...(settings.width !== undefined ? { width: settings.width } : {}),
        ...(settings.height !== undefined ? { height: settings.height } : {}),
        frames: videoFrameCount(args, settings, defaults),
        frame_rate: Number(settings.frame_rate ?? defaults.frame_rate ?? 24),
        ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        // Carried for NAG. The distilled lanes run cfg=1, so the runner turns a
        // negative prompt into attention-space guidance rather than CFG, which
        // would be inert there. nag_scale <= 1 opts a request out.
        ...(settings.negative_prompt ? { negative_prompt: settings.negative_prompt } : {}),
        ...(settings.nagScale !== undefined ? { nag_scale: settings.nagScale } : {}),
      },
      keyframes: settings.keyframes,
      ...(settings.ingredientSheet ? { ingredientSheet: settings.ingredientSheet } : {}),
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
      ...((Array.isArray(nativeSpec.loras) || settings.loras.length) ? {
        loras: mergeNativeWorkflowLoras(nativeSpec.loras, settings.loras),
      } : {}),
      ...(nativeSpec.ic_lora || existingNative.icLora ? { icLora: {
        ...(existingNative.icLora && typeof existingNative.icLora === 'object' ? existingNative.icLora : {}),
        ...(nativeSpec.ic_lora && typeof nativeSpec.ic_lora === 'object' ? nativeSpec.ic_lora : {}),
        ...(settings.imageName ? { reference_image: settings.imageName } : {}),
      } } : {}),
    };
    extraPngInfo.workflow = editorWorkflow;
    extraPngInfo.nativeMlxLtx = editorWorkflow.extra.nativeMlxLtx;
  }

  if (args.studio_lane) extraPngInfo.studioLane = args.studio_lane;
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
  const requesterPub = requesterPublicKey();
  if (requesterPub) headers['X-E2E-Requester-Pub'] = requesterPub;
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
    // Stringify object errors: a structured {error:{...}} body used to surface as
    // the literal "[object Object]", hiding the only useful diagnostic.
    const raw = data?.error ?? data?.message ?? text ?? `HTTP ${response.status}`;
    const message = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const err = new Error(message);
    err.status = response.status;
    err.response = data;
    // Operational failures describe the MACHINE, not the work: an unreachable
    // lane, a dropped tunnel, a rental that no longer exists. They carry no
    // prompt or media content, so they survive machine-private redaction —
    // otherwise every one of them reaches the studio as a bare timeout and the
    // one thing the user could act on is the thing that gets stripped.
    err.machineSafe = Boolean(data?.operational);
    throw err;
  }
  return data;
}

// Submitting a video is not a quick POST, and a caller that gives up does NOT
// stop it. Two slow stretches live inside this one request: a reference job's
// inputs are staged on the remote lane first (measured ~1 MB/s over the rental
// tunnel, so a motion clip plus nine pictures is 15-25s), and then ComfyUI only
// answers /prompt once its executor is free — behind a running 8-minute render
// that alone can take most of a minute. At the old 60s cap the abort landed
// mid-flight while the gateway went on to queue the prompt, record its lane and
// start the harvest watcher: a real render nobody was holding the id for.
//
// So the timeout is sized to the work, and an abort is no longer terminal —
// the gateway files each submission under the client_id we minted for it, and
// we ask for that id back rather than abandoning a job that is already running.
const VIDEO_SUBMIT_TIMEOUT_MS = 150000;
const SUBMIT_RECONCILE_WINDOW_MS = 30000;
const SUBMIT_RECONCILE_INTERVAL_MS = 2000;

const sleepMs = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function adoptSubmittedPrompt(clientId) {
  const deadline = Date.now() + SUBMIT_RECONCILE_WINDOW_MS;
  for (;;) {
    try {
      const found = await requestJson(`/api/comfy/prompt-by-client/${encodeURIComponent(clientId)}`, { timeoutMs: 15000 });
      if (found?.prompt_id) return found;
    } catch {
      // A 404 is the normal answer until Comfy accepts the prompt: the route is
      // recorded from the submit response, so it appears only once it exists.
    }
    if (Date.now() >= deadline) return null;
    await sleepMs(SUBMIT_RECONCILE_INTERVAL_MS);
  }
}

async function submitVideoPrompt(body) {
  try {
    return await requestJson('/comfy/api/prompt', { method: 'POST', body, timeoutMs: VIDEO_SUBMIT_TIMEOUT_MS });
  } catch (error) {
    const clientId = body?.client_id;
    if (!clientId) throw error;
    const adopted = await adoptSubmittedPrompt(clientId);
    // Nothing queued under our id: the submit really did fail, so report it.
    if (!adopted) throw error;
    console.error(
      `[media-studio-mcp] lost the submit response (${error?.message || error}); `
      + `adopted prompt ${adopted.prompt_id} already queued on lane ${adopted.lane}`,
    );
    return { prompt_id: adopted.prompt_id, status: 'queued', adopted: true };
  }
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
    error: String(error?.message || error?.error || error?.error_type || error),
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
    // A machine-safe reason is about the infrastructure, never the job: it is
    // the difference between "MediaStudioError" and "the machine behind this
    // lane is not answering — re-attach it". Everything else stays redacted.
    ...(error?.machineSafe && error?.message ? { error: String(error.message) } : {}),
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
      if (machinePrivate && privateReceipt) {
        // The browser-facing receipt is redacted to a generic MediaStudioError,
        // which makes failures un-debuggable. Log the real reason to stderr only
        // (server logs are not browser-exposed, so this leaks nothing).
        console.error('[media-studio-mcp] tool failed (redacted to client):', error?.stack || error?.message || error);
        return fail(machineFailureReceipt(error));
      }
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

// A failed prompt's reason lives in status.messages, not in any top-level
// field, so a job record built without this reads back as a bare 'error' and
// the studio can only say "reported a failed generation". Remote lanes send
// hivemind_remote_error (the gateway already sanitised it); a local Comfy
// sends the native execution_error, from which only the node identity and the
// exception are taken — never current_inputs (prompt text) or the traceback.
function comfyHistoryErrorMessage(status) {
  for (const message of status?.messages || []) {
    if (!Array.isArray(message) || message.length < 2) continue;
    const [kind, payload] = message;
    if (kind === 'hivemind_remote_error') {
      const text = String(payload?.error || '').trim();
      if (text) return text.slice(0, 400);
    }
    if (kind === 'execution_error' && payload && typeof payload === 'object') {
      const where = [payload.node_type, payload.node_id ? `node ${payload.node_id}` : '']
        .filter(Boolean).join(' ');
      const detail = String(payload.exception_message || payload.exception_type || 'failed')
        .replace(/\s+/g, ' ').trim();
      return `${where ? `${where} failed — ` : ''}${detail}`.slice(0, 400);
    }
  }
  return '';
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
  const jobStatus = completed ? (statusText.includes('error') ? 'error' : 'success') : 'running';
  const error = jobStatus === 'error' ? comfyHistoryErrorMessage(status) : '';
  return normalizeRecord({
    id: promptId,
    status: jobStatus,
    backend: 'comfy-ltx-eros-video',
    comfy_status: status,
    outputs,
    image_urls: imageUrls,
    ...(error ? { error } : {}),
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
      media_type: z.string().optional().describe('Optional media type filter, such as image or video.'),
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
      workflow_id: z.string().optional().describe('Optional registered image workflow id from media_list_workflows. The workflow selects the backend and defaults.'),
      backend: z.string().optional().describe('Optional backend route, such as comfy-krea2-turbo-identity-edit or mlx-mxfp8-bigloves-klein3-edit.'),
      width: z.number().int().min(64).max(4096).optional(),
      height: z.number().int().min(64).max(4096).optional(),
      steps: z.number().int().min(1).max(150).optional(),
      cfg: z.number().min(0).max(50).optional(),
      cfgScale: z.number().min(0).max(50).optional(),
      guidance: z.number().min(0).max(50).optional(),
      seed: z.union([z.number().int(), z.string()]).optional(),
      negative_prompt: z.string().max(2000).optional(),
      ref_boost: z.number().min(0).max(1000).optional().describe('Krea2 identity fidelity dial. Default 4.'),
      identity_strength: z.number().min(-10).max(10).optional().describe('Krea2 identity LoRA strength. Default 1.'),
      grounding_px: z.number().int().min(0).max(4096).optional().describe('Krea2 identity Qwen3-VL grounding size. Default 768.'),
      image_path: z.string().optional().describe('Existing local image path or Comfy input filename for edit backends.'),
      image_base64: z.string().optional().describe('Inline source image as raw base64 or data:image/...;base64,... data URL. Wins over image_path.'),
      image_url: z.string().optional().describe('Optional HTTP(S) source image fetched by Media Studio. Ignored when image_base64 is supplied.'),
      image_paths: z.array(z.string()).max(4).optional().describe('Additional reference images as local paths or Comfy input filenames for multi-reference edit backends (BigLove Klein conditions on up to 4 references total, e.g. for character sheets).'),
      images_base64: z.array(z.string()).max(4).optional().describe('Additional inline reference images (raw base64 or data URLs) for multi-reference edit backends. Combined with image_path/image_base64, the first 4 unique references are used.'),
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
    const workflow = args.workflow_id ? videoWorkflowRegistry()[args.workflow_id] : null;
    if (args.workflow_id && (!workflow || workflow.media_type !== 'image')) {
      throw new Error(`Unknown image workflow: ${args.workflow_id}`);
    }
    const hasImage = Boolean(args.image_base64 || args.image_url || args.image_path);
    if (workflow?.requires?.image && !hasImage) {
      throw new Error(`${workflow.title || workflow.id} requires a source image`);
    }
    const stagedImage = await stageInlineImageFromArgs(args);
    const body = Object.fromEntries(Object.entries(args).filter(([key, value]) => (
      !['workflow_id', 'wait', 'timeout_s', 'include_urls', 'image_base64', 'image_url'].includes(key) && value !== undefined
    )));
    if (workflow) {
      for (const [key, value] of Object.entries(workflowDefaults(workflow.id))) {
        if (body[key] === undefined) body[key] = value;
      }
    }
    if (!body.backend && workflow?.backend) body.backend = workflow.backend;
    if (stagedImage) body.image_path = stagedImage;
    const queued = normalizeRecord(await requestJson('/api/generate', {
      method: 'POST',
      body,
      timeoutMs: 30000,
    }), { includeUrls });
    if (!args.wait || !queued.id) return { ...(workflow ? { workflow: publicWorkflow(workflow) } : {}), job: queued };
    const job = await waitForJob(queued.id, { timeoutS: args.timeout_s, includeUrls });
    return { ...(workflow ? { workflow: publicWorkflow(workflow) } : {}), job };
  }, { privateReceipt: true }));

  server.registerTool('media_generate_video', {
    title: 'Generate Video',
    description: 'Queue a registered video workflow. If workflow_id is omitted, the default local video workflow is used.',
    inputSchema: {
      workflow_id: z.string().optional().describe(`Registered workflow id. Defaults to ${defaultVideoWorkflowId()}. Use media_list_workflows to discover options.`),
      studio_lane: z.string().max(512).optional().describe('Opaque app-tab queue lane. Jobs from one lane run in order; different tabs and media studios remain independent.'),
      prompt: z.string().min(1).optional().describe('Optional positive video prompt. Long natural-language prompts are preserved without a client-side character cap.'),
      reference_description: z.string().optional().describe('Ingredients IC-LoRA only: panel-by-panel description of the reference sheet. Omit only when prompt already contains the required Reference Sheet Description and Target Description headings.'),
      ingredient_images: z.array(z.object({
        image_path: z.string().optional(),
        image_base64: z.string().optional(),
        image_url: z.string().optional(),
        description: z.string().max(1000).optional(),
      })).min(1).max(12).optional().describe('Ingredients IC-LoRA only: independent conditioning references composed server-side into one black, unlabeled, contain-only sheet. These images never become timeline anchors.'),
      spectrum: z.boolean().optional().describe('Spectrum forecasting: predicts about half the sampling steps instead of computing them — roughly half the sampling time, softer fine detail. Defaults to the workflow setting.'),
      fast_high_res: z.boolean().optional().describe('Fast high-res (MiniMax H3): sample the first pass on a small canvas, lift the video latent to full size with H3\'s trained latent upscaler, and spend only the last few sigmas at full size. Same step count, most of them on a fraction of the rows. Off unless asked for; the compiler declines and renders single-pass when the target is too small for two passes to pay.'),
      negative_prompt: z.string().max(2000).optional().describe('Optional negative video prompt mapped through the registered workflow when supported.'),
      nag_scale: z.number().min(0).max(30).optional().describe('Normalized Attention Guidance scale for the local distilled LTX lanes. Those run cfg=1, where a negative prompt is otherwise ignored; NAG applies it inside cross-attention for ~8% more time. Omit for the default (11), pass <=1 to disable.'),
      image_path: z.string().optional().describe('Absolute local image path or existing Comfy input filename. Absolute paths are copied into the private Comfy input folder before queueing if the workflow needs Comfy access.'),
      image_base64: z.string().optional().describe('Inline source image as raw base64 or data:image/...;base64,... data URL. Wins over image_path.'),
      image_url: z.string().optional().describe('Optional HTTP(S) source image fetched by Media Studio. Ignored when image_base64 is supplied.'),
      video_path: z.string().optional().describe('Source video path or existing Comfy input filename. Supplying video switches LTX generation to shot extension.'),
      video_base64: z.string().optional().describe('Inline source video as raw base64 or data:video/...;base64,... data URL. Wins over video_path.'),
      video_url: z.string().optional().describe('Optional HTTP(S) source video fetched by Media Studio. Ignored when video_base64 is supplied.'),
      video_mode: z.enum(['extend']).default('extend').describe('How LTX uses the source video. Extend preserves the source clip and generates a seamless continuation.'),
      motion_context_path: z.string().optional().describe('MiniMax H3 scene chaining: path or existing Comfy input filename of the PREVIOUS clip. Its last 22 frames (and audio tail) seed this generation so motion and room tone continue across the cut; the re-rendered context head is trimmed off the delivered clip. The new clip renders on the context clip\'s canvas, Spectrum is forced off, and the start frame is replaced by the chain (end_image_* still works).'),
      motion_context_base64: z.string().optional().describe('Inline motion-context clip as raw base64 or data:video/...;base64,... data URL. Wins over motion_context_path.'),
      motion_context_url: z.string().optional().describe('Optional HTTP(S) motion-context clip fetched by Media Studio. Ignored when motion_context_base64 is supplied.'),
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
      reference_images: z.array(z.object({
        image_path: z.string().optional(),
        image_base64: z.string().optional(),
        image_url: z.string().optional(),
      })).max(9).optional().describe(
        'MiniMax H3 Reference mode: up to nine reference pictures, in order. '
        + 'Reference N is the prompt\'s <Picture N>. Any reference_* argument routes the call to Reference mode '
        + 'automatically: sent to a tier without reference slots (minimax-h3, minimax-h3-turbo) it runs on the '
        + 'family\'s reference workflow instead (minimax-h3-reference — the result\'s workflow.id says which graph '
        + 'ran and routed_from where the call came from); a family with no reference workflow refuses the call '
        + 'rather than dropping the references.',
      ),
      reference_videos: z.array(z.object({
        video_path: z.string().optional(),
        video_base64: z.string().optional(),
        video_url: z.string().optional(),
        use_audio: z.boolean().optional(),
        canvas: z.enum(['full', 'compact']).optional().describe(
          'How the clip is staged for the node. "full" (default) keeps MiniMax H3\'s own 768-short-edge '
          + 'reference canvas. "compact" fits the clip inside 384x1152, never upscaled: about 3.3x fewer '
          + 'sequence rows and roughly half the sampling time, which is what lets a longer clip or a longer '
          + 'reference fit the card. Measured indistinguishable for MOTION references (same-seed renders at '
          + 'full, 544 and 384 sit within the between-seed noise of each other); not validated when the video '
          + 'is the identity reference, so it is a per-clip choice.'),
        duration_seconds: z.number().positive().max(3600).optional().describe(
          'This clip\'s own length, if the caller already knows it. Purely an optimisation: a reference is '
          + 'trimmed to min(its own length, the generated clip\'s), so this decides whether the run fits, and '
          + 'sending it lets an over-budget request be refused before anything is staged rather than after '
          + 'every reference has been fetched and re-encoded. Omit it and the clip is assumed long until the '
          + 'real file is measured on staging.'),
      })).max(3).optional().describe(
        'MiniMax H3 Reference mode: up to three MOTION reference videos, in order — video N is the prompt\'s '
        + '<Video N>. Carries how a body moves: gesture style, posture, mannerisms, facial expressiveness. How '
        + 'literally it binds is set by that <Video N>\'s retention_analysis tag — fully_preserved reproduces the '
        + 'movement, attribute_transfer performs a DIFFERENT action in that performer\'s manner, weak_reference is '
        + 'a loose pacing cue. Each clip 2-15s, MP4/MOV/WebM/MKV/AVI/M4V, resampled to 24 fps on staging and read '
        + 'only up to the generated clip\'s own length. Requires at least one reference picture or video overall. '
        + 'With NO reference_images attached, <Video 1> is the IDENTITY reference too: bind <Subject 1> to it '
        + '("<Subject 1> is the man in <Video 1>, with …"), tag it fully_preserved, and say its performer\'s face, '
        + 'hair, build and wardrobe carry — only the clip\'s setting and framing are excluded. '
        + 'Set use_audio to also condition on the clip\'s soundtrack — that soundtrack then takes an <Audio N> '
        + 'label of its own, emitted BEFORE its <Video N>, which shifts the numbering of any standalone clips. '
        + 'Routes to Reference mode automatically, like reference_images.',
      ),
      reference_audios: z.array(z.object({
        audio_path: z.string().optional(),
        audio_base64: z.string().optional(),
        audio_url: z.string().optional(),
      })).max(3).optional().describe(
        'MiniMax H3 Reference mode: up to three voice (or music) reference clips, in order — clip N is the '
        + 'prompt\'s <Audio N>, numbered after any reference video\'s own soundtrack. Each clip 2-15s, 15s combined, '
        + 'WAV/MP3/FLAC/OGG/M4A/AAC; requires at least one reference picture or video alongside. Clones the voice two ways: tag the prompt summary '
        + '[audio reuse] to reperform the clip\'s exact words (keep them verbatim, original language, inside <d>…</d>), '
        + 'or [audio reference] to lend only its timbre and delivery to NEW dialogue (never repeat the source words). '
        + 'Define each in subject_definitions, e.g. "<Audio 1> is the voice-timbre reference for <Subject 1> (S1)." '
        + 'Routes to Reference mode automatically, like reference_images.',
      ),
      loras: z.array(z.object({
        id: z.string().min(1),
        strength: z.number().min(-10).max(10).optional(),
      })).max(20).optional().describe('Installed workflow-compatible LoRAs. Each is applied to video/model layers only so generated audio conditioning stays unchanged.'),
      params: z.record(z.string(), z.any()).optional().describe('Additional workflow parameters for registry-defined slots, e.g. steps, cfg, guidance, or model-specific controls.'),
      width: z.number().int().min(64).max(4096).optional(),
      height: z.number().int().min(64).max(4096).optional(),
      frames: z.number().int().min(9).max(721).optional(),
      frame_rate: z.number().min(1).max(120).optional(),
      duration_seconds: z.number().min(1 / 24).max(30).optional().describe('For video input, seconds of new footage to append. For image input, requested output duration.'),
      // -1 asks for a fresh random seed, same as omitting it; the floor was 0,
      // which rejected the one value the tool description tells callers to send.
      seed: z.number().int().min(-1).max(1000000000).optional()
        .describe('Omit or pass -1 for a fresh random seed; >= 0 locks it. A locked seed on a remote lane replays ComfyUI\'s cache and returns a file the privacy sweeper has already deleted.'),
      denoise: z.enum(['', 'light', 'strong']).optional().describe('Post-generation grain cleanup for the native MLX LTX path. Motion-adaptive temporal averaging (atadenoise); "strong" adds a spatial-only pass. Default off.'),
      head_swap: z.boolean().optional().describe('Replace the face in the source video with the supplied image, using the BFS head-swap IC-LoRA. Requires BOTH a source video and a face image, plus the BFS LoRA selected. Prompt format: "head_swap: FACE: [new face] ACTION: [action from the original video]".'),
      head_swap_region_px: z.number().min(32).max(2048).optional().describe('Width of the reserved face strip in the head-swap guide frame (default 256, matching the model author\'s workflow).'),
      head_swap_max_dimension: z.number().int().min(0).max(4096).optional().describe('Cap the head-swap render\'s long side, preserving aspect (0 = render at the source clip\'s own size). A head swap is rendered at the source resolution, so this is the main lever on how long it takes; the author recommends around 768.'),
      head_swap_lora_strength: z.number().min(0.1).max(2).optional().describe('Strength of the BFS head-swap IC-LoRA, which the head-swap task supplies automatically (default 1.0). Per the model author: 1.0 gives the best motion fidelity; above 1.0 captures identity and hair more strongly but can distort.'),
      head_swap_backend: z.enum(['bfs', 'facefusion']).optional().describe('Which engine performs the head swap. "bfs" (default) regenerates every frame with the BFS IC-LoRA, so it can change hair and head shape but reinvents the scene. "facefusion" swaps the face region onto the ORIGINAL frames, so body, clothing, background and motion stay identical and it runs roughly 10x quicker, but hair and head shape stay the source actor\'s.'),
      head_swap_face_enhancer: z.boolean().optional().describe('FaceFusion only: run the face enhancer after the swap to restore detail the 128px swapper loses. Roughly doubles the runtime.'),
      head_swap_pipeline: z.enum(['single-stage', 'fast']).optional().describe('Head-swap sampler path. "single-stage" (default) generates at full resolution with the guide applied throughout and tracks it most tightly. "fast" generates at half resolution, upsamples, then runs a control-aware refine — substantially quicker, slightly looser on the guide.'),
      detailer_strength: z.number().min(0).max(1.5).optional().describe("Strength for Lightricks' IC-LoRA Detailer, run as an optional second sampling pass over the generated clip to add fine texture. 0 (default) skips the pass entirely and costs nothing; 0.6 is the commonly reported value."),
      wait: z.boolean().default(false).describe('Poll until native wrapper success/error, or until Comfy fallback appears in history.'),
      timeout_s: z.number().min(1).max(7200).default(5400),
      include_urls: z.boolean().default(false).describe('Include token-bearing absolute Studio URLs in wrapper-native results.'),
    },
  }, tool(async (args) => {
    const includeUrls = machinePrivate ? false : args.include_urls;
    const { spec, workflow, settings, body } = await buildVideoPromptBody(args);
    const submission = await submitVideoPrompt(body);
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
        ...(settings.motionContext ? { motion_context: settings.motionContext } : {}),
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
      // Everything this request does — including the gateway calls that decide
      // who the generated media is sealed to — runs as the caller that asked
      // for it. Absent or malformed header falls back to this process's key.
      await runWithRequester(
        req.headers['x-e2e-requester-pub'],
        () => transport.handleRequest(req, res, req.body),
      );
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
  MEDIA_STUDIO_E2E_PUB           Requester public key (base64url SPKI) remote-lane
                                  outputs are sealed to; also scopes job status reads
  MEDIA_STUDIO_E2E_PUB_FILE      File containing the requester public key
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

// Only start a server when this file IS the program. Importing it (the
// requester-context test does) must not silently bring up a stdio MCP server
// that never returns.
// Compared through realpath, not URL equality: the supervisor may launch this
// through a symlinked path, and a false negative here means the sidecar never
// starts at all.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
