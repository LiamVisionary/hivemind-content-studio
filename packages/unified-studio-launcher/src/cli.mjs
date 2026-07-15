#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { installLauncher } from './launchers.mjs';
import { bootstrapRepositories, repositoryStatus } from './repository-manager.mjs';
import { doctor, runAction, status } from './service-manager.mjs';
import { listen } from './server.mjs';

function openUrl(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawnSync(opener, args, { stdio: 'ignore', detached: true });
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
}

function loadFromArgs(args) {
  const path = argValue(args, '--config');
  return loadConfig(path || undefined);
}

async function serve(args) {
  const config = loadFromArgs(args);
  if (args.includes('--start')) {
    const result = await runAction(config, 'start');
    if (!result.ok) console.error(result.stderr || result.stdout || 'Start failed');
  }
  await listen(config);
  const url = config.openUrl || `http://${config.host}:${config.port}`;
  console.log(`${config.name} listening on ${url}`);
  if (args.includes('--open')) openUrl(url);
}

async function installPlatformLauncher(args, platform = process.platform) {
  const config = loadFromArgs(args);
  if (platform !== process.platform) {
    throw new Error(`Cannot install a ${platform} launcher while running on ${process.platform}`);
  }
  const target = installLauncher(config, platform);
  console.log(JSON.stringify(target, null, 2));
}

async function main() {
  const [command = 'serve', ...args] = process.argv.slice(2);
  const config = loadFromArgs(args);
  if (command === 'serve') return serve(args);
  if (command === 'status') {
    console.log(JSON.stringify(await status(config), null, 2));
    return;
  }
  if (['start', 'stop', 'restart'].includes(command)) {
    console.log(JSON.stringify(await runAction(config, command), null, 2));
    return;
  }
  if (command === 'doctor') {
    const checks = doctor(config);
    for (const check of checks) console.log(`${check.ok ? 'ok ' : 'miss'} ${check.label}: ${check.value}`);
    return;
  }
  if (command === 'repos') {
    console.log(JSON.stringify(repositoryStatus(config), null, 2));
    return;
  }
  if (command === 'bootstrap') {
    console.log(JSON.stringify(bootstrapRepositories(config, {
      update: args.includes('--update'),
      install: args.includes('--install')
    }), null, 2));
    return;
  }
  if (command === 'install-launcher') return installPlatformLauncher(args);
  if (command === 'install-macos-app') return installPlatformLauncher(args, 'darwin');
  if (command === 'install-linux-launcher') return installPlatformLauncher(args, 'linux');
  if (command === 'install-windows-launcher') return installPlatformLauncher(args, 'win32');
  console.log(`Usage: node src/cli.mjs <serve|status|start|stop|restart|doctor|repos|bootstrap|install-launcher> [--config path]`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
