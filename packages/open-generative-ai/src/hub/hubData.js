// Hub shared data layer — ported from src/views/hub/hubApp.js (logic only; the
// DOM rendering moved into React views under src/hub/views). Module-level
// singletons (bridge state, polling, owner passphrase) live here so React
// remounts can never reset them. Every fetch route, payload shape, storage key,
// window event, postMessage type, interval, and backoff is preserved verbatim
// from hubApp.js — when in doubt, that file is the contract.
import { useSyncExternalStore } from 'react';
import { toast } from 'react-hot-toast';
import { setApiStatus as setApiStatusStore } from '../app/statusStore.js';
import { decryptMedia } from '../lib/e2eVault.js';
import { loadStudioSetup } from '../app/promptTarget.js';
import { updateComposerSection } from '../lib/composerState.js';
import { basenameOf, resolveGenerationSetup } from '../lib/generationSetupStore.js';

// Prompt fields sealed to the owner vault arrive as "vseal:v1:{envelope}". The
// server holds no key — decrypt them in-browser for display. Fail-soft so a
// locked/failed vault never breaks the prompts list.
const VAULT_TEXT_PREFIX = 'vseal:v1:';
async function decryptVaultText(value) {
  if (typeof value !== 'string' || !value.startsWith(VAULT_TEXT_PREFIX)) return value;
  try {
    const env = JSON.parse(value.slice(VAULT_TEXT_PREFIX.length));
    const buf = await decryptMedia(env.ciphertext, env.wrapped_dek);
    return new TextDecoder().decode(buf);
  } catch {
    return '🔒 Sealed prompt (unlock the vault to view)';
  }
}
async function decryptPromptEntry(entry) {
  const [prompt, user_prompt, title] = await Promise.all([
    decryptVaultText(entry.prompt),
    decryptVaultText(entry.user_prompt),
    decryptVaultText(entry.title),
  ]);
  return { ...entry, prompt, user_prompt, title };
}

// Studio (auto-workflow) outputs record a vault-sealed setup {prompt, seed,
// model} instead of a ComfyUI-mobile node graph. We can decrypt it right here
// in the hub (owner vault), so "Load in Studio" works without the canvas iframe.
function isVaultSealedSetup(workflow) {
  return !!workflow && typeof workflow === 'object'
    && workflow.format === 'hivemind-vault-sealed-setup'
    && typeof workflow.ciphertext === 'string'
    && typeof workflow.wrapped_dek === 'string';
}
async function decryptVaultSealedSetup(workflow) {
  const buf = await decryptMedia(workflow.ciphertext, workflow.wrapped_dek);
  const obj = JSON.parse(new TextDecoder().decode(buf));
  // Return the whole decrypted setup (prompt, negative, seed, steps, cfg, dims,
  // model, loras, apiGraph); callers pick what they need.
  return {
    ...obj,
    primaryPrompt: typeof obj.primaryPrompt === 'string' ? obj.primaryPrompt : '',
    seeds: Array.isArray(obj.seeds) ? obj.seeds : [],
    models: Array.isArray(obj.models) ? obj.models : [],
    apiGraph: obj.apiGraph && typeof obj.apiGraph === 'object' ? obj.apiGraph : null,
  };
}

/* ------------------------------------------------------------------ */
/* Store                                                              */
/* ------------------------------------------------------------------ */

export const hubState = {
  catalog: null,
  runs: [],
  selectedLane: '',
  selectedRunId: '',
  scenes: [{ title: 'Hook', beat: '', overlay: '', voice: '', duration_seconds: 4, image_prompt: '', motion_prompt: '' }],
  statusFilter: '',
  oauth: null,
  simpleCatalog: null,
  simpleAttachments: [],
  simpleHistory: [],
  simplePlan: null,
  createMode: 'simple',
  studioMode: 'create',
  prompts: [],
  canvasHistory: [],
  canvasPage: 0,
  canvasPageSize: 48,
  canvasHasMore: true,
  canvasLoading: false,
  canvasTotal: 0,
  canvasFormat: '',
  canvasModel: '',
  canvasFormats: [],
  canvasModels: [],
  canvasSetups: {},
  canvasWorkflowPayloads: {},
  loadedCanvasSetup: null,
  telemetry: null,
  historyFilter: '',
  activeView: 'create',
  // Simple composer (was DOM state in the persistent hub root)
  composer: { prompt: '', promptHelper: true, walkthrough: false, seed: '-1', seedMode: 'randomize' },
  // Route values — JSON strings exactly as the old hidden inputs stored them
  // (#simple-brain / #simple-image-route / #simple-video-route).
  routes: { brain: '', image: 'automatic', video: 'automatic' },
  thread: [],
  simpleBusy: false,
  simpleBusyLabel: '',
  // Advanced workflow form (was DOM field state)
  workflow: {
    title: '', concept: '', audience: '', goal: '', tone: '', source: '', creator: '',
    aspectRatio: '', runtimeSeconds: '', privacy: '', maxCost: '0',
    voiceEnabled: true, voiceDelivery: '', voiceId: '',
    subtitlesEnabled: true, subtitlePosition: 'bottom', subtitleSize: '56',
    mediaSource: 'pexels', videoCount: '3', clipDuration: '3',
    publishCaption: '', publishCta: '', platforms: [], providerRoles: {},
    operatorToken: '',
  },
  // Fallback so Canvas still embeds when /api/surfaces is unreachable
  // (e.g. running the UI standalone on the vite dev server).
  surfaces: { surfaces: { canvas: { gateway_path: '/mobile/' } } },
};

let version = 0;
const listeners = new Set();

export function notifyHub() {
  version += 1;
  listeners.forEach((fn) => fn());
}

export function subscribeHub(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const getVersion = () => version;

// Components call useHub() and read hubState fields; any notifyHub() re-renders.
export function useHub() {
  useSyncExternalStore(subscribeHub, getVersion);
  return hubState;
}

/* ------------------------------------------------------------------ */
/* Module singletons (survive any React churn)                        */
/* ------------------------------------------------------------------ */

let hubRootEl = null;
let canvasBridgeReady = false;
let canvasBridgeWaiters = [];
const canvasBridgeRequests = new Map();
const canvasSetupPromises = new Map();
const canvasSetupQueue = [];
let canvasSetupActive = 0;
let threadSeq = 0;

const surfaceFrames = new Map(); // name -> iframe element (never unmounted)
const surfaceWanted = new Set();

// Imperative hooks registered by mounted views (fail-open when absent).
const focusHooks = new Map(); // 'prompt' | 'workflowTitle' -> fn
let threadScroller = null;

export function setHubRootEl(el) { hubRootEl = el; }
export function registerHubFocus(key, fn) {
  focusHooks.set(key, fn);
  return () => { if (focusHooks.get(key) === fn) focusHooks.delete(key); };
}
export function registerThreadScroller(fn) {
  threadScroller = fn;
  return () => { if (threadScroller === fn) threadScroller = null; };
}

const OWNER_PASSPHRASE_STORAGE_KEY = 'hivemind.ownerPassphrase.once';

function readOwnerPassphrase() {
  try {
    const raw = sessionStorage.getItem(OWNER_PASSPHRASE_STORAGE_KEY) || '';
    if (!raw) return '';
    try {
      const parsed = JSON.parse(raw);
      const password = typeof parsed?.password === 'string' ? parsed.password : '';
      const expiresAt = Number(parsed?.expiresAt || 0);
      if (expiresAt && expiresAt <= Date.now()) {
        sessionStorage.removeItem(OWNER_PASSPHRASE_STORAGE_KEY);
        return '';
      }
      return password;
    } catch {
      return raw;
    }
  } catch {
    return '';
  }
}

// Read once at import time, exactly like hubApp.js (module loads on first hub
// navigation, after the owner gate wrote the key).
let ownerPassphrase = readOwnerPassphrase();

/* ------------------------------------------------------------------ */
/* Small shared helpers                                               */
/* ------------------------------------------------------------------ */

export const titleCase = (value) => String(value || '').replaceAll('-', ' ').replace(/\b\w/g, (char) => char.toUpperCase());

export const providerLabel = (value) => ({
  'openai-gpt-image': 'OpenAI · GPT Image',
  'openai-gpt-image-oauth': 'OpenAI · GPT Image OAuth',
  'xai-imagine-api': 'xAI · Imagine API',
  'xai-imagine-oauth': 'xAI · Imagine OAuth',
  'hivemindos-hosted-media': 'HivemindOS · Hosted media',
  'media-studio-mcp': 'HivemindOS · Media Studio MCP',
  'upload-post': 'Upload-Post',
}[value] || value);

export async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    headers: { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) },
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    const detail = typeof payload === 'object' ? payload.detail : payload;
    throw new Error(Array.isArray(detail) ? detail.map((item) => item.msg).join(' · ') : detail || `Request failed (${response.status})`);
  }
  return payload;
}

export function routeValue(provider, model, auth = '') {
  return JSON.stringify({ provider, model, ...(auth ? { auth } : {}) });
}

// Was selectedRoute($(select)); parses the stored JSON string.
export function parseRoute(value) {
  if (!value || value === 'automatic') return { provider: 'automatic', model: 'automatic' };
  try { return JSON.parse(value); } catch { return { provider: 'automatic', model: 'automatic' }; }
}

export const STUDIO_MODES = {
  create: {
    label: 'Create',
    heading: 'What do you want to make?',
    copy: 'Create images, video, and complete media from one prompt, one model router, and one durable run.',
    placeholder: 'Create a 20-second product launch ad with a hard pattern interrupt, three cinematic scenes, and a direct CTA…',
    submit: 'Plan creation',
    attachment: 'Images',
  },
  edit: {
    label: 'Edit',
    heading: 'What should change?',
    copy: 'Add one or more ordered references, describe the transformation, and keep every result in the same asset history.',
    placeholder: 'Replace the background with a warm editorial studio while preserving the product, framing, and lighting direction…',
    submit: 'Plan edit',
    attachment: 'References',
  },
  animate: {
    label: 'Animate',
    heading: 'What should move?',
    copy: 'Animate an idea or attached frame with the same video models, run history, provenance, and approvals.',
    placeholder: 'Animate this frame with a slow push-in, subtle fabric movement, natural parallax, and a clean final hold…',
    submit: 'Plan animation',
    attachment: 'Start frame',
  },
  workflow: {
    label: 'Workflow',
    heading: 'Build the complete workflow',
    copy: 'Control scenes, providers, voice, assembly, publishing, budget, and policy in one production form.',
    placeholder: '',
    submit: 'Create production',
    attachment: 'Images',
  },
};

export function setStudioMode(mode) {
  const selected = Object.hasOwn(STUDIO_MODES, mode) ? mode : 'create';
  hubState.studioMode = selected;
  hubState.createMode = selected === 'workflow' ? 'advanced' : 'simple';
  notifyHub();
}

export function setCreateMode(mode) {
  hubState.createMode = mode === 'advanced' ? 'advanced' : 'simple';
  notifyHub();
}

/* ------------------------------------------------------------------ */
/* Route picker taxonomy (hubApp.js:188-426)                          */
/* ------------------------------------------------------------------ */

function modelOptionLabel(model) {
  const vision = model.vision ? ' · vision' : '';
  const suffix = model.recommended ? ' · recommended' : '';
  return `${model.id}${vision}${suffix}`;
}

export const ROUTE_AUTH_SECTIONS = {
  api: { label: 'API key', detail: 'Uses credentials loaded server-side from the shared Hive environment.' },
  oauth: { label: 'OAuth', detail: 'Uses a connected HivemindOS account. Tokens never enter this browser.' },
  local: { label: 'Local & managed', detail: 'Runs locally, on your fleet, through a consumer session, or with HivemindOS credits.' },
};

const DIRECT_API_MEDIA_PROVIDERS = new Set(['openai-gpt-image', 'xai-imagine-api', 'muapi', 'higgsfield-cloud']);

export function mediaAuthSection(providerId) {
  if (providerId.endsWith('-oauth')) return 'oauth';
  if (DIRECT_API_MEDIA_PROVIDERS.has(providerId)) return 'api';
  return 'local';
}

export function routePickerProviders(kind) {
  if (kind === 'brain') {
    return (hubState.simpleCatalog?.brains || []).flatMap((provider) => Object.keys(ROUTE_AUTH_SECTIONS).map((authSection) => ({
      id: provider.slug,
      label: provider.name,
      authSection,
      available: provider.models.some((model) => model.auth === authSection && !model.disabled),
      detail: '',
      models: provider.models.filter((model) => model.auth === authSection).map((model) => ({
        id: model.id,
        label: modelOptionLabel(model),
        value: routeValue(provider.slug, model.id, model.auth),
        disabled: Boolean(model.disabled),
        disabledReason: model.disabledReason || 'Unavailable for planning in this runtime.',
      })),
    })).filter((provider) => provider.models.length));
  }
  return (hubState.simpleCatalog?.media?.[kind] || []).map((provider) => ({
    id: provider.id,
    label: provider.label,
    authSection: mediaAuthSection(provider.id),
    available: Boolean(provider.available),
    detail: provider.detail || '',
    models: provider.models.map((model) => ({
      id: model.id,
      label: model.label,
      value: routeValue(provider.id, model.id),
      disabled: !provider.available,
      disabledReason: provider.detail || 'This provider is not ready.',
    })),
  }));
}

export function selectedRoutePickerItem(kind) {
  const route = parseRoute(hubState.routes[kind]);
  if (route.provider === 'automatic') return null;
  for (const provider of routePickerProviders(kind)) {
    const model = provider.models.find((candidate) => candidate.value === routeValue(route.provider, route.model, route.auth));
    if (model) return { provider, model };
  }
  return null;
}

export function routePickerMatches(provider, model, query) {
  if (!query) return true;
  const haystack = `${provider.label} ${provider.id} ${model.label} ${model.id} ${ROUTE_AUTH_SECTIONS[provider.authSection].label}`.toLowerCase();
  return query.split(/\s+/).every((token) => haystack.includes(token));
}

export function setRouteValue(kind, value) {
  hubState.routes[kind] = value;
  notifyHub();
  if (kind === 'brain') {
    const model = selectedBrainModel();
    if (hubState.simpleAttachments.length && model?.vision === false) toast.error(`${model.id} is text-only — it can't see your attached images.`);
  }
}

export function savedRouteValue(kind, route) {
  if (!route || typeof route !== 'object') return '';
  if (kind !== 'brain' && route.provider === 'automatic') return 'automatic';
  const providers = routePickerProviders(kind);
  const provider = providers.find((item) => item.id === route.provider && (!route.auth || item.authSection === route.auth));
  if (!provider) return '';
  const model = provider.models.find((item) => item.id === route.model && !item.disabled)
    || provider.models.find((item) => item.id === 'automatic' && !item.disabled)
    || provider.models.find((item) => !item.disabled);
  return model?.value || '';
}

export function selectedBrainModel() {
  const route = parseRoute(hubState.routes.brain);
  const provider = (hubState.simpleCatalog?.brains || []).find((item) => item.slug === route.provider);
  return provider?.models.find((model) => model.id === route.model && (!route.auth || model.auth === route.auth)) || null;
}

function preferVisionBrain() {
  // Only auto-switch away from a brain the catalog marks as known text-only
  // (vision === false). Unknown modality (no flag) stays put — the planner
  // degrades to a text-only plan with a warning if the route rejects images.
  if (!hubState.simpleAttachments.length) return;
  const current = selectedBrainModel();
  if (!current || current.vision !== false) return;
  const candidates = (hubState.simpleCatalog?.brains || []).flatMap((provider) => provider.models
    .filter((model) => model.vision && !model.disabled)
    .map((model) => ({ provider, model })));
  const target = candidates.find((item) => item.model.recommended) || candidates[0];
  if (!target) return;
  setRouteValue('brain', routeValue(target.provider.slug, target.model.id, target.model.auth));
  toast(`Brain switched to ${target.model.id} — ${current.id} is text-only and can't see attached images.`);
}

function defaultBrainRoute() {
  const groups = hubState.simpleCatalog?.brains || [];
  if (!groups.length) { hubState.routes.brain = ''; return; }
  const available = groups.flatMap((provider) => provider.models.map((model) => ({ provider, model }))).filter((item) => !item.model.disabled);
  const recommended = available.find((item) => item.model.recommended) || available[0];
  if (recommended) hubState.routes.brain = routeValue(recommended.provider.slug, recommended.model.id, recommended.model.auth);
}

export function selectedMediaModel(kind) {
  const route = parseRoute(hubState.routes[kind]);
  if (route.provider === 'automatic') return null;
  const provider = (hubState.simpleCatalog?.media?.[kind] || []).find((item) => item.id === route.provider);
  return provider?.models.find((model) => model.id === route.model) || null;
}

export function capabilityNote() {
  const models = ['image', 'video'].map(selectedMediaModel).filter(Boolean);
  if (!models.length) {
    return hubState.simpleCatalog?.attachment_note || 'Up to 30 ordered reference images. Automatic lets the brain choose compatible roles and providers.';
  }
  return models.map((model) => {
    const roles = model.reference_roles?.length ? model.reference_roles.join(', ') : 'no image input';
    const limit = model.max_reference_images == null ? `validated from ${model.limit_source}` : `${model.max_reference_images} image${model.max_reference_images === 1 ? '' : 's'} max`;
    return `${model.label}: ${roles} · ${limit}`;
  }).join('  •  ');
}

/* ------------------------------------------------------------------ */
/* Attachments (hubApp.js:428-490)                                    */
/* ------------------------------------------------------------------ */

export const attachmentRole = (index, total) =>
  (total === 1 ? 'Reference' : index === 0 ? 'Start' : index === total - 1 ? 'End' : `Reference ${index}`);

const isImageFile = (file) => (file.type || '').startsWith('image/') || /\.(avif|heic|heif|png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file.name || '');

export function addSimpleImages(files) {
  const all = [...files];
  const accepted = all.filter(isImageFile);
  if (accepted.length < all.length) toast.error(`${all.length - accepted.length} file${all.length - accepted.length === 1 ? ' is' : 's are'} not an image and ${all.length - accepted.length === 1 ? 'was' : 'were'} skipped.`);
  const remaining = 30 - hubState.simpleAttachments.length;
  if (accepted.length > remaining) toast.error(`Only the first ${remaining} image${remaining === 1 ? '' : 's'} were added.`);
  accepted.slice(0, Math.max(0, remaining)).forEach((file) => hubState.simpleAttachments.push({ file, url: URL.createObjectURL(file) }));
  notifyHub();
  preferVisionBrain();
}

export function removeSimpleImage(index) {
  const [removed] = hubState.simpleAttachments.splice(index, 1);
  if (removed?.file) URL.revokeObjectURL(removed.url);
  notifyHub();
}

async function attachmentBrainData(item) {
  // Downscaled JPEG data URL so the brain can actually see the reference,
  // whatever container format the original file uses (AVIF, HEIC, …).
  if (item.brainData !== undefined) return item.brainData;
  try {
    const source = item.file || await fetch(item.url).then((response) => {
      if (!response.ok) throw new Error('Saved reference image is unavailable');
      return response.blob();
    });
    const bitmap = await createImageBitmap(source);
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    item.brainData = canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    item.brainData = null;
  }
  return item.brainData;
}

async function simpleAttachmentsPayload() {
  return Promise.all(hubState.simpleAttachments.map(async (item, index) => {
    const data = index < 12 ? await attachmentBrainData(item) : null;
    return {
      name: item.name || item.file?.name || `reference-${index + 1}`,
      type: item.type || item.file?.type || 'image/*',
      size: item.size ?? item.file?.size ?? 0,
      order: index + 1,
      ...(data ? { data } : {}),
    };
  }));
}

/* ------------------------------------------------------------------ */
/* Thread + planner submit (hubApp.js:492-775)                        */
/* ------------------------------------------------------------------ */

function scrollThreadToLatest() {
  // Immediate + delayed pass, same 120ms cadence as the old hub (async
  // card/image layout growth lands after the first scroll).
  const toBottom = () => { if (threadScroller) threadScroller(); };
  toBottom();
  setTimeout(toBottom, 120);
}

function pushThread(item) {
  threadSeq += 1;
  const entry = { id: threadSeq, ...item };
  hubState.thread.push(entry);
  notifyHub();
  scrollThreadToLatest();
  return entry;
}

function replaceThreadItem(id, item) {
  const index = hubState.thread.findIndex((entry) => entry.id === id);
  if (index >= 0) hubState.thread[index] = { id, ...item };
  notifyHub();
}

export function setComposer(patch) {
  Object.assign(hubState.composer, patch);
  notifyHub();
}

function setSimpleBusy(busy, label = 'Planning') {
  hubState.simpleBusy = busy;
  hubState.simpleBusyLabel = label;
  notifyHub();
}

export function threadRunFor(item) {
  return hubState.runs.find((run) => run.run_id === item.runId) || item.snapshot || null;
}

export async function createSimpleRun(plan) {
  setSimpleBusy(true, 'Creating');
  const loading = pushThread({ kind: 'loading' });
  try {
    const form = new FormData();
    const referenceArtifacts = hubState.simpleAttachments.filter((item) => item.artifactId).map((item) => ({ run_id: item.sourceRunId, artifact_id: item.artifactId }));
    form.append('plan_json', JSON.stringify({ ...plan, reference_artifacts: referenceArtifacts }));
    hubState.simpleAttachments.filter((item) => item.file).forEach((item) => form.append('images', item.file, item.file.name));
    const run = await api('/api/simple/runs', { method: 'POST', body: form });
    replaceThreadItem(loading.id, { kind: 'runCards', runId: run.run_id, snapshot: run });
    await Promise.all([loadRuns(), loadGenerationTelemetry({ quiet: true })]);
    hubState.selectedRunId = run.run_id;
    notifyHub();
    toast('Production created. Agents can continue from the durable run.');
    void loadPrompts({ quiet: true });
  } catch (error) {
    replaceThreadItem(loading.id, { kind: 'runError', message: error.message });
    toast.error(error.message);
  } finally {
    setSimpleBusy(false);
    scrollThreadToLatest();
  }
}

export async function submitSimplePrompt() {
  const prompt = hubState.composer.prompt.trim();
  if (!prompt) { toast.error('Describe what you want to create.'); return; }
  if (hubState.studioMode === 'edit' && !hubState.simpleAttachments.length) { toast.error('Add at least one reference image before planning an edit.'); return; }
  const brain = parseRoute(hubState.routes.brain);
  if (!brain.provider || brain.provider === 'automatic') { toast.error('Connect or select an LLM brain first.'); return; }
  pushThread({ kind: 'user', text: prompt });
  hubState.simpleHistory.push({ role: 'user', content: prompt });
  setSimpleBusy(true);
  try {
    const imageSelection = parseRoute(hubState.routes.image);
    const videoSelection = parseRoute(hubState.routes.video);
    const seed = Number(hubState.composer.seed);
    const payload = await api('/api/simple/plan', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        studioMode: hubState.studioMode,
        ...brain,
        promptHelper: hubState.composer.promptHelper,
        walkthrough: hubState.composer.walkthrough,
        confirmed: false,
        history: hubState.simpleHistory.slice(0, -1),
        attachments: await simpleAttachmentsPayload(),
        imageSelection,
        videoSelection,
        seed: Number.isSafeInteger(seed) ? seed : null,
        seedMode: hubState.composer.seedMode,
      }),
    });
    const plan = payload.plan;
    plan.user_prompt = prompt;
    hubState.simplePlan = plan;
    pushThread({
      kind: 'assistant',
      message: plan.message || (plan.mode === 'confirmation' ? 'Review the production plan before it starts.' : 'The production plan is ready.'),
      questions: Array.isArray(plan.questions) ? plan.questions : null,
      plan: plan.draft ? plan : null,
    });
    hubState.simpleHistory.push({ role: 'assistant', content: plan.message || JSON.stringify(plan.questions || []) });
    hubState.composer.prompt = '';
    notifyHub();
    if (plan.mode === 'brief') await createSimpleRun(plan);
  } catch (error) {
    pushThread({ kind: 'assistant', error: true, message: error.message });
    toast.error(error.message);
  } finally {
    setSimpleBusy(false);
  }
}

/* ------------------------------------------------------------------ */
/* Generation cards (pure derivations, hubApp.js:529-677)             */
/* ------------------------------------------------------------------ */

export function generationArtifactUrl(run, artifact) {
  return `/api/runs/${encodeURIComponent(run.run_id)}/artifacts/${encodeURIComponent(artifact.id)}`;
}

function generationProvider(run, role) {
  return run.brief?.providers?.[role] || run.providers?.[role] || 'agent-routed';
}

function generationModel(run, provider, stage) {
  const options = run.brief?.provider_options?.[provider];
  if (!options || typeof options !== 'object') return 'automatic';
  const nested = options[stage];
  return nested?.model || options[`${stage}_model`] || options.model || 'automatic';
}

function generationAttempt(run, intent) {
  const events = (run.events || []).filter((event) => event.kind?.startsWith('generation.') && event.payload?.intent === intent);
  if (!events.length) return null;
  const latest = events[events.length - 1];
  const telemetryId = latest.payload?.telemetry_id;
  const started = events.find((event) => event.kind === 'generation.started' && event.payload?.telemetry_id === telemetryId);
  return {
    ...latest.payload,
    createdAt: started ? Date.parse(started.created_at) : undefined,
    completedAt: latest.kind === 'generation.started' ? undefined : Date.parse(latest.created_at),
  };
}

function generationStageStatus(run, stepId, artifacts, expected, attempt) {
  const step = (run.steps || []).find((item) => item.step_id === stepId);
  if (artifacts.length >= expected && expected > 0) return 'ready';
  if (attempt?.status === 'running' || step?.status === 'running') return 'running';
  if (attempt?.status === 'failed' || step?.status === 'failed') return 'error';
  return 'waiting';
}

function generationStageDetail(run, stepId, kind, artifacts, expected, status) {
  const remaining = Math.max(0, expected - artifacts.length);
  if (status === 'ready') return `${artifacts.length} ${kind === 'image' ? 'image' : 'video'} artifact${artifacts.length === 1 ? '' : 's'} ready.`;
  if (status === 'running') return `${remaining || expected} scene ${kind === 'image' ? 'keyframe' : 'video'}${(remaining || expected) === 1 ? '' : 's'} generating.`;
  if (status === 'error') return `The ${kind} generation attempt failed. Open the run for retry evidence.`;
  if (stepId === 'motion' && !(run.steps || []).find((item) => item.step_id === 'keyframes')?.status?.includes('completed')) return 'Waiting for scene keyframes before video generation.';
  return `${remaining || expected} scene ${kind === 'image' ? 'keyframe' : 'video'}${(remaining || expected) === 1 ? '' : 's'} ready for generation.`;
}

export function buildRunGenerationCards(run) {
  const records = run.artifact_records || [];
  const expected = Math.max(1, run.brief?.scenes?.length || 1);
  const referenceArtifacts = records.filter((artifact) => String(artifact.role || '').startsWith('reference-'));
  const stages = [];
  if ((run.steps || []).some((step) => step.step_id === 'keyframes')) {
    const artifacts = records.filter((artifact) => artifact.role === 'keyframe');
    const provider = generationProvider(run, 'image');
    const attempt = generationAttempt(run, 'generate_keyframes');
    const status = generationStageStatus(run, 'keyframes', artifacts, expected, attempt);
    stages.push({
      id: `${run.run_id}:image`, kind: 'image', intent: 'generate_keyframes', title: 'Image generation', status,
      prompt: run.brief?.concept || run.brief?.goal || runTitle(run), provider, model: generationModel(run, provider, 'keyframe'),
      detail: generationStageDetail(run, 'keyframes', 'image', artifacts, expected, status), artifacts, sourceArtifacts: referenceArtifacts,
      createdAt: attempt?.createdAt, completedAt: attempt?.completedAt, error: attempt?.error_type || '',
    });
  }
  if ((run.steps || []).some((step) => step.step_id === 'motion')) {
    const sceneVideos = records.filter((artifact) => artifact.role === 'scene-video');
    const finalVideos = records.filter((artifact) => artifact.role === 'final-video');
    const artifacts = sceneVideos.length ? sceneVideos : finalVideos;
    const provider = generationProvider(run, 'motion');
    const attempt = generationAttempt(run, 'animate_scenes');
    const status = generationStageStatus(run, 'motion', artifacts, expected, attempt);
    stages.push({
      id: `${run.run_id}:video`, kind: 'video', intent: 'animate_scenes', title: 'Video generation', status,
      prompt: run.brief?.concept || run.brief?.goal || runTitle(run), provider, model: generationModel(run, provider, 'motion'),
      detail: generationStageDetail(run, 'motion', 'video', artifacts, expected, status), artifacts,
      sourceArtifacts: records.filter((artifact) => artifact.role === 'keyframe'), createdAt: attempt?.createdAt,
      completedAt: attempt?.completedAt, error: attempt?.error_type || '',
    });
  }
  return stages;
}

export function generationStatusLabel(status) {
  return ({ waiting: 'waiting', running: 'generating', ready: 'ready', error: 'error' })[status] || status;
}

export function generationTiming(card) {
  if (!Number.isFinite(card.createdAt)) return '';
  const end = Number.isFinite(card.completedAt) ? card.completedAt : Date.now();
  const label = card.status === 'running' ? 'elapsed' : card.status === 'error' ? 'failed after' : 'generated in';
  return ` · ${label} ${formatTelemetryDuration(end - card.createdAt)}`;
}

// Estimated (elapsed vs historical provider average) progress; null when unknown.
// Clamped 2–96 exactly like the old hub.
export function generationProgressPct(card) {
  if (card.status !== 'running' || !Number.isFinite(card.createdAt)) return null;
  const providerMetrics = (hubState.telemetry?.by_provider || []).find((row) => row.provider === card.provider);
  const estimate = Number(providerMetrics?.average_duration_ms || 0);
  if (!estimate) return null;
  return Math.min(96, Math.max(2, Math.round(((Date.now() - card.createdAt) / estimate) * 100)));
}

/* ------------------------------------------------------------------ */
/* Navigation (hubApp.js:781-800)                                     */
/* ------------------------------------------------------------------ */

export const HUB_VIEWS = ['create', 'canvas', 'models', 'runs', 'history', 'telemetry', 'providers', 'machines'];
// View name → AppShell page id ('create' renders on the 'planner' page).
const hubPageForView = (view) => (view === 'create' ? 'planner' : view);

// Hub-internal navigation goes through the App router so the rail, URL, and
// document title stay in sync. The router mounts/activates the hub view.
export function navigateHub(view) {
  const selected = HUB_VIEWS.includes(view) ? view : 'create';
  window.dispatchEvent(new CustomEvent('navigate', { detail: { page: hubPageForView(selected) } }));
}

// Called by HubLayer whenever the active hub view changes (was setActiveHubView).
export function activateHubView(view) {
  const selected = HUB_VIEWS.includes(view) ? view : 'create';
  hubState.activeView = selected;
  notifyHub();
  if (selected === 'canvas') loadToolSurface(selected);
  if (selected === 'history') void loadPrompts({ quiet: true });
  if (selected === 'telemetry') void loadGenerationTelemetry({ quiet: true });
}

/* ------------------------------------------------------------------ */
/* Tool surfaces + owner access bridge (hubApp.js:802-856)            */
/* ------------------------------------------------------------------ */

export function gatewayUrl(path) {
  if (location.port === '8789') return `${location.origin}${path}`;
  return `${location.protocol}//${location.hostname}:8788${path}`;
}

export function registerToolSurfaceFrame(name, el) {
  surfaceFrames.set(name, el);
  if (surfaceWanted.has(name)) loadToolSurface(name);
}

export function toolSurfaceUrl(name) {
  const frame = surfaceFrames.get(name);
  if (frame?.src) return frame.src;
  const surface = hubState.surfaces?.surfaces?.[name];
  if (!surface) return '';
  return surface.path || gatewayUrl(surface.gateway_path || '/');
}

export function loadToolSurface(name) {
  surfaceWanted.add(name);
  const frame = surfaceFrames.get(name);
  if (!frame || frame.dataset.loaded === 'true') return;
  const surface = hubState.surfaces?.surfaces?.[name];
  if (!surface) return;
  const url = surface.path || gatewayUrl(surface.gateway_path || '/');
  frame.src = url;
  frame.addEventListener('load', () => { void postOwnerAccess(frame, 'hivemind-owner-unlock'); }, { once: true });
  frame.dataset.loaded = 'true';
}

// Reload ONLY the iframe (toolbar reload button). Re-arms the owner unlock
// handshake; a canvas reload also resets the history bridge readiness.
export function reloadToolSurface(name) {
  const frame = surfaceFrames.get(name);
  if (!frame) return;
  if (frame.dataset.loaded !== 'true') { loadToolSurface(name); return; }
  if (name === 'canvas') canvasBridgeReady = false;
  const src = frame.src;
  frame.addEventListener('load', () => { void postOwnerAccess(frame, 'hivemind-owner-unlock'); }, { once: true });
  frame.src = src;
}

function toolSurfaceOrigin(frame) {
  try { return new URL(frame.src, location.href).origin; } catch { return ''; }
}

function ownerAccessFrameForEvent(event) {
  if (event.data?.type !== 'hivemind-owner-unlock-ready') return null;
  for (const [name, frame] of surfaceFrames) {
    if (name === 'canvas' && frame.contentWindow === event.source && event.origin === toolSurfaceOrigin(frame)) return frame;
  }
  return null;
}

async function postOwnerAccess(frame, type) {
  if (!frame?.contentWindow) return;
  let ownerSession = false;
  if (type === 'hivemind-owner-unlock' && !ownerPassphrase) {
    try {
      ownerSession = Boolean((await api('/api/owner/session')).unlocked);
    } catch {
      return;
    }
    if (!ownerSession) return;
  }
  try {
    frame.contentWindow.postMessage({
      type,
      ...(ownerPassphrase ? { passphrase: ownerPassphrase } : {}),
      ...(ownerSession ? { ownerSession: true } : {}),
    }, toolSurfaceOrigin(frame));
  } catch { /* frame gone */ }
}

/* ------------------------------------------------------------------ */
/* History / prompts (hubApp.js:859-934)                              */
/* ------------------------------------------------------------------ */

// The History view re-polls every 10s while it is open. Publishing an identical
// payload would re-render the whole archive — every card, every thumbnail — for
// nothing, which reads as the view spontaneously refreshing itself under the
// user (and lands right about when a short video finishes playing). Compare
// before publishing so an unchanged poll is completely inert.
function historySnapshotSignature(prompts, canvasHistory, total, hasMore, formats, models) {
  return JSON.stringify([
    prompts.map((entry) => [entry.prompt_id, entry.updated_at, entry.favorite, entry.use_count]),
    canvasHistory.map((entry) => [entry.history_id, entry.created_at, entry.models, entry.seeds, entry.encrypted_at_rest]),
    total, hasMore, formats, models,
  ]);
}

// A background poll only ever re-fetches PAGE 1, but the view may have scrolled
// far past it. Publishing page 1 as the whole list drops every later page: those
// cards unmount, their decrypted <img>/<video> state dies (a playing video snaps
// back to the "Load video" button), and the infinite-scroll sentinel — now sitting
// near the shortened list's end — immediately re-appends the very pages that were
// just thrown away. That churn repeated on every 10s tick. Merge instead: page 1
// refreshes the newest window, everything already loaded past it is kept, and
// client-discovered provenance survives a refresh that comes back without it.
function mergeCanvasHistoryPage(existing, page) {
  if (!page.length) return page; // the collection really is empty now
  const byId = new Map(existing.map((entry) => [entry.history_id, entry]));
  const head = page.map((fresh) => {
    const known = byId.get(fresh.history_id);
    if (!known) return fresh;
    return {
      ...fresh,
      models: fresh.models?.length ? fresh.models : known.models,
      seeds: fresh.seeds?.length ? fresh.seeds : known.seeds,
    };
  });
  const headIds = new Set(head.map((entry) => entry.history_id));
  // History is newest-first, so everything genuinely past page 1 is older than
  // that page's last row. Cutting on recency rather than on index keeps the later
  // pages when a new generation shifts the page boundary, while still dropping a
  // row the server deleted from inside the page-1 window. Rows without a
  // timestamp are kept — losing one is worse than showing it a poll too long.
  const oldest = page[page.length - 1].created_at;
  return head.concat(existing.filter((entry) => (
    !headIds.has(entry.history_id) && (!oldest || !entry.created_at || entry.created_at <= oldest)
  )));
}

export async function loadPrompts({ quiet = false } = {}) {
  // A quiet poll refreshes the first page in place. An explicit load (first open,
  // filter change) restarts pagination from scratch.
  const refresh = quiet && hubState.canvasHistory.length > 0;
  let changed = true;
  try {
    if (!refresh) {
      hubState.canvasPage = 0;
      hubState.canvasHasMore = true;
      // Only an explicit load owns the spinner: flipping it during a poll flashes
      // "Loading more outputs…" and makes a concurrent scroll-to-load a no-op.
      hubState.canvasLoading = true;
    }
    const query = new URLSearchParams({
      page: '1',
      page_size: String(hubState.canvasPageSize),
      ...(hubState.canvasFormat ? { format: hubState.canvasFormat } : {}),
      ...(hubState.canvasModel ? { model: hubState.canvasModel } : {}),
    });
    const [promptPayload, canvasPayload] = await Promise.all([
      api('/api/simple/prompts'),
      api(`/api/canvas/history?${query.toString()}`),
    ]);
    const prompts = await Promise.all((promptPayload.prompts || []).map(decryptPromptEntry));
    const firstPage = canvasPayload.history || [];
    const canvasHistory = refresh ? mergeCanvasHistoryPage(hubState.canvasHistory, firstPage) : firstPage;
    const total = Number(canvasPayload.pagination?.total || canvasHistory.length);
    // A refresh never looked past page 1, so it must not rewind the cursor the
    // infinite scroller already advanced.
    const page = refresh ? hubState.canvasPage : (canvasPayload.pagination?.page || 1);
    const hasMore = refresh ? hubState.canvasHasMore : Boolean(canvasPayload.pagination?.has_more);
    const pageFormats = canvasPayload.filters?.formats || [];
    const pageModels = canvasPayload.filters?.models || [];
    // Filter options are per-page (loadMoreCanvasHistory unions them), so a refresh
    // must union too or the format/model dropdowns shrink under the user.
    const formats = refresh ? [...new Set([...hubState.canvasFormats, ...pageFormats])].sort() : pageFormats;
    const models = refresh
      ? [...new Set([...hubState.canvasModels, ...pageModels])].sort((left, right) => left.localeCompare(right))
      : pageModels;
    changed = historySnapshotSignature(hubState.prompts, hubState.canvasHistory, hubState.canvasTotal, hubState.canvasHasMore, hubState.canvasFormats, hubState.canvasModels)
      !== historySnapshotSignature(prompts, canvasHistory, total, hasMore, formats, models);
    if (changed) {
      hubState.prompts = prompts;
      hubState.canvasHistory = canvasHistory;
      hubState.canvasTotal = total;
      hubState.canvasFormats = formats;
      hubState.canvasModels = models;
    }
    hubState.canvasPage = page;
    hubState.canvasHasMore = hasMore;
  } catch (error) {
    if (!quiet) toast.error(error.message);
  } finally {
    if (!refresh) hubState.canvasLoading = false;
  }
  if (changed) notifyHub();
}

export async function loadMoreCanvasHistory() {
  if (hubState.canvasLoading || !hubState.canvasHasMore) return;
  hubState.canvasLoading = true;
  const query = new URLSearchParams({
    page: String(hubState.canvasPage + 1),
    page_size: String(hubState.canvasPageSize),
    ...(hubState.canvasFormat ? { format: hubState.canvasFormat } : {}),
    ...(hubState.canvasModel ? { model: hubState.canvasModel } : {}),
  });
  try {
    const payload = await api(`/api/canvas/history?${query.toString()}`);
    const known = new Set(hubState.canvasHistory.map((entry) => entry.history_id));
    hubState.canvasHistory.push(...(payload.history || []).filter((entry) => !known.has(entry.history_id)));
    hubState.canvasPage = payload.pagination?.page || hubState.canvasPage + 1;
    hubState.canvasHasMore = Boolean(payload.pagination?.has_more);
    hubState.canvasTotal = Number(payload.pagination?.total || hubState.canvasTotal);
    hubState.canvasFormats = [...new Set([...hubState.canvasFormats, ...(payload.filters?.formats || [])])].sort();
    hubState.canvasModels = [...new Set([...hubState.canvasModels, ...(payload.filters?.models || [])])].sort((left, right) => left.localeCompare(right));
  } catch (error) {
    toast.error(error.message);
  } finally {
    hubState.canvasLoading = false;
  }
  notifyHub();
}

export function setHistoryFilter(filter) {
  hubState.historyFilter = filter;
  notifyHub();
}

export function setCanvasFilters({ format, model }) {
  if (format !== undefined) hubState.canvasFormat = format;
  if (model !== undefined) hubState.canvasModel = model;
  notifyHub();
  void loadPrompts();
}

/* ------------------------------------------------------------------ */
/* Telemetry (hubApp.js:936-981)                                      */
/* ------------------------------------------------------------------ */

export function formatTelemetryDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export async function loadGenerationTelemetry({ quiet = false } = {}) {
  try {
    const telemetry = await api('/api/telemetry/generations');
    const changed = JSON.stringify(hubState.telemetry) !== JSON.stringify(telemetry);
    hubState.telemetry = telemetry;
    if (changed) notifyHub();
    return changed;
  } catch (error) {
    if (!quiet) toast.error(error.message);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Canvas history bridge (hubApp.js:1130-1249)                        */
/* ------------------------------------------------------------------ */

function canvasFrameOrigin() {
  const frame = surfaceFrames.get('canvas');
  if (!frame?.src) return '';
  try { return new URL(frame.src, location.href).origin; } catch { return ''; }
}

function drainCanvasSetupQueue() {
  while (canvasSetupActive < 2 && canvasSetupQueue.length) {
    const job = canvasSetupQueue.shift();
    canvasSetupActive += 1;
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
      canvasSetupActive -= 1;
      drainCanvasSetupQueue();
    });
  }
}

function scheduleCanvasSetup(task) {
  return new Promise((resolve, reject) => {
    canvasSetupQueue.push({ task, resolve, reject });
    drainCanvasSetupQueue();
  });
}

function waitForCanvasBridge() {
  loadToolSurface('canvas');
  if (canvasBridgeReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      canvasBridgeWaiters = canvasBridgeWaiters.filter((waiter) => waiter.resolve !== resolve);
      reject(new Error('Canvas is still starting. Try the action again in a moment.'));
    }, 15000);
    canvasBridgeWaiters.push({ resolve, reject, timeout });
  });
}

async function canvasWorkflowPayload(entry) {
  if (!hubState.canvasWorkflowPayloads[entry.history_id]) {
    hubState.canvasWorkflowPayloads[entry.history_id] = await api(`/api/canvas/history/${encodeURIComponent(entry.history_id)}/workflow`);
  }
  return hubState.canvasWorkflowPayloads[entry.history_id];
}

async function requestCanvasBridge(entry, action = 'inspect') {
  const payload = await canvasWorkflowPayload(entry);
  // Studio outputs carry a vault-sealed setup (prompt/seed/model + the resolved
  // API graph), not a ComfyUI-mobile envelope. Decrypt it in the hub.
  let bridgeMessage;
  if (isVaultSealedSetup(payload?.workflow)) {
    const setup = await decryptVaultSealedSetup(payload.workflow);
    // "Load in Studio" (inspect) is fully served here — no canvas iframe needed.
    if (action !== 'load-canvas') return setup;
    // "Load in Canvas": hand the decrypted API graph to the canvas iframe, which
    // rebuilds the exact node graph (apiGraphToWorkflow) and opens it.
    if (!setup.apiGraph) {
      throw new Error('This studio output has no recorded node graph — use "Load in Studio" to recover its prompt, seed, and model.');
    }
    bridgeMessage = { apiWorkflow: setup.apiGraph };
  } else {
    bridgeMessage = { workflow: payload.workflow };
  }
  await waitForCanvasBridge();
  const requestId = globalThis.crypto?.randomUUID?.() || `history-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const frame = surfaceFrames.get('canvas');
  const targetOrigin = canvasFrameOrigin();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      canvasBridgeRequests.delete(requestId);
      reject(new Error('Canvas did not finish reading this workflow.'));
    }, 30000);
    canvasBridgeRequests.set(requestId, { resolve, reject, timeout });
    frame.contentWindow.postMessage({
      type: 'hivemind-owner-history-request',
      requestId,
      action,
      historyId: entry.history_id,
      ...bridgeMessage,
      mediaUrl: entry.media_url,
      mediaType: entry.media_type,
    }, targetOrigin);
  });
}

export async function inspectCanvasHistoryEntry(historyId) {
  const entry = hubState.canvasHistory.find((item) => item.history_id === historyId);
  if (!entry || hubState.canvasSetups[historyId]?.unavailable) return null;
  if (hubState.canvasSetups[historyId]?.primaryPrompt !== undefined) return hubState.canvasSetups[historyId];
  if (canvasSetupPromises.has(historyId)) return canvasSetupPromises.get(historyId);
  const pending = scheduleCanvasSetup(() => requestCanvasBridge(entry, 'inspect'))
    .then(async (setup) => {
      hubState.canvasSetups[historyId] = setup;
      entry.models = setup.models || [];
      entry.seeds = setup.seeds || [];
      hubState.canvasModels = [...new Set([...hubState.canvasModels, ...entry.models])].sort((left, right) => left.localeCompare(right));
      notifyHub();
      await api(`/api/canvas/history/${encodeURIComponent(historyId)}/provenance`, {
        method: 'POST',
        body: JSON.stringify({ models: entry.models, seeds: entry.seeds }),
      }).catch(() => {});
      return setup;
    })
    .catch((error) => {
      const unavailable = /exact canvas workflow is unavailable|no loadable exact workflow/i.test(error.message);
      hubState.canvasSetups[historyId] = { unavailable, error: error.message };
      notifyHub();
      return null;
    })
    .finally(() => canvasSetupPromises.delete(historyId));
  canvasSetupPromises.set(historyId, pending);
  return pending;
}

// Model line under a canvas history card (was imperative textContent updates).
export function canvasEntryModelLabel(entry) {
  const setup = hubState.canvasSetups[entry.history_id];
  if (entry.models?.length) return entry.models.join(', ');
  if (setup?.unavailable) return 'Exact setup unavailable';
  if (setup?.error) return 'Setup not loaded · use an action to retry';
  if (setup?.primaryPrompt !== undefined) return 'Exact workflow available';
  return 'Reading exact setup…';
}

function selectMatchingCanvasModel(entry, setup) {
  const kind = entry.media_type?.startsWith('video/') ? 'video' : 'image';
  const wanted = new Set((setup.models || []).flatMap((value) => [String(value).toLowerCase(), String(value).split(/[\\/]/).pop().toLowerCase()]));
  for (const provider of hubState.simpleCatalog?.media?.[kind] || []) {
    const model = provider.models.find((candidate) => wanted.has(String(candidate.id).toLowerCase()) || wanted.has(String(candidate.id).split(/[\\/]/).pop().toLowerCase()));
    if (!model) continue;
    setRouteValue(kind, routeValue(provider.id, model.id));
    return;
  }
}

// Last path segment of a media URL/path, query- and hash-stripped — used to match a
// dropped output file back to its canvas-history entry (drag-to-restore, tier 3).
function outputBasename(url) {
  if (!url) return '';
  try {
    const noQuery = String(url).split('#')[0].split('?')[0];
    return decodeURIComponent(noQuery.split('/').filter(Boolean).pop() || '');
  } catch {
    return '';
  }
}

// Ensure the owner's canvas history is loaded (it populates on hub load; a drop may
// happen before the user ever opened the hub). Best-effort, quiet.
//
// Canvas outputs ONLY. This used to prime via loadPrompts(), which additionally
// fetched and decrypted the entire prompt library — an RSA-OAEP unwrap per entry —
// on the critical path of a drag-to-restore that never reads a prompt. That was the
// bulk of the wait before "No saved settings found for this file" appeared.
export async function ensureCanvasHistoryLoaded() {
  if (hubState.canvasHistory.length) return;
  try {
    const query = new URLSearchParams({ page: '1', page_size: String(hubState.canvasPageSize) });
    const payload = await api(`/api/canvas/history?${query.toString()}`);
    const history = payload.history || [];
    if (!history.length) return;
    // Leave the pagination cursor consistent so opening History later refreshes
    // from a valid page 1 rather than re-appending what is already here.
    hubState.canvasHistory = history;
    hubState.canvasTotal = Number(payload.pagination?.total || history.length);
    hubState.canvasPage = payload.pagination?.page || 1;
    hubState.canvasHasMore = Boolean(payload.pagination?.has_more);
    hubState.canvasFormats = [...new Set([...hubState.canvasFormats, ...(payload.filters?.formats || [])])].sort();
    hubState.canvasModels = [...new Set([...hubState.canvasModels, ...(payload.filters?.models || [])])]
      .sort((left, right) => left.localeCompare(right));
    notifyHub();
  } catch { /* best-effort — the drop falls through to its own message */ }
}

// Reverse-lookup: find the canvas-history entry whose output matches a dropped URL or
// filename, so drag-to-restore can recover older local-ComfyUI outputs that predate
// the per-output setup store, reusing loadCanvasOutputInStudio's decrypt+restore path.
export function findCanvasHistoryIdForOutput(url, basename) {
  const targetName = basename || (url ? outputBasename(url) : '');
  const entry = hubState.canvasHistory.find((item) => {
    const mediaUrl = item.media_url || '';
    if (url && mediaUrl === url) return true;
    return targetName ? outputBasename(mediaUrl) === targetName : false;
  });
  return entry ? entry.history_id : null;
}

// Outputs the studios made themselves (Media Studio video, local ComfyUI image,
// cloud MUAPI) have no ComfyUI Canvas graph to recover, so asking the Canvas
// bridge for one only ever answered "Exact Canvas workflow is unavailable for
// this output". Their real settings were sealed to the owner vault at generation
// time — the same record drag-to-restore reads. Try that first; the Canvas bridge
// stays the fallback for genuine Canvas outputs and anything predating the store.
// A History row's media_url is `/api/canvas/history/<id>/media` — keyed by history
// id, and unrelated to the URL a studio sealed its settings under. The OUTPUT
// FILENAME is the one identifier both sides share (the studios seal under
// basenameOf(their url), which is that same file), so it is what makes this lookup
// able to hit at all. Falling back to the media_url basename only helps rows that
// predate output_basename.
function sealedLookupKeys(entry) {
  return {
    url: entry.media_url,
    basename: entry.output_basename || basenameOf(entry.media_url),
  };
}

async function restoreSealedGenerationSetup(entry) {
  let result = null;
  try {
    result = await resolveGenerationSetup(sealedLookupKeys(entry));
  } catch { return false; }
  if (!result?.context) return false;
  const section = result.section || (entry.media_type?.startsWith('video/') ? 'video' : 'image');
  loadStudioSetup(section, { format: 'studio-full-context', section, context: result.context });
  window.dispatchEvent(new CustomEvent('navigate', { detail: { page: section } }));
  toast.success(`Settings restored into the ${section === 'video' ? 'Video' : 'Image'} studio.`);
  return true;
}

export async function loadCanvasOutputInStudio(historyId) {
  const entry = hubState.canvasHistory.find((item) => item.history_id === historyId);
  if (!entry) return;
  if (await restoreSealedGenerationSetup(entry)) return;
  try {
    const setup = await inspectCanvasHistoryEntry(historyId);
    if (!setup) {
      // "Exact Canvas workflow is unavailable" is the Canvas bridge's answer, and
      // it is a confusing thing to show for a Media Studio or cloud output, which
      // never had a Canvas workflow to begin with. Those outputs are restorable
      // only from their sealed settings — and if the seal is gone, say so.
      const bridgeError = hubState.canvasSetups[historyId]?.error || '';
      if (/exact canvas workflow is unavailable|no loadable exact workflow/i.test(bridgeError)) {
        throw new Error('No saved settings for this output — it was made outside Canvas, and its recorded setup is no longer available.');
      }
      throw new Error(bridgeError || 'Exact setup unavailable');
    }
    hubState.loadedCanvasSetup = { historyId, entry, setup };
    // Route to the matching STUDIO (Image/Video), not the Planner. Persist the
    // prompt as the studio's draft (read on first mount) AND live-set it into
    // the studio if it is already mounted-hidden.
    const isVideo = entry.media_type?.startsWith('video/');
    const section = isVideo ? 'video' : 'image';
    updateComposerSection(section, { prompt: setup.primaryPrompt || '' });
    // Hand the FULL setup to the studio (restores model, seed, steps, cfg, dims,
    // negative, prompt); queues + drains when the studio activates below.
    loadStudioSetup(section, setup);
    // Route to the studio PAGE directly — navigateHub only handles hub views and
    // would fall back to the Planner ('create') for a studio page.
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page: section } }));
    toast(isVideo ? 'Loaded the exact settings into the Video studio.' : 'Loaded the exact settings into the Image studio.');
  } catch (error) {
    toast.error(error.message);
  }
}

export async function loadCanvasOutputInCanvas(historyId) {
  const entry = hubState.canvasHistory.find((item) => item.history_id === historyId);
  if (!entry) return;
  navigateHub('canvas');
  try {
    const setup = await requestCanvasBridge(entry, 'load-canvas');
    hubState.canvasSetups[historyId] = setup;
    notifyHub();
    toast('Loaded the exact encrypted workflow and generated output in Canvas.');
  } catch (error) {
    toast.error(error.message);
  }
}

export async function copyText(value) {
  await navigator.clipboard.writeText(value);
  toast('Copied prompt.');
}

export async function copyCanvasPrompt(historyId) {
  try {
    // Same gap as loadCanvasOutputInStudio: studio-made outputs have no Canvas
    // graph, but their prompt is in the vault-sealed capture.
    const entry = hubState.canvasHistory.find((item) => item.history_id === historyId);
    if (entry) {
      const sealed = await resolveGenerationSetup(sealedLookupKeys(entry))
        .catch(() => null);
      if (sealed?.context?.prompt) {
        await copyText(sealed.context.prompt);
        return;
      }
    }
    const setup = await inspectCanvasHistoryEntry(historyId);
    if (!setup?.primaryPrompt) throw new Error('This output has no recoverable prompt.');
    await copyText(setup.primaryPrompt);
  } catch (error) {
    toast.error(error.message);
  }
}

// Called AFTER the user confirms in the ConfirmModal (same gating semantics as
// the old #history-delete-dialog). Returns false on failure so the modal stays open.
export async function deleteCanvasOutput(historyId) {
  try {
    await api(`/api/canvas/history/${encodeURIComponent(historyId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: true }),
    });
    hubState.canvasHistory = hubState.canvasHistory.filter((entry) => entry.history_id !== historyId);
    hubState.canvasTotal = Math.max(0, hubState.canvasTotal - 1);
    delete hubState.canvasSetups[historyId];
    delete hubState.canvasWorkflowPayloads[historyId];
    if (hubState.loadedCanvasSetup?.historyId === historyId) hubState.loadedCanvasSetup = null;
    notifyHub();
    toast('Output and its local traces were permanently deleted.');
    return true;
  } catch (error) {
    toast.error(error.message);
    return false;
  }
}

export function clearLoadedCanvasSetup() {
  hubState.loadedCanvasSetup = null;
  notifyHub();
}

/* ------------------------------------------------------------------ */
/* Prompt library (hubApp.js:1380-1510)                               */
/* ------------------------------------------------------------------ */

export const TEMPLATE_CATEGORY_LABELS = { ugc: 'UGC realism', formats: 'Winning formats', animation: 'Animation' };

export function insertPromptIntoComposer(text) {
  const existing = hubState.composer.prompt;
  hubState.composer.prompt = existing.trim() ? `${existing.replace(/\s+$/, '')}\n${text}` : text;
  notifyHub();
  navigateHub('create');
  focusHooks.get('prompt')?.();
}

export async function setPromptFavorite(promptId, favorite) {
  try {
    const payload = await api(`/api/simple/prompts/${encodeURIComponent(promptId)}/favorite`, { method: 'POST', body: JSON.stringify({ favorite }) });
    const index = hubState.prompts.findIndex((entry) => entry.prompt_id === promptId);
    if (index >= 0) hubState.prompts[index] = await decryptPromptEntry(payload.prompt);
    notifyHub();
  } catch (error) { toast.error(error.message); }
}

export async function deletePrompt(promptId) {
  try {
    await api(`/api/simple/prompts/${encodeURIComponent(promptId)}`, { method: 'DELETE' });
    hubState.prompts = hubState.prompts.filter((entry) => entry.prompt_id !== promptId);
    notifyHub();
  } catch (error) { toast.error(error.message); }
}

/* ------------------------------------------------------------------ */
/* Composer restore from runs (hubApp.js:1417-1491)                   */
/* ------------------------------------------------------------------ */

function promptEntryForRun(runId) {
  return hubState.prompts.find((entry) => entry.run_id === runId) || null;
}

function mediaRouteFromRun(run, kind) {
  const role = kind === 'image' ? 'image' : 'motion';
  const provider = run.brief?.providers?.[role] || run.providers?.[role] || '';
  if (!provider) return null;
  const options = run.brief?.provider_options?.[provider];
  const nested = options?.[role];
  return { provider, model: nested?.model || options?.[`${role}_model`] || options?.model || 'automatic' };
}

function restoreRunAttachments(run) {
  hubState.simpleAttachments.filter((item) => item.file).forEach((item) => URL.revokeObjectURL(item.url));
  const references = (run.artifact_records || []).filter((item) =>
    String(item.role || '').startsWith('reference-') && String(item.mime_type || '').startsWith('image/')
  ).sort((left, right) => Number(left.scene || 0) - Number(right.scene || 0));
  hubState.simpleAttachments = references.map((artifact, index) => ({
    file: null,
    name: `${artifact.role || 'reference-image'}-${index + 1}`,
    type: artifact.mime_type,
    size: artifact.size_bytes || 0,
    url: `/api/runs/${encodeURIComponent(run.run_id)}/artifacts/${encodeURIComponent(artifact.id)}`,
    sourceRunId: run.run_id,
    artifactId: artifact.id,
  }));
  notifyHub();
  preferVisionBrain();
}

export function loadRunIntoSimpleComposer(runId, { notify = true, focus = true, navigateToCreate = true } = {}) {
  const run = hubState.runs.find((item) => item.run_id === runId);
  if (!run) return false;
  const entry = promptEntryForRun(runId);
  const runComposer = run.composer && Object.keys(run.composer).length ? run.composer : null;
  const composer = runComposer || entry?.composer || {};
  const prompt = run.user_prompt || entry?.user_prompt || entry?.prompt || run.brief?.concept || run.brief?.title || '';
  hubState.composer.prompt = prompt;

  const routes = {
    brain: composer.brain,
    image: composer.imageSelection || mediaRouteFromRun(run, 'image'),
    video: composer.videoSelection || mediaRouteFromRun(run, 'video'),
  };
  Object.entries(routes).forEach(([kind, route]) => {
    const value = savedRouteValue(kind, route);
    if (value) setRouteValue(kind, value);
  });
  if (typeof composer.promptHelper === 'boolean') hubState.composer.promptHelper = composer.promptHelper;
  if (typeof composer.walkthrough === 'boolean') hubState.composer.walkthrough = composer.walkthrough;
  if (typeof composer.seed === 'number') hubState.composer.seed = String(composer.seed);
  if (['fixed', 'randomize', 'increment', 'decrement'].includes(composer.seedMode)) hubState.composer.seedMode = composer.seedMode;
  restoreRunAttachments(run);
  hubState.simpleHistory = [];
  hubState.simplePlan = null;
  hubState.createMode = 'simple';
  setStudioMode(composer.studioMode || 'create');
  if (navigateToCreate) navigateHub('create');
  if (focus) focusHooks.get('prompt')?.({ caretToEnd: true });
  if (notify) toast('Loaded this run’s prompt, saved settings, and reference images into the composer.');
  return true;
}

function restoreLatestRunInComposer() {
  const latest = [...hubState.runs].sort((left, right) => new Date(right.created_at) - new Date(left.created_at))[0];
  if (!latest) return;
  loadRunIntoSimpleComposer(latest.run_id, { notify: false, focus: false, navigateToCreate: false });
  if (!hubState.thread.length && buildRunGenerationCards(latest).length) {
    pushThread({ kind: 'runCards', runId: latest.run_id, snapshot: latest });
  }
}

/* ------------------------------------------------------------------ */
/* Advanced workflow form (hubApp.js:1512-1676)                       */
/* ------------------------------------------------------------------ */

export function lane() {
  return hubState.catalog?.lanes.find((item) => item.id === hubState.selectedLane);
}

export function setWorkflow(patch) {
  Object.assign(hubState.workflow, patch);
  notifyHub();
}

export function setProviderRole(role, value) {
  if (value) hubState.workflow.providerRoles[role] = value;
  else delete hubState.workflow.providerRoles[role];
  notifyHub();
}

export function togglePlatform(value) {
  const set = new Set(hubState.workflow.platforms);
  if (set.has(value)) set.delete(value); else set.add(value);
  hubState.workflow.platforms = [...set];
  notifyHub();
}

export function setSelectedLane(laneId, { resetDefaults = true } = {}) {
  hubState.selectedLane = laneId;
  const selected = lane();
  if (!selected) { notifyHub(); return; }
  if (resetDefaults) {
    hubState.workflow.aspectRatio = selected.default_aspect_ratio;
    hubState.workflow.runtimeSeconds = String(selected.default_runtime_seconds);
  }
  // The old renderProviderSelectors rebuilt the selects on lane change, which
  // reset every role to Automatic — preserved here.
  hubState.workflow.providerRoles = {};
  notifyHub();
}

export function providerRolesForLane() {
  const rolesByLane = {
    'first-frame-animation-ad': ['script', 'image', 'motion', 'voice', 'assembly', 'publish'],
    'stickman-performance-ad': ['script', 'image', 'voice', 'assembly', 'publish'],
    'static-text-ad': ['script', 'image', 'publish'],
    animation: ['script', 'image', 'motion', 'voice', 'music', 'assembly', 'publish'],
    faceless: ['script', 'stock', 'voice', 'assembly', 'publish'],
    clip: ['clip', 'publish'],
    'social-post': ['publish'],
  };
  return rolesByLane[hubState.selectedLane] || [];
}

export function addScene() {
  hubState.scenes.push({ title: `Scene ${hubState.scenes.length + 1}`, beat: '', overlay: '', voice: '', duration_seconds: 4, image_prompt: '', motion_prompt: '' });
  notifyHub();
}

export function removeScene(index) {
  if (hubState.scenes.length === 1) return;
  hubState.scenes.splice(index, 1);
  notifyHub();
}

export function updateScene(index, field, value) {
  if (!hubState.scenes[index]) return;
  hubState.scenes[index][field] = field === 'duration_seconds' ? Number(value) : value;
  notifyHub();
}

export function draftPayload() {
  const selected = lane();
  const w = hubState.workflow;
  return {
    lane: hubState.selectedLane,
    title: w.title.trim(),
    concept: w.concept.trim(),
    audience: w.audience.trim(),
    goal: w.goal.trim(),
    tone: w.tone.trim(),
    source: w.source.trim(),
    creator: w.creator.trim(),
    aspect_ratio: w.aspectRatio,
    runtime_seconds: Number(w.runtimeSeconds || selected.default_runtime_seconds),
    privacy: w.privacy,
    max_cost_usd: Number(w.maxCost || 0),
    scenes: selected.supports.scenes ? hubState.scenes : [],
    voice: {
      enabled: w.voiceEnabled,
      provider: w.providerRoles.voice || 'universal-tts',
      delivery: w.voiceDelivery.trim(),
      voice_id: w.voiceId.trim(),
    },
    subtitles: { enabled: w.subtitlesEnabled, position: w.subtitlePosition, font_size: Number(w.subtitleSize) },
    providers: { ...w.providerRoles },
    publish: {
      platforms: [...w.platforms],
      caption: w.publishCaption.trim(),
      cta: w.publishCta.trim(),
    },
    faceless: {
      media_source: w.mediaSource,
      count: Number(w.videoCount),
      clip_duration_seconds: Number(w.clipDuration),
    },
  };
}

export async function createWorkflowRun() {
  try {
    const run = await api('/api/runs', { method: 'POST', body: JSON.stringify(draftPayload()) });
    await loadRuns();
    hubState.selectedRunId = run.run_id;
    notifyHub();
    toast('Production created. The first bounded action is ready.');
    navigateHub('runs');
    return run;
  } catch (error) {
    toast.error(error.message);
    return null;
  }
}

export function duplicateRun(runId) {
  const run = hubState.runs.find((item) => item.run_id === runId);
  if (!run) return;
  const brief = run.brief || {};
  const w = hubState.workflow;
  w.title = `${brief.title || runTitle(run)} — variant`;
  w.concept = brief.concept || '';
  w.audience = brief.audience || '';
  w.goal = brief.goal || '';
  w.tone = brief.tone || '';
  w.source = brief.source || '';
  hubState.scenes = (brief.scenes || []).map((scene) => ({ title: scene.title || '', beat: scene.beat || '', overlay: scene.overlay || '', voice: scene.voice || '', duration_seconds: scene.duration_seconds || 4, image_prompt: scene.image_prompt || '', motion_prompt: scene.motion_prompt || '' }));
  if (!hubState.scenes.length) hubState.scenes = [{ title: 'Opening', beat: brief.concept || brief.title || '', overlay: '', voice: '', duration_seconds: 4, image_prompt: '', motion_prompt: '' }];
  setSelectedLane(run.lane, { resetDefaults: false });
  w.aspectRatio = brief.aspect_ratio || lane().default_aspect_ratio;
  w.runtimeSeconds = String(brief.runtime_seconds || lane().default_runtime_seconds);
  w.privacy = run.policy?.privacy || 'local-first';
  w.maxCost = String(run.cost?.max_cost_usd || 0);
  w.voiceEnabled = brief.voice?.enabled !== false;
  w.voiceDelivery = brief.voice?.delivery || '';
  w.voiceId = brief.voice?.voice_id || '';
  w.subtitlesEnabled = brief.subtitles?.enabled !== false;
  w.subtitlePosition = brief.subtitles?.position || 'bottom';
  w.subtitleSize = String(brief.subtitles?.font_size || 56);
  w.mediaSource = brief.media_source || 'pexels';
  w.videoCount = String(brief.count || 1);
  w.clipDuration = String(brief.clip_duration_seconds || 5);
  const publish = run.publish || brief.publish || {};
  w.publishCaption = publish.caption || '';
  w.publishCta = publish.cta || '';
  w.platforms = [...(publish.platforms || [])];
  w.providerRoles = { ...(run.providers || brief.providers || {}) };
  setStudioMode('workflow');
  navigateHub('create');
  focusHooks.get('workflowTitle')?.();
  toast('Loaded as a new editable variant. The original run stays immutable.');
}

/* ------------------------------------------------------------------ */
/* Runs (hubApp.js:1678-1791)                                         */
/* ------------------------------------------------------------------ */

export async function loadRuns() {
  const payload = await api('/api/runs');
  // Same reasoning as loadPrompts: this is on the 10s poll, so republishing an
  // identical payload re-renders every hub view for nothing. Returns whether it
  // actually changed so refreshAll can stay silent on an idle tick.
  const changed = JSON.stringify(hubState.runs) !== JSON.stringify(payload.runs);
  hubState.runs = payload.runs;
  // Legacy AppShell topbar id — write only if present (retired in the new shell).
  const count = document.getElementById('hub-run-count');
  if (count) count.textContent = hubState.runs.length;
  if (changed) notifyHub();
  return changed;
}

export function runTitle(run) {
  return run.brief?.title || run.brief?.subject || run.run_id;
}

export function filteredRuns() {
  if (!hubState.statusFilter) return hubState.runs;
  if (hubState.statusFilter === 'completed') return hubState.runs.filter((run) => run.status === 'completed');
  return hubState.runs.filter((run) => !['completed', 'cancelled', 'failed'].includes(run.status));
}

export function setStatusFilter(filter) {
  hubState.statusFilter = filter;
  notifyHub();
}

export function setSelectedRunId(runId) {
  hubState.selectedRunId = runId;
  notifyHub();
}

// Operator token is read LIVE at action time (controlled input keeps it current).
function authHeaders() {
  const token = hubState.workflow.operatorToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function runAction(action, runId, stepId) {
  try {
    const path = action === 'retry' ? `/api/runs/${encodeURIComponent(runId)}/retry` : `/api/runs/${encodeURIComponent(runId)}/${action}`;
    const body = action === 'retry' ? { step_id: stepId } : action === 'cancel' ? { reason: 'Cancelled from Content Studio' } : undefined;
    const run = await api(path, { method: 'POST', headers: authHeaders(), ...(body ? { body: JSON.stringify(body) } : {}) });
    await loadRuns();
    hubState.selectedRunId = run.run_id;
    notifyHub();
    toast(`${titleCase(action)} completed.`);
  } catch (error) { toast.error(error.message); }
}

/* ------------------------------------------------------------------ */
/* OAuth / providers (hubApp.js:1807-1856)                            */
/* ------------------------------------------------------------------ */

export async function loadOAuth() {
  hubState.oauth = await api('/api/oauth');
  notifyHub();
}

export async function startOAuth(provider) {
  try {
    const result = await api(`/api/oauth/${provider}/start`, { method: 'POST' });
    window.open(result.authorize_url, '_blank', 'noopener,noreferrer');
    toast(`Finish ${providerLabel(provider)} sign in in the new tab, then refresh provider status.`);
  } catch (error) {
    toast.error(error.message);
  }
}

/* ------------------------------------------------------------------ */
/* Status + refresh (hubApp.js:2036-2063)                             */
/* ------------------------------------------------------------------ */

function setApiOnline(online) {
  // React topbar subscribes to the status store; the old #hub-api-status DOM
  // contract is retired but the copy is preserved.
  setApiStatusStore(online ? 'online' : 'offline', online ? 'Local API ready' : 'API unavailable');
  // Legacy id support if an old shell is hosting this bundle.
  const el = document.getElementById('hub-api-status');
  if (el) {
    el.className = `hub-api-status ${online ? 'is-online' : 'is-offline'}`;
    el.innerHTML = `<i></i><span>${online ? 'Local API ready' : 'API unavailable'}</span>`;
    el.title = online ? 'Hivemind Content Studio API is reachable' : 'The studio API is not reachable from this origin';
  }
}

export async function refreshAll({ quiet = false } = {}) {
  document.getElementById('hub-refresh-button')?.setAttribute('aria-busy', 'true');
  try {
    if (!hubState.catalog || !quiet) hubState.catalog = await api('/api/catalog');
    if (!quiet) hubState.surfaces = await api('/api/surfaces');
    if (!hubState.oauth || !quiet) await loadOAuth();
    const [runsChanged, telemetryChanged] = await Promise.all([loadRuns(), loadGenerationTelemetry({ quiet: true })]);
    setApiOnline(true);
    // An idle quiet tick must publish nothing at all — loadRuns/loadGenerationTelemetry
    // already notified if their data moved, and a blanket notify here re-rendered the
    // whole hub (every History card, every thumbnail) every 10 seconds regardless.
    if (!quiet || runsChanged || telemetryChanged) notifyHub();
    // Keep the History tab live while it's open — a generation finishing in
    // another view appears without toggling away.
    if (hubState.activeView === 'history') await loadPrompts({ quiet: true });
  } catch (error) {
    setApiOnline(false);
    if (!quiet) toast.error(error.message);
  } finally { document.getElementById('hub-refresh-button')?.removeAttribute('aria-busy'); }
}

/* ------------------------------------------------------------------ */
/* Boot (hubApp.js:1858-2097)                                         */
/* ------------------------------------------------------------------ */

let eventsBound = false;

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;

  // Owner access bridge — replies to canvas/models unlock-ready pings.
  window.addEventListener('message', (event) => {
    const frame = ownerAccessFrameForEvent(event);
    if (frame) void postOwnerAccess(frame, 'hivemind-owner-unlock');
  });

  // Canvas history bridge — ready flag + request/response correlation.
  window.addEventListener('message', (event) => {
    const frame = surfaceFrames.get('canvas');
    if (!frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== canvasFrameOrigin()) return;
    if (event.data?.type === 'hivemind-owner-history-bridge-ready') {
      canvasBridgeReady = true;
      canvasBridgeWaiters.splice(0).forEach((waiter) => {
        clearTimeout(waiter.timeout);
        waiter.resolve();
      });
      return;
    }
    if (event.data?.type !== 'hivemind-owner-history-response') return;
    const pending = canvasBridgeRequests.get(event.data.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    canvasBridgeRequests.delete(event.data.requestId);
    if (event.data.ok) pending.resolve(event.data.setup || {});
    else pending.reject(new Error(event.data.error || 'Unable to read the exact workflow'));
  });

  // AppShell topbar controls talk to the hub through window events.
  window.addEventListener('hivemind-hub-refresh', () => { void refreshAll(); void loadPrompts({ quiet: true }); });
  window.addEventListener('hivemind-owner-lock-broadcast', () => {
    surfaceFrames.forEach((frame) => { void postOwnerAccess(frame, 'hivemind-owner-lock'); });
    ownerPassphrase = '';
    try { sessionStorage.removeItem(OWNER_PASSPHRASE_STORAGE_KEY); } catch { /* non-critical */ }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden && hubRootEl?.isConnected) refreshAll({ quiet: true }); });
}

function anyRunningGenerationCard() {
  return hubState.thread.some((item) => {
    if (item.kind !== 'runCards') return false;
    const run = threadRunFor(item);
    return run ? buildRunGenerationCards(run).some((card) => card.status === 'running') : false;
  });
}

let bootStarted = false;

async function boot() {
  bindEvents();
  try {
    [hubState.catalog, hubState.simpleCatalog, hubState.surfaces] = await Promise.all([
      api('/api/catalog'), api('/api/simple/catalog'), api('/api/surfaces'),
    ]);
    await loadOAuth();
    // Select defaults (was the boot-time <select> population).
    hubState.workflow.aspectRatio = hubState.catalog.aspect_ratios?.[0] || '';
    hubState.workflow.privacy = hubState.catalog.privacy_modes?.[0] || '';
    defaultBrainRoute();
    hubState.routes.image = 'automatic';
    hubState.routes.video = 'automatic';
    setStudioMode('create');
    hubState.selectedLane = hubState.catalog.lanes[0].id;
    setSelectedLane(hubState.selectedLane);
    notifyHub();
    await refreshAll({ quiet: true });
    await loadPrompts({ quiet: true });
    restoreLatestRunInComposer();
  } catch (error) {
    // Standalone mode (vite dev / hosted dist without the studio API):
    // stay quiet, mark the status pill, keep the native studios usable.
    console.warn('[hub] studio API unavailable:', error?.message || error);
    setApiOnline(false);
  }
  setInterval(() => { if (!document.hidden && hubRootEl?.isConnected) refreshAll({ quiet: true }); }, 10000);
  setInterval(() => {
    if (!document.hidden && hubRootEl?.isConnected && anyRunningGenerationCard()) notifyHub();
  }, 1000);
}

// Idempotent — HubLayer calls this on mount; boot runs exactly once per session.
export function startHub() {
  if (bootStarted) return;
  bootStarted = true;
  void boot();
}
