import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function statePath(config) {
  return join(config.dataDir, 'state.json');
}

export function readState(config) {
  try { return JSON.parse(readFileSync(statePath(config), 'utf8')); }
  catch { return { pids: {}, updatedAt: null }; }
}

export function writeState(config, state) {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(statePath(config), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}

export function sanitizeOutput(text = '') {
  return String(text)
    .replace(/\b100(?:\.\d{1,3}){3}\b/g, '[tailnet-ip]')
    .replace(/token=[^&\s"']+/gi, 'token=[redacted]');
}

export async function probe(url, timeoutMs = 2500) {
  if (!url) return { online: false, status: null, latencyMs: null, skipped: true };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    return { online: response.ok, status: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      online: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: error.name === 'AbortError' ? 'timeout' : 'unreachable'
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function status(config) {
  const state = readState(config);
  const services = await Promise.all(config.services.map(async (service) => {
    const health = await probe(service.healthUrl);
    const pid = state.pids?.[service.id] || null;
    const pidAlive = pid ? processAlive(pid) : false;
    const online = Boolean(health.online || pidAlive);
    return {
      id: service.id,
      name: service.name || service.id,
      role: service.role || '',
      url: service.url || '',
      online,
      state: online ? 'online' : 'offline',
      health,
      pid: pidAlive ? pid : null,
      managed: Boolean(service.start)
    };
  }));
  return {
    ok: services.some((service) => service.online),
    name: config.name,
    checkedAt: new Date().toISOString(),
    configPath: config.configPath,
    services
  };
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function runActionCommand(config, action) {
  const command = config.actions?.[action];
  if (!Array.isArray(command) || !command.length) return null;
  const [bin, ...args] = command;
  const result = spawnSync(bin, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 180000,
    env: process.env
  });
  return {
    ok: result.status === 0,
    code: result.status || 0,
    stdout: sanitizeOutput(result.stdout || ''),
    stderr: sanitizeOutput(result.stderr || '')
  };
}

function environmentForService(service) {
  return { ...process.env, ...(service.env || {}) };
}

export async function runAction(config, action) {
  if (!['start', 'stop', 'restart'].includes(action)) {
    return { ok: false, code: 1, stdout: '', stderr: `Unsupported action: ${action}` };
  }
  const wholeStack = runActionCommand(config, action);
  if (wholeStack) return wholeStack;
  if (action === 'restart') {
    await runAction(config, 'stop');
    return runAction(config, 'start');
  }
  if (action === 'start') return startServices(config);
  return stopServices(config);
}

export function startServices(config) {
  const state = readState(config);
  const results = [];
  for (const service of config.services) {
    if (!Array.isArray(service.start) || !service.start.length) continue;
    const existingPid = state.pids?.[service.id];
    if (existingPid && processAlive(existingPid)) {
      results.push(`${service.id}: already running (${existingPid})`);
      continue;
    }
    const [bin, ...args] = service.start;
    const child = spawn(bin, args, {
      cwd: service.cwd || process.cwd(),
      detached: true,
      stdio: 'ignore',
      env: environmentForService(service)
    });
    child.unref();
    state.pids[service.id] = child.pid;
    results.push(`${service.id}: started (${child.pid})`);
  }
  writeState(config, state);
  return { ok: true, code: 0, stdout: results.join('\n'), stderr: '' };
}

export function stopServices(config) {
  const state = readState(config);
  const results = [];
  for (const service of config.services) {
    if (Array.isArray(service.stop) && service.stop.length) {
      const [bin, ...args] = service.stop;
      const result = spawnSync(bin, args, {
        cwd: service.cwd || process.cwd(),
        encoding: 'utf8',
        timeout: 60000,
        env: environmentForService(service)
      });
      results.push(`${service.id}: stop command ${result.status === 0 ? 'ok' : 'failed'}`);
      continue;
    }
    const pid = state.pids?.[service.id];
    if (pid && processAlive(pid)) {
      process.kill(pid, 'SIGTERM');
      results.push(`${service.id}: stopped (${pid})`);
    }
    delete state.pids[service.id];
  }
  writeState(config, state);
  return { ok: true, code: 0, stdout: results.join('\n'), stderr: '' };
}

export function doctor(config) {
  const checks = [
    ['config', config.configPath, existsSync(config.configPath)],
    ['data dir parent', config.dataDir, true],
    ['repositories', `${config.repositories?.length || 0} configured`, true]
  ];
  for (const repo of config.repositories || []) {
    checks.push([`${repo.id} repo`, repo.path, existsSync(repo.path)]);
  }
  for (const service of config.services) {
    if (service.cwd) checks.push([`${service.id} cwd`, service.cwd, existsSync(service.cwd)]);
  }
  return checks.map(([label, value, ok]) => ({ label, value, ok }));
}
