export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, stat, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { spawn } from 'node:child_process';

const NATIVE_API = process.env.ZIMAGE_NATIVE_API || 'http://127.0.0.1:8787';
const ENCRYPTED_SUFFIX = '.zenc';

let cachedNativeToken;
function nativeApiToken() {
  if (cachedNativeToken !== undefined) return cachedNativeToken;
  const envToken = (process.env.ZIMG_TOKEN || '').trim();
  if (envToken) {
    cachedNativeToken = envToken;
    return cachedNativeToken;
  }
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

// The encryption sweeper replaces plaintext outputs with .zenc sidecars, so a
// preview request that arrives after the sweep finds no readable input here.
// The native API decrypts on demand; fetch the plaintext bytes from it so the
// preview can still render (and get cached) for encrypted outputs.
async function fetchDecryptedBytes(filename) {
  const token = nativeApiToken();
  if (!token) return null;
  try {
    const upstream = await fetch(
      `${NATIVE_API}/image/${encodeURIComponent(filename)}?token=${encodeURIComponent(token)}`,
      { cache: 'no-store' },
    );
    if (!upstream.ok) return null;
    return Buffer.from(await upstream.arrayBuffer());
  } catch {
    return null;
  }
}

const ROOTS = {
  output: join(process.env.HOME || '', '.comfy-private.noindex/output'),
  input: join(process.env.HOME || '', '.comfy-private.noindex/input'),
  temp: join(process.env.HOME || '', '.comfy-private.noindex/temp'),
};
const CACHE_ROOT = join(process.env.HOME || '', '.comfy-private.noindex/preview-cache');
const MAX_DIMENSION = 960;

function safeJoin(root, subfolder, filename) {
  const relative = normalize(join(subfolder || '', filename || ''));
  if (!relative || relative.startsWith('..') || relative.includes('/../')) return null;
  const full = join(root, relative);
  if (!full.startsWith(root)) return null;
  return full;
}

function runSips(input, output) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', String(MAX_DIMENSION), input, '--out', output], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(err || `sips exited ${code}`));
    });
  });
}

export async function GET(request) {
  const url = new URL(request.url);
  const filename = url.searchParams.get('filename') || '';
  const subfolder = url.searchParams.get('subfolder') || '';
  const source = url.searchParams.get('source') || url.searchParams.get('type') || 'output';
  const root = ROOTS[source] || ROOTS.output;
  const input = safeJoin(root, subfolder, filename);

  if (!input) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  let statTarget = input;
  let needsDecrypt = false;
  if (!existsSync(input)) {
    if (existsSync(`${input}${ENCRYPTED_SUFFIX}`)) {
      statTarget = `${input}${ENCRYPTED_SUFFIX}`;
      needsDecrypt = true;
    } else {
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
  }

  const inputStat = await stat(statTarget);
  const cacheKey = createHash('sha1')
    .update(`${source}\n${subfolder}\n${filename}\n${inputStat.mtimeMs}\n${inputStat.size}\n${MAX_DIMENSION}`)
    .digest('hex');
  const cacheFile = join(CACHE_ROOT, `${cacheKey}.jpg`);

  try {
    if (!existsSync(cacheFile)) {
      await mkdir(dirname(cacheFile), { recursive: true });
      if (needsDecrypt) {
        const bytes = await fetchDecryptedBytes(filename);
        if (!bytes) {
          return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
        }
        // sips needs a file path; keep the transient plaintext inside the cache
        // dir and remove it as soon as the preview is rendered.
        const tempFile = join(CACHE_ROOT, `${cacheKey}.${process.pid}.tmp.png`);
        try {
          await writeFile(tempFile, bytes);
          await runSips(tempFile, cacheFile);
        } finally {
          try { await unlink(tempFile); } catch {}
        }
      } else {
        await runSips(input, cacheFile);
      }
    }
    const body = await readFile(cacheFile);
    return new Response(body, {
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(body.length),
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    console.warn('preview generation failed', err);
    if (needsDecrypt) {
      const bytes = await fetchDecryptedBytes(filename);
      if (!bytes) {
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      }
      return new Response(bytes, {
        headers: {
          'content-type': 'image/png',
          'content-length': String(bytes.length),
          'cache-control': 'no-store',
        },
      });
    }
    const body = await readFile(input);
    return new Response(body, {
      headers: {
        'content-type': 'image/png',
        'content-length': String(body.length),
        'cache-control': 'no-store',
      },
    });
  }
}
