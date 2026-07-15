import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.mjs';
import { launcherTargets } from '../src/launchers.mjs';
import { doctor, sanitizeOutput } from '../src/service-manager.mjs';

test('loads the example config', () => {
  const config = loadConfig(new URL('../studio.config.example.json', import.meta.url).pathname);
  assert.equal(config.name, 'Unified Media Studio');
  assert.equal(config.port, 4888);
  assert.ok(config.services.length >= 4);
  assert.deepEqual(config.repositories, []);
});

test('doctor reports config as present', () => {
  const config = loadConfig(new URL('../studio.config.example.json', import.meta.url).pathname);
  const checks = doctor(config);
  assert.equal(checks.find((check) => check.label === 'config')?.ok, true);
});

test('sanitizes tailnet IPs and query tokens', () => {
  const tailnetLikeHost = ['100', '64', '1', '2'].join('.');
  const secretLikeValue = ['sec', 'ret'].join('');
  const text = sanitizeOutput(`http://${tailnetLikeHost}:8788/?token=${secretLikeValue}`);
  assert.equal(text.includes(tailnetLikeHost), false);
  assert.equal(text.includes(secretLikeValue), false);
});

test('loads platform-specific commands and repositories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-config-'));
  const configPath = join(dir, 'studio.config.json');
  writeFileSync(configPath, JSON.stringify({
    name: 'Cross Platform Studio',
    repositories: [
      {
        id: 'comfyui',
        url: 'https://example.com/comfyui.git',
        ref: 'main',
        path: 'vendor/ComfyUI',
        install: {
          win32: [['python', '-m', 'pip', 'install', '-r', 'requirements.txt']],
          default: [['python3', '-m', 'pip', 'install', '-r', 'requirements.txt']]
        }
      }
    ],
    services: [
      {
        id: 'comfyui',
        cwd: 'vendor/ComfyUI',
        start: {
          win32: ['python', 'main.py'],
          default: ['python3', 'main.py']
        }
      }
    ]
  }));

  const config = loadConfig(configPath, { platform: 'win32' });
  assert.deepEqual(config.services[0].start, ['python', 'main.py']);
  assert.equal(config.services[0].cwd, join(dir, 'vendor/ComfyUI'));
  assert.equal(config.repositories[0].path, join(dir, 'vendor/ComfyUI'));
  assert.deepEqual(config.repositories[0].install[0], ['python', '-m', 'pip', 'install', '-r', 'requirements.txt']);
});

test('loads platform-specific service environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-config-env-'));
  const configPath = join(dir, 'studio.config.json');
  writeFileSync(configPath, JSON.stringify({
    services: [
      {
        id: 'comfyui',
        env: {
          darwin: {
            ZIMG_ACCELERATOR_PROFILE: 'apple-silicon',
            ZIMG_ENABLE_APPLE_SILICON_OPTIMIZATIONS: 1
          },
          win32: {
            ZIMG_ACCELERATOR_PROFILE: 'cuda'
          }
        }
      },
      {
        id: 'native',
        env: {
          COMMON_FLAG: '1',
          PROFILE_FLAG: {
            darwin: 'mlx',
            win32: 'cuda',
            default: 'cpu'
          }
        }
      },
      {
        id: 'literal',
        env: {
          default: 'kept-as-env-var',
          PROFILE_FLAG: {
            win32: 'cuda',
            default: 'cpu'
          }
        }
      }
    ]
  }));

  const macConfig = loadConfig(configPath, { platform: 'darwin' });
  assert.deepEqual(macConfig.services[0].env, {
    ZIMG_ACCELERATOR_PROFILE: 'apple-silicon',
    ZIMG_ENABLE_APPLE_SILICON_OPTIMIZATIONS: '1'
  });
  assert.deepEqual(macConfig.services[1].env, {
    COMMON_FLAG: '1',
    PROFILE_FLAG: 'mlx'
  });
  assert.deepEqual(macConfig.services[2].env, {
    default: 'kept-as-env-var',
    PROFILE_FLAG: 'cpu'
  });

  const winConfig = loadConfig(configPath, { platform: 'win32' });
  assert.deepEqual(winConfig.services[0].env, {
    ZIMG_ACCELERATOR_PROFILE: 'cuda'
  });
  assert.deepEqual(winConfig.services[1].env, {
    COMMON_FLAG: '1',
    PROFILE_FLAG: 'cuda'
  });
  assert.deepEqual(winConfig.services[2].env, {
    default: 'kept-as-env-var',
    PROFILE_FLAG: 'cuda'
  });
});

test('computes launcher targets for the three desktop platforms', () => {
  const config = loadConfig(new URL('../studio.config.example.json', import.meta.url).pathname);
  assert.equal(launcherTargets(config, 'darwin').kind, 'macos-app');
  assert.equal(launcherTargets(config, 'linux').kind, 'linux-desktop');
  assert.equal(launcherTargets(config, 'win32').kind, 'windows-cmd');
});
