#!/usr/bin/env node
/* Hosted Open Generative AI wrapper for Liam's Mac.
 * Serves the Vite build and provides a browser localAI bridge backed by the
 * existing local Z-Image API. Secrets stay server-side; the browser never sees
 * the Z-Image token.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { loadHostedImageModels, loadHostedWorkflowModels } = require('./hosted-local-models');
const { discoverAutoImageWorkflows } = require('./auto-workflow-discovery');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const HOST = process.env.OGA_HOST || '127.0.0.1';
const PORT = Number(process.env.OGA_PORT || 8794);
const ZIMAGE_URL = process.env.ZIMAGE_API_URL || 'http://127.0.0.1:8787';
const MEDIA_STATE_ROOT = process.env.HIVEMIND_MEDIA_STATE_DIR || path.join(process.env.HOME || '', '.hivemindos/media-studio');
const ZIMAGE_TOKEN_FILE = process.env.ZIMAGE_TOKEN_FILE || path.join(MEDIA_STATE_ROOT, 'secure/zimg-token');
const LOCAL_AI_DIR = path.join(process.env.HOME || '', 'Library/Application Support/open-generative-ai/local-ai');
const WORKFLOW_REGISTRY = process.env.MEDIA_STUDIO_WORKFLOW_REGISTRY || path.resolve(ROOT, '../media-gateway/workflow-registry.json');
const MAX_REQUEST_BODY = 25 * 1024 * 1024;

function readToken() {
  try { return fs.readFileSync(ZIMAGE_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

function send(res, status, body, headers = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  res.writeHead(status, {
    'Content-Length': data.length,
    'Cache-Control': headers['Cache-Control'] || 'no-store',
    ...headers,
  });
  res.end(data);
}
function sendJson(res, status, obj) { send(res, status, obj, { 'Content-Type': 'application/json; charset=utf-8' }); }
function sendText(res, status, text) { send(res, status, text, { 'Content-Type': 'text/plain; charset=utf-8' }); }

function readBody(req, max = MAX_REQUEST_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > max) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = options.body ? Buffer.from(options.body) : null;
    const headers = { ...(options.headers || {}) };
    if (payload) headers['Content-Length'] = payload.length;
    const r = mod.request({ method: options.method || 'GET', hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers, timeout: options.timeout || 30000 }, (up) => {
      const chunks = [];
      up.on('data', d => chunks.push(d));
      up.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        if (up.statusCode < 200 || up.statusCode >= 300) reject(new Error(data.error || `HTTP ${up.statusCode}`));
        else resolve(data);
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('request timed out')));
    if (payload) r.write(payload);
    r.end();
  });
}

function requestBuffer(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers, timeout: 60000 }, (up) => {
      const chunks = [];
      up.on('data', d => chunks.push(d));
      up.on('end', () => {
        if (up.statusCode < 200 || up.statusCode >= 300) reject(new Error(`HTTP ${up.statusCode}`));
        else resolve({ buffer: Buffer.concat(chunks), contentType: up.headers['content-type'] || 'application/octet-stream' });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('request timed out')));
    r.end();
  });
}

// Aspect ratio -> pixel dimensions. `base` is the short-side resolution: it is
// what the studio's Resolution control drives, so 768 on 16:9 renders a smaller
// (and proportionally faster) frame than 1024 on 16:9. Explicit width/height in
// the request bypass this entirely.
function arToDimensions(ar, modelType, base) {
  const requested = Number(base);
  if (!Number.isFinite(requested) || requested <= 0) {
    base = (modelType === 'sdxl' || modelType === 'z-image') ? 1024 : 512;
  } else {
    base = Math.round(Math.max(256, Math.min(2048, requested)) / 64) * 64;
  }
  const map = {
    '1:1': [base, base],
    '16:9': [Math.round(base * 16 / 9 / 64) * 64, base],
    '9:16': [base, Math.round(base * 16 / 9 / 64) * 64],
    '4:3': [Math.round(base * 4 / 3 / 64) * 64, base],
    '3:4': [base, Math.round(base * 4 / 3 / 64) * 64],
  };
  return map[ar] || [base, base];
}

function listModels() {
  let registryModels = [];
  try {
    registryModels = loadHostedImageModels(WORKFLOW_REGISTRY);
  } catch (error) {
    console.error(`[open-generative-ai-hosted] unable to load image workflows: ${error.message}`);
  }
  let autoModels = [];
  try {
    // Auto-detected drop-in workflows; registry entries win on id collision.
    const knownIds = new Set(registryModels.map((model) => model.id));
    autoModels = discoverAutoImageWorkflows().filter((model) => !knownIds.has(model.id));
  } catch (error) {
    console.error(`[open-generative-ai-hosted] auto-workflow discovery failed: ${error.message}`);
  }
  return [...registryModels, ...autoModels];
}

function listWorkflowModels() {
  let registryModels = [];
  try {
    registryModels = loadHostedWorkflowModels(WORKFLOW_REGISTRY);
  } catch (error) {
    console.error(`[open-generative-ai-hosted] unable to load workflow metadata: ${error.message}`);
  }
  return registryModels;
}

// LoRA lookup only needs a workflow's compatible BASE MODELS. Video workflows
// live in the Media Studio MCP's own registry, not in workflow-registry.json that
// this bridge reads, so resolving them here used to mean a hand-maintained copy of
// the ids — which silently broke LoRAs for every workflow added afterwards.
// Instead the caller passes the base models it already got from the authoritative
// MCP catalog, and this only sanitises them. A real registry entry still wins.
function baseModelsFromQuery(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && item.length <= 64 && /^[\w .+-]+$/.test(item))
    .slice(0, 8);
}

async function handleLocalAi(req, res, pathname, query = new URLSearchParams()) {
  if (pathname === '/local-ai/binary-status') {
    return sendJson(res, 200, { exists: true, hosted: true, dataDir: LOCAL_AI_DIR, modelsDir: path.join(LOCAL_AI_DIR, 'models'), zimage: ZIMAGE_URL });
  }
  if (pathname === '/local-ai/models') return sendJson(res, 200, listModels());
  if (pathname === '/local-ai/prompt-helper' && req.method === 'POST') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Media Studio token unavailable' });
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const selected = listWorkflowModels().find((model) => model.id === body.model);
      if (!selected) return sendJson(res, 400, { error: `Unknown local workflow: ${body.model || '(missing)'}` });
      if (!selected.promptHelper) return sendJson(res, 400, { error: `${selected.name} does not expose a prompt helper` });
      const idea = String(body.idea || body.prompt || '').trim();
      if (!idea) return sendJson(res, 400, { error: 'Enter a prompt before using the prompt helper' });
      const helper = selected.promptHelper;
      const result = await requestJson(`${ZIMAGE_URL}/comfy/api/prompt_assistant/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          idea,
          profile: helper.profile,
          helper_mode: helper.helperMode,
          timeout_seconds: helper.timeoutSeconds,
          negative_prompt: String(body.negative_prompt || ''),
          seed: Number.isFinite(Number(body.seed)) ? Number(body.seed) : -1,
          ...(typeof body.reference_image === 'string' && body.reference_image.startsWith('data:image/')
            ? { reference_image: body.reference_image }
            : {}),
          ...(Array.isArray(body.active_loras) ? { active_loras: body.active_loras } : {}),
        }),
        timeout: (helper.timeoutSeconds + 15) * 1000,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 502, { error: error.message });
    }
  }
  if (pathname === '/local-ai/civitai-download' && req.method === 'POST') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Media Studio token unavailable' });
    try {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      const url = String(body.url || '').trim();
      if (!url) return sendJson(res, 400, { error: 'Civitai URL required' });
      // An update-and-replace names the installed LoRA it supersedes. Keep it a
      // plain relative name here; the gateway re-resolves it under models/loras.
      const replaceId = String(body.replaceId || '').trim();
      if (replaceId && (replaceId.includes('..') || replaceId.startsWith('/'))) {
        return sendJson(res, 400, { error: 'Invalid LoRA to replace' });
      }
      // No expectedType: any Civitai model type is downloadable from here. The
      // gateway files each one by type (loras / checkpoints / vae / embeddings…),
      // so pinning this to LORA only ever rejected downloads it could have placed.
      const job = await requestJson(`${ZIMAGE_URL}/api/civitai/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(replaceId ? { url, replaceId } : { url }),
        timeout: 60000,
      });
      return sendJson(res, 202, job);
    } catch (error) {
      return sendJson(res, 502, { error: error.message });
    }
  }
  if (pathname.startsWith('/local-ai/civitai-download/') && req.method === 'DELETE') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Media Studio token unavailable' });
    const jobId = pathname.slice('/local-ai/civitai-download/'.length);
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) return sendJson(res, 400, { error: 'Invalid download job id' });
    try {
      const job = await requestJson(`${ZIMAGE_URL}/api/civitai/cancel-download/${encodeURIComponent(jobId)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      return sendJson(res, 200, job);
    } catch (error) {
      return sendJson(res, 502, { error: error.message });
    }
  }
  if (pathname.startsWith('/local-ai/civitai-download/') && req.method === 'GET') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Media Studio token unavailable' });
    const jobId = pathname.slice('/local-ai/civitai-download/'.length);
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) return sendJson(res, 400, { error: 'Invalid download job id' });
    try {
      const job = await requestJson(`${ZIMAGE_URL}/api/civitai/download/${encodeURIComponent(jobId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return sendJson(res, 200, job);
    } catch (error) {
      return sendJson(res, 502, { error: error.message });
    }
  }
  if (pathname.startsWith('/local-ai/loras/')) {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Z-Image token unavailable' });
    const modelId = decodeURIComponent(pathname.slice('/local-ai/loras/'.length));
    // Registry workflows first, then auto-discovered drop-ins (listModels merges both),
    // then the base models the caller carries from the MCP catalog — that last path is
    // what keeps MCP-only video workflows working without a hand-kept id list here.
    const selected = listWorkflowModels().find((model) => model.id === modelId)
        || listModels().find((model) => model.id === modelId);
    const declaredBaseModels = baseModelsFromQuery(query.get('baseModels'));
    if (!selected && declaredBaseModels.length === 0) {
      return sendJson(res, 404, { error: `Unknown local workflow: ${modelId}` });
    }
    const resolvedBaseModels = selected?.compatibleBaseModels?.length
      ? selected.compatibleBaseModels
      : declaredBaseModels;
    if ((selected && !selected.supportsLoras) || resolvedBaseModels.length === 0) {
      return sendJson(res, 200, { model: modelId, supported: false, baseModels: [], loras: [] });
    }
    try {
      const baseModels = resolvedBaseModels.join(',');
      const catalog = await requestJson(`${ZIMAGE_URL}/api/loras?compact=1&baseModels=${encodeURIComponent(baseModels)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const loras = (catalog.loras || []).map((lora) => ({
        ...lora,
        previewPath: lora.hasPreview
          ? `/local-ai/lora-preview/${Buffer.from(String(lora.id), 'utf8').toString('base64url')}`
          : '',
      }));
      return sendJson(res, 200, { model: modelId, supported: true, baseModels: catalog.baseModels || resolvedBaseModels, loras });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }
  if (pathname === '/local-ai/lora-updates' && req.method === 'GET') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Z-Image token unavailable' });
    // Same sanitising as the LoRA list: only the caller's declared base models reach
    // the gateway, so an update check never widens beyond the workflow in view.
    const baseModels = baseModelsFromQuery(query.get('baseModels'));
    const search = baseModels.length ? `?baseModels=${encodeURIComponent(baseModels.join(','))}` : '';
    try {
      const data = await requestJson(`${ZIMAGE_URL}/api/civitai/lora-updates${search}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 60000,
      });
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, 502, { error: error.message });
    }
  }
  if (pathname.startsWith('/local-ai/lora-preview/')) {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Z-Image token unavailable' });
    try {
      const encoded = pathname.slice('/local-ai/lora-preview/'.length);
      const loraId = Buffer.from(encoded, 'base64url').toString('utf8');
      if (!loraId) return sendText(res, 404, 'not found');
      const preview = await requestBuffer(`${ZIMAGE_URL}/api/loras/preview?id=${encodeURIComponent(loraId)}`, {
        Authorization: `Bearer ${token}`,
      });
      return send(res, 200, preview.buffer, {
        'Content-Type': preview.contentType,
        'Cache-Control': 'private, max-age=3600',
      });
    } catch (_) {
      return sendText(res, 404, 'not found');
    }
  }
  if (pathname.startsWith('/local-ai/job/')) {
    const token = readToken();
    if (!token) return sendJson(res, 500, { status: 'error', error: 'Z-Image token unavailable' });
    const id = pathname.split('/').pop();
    try {
      const job = await requestJson(`${ZIMAGE_URL}/api/job/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (job.status === 'success' && job.image_urls?.[0]) {
        const imgUrl = job.image_urls[0].startsWith('http') ? job.image_urls[0] : `${ZIMAGE_URL}${job.image_urls[0]}`;
        const img = await requestBuffer(imgUrl, { Authorization: `Bearer ${token}` });
        job.url = `data:${String(img.contentType).split(';')[0]};base64,${img.buffer.toString('base64')}`;
      }
      return sendJson(res, 200, job);
    } catch (e) { return sendJson(res, 502, { status: 'error', error: e.message }); }
  }
  if (pathname === '/local-ai/generate' && req.method === 'POST') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Z-Image token unavailable' });
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const selected = listModels().find((model) => model.id === body.model);
      if (!selected) return sendJson(res, 400, { error: `Unknown local image workflow: ${body.model || '(missing)'}` });
      if (selected.requires?.image && !body.image_base64 && !body.image_url) {
        return sendJson(res, 400, { error: `${selected.name} requires a source image` });
      }
      const modelType = selected.family === 'z-image' ? 'z-image' : 'sdxl';
      const [arWidth, arHeight] = arToDimensions(body.aspect_ratio || '1:1', modelType, body.base_size);
      const payload = {
        prompt: String(body.prompt || ''),
        negative_prompt: String(body.negative_prompt || ''),
        width: Number(body.width || body.customWidth || arWidth || selected.defaultWidth),
        height: Number(body.height || body.customHeight || arHeight || selected.defaultHeight),
        steps: Number(body.steps || selected.defaultSteps || 8),
        cfg: Number(body.cfgScale ?? body.guidance_scale ?? body.guidance ?? selected.defaultGuidance ?? 1),
        seed: body.seed ?? -1,
      };
      if (selected.backend) payload.backend = selected.backend;
      if (selected.workflowFile) payload.workflow_file = selected.workflowFile;
      if (Array.isArray(body.loras)) payload.loras = body.loras;
      // Sampler/scheduler are only meaningful for workflows that declare them;
      // everything else keeps its own tuned pair.
      if (body.sampler_name && selected.samplers?.includes(String(body.sampler_name))) {
        payload.sampler_name = String(body.sampler_name);
      }
      if (body.scheduler && selected.schedulers?.includes(String(body.scheduler))) {
        payload.scheduler = String(body.scheduler);
      }
      if (body.couple_mode) {
        payload.couple_mode = true;
        if (body.couple_shared) payload.couple_shared = true;
        if (body.couple_direction) payload.couple_direction = String(body.couple_direction);
        if (body.couple_split != null) payload.couple_split = Number(body.couple_split);
        if (body.couple_pair) payload.couple_pair = String(body.couple_pair);
      }
      if (body.image_base64) {
        payload.image_base64 = body.image_base64;
      } else if (body.image_url) {
        // Only an absolute http(s) source can be fetched from here. A reference the
        // owner picked from their saved list is a same-origin path to a vault-sealed
        // envelope: this host holds no key, so the client has to decrypt it and send
        // image_base64 instead. Passing the bare path straight to new URL() threw a
        // bare "Invalid URL" that said nothing about which side had to change.
        if (!/^https?:\/\//i.test(String(body.image_url))) {
          return sendJson(res, 400, {
            error: 'A saved reference image has to be sent as image_base64 — this host cannot read a sealed reference path.',
          });
        }
        const source = await requestBuffer(body.image_url);
        if (/hivemind\.e2e/i.test(String(source.contentType))) {
          return sendJson(res, 400, {
            error: 'That reference is end-to-end encrypted — decrypt it in the browser and send image_base64.',
          });
        }
        payload.image_base64 = `data:${String(source.contentType).split(';')[0]};base64,${source.buffer.toString('base64')}`;
      }
      const submitted = await requestJson(`${ZIMAGE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      return sendJson(res, 202, submitted);
    } catch (e) { return sendJson(res, 502, { error: e.message }); }
  }
  if (pathname === '/local-ai/upscale' && req.method === 'POST') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Z-Image token unavailable' });
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.image_base64) return sendJson(res, 400, { error: 'image_base64 is required' });
      const payload = {
        image_base64: body.image_base64,
        mode: body.mode === 'max' ? 'max' : 'fast',
        scale: Number(body.scale || 1.5),
      };
      if (body.prompt) payload.prompt = String(body.prompt);
      const submitted = await requestJson(`${ZIMAGE_URL}/api/upscale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      return sendJson(res, 202, submitted);
    } catch (e) { return sendJson(res, 502, { error: e.message }); }
  }
  return sendJson(res, 404, { error: 'not found' });
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.json':'application/json; charset=utf-8' })[ext] || 'application/octet-stream';
}

function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(DIST, '.' + rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const index = path.join(DIST, 'index.html');
    if (fs.existsSync(index)) return send(res, 200, fs.readFileSync(index), { 'Content-Type': 'text/html; charset=utf-8' });
    return sendText(res, 404, 'dist not built; run npm run vite:build\n');
  }
  const immutable = rel.startsWith('/assets/');
  send(res, 200, fs.readFileSync(file), { 'Content-Type': contentType(file), 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || HOST}`);
  try {
    if (u.pathname === '/health' || u.pathname === '/healthz') return sendJson(res, 200, { ok: true, service: 'Open Generative AI Hosted', hosted: true, zimage: ZIMAGE_URL });
    if (u.pathname.startsWith('/local-ai/')) return handleLocalAi(req, res, u.pathname, u.searchParams);
    if (u.pathname.startsWith('/api/')) return sendJson(res, 501, { error: 'Cloud Muapi proxy is not enabled in hosted mode; use local Z-Image or the desktop app API-key flow.' });
    return serveStatic(res, u.pathname);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});
server.listen(PORT, HOST, () => console.log(`[open-generative-ai-hosted] http://${HOST}:${PORT}`));
