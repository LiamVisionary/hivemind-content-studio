const HIVE_VIDEO_PREFIX = 'hivemind-media:';
const VIDEO_SELECTION_KEY = 'hivemind.explore.videoSelection';
const OPTIONS_KEY = 'hivemind.explore.options';
const PENDING_JOBS_KEY = 'muapi_pending_jobs';

let contextPromise = null;
let contextCache = null;
let hiveVideoModels = [];
const uploadedFiles = new Map();

const qs = () => new URLSearchParams(window.location.search);

export function isHivemindStudioEnabled() {
    return qs().get('hivemindStudio') === '1';
}

function scrubLegacyPersistentCreativeState() {
    if (!isHivemindStudioEnabled()) return;
    try { localStorage.removeItem('muapi_history'); } catch {}
    try { localStorage.removeItem('video_history'); } catch {}
    try { localStorage.removeItem(PENDING_JOBS_KEY); } catch {}
}

export function loadStudioGenerationHistory(storageKey) {
    if (isHivemindStudioEnabled()) {
        scrubLegacyPersistentCreativeState();
        return [];
    }
    try {
        const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function saveStudioGenerationHistory(storageKey, entries, limit) {
    if (isHivemindStudioEnabled()) {
        scrubLegacyPersistentCreativeState();
        return;
    }
    try {
        localStorage.setItem(storageKey, JSON.stringify(entries.slice(0, limit)));
    } catch {}
}

export function clearHivemindStudioPrivateState() {
    scrubLegacyPersistentCreativeState();
    try { sessionStorage.removeItem(PENDING_JOBS_KEY); } catch {}
    try { sessionStorage.removeItem(VIDEO_SELECTION_KEY); } catch {}
    try { sessionStorage.removeItem(OPTIONS_KEY); } catch {}
    for (const url of uploadedFiles.keys()) URL.revokeObjectURL(url);
    uploadedFiles.clear();
    contextPromise = null;
    contextCache = null;
}

function defaultContext() {
    return { catalog: null, prompts: [], videoModels: [] };
}

function workflowProvider(catalog) {
    return catalog?.media?.video?.find((provider) => provider.id === 'media-studio-mcp') || null;
}

function workflowModelId(workflowId) {
    return `${HIVE_VIDEO_PREFIX}${encodeURIComponent(workflowId)}`;
}

export function isHivemindVideoModelId(id) {
    return typeof id === 'string' && id.startsWith(HIVE_VIDEO_PREFIX);
}

export function workflowIdFromHivemindModelId(id) {
    return decodeURIComponent(String(id || '').slice(HIVE_VIDEO_PREFIX.length));
}

export function getHivemindVideoModelById(id) {
    return hiveVideoModels.find((model) => model.id === id) || null;
}

function mapWorkflowModels(catalog) {
    const provider = workflowProvider(catalog);
    if (!provider?.models?.length) return [];
    return provider.models.map((workflow) => ({
        ...(() => {
            const accepts = Array.isArray(workflow.accepts) ? workflow.accepts : [];
            return {
                accepts,
                supportsVideoInput: accepts.some((field) => String(field).startsWith('video_')),
                videoModes: accepts.includes('video_mode') ? ['extend'] : [],
            };
        })(),
        id: workflowModelId(workflow.id),
        workflowId: workflow.id,
        name: workflow.label || workflow.id,
        description: `${provider.label || 'Media Studio'} workflow`,
        type: 'video',
        family: 'hivemind-media-studio',
        provider: 'hivemind-media-studio',
        needsImage: !Array.isArray(workflow.accepts) || !workflow.accepts.some((field) => String(field).startsWith('video_')),
        ready: Boolean(provider.available),
        detail: provider.detail || '',
        aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        defaultDuration: 4,
        tags: ['video', 'workflow', 'local'],
    }));
}

export async function loadHivemindStudioContext({ refresh = false } = {}) {
    if (!isHivemindStudioEnabled()) return defaultContext();
    if (contextCache && !refresh) return contextCache;
    if (!contextPromise || refresh) {
        contextPromise = Promise.all([
            fetch('/api/simple/catalog', { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.ok ? r.json() : null).catch(() => null),
            fetch('/api/simple/prompts?favorites=true&limit=40', { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.ok ? r.json() : null).catch(() => null),
        ]).then(([catalog, promptPayload]) => {
            const normalizedCatalog = catalog?.ok ? catalog : null;
            hiveVideoModels = mapWorkflowModels(normalizedCatalog);
            contextCache = {
                catalog: normalizedCatalog,
                prompts: Array.isArray(promptPayload?.prompts) ? promptPayload.prompts : [],
                videoModels: hiveVideoModels,
            };
            return contextCache;
        });
    }
    return contextPromise;
}

export async function uploadFileToHivemindStudio(file) {
    const url = URL.createObjectURL(file);
    uploadedFiles.set(url, file);
    return { url, path: url };
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Could not read image file'));
        reader.readAsDataURL(blob);
    });
}

async function mediaSourceToDataUrl(source, kind) {
    if (!source) return null;
    if (String(source).startsWith(`data:${kind}/`)) return source;
    const remembered = uploadedFiles.get(source);
    if (remembered) return blobToDataUrl(remembered);
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Could not read the selected ${kind}.`);
    return blobToDataUrl(await response.blob());
}

export function getHivemindStudioOptions() {
    try {
        return { promptHelper: true, passthrough: false, walkthrough: false, ...JSON.parse(sessionStorage.getItem(OPTIONS_KEY) || '{}') };
    } catch {
        return { promptHelper: true, passthrough: false, walkthrough: false };
    }
}

function saveHivemindStudioOptions(options) {
    sessionStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
}

export function getSavedHivemindVideoSelection() {
    try {
        return JSON.parse(sessionStorage.getItem(VIDEO_SELECTION_KEY) || 'null');
    } catch {
        return null;
    }
}

function saveHivemindVideoSelection(selection) {
    sessionStorage.setItem(VIDEO_SELECTION_KEY, JSON.stringify(selection));
}

export async function generateHivemindVideo(params) {
    const videoBase64 = params.video_base64 || await mediaSourceToDataUrl(params.video || params.video_url, 'video');
    const imageBase64 = videoBase64 ? null : (params.image_base64 || await mediaSourceToDataUrl(params.image || params.image_url, 'image'));
    if (!videoBase64 && !imageBase64) throw new Error('Upload a start image or source video for this local workflow.');
    const workflowId = params.workflow_id || workflowIdFromHivemindModelId(params.model);
    const response = await fetch('/api/media-studio/video', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt: params.prompt || '',
            workflow_id: workflowId,
            ...(videoBase64 ? { video_base64: videoBase64, video_mode: 'extend' } : { image_base64: imageBase64 }),
            duration_seconds: params.duration || params.duration_seconds || 4,
            aspect_ratio: params.aspect_ratio || '',
        }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
        throw new Error(data.detail || data.error || `Media Studio generation failed with HTTP ${response.status}`);
    }
    return { ...data, id: data.job_id || data.id, url: data.url || data.media_url || data.output_url };
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[char]));
}

function insertIntoPrompt(text) {
    const active = document.activeElement;
    const target = active?.tagName === 'TEXTAREA' && !active.disabled
        ? active
        : document.querySelector('#content-area textarea:not([disabled])') || document.querySelector('textarea:not([disabled])');
    if (!target) return false;
    const current = target.value.trim();
    target.value = current ? `${target.value.replace(/\s+$/, '')}\n${text}` : text;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.focus();
    target.setSelectionRange(target.value.length, target.value.length);
    return true;
}

function renderItems(items, kind) {
    if (!items.length) return '<p class="text-[11px] text-white/40 px-2 py-3">Nothing saved yet.</p>';
    return items.slice(0, 8).map((item) => {
        const label = kind === 'template' ? item.title : item.prompt;
        const text = kind === 'template' ? item.description : item.prompt;
        const id = kind === 'template' ? item.id : item.prompt_id;
        return `
            <button type="button" data-hive-${kind}="${escapeHtml(id)}" class="w-full text-left rounded-xl border border-white/5 bg-white/[0.03] hover:bg-white/[0.07] px-3 py-2 transition-colors">
                <span class="block text-xs font-bold text-white truncate">${escapeHtml(label)}</span>
                <span class="block text-[10px] text-white/45 truncate">${escapeHtml(text)}</span>
            </button>
        `;
    }).join('');
}

function renderDock(panel, context) {
    const templates = context.catalog?.templates || [];
    const options = getHivemindStudioOptions();
    panel.innerHTML = `
        <div class="flex items-center justify-between gap-3 border-b border-white/10 pb-3">
            <div>
                <div class="text-[10px] font-black uppercase tracking-[0.22em] text-primary">Hivemind</div>
                <div class="text-sm font-black text-white">Studio tools</div>
            </div>
            <button type="button" data-hive-close class="h-8 w-8 rounded-lg bg-white/5 text-white/70 hover:bg-white/10">x</button>
        </div>
        <div class="grid gap-3 pt-3">
            <label class="grid gap-1.5">
                <span class="text-[10px] font-bold uppercase tracking-widest text-white/45">Local video workflow</span>
                <select data-hive-video-workflow class="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs font-bold text-white outline-none">
                    <option value="">Choose on generate</option>
                    ${context.videoModels.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}</option>`).join('')}
                </select>
            </label>
            <div class="grid grid-cols-3 gap-2">
                <label class="flex items-center justify-between gap-2 rounded-xl border border-white/5 bg-white/[0.03] px-2 py-2 text-[10px] font-bold text-white/70"><span>Helper</span><input data-hive-option="promptHelper" type="checkbox" ${options.promptHelper ? 'checked' : ''}></label>
                <label class="flex items-center justify-between gap-2 rounded-xl border border-white/5 bg-white/[0.03] px-2 py-2 text-[10px] font-bold text-white/70"><span>Pass</span><input data-hive-option="passthrough" type="checkbox" ${options.passthrough ? 'checked' : ''}></label>
                <label class="flex items-center justify-between gap-2 rounded-xl border border-white/5 bg-white/[0.03] px-2 py-2 text-[10px] font-bold text-white/70"><span>Ask</span><input data-hive-option="walkthrough" type="checkbox" ${options.walkthrough ? 'checked' : ''}></label>
            </div>
            <details class="rounded-xl border border-white/5 bg-white/[0.03] p-2">
                <summary class="cursor-pointer text-xs font-black text-white">Templates</summary>
                <div class="mt-2 grid gap-2">${renderItems(templates, 'template')}</div>
            </details>
            <details class="rounded-xl border border-white/5 bg-white/[0.03] p-2">
                <summary class="cursor-pointer text-xs font-black text-white">Ingredients</summary>
                <div class="mt-2 grid gap-2">${renderItems(context.prompts, 'ingredient')}</div>
            </details>
        </div>
    `;
    const saved = getSavedHivemindVideoSelection();
    const select = panel.querySelector('[data-hive-video-workflow]');
    if (select && saved?.modelId) select.value = saved.modelId;
}

export function installHivemindExploreDock() {
    if (!isHivemindStudioEnabled() || document.getElementById('hivemind-explore-dock')) return;
    scrubLegacyPersistentCreativeState();
    const root = document.createElement('div');
    root.id = 'hivemind-explore-dock';
    root.className = 'fixed right-3 top-[76px] z-[90] flex flex-col items-end gap-2';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'h-10 rounded-xl border border-white/10 bg-black/80 px-3 text-xs font-black text-white shadow-2xl backdrop-blur-xl hover:border-primary/50';
    toggle.textContent = 'Hivemind';
    const panel = document.createElement('div');
    panel.className = 'hidden w-[min(21rem,calc(100vw-1.5rem))] rounded-2xl border border-white/10 bg-black/90 p-3 shadow-2xl backdrop-blur-xl';
    root.appendChild(toggle);
    root.appendChild(panel);
    document.body.appendChild(root);

    const open = async () => {
        const context = await loadHivemindStudioContext();
        renderDock(panel, context);
        panel.classList.remove('hidden');
    };
    const close = () => panel.classList.add('hidden');
    toggle.onclick = () => panel.classList.contains('hidden') ? void open() : close();

    panel.addEventListener('click', (event) => {
        const closeButton = event.target.closest('[data-hive-close]');
        if (closeButton) { close(); return; }
        const template = event.target.closest('[data-hive-template]');
        if (template) {
            const item = contextCache?.catalog?.templates?.find((candidate) => candidate.id === template.dataset.hiveTemplate);
            if (item) insertIntoPrompt(item.prompt);
            return;
        }
        const ingredient = event.target.closest('[data-hive-ingredient]');
        if (ingredient) {
            const item = contextCache?.prompts?.find((candidate) => candidate.prompt_id === ingredient.dataset.hiveIngredient);
            if (item) insertIntoPrompt(item.prompt);
        }
    });

    panel.addEventListener('change', (event) => {
        const option = event.target.closest('[data-hive-option]');
        if (option) {
            const current = getHivemindStudioOptions();
            current[option.dataset.hiveOption] = Boolean(option.checked);
            if (option.dataset.hiveOption === 'passthrough' && option.checked) current.promptHelper = false;
            if (option.dataset.hiveOption === 'promptHelper' && option.checked) current.passthrough = false;
            saveHivemindStudioOptions(current);
            renderDock(panel, contextCache || defaultContext());
            return;
        }
        const select = event.target.closest('[data-hive-video-workflow]');
        if (!select) return;
        const model = contextCache?.videoModels?.find((candidate) => candidate.id === select.value);
        if (!model) return;
        saveHivemindVideoSelection({ provider: 'media-studio-mcp', model: model.workflowId, modelId: model.id });
        window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'video' } }));
        window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent('hivemind-workflow-selected', { detail: { modelId: model.id } }));
        }, 0);
    });

    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type === 'hivemind-owner-lock') {
            clearHivemindStudioPrivateState();
            return;
        }
        if (event.data?.type === 'hivemind-explore-insert-prompt') insertIntoPrompt(event.data.text || '');
        if (event.data?.type === 'hivemind-explore-refresh') void loadHivemindStudioContext({ refresh: true });
    });

    window.parent?.postMessage?.({ type: 'hivemind-explore-ready' }, window.location.origin);
    void loadHivemindStudioContext();
}
