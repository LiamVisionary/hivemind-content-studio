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

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const HOST = process.env.OGA_HOST || '127.0.0.1';
const PORT = Number(process.env.OGA_PORT || 8794);
const ZIMAGE_URL = process.env.ZIMAGE_API_URL || 'http://127.0.0.1:8787';
const MEDIA_STATE_ROOT = process.env.HIVEMIND_MEDIA_STATE_DIR || path.join(process.env.HOME || '', '.hivemindos/media-studio');
const ZIMAGE_TOKEN_FILE = process.env.ZIMAGE_TOKEN_FILE || path.join(MEDIA_STATE_ROOT, 'secure/zimg-token');
const LOCAL_AI_DIR = path.join(process.env.HOME || '', 'Library/Application Support/open-generative-ai/local-ai');

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

function readBody(req, max = 2_000_000) {
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
  const modelsDir = path.join(LOCAL_AI_DIR, 'models');
  const has = (filename) => fs.existsSync(path.join(modelsDir, filename));
  return [
    { id: 'z-image-turbo', name: 'Z-Image Turbo', type: 'z-image', provider: 'hosted-zimage', state: 'downloaded', path: ZIMAGE_URL, aspectRatios: ['1:1','4:3','3:4','16:9','9:16'], defaultSteps: 8, defaultGuidance: 1.0, tags: ['hosted','fast','local'] },
    { id: 'dreamshaper-8', name: 'Dreamshaper 8', type: 'sd1', provider: 'sdcpp', state: has('DreamShaper_8_pruned.safetensors') ? 'downloaded' : 'not-downloaded', path: path.join(modelsDir, 'DreamShaper_8_pruned.safetensors') },
  ];
}

async function handleLocalAi(req, res, pathname) {
  if (pathname === '/local-ai/binary-status') {
    return sendJson(res, 200, { exists: true, hosted: true, dataDir: LOCAL_AI_DIR, modelsDir: path.join(LOCAL_AI_DIR, 'models'), zimage: ZIMAGE_URL });
  }
  if (pathname === '/local-ai/models') return sendJson(res, 200, listModels());
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
      const modelType = body.model === 'z-image-turbo' ? 'z-image' : 'z-image';
      const [arWidth, arHeight] = arToDimensions(body.aspect_ratio || '1:1', modelType);
      const payload = {
        prompt: String(body.prompt || ''),
        negative_prompt: String(body.negative_prompt || ''),
        width: Number(body.width || body.customWidth || arWidth),
        height: Number(body.height || body.customHeight || arHeight),
        steps: Number(body.steps || 8),
        cfg: Number(body.cfgScale || body.guidance || 1),
        seed: body.seed ?? -1,
      };
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
