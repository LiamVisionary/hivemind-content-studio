import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const execFileAsync = promisify(execFile);
const HOME = process.env.HOME || os.homedir();
const PROJECT_ROOT = process.cwd();
const STACK_BIN = join(HOME, '.local/bin/zimage-stack');
const TOKEN_PATH = process.env.ZIMG_TOKEN_FILE || join(process.env.HIVEMIND_MEDIA_STATE_DIR || join(HOME, '.hivemindos/media-studio'), 'secure/zimg-token');
const MANIFEST_PATH = join(PROJECT_ROOT, 'studio.runtime.json');
const ACTIONS = new Set(['start', 'stop', 'restart']);

function token() {
  try { return readFileSync(TOKEN_PATH, 'utf8').trim(); }
  catch { return ''; }
}

function manifest() {
  try { return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')); }
  catch {
    return { name: 'Media Studio', manager: 'Media Studio supervisor', components: [] };
  }
}

function sanitize(text = '') {
  return String(text)
    .replace(/\b100(?:\.\d{1,3}){3}\b/g, '[tailnet-ip]')
    .replace(/token=[^&\s"']+/gi, 'token=[redacted]');
}

function cookieValue(request, key) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === key) return rest.join('=');
  }
  return '';
}

function authorized(request) {
  const expected = token();
  if (!expected) return false;
  const auth = request.headers.get('authorization') || '';
  if (auth === `Bearer ${expected}`) return true;
  if (request.headers.get('x-token') === expected) return true;
  const url = new URL(request.url);
  if (url.searchParams.get('token') === expected) return true;
  return cookieValue(request, 'zimg_token') === expected;
}

async function runStack(args, timeout = 120000) {
  try {
    const result = await execFileAsync(STACK_BIN, args, {
      timeout,
      cwd: join(HOME, 'comfy'),
      env: {
        ...process.env,
        PATH: `${join(HOME, '.local/bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
      },
    });
    return { ok: true, code: 0, stdout: sanitize(result.stdout), stderr: sanitize(result.stderr) };
  } catch (err) {
    return {
      ok: false,
      code: err.code || 1,
      stdout: sanitize(err.stdout || ''),
      stderr: sanitize(err.stderr || err.message || ''),
    };
  }
}

async function probe(url, timeoutMs = 2500) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    return {
      online: res.ok,
      status: res.status,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      online: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: err.name === 'AbortError' ? 'timeout' : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseListeners(statusText) {
  const listeners = {};
  const re = /:(\d+)\s+pid\(s\):\s*([0-9,\s]+)/g;
  let match;
  while ((match = re.exec(statusText))) {
    listeners[match[1]] = match[2].trim().split(/\s+/).filter(Boolean);
  }
  return listeners;
}

async function runtimeStatus() {
  const spec = manifest();
  const [stack, appUrlResult] = await Promise.all([
    runStack(['status'], 15000),
    runStack(['url'], 5000),
  ]);
  const statusText = `${stack.stdout || ''}\n${stack.stderr || ''}`;
  const listeners = parseListeners(statusText);
  const componentResults = await Promise.all(
    (spec.components || []).map(async (component) => {
      const probeResult = component.healthUrl ? await probe(component.healthUrl) : null;
      const hasListener = component.port ? Boolean(listeners[String(component.port)]) : false;
      const online = Boolean(probeResult?.online || hasListener);
      return {
        ...component,
        online,
        state: online ? 'online' : 'offline',
        latencyMs: probeResult?.latencyMs ?? null,
        status: probeResult?.status ?? null,
        pidCount: component.port ? (listeners[String(component.port)] || []).length : 0,
      };
    }),
  );
  return {
    ok: componentResults.some((component) => component.online),
    name: spec.name || 'Media Studio',
    manager: spec.manager || 'Media Studio supervisor',
    appUrl: (appUrlResult.stdout || '').trim() || spec.entrypoints?.local || 'http://127.0.0.1:8788',
    checkedAt: new Date().toISOString(),
    stackAvailable: stack.ok,
    listeners,
    components: componentResults,
    rawStatus: statusText.trim().split('\n').slice(0, 80).join('\n'),
  };
}

export async function GET() {
  const body = JSON.stringify(await runtimeStatus());
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
    },
  });
}

export async function POST(request) {
  if (!authorized(request)) {
    return Response.json({ error: 'Runtime actions require the backend token.' }, { status: 401 });
  }
  let body = {};
  try { body = await request.json(); } catch {}
  const action = body.action;
  if (!ACTIONS.has(action)) {
    return Response.json({ error: 'Unsupported runtime action.' }, { status: 400 });
  }
  if (action === 'start') {
    const current = await runtimeStatus();
    const coreOnline = new Set(
      (current.components || [])
        .filter((component) => component.online)
        .map((component) => component.id),
    );
    if (coreOnline.has('gateway') && coreOnline.has('backend') && coreOnline.has('comfyui')) {
      return Response.json({
        action,
        result: { ok: true, code: 0, stdout: 'Media Studio stack is already running.', stderr: '' },
        runtime: current,
      });
    }
  }
  const result = await runStack([action], 180000);
  const status = await runtimeStatus();
  return Response.json({ action, result, runtime: status }, { status: result.ok ? 200 : 500 });
}
