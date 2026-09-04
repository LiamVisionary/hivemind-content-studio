#!/usr/bin/env node
/* Hosted local-inference bridge for Hivemind Content Studio.
 * Serves the Vite build and provides a browser localAI bridge backed by the
 * existing local Z-Image API. Secrets stay server-side; the browser never sees
 * the Z-Image token.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { loadHostedImageModels, loadHostedWorkflowModels, missingWeightFiles } = require('./hosted-local-models');
const { defaultAutoWorkflowDirs, discoverAutoImageWorkflows } = require('./auto-workflow-discovery');
// Generated from src/hivemind_content_studio/identity.py.
const identity = require('./electron/identity.json');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const HOST = process.env.OGA_HOST || '127.0.0.1';
const PORT = Number(process.env.OGA_PORT || 8794);
const ZIMAGE_URL = process.env.ZIMAGE_API_URL || 'http://127.0.0.1:8787';
const MEDIA_STATE_ROOT = process.env.HIVEMIND_MEDIA_STATE_DIR || path.join(process.env.HOME || '', '.hivemindos/media-studio');
const ZIMAGE_TOKEN_FILE = process.env.ZIMAGE_TOKEN_FILE || path.join(MEDIA_STATE_ROOT, 'secure/zimg-token');
// The product's own support folder, named once in
// src/hivemind_content_studio/identity.py and generated into identity.json.
// A machine that already downloaded a model under the donor-named folder keeps
// serving it: the old directory wins only while the new one does not exist, so
// nobody is asked to re-download a model to rename a folder.
const APPLICATION_SUPPORT = path.join(process.env.HOME || '', 'Library/Application Support');
const LOCAL_AI_DIR = (() => {
  const current = path.join(APPLICATION_SUPPORT, identity.supportDirName, 'local-ai');
  if (fs.existsSync(current)) return current;
  const legacy = path.join(APPLICATION_SUPPORT, identity.legacySupportDirName, 'local-ai');
  return fs.existsSync(legacy) ? legacy : current;
})();
const WORKFLOW_REGISTRY = process.env.MEDIA_STUDIO_WORKFLOW_REGISTRY || path.resolve(ROOT, '../media-gateway/workflow-registry.json');
const MAX_REQUEST_BODY = 25 * 1024 * 1024;
// FLUX.2 Klein conditions on up to four reference images total. The gateway
// enforces the same ceiling (BIGLOVE_KLEIN3_MAX_REFERENCES); this bound just
// keeps the bridge from fetching bytes that would be dropped downstream.
const KLEIN_MAX_REFERENCE_IMAGES = 4;

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
      if (size > max) {
        const tooLarge = new Error('request body too large');
        tooLarge.status = 413;
        reject(tooLarge);
        // Stop reading but do not destroy the socket yet: destroying it here
        // tore the connection down before the 413 could be written, so the
        // caller saw a reset instead of an answer. Node closes the connection
        // itself once the response is out, because the body was never drained.
        req.removeAllListeners('data');
        req.pause();
        return;
      }
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
        if (up.statusCode < 200 || up.statusCode >= 300) {
          // Carry the upstream status: the gateway's own 400 ("URL must be from
          // civitai.com") and 404 ("unknown LoRA") used to reach the browser as 502.
          const failure = new Error(data.error || `HTTP ${up.statusCode}`);
          failure.status = up.statusCode;
          reject(failure);
        } else resolve(data);
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('request timed out')));
    if (payload) r.write(payload);
    r.end();
  });
}

function requestBuffer(url, headers = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : Infinity;
    const maxRedirects = Number(options.maxRedirects) > 0 ? Number(options.maxRedirects) : 0;
    const r = mod.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers, timeout: 60000 }, (up) => {
      // Civitai's media CDN answers with a 301 to its storage host, so a fetch that
      // never follows one silently rendered every remote preview as "not found".
      if (maxRedirects > 0 && up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
        up.resume();
        let next = null;
        try { next = new URL(up.headers.location, url); } catch { reject(new Error('bad redirect')); return; }
        if (typeof options.allowHost === 'function' && !options.allowHost(next.hostname)) {
          reject(new Error('redirect host not allowed'));
          return;
        }
        requestBuffer(next.toString(), headers, { ...options, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
        return;
      }
      const chunks = [];
      let size = 0;
      up.on('data', d => {
        size += d.length;
        // Bounded because card art can be a video: a preview must not be able to
        // pull an unbounded body into this process.
        if (size > maxBytes) { up.destroy(); reject(new Error('response too large')); return; }
        chunks.push(d);
      });
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

// The HTTP status a failed upstream call should be answered with: the upstream's
// own 4xx/5xx when it gave one, 413 for our own body cap, 502 otherwise.
function upstreamStatus(error) {
  const status = Number(error && error.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

// Hosts a caller-supplied reference URL may NOT point at: this process sits on
// the machine, so a fetch to loopback, link-local or a private range would reach
// services the browser itself cannot. The media gateway is the one exception —
// same machine, same trust — so a generated output can be re-used as a source.
function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true;
  if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
function isGatewayHost(parsed) {
  try {
    const gateway = new URL(ZIMAGE_URL);
    return parsed.hostname === gateway.hostname && (parsed.port || (parsed.protocol === 'https:' ? '443' : '80')) === (gateway.port || (gateway.protocol === 'https:' ? '443' : '80'));
  } catch { return false; }
}
// A source picture the generate route fetches on the caller's behalf. Bounded
// like an upload (the studio's own image cap) and never from a private host.
const REFERENCE_FETCH_MAX_BYTES = 32 * 1024 * 1024;
async function fetchReferenceImage(value) {
  let parsed;
  try { parsed = new URL(String(value)); } catch {
    const bad = new Error('That reference URL is not valid'); bad.status = 400; throw bad;
  }
  if (!/^https?:$/.test(parsed.protocol) || (!isGatewayHost(parsed) && isPrivateHost(parsed.hostname))) {
    const refused = new Error('That reference URL cannot be fetched from here — send the picture as image_base64');
    refused.status = 400;
    throw refused;
  }
  return requestBuffer(parsed.toString(), {}, {
    maxBytes: REFERENCE_FETCH_MAX_BYTES,
    maxRedirects: 3,
    allowHost: (host) => !isPrivateHost(host),
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

// The registry file is re-read and the drop-in folders re-scanned on every call,
// and /local-ai/models is asked by every studio tab at boot plus every model
// picker afterwards. Keyed on what those reads actually depend on — the registry
// file's mtime and size, and the same for each auto-workflow directory — so a
// workflow added or edited still lands on the very next request, and a boot with
// several tabs open reads the disk once.
let modelsCache = { key: '', models: null };

function modelSourceStamp() {
  const parts = [];
  for (const target of [WORKFLOW_REGISTRY, ...defaultAutoWorkflowDirs()]) {
    try {
      const stat = fs.statSync(target);
      parts.push(`${target}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${target}:missing`);
    }
  }
  return parts.join('|');
}

function listModels() {
  const key = modelSourceStamp();
  if (modelsCache.models && modelsCache.key === key) return modelsCache.models;
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
  const models = [...registryModels, ...autoModels];
  modelsCache = { key, models };
  return models;
}

// ── Is anything actually runnable right now? ─────────────────────────────
//
// /local-ai/models used to answer "these workflows are registered", which the
// studio read as "these models will run". Two things separate the one from the
// other: the weights being on disk (hosted-local-models resolves the graph's
// checkpoints) and the lane behind this bridge being up. The second is a
// network call, so it is asked at most once every five seconds and shared by
// every model in the answer.
const LANE_PROBE_TTL_MS = 5000;
let laneProbe = { at: 0, answered: false };

function probeLane() {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(`${String(ZIMAGE_URL).replace(/\/$/, '')}/comfy/system_stats`); } catch { resolve(false); return; }
    const mod = target.protocol === 'https:' ? https : http;
    const token = readToken();
    const request = mod.request({
      method: 'GET',
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      timeout: 2500,
    }, (up) => {
      // ANY answer counts. A 401 or a 502 is the lane talking — only a dead
      // socket means nothing is listening, and calling a running engine
      // offline because it answered 404 would disable Generate for no reason.
      up.resume();
      resolve(true);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.end();
  });
}

async function laneAnswers() {
  const now = Date.now();
  if (laneProbe.at && now - laneProbe.at < LANE_PROBE_TTL_MS) return laneProbe.answered;
  const answered = await probeLane();
  laneProbe = { at: Date.now(), answered };
  return answered;
}

// `ready` is only ever false on evidence: a checkpoint the graph names and the
// models directory does not hold, or a lane that did not answer at all.
async function listModelsWithReadiness() {
  const models = listModels();
  if (!models.length) return models;
  const laneOk = await laneAnswers();
  return models.map((model) => {
    const missing = missingWeightFiles(model.workflowFile);
    if (missing.length) {
      return { ...model, ready: false, readyReason: 'missing-weights', missingWeights: missing.slice(0, 4) };
    }
    if (!laneOk) return { ...model, ready: false, readyReason: 'engine-offline' };
    return { ...model, ready: true, readyReason: 'ok' };
  });
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

/* ---------------- installed library + Civitai browse ---------------- */

// Only these hosts are fetched on the browser's behalf by /local-ai/model-preview.
// Card art for installed and searched models lives on Civitai's image CDN; keeping
// the fetch here means the browser never opens a connection to a third party.
// Card art can be a short video, so the ceiling is generous — but it is a ceiling.
const PREVIEW_MAX_BYTES = 12 * 1024 * 1024;
// Civitai serves card art through a transform segment in the path. Asking for a
// card-sized render is the difference between 1.5 MB and 85 MB on a video preview.
const PREVIEW_TRANSFORM = 'width=450';
// Still frame of a video preview: 216 KB instead of 1.5 MB, so a grid of video
// LoRAs costs about what a grid of image LoRAs costs. Motion is fetched on demand.
const PREVIEW_STILL_TRANSFORM = 'anim=false,width=450';

function isCivitaiHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'civitai.com' || host.endsWith('.civitai.com');
}

// .../<hash>/<uuid>/original=true/file.mp4 -> .../<hash>/<uuid>/width=450/file.mp4
function civitaiThumbnailUrl(parsed, still = false) {
  const url = new URL(parsed.toString());
  const transform = still ? PREVIEW_STILL_TRANSFORM : PREVIEW_TRANSFORM;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 2) {
    const transformIndex = parts.length - 2;
    if (parts[transformIndex].includes('=')) parts[transformIndex] = transform;
    else parts.splice(parts.length - 1, 0, transform);
    url.pathname = `/${parts.join('/')}`;
  }
  return url.toString();
}
const CIVITAI_SEARCH_PARAMS = [
  'query', 'tag', 'username', 'types', 'baseModels', 'sort', 'period',
  'nsfw', 'checkpointType', 'primaryFileOnly', 'supportsGeneration', 'limit', 'cursor', 'page',
];

const CIVITAI_IMAGE_PARAMS = [
  'type', 'baseModels', 'sort', 'period', 'nsfw', 'username', 'limit', 'cursor',
  'postId', 'modelId', 'modelVersionId',
];

// One inspiration card, with the artwork routed through this bridge. `stillPath`
// is the poster for a video card so a grid of clips costs about what a grid of
// stills costs; the motion is only fetched when a card is hovered.
function slimCivitaiImage(item) {
  const source = String(item.cardUrl || item.url || '');
  const previewPath = source ? `/local-ai/model-preview/${previewRef(source)}` : '';
  return {
    id: String(item.id || ''),
    kind: item.kind === 'video' ? 'video' : 'image',
    previewPath,
    stillPath: previewPath ? `${previewPath}?anim=0` : '',
    width: Number(item.width) || 0,
    height: Number(item.height) || 0,
    baseModel: String(item.baseModel || ''),
    username: String(item.username || ''),
    pageUrl: String(item.pageUrl || ''),
    nsfw: Boolean(item.nsfw),
    nsfwLevel: String(item.nsfwLevel || ''),
    createdAt: item.createdAt || null,
    stats: item.stats || {},
    prompt: String(item.prompt || ''),
    negativePrompt: String(item.negativePrompt || ''),
    sampler: String(item.sampler || ''),
    scheduler: String(item.scheduler || ''),
    steps: Number(item.steps) || null,
    cfgScale: Number(item.cfgScale) || null,
    seed: item.seed == null ? null : Number(item.seed),
    clipSkip: Number(item.clipSkip) || null,
    modelName: String(item.modelName || ''),
    resources: Array.isArray(item.resources) ? item.resources : [],
  };
}

function previewRef(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

function previewKind(url) {
  return /\.(mp4|webm|mov)(?:[?#]|$)/i.test(String(url || '')) ? 'video' : 'image';
}

// Model descriptions arrive as Civitai HTML. The UI shows them as plain text, and
// unrendered markup is the kind of thing that ends up injected somewhere later.
function plainText(value, limit = 600) {
  const text = String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h\d)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, entity) => (
      { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[entity] || ' '
    ))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// One installed file, stripped to what a card and a detail panel actually draw.
// The gateway's own /api/library carries the full Civitai sidecar per file — 56 MB
// for ~150 models — so the metadata blob and the absolute path stay on this side.
function slimLibraryAsset(item, kind) {
  const meta = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const version = meta.modelVersion && typeof meta.modelVersion === 'object' ? meta.modelVersion : {};
  const preview = String(item.preview || '');
  const id = String(item.id || '');
  const kindOfPreview = previewKind(preview);
  // The gateway hands back a path, a Civitai URL, or its own preview endpoint.
  const source = preview.startsWith('/api/model-preview?path=')
    ? decodeURIComponent(preview.slice('/api/model-preview?path='.length))
    : preview;
  const previewRoute = source ? `/local-ai/model-preview/${previewRef(source)}` : '';
  // LoRA stills go through the gateway's encrypted, file-identity-keyed cache — the
  // same art the studio's LoRA panel draws. Video card art has no entry there (that
  // route only ever resolves stills), so it asks the CDN for a still frame instead,
  // and the animation is a separate, on-demand fetch.
  const loraId = kind === 'lora' && id.startsWith('loras/') ? id.slice('loras/'.length) : '';
  let previewPath = '';
  if (!source) previewPath = '';
  else if (kindOfPreview === 'video') previewPath = `${previewRoute}?anim=0`;
  else if (loraId) previewPath = `/local-ai/lora-preview/${previewRef(loraId)}`;
  else previewPath = previewRoute;
  return {
    id,
    kind,
    name: String(item.name || ''),
    displayName: String(item.displayName || item.name || ''),
    folder: String(item.folder || ''),
    category: String(item.category || ''),
    role: String(item.role || ''),
    baseModel: String(item.baseModel || 'Unknown'),
    creator: String(item.creator || ''),
    tags: (Array.isArray(item.tags) ? item.tags : []).map(String).slice(0, 12),
    triggerWords: (Array.isArray(item.triggerWords) ? item.triggerWords : []).map(String).slice(0, 8),
    size: String(item.size || ''),
    sizeBytes: Number(item.size_bytes || 0),
    favorite: Boolean(item.favorite),
    notes: plainText(item.notes, 400),
    description: plainText(item.description),
    dateAdded: String(item.dateAdded || ''),
    versionId: String(version.id || ''),
    versionName: String(version.name || '').trim(),
    civitaiModelId: String(version.modelId || (version.model && version.model.id) || ''),
    previewPath,
    // Only set when there is motion to load: the card shows the still until asked.
    motionPath: kindOfPreview === 'video' ? previewRoute : '',
    previewKind: kindOfPreview,
  };
}

// A Civitai search hit, flattened to its newest version: the grid needs one card's
// worth of fields, not the full version/file/image tree the API returns.
function slimCivitaiItem(item) {
  const version = (item.modelVersions || [])[0] || {};
  const files = Array.isArray(version.files) ? version.files : [];
  const file = files.find((entry) => entry.primary) || files[0] || {};
  const image = (Array.isArray(version.images) ? version.images : []).find((entry) => entry && entry.url) || {};
  const stats = item.stats || {};
  return {
    id: String(item.id || ''),
    name: String(item.name || ''),
    type: String(item.type || ''),
    nsfw: Boolean(item.nsfw),
    creator: String(item.creator || ''),
    downloads: Number(stats.downloadCount || 0),
    likes: Number(stats.thumbsUpCount ?? stats.favoriteCount ?? 0),
    versionId: String(version.id || ''),
    versionName: String(version.name || ''),
    baseModel: String(version.baseModel || ''),
    trainedWords: (Array.isArray(version.trainedWords) ? version.trainedWords : []).map(String).slice(0, 8),
    fileId: String(file.id || ''),
    fileName: String(file.name || ''),
    sizeBytes: Math.round(Number(file.sizeKB || 0) * 1024),
    previewPath: image.url ? `/local-ai/model-preview/${previewRef(image.url)}` : '',
    previewKind: previewKind(image.url),
    // Version-pinned page URL: this is also the download input the gateway
    // resolves, so the client never needs a second download shape.
    url: item.id ? `https://civitai.com/models/${encodeURIComponent(String(item.id))}${version.id ? `?modelVersionId=${encodeURIComponent(String(version.id))}` : ''}` : '',
  };
}

// The bridge has no session of its own: whoever reaches it can start local
// generations and pay for Civitai downloads on the owner's key. A page on any
// other site can point its own DNS name at 127.0.0.1 and reach this port, and
// the browser will then treat it as same-origin — the Host header is the one
// thing still carrying the attacker's name, so it is the one thing checked.
// The studio proxies here as 127.0.0.1:8794 and passes.
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

function fromLoopback(req) {
  const authority = String(req.headers.host || '').trim();
  if (!authority) return false;
  try {
    return LOOPBACK_NAMES.has(new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, '').toLowerCase());
  } catch {
    return false;
  }
}

async function handleLocalAi(req, res, pathname, query = new URLSearchParams()) {
  if (!fromLoopback(req)) {
    return sendJson(res, 400, {
      error: 'This bridge only answers on this machine. Open the studio at http://127.0.0.1:8765.',
    });
  }
  if (pathname === '/local-ai/binary-status') {
    return sendJson(res, 200, { exists: true, hosted: true, dataDir: LOCAL_AI_DIR, modelsDir: path.join(LOCAL_AI_DIR, 'models'), zimage: ZIMAGE_URL });
  }
  if (pathname === '/local-ai/models') return sendJson(res, 200, await listModelsWithReadiness());
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
      return sendJson(res, upstreamStatus(error), { error: error.message });
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
      return sendJson(res, upstreamStatus(error), { error: error.message });
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
      return sendJson(res, upstreamStatus(error), { error: error.message });
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
      return sendJson(res, upstreamStatus(error), { error: error.message });
    }
  }
  if (pathname.startsWith('/local-ai/loras/')) {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Z-Image token unavailable' });
    let modelId = '';
    try {
      modelId = decodeURIComponent(pathname.slice('/local-ai/loras/'.length));
    } catch {
      // "%zz" throws URIError; outside a try it was an unhandled rejection that
      // took the whole bridge down for every caller.
      return sendJson(res, 400, { error: 'Invalid workflow id' });
    }
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
      return sendJson(res, upstreamStatus(e), { error: e.message });
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
      return sendJson(res, upstreamStatus(error), { error: error.message });
    }
  }
  if (pathname === '/local-ai/library' && req.method === 'GET') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Media Studio token unavailable' });
    try {
      const data = await requestJson(`${ZIMAGE_URL}/api/library`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 120000,
      });
      const assets = [
        ...(data.loras || []).map((item) => slimLibraryAsset(item, 'lora')),
        ...(data.checkpoints || []).map((item) => slimLibraryAsset(item, 'checkpoint')),
        ...(data.embeddings || []).map((item) => slimLibraryAsset(item, 'embedding')),
        ...(data.other || []).map((item) => slimLibraryAsset(item, 'other')),
      ];
      return sendJson(res, 200, {
        assets,
        stats: data.stats || {},
        baseModels: (data.baseModels || []).map(String),
        tags: (data.tags || []).slice(0, 60),
      });
    } catch (error) {
      return sendJson(res, upstreamStatus(error), { error: error.message });
    }
  }
  if (pathname === '/local-ai/civitai-search' && req.method === 'GET') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Media Studio token unavailable' });
    const search = new URLSearchParams();
    for (const key of CIVITAI_SEARCH_PARAMS) {
      const value = query.get(key);
      // The gateway validates the values themselves; this only bounds their size and
      // keeps every other parameter out of the upstream request.
      if (value !== null && value !== '' && String(value).length <= 200) search.set(key, String(value));
    }
    try {
      const data = await requestJson(`${ZIMAGE_URL}/api/civitai/search?${search}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 60000,
      });
      const installed = data.installed || {};
      return sendJson(res, 200, {
        items: (data.items || []).map(slimCivitaiItem),
        // Ids only: enough to mark a result as already installed, without shipping
        // the installed files' names and download records to the browser.
        installedVersionIds: (installed.versionIds || []).map(String),
        installedFileIds: (installed.fileIds || []).map(String),
        baseModelOptions: (data.baseModelOptions || []).map(String),
        nextCursor: String((data.metadata || {}).nextCursor || ''),
      });
    } catch (error) {
      return sendJson(res, upstreamStatus(error), { error: error.message });
    }
  }
  // The inspiration finder. Same Civitai key and the same privacy rule as the
  // model browser: only ids, prompts and numbers cross to the browser, and the
  // artwork itself is fetched through /local-ai/model-preview so the page never
  // opens a connection to Civitai's CDN. The full-resolution CDN url is
  // deliberately NOT forwarded — "Open on Civitai" uses the image's PAGE, which
  // is a visit the owner chose to make.
  if (pathname === '/local-ai/civitai-images' && req.method === 'GET') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Media Studio token unavailable' });
    const search = new URLSearchParams();
    for (const key of CIVITAI_IMAGE_PARAMS) {
      const value = query.get(key);
      if (value !== null && value !== '' && String(value).length <= 200) search.set(key, String(value));
    }
    try {
      const data = await requestJson(`${ZIMAGE_URL}/api/civitai/images?${search}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 90000,
      });
      return sendJson(res, 200, {
        items: (data.items || []).map(slimCivitaiImage),
        baseModelOptions: (data.baseModelOptions || []).map(String),
        nextCursor: String((data.metadata || {}).nextCursor || ''),
        scanned: Number((data.metadata || {}).scanned || 0),
      });
    } catch (error) {
      return sendJson(res, upstreamStatus(error), { error: error.message });
    }
  }
  if (pathname === '/local-ai/civitai-base-models' && req.method === 'GET') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Media Studio token unavailable' });
    try {
      const data = await requestJson(`${ZIMAGE_URL}/api/civitai/base-models`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 60000,
      });
      return sendJson(res, 200, {
        baseModels: (data.baseModels || []).map(String),
        currentBaseModels: (data.currentBaseModels || []).map(String),
      });
    } catch (error) {
      return sendJson(res, upstreamStatus(error), { error: error.message });
    }
  }
  // Card art for anything that is not a LoRA (those have their own cached route):
  // a local file under the ComfyUI models tree, or Civitai-hosted art fetched here
  // so the browser never talks to Civitai itself.
  if (pathname.startsWith('/local-ai/model-preview/')) {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Media Studio token unavailable' });
    let target = '';
    try {
      target = Buffer.from(pathname.slice('/local-ai/model-preview/'.length), 'base64url').toString('utf8');
    } catch {
      return sendText(res, 400, 'bad preview reference');
    }
    try {
      if (/^https?:\/\//.test(target)) {
        const parsed = new URL(target);
        if (parsed.protocol !== 'https:' || !isCivitaiHost(parsed.hostname)) {
          return sendText(res, 403, 'preview host not allowed');
        }
        const remote = await requestBuffer(civitaiThumbnailUrl(parsed, query.get('anim') === '0'), { 'User-Agent': 'HivemindContentStudio/1.0' }, {
          maxBytes: PREVIEW_MAX_BYTES,
          maxRedirects: 3,
          allowHost: isCivitaiHost,
        });
        return send(res, 200, remote.buffer, {
          'Content-Type': remote.contentType,
          'Cache-Control': 'private, max-age=3600',
        });
      }
      // Local file: the gateway owns the path allowlist (ComfyUI models / outputs),
      // so it stays the one place that decides which files are readable.
      if (!target.startsWith('/') || target.includes('..')) return sendText(res, 400, 'bad preview reference');
      const local = await requestBuffer(`${ZIMAGE_URL}/api/model-preview?path=${encodeURIComponent(target)}`, {
        Authorization: `Bearer ${token}`,
      }, { maxBytes: PREVIEW_MAX_BYTES });
      return send(res, 200, local.buffer, {
        'Content-Type': local.contentType,
        'Cache-Control': 'private, max-age=3600',
      });
    } catch {
      return sendText(res, 404, 'not found');
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
  // Stop a running image job at the gateway. The studio's Cancel used to stop
  // only its own poll; the render kept burning the lane behind it. Matched
  // before the GET job route below, which would read "cancel" as the id.
  const cancelMatch = pathname.match(/^\/local-ai\/job\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { ok: false, error: 'Z-Image token unavailable' });
    let id = '';
    try { id = decodeURIComponent(cancelMatch[1]); } catch { return sendJson(res, 400, { ok: false, error: 'Invalid job id' }); }
    if (!/^[a-zA-Z0-9_.:-]+$/.test(id)) return sendJson(res, 400, { ok: false, error: 'Invalid job id' });
    try {
      const outcome = await requestJson(`${ZIMAGE_URL}/api/job/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000,
      });
      // The gateway's receipt, with one status word the studio can show:
      // interrupted = the backend accepted the stop; stopped = it is verifiably
      // no longer holding the lane (false: the next job queues behind it).
      return sendJson(res, 200, {
        ok: true,
        status: 'cancelled',
        id: String(outcome.id || id),
        known: Boolean(outcome.known),
        interrupted: Boolean(outcome.interrupted),
        stopped: Boolean(outcome.stopped),
        ...(outcome.backend_state ? { backend_state: outcome.backend_state } : {}),
      });
    } catch (e) { return sendJson(res, upstreamStatus(e), { ok: false, status: 'error', error: e.message }); }
  }
  if (pathname.startsWith('/local-ai/job/')) {
    const token = readToken();
    if (!token) return sendJson(res, 500, { status: 'error', error: 'Z-Image token unavailable' });
    const id = pathname.split('/').pop();
    try {
      const job = await requestJson(`${ZIMAGE_URL}/api/job/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (job.status === 'success' && job.image_urls?.[0]) {
        // The gateway lists every output here — including .mp4 (RIFE
        // interpolation). The content type says which kind came back.
        const mediaUrl = job.image_urls[0].startsWith('http') ? job.image_urls[0] : `${ZIMAGE_URL}${job.image_urls[0]}`;
        const media = await requestBuffer(mediaUrl, { Authorization: `Bearer ${token}` });
        const contentType = String(media.contentType).split(';')[0];
        job.url = `data:${contentType};base64,${media.buffer.toString('base64')}`;
        // A SEALED output answers as the envelope type (application/vnd.hivemind.e2e+json),
        // which is neither video/ nor image/ — so the content type alone called every
        // sealed clip an image. The filename still carries the truth.
        job.mediaType = contentType.startsWith('video/')
          || /\.(mp4|mov|webm|mkv|m4v)(\.(e2e|zenc))?$/i.test(String(job.image_urls[0]).split('?')[0])
          ? 'video'
          : 'image';
      }
      return sendJson(res, 200, job);
    } catch (e) { return sendJson(res, upstreamStatus(e), { status: 'error', error: e.message }); }
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
      if (selected.requires?.prompt !== false && !String(body.prompt || '').trim()) {
        return sendJson(res, 400, { error: 'Write a prompt first' });
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
      if (body.studio_lane) payload.studio_lane = String(body.studio_lane).slice(0, 512);
      // The studio's per-tab "Run on" pin — the gateway routes by it.
      if (body.run_on) payload.run_on = String(body.run_on).slice(0, 128);
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
      // Strength Hunt (Mix-Studio port): 1-2 LoRA ids whose strength the gateway
      // sweeps in one job. Only meaningful on backends whose runner supports it;
      // the gateway validates the ids against the submitted LoRA selection.
      if (body.strength_hunt && Array.isArray(body.strength_hunt.lora_ids) && body.strength_hunt.lora_ids.length) {
        payload.strength_hunt = { lora_ids: body.strength_hunt.lora_ids.slice(0, 2).map(String) };
      }
      // Character Sheet (Civitai multi-view port): a preset name or explicit
      // view ids; the gateway validates against its view registry and runs
      // one Klein edit per view before compositing the labeled sheet.
      if (body.character_sheet && typeof body.character_sheet === 'object') {
        const sheet = {};
        if (body.character_sheet.preset) sheet.preset = String(body.character_sheet.preset);
        if (Array.isArray(body.character_sheet.views) && body.character_sheet.views.length) {
          sheet.views = body.character_sheet.views.slice(0, 12).map(String);
        }
        if (sheet.preset || sheet.views) payload.character_sheet = sheet;
      }
      // Canvas expansion (Mix-Studio port): centered pixel-preserving outpaint
      // to an explicit target canvas. Needs the source image alongside it.
      if (body.outpaint && Number(body.outpaint.width) > 0 && Number(body.outpaint.height) > 0) {
        payload.outpaint = {
          width: Math.round(Number(body.outpaint.width)),
          height: Math.round(Number(body.outpaint.height)),
          ...(Number(body.outpaint.feathering) >= 0 ? { feathering: Math.round(Number(body.outpaint.feathering)) } : {}),
          ...(body.outpaint.offset_x != null ? { offset_x: Number(body.outpaint.offset_x) } : {}),
          ...(body.outpaint.offset_y != null ? { offset_y: Number(body.outpaint.offset_y) } : {}),
        };
      }
      // Masked edit (soft inpaint): the browser paints a white-on-black mask
      // and sends it as a data URL alongside the source image.
      if (body.inpaint && typeof body.inpaint.mask_base64 === 'string' && body.inpaint.mask_base64) {
        payload.inpaint = {
          mask_base64: body.inpaint.mask_base64,
          ...(body.inpaint.mask_expand != null ? { mask_expand: Math.round(Number(body.inpaint.mask_expand)) } : {}),
          ...(body.inpaint.mask_influence != null ? { mask_influence: Math.round(Number(body.inpaint.mask_influence)) } : {}),
        };
      }
      // Additional references — these ride ALONGSIDE the primary image, so the
      // list holds at most KLEIN_MAX_REFERENCE_IMAGES - 1 entries. Data URLs
      // pass through; an absolute http(s) entry is fetched here the same way
      // the primary image_url is. Sealed reference paths must arrive already
      // decrypted as data URLs — this host holds no vault key.
      if (Array.isArray(body.images_base64) && body.images_base64.length) {
        const extras = [];
        for (const entry of body.images_base64.slice(0, KLEIN_MAX_REFERENCE_IMAGES - 1)) {
          const value = String(entry || '').trim();
          if (!value) continue;
          if (value.startsWith('data:')) {
            extras.push(value);
          } else if (/^https?:\/\//i.test(value)) {
            const source = await fetchReferenceImage(value);
            if (/hivemind\.e2e/i.test(String(source.contentType))) {
              return sendJson(res, 400, {
                error: 'A reference in images_base64 is end-to-end encrypted — decrypt it in the browser and send a data URL.',
              });
            }
            extras.push(`data:${String(source.contentType).split(';')[0]};base64,${source.buffer.toString('base64')}`);
          } else {
            return sendJson(res, 400, {
              error: 'images_base64 entries must be data URLs (or absolute http(s) URLs) — this host cannot read a sealed reference path.',
            });
          }
        }
        if (extras.length) payload.images_base64 = extras;
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
        const source = await fetchReferenceImage(body.image_url);
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
    } catch (e) { return sendJson(res, upstreamStatus(e), { error: e.message }); }
  }
  if (pathname === '/local-ai/interpolate' && req.method === 'POST') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Z-Image token unavailable' });
    try {
      // Whole clips ride as base64 — the default JSON cap would reject them.
      const body = JSON.parse((await readBody(req, 512 * 1024 * 1024)).toString('utf8') || '{}');
      if (!body.video_base64) return sendJson(res, 400, { error: 'video_base64 is required' });
      const payload = {
        video_base64: body.video_base64,
        factor: Number(body.factor) === 4 ? 4 : 2,
      };
      const submitted = await requestJson(`${ZIMAGE_URL}/api/interpolate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        timeout: 180000,
      });
      return sendJson(res, 202, submitted);
    } catch (e) { return sendJson(res, upstreamStatus(e), { error: e.message }); }
  }
  if (pathname === '/local-ai/smart-mask' && req.method === 'POST') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Z-Image token unavailable' });
    try {
      const body = JSON.parse((await readBody(req, 64 * 1024 * 1024)).toString('utf8') || '{}');
      if (!body.image_base64) return sendJson(res, 400, { error: 'image_base64 is required' });
      const payload = {
        image_base64: body.image_base64,
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        points: Array.isArray(body.points) ? body.points : undefined,
        ...(Number.isFinite(Number(body.confidence)) ? { confidence: Number(body.confidence) } : {}),
      };
      const submitted = await requestJson(`${ZIMAGE_URL}/api/smart-mask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        timeout: 120000,
      });
      return sendJson(res, 202, submitted);
    } catch (e) { return sendJson(res, upstreamStatus(e), { error: e.message }); }
  }
  if (pathname === '/local-ai/ltx-director' && req.method === 'POST') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Z-Image token unavailable' });
    try {
      const body = JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString('utf8') || '{}');
      if (!body.project || typeof body.project !== 'object') {
        return sendJson(res, 400, { error: 'project is required' });
      }
      // The project is the payload; the gateway validates it and answers 400
      // with a sentence, so this only forwards the fields the route reads.
      const payload = {
        project: body.project,
        ...(Number.isFinite(Number(body.width)) ? { width: Number(body.width) } : {}),
        ...(Number.isFinite(Number(body.height)) ? { height: Number(body.height) } : {}),
        ...(Number.isFinite(Number(body.seed)) ? { seed: Number(body.seed) } : {}),
        ...(Array.isArray(body.loras) ? { loras: body.loras } : {}),
      };
      const submitted = await requestJson(`${ZIMAGE_URL}/api/ltx-director`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        timeout: 120000,
      });
      return sendJson(res, 202, submitted);
    } catch (e) { return sendJson(res, upstreamStatus(e), { error: e.message }); }
  }
  if (pathname === '/local-ai/episode' && req.method === 'POST') {
    const token = readToken();
    if (!token) return sendJson(res, 500, { error: 'Z-Image token unavailable' });
    try {
      // A joined episode is every shot in one file — the largest thing the
      // studio ever uploads, and the default JSON cap would reject it.
      const body = JSON.parse((await readBody(req, 512 * 1024 * 1024)).toString('utf8') || '{}');
      if (!body.video_base64) return sendJson(res, 400, { error: 'video_base64 is required' });
      const payload = {
        video_base64: body.video_base64,
        shots: Number(body.shots) > 0 ? Math.floor(Number(body.shots)) : 0,
      };
      const submitted = await requestJson(`${ZIMAGE_URL}/api/episode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        timeout: 180000,
      });
      return sendJson(res, 202, submitted);
    } catch (e) { return sendJson(res, upstreamStatus(e), { error: e.message }); }
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
      if (body.run_on) payload.run_on = String(body.run_on).slice(0, 128);
      const submitted = await requestJson(`${ZIMAGE_URL}/api/upscale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      return sendJson(res, 202, submitted);
    } catch (e) { return sendJson(res, upstreamStatus(e), { error: e.message }); }
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
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || HOST}`);
  } catch {
    return sendJson(res, 400, { error: 'Invalid request URL' });
  }
  try {
    if (u.pathname === '/health' || u.pathname === '/healthz') return sendJson(res, 200, { ok: true, service: `${identity.productName} local-inference bridge`, hosted: true, zimage: ZIMAGE_URL });
    // Awaited, so a rejection inside a route lands in THIS catch instead of
    // escaping as an unhandled rejection (which terminates Node 22).
    if (u.pathname.startsWith('/local-ai/')) return await handleLocalAi(req, res, u.pathname, u.searchParams);
    if (u.pathname.startsWith('/api/')) return sendJson(res, 501, { error: 'Cloud Muapi proxy is not enabled in hosted mode; use local Z-Image or the desktop app API-key flow.' });
    return serveStatic(res, u.pathname);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch { /* already closed */ } return undefined; }
    return sendJson(res, 500, { error: 'The local inference bridge hit an unexpected error' });
  }
});
// Last line of defence: log the kind of failure (never a payload — requests
// carry prompts and pictures) and keep serving the other callers.
process.on('unhandledRejection', (reason) => {
  const name = reason && reason.name ? reason.name : typeof reason;
  console.error(`[open-generative-ai-hosted] unhandled rejection (${name}); the bridge stays up`);
});
server.listen(PORT, HOST, () => console.log(`[open-generative-ai-hosted] http://${HOST}:${PORT}`));
