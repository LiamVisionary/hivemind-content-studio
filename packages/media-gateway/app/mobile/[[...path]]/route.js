export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { gzipSync } from 'node:zlib';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const COMFY = process.env.COMFY_HTTP || 'http://127.0.0.1:8188';
const PROJECT_ROOT = process.cwd();
const MOBILE_DIST = process.env.COMFY_MOBILE_DIST || resolve(PROJECT_ROOT, '../comfyui-mobile/dist');
const MOBILE_ASSETS = join(MOBILE_DIST, 'assets');
const mobileAssetCache = new Map();
let mobileBuildVersionCache = { checkedAt: 0, value: '0' };

function getMobileBuildVersion() {
  const now = Date.now();
  if (now - mobileBuildVersionCache.checkedAt < 1000) return mobileBuildVersionCache.value;
  try {
    const indexMtime = statSync(join(MOBILE_DIST, 'index.html')).mtimeMs;
    const wrapperBuildMtime = Math.max(
      statSync(join(PROJECT_ROOT, '.next/BUILD_ID')).mtimeMs,
      statSync(join(PROJECT_ROOT, 'app/mobile/[[...path]]/route.js')).mtimeMs,
    );
    const assetMtime = readdirSync(MOBILE_ASSETS)
      .filter((name) => /\.(js|css)$/.test(name))
      .reduce((latest, name) => Math.max(latest, statSync(join(MOBILE_ASSETS, name)).mtimeMs), 0);
    mobileBuildVersionCache = {
      checkedAt: now,
      value: String(Math.round(Math.max(indexMtime, assetMtime, wrapperBuildMtime))),
    };
  } catch {
    mobileBuildVersionCache = { checkedAt: now, value: String(now) };
  }
  return mobileBuildVersionCache.value;
}

function appendMobileBuildVersionToHtml(text) {
  const version = getMobileBuildVersion();
  return text.replace(/(\/mobile\/assets\/[^"'<>?#]+\.(?:js|css))(?![?])/g, `$1?v=${version}`);
}

function acceptsGzip(request) {
  return /\bgzip\b/.test(request.headers.get('accept-encoding') || '');
}

function gzipResponseBodyIfUseful(request, headers, body) {
  if (!acceptsGzip(request)) return body;
  const contentType = headers.get('content-type') || '';
  const compressible = /javascript|text\/css|text\/html|application\/json|text\//i.test(contentType);
  if (!compressible || body.length < 1024) return body;
  const compressed = gzipSync(body, { level: 6 });
  if (compressed.length >= body.length) return body;
  headers.set('content-encoding', 'gzip');
  headers.set('vary', appendVary(headers.get('vary'), 'Accept-Encoding'));
  headers.set('content-length', compressed.length.toString());
  return compressed;
}

function appendVary(current, value) {
  if (!current) return value;
  const parts = current.split(',').map((part) => part.trim().toLowerCase());
  return parts.includes(value.toLowerCase()) ? current : `${current}, ${value}`;
}

function sanitizeHeaders(request) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('content-length');
  headers.delete('origin');
  headers.delete('referer');
  return headers;
}

function rewriteMobileText(text) {
  return text
    // Vite emits bare crossorigin attributes. Keep same-origin module/CSS
    // requests credential/simple and avoid blank iframe failures.
    .replace(/\s+crossorigin(?=[\s>])/g, '')
    // The mobile frontend is written as if it owns the root ComfyUI origin.
    // In this wrapper, /api belongs to Media Studio, so namespace ComfyUI.
    .replaceAll('"/api/', '"/comfy/api/')
    .replaceAll("'/api/", "'/comfy/api/")
    .replaceAll('`/api/', '`/comfy/api/')
    .replaceAll('(/api/', '(/comfy/api/')
    .replaceAll('/system_stats', '/comfy/system_stats')
    // Be idempotent: newer mobile code may already emit wrapper-prefixed
    // ComfyUI media URLs. A broad /view? rewrite turns /comfy/view? into
    // /comfy/comfy/view?, which renders broken thumbnails in expanded
    // Favorite Workflow output grids.
    .replace(/(?<!\/comfy)\/view\?/g, '/comfy/view?')
    .replaceAll('/upload/', '/comfy/upload/');
}

async function proxyMobile(request, context) {
  const params = await context.params;
  const parts = params.path || [];
  const path = parts.length ? parts.map(encodeURIComponent).join('/') : '';
  const source = new URL(request.url);
  const targetPath = path ? `/mobile/${path}` : '/mobile/';
  const target = `${COMFY}${targetPath}${source.search}`;
  const isGetLike = ['GET', 'HEAD'].includes(request.method);
  const isFingerprintAsset = isGetLike && /^assets\//.test(path);
  const cacheKey = `${request.method}:${target}`;

  if (isFingerprintAsset && mobileAssetCache.has(cacheKey)) {
    const cached = mobileAssetCache.get(cacheKey);
    const headers = new Headers(cached.headers);
    let responseBody = cached.body;
    if (request.method !== 'HEAD') {
      responseBody = gzipResponseBodyIfUseful(request, headers, cached.body);
    } else {
      headers.set('content-length', cached.body.length.toString());
    }
    return new Response(request.method === 'HEAD' ? null : responseBody, {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }

  const init = { method: request.method, headers: sanitizeHeaders(request), redirect: 'manual', cache: 'no-store' };
  if (!isGetLike) init.body = await request.arrayBuffer();

  const upstream = await fetch(target, init);
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete('content-encoding');

  if (isFingerprintAsset) {
    responseHeaders.set('cache-control', 'public, max-age=31536000, immutable');
  } else {
    responseHeaders.set('cache-control', 'no-store, max-age=0');
  }

  const contentType = responseHeaders.get('content-type') || '';
  let body;
  if (contentType.includes('text/html')) {
    body = Buffer.from(appendMobileBuildVersionToHtml(rewriteMobileText(await upstream.text())));
  } else if (contentType.includes('javascript') || contentType.includes('text/css')) {
    body = Buffer.from(rewriteMobileText(await upstream.text()));
  } else {
    body = Buffer.from(await upstream.arrayBuffer());
  }
  responseHeaders.set('content-length', body.length.toString());

  if (isFingerprintAsset && upstream.ok) {
    mobileAssetCache.set(cacheKey, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: Array.from(new Headers(responseHeaders).entries()).filter(([name]) => name !== 'content-encoding' && name !== 'vary'),
      body,
    });
  }

  let responseBody = body;
  if (request.method !== 'HEAD') {
    responseBody = gzipResponseBodyIfUseful(request, responseHeaders, body);
  } else {
    responseHeaders.set('content-length', body.length.toString());
  }

  const response = new Response(request.method === 'HEAD' ? null : responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });

  return response;
}

export const GET = proxyMobile;
export const HEAD = proxyMobile;
export const POST = proxyMobile;
export const PUT = proxyMobile;
export const PATCH = proxyMobile;
export const DELETE = proxyMobile;
export const OPTIONS = proxyMobile;
