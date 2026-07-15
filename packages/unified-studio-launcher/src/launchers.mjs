import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

function safeName(name) {
  return String(name || 'Unified Media Studio').replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim() || 'Unified Media Studio';
}

function slugName(name) {
  return safeName(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unified-media-studio';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function winQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function commandArgs(config) {
  const args = ['serve', '--start', '--open'];
  if (config.configPath) args.push('--config', config.configPath);
  return args;
}

export function launcherTargets(config, platform = process.platform) {
  const name = safeName(config.name);
  const slug = slugName(name);
  if (platform === 'darwin') {
    const appDir = join(os.homedir(), 'Applications', `${name}.app`);
    return {
      platform,
      kind: 'macos-app',
      appDir,
      executable: join(appDir, 'Contents', 'MacOS', name),
      plist: join(appDir, 'Contents', 'Info.plist')
    };
  }
  if (platform === 'win32') {
    const programsDir = process.env.APPDATA
      ? join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
      : os.homedir();
    return {
      platform,
      kind: 'windows-cmd',
      commandFile: join(programsDir, `${name}.cmd`)
    };
  }
  return {
    platform,
    kind: 'linux-desktop',
    script: join(os.homedir(), '.local', 'bin', slug),
    desktopFile: join(os.homedir(), '.local', 'share', 'applications', `${slug}.desktop`)
  };
}

export function installLauncher(config, platform = process.platform) {
  const targets = launcherTargets(config, platform);
  const repoRoot = config.repoRoot;
  const cliPath = join(repoRoot, 'src', 'cli.mjs');
  const args = commandArgs(config);

  if (platform === 'darwin') {
    mkdirSync(join(targets.appDir, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(targets.executable, `#!/bin/sh
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd ${shellQuote(repoRoot)} || exit 1
exec /usr/bin/env node ${shellQuote(cliPath)} ${args.map(shellQuote).join(' ')}
`);
    chmodSync(targets.executable, 0o755);
    writeFileSync(targets.plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>${xmlEscape(config.name)}</string>
  <key>CFBundleIdentifier</key><string>app.unified-media-studio.local</string>
  <key>CFBundleName</key><string>${xmlEscape(config.name)}</string>
  <key>CFBundleDisplayName</key><string>${xmlEscape(config.name)}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
</dict>
</plist>
`);
    return targets;
  }

  if (platform === 'win32') {
    mkdirSync(join(targets.commandFile, '..'), { recursive: true });
    writeFileSync(targets.commandFile, `@echo off
setlocal
cd /d ${winQuote(repoRoot)}
node ${winQuote(cliPath)} ${args.map(winQuote).join(' ')}
if errorlevel 1 pause
`);
    return targets;
  }

  mkdirSync(join(targets.script, '..'), { recursive: true });
  mkdirSync(join(targets.desktopFile, '..'), { recursive: true });
  writeFileSync(targets.script, `#!/bin/sh
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd ${shellQuote(repoRoot)} || exit 1
exec node ${shellQuote(cliPath)} ${args.map(shellQuote).join(' ')}
`);
  chmodSync(targets.script, 0o755);
  writeFileSync(targets.desktopFile, `[Desktop Entry]
Type=Application
Name=${config.name}
Exec=${targets.script}
Terminal=false
Categories=Graphics;Development;
`);
  return targets;
}
