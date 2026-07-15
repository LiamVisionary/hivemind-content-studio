#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
const studioRoot = dirname(dirname(projectRoot));
const workspaceRoot = dirname(studioRoot);
const stackBin = process.env.HIVEMIND_STUDIO_STACK || join(studioRoot, 'scripts/hivemind-studio-stack');
const mediaStateRoot = process.env.HIVEMIND_MEDIA_STATE_DIR || join(os.homedir(), '.hivemindos/media-studio');
const localUrl = 'http://127.0.0.1:8765';
const appName = 'Hivemind Content Studio';

function sanitize(text = '') {
  return String(text)
    .replace(/\b100(?:\.\d{1,3}){3}\b/g, '[tailnet-ip]')
    .replace(/token=[^&\s"']+/gi, 'token=[redacted]');
}

function hasZimageStack() {
  return existsSync(stackBin);
}

function runStack(args, { timeout = 120000, check = false } = {}) {
  if (!hasZimageStack()) {
    const err = new Error(`Missing ${stackBin}`);
    err.stdout = '';
    err.stderr = 'zimage-stack is not installed';
    throw err;
  }
  const result = spawnSync(stackBin, args, {
      cwd: studioRoot,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      PATH: `${join(os.homedir(), '.local/bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
    },
  });
  if (check && result.status !== 0) {
    const err = new Error(result.stderr || result.stdout || `zimage-stack ${args.join(' ')} failed`);
    err.status = result.status;
    err.stdout = result.stdout || '';
    err.stderr = result.stderr || '';
    throw err;
  }
  return result;
}

function stackStatus() {
  try {
    return runStack(['status'], { timeout: 15000 });
  } catch (err) {
    return { status: 1, stdout: err.stdout || '', stderr: err.stderr || err.message };
  }
}

function stackLooksRunning() {
  const status = stackStatus();
  const text = `${status.stdout || ''}\n${status.stderr || ''}`;
  return status.status === 0 && /:8788\b/.test(text) && /:8787\b/.test(text) && /:8188\b/.test(text);
}

function stackUrl() {
  if (hasZimageStack()) {
    try {
      const value = execFileSync(stackBin, ['url'], {
        cwd: studioRoot,
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      if (value) return value;
    } catch {}
  }
  return localUrl;
}

function openUrl(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawnSync(opener, args, { stdio: 'ignore', detached: true });
}

function ensureStarted() {
  if (stackLooksRunning()) return;
  const result = runStack(['start'], { timeout: 180000 });
  process.stdout.write(sanitize(result.stdout || ''));
  process.stderr.write(sanitize(result.stderr || ''));
  if (result.status !== 0 && !stackLooksRunning()) {
    process.exitCode = result.status || 1;
  }
}

function printStatus() {
  const status = stackStatus();
  process.stdout.write(sanitize(status.stdout || ''));
  process.stderr.write(sanitize(status.stderr || ''));
  process.exitCode = status.status || 0;
}

function runAction(action) {
  if (action === 'start' && stackLooksRunning()) {
    console.log('Media Studio stack is already running.');
    return;
  }
  const result = runStack([action], { timeout: action === 'status' ? 15000 : 180000 });
  process.stdout.write(sanitize(result.stdout || ''));
  process.stderr.write(sanitize(result.stderr || ''));
  process.exitCode = result.status || 0;
}

function installMacApp() {
  const appsDir = join(os.homedir(), 'Applications');
  const appDir = join(appsDir, `${appName}.app`);
  const contentsDir = join(appDir, 'Contents');
  const macosDir = join(contentsDir, 'MacOS');
  mkdirSync(macosDir, { recursive: true });

  const executable = join(macosDir, appName);
  const shell = `#!/bin/zsh
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "${projectRoot}"
exec /usr/bin/env node "${join(projectRoot, 'bin/image-gen-studio.mjs')}" open --start
`;
  writeFileSync(executable, shell);
  chmodSync(executable, 0o755);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>${appName}</string>
  <key>CFBundleIdentifier</key>
  <string>com.liam.media-studio</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <false/>
</dict>
</plist>
`;
  writeFileSync(join(contentsDir, 'Info.plist'), plist);

  console.log(`Installed ${appName}.app at ${appDir}`);
}

function doctor() {
  const checks = [
    ['studio repo', studioRoot],
    ['gateway repo', projectRoot],
    ['ComfyUI', join(workspaceRoot, 'ComfyUI/main.py')],
    ['mobile dist', join(studioRoot, 'packages/comfyui-mobile/dist/index.html')],
    ['OpenGen dist', join(studioRoot, 'packages/open-generative-ai/dist/index.html')],
    ['zimage-stack', stackBin],
    ['token', join(mediaStateRoot, 'secure/zimg-token')],
  ];
  for (const [label, path] of checks) {
    console.log(`${existsSync(path) ? 'ok ' : 'miss'} ${label}: ${path}`);
  }
  const manifest = join(projectRoot, 'studio.runtime.json');
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    console.log(`ok  manifest: ${parsed.name} (${parsed.components.length} components)`);
  }
}

function usage() {
  console.log(`Usage: media-studio <command>

Commands:
  open [--start]        Open the unified Studio app, optionally starting the stack first
  start                 Start the managed stack with zimage-stack
  stop                  Stop the managed stack
  restart               Restart the managed stack
  status                Print sanitized stack status
  url                   Print the Studio URL
  doctor                Check expected local components
  install-macos-app     Install ~/Applications/Media Studio.app
`);
}

const [command = 'open', ...args] = process.argv.slice(2);

try {
  if (command === 'open') {
    if (args.includes('--start')) ensureStarted();
    const url = stackUrl();
    console.log(`Opening ${url}`);
    openUrl(url);
  } else if (['start', 'stop', 'restart'].includes(command)) {
    runAction(command);
  } else if (command === 'status') {
    printStatus();
  } else if (command === 'url') {
    console.log(stackUrl());
  } else if (command === 'doctor') {
    doctor();
  } else if (command === 'install-macos-app') {
    installMacApp();
  } else {
    usage();
    process.exitCode = command === 'help' || command === '--help' || command === '-h' ? 0 : 1;
  }
} catch (err) {
  console.error(sanitize(err.message || String(err)));
  if (err.stdout) process.stdout.write(sanitize(err.stdout));
  if (err.stderr) process.stderr.write(sanitize(err.stderr));
  process.exitCode = 1;
}
