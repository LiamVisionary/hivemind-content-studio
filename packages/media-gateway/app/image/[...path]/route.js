import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BACKEND = 'http://127.0.0.1:8787';
const TOKEN_PATH = process.env.ZIMG_TOKEN_FILE || join(process.env.HIVEMIND_MEDIA_STATE_DIR || join(process.env.HOME || '', '.hivemindos/media-studio'), 'secure/zimg-token');

function backendToken() {
  try { return readFileSync(TOKEN_PATH, 'utf8').trim(); }
  catch { return ''; }
}

async function proxyImage(request, context) {
  const params = await context.params;
  const path = (params.path || []).map(encodeURIComponent).join('/');
  const source = new URL(request.url);
  const target = `${BACKEND}/image/${path}${source.search}`;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('content-length');
  if (!headers.get('authorization')) {
    const token = backendToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
  }
  const upstream = await fetch(target, { method: request.method, headers, cache: 'no-store' });
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.set('cache-control', 'private, no-store, max-age=0');
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

export const GET = proxyImage;
export const HEAD = proxyImage;
