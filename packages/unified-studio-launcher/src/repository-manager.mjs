import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sanitizeOutput } from './service-manager.mjs';

function run(command, cwd, timeout = 180000) {
  const [bin, ...args] = command;
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    env: process.env
  });
  return {
    ok: result.status === 0,
    code: result.status ?? 1,
    stdout: sanitizeOutput(result.stdout || ''),
    stderr: sanitizeOutput(result.stderr || '')
  };
}

function git(args, cwd) {
  return run(['git', ...args], cwd);
}

function gitAvailable() {
  return run(['git', '--version'], process.cwd(), 15000).ok;
}

function gitValue(args, cwd) {
  const result = git(args, cwd);
  return result.ok ? result.stdout.trim() : '';
}

function isGitRepository(path) {
  if (!existsSync(path)) return false;
  return git(['rev-parse', '--is-inside-work-tree'], path).ok;
}

export function repositoryStatus(config) {
  const hasGit = gitAvailable();
  const repositories = config.repositories.map((repo) => {
    const present = existsSync(repo.path);
    const gitRepo = present && isGitRepository(repo.path);
    return {
      id: repo.id,
      url: repo.url || '',
      path: repo.path,
      ref: repo.ref || '',
      present,
      git: gitRepo,
      branch: gitRepo ? gitValue(['rev-parse', '--abbrev-ref', 'HEAD'], repo.path) : '',
      commit: gitRepo ? gitValue(['rev-parse', '--short', 'HEAD'], repo.path) : '',
      installCommands: repo.install?.length || 0,
      state: !present ? 'missing' : gitRepo ? 'ready' : 'path-exists'
    };
  });
  return {
    ok: hasGit && repositories.every((repo) => repo.present && repo.git),
    git: hasGit,
    count: repositories.length,
    ready: repositories.filter((repo) => repo.present && repo.git).length,
    repositories
  };
}

export function bootstrapRepositories(config, options = {}) {
  const update = Boolean(options.update);
  const install = Boolean(options.install);
  const results = [];
  const hasGit = gitAvailable();
  if (!hasGit) {
    return { ok: false, git: false, results: [{ id: 'git', ok: false, message: 'git is not available on PATH' }] };
  }

  for (const repo of config.repositories) {
    const entry = { id: repo.id, path: repo.path, steps: [] };
    if (!repo.url) {
      entry.ok = false;
      entry.steps.push({ step: 'config', ok: false, stderr: 'repository url is required' });
      results.push(entry);
      continue;
    }

    if (!existsSync(repo.path)) {
      mkdirSync(dirname(repo.path), { recursive: true });
      const clone = git(['clone', repo.url, repo.path], process.cwd());
      entry.steps.push({ step: 'clone', ...clone });
      if (!clone.ok) {
        entry.ok = false;
        results.push(entry);
        continue;
      }
      if (repo.ref) {
        entry.steps.push({ step: 'checkout', ...git(['checkout', repo.ref], repo.path) });
      }
    } else if (!isGitRepository(repo.path)) {
      entry.ok = false;
      entry.steps.push({ step: 'inspect', ok: false, code: 1, stdout: '', stderr: 'path exists but is not a git repository' });
      results.push(entry);
      continue;
    } else if (update) {
      entry.steps.push({ step: 'fetch', ...git(['fetch', '--all', '--tags', '--prune'], repo.path) });
      if (repo.ref) entry.steps.push({ step: 'checkout', ...git(['checkout', repo.ref], repo.path) });
      if (!repo.ref) entry.steps.push({ step: 'pull', ...git(['pull', '--ff-only'], repo.path) });
    } else {
      entry.steps.push({ step: 'inspect', ok: true, code: 0, stdout: 'already present', stderr: '' });
    }

    if (install) {
      for (const command of repo.install || []) {
        entry.steps.push({ step: `install: ${command[0]}`, ...run(command, repo.path, 600000) });
      }
    }

    entry.ok = entry.steps.every((step) => step.ok);
    results.push(entry);
  }

  return {
    ok: results.every((result) => result.ok !== false),
    git: true,
    update,
    install,
    results
  };
}
