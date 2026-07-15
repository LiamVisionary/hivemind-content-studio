const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
let electronApp = null;
try { electronApp = require('electron').app; } catch (_) { electronApp = null; }

function appPath(name) {
    if (electronApp?.getPath) return electronApp.getPath(name);
    if (name === 'home') return process.env.HOME || process.env.USERPROFILE || process.cwd();
    if (name === 'temp') return require('os').tmpdir();
    return process.cwd();
}

const DEFAULT_REPO = path.join(appPath('home'), 'voice-lab', 'ideogram4');
const REPO_DIR = process.env.IDEOGRAM4_REPO_DIR || DEFAULT_REPO;
const PYTHON_BIN = process.env.IDEOGRAM4_PYTHON || path.join(REPO_DIR, '.venv', 'bin', 'python');
const MLX_PYTHON_BIN = process.env.IDEOGRAM4_MLX_PYTHON || PYTHON_BIN;
const SIDECAR_PORT = Number(process.env.IDEOGRAM4_MLX_PORT || 8807);
const SIDECAR_SCRIPT = process.env.IDEOGRAM4_MLX_SIDECAR || path.join(REPO_DIR, 'scripts', 'ideogram4_mlx_sidecar.py');
const SIDECAR_EXPOSURE = (process.env.IDEOGRAM4_MLX_EXPOSURE || 'tailnet').toLowerCase();
const TOKEN_FILE = process.env.IDEOGRAM4_MLX_TOKEN_FILE || path.join(REPO_DIR, '.ideogram4-mlx-token');

let sidecarProcess = null;
let sidecarStarting = null;

function loadEnvFile(filePath) {
    try {
        const raw = fs.readFileSync(filePath).toString('utf8').replace(/\u0000/g, '\n');
        const env = {};
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
            const idx = trimmed.indexOf('=');
            const key = trimmed.slice(0, idx).trim();
            let value = trimmed.slice(idx + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (key) env[key] = value;
        }
        return env;
    } catch (_) {
        return {};
    }
}

function discoverTailnetHost() {
    if (process.env.IDEOGRAM4_MLX_TAILNET_HOST) return process.env.IDEOGRAM4_MLX_TAILNET_HOST.trim();
    const candidates = [
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
        'tailscale',
    ];
    for (const cmd of candidates) {
        try {
            const out = execFileSync(cmd, ['ip', '-4'], { encoding: 'utf8', timeout: 3000 }).trim();
            const first = out.split(/\s+/).find(Boolean);
            if (first) return first;
        } catch (_) {}
    }
    return '';
}

function resolveSidecarHost() {
    if (process.env.IDEOGRAM4_MLX_HOST) return process.env.IDEOGRAM4_MLX_HOST.trim();
    if (SIDECAR_EXPOSURE === 'tailnet') {
        const host = discoverTailnetHost();
        if (!host) throw new Error('IDEOGRAM4_MLX_EXPOSURE=tailnet requires Tailscale; could not discover a Tailscale IPv4 address.');
        return host;
    }
    return '127.0.0.1';
}

function readOrCreateToken() {
    if (process.env.IDEOGRAM4_MLX_TOKEN) return process.env.IDEOGRAM4_MLX_TOKEN;
    try {
        const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        if (existing) return existing;
    } catch (_) {}
    const token = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
    try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (_) {}
    return token;
}

function buildSidecarHeaders(extra = {}) {
    const token = readOrCreateToken();
    return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

function buildProviderEnv() {
    const sidecarHost = resolveSidecarHost();
    const env = {
        ...process.env,
        ...loadEnvFile(path.join(appPath('home'), '.hivemindos', '.env')),
        ...loadEnvFile(path.join(appPath('home'), '.hermes', '.env')),
        PYTORCH_ENABLE_MPS_FALLBACK: process.env.PYTORCH_ENABLE_MPS_FALLBACK || '1',
        IDEOGRAM4_MLX_EXPOSURE: SIDECAR_EXPOSURE,
        IDEOGRAM4_MLX_HOST: sidecarHost,
        IDEOGRAM4_MLX_PORT: String(SIDECAR_PORT),
        IDEOGRAM4_MLX_TOKEN: readOrCreateToken(),
        IDEOGRAM4_MLX_TOKEN_FILE: TOKEN_FILE,
    };
    if (!env.HF_TOKEN) {
        env.HF_TOKEN = env.HUGGINGFACE_READ_WRITE_KEY || env.HUGGINGFACE_TOKEN || env.HUGGINGFACE_HUB_TOKEN || '';
    }
    return env;
}

function arToDimensions(ar) {
    const map = {
        '1:1': [1024, 1024],
        '16:9': [1536, 864],
        '9:16': [864, 1536],
        '4:3': [1280, 960],
        '3:4': [960, 1280],
    };
    return map[ar] || [1024, 1024];
}

function isInstalled() {
    return fs.existsSync(path.join(REPO_DIR, 'run_inference.py')) && fs.existsSync(PYTHON_BIN);
}

function isMlxInstalled() {
    return isInstalled()
        && process.platform === 'darwin'
        && process.arch === 'arm64'
        && fs.existsSync(MLX_PYTHON_BIN)
        && fs.existsSync(SIDECAR_SCRIPT);
}

function buildSidecarUrl(route = '/') {
    const clean = route.startsWith('/') ? route : `/${route}`;
    return `http://${resolveSidecarHost()}:${SIDECAR_PORT}${clean}`;
}

function buildLoopbackSidecarUrl(route = '/') {
    const previous = process.env.IDEOGRAM4_MLX_HOST;
    process.env.IDEOGRAM4_MLX_HOST = '127.0.0.1';
    try { return buildSidecarUrl(route); }
    finally {
        if (previous === undefined) delete process.env.IDEOGRAM4_MLX_HOST;
        else process.env.IDEOGRAM4_MLX_HOST = previous;
    }
}

function isAllowedSidecarUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:'
            && parsed.hostname === resolveSidecarHost()
            && Number(parsed.port || 80) === SIDECAR_PORT;
    } catch (_) {
        return false;
    }
}

function isLoopbackSidecarUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:'
            && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)
            && Number(parsed.port || 80) === SIDECAR_PORT;
    } catch (_) {
        return false;
    }
}

function resolveRuntimeMode(params = {}) {
    const requested = String(params.runtime_mode || params.runtimeMode || '').toLowerCase();
    if (requested === 'persistent' || requested === 'keep-warm' || requested === 'keep_warm') return 'persistent';
    if (requested === 'one-off' || requested === 'one_off' || requested === 'oneshot') return 'one-off';
    if (params.persistent === true || params.keepWarm === true) return 'persistent';
    if (process.env.IDEOGRAM4_RUNTIME_MODE === 'persistent') return 'persistent';
    return 'one-off';
}

function status() {
    let url = null;
    let hostError = null;
    try { url = buildSidecarUrl('/').replace(/\/$/, ''); } catch (e) { hostError = e.message; }
    return {
        installed: isInstalled(),
        repoDir: REPO_DIR,
        python: PYTHON_BIN,
        mlx: {
            installed: isMlxInstalled(),
            python: MLX_PYTHON_BIN,
            script: SIDECAR_SCRIPT,
            url,
            hostError,
            running: !!sidecarProcess,
            exposure: SIDECAR_EXPOSURE,
            requiresAuth: true,
            tokenFile: TOKEN_FILE,
            secure: SIDECAR_EXPOSURE === 'tailnet' ? 'tailnet-http-bearer' : 'loopback-http-bearer',
            note: SIDECAR_EXPOSURE === 'tailnet'
                ? 'HTTP is bound to this Mac\'s Tailscale interface and protected with a bearer token; traffic stays inside the Tailnet overlay.'
                : 'HTTP is bound to loopback and protected with a bearer token.',
        },
    };
}

function localHttpJson(url, options = {}) {
    if (!isAllowedSidecarUrl(url)) return Promise.reject(new Error(`Refusing non-approved Ideogram sidecar URL: ${url}`));
    return new Promise((resolve, reject) => {
        const payload = options.body ? Buffer.from(options.body) : null;
        const headers = buildSidecarHeaders(options.headers || {});
        if (payload) headers['Content-Length'] = String(payload.length);
        const parsed = new URL(url);
        const req = http.request({
            method: options.method || 'GET',
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            headers,
            timeout: options.timeout || 30000,
        }, (res) => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data = {};
                try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(data.detail || data.error || `HTTP ${res.statusCode}`));
                    return;
                }
                resolve(data);
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('request timed out')));
        if (payload) req.write(payload);
        req.end();
    });
}

async function probeSidecar(timeout = 1500) {
    try {
        return await localHttpJson(buildSidecarUrl('/v1/health'), { timeout });
    } catch (_) {
        return null;
    }
}

async function ensureSidecar(mainWindow) {
    if (!isMlxInstalled()) {
        throw new Error(`Ideogram 4 MLX sidecar is not available. Expected ${SIDECAR_SCRIPT} and ${MLX_PYTHON_BIN}.`);
    }
    const existing = await probeSidecar();
    if (existing?.ok) return existing;
    if (sidecarStarting) return sidecarStarting;

    const send = (data) => mainWindow?.webContents.send('local-ai:progress', data);
    sidecarStarting = new Promise((resolve, reject) => {
        send({ step: 0, totalSteps: 1, status: 'starting', progress: 0, message: 'Starting persistent Ideogram 4 MLX sidecar' });
        const env = buildProviderEnv();
        sidecarProcess = spawn(MLX_PYTHON_BIN, [SIDECAR_SCRIPT], {
            cwd: REPO_DIR,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const output = [];
        const handle = (buf) => {
            const text = buf.toString();
            output.push(text.trimEnd());
            if (text.includes('Loading')) {
                send({ step: 0, totalSteps: 1, status: 'loading', progress: 0.02, message: text.trim().slice(0, 120) });
            }
        };
        sidecarProcess.stdout.on('data', handle);
        sidecarProcess.stderr.on('data', handle);
        sidecarProcess.on('error', (err) => {
            sidecarProcess = null;
            sidecarStarting = null;
            reject(err);
        });
        sidecarProcess.on('close', (code) => {
            sidecarProcess = null;
            if (sidecarStarting) {
                const tail = output.filter(Boolean).slice(-30).join('\n');
                sidecarStarting = null;
                reject(new Error(`Ideogram 4 MLX sidecar exited during startup (${code}):\n${tail}`));
            }
        });

        const startedAt = Date.now();
        const poll = async () => {
            const health = await probeSidecar(2000);
            if (health?.ok) {
                sidecarStarting = null;
                resolve(health);
                return;
            }
            if (Date.now() - startedAt > 10 * 60 * 1000) {
                const tail = output.filter(Boolean).slice(-30).join('\n');
                sidecarStarting = null;
                reject(new Error(`Timed out starting Ideogram 4 MLX sidecar:\n${tail}`));
                return;
            }
            setTimeout(poll, 2000);
        };
        setTimeout(poll, 1000);
    });
    return sidecarStarting;
}

async function generatePersistent(params, mainWindow) {
    const send = (data) => mainWindow?.webContents.send('local-ai:progress', data);
    const [width, height] = arToDimensions(params.aspect_ratio || '1:1');
    const seed = params.seed && params.seed !== -1 ? Number(params.seed) : Math.floor(Math.random() * 2147483647);
    const samplerPreset = params.sampler_preset || process.env.IDEOGRAM4_MLX_SAMPLER_PRESET || 'V4_QUALITY_48';
    await ensureSidecar(mainWindow);
    send({ step: 0, totalSteps: 1, status: 'queued', progress: 0.03, message: 'Submitting to warm Ideogram 4 MLX sidecar' });
    const result = await localHttpJson(buildSidecarUrl('/v1/images/generate'), {
        method: 'POST',
        timeout: 15 * 60 * 1000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt: params.prompt || '',
            width,
            height,
            seed,
            sampler_preset: samplerPreset,
            magic_prompt: params.magic_prompt !== false,
            local_magic_prompt_base_url: process.env.LM_STUDIO_BASE_URL || undefined,
        }),
    });
    if (!result?.image_base64) throw new Error('Ideogram 4 MLX sidecar returned no image.');
    send({ step: 1, totalSteps: 1, status: 'done', progress: 1 });
    return { url: `data:${result.content_type || 'image/png'};base64,${result.image_base64}`, seed: result.seed ?? seed, runtime: 'ideogram4-mlx-persistent' };
}

async function generateOneOff(params, mainWindow) {
    if (!isInstalled()) {
        throw new Error(`Ideogram 4 runtime is not installed at ${REPO_DIR}. Expected ${PYTHON_BIN}.`);
    }

    const send = (data) => mainWindow?.webContents.send('local-ai:progress', data);
    const [width, height] = arToDimensions(params.aspect_ratio || '1:1');
    const steps = Math.max(1, Math.round(Number(params.steps) || 12));
    const seed = params.seed && params.seed !== -1 ? Number(params.seed) : Math.floor(Math.random() * 2147483647);
    const outPath = path.join(appPath('temp'), `ideogram4-${Date.now()}.png`);

    const args = [
        path.join(REPO_DIR, 'run_inference.py'),
        '--prompt', params.prompt || '',
        '--output', outPath,
        '--height', String(height),
        '--width', String(width),
        '--seed', String(seed),
        '--device', process.env.IDEOGRAM4_DEVICE || 'mps',
        '--quantization', process.env.IDEOGRAM4_QUANTIZATION || 'fp8',
        '--sampler-preset', process.env.IDEOGRAM4_SAMPLER_PRESET || 'V4_TURBO_12',
    ];
    const providerEnv = buildProviderEnv();
    if (!providerEnv.IDEOGRAM_API_KEY && !providerEnv.MAGIC_PROMPT_API_KEY) {
        args.push('--no-magic-prompt');
    }
    args.push('--warn-on-caption-issues');

    send({ step: 0, totalSteps: steps, status: 'starting', progress: 0, message: 'Loading Ideogram 4 runtime' });

    return new Promise((resolve, reject) => {
        const child = spawn(PYTHON_BIN, args, {
            cwd: REPO_DIR,
            env: providerEnv,
        });
        const output = [];
        let sawExpansion = false;

        const handle = (buf) => {
            const text = buf.toString();
            output.push(text.trimEnd());
            if (!sawExpansion && text.includes('Expanded caption')) {
                sawExpansion = true;
                send({ step: 1, totalSteps: steps, status: 'prompt-expanded', progress: 0.08, message: 'Expanded Ideogram structured prompt' });
            }
            const matches = [...text.matchAll(/(\d+)\s*\/\s*(\d+)\s*-\s*[\d.]+s\/it/g)];
            for (const m of matches) {
                const step = Number(m[1]);
                const total = Number(m[2]);
                if (Number.isFinite(step) && Number.isFinite(total) && total > 0) {
                    send({ step, totalSteps: total, status: 'generating', progress: Math.min(0.95, step / total) });
                }
            }
        };

        child.stdout.on('data', handle);
        child.stderr.on('data', handle);
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                const tail = output.filter(Boolean).slice(-30).join('\n');
                reject(new Error(`Ideogram 4 exited with code ${code}:\n${tail}`));
                return;
            }
            if (!fs.existsSync(outPath)) {
                reject(new Error('Ideogram 4 finished but no output image was found.'));
                return;
            }
            const img = fs.readFileSync(outPath);
            fs.unlinkSync(outPath);
            send({ step: steps, totalSteps: steps, status: 'done', progress: 1 });
            resolve({ url: `data:image/png;base64,${img.toString('base64')}`, seed, runtime: 'ideogram4-one-off' });
        });
    });
}

async function generate(params, mainWindow) {
    return resolveRuntimeMode(params) === 'persistent'
        ? generatePersistent(params, mainWindow)
        : generateOneOff(params, mainWindow);
}

async function warmPersistent(mainWindow) {
    await ensureSidecar(mainWindow);
    return localHttpJson(buildSidecarUrl('/v1/warm'), { method: 'POST', timeout: 10 * 60 * 1000 });
}

function stopPersistent() {
    if (sidecarProcess) {
        sidecarProcess.kill('SIGTERM');
        sidecarProcess = null;
    }
    sidecarStarting = null;
    return { ok: true };
}

module.exports = {
    generate,
    status,
    warmPersistent,
    stopPersistent,
    resolveRuntimeMode,
    buildSidecarHeaders,
    buildSidecarUrl,
    buildLoopbackSidecarUrl,
    isAllowedSidecarUrl,
    isLoopbackSidecarUrl,
};
