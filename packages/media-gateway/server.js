const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const next = require('next');
const httpProxy = require('http-proxy');
const WebSocket = require('ws');
// sharp (libvips) ships with the Next install; used to serve real downscaled
// thumbnails/previews instead of full-resolution originals. Optional: when it
// is unavailable every route falls back to the previous full-bytes behavior.
let sharp = null;
try { sharp = require('sharp'); } catch { sharp = null; }

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8788);
const internalPort = Number(process.env.INTERNAL_NEXT_PORT || port + 2);
const comfyTarget = process.env.COMFY_HTTP || process.env.COMFY_HTTP_DEFAULT || 'http://127.0.0.1:8188';
function parseComfyLanes() {
  const lanes = [['default', process.env.COMFY_HTTP_DEFAULT || comfyTarget]];
  const raw = process.env.COMFY_LANES || '';
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const [rawName, ...urlParts] = trimmed.split('=');
    const name = rawName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const url = urlParts.join('=').trim().replace(/\/$/, '');
    if (name && url) lanes.push([name, url]);
  }
  return lanes.filter((entry, index, arr) => entry[1] && arr.findIndex((other) => other[1] === entry[1]) === index);
}
const comfyLaneTargets = parseComfyLanes();
const nativeOutputDirs = [
  process.env.ZIMG_OUTPUT_DIR || path.join(process.env.HOME || '', '.comfy-private.noindex/z_image_outputs'),
  process.env.COMFY_OUTPUT_DIR || path.join(process.env.HOME || '', '.comfy-private.noindex/output'),
];
const comfyUrl = new URL(comfyTarget);
function wsTargetForHttpTarget(target) {
  return target.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/$/, '');
}
function originForHttpTarget(target) {
  try {
    return new URL(target).origin;
  } catch {
    return comfyUrl.origin;
  }
}
function normalizeComfyWsPath(pathname) {
  if (pathname.startsWith('/mobile/api/comfy/')) {
    return pathname.replace(/^\/mobile\/api\/comfy/, '') || '/ws';
  }
  if (pathname.startsWith('/comfy/')) {
    return pathname.replace(/^\/comfy/, '') || '/ws';
  }
  return pathname || '/ws';
}
const nextTarget = `http://127.0.0.1:${internalPort}`;
const zimgApiTarget = process.env.ZIMG_API_HTTP || 'http://127.0.0.1:8787';
const mediaStateRoot = process.env.HIVEMIND_MEDIA_STATE_DIR
  || path.join(process.env.HOME || '', '.hivemindos/media-studio');
const gatewayStateDir = process.env.MEDIA_GATEWAY_STATE_DIR
  || path.join(mediaStateRoot, 'state/media-gateway');
const tokenPath = process.env.ZIMG_TOKEN_FILE || path.join(mediaStateRoot, 'secure/zimg-token');
function readWrapperToken() {
  try { return fs.readFileSync(tokenPath, 'utf8').trim(); } catch { return ''; }
}
const comfyPrivateViewToken = (process.env.COMFY_PRIVATE_VIEW_TOKEN || '').trim();

const app = next({ dev, hostname: '127.0.0.1', port: internalPort });
const handle = app.getRequestHandler();
const httpToNext = httpProxy.createProxyServer({
  target: nextTarget,
  changeOrigin: false,
  xfwd: true,
});
const httpToComfy = httpProxy.createProxyServer({
  target: comfyTarget,
  changeOrigin: true,
  xfwd: true,
});
const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
const objectInfoCache = {
  body: null,
  gzipped: null,
  contentType: 'application/json; charset=utf-8',
  fetchedAt: 0,
};
const OBJECT_INFO_CACHE_MS = Number(process.env.OBJECT_INFO_CACHE_MS || 5 * 60 * 1000);

function clientAcceptsGzip(req) {
  return /\bgzip\b/.test(req.headers['accept-encoding'] || '');
}

function appendVary(current, value) {
  if (!current) return value;
  const parts = String(current).split(',').map((part) => part.trim().toLowerCase());
  return parts.includes(value.toLowerCase()) ? current : `${current}, ${value}`;
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, {
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
      },
    }, (upstream) => {
      const chunks = [];
      upstream.on('data', (chunk) => chunks.push(chunk));
      upstream.on('end', () => {
        resolve({
          statusCode: upstream.statusCode || 502,
          statusMessage: upstream.statusMessage || '',
          headers: upstream.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('object_info upstream timeout')));
    req.on('error', reject);
  });
}


function queueWithLane(value, lane) {
  if (!value || typeof value !== 'object') return value;
  const tagTuple = (item) => {
    if (!Array.isArray(item)) return item;
    const next = [...item];
    const extra = next[3] && typeof next[3] === 'object' ? { ...next[3] } : {};
    extra.comfy_lane = lane;
    next[3] = extra;
    return next;
  };
  return {
    ...value,
    queue_running: Array.isArray(value.queue_running) ? value.queue_running.map(tagTuple) : value.queue_running,
    queue_pending: Array.isArray(value.queue_pending) ? value.queue_pending.map(tagTuple) : value.queue_pending,
  };
}

async function fetchJsonFromTarget(target, upstreamPath) {
  const upstream = await fetchBuffer(`${target.replace(/\/$/, '')}${upstreamPath}`);
  const contentType = upstream.headers['content-type'] || '';
  if (upstream.statusCode < 200 || upstream.statusCode >= 300 || !contentType.includes('application/json')) {
    return { upstream, json: null };
  }
  return { upstream, json: JSON.parse(upstream.body.toString('utf8') || '{}') };
}

async function fetchComfyLanesJson(upstreamPath) {
  const results = await Promise.all(comfyLaneTargets.map(async ([lane, target]) => {
    try {
      const { upstream, json } = await fetchJsonFromTarget(target, upstreamPath);
      return { lane, target, upstream, json, error: null };
    } catch (err) {
      return { lane, target, upstream: null, json: null, error: err };
    }
  }));
  return results;
}

function fetchNativeJson(apiPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, zimgApiTarget).toString();
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, {
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
        'x-token': readWrapperToken(),
      },
    }, (upstream) => {
      const chunks = [];
      upstream.on('data', (chunk) => chunks.push(chunk));
      upstream.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if ((upstream.statusCode || 500) < 200 || (upstream.statusCode || 500) >= 300) {
          resolve(null);
          return;
        }
        try { resolve(JSON.parse(body || '{}')); }
        catch (err) { reject(err); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('native history upstream timeout')));
    req.on('error', reject);
  });
}

function parseRecordTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nativeRecordToComfyHistoryItem(record) {
  if (!record || typeof record !== 'object') return null;
  const id = String(record.id || record.prompt_id || '');
  if (!id) return null;
  const status = String(record.status || 'success');
  if (status === 'queued' || status === 'running') return null;
  const isError = status === 'error' || status === 'failed';
  const startedAt = parseRecordTimestamp(record.started_at || record.created_at);
  const finishedAt = parseRecordTimestamp(record.finished_at || record.completed_at || record.updated_at) ?? startedAt;
  const messages = [];
  if (startedAt != null) {
    messages.push(['execution_start', { timestamp: startedAt }]);
  }
  if (finishedAt != null) {
    messages.push([
      isError ? 'execution_error' : 'execution_success',
      {
        timestamp: finishedAt,
        ...(isError && record.error ? { message: String(record.error) } : {}),
      },
    ]);
  }
  const outputs = Array.isArray(record.outputs) ? record.outputs : [];
  const media = { images: [], gifs: [], videos: [] };
  for (const outputPath of outputs) {
    const filename = path.basename(String(outputPath || ''));
    if (!filename) continue;
    const item = { filename, subfolder: '', type: 'output' };
    const ext = path.extname(filename).toLowerCase();
    if (['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'].includes(ext)) {
      media.videos.push(item);
    } else if (['.gif', '.webp'].includes(ext)) {
      media.gifs.push(item);
    } else {
      media.images.push(item);
    }
  }
  const nativeOutputs = {};
  if (media.images.length) nativeOutputs.images = media.images;
  if (media.gifs.length) nativeOutputs.gifs = media.gifs;
  if (media.videos.length) nativeOutputs.videos = media.videos;
  const promptTuple = Array.isArray(record.comfy_prompt)
    ? (() => {
        const tuple = [...record.comfy_prompt];
        // Native history records already store a redacted API graph. Preserve
        // extra_pnginfo.workflow so Mobile can restore from history/image cards;
        // hiding it here makes “load workflow from file/history” fail.
        tuple[2] = {};
        const workflow = workflowFromNativeRecord(record);
        if (workflow) {
          const extra = tuple[3] && typeof tuple[3] === 'object' && !Array.isArray(tuple[3])
            ? { ...tuple[3] }
            : {};
          extra.extra_pnginfo = {
            ...((extra.extra_pnginfo && typeof extra.extra_pnginfo === 'object') ? extra.extra_pnginfo : {}),
            workflow,
          };
          tuple[3] = extra;
        }
        return tuple;
      })()
    : (() => {
        const extra = { backend: record.backend || 'native-mlx' };
        const workflow = workflowFromNativeRecord(record);
        if (workflow) extra.extra_pnginfo = { workflow };
        return [0, id, {}, extra, []];
      })();
  return {
    prompt: promptTuple,
    outputs: Object.keys(nativeOutputs).length ? { native_mlx: nativeOutputs } : {},
    status: {
      status_str: isError ? 'error' : (status === 'queued' || status === 'running' ? status : 'success'),
      completed: status === 'success',
      messages,
    },
  };
}

function nativeRecordsToComfyHistory(records, requestedId = '') {
  const out = {};
  for (const record of Array.isArray(records) ? records : []) {
    const id = String(record?.id || record?.prompt_id || '');
    if (!id) continue;
    if (requestedId && id !== requestedId) continue;
    const item = nativeRecordToComfyHistoryItem(record);
    if (item) out[id] = item;
  }
  return out;
}

async function fetchNativeHistoryMap(requestedId = '') {
  try {
    if (requestedId) {
      const rec = await fetchNativeJson(`/api/job/${encodeURIComponent(requestedId)}`);
      if (rec && !rec.error) return nativeRecordsToComfyHistory([rec], requestedId);
    }
    const data = await fetchNativeJson('/api/history');
    return nativeRecordsToComfyHistory(Array.isArray(data?.history) ? data.history : [], requestedId);
  } catch (err) {
    console.error('[native-history-merge] error:', err && err.message ? err.message : err);
    return {};
  }
}

async function sendMergedHistory(req, res, upstreamPath, requestedId = '') {
  try {
    const [laneResults, nativeMap] = await Promise.all([
      fetchComfyLanesJson(upstreamPath),
      fetchNativeHistoryMap(requestedId),
    ]);
    let comfyMap = {};
    let upstreamStatus = 502;
    let upstreamMessage = 'Bad Gateway';
    for (const result of laneResults) {
      if (result.upstream) {
        upstreamStatus = result.upstream.statusCode || upstreamStatus;
        upstreamMessage = result.upstream.statusMessage || upstreamMessage;
      }
      if (result.json && typeof result.json === 'object' && !Array.isArray(result.json)) {
        comfyMap = { ...comfyMap, ...sanitizeHistoryPayload(result.json) };
        upstreamStatus = 200;
        upstreamMessage = 'OK';
      }
    }
    const merged = { ...comfyMap, ...nativeMap };
    sendJsonResponse(req, res, Object.keys(merged).length || upstreamStatus === 200 ? 200 : upstreamStatus, upstreamMessage, { 'content-type': 'application/json; charset=utf-8' }, merged);
  } catch (err) {
    console.error('[merged-history] error:', err && err.message ? err.message : err);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ComfyUI/native history bad gateway');
    } else if (!res.destroyed) {
      res.destroy();
    }
  }
}

function isEncryptedWorkflowEnvelope(value) {
  return Boolean(
    value && typeof value === 'object'
    && value.encrypted === true
    && value.format === 'comfyui-mobile-encrypted-workflow'
  );
}

function sanitizeExtraData(extra) {
  if (!extra || typeof extra !== 'object') return extra;
  const workflow = extra.extra_pnginfo?.workflow;
  if (!workflow) return extra;
  if (isEncryptedWorkflowEnvelope(workflow)) return extra;
  return {
    ...extra,
    extra_pnginfo: {
      ...extra.extra_pnginfo,
      workflow: '[unencrypted workflow metadata hidden]',
    },
  };
}

function sanitizeQueueTuple(item) {
  if (!Array.isArray(item)) return item;
  const next = [...item];
  // Comfy queue tuple shape: [number, prompt_id, api_prompt, extra_data, outputs_to_execute].
  // api_prompt contains plaintext text-encode inputs, so never expose it through the wrapper.
  next[2] = {};
  next[3] = sanitizeExtraData(next[3]);
  return next;
}

function sanitizeQueuePayload(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    queue_running: Array.isArray(value.queue_running) ? value.queue_running.map(sanitizeQueueTuple) : value.queue_running,
    queue_pending: Array.isArray(value.queue_pending) ? value.queue_pending.map(sanitizeQueueTuple) : value.queue_pending,
  };
}

function sanitizeHistoryItem(item) {
  if (!item || typeof item !== 'object') return item;
  const next = { ...item };
  if (Array.isArray(next.prompt)) {
    // Comfy history prompt shape: [number, prompt_id, api_prompt, extra_data].
    next.prompt = [...next.prompt];
    next.prompt[2] = {};
    next.prompt[3] = sanitizeExtraData(next.prompt[3]);
  }
  return next;
}

function sanitizeHistoryPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeHistoryItem(item)]));
}

function contentTypeForFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

function viewResponseFilename(value) {
  const safeName = path.basename(String(value || '')).replace(/[\r\n"]/g, '_');
  return safeName || '';
}

function contentDispositionForFilename(filename) {
  const safeName = viewResponseFilename(filename);
  if (!safeName) return null;
  return `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function requestViewFilename(req) {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    return viewResponseFilename(url.searchParams.get('filename') || '');
  } catch {
    return '';
  }
}

function isComfyViewRequest(req) {
  try {
    const pathname = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`).pathname;
    return (
      pathname === '/view' ||
      pathname === '/api/view' ||
      pathname === '/comfy/view' ||
      pathname === '/comfy/api/view' ||
      pathname === '/mobile/api/comfy/view' ||
      pathname === '/mobile/api/comfy/api/view'
    );
  } catch {
    return false;
  }
}

function findNativeOutputFile(filename) {
  const safeName = path.basename(String(filename || ''));
  if (!safeName) return null;
  for (const root of nativeOutputDirs) {
    if (!root) continue;
    const rootResolved = path.resolve(root);
    const direct = path.resolve(rootResolved, safeName);
    const encryptedDirect = path.resolve(rootResolved, `${safeName}.zenc`);
    try {
      if (direct.startsWith(rootResolved) && fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
      if (encryptedDirect.startsWith(rootResolved) && fs.existsSync(encryptedDirect) && fs.statSync(encryptedDirect).isFile()) return direct;
    } catch {}
    try {
      const stack = [rootResolved];
      while (stack.length) {
        const dir = stack.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.isFile() && entry.name === safeName) return full;
          else if (entry.isFile() && entry.name === `${safeName}.zenc`) return path.join(dir, safeName);
        }
      }
    } catch {}
  }
  return null;
}

const SCALED_CACHE_DIR = path.join(
  process.env.HOME || '',
  '.comfy-private.noindex/preview-cache/scaled',
);
const SCALABLE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function isScalableImage(filePath) {
  return SCALABLE_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function clampInt(value, min, max, fallback) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function fetchDecryptedNativeBytes(basename) {
  const token = readWrapperToken();
  if (!token) return null;
  try {
    const upstream = await fetch(
      `${zimgApiTarget}/image/${encodeURIComponent(basename)}?token=${encodeURIComponent(token)}`,
      { cache: 'no-store' },
    );
    if (!upstream.ok) return null;
    return Buffer.from(await upstream.arrayBuffer());
  } catch {
    return null;
  }
}

// Render (once) and serve a downscaled JPEG for an output image. Remote tailnet
// clients previously received full-resolution PNGs for every gallery tile and
// preview - multi-MB per image at 2048px - which made the Outputs panel crawl.
// Scaled variants are content-addressed by source mtime/size, so each image is
// decrypted and resized at most once per (size, quality) and then served from
// disk at file-transfer speed.
async function serveScaledNativeImage(req, res, filePath, plainExists, scale) {
  const statSource = plainExists ? filePath : `${filePath}.zenc`;
  const st = fs.statSync(statSource);
  const key = crypto.createHash('sha1')
    .update([filePath, st.mtimeMs, st.size, scale.maxEdge, scale.quality].join('\n'))
    .digest('hex');
  const cacheFile = path.join(SCALED_CACHE_DIR, `${key}.jpg`);
  if (!fs.existsSync(cacheFile)) {
    let input;
    if (plainExists) {
      input = await fs.promises.readFile(filePath);
    } else {
      input = await fetchDecryptedNativeBytes(path.basename(filePath));
      if (!input) throw new Error('decrypted bytes unavailable');
    }
    const out = await sharp(input)
      .rotate()
      .resize({ width: scale.maxEdge, height: scale.maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: scale.quality })
      .toBuffer();
    await fs.promises.mkdir(SCALED_CACHE_DIR, { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, out);
    await fs.promises.rename(tmp, cacheFile);
  }
  const body = await fs.promises.readFile(cacheFile);
  res.writeHead(200, {
    'content-type': 'image/jpeg',
    'content-length': body.length,
    'cache-control': 'private, max-age=86400, immutable',
    'content-disposition': contentDispositionForFilename(path.basename(filePath)) || 'inline',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

function serveNativeOutputView(req, res, url, scale) {
  const filename = url.searchParams.get('filename') || '';
  const filePath = findNativeOutputFile(filename);
  if (!filePath) return false;
  const encryptedPath = `${filePath}.zenc`;
  if (scale && sharp && isScalableImage(filePath)) {
    const plainExists = fs.existsSync(filePath);
    if (plainExists || fs.existsSync(encryptedPath)) {
      serveScaledNativeImage(req, res, filePath, plainExists, scale).catch((err) => {
        console.warn('[scaled-view] falling back to full bytes:', err && err.message ? err.message : err);
        if (!res.headersSent) {
          serveNativeOutputView(req, res, url); // full-bytes path below
        } else if (!res.writableEnded) {
          res.end();
        }
      });
      return true;
    }
  }
  if (!fs.existsSync(filePath) && fs.existsSync(encryptedPath)) {
    const token = readWrapperToken();
    if (!token) return false;
    const upstreamPath = `/image/${encodeURIComponent(path.basename(filePath))}?token=${encodeURIComponent(token)}`;
    const upstreamUrl = new URL(upstreamPath, zimgApiTarget);
    const lib = upstreamUrl.protocol === 'https:' ? https : http;
    const upstreamReq = lib.request(upstreamUrl, {
      method: req.method,
      headers: { accept: req.headers.accept || '*/*' },
    }, (upstream) => {
      const headers = {
        'content-type': upstream.headers['content-type'] || contentTypeForFilename(filePath),
        'cache-control': 'private, max-age=10800',
        'content-disposition': contentDispositionForFilename(path.basename(filePath)) || 'inline',
      };
      if (upstream.headers['content-length']) headers['content-length'] = upstream.headers['content-length'];
      res.writeHead(upstream.statusCode || 502, headers);
      if (req.method === 'HEAD') {
        upstream.resume();
        res.end();
      } else {
        upstream.pipe(res);
      }
    });
    upstreamReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Failed to decrypt encrypted output');
    });
    upstreamReq.end();
    return true;
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'content-type': contentTypeForFilename(filePath),
    'content-length': stat.size,
    'cache-control': 'private, max-age=10800',
    'content-disposition': contentDispositionForFilename(path.basename(filePath)) || 'inline',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function sendJsonResponse(req, res, statusCode, statusMessage, headers, value) {
  const body = Buffer.from(JSON.stringify(value));
  const responseHeaders = {
    'content-type': headers['content-type'] || 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
  };
  let responseBody = body;
  if (clientAcceptsGzip(req) && body.length > 1024) {
    responseBody = zlib.gzipSync(body, { level: 6 });
    responseHeaders['content-encoding'] = 'gzip';
    responseHeaders.vary = 'Accept-Encoding';
  }
  responseHeaders['content-length'] = responseBody.length;
  res.writeHead(statusCode, statusMessage, responseHeaders);
  if (req.method !== 'HEAD') res.end(responseBody); else res.end();
}

function isEncryptedWorkflowEnvelope(value) {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value)
      && value.encrypted === true
      && value.format === 'comfyui-mobile-encrypted-workflow'
      && typeof value.iterations === 'number'
      && typeof value.salt === 'string'
      && typeof value.iv === 'string'
      && typeof value.data === 'string'
  );
}

function isWorkflowLike(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.nodes));
}

function plaintextWorkflowMetadataAllowed() {
  return /^(1|true|yes|on)$/i.test(process.env.COMFY_MOBILE_ALLOW_PLAINTEXT_IMAGE_WORKFLOW || '');
}

function privateWorkflowMetadata(value) {
  if (isEncryptedWorkflowEnvelope(value)) return value;
  if (plaintextWorkflowMetadataAllowed() && isWorkflowLike(value)) return value;
  return null;
}

function parsePrivateWorkflowMetadata(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return privateWorkflowMetadata(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return privateWorkflowMetadata(value);
}

function workflowFromMobileMetadataPayload(data) {
  if (!data || typeof data !== 'object') return null;
  return parsePrivateWorkflowMetadata(data.workflow);
}

function sanitizedMobileMetadataPayload(data, workflow) {
  return {
    ...(data && typeof data === 'object' ? data : {}),
    workflow,
    prompt: undefined,
  };
}

function isNativeExactWorkflowMetadata(value) {
  if (isEncryptedWorkflowEnvelope(value)) return true;
  if (!isWorkflowLike(value)) return false;
  const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  if (nodes.length < 2) return false;
  return nodes.some((node) => {
    const type = String(node?.type || node?.class_type || '');
    return ['CLIPTextEncode', 'SamplerCustomAdvanced', 'KSampler', 'KSamplerAdvanced', 'SaveImage', 'SaveImageWebsocket'].includes(type);
  });
}

function isBigLoveKlein3NativeFilename(filename) {
  const name = path.basename(String(filename || '')).toLowerCase();
  return /^biglove_klein3_mlx_[a-f0-9]+\.png$/.test(name);
}

function isBigLoveKlein3NativeRecord(record) {
  if (!record || typeof record !== 'object') return false;
  const backend = String(record.backend || '').toLowerCase();
  if (backend.includes('biglove') && backend.includes('klein3')) return true;
  return Array.isArray(record.outputs) && record.outputs.some((out) => {
    return isBigLoveKlein3NativeFilename(out);
  });
}

function decryptWorkflowEnvelope(value) {
  if (!isEncryptedWorkflowEnvelope(value)) return value;
  const token = readWrapperToken();
  if (!token) return value;
  try {
    const key = crypto.pbkdf2Sync(Buffer.from(token), Buffer.from(value.salt, 'base64'), value.iterations, 32, 'sha256');
    const encrypted = Buffer.from(value.data, 'base64');
    if (encrypted.length < 17) return value;
    const ciphertext = encrypted.subarray(0, encrypted.length - 16);
    const authTag = encrypted.subarray(encrypted.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString('utf8'));
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.nodes) ? parsed : value;
  } catch {
    return value;
  }
}

function workflowFromNativeRecord(record) {
  const promptTuple = Array.isArray(record?.comfy_prompt) ? record.comfy_prompt : [];
  const extra = promptTuple[3] && typeof promptTuple[3] === 'object' ? promptTuple[3] : {};
  const workflow = extra.extra_pnginfo?.workflow || extra.workflow || record?.workflow;
  if (workflow) {
    return parsePrivateWorkflowMetadata(workflow);
  }
  return null;
}

function apiPromptFromNativeRecord(record) {
  if (record?.prompt && typeof record.prompt === 'object') return record.prompt;
  const promptTuple = Array.isArray(record?.comfy_prompt) ? record.comfy_prompt : [];
  return promptTuple[2] && typeof promptTuple[2] === 'object' ? promptTuple[2] : null;
}

async function findNativeRecordForFilename(filename) {
  const safeName = path.basename(String(filename || ''));
  if (!safeName) return null;
  const data = await fetchNativeJson('/api/history');
  const records = Array.isArray(data?.history) ? data.history : [];
  const apiRecord = records.find((record) => Array.isArray(record?.outputs) && record.outputs.some((out) => path.basename(String(out || '')) === safeName));
  if (apiRecord) return apiRecord;

  const localHistory = path.join(gatewayStateDir, 'history.jsonl');
  try {
    const lines = fs.readFileSync(localHistory, 'utf8').split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let record;
      try { record = JSON.parse(lines[i]); } catch { continue; }
      if (Array.isArray(record?.outputs) && record.outputs.some((out) => path.basename(String(out || '')) === safeName)) {
        return record;
      }
    }
  } catch {}
  return null;
}

function extractPngTextChunks(buffer) {
  const out = {};
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return out;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) return out;
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (length < 0 || chunkEnd > buffer.length) break;
    if (type === 'tEXt') {
      const sep = buffer.indexOf(0, dataStart);
      if (sep >= dataStart && sep < dataEnd) {
        const key = buffer.subarray(dataStart, sep).toString('latin1');
        const value = buffer.subarray(sep + 1, dataEnd).toString('utf8');
        out[key] = value;
      }
    }
    offset = chunkEnd;
    if (type === 'IEND') break;
  }
  return out;
}

async function workflowFromNativeImageMetadata(filename) {
  const safeName = path.basename(String(filename || ''));
  if (!safeName || !findNativeOutputFile(safeName)) return null;
  const token = readWrapperToken();
  if (!token) return null;
  try {
    const imageUrl = new URL(`/image/${encodeURIComponent(safeName)}?token=${encodeURIComponent(token)}`, zimgApiTarget);
    const upstream = await fetchBuffer(imageUrl.toString());
    const contentType = String(upstream.headers['content-type'] || '');
    if (upstream.statusCode < 200 || upstream.statusCode >= 300 || !contentType.includes('image/')) return null;
    const text = extractPngTextChunks(upstream.body);
    const rawWorkflow = text.workflow || text.Workflow;
    if (!rawWorkflow) return null;
    const parsed = JSON.parse(rawWorkflow);
    return privateWorkflowMetadata(parsed);
  } catch {
    return null;
  }
}

async function workflowFromOutputIndexRequest(req) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const rel = url.searchParams.get('path') || url.searchParams.get('filename') || '';
    const base = path.basename(rel);
    if (!base) return null;
    const token = readWrapperToken();
    if (!token) return null;
    const upstream = await fetch(
      `${zimgApiTarget}/workflow-for-output?filename=${encodeURIComponent(base)}&token=${encodeURIComponent(token)}`,
      { cache: 'no-store' },
    );
    if (!upstream.ok) return null;
    const data = await upstream.json();
    return data && data.workflow ? data : null;
  } catch {
    return null;
  }
}

async function nativeMetadataForRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const filename = url.searchParams.get('path') || '';
  const record = await findNativeRecordForFilename(filename);
  const workflow = record
    ? workflowFromNativeRecord(record) || await workflowFromNativeImageMetadata(filename)
    : await workflowFromNativeImageMetadata(filename);
  if (!workflow) return null;
  return { workflow, record };
}

function nativeBigLoveFileExistsForRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const filename = url.searchParams.get('path') || '';
  return Boolean(isBigLoveKlein3NativeFilename(filename) && findNativeOutputFile(filename));
}

async function sendMobileFileMetadata(req, res) {
  try {
    const upstream = await fetchBuffer(`${comfyTarget.replace(/\/$/, '')}${req.url}`);
    const contentType = upstream.headers['content-type'] || '';
    const upstreamJsonOk = upstream.statusCode >= 200 && upstream.statusCode < 300 && contentType.includes('application/json');
    if (upstreamJsonOk) {
      const data = JSON.parse(upstream.body.toString('utf8'));
      const workflow = workflowFromMobileMetadataPayload(data);
      if (workflow) {
        sendJsonResponse(req, res, upstream.statusCode, upstream.statusMessage, upstream.headers, sanitizedMobileMetadataPayload(data, workflow));
        return;
      }
    }

    const native = await nativeMetadataForRequest(req);
    if (native && native.workflow) {
      sendJsonResponse(req, res, 200, 'OK', { 'content-type': 'application/json; charset=utf-8' }, {
        workflow: native.workflow || null,
        native: true,
      });
      return;
    }

    // The frontend's "Load workflow" and debug-copy paths call
    // /mobile/api/file-metadata. For encrypted outputs, Comfy's upstream mobile
    // metadata route only sees the missing plaintext PNG and returns
    // "File not found", so consult the persistent output -> encrypted workflow
    // index here too (image-metadata already does this below).
    const indexed = await workflowFromOutputIndexRequest(req);
    if (indexed) {
      const workflow = workflowFromMobileMetadataPayload(indexed);
      if (workflow) {
        sendJsonResponse(req, res, 200, 'OK', { 'content-type': 'application/json; charset=utf-8' }, sanitizedMobileMetadataPayload(indexed, workflow));
        return;
      }
    }

    if (nativeBigLoveFileExistsForRequest(req)) {
      sendJsonResponse(req, res, 404, 'Not Found', { 'content-type': 'application/json; charset=utf-8' }, {
        error: 'No exact workflow metadata found for this native BigLove output',
        native: true,
      });
      return;
    }

    if (upstreamJsonOk) {
      sendJsonResponse(req, res, 404, 'Not Found', { 'content-type': 'application/json; charset=utf-8' }, {
        error: 'No encrypted workflow metadata found',
      });
      return;
    }

    res.writeHead(upstream.statusCode, {
      'content-type': contentType || 'text/plain; charset=utf-8',
      'content-length': upstream.body.length,
      'cache-control': 'no-store, max-age=0',
    });
    if (req.method !== 'HEAD') res.end(upstream.body); else res.end();
  } catch (err) {
    console.error('[mobile-file-metadata] error:', err && err.message ? err.message : err);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'mobile file metadata bad gateway' }));
    }
  }
}

async function sendMobileWorkflowAvailability(req, res) {
  try {
    const upstream = await fetchBuffer(`${comfyTarget.replace(/\/$/, '')}${req.url}`);
    const contentType = upstream.headers['content-type'] || '';
    if (upstream.statusCode >= 200 && upstream.statusCode < 300 && contentType.includes('application/json')) {
      const data = JSON.parse(upstream.body.toString('utf8'));
      const workflow = workflowFromMobileMetadataPayload(data);
      sendJsonResponse(req, res, upstream.statusCode, upstream.statusMessage, upstream.headers, {
        available: Boolean(workflow),
      });
      return;
    }
    const native = await nativeMetadataForRequest(req);
    const nativeExists = nativeBigLoveFileExistsForRequest(req);
    const indexed = await workflowFromOutputIndexRequest(req);
    const indexedWorkflow = indexed ? workflowFromMobileMetadataPayload(indexed) : null;
    sendJsonResponse(req, res, 200, 'OK', { 'content-type': 'application/json; charset=utf-8' }, {
      available: Boolean((native && (native.workflow || native.prompt)) || indexedWorkflow),
      native: Boolean(native) || nativeExists,
      indexed: Boolean(indexedWorkflow),
    });
  } catch (err) {
    console.error('[mobile-workflow-availability] error:', err && err.message ? err.message : err);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'mobile workflow availability bad gateway' }));
    }
  }
}

async function sendMobileImageMetadata(req, res) {
  try {
    const upstream = await fetchBuffer(`${comfyTarget.replace(/\/$/, '')}${req.url}`);
    const contentType = upstream.headers['content-type'] || '';
    const upstreamJsonOk = upstream.statusCode >= 200 && upstream.statusCode < 300 && contentType.includes('application/json');
    if (upstreamJsonOk) {
      const data = JSON.parse(upstream.body.toString('utf8'));
      const workflow = workflowFromMobileMetadataPayload(data);
      if (workflow) {
        sendJsonResponse(req, res, upstream.statusCode, upstream.statusMessage, upstream.headers, sanitizedMobileMetadataPayload(data, workflow));
        return;
      }
    }
    const native = await nativeMetadataForRequest(req);
    if (native && native.workflow) {
      sendJsonResponse(req, res, 200, 'OK', { 'content-type': 'application/json; charset=utf-8' }, { workflow: native.workflow || null, native: true });
      return;
    }
    // Outputs never embed workflows (--disable-metadata) and Comfy's history
    // dies on restart, so the native API keeps a persistent filename ->
    // encrypted-envelope index harvested from lane history. Consult it before
    // giving up: this is what makes "load workflow from image" survive both
    // restarts and output encryption.
    const indexed = await workflowFromOutputIndexRequest(req);
    if (indexed) {
      const workflow = workflowFromMobileMetadataPayload(indexed);
      if (workflow) {
        sendJsonResponse(req, res, 200, 'OK', { 'content-type': 'application/json; charset=utf-8' }, sanitizedMobileMetadataPayload(indexed, workflow));
        return;
      }
    }
    if (upstreamJsonOk) {
      sendJsonResponse(req, res, 404, 'Not Found', { 'content-type': 'application/json; charset=utf-8' }, {
        error: 'No encrypted workflow metadata found',
      });
      return;
    }
    // The upstream custom node says "File not found" for encrypted outputs
    // (it only sees plaintext); if the encrypted sidecar exists the file is
    // fine - there is just no workflow recorded for it anywhere.
    {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const rel = url.searchParams.get('path') || url.searchParams.get('filename') || '';
      const candidate = rel ? findNativeOutputFile(path.basename(rel)) : null;
      if (candidate && !fs.existsSync(candidate) && fs.existsSync(`${candidate}.zenc`)) {
        sendJsonResponse(req, res, 404, 'Not Found', { 'content-type': 'application/json; charset=utf-8' }, {
          error: 'No workflow recorded for this image (it predates the workflow index)',
        });
        return;
      }
    }
    res.writeHead(upstream.statusCode, {
      'content-type': contentType || 'text/plain; charset=utf-8',
      'content-length': upstream.body.length,
      'cache-control': 'no-store, max-age=0',
    });
    if (req.method !== 'HEAD') res.end(upstream.body); else res.end();
  } catch (err) {
    console.error('[mobile-image-metadata] error:', err && err.message ? err.message : err);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'mobile image metadata bad gateway' }));
    }
  }
}

async function sendRedactedComfyJson(req, res, upstreamPath, sanitizer) {
  try {
    const laneResults = await fetchComfyLanesJson(upstreamPath);
    if (upstreamPath === '/queue') {
      const merged = { queue_running: [], queue_pending: [] };
      for (const result of laneResults) {
        if (!result.json) continue;
        const tagged = queueWithLane(result.json, result.lane);
        if (Array.isArray(tagged.queue_running)) merged.queue_running.push(...tagged.queue_running);
        if (Array.isArray(tagged.queue_pending)) merged.queue_pending.push(...tagged.queue_pending);
      }
      sendJsonResponse(req, res, 200, 'OK', { 'content-type': 'application/json; charset=utf-8' }, sanitizer(merged));
      return;
    }
    const first = laneResults.find((result) => result.json || result.upstream)?.upstream;
    if (!first) throw new Error('no Comfy lane responded');
    const result = laneResults.find((entry) => entry.json);
    if (!result) {
      const contentType = first.headers['content-type'] || '';
      res.writeHead(first.statusCode || 502, {
        'content-type': contentType || 'text/plain; charset=utf-8',
        'content-length': first.body.length,
        'cache-control': 'no-store, max-age=0',
      });
      if (req.method !== 'HEAD') res.end(first.body); else res.end();
      return;
    }
    sendJsonResponse(req, res, result.upstream.statusCode, result.upstream.statusMessage, result.upstream.headers, sanitizer(result.json));
  } catch (err) {
    console.error('[redacted-comfy-json] error:', err && err.message ? err.message : err);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ComfyUI redacted JSON bad gateway');
    } else if (!res.destroyed) {
      res.destroy();
    }
  }
}

async function sendObjectInfo(req, res) {
  try {
    const now = Date.now();
    if (!objectInfoCache.body || now - objectInfoCache.fetchedAt > OBJECT_INFO_CACHE_MS) {
      const upstream = await fetchBuffer(`${comfyTarget.replace(/\/$/, '')}/api/object_info`);
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        res.writeHead(upstream.statusCode, {
          'content-type': upstream.headers['content-type'] || 'text/plain; charset=utf-8',
          'content-length': upstream.body.length,
          'cache-control': 'no-store, max-age=0',
        });
        if (req.method !== 'HEAD') res.end(upstream.body); else res.end();
        return;
      }
      objectInfoCache.body = upstream.body;
      objectInfoCache.gzipped = zlib.gzipSync(upstream.body, { level: 6 });
      objectInfoCache.contentType = upstream.headers['content-type'] || 'application/json; charset=utf-8';
      objectInfoCache.fetchedAt = now;
    }

    const useGzip = clientAcceptsGzip(req) && objectInfoCache.gzipped.length < objectInfoCache.body.length;
    const body = useGzip ? objectInfoCache.gzipped : objectInfoCache.body;
    const headers = {
      'content-type': objectInfoCache.contentType,
      'cache-control': 'private, max-age=300',
      'content-length': body.length,
    };
    if (useGzip) {
      headers['content-encoding'] = 'gzip';
      headers.vary = appendVary(headers.vary, 'Accept-Encoding');
    }
    res.writeHead(200, headers);
    if (req.method !== 'HEAD') res.end(body); else res.end();
  } catch (err) {
    console.error('[object-info-cache] error:', err && err.message ? err.message : err);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ComfyUI object_info bad gateway');
    } else if (!res.destroyed) {
      res.destroy();
    }
  }
}

httpToNext.on('error', (err, req, res) => {
  console.error('[next-proxy] error:', err && err.message ? err.message : err);
  if (res && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad gateway');
  } else if (res && !res.destroyed) {
    res.destroy();
  }
});

httpToComfy.on('proxyReq', (proxyReq) => {
  // Browser-origin requests to the wrapper include Origin/Referer for POSTs.
  // ComfyUI rejects those as cross-origin because the upstream host is 127.0.0.1:8188,
  // which caused mobile actions such as Recent workflow persistence to 403.
  proxyReq.removeHeader('origin');
  proxyReq.removeHeader('referer');
  if (comfyPrivateViewToken) {
    proxyReq.setHeader('X-ZImage-Private-View-Token', comfyPrivateViewToken);
  }
});

httpToComfy.on('proxyRes', (proxyRes, req) => {
  if (!isComfyViewRequest(req)) return;
  const disposition = contentDispositionForFilename(requestViewFilename(req));
  if (disposition) proxyRes.headers['content-disposition'] = disposition;
});

httpToComfy.on('error', (err, req, res) => {
  console.error('[comfy-proxy] error:', err && err.message ? err.message : err);
  if (res && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ComfyUI bad gateway');
  } else if (res && !res.destroyed) {
    res.destroy();
  }
});

function proxyComfyWebSocket(req, socket, head) {
  // The public :8788 server owns /ws before Next sees the upgrade. This avoids
  // Next/custom-server upgrade interference that previously injected a ComfyUI
  // wrapper-origin 403 after the first status frame.
  wss.handleUpgrade(req, socket, head, (client) => {
    const source = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const upstreamPath = normalizeComfyWsPath(source.pathname);
    const upstreams = comfyLaneTargets.map(([lane, target]) => ({
      lane,
      socket: new WebSocket(`${wsTargetForHttpTarget(target)}${upstreamPath}${source.search}`, {
        headers: { Origin: originForHttpTarget(target) },
        perMessageDeflate: false,
      }),
    }));

    let closed = false;
    const closeAll = () => {
      if (closed) return;
      closed = true;
      try { if (client.readyState === WebSocket.OPEN) client.close(1000, 'proxy closing'); } catch {}
      for (const { socket: upstream } of upstreams) {
        try { if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, 'proxy closing'); } catch {}
      }
      setTimeout(() => {
        try { if (client.readyState !== WebSocket.CLOSED) client.terminate(); } catch {}
        for (const { socket: upstream } of upstreams) {
          try { if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate(); } catch {}
        }
      }, 1000).unref();
    };

    const closeIfNoLaneAlive = () => {
      if (closed) return;
      const laneAlive = upstreams.some(({ socket: upstream }) => (
        upstream.readyState === WebSocket.CONNECTING ||
        upstream.readyState === WebSocket.OPEN
      ));
      if (!laneAlive) closeAll();
    };

    for (const { lane, socket: upstream } of upstreams) {
      upstream.on('message', (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(isBinary ? data : data.toString());
      });
      upstream.on('close', closeIfNoLaneAlive);
      upstream.on('error', (err) => {
        console.error(`[ws-proxy:${lane}] upstream error:`, err && err.message ? err.message : err);
        closeIfNoLaneAlive();
      });
    }
    // ComfyUI Mobile listens for server-side events and does not need to send
    // app messages upstream. Keeping this one-way also prevents upgrade-buffer
    // artifacts from ever reaching ComfyUI as a second HTTP request.
    client.on('close', closeAll);
    client.on('error', closeAll);
  });
}


function proxyPromptToNativeApi(req, res) {
  const chunks = [];
  let total = 0;
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > 5 * 1024 * 1024) {
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'prompt body too large' }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let upstreamBody = body;
    try {
      const contentType = String(req.headers['content-type'] || '');
      if (contentType.includes('application/json')) {
        const payload = JSON.parse(body.toString('utf8') || '{}');
        const promptAssistantRepairs = repairPromptAssistantFinalInputs(payload);
        const repairs = promptAssistantRepairs + repairMissingSamplerNegativeConditioning(payload);
        if (repairs > 0) {
          upstreamBody = Buffer.from(JSON.stringify(payload));
          if (promptAssistantRepairs > 0) {
            console.warn(`[mobile-prompt-repair] repaired ${promptAssistantRepairs} Prompt Assistant input(s)`);
          }
          if (repairs > promptAssistantRepairs) {
            console.warn(`[mobile-prompt-repair] added fallback negative conditioning for ${repairs - promptAssistantRepairs} sampler node(s)`);
          }
        }
      }
    } catch (err) {
      console.warn('[mobile-prompt-repair] skipped prompt repair:', err && err.message ? err.message : err);
    }
    const target = new URL(req.url, zimgApiTarget);
    const token = readWrapperToken();
    const headers = {
      'content-type': req.headers['content-type'] || 'application/json',
      'content-length': String(upstreamBody.length),
      'x-token': token,
      'accept': req.headers.accept || 'application/json',
    };
    const upstreamReq = http.request(target, { method: req.method, headers }, (upstream) => {
      const responseChunks = [];
      upstream.on('data', (chunk) => responseChunks.push(chunk));
      upstream.on('end', () => {
        const responseBody = Buffer.concat(responseChunks);
        res.writeHead(upstream.statusCode || 502, {
          'content-type': upstream.headers['content-type'] || 'application/json; charset=utf-8',
          'cache-control': 'no-store, max-age=0',
          'content-length': responseBody.length,
        });
        res.end(responseBody);
      });
    });
    upstreamReq.setTimeout(30000, () => upstreamReq.destroy(new Error('native prompt intercept timeout')));
    upstreamReq.on('error', (err) => {
      console.error('[native-prompt-intercept] error:', err && err.message ? err.message : err);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'native prompt intercept bad gateway' }));
      } else if (!res.destroyed) {
        res.destroy();
      }
    });
    upstreamReq.end(upstreamBody);
  });
  req.on('error', (err) => {
    console.error('[native-prompt-intercept] request error:', err && err.message ? err.message : err);
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'bad prompt request' }));
    }
  });
}

function isPromptLink(value) {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string' && typeof value[1] === 'number';
}

function promptNodeClass(node) {
  return String(node && typeof node === 'object' ? node.class_type || '' : '');
}

function firstLinkedClipFromConditioning(prompt, conditioning) {
  if (!isPromptLink(conditioning)) return null;
  const source = prompt[conditioning[0]];
  if (!source || typeof source !== 'object') return null;
  const inputs = source.inputs && typeof source.inputs === 'object' ? source.inputs : {};
  if (isPromptLink(inputs.clip)) return inputs.clip;
  return null;
}

function bestNegativeTextFromPrompt(prompt, excludeKey) {
  const negativePattern = /\b(worst|low quality|score_[123]|blurry|jpeg|artifact|lowres|censor|bad|negative)\b/i;
  let fallback = '';
  for (const [key, node] of Object.entries(prompt)) {
    if (key === excludeKey || promptNodeClass(node) !== 'CLIPTextEncode') continue;
    const text = node && typeof node === 'object' && node.inputs && typeof node.inputs === 'object'
      ? node.inputs.text
      : '';
    if (typeof text !== 'string') continue;
    if (!fallback) fallback = text;
    if (negativePattern.test(text)) return text;
  }
  return fallback;
}

function workflowFromPromptPayload(payload) {
  const extra = payload && typeof payload === 'object' && payload.extra_data && typeof payload.extra_data === 'object'
    ? payload.extra_data
    : {};
  const workflow = extra.extra_pnginfo?.workflow || extra.workflow || payload.workflow;
  return workflow ? decryptWorkflowEnvelope(workflow) : null;
}

function workflowWidgetIndex(workflow, nodeId, widgetName, fallback) {
  const direct = workflow?.widget_idx_map?.[String(nodeId)]?.[widgetName];
  if (Number.isInteger(direct)) return direct;
  const extra = workflow?.extra?.widget_idx_map?.[String(nodeId)]?.[widgetName];
  if (Number.isInteger(extra)) return extra;
  return fallback;
}

function workflowNodeById(workflow, nodeId) {
  if (!workflow || typeof workflow !== 'object' || !Array.isArray(workflow.nodes)) return null;
  return workflow.nodes.find((node) => String(node?.id) === String(nodeId)) || null;
}

function workflowWidgetValue(workflow, nodeId, widgetName, fallbackIndex) {
  const node = workflowNodeById(workflow, nodeId);
  if (!node) return undefined;
  const values = node.widgets_values;
  if (Array.isArray(values)) {
    const index = workflowWidgetIndex(workflow, nodeId, widgetName, fallbackIndex);
    return Number.isInteger(index) ? values[index] : undefined;
  }
  if (values && typeof values === 'object') {
    return values[widgetName] ?? values[String(fallbackIndex)];
  }
  return undefined;
}

function looksLikeStructuredPositivePrompt(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return false;
  return (
    (text.startsWith('{') &&
      (text.includes('"high_level_description"') ||
        text.includes('"compositional_deconstruction"'))) ||
    (/"bbox"\s*:/.test(text) && /"desc"\s*:/.test(text))
  );
}

function repairPromptAssistantFinalInputs(payload) {
  if (!payload || typeof payload !== 'object' || !payload.prompt || typeof payload.prompt !== 'object') {
    return 0;
  }
  const workflow = workflowFromPromptPayload(payload);
  let repairCount = 0;
  for (const [key, node] of Object.entries(payload.prompt)) {
    if (promptNodeClass(node) !== 'PromptAssistantGenerate') continue;
    const inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : null;
    if (!inputs) continue;

    if (inputs.idea !== '') {
      inputs.idea = '';
      repairCount += 1;
    }
    inputs.context = '';
    inputs.image_caption = '';
    inputs.extra_instructions = '';
    if (inputs.emit_ui_text !== true) {
      inputs.emit_ui_text = true;
      repairCount += 1;
    }
    if (inputs.auto_generate_on_queue !== false) {
      inputs.auto_generate_on_queue = false;
      repairCount += 1;
    }

    const workflowPrompt = workflowWidgetValue(workflow, key, 'prompt', 8);
    if (typeof workflowPrompt === 'string' && workflowPrompt !== inputs.prompt) {
      inputs.prompt = workflowPrompt;
      repairCount += 1;
    } else if (inputs.prompt == null) {
      inputs.prompt = '';
      repairCount += 1;
    }

    const workflowNegative = workflowWidgetValue(workflow, key, 'negative_prompt', 9);
    if (typeof workflowNegative === 'string' && workflowNegative !== inputs.negative_prompt) {
      inputs.negative_prompt = workflowNegative;
      repairCount += 1;
    } else if (inputs.negative_prompt == null) {
      inputs.negative_prompt = '';
      repairCount += 1;
    }

    if (inputs.helper_mode == null || String(inputs.helper_mode).trim() === '') {
      inputs.helper_mode = 'None';
      repairCount += 1;
    }

    if (String(inputs.prompt || '').trim() === '' && looksLikeStructuredPositivePrompt(inputs.negative_prompt)) {
      inputs.prompt = inputs.negative_prompt;
      inputs.negative_prompt = '';
      repairCount += 1;
    }
  }
  return repairCount;
}

function repairMissingSamplerNegativeConditioning(payload) {
  if (!payload || typeof payload !== 'object' || !payload.prompt || typeof payload.prompt !== 'object') {
    return 0;
  }
  const prompt = payload.prompt;
  let repairCount = 0;
  for (const [key, node] of Object.entries(prompt)) {
    const classType = promptNodeClass(node);
    if (classType !== 'KSampler' && classType !== 'KSamplerAdvanced') continue;
    const inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : null;
    if (!inputs || inputs.negative !== undefined) continue;

    const positiveSourceKey = isPromptLink(inputs.positive) ? inputs.positive[0] : '';
    const clip = firstLinkedClipFromConditioning(prompt, inputs.positive);
    if (!clip) continue;

    const fallbackKey = `__server_fallback_negative_${String(key).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    if (!prompt[fallbackKey]) {
      prompt[fallbackKey] = {
        class_type: 'CLIPTextEncode',
        inputs: {
          clip,
          text: bestNegativeTextFromPrompt(prompt, positiveSourceKey),
        },
      };
    }
    inputs.negative = [fallbackKey, 0];
    repairCount += 1;
  }
  return repairCount;
}

app.prepare().then(() => {
  const nextServer = http.createServer((req, res) => handle(req, res));
  nextServer.listen(internalPort, '127.0.0.1', () => {
    console.log(`Next internal server listening on http://127.0.0.1:${internalPort}`);
  });

  const publicServer = http.createServer((req, res) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    } catch {
      pathname = req.url || '';
    }

    if ((pathname === '/comfy/api/queue' || pathname === '/comfy/queue' || pathname === '/api/queue' || pathname === '/queue') && (req.method === 'GET' || req.method === 'HEAD')) {
      sendRedactedComfyJson(req, res, '/queue', sanitizeQueuePayload);
      return;
    }

    if ((pathname === '/comfy/api/history' || pathname === '/comfy/history' || pathname === '/api/history' || pathname === '/history' || pathname.startsWith('/comfy/api/history/') || pathname.startsWith('/comfy/history/') || pathname.startsWith('/api/history/') || pathname.startsWith('/history/')) && (req.method === 'GET' || req.method === 'HEAD')) {
      let upstreamPath = pathname;
      if (upstreamPath.startsWith('/comfy/api')) upstreamPath = upstreamPath.replace(/^\/comfy\/api/, '');
      else if (upstreamPath.startsWith('/comfy')) upstreamPath = upstreamPath.replace(/^\/comfy/, '');
      upstreamPath = upstreamPath + (new URL(req.url, `http://${req.headers.host || 'localhost'}`).search || '');
      const match = pathname.match(/\/(?:api\/)?history\/([^/?#]+)/);
      sendMergedHistory(req, res, upstreamPath, match ? decodeURIComponent(match[1]) : '');
      return;
    }

    if ((pathname === '/comfy/api/object_info' || pathname === '/api/object_info') && (req.method === 'GET' || req.method === 'HEAD')) {
      sendObjectInfo(req, res);
      return;
    }

    if (pathname === '/workflow-key' && (req.method === 'GET' || req.method === 'HEAD')) {
      // Deprecated: old builds exposed a backend-derived workflow metadata key.
      // ComfyUI Mobile now uses a user-only browser unlock key, kept only in
      // loaded-tab memory, so the wrapper must not return any decrypt key.
      sendJsonResponse(req, res, 410, 'Gone', { 'content-type': 'application/json; charset=utf-8' }, { error: 'workflow key endpoint disabled; unlock in the browser' });
      return;
    }

    if ((pathname === '/comfy/view' || pathname === '/comfy/api/view' || pathname === '/view' || pathname === '/api/view') && (req.method === 'GET' || req.method === 'HEAD')) {
      const source = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      // A preview param means the caller wants display bytes, not the original:
      // serve a downscaled JPEG (rendered once, cached). Full-quality requests
      // (no preview param - downloads, pixel-exact viewing) keep original bytes.
      const previewParam = source.searchParams.get('preview');
      const scale = previewParam
        ? { maxEdge: 2048, quality: clampInt((previewParam.split(';')[1] || '').trim(), 50, 95, 88) }
        : undefined;
      if (serveNativeOutputView(req, res, source, scale)) return;
    }

    if (pathname === '/mobile/api/file-metadata' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendMobileFileMetadata(req, res);
      return;
    }

    if (pathname === '/mobile/api/workflow-availability' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendMobileWorkflowAvailability(req, res);
      return;
    }

    if (pathname === '/mobile/api/image-metadata' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendMobileImageMetadata(req, res);
      return;
    }

    if ((pathname === '/mobile/api/preview' || pathname === '/mobile/api/thumbnail') && (req.method === 'GET' || req.method === 'HEAD')) {
      const source = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const isThumbnail = pathname === '/mobile/api/thumbnail';
      const scale = isThumbnail
        ? { maxEdge: clampInt(source.searchParams.get('maxedge'), 64, 640, 320), quality: 80 }
        : { maxEdge: clampInt(source.searchParams.get('maxedge'), 320, 2048, 960), quality: 84 };
      if (serveNativeOutputView(req, res, source, scale)) return;
    }


    if ((pathname === '/comfy/api/prompt' || pathname === '/comfy/prompt' || pathname === '/api/prompt' || pathname === '/prompt') && req.method === 'POST') {
      proxyPromptToNativeApi(req, res);
      return;
    }

    if ((pathname === '/api/queue' || pathname === '/queue' || pathname === '/api/history' || pathname === '/history' || pathname === '/api/interrupt' || pathname === '/interrupt') && req.method !== 'GET' && req.method !== 'HEAD') {
      req.url = req.url.replace(/^\/api/, '') || '/';
      httpToComfy.web(req, res);
      return;
    }

    if (pathname.startsWith('/comfy/')) {
      req.url = req.url.replace(/^\/comfy/, '') || '/';
      httpToComfy.web(req, res);
      return;
    }

    // Safety net for older/cached ComfyUI Mobile bundles that still call bare
    // Comfy endpoints. Without this, remote image uploads can fail silently and
    // leave LoadImage pointing at a stale previous file.
    if (pathname.startsWith('/upload/') || pathname === '/view' || pathname.startsWith('/view?')) {
      httpToComfy.web(req, res);
      return;
    }

    if ((pathname === '/mobile/api/comfy/api/queue' || pathname === '/mobile/api/comfy/queue') && (req.method === 'GET' || req.method === 'HEAD')) {
      sendRedactedComfyJson(req, res, '/queue', sanitizeQueuePayload);
      return;
    }

    if ((pathname === '/mobile/api/comfy/api/history' || pathname === '/mobile/api/comfy/history' || pathname.startsWith('/mobile/api/comfy/api/history/') || pathname.startsWith('/mobile/api/comfy/history/')) && (req.method === 'GET' || req.method === 'HEAD')) {
      const upstreamPath = pathname.replace(/^\/mobile\/api\/comfy\/api/, '').replace(/^\/mobile\/api\/comfy/, '') + (new URL(req.url, `http://${req.headers.host || 'localhost'}`).search || '');
      const match = pathname.match(/\/(?:api\/)?history\/([^/?#]+)/);
      sendMergedHistory(req, res, upstreamPath, match ? decodeURIComponent(match[1]) : '');
      return;
    }

    if ((pathname === '/mobile/api/comfy/api/prompt' || pathname === '/mobile/api/comfy/prompt') && req.method === 'POST') {
      req.url = req.url.replace(/^\/mobile\/api\/comfy/, '/comfy') || '/comfy/prompt';
      proxyPromptToNativeApi(req, res);
      return;
    }

    if (pathname.startsWith('/mobile/api/comfy/')) {
      req.url = req.url.replace(/^\/mobile\/api\/comfy/, '') || '/';
      httpToComfy.web(req, res);
      return;
    }

    httpToNext.web(req, res);
  });

  publicServer.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    } catch {
      pathname = req.url || '';
    }

    if (pathname === '/ws' || pathname === '/comfy/ws' || pathname === '/mobile/api/comfy/ws') {
      proxyComfyWebSocket(req, socket, head);
      return;
    }

    socket.destroy();
  });

  publicServer.listen(port, hostname, () => {
    console.log(`Media Studio public frontend listening on http://${hostname}:${port}`);
    console.log(`Proxying HTTP to ${nextTarget}`);
    console.log(`Bridging ComfyUI WebSocket /ws to lanes: ${comfyLaneTargets.map(([lane, target]) => `${lane}=${target}`).join(", ")}`);
    console.log(`Comfy lanes: ${comfyLaneTargets.map(([lane, target]) => `${lane}=${target}`).join(", ")}`);
  });
});
