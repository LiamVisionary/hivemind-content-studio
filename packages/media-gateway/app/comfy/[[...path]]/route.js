export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const COMFY = process.env.COMFY_HTTP || 'http://127.0.0.1:8188';
const COMFY_PRIVATE_VIEW_TOKEN = (process.env.COMFY_PRIVATE_VIEW_TOKEN || '').trim();
const NATIVE_API = process.env.ZIMAGE_NATIVE_API || 'http://127.0.0.1:8787';

let cachedNativeToken;
function nativeApiToken() {
  if (cachedNativeToken !== undefined) return cachedNativeToken;
  const envToken = (process.env.ZIMG_TOKEN || '').trim();
  if (envToken) {
    cachedNativeToken = envToken;
    return cachedNativeToken;
  }
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const stateRoot = process.env.HIVEMIND_MEDIA_STATE_DIR || join(process.env.HOME || '', '.hivemindos/media-studio');
  const tokenPath = process.env.ZIMG_TOKEN_FILE || join(stateRoot, 'secure/zimg-token');
  try {
    const value = readFileSync(tokenPath, 'utf8').trim();
    if (value) {
      cachedNativeToken = value;
      return cachedNativeToken;
    }
  } catch {}
  cachedNativeToken = null;
  return cachedNativeToken;
}

// Private output views go through the native API first so plaintext is replaced
// by its encrypted sidecar before any browser response is produced.
async function nativeViewFallback(source) {
  const token = nativeApiToken();
  if (!token) return null;
  const filename = source.searchParams.get('filename');
  if (!filename) return null;
  try {
    const upstream = await fetch(
      `${NATIVE_API}/comfy/view?filename=${encodeURIComponent(filename)}&token=${encodeURIComponent(token)}`,
      { cache: 'no-store' },
    );
    if (!upstream.ok) return null;
    const headers = new Headers(upstream.headers);
    headers.delete('content-encoding');
    headers.delete('set-cookie');
    headers.set('cache-control', 'private, no-store, max-age=0');
    headers.set('pragma', 'no-cache');
    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return null;
  }
}

function isEncryptedWorkflowEnvelope(value) {
  return Boolean(
    value && typeof value === 'object'
    && value.encrypted === true
    && value.format === 'comfyui-mobile-encrypted-workflow'
  );
}

function sanitizeComfyHistoryItem(item) {
  if (!item || typeof item !== 'object') return item;
  const next = { ...item };
  if (Array.isArray(next.prompt)) {
    // Comfy history prompt shape: [number, prompt_id, api_prompt, extra_data].
    // api_prompt contains executable plaintext text-encode inputs, so hide it.
    // Keep extra_data.extra_pnginfo.workflow because our mobile frontend stores an
    // encrypted envelope there and decrypts it client-side for workflow restore.
    next.prompt = [...next.prompt];
    next.prompt[2] = '[private API prompt hidden]';
    const workflow = next.prompt[3]?.extra_pnginfo?.workflow;
    if (workflow && !isEncryptedWorkflowEnvelope(workflow)) {
      next.prompt[3] = {
        ...next.prompt[3],
        extra_pnginfo: {
          ...next.prompt[3].extra_pnginfo,
          workflow: '[unencrypted workflow metadata hidden]',
        },
      };
    }
  }
  return next;
}

function sanitizeComfyQueueTuple(item) {
  if (!Array.isArray(item)) return item;
  const next = [...item.slice(0, 5)];
  next[2] = {};
  const extra = next[3] && typeof next[3] === 'object' ? { ...next[3] } : {};
  const workflow = extra.extra_pnginfo?.workflow;
  next[3] = isEncryptedWorkflowEnvelope(workflow)
    ? { extra_pnginfo: { workflow } }
    : {};
  return next;
}

function sanitizeComfyQueuePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return {
    ...value,
    queue_running: Array.isArray(value.queue_running) ? value.queue_running.map(sanitizeComfyQueueTuple) : value.queue_running,
    queue_pending: Array.isArray(value.queue_pending) ? value.queue_pending.map(sanitizeComfyQueueTuple) : value.queue_pending,
  };
}

function sanitizeComfyHistoryPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeComfyHistoryItem(item)]),
  );
}

function shouldRedactHistoryJson(path, responseHeaders) {
  const contentType = responseHeaders.get('content-type') || '';
  if (!contentType.includes('application/json')) return false;
  const cleanPath = path.replace(/^api\//, '');
  return cleanPath === 'history' || cleanPath.startsWith('history/');
}

function shouldRedactQueueJson(path, responseHeaders) {
  const contentType = responseHeaders.get('content-type') || '';
  if (!contentType.includes('application/json')) return false;
  const cleanPath = path.replace(/^api\//, '');
  return cleanPath === 'queue';
}

function sanitizeHeaders(request) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('content-length');
  headers.delete('origin');
  headers.delete('referer');
  if (COMFY_PRIVATE_VIEW_TOKEN) {
    headers.set('X-ZImage-Private-View-Token', COMFY_PRIVATE_VIEW_TOKEN);
  }
  return headers;
}

async function proxyComfy(request, context) {
  const params = await context.params;
  const path = (params.path || []).map(encodeURIComponent).join('/');
  const source = new URL(request.url);
  const target = `${COMFY}/${path}${source.search}`;
  const init = { method: request.method, headers: sanitizeHeaders(request), cache: 'no-store' };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer();

  if (['GET', 'HEAD'].includes(request.method) && path.replace(/^api\//, '') === 'view') {
    const privateView = await nativeViewFallback(source);
    if (privateView) return privateView;
  }

  const upstream = await fetch(target, init);
  const cleanPath = path.replace(/^api\//, '');
  if (
    ['GET', 'HEAD'].includes(request.method)
    && cleanPath === 'view'
    && upstream.status === 404
  ) {
    const fallback = await nativeViewFallback(source);
    if (fallback) return fallback;
  }
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete('content-encoding');
  if (['GET', 'HEAD'].includes(request.method) && path === 'view' && upstream.ok) {
    responseHeaders.set('cache-control', 'private, no-store, max-age=0');
    responseHeaders.set('pragma', 'no-cache');
  } else {
    responseHeaders.set('cache-control', 'no-store, max-age=0');
  }
  if (shouldRedactHistoryJson(path, responseHeaders) && upstream.ok) {
    const body = JSON.stringify(sanitizeComfyHistoryPayload(await upstream.json()));
    responseHeaders.set('content-length', Buffer.byteLength(body).toString());
    return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  }
  if (shouldRedactQueueJson(path, responseHeaders) && upstream.ok) {
    const body = JSON.stringify(sanitizeComfyQueuePayload(await upstream.json()));
    responseHeaders.set('content-length', Buffer.byteLength(body).toString());
    return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

export const GET = proxyComfy;
export const HEAD = proxyComfy;
export const POST = proxyComfy;
export const PUT = proxyComfy;
export const PATCH = proxyComfy;
export const DELETE = proxyComfy;
export const OPTIONS = proxyComfy;
