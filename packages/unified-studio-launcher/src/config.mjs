import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, '..');
const platformKeys = new Set(['darwin', 'macos', 'linux', 'win32', 'windows', 'default']);

export function defaultConfigPath() {
  if (process.env.STUDIO_CONFIG) return resolve(process.env.STUDIO_CONFIG);
  const local = join(process.cwd(), 'studio.config.json');
  if (existsSync(local)) return local;
  return join(repoRoot, 'studio.config.example.json');
}

export function expandValue(value) {
  if (typeof value !== 'string') return value;
  const home = os.homedir();
  return value
    .replace(/^~(?=$|[/\\])/, home)
    .replaceAll('${HOME}', home)
    .replaceAll('$HOME', home)
    .replaceAll('%USERPROFILE%', process.env.USERPROFILE || home)
    .replace(/\$\{([A-Z0-9_]+)\}/gi, (match, key) => process.env[key] || match);
}

export function expandPath(value, baseDir = process.cwd()) {
  if (!value) return value;
  const expanded = expandValue(value);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

export function resolveCommand(value, platform = process.platform) {
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.map(expandValue);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const selected = value[platform]
      || (platform === 'darwin' ? value.macos : undefined)
      || (platform === 'win32' ? value.windows : undefined)
      || value.default;
    return resolveCommand(selected, platform);
  }
  return undefined;
}

function platformSelection(value, platform = process.platform) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return value[platform]
    || (platform === 'darwin' ? value.macos : undefined)
    || (platform === 'win32' ? value.windows : undefined)
    || value.default;
}

function isPlatformMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => platformKeys.has(key));
}

export function resolveEnvMap(value, platform = process.platform) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const selected = isPlatformMap(value) ? platformSelection(value, platform) : value;
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) return {};
  return Object.fromEntries(Object.entries(selected)
    .map(([key, envValue]) => {
      const resolved = isPlatformMap(envValue) ? platformSelection(envValue, platform) : envValue;
      if (resolved === undefined || resolved === null) return null;
      return [key, expandValue(String(resolved))];
    })
    .filter(Boolean));
}

export function resolveCommandList(value, platform = process.platform) {
  if (!value) return [];
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    const command = resolveCommand(value, platform);
    return command ? [command] : [];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveCommand(entry, platform)).filter(Boolean);
  }
  if (value && typeof value === 'object') {
    const selected = value[platform]
      || (platform === 'darwin' ? value.macos : undefined)
      || (platform === 'win32' ? value.windows : undefined)
      || value.default;
    return resolveCommandList(selected, platform);
  }
  return [];
}

function inferRepositoryId(repo) {
  if (repo.id) return repo.id;
  if (!repo.url) return 'repository';
  return repo.url.split('/').pop().replace(/\.git$/i, '') || 'repository';
}

function normalizeActions(actions = {}, platform = process.platform) {
  return Object.fromEntries(Object.entries(actions)
    .map(([action, command]) => [action, resolveCommand(command, platform)])
    .filter(([, command]) => Array.isArray(command) && command.length));
}

export function loadConfig(configPath = defaultConfigPath(), options = {}) {
  const absolutePath = resolve(configPath);
  const raw = JSON.parse(readFileSync(absolutePath, 'utf8'));
  const baseDir = dirname(absolutePath);
  const platform = options.platform || process.platform;
  const config = {
    name: raw.name || 'Unified Media Studio',
    host: raw.host || '127.0.0.1',
    port: Number(process.env.STUDIO_PORT || raw.port || 4888),
    openUrl: raw.openUrl || `http://${raw.host || '127.0.0.1'}:${Number(process.env.STUDIO_PORT || raw.port || 4888)}`,
    dataDir: expandPath(raw.dataDir || '.studio', baseDir),
    actions: normalizeActions(raw.actions || {}, platform),
    services: Array.isArray(raw.services) ? raw.services : [],
    repositories: Array.isArray(raw.repositories) ? raw.repositories : [],
    repoRoot,
    configPath: absolutePath
  };
  config.services = config.services.map((service) => ({
    ...service,
    cwd: service.cwd ? expandPath(service.cwd, baseDir) : undefined,
    env: resolveEnvMap(service.env, platform),
    start: resolveCommand(service.start, platform),
    stop: resolveCommand(service.stop, platform)
  }));
  config.repositories = config.repositories.map((repo) => ({
    ...repo,
    id: inferRepositoryId(repo),
    path: expandPath(repo.path || `vendor/${inferRepositoryId(repo)}`, baseDir),
    install: resolveCommandList(repo.install, platform)
  }));
  return config;
}
