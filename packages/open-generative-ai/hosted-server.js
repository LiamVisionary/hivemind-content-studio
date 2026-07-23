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

function arToDimensions(ar, modelType) {
  const base = (modelType === 'sdxl' || modelType === 'z-image') ? 1024 : 512;
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
  try {
    return loadHostedWorkflowModels(WORKFLOW_REGISTRY);
  } catch (error) {
    console.error(`[open-generative-ai-hosted] unable to load workflow metadata: ${error.message}`);
    return [];
  }
}

async function handleLocalAi(req, res, pathname) {
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
      const job = await requestJson(`${ZIMAGE_URL}/api/civitai/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url, expectedType: 'LORA' }),
        timeout: 60000,
      });
      return sendJson(res, 202, job);
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
    // Registry workflows first, then auto-discovered drop-ins (listModels merges both).
    const selected = listWorkflowModels().find((model) => model.id === modelId)
        || listModels().find((model) => model.id === modelId);
    if (!selected) return sendJson(res, 404, { error: `Unknown local workflow: ${modelId}` });
    if (!selected.supportsLoras || selected.compatibleBaseModels.length === 0) {
      return sendJson(res, 200, { model: modelId, supported: false, baseModels: [], loras: [] });
    }
    try {
      const baseModels = selected.compatibleBaseModels.join(',');
      const catalog = await requestJson(`${ZIMAGE_URL}/api/loras?compact=1&baseModels=${encodeURIComponent(baseModels)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const loras = (catalog.loras || []).map((lora) => ({
        ...lora,
        previewPath: lora.hasPreview
          ? `/local-ai/lora-preview/${Buffer.from(String(lora.id), 'utf8').toString('base64url')}`
          : '',
      }));
      return sendJson(res, 200, { model: modelId, supported: true, baseModels: catalog.baseModels || selected.compatibleBaseModels, loras });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
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
      const [arWidth, arHeight] = arToDimensions(body.aspect_ratio || '1:1', modelType);
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
        const source = await requestBuffer(body.image_url);
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
    if (u.pathname.startsWith('/local-ai/')) return handleLocalAi(req, res, u.pathname);
    if (u.pathname.startsWith('/api/')) return sendJson(res, 501, { error: 'Cloud Muapi proxy is not enabled in hosted mode; use local Z-Image or the desktop app API-key flow.' });
    return serveStatic(res, u.pathname);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});
server.listen(PORT, HOST, () => console.log(`[open-generative-ai-hosted] http://${HOST}:${PORT}`));
