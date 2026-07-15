#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename, extname } from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function usage() {
  return `Usage: node scripts/install-civitai-workflow.mjs --manifest manifests/civitai/ltx23-eros-anchor.json [options]

Options:
  --comfy-dir PATH       ComfyUI checkout. Default: $COMFY_DIR or ~/comfy/ComfyUI
  --endpoint URL         Downloader base URL. Default: $CIVITAI_DOWNLOADER_ENDPOINT or http://127.0.0.1:8787
  --token-file PATH      Downloader bearer token file. Default: ~/comfy/z-image-api/token.txt
  --comfy-url URL        Running ComfyUI URL for object_info checks. Default: http://127.0.0.1:8188
  --install-nodes        Clone declared missing custom-node repositories
  --download-models      Download missing model dependencies with explicit URLs
  --download-optional-models
                         Include optional model dependencies when downloading models
  --skip-download        Reuse an already-downloaded archive from ComfyUI/models
  --platform NAME        Override platform for manifest filtering
  --json                 Print machine-readable JSON only
`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--install-nodes') out.installNodes = true;
    else if (arg === '--download-models') out.downloadModels = true;
    else if (arg === '--download-optional-models') out.downloadOptionalModels = true;
    else if (arg === '--skip-download') out.skipDownload = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function expandHome(value) {
  if (!value) return value;
  return String(value)
    .replace(/^~(?=$|[/\\])/, os.homedir())
    .replaceAll('${HOME}', os.homedir())
    .replaceAll('$HOME', os.homedir())
    .replaceAll('%USERPROFILE%', process.env.USERPROFILE || os.homedir());
}

function repoPath(value) {
  const expanded = expandHome(value);
  return resolve(expanded.startsWith('/') || /^[A-Za-z]:[\\/]/.test(expanded)
    ? expanded
    : join(repoRoot, expanded));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function pathExists(path) {
  try { return existsSync(path); } catch { return false; }
}

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

function safeOutput(text = '') {
  return String(text)
    .replace(/\b100(?:\.\d{1,3}){3}\b/g, '[tailnet-ip]')
    .replace(/token=[^&\s"']+/gi, 'token=[redacted]');
}

function readToken(args) {
  const envToken = process.env.STUDIO_DOWNLOADER_TOKEN || process.env.CIVITAI_DOWNLOADER_TOKEN || process.env.ZIMG_TOKEN;
  if (envToken) return envToken.trim();
  const tokenFile = expandHome(args.tokenFile || process.env.CIVITAI_DOWNLOADER_TOKEN_FILE || '~/comfy/z-image-api/token.txt');
  if (tokenFile && pathExists(tokenFile)) return readFileSync(tokenFile, 'utf8').trim();
  return '';
}

async function requestJson(url, options = {}, token = '') {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { ...options, headers, cache: 'no-store' });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!response.ok) {
    const message = data.error || data.message || response.statusText;
    throw new Error(`${response.status} ${message}`);
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function downloadedArtifactFromSidecar(sidecarPath, versionId) {
  try {
    const data = readJson(sidecarPath);
    const found = data?.modelVersion?.id || data?.versionId;
    if (String(found) !== String(versionId)) return null;
    const artifactPath = sidecarPath.replace(/\.civitai\.json$/i, '');
    return pathExists(artifactPath) ? artifactPath : null;
  } catch {
    return null;
  }
}

function walkFiles(root, out = []) {
  if (!pathExists(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function findDownloadedArtifact(comfyDir, manifest) {
  const expected = manifest.download?.expectedPath
    ? join(comfyDir, manifest.download.expectedPath)
    : null;
  if (expected && pathExists(expected)) return expected;

  const versionId = manifest.modelVersionId || manifest.versionId;
  if (!versionId) return null;
  for (const sidecarPath of walkFiles(join(comfyDir, 'models')).filter((file) => file.endsWith('.civitai.json'))) {
    const artifact = downloadedArtifactFromSidecar(sidecarPath, versionId);
    if (artifact) return artifact;
  }
  return null;
}

async function downloadViaEndpoint(manifest, args, token) {
  if (args.skipDownload) {
    const artifact = findDownloadedArtifact(args.comfyDir, manifest);
    if (!artifact) throw new Error('No existing Civitai artifact found; remove --skip-download or check download.expectedPath');
    return { skipped: true, path: artifact };
  }

  const endpoint = String(args.endpoint || 'http://127.0.0.1:8787').replace(/\/$/, '');
  const body = manifest.fileId
    ? { versionId: manifest.modelVersionId || manifest.versionId, fileId: manifest.fileId }
    : { url: manifest.sourceUrl || manifest.url };
  const job = await requestJson(`${endpoint}/api/civitai/download`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }, token);
  const jobId = job.id;
  if (!jobId) throw new Error('Downloader did not return a job id');
  let current = job;
  for (let i = 0; i < 900; i += 1) {
    current = await requestJson(`${endpoint}/api/civitai/download/${jobId}`, {}, token);
    if (current.status === 'success') return { jobId, path: current.result?.path, result: current.result };
    if (current.status === 'error') throw new Error(current.error || 'Civitai download failed');
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for Civitai download job ${jobId}`);
}

function pythonCommand(comfyDir) {
  const bundled = join(comfyDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (pathExists(bundled)) return bundled;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function extractWorkflowArchive(archivePath, targetDir, outputName, python) {
  mkdirSync(targetDir, { recursive: true });
  const code = String.raw`
import json, os, re, sys, zipfile
archive, target, preferred = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(target, exist_ok=True)
outputs = []
with zipfile.ZipFile(archive) as zf:
    infos = [info for info in zf.infolist() if not info.is_dir() and info.filename.lower().endswith('.json')]
    if not infos:
        raise SystemExit('archive contains no workflow JSON files')
    for index, info in enumerate(infos):
        name = preferred if preferred and len(infos) == 1 else os.path.basename(info.filename)
        name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', '_', name).strip(' .') or f'workflow_{index + 1}.json'
        if not name.lower().endswith('.json'):
            name += '.json'
        dest = os.path.abspath(os.path.join(target, name))
        root = os.path.abspath(target)
        if os.path.commonpath([root, dest]) != root:
            raise SystemExit(f'unsafe archive path: {info.filename}')
        with open(dest, 'wb') as f:
            f.write(zf.read(info))
        outputs.append(dest)
print(json.dumps(outputs))
`;
  const result = spawnSync(python, ['-c', code, archivePath, targetDir, outputName || ''], {
    encoding: 'utf8',
    timeout: 120000
  });
  if (result.status !== 0) {
    throw new Error(safeOutput(result.stderr || result.stdout || 'workflow extraction failed'));
  }
  return JSON.parse(result.stdout);
}

function workflowClasses(path) {
  const data = readJson(path);
  if (Array.isArray(data.nodes)) {
    return [...new Set(data.nodes
      .filter((node) => node && typeof node === 'object' && node.type)
      .map((node) => String(node.type)))].sort();
  }
  return [...new Set(Object.values(data)
    .filter((node) => node && typeof node === 'object' && node.class_type)
    .map((node) => String(node.class_type)))].sort();
}

async function objectInfo(comfyUrl) {
  try {
    const response = await fetch(`${String(comfyUrl).replace(/\/$/, '')}/object_info`, { cache: 'no-store' });
    if (!response.ok) throw new Error(response.statusText);
    return await response.json();
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

function platformMatches(item, platform) {
  const platforms = item.platforms || item.installPlatforms;
  return !Array.isArray(platforms) || platforms.includes(platform);
}

function dependencyGroups(manifest, platform) {
  const byKey = new Map();
  for (const dep of manifest.nodeDependencies || []) {
    if (!platformMatches(dep, platform)) continue;
    if (dep.frontendOnly) continue;
    if (!dep.repo && !dep.directory) continue;
    const key = dep.directory || basename(String(dep.repo || '').replace(/\.git$/i, ''));
    const current = byKey.get(key) || { ...dep, classes: [] };
    if (dep.class) current.classes.push(dep.class);
    byKey.set(key, current);
  }
  return [...byKey.values()];
}

function run(command, cwd, timeout = 600000) {
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
    stdout: safeOutput(result.stdout || ''),
    stderr: safeOutput(result.stderr || '')
  };
}

function installNodeDependencies(manifest, args, python) {
  const customNodesDir = join(args.comfyDir, 'custom_nodes');
  mkdirSync(customNodesDir, { recursive: true });
  const results = [];
  for (const dep of dependencyGroups(manifest, args.platform)) {
    const directory = dep.directory || basename(String(dep.repo).replace(/\.git$/i, ''));
    const target = join(customNodesDir, directory);
    const result = { directory, repo: dep.repo || '', classes: dep.classes || [], path: target };
    if (pathExists(target)) {
      result.status = 'present';
      results.push(result);
      continue;
    }
    if (!args.installNodes) {
      result.status = 'missing';
      result.install = 'skipped';
      results.push(result);
      continue;
    }
    const clone = run(['git', 'clone', dep.repo, target], customNodesDir);
    result.clone = clone;
    if (!clone.ok) {
      result.status = 'error';
      results.push(result);
      continue;
    }
    const requirements = join(target, 'requirements.txt');
    if (dep.installRequirements !== false && pathExists(requirements) && fileSize(requirements) > 0) {
      result.requirements = run([python, '-m', 'pip', 'install', '-r', requirements], target);
    }
    result.status = result.requirements && !result.requirements.ok ? 'error' : 'installed';
    results.push(result);
  }
  return results;
}

function applyManifestPatches(manifest, args) {
  const customNodesDir = join(args.comfyDir, 'custom_nodes');
  const results = [];
  for (const patch of manifest.patches || []) {
    if (!platformMatches(patch, args.platform)) continue;
    const directory = patch.directory || patch.targetDirectory;
    const patchFile = patch.file || patch.path;
    const target = directory ? join(customNodesDir, directory) : args.comfyDir;
    const patchPath = patchFile ? repoPath(patchFile) : '';
    const result = {
      directory: directory || '.',
      patch: patchFile || '',
      path: target,
      description: patch.description || ''
    };

    if (!patchPath || !pathExists(patchPath)) {
      result.status = 'missing-patch';
      results.push(result);
      continue;
    }
    if (!pathExists(target)) {
      result.status = 'missing-target';
      results.push(result);
      continue;
    }

    const applyFlags = patch.unidiffZero ? ['--unidiff-zero'] : [];
    const reverseCheck = run(['git', 'apply', ...applyFlags, '--reverse', '--check', patchPath], target, 120000);
    if (reverseCheck.ok) {
      result.status = 'present';
      results.push(result);
      continue;
    }

    const check = run(['git', 'apply', ...applyFlags, '--check', patchPath], target, 120000);
    result.check = check;
    if (!check.ok) {
      result.status = 'error';
      results.push(result);
      continue;
    }

    const applied = run(['git', 'apply', ...applyFlags, patchPath], target, 120000);
    result.apply = applied;
    result.status = applied.ok ? 'applied' : 'error';
    results.push(result);
  }
  return results;
}

function modelPath(comfyDir, dep) {
  const rel = String(dep.relativePath || dep.name || '').replaceAll('\\', '/');
  return join(comfyDir, 'models', dep.folder, rel);
}

async function downloadFile(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  if (!response.body) throw new Error('download response had no body');
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));
  renameSync(tmp, dest);
}

async function checkModelDependencies(manifest, args) {
  const results = [];
  for (const dep of manifest.modelDependencies || []) {
    if (!platformMatches(dep, args.platform)) continue;
    const target = modelPath(args.comfyDir, dep);
    const entry = {
      name: dep.name || dep.relativePath,
      folder: dep.folder,
      path: target,
      required: dep.required !== false,
      present: pathExists(target),
      size: pathExists(target) ? fileSize(target) : 0
    };
    const shouldDownload = args.downloadModels && dep.url && (entry.required || args.downloadOptionalModels);
    if (!entry.present && shouldDownload) {
      await downloadFile(dep.url, target);
      entry.present = pathExists(target);
      entry.size = pathExists(target) ? fileSize(target) : 0;
      entry.downloaded = entry.present;
    }
    results.push(entry);
  }
  return results;
}

function classifyMissingClasses(classes, objectMap, manifest, platform) {
  if (!objectMap || objectMap.error) return { skipped: objectMap?.error || 'object_info unavailable', missing: [] };
  const known = new Set(Object.keys(objectMap));
  const frontendOnly = new Set((manifest.nodeDependencies || [])
    .filter((dep) => dep.frontendOnly && platformMatches(dep, platform))
    .map((dep) => dep.class));
  const optional = new Set((manifest.nodeDependencies || [])
    .filter((dep) => dep.required === false || !platformMatches(dep, platform))
    .map((dep) => dep.class));
  const missing = classes
    .filter((klass) => !known.has(klass))
    .filter((klass) => !frontendOnly.has(klass))
    .map((klass) => ({ class: klass, optional: optional.has(klass) }));
  return { missing };
}

function printHuman(report) {
  console.log(`Installed workflow: ${report.workflowFiles.join(', ')}`);
  console.log(`Archive: ${report.archivePath}`);
  if (report.nodeInstalls.length) {
    console.log('\nCustom nodes:');
    for (const item of report.nodeInstalls) {
      console.log(`  ${item.status.padEnd(9)} ${item.directory}`);
    }
  }
  if (report.patches.length) {
    console.log('\nPatches:');
    for (const item of report.patches) {
      console.log(`  ${item.status.padEnd(13)} ${item.directory} ${item.description}`.trimEnd());
      if (item.status === 'error' && item.check?.stderr) console.log(`    ${item.check.stderr.trim()}`);
      if (item.status === 'error' && item.apply?.stderr) console.log(`    ${item.apply.stderr.trim()}`);
    }
  }
  if (report.nodeCheck.skipped) {
    console.log(`\nNode check skipped: ${report.nodeCheck.skipped}`);
  } else {
    const hardMissing = report.nodeCheck.missing.filter((item) => !item.optional).map((item) => item.class);
    const optionalMissing = report.nodeCheck.missing.filter((item) => item.optional).map((item) => item.class);
    console.log(`\nMissing runtime node classes: ${hardMissing.length ? hardMissing.join(', ') : 'none'}`);
    if (optionalMissing.length) console.log(`Optional missing node classes: ${optionalMissing.join(', ')}`);
  }
  const missingModels = report.models.filter((item) => item.required && !item.present);
  console.log(`Missing required model files: ${missingModels.length ? missingModels.map((item) => `${item.folder}/${item.name}`).join(', ') : 'none'}`);
  if (report.restartRequired) console.log('\nRestart ComfyUI to load newly installed custom nodes.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.manifest) throw new Error('Missing --manifest');
  args.manifest = resolve(expandHome(args.manifest));
  args.comfyDir = resolve(expandHome(args.comfyDir || process.env.COMFY_DIR || '~/comfy/ComfyUI'));
  args.endpoint = args.endpoint || process.env.CIVITAI_DOWNLOADER_ENDPOINT || 'http://127.0.0.1:8787';
  args.comfyUrl = args.comfyUrl || process.env.COMFY_URL || 'http://127.0.0.1:8188';
  args.platform = args.platform || process.platform;

  const manifest = readJson(args.manifest);
  const token = readToken(args);
  const python = pythonCommand(args.comfyDir);
  const download = await downloadViaEndpoint(manifest, args, token);
  const archivePath = download.path;
  if (!archivePath || !pathExists(archivePath)) throw new Error('Downloaded archive path is missing');

  const workflowTarget = join(args.comfyDir, manifest.workflow?.extractTo || `workflows/civitai/${manifest.id || 'workflow'}`);
  const workflowFiles = extractWorkflowArchive(archivePath, workflowTarget, manifest.workflow?.outputName, python);
  const metadataPath = join(workflowTarget, 'install-metadata.json');
  writeFileSync(metadataPath, JSON.stringify({
    installedAt: new Date().toISOString(),
    manifest: basename(args.manifest),
    sourceUrl: manifest.sourceUrl,
    archivePath,
    workflowFiles
  }, null, 2));

  const nodeInstalls = installNodeDependencies(manifest, args, python);
  const patches = applyManifestPatches(manifest, args);
  const models = await checkModelDependencies(manifest, args);
  const classes = [...new Set(workflowFiles.flatMap((file) => workflowClasses(file)))].sort();
  const objectMap = await objectInfo(args.comfyUrl);
  const nodeCheck = classifyMissingClasses(classes, objectMap, manifest, args.platform);
  const restartRequired = nodeInstalls.some((item) => item.status === 'installed');
  const missingRequiredModels = models.filter((item) => item.required && !item.present);
  const missingRequiredNodes = nodeCheck.missing?.filter((item) => !item.optional).map((item) => item.class) || [];
  const failedPatches = patches.filter((item) => item.status === 'error' || item.status === 'missing-patch' || item.status === 'missing-target');

  const report = {
    ok: missingRequiredModels.length === 0 && missingRequiredNodes.length === 0 && failedPatches.length === 0 && !restartRequired,
    workflowInstalled: true,
    runtimeReady: missingRequiredModels.length === 0 && missingRequiredNodes.length === 0 && failedPatches.length === 0 && !restartRequired,
    id: manifest.id,
    archivePath,
    workflowFiles,
    metadataPath,
    nodeInstalls,
    patches,
    nodeCheck,
    models,
    restartRequired,
    download: { skipped: Boolean(download.skipped), jobId: download.jobId || null }
  };

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
}

main().catch((error) => {
  console.error(safeOutput(error.stack || error.message || String(error)));
  process.exitCode = 1;
});
