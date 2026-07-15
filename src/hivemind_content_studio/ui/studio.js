const state = {
  catalog: null,
  runs: [],
  selectedLane: '',
  selectedRunId: '',
  scenes: [{ title: 'Hook', beat: '', overlay: '', voice: '', duration_seconds: 4, image_prompt: '', motion_prompt: '' }],
  statusFilter: '',
  operatorToken: '',
  oauth: null,
  simpleCatalog: null,
  simpleAttachments: [],
  simpleHistory: [],
  simplePlan: null,
  createMode: 'simple',
  studioMode: 'create',
  prompts: [],
  telemetry: null,
  historyFilter: '',
  routePickerOpen: '',
  routePickerQuery: { brain: '', image: '', video: '' },
  routePickerExpanded: { brain: {}, image: {}, video: {} },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const titleCase = (value) => String(value || '').replaceAll('-', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
const providerLabel = (value) => ({
  'openai-gpt-image': 'OpenAI · GPT Image',
  'openai-gpt-image-oauth': 'OpenAI · GPT Image OAuth',
  'xai-imagine-api': 'xAI · Imagine API',
  'xai-imagine-oauth': 'xAI · Imagine OAuth',
  'hivemindos-hosted-media': 'HivemindOS · Hosted media',
  'media-studio-mcp': 'HivemindOS · Media Studio MCP',
  'upload-post': 'Upload-Post',
}[value] || value);

async function api(path, options = {}) {
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

function routeValue(provider, model, auth = '') {
  return JSON.stringify({ provider, model, ...(auth ? { auth } : {}) });
}

function selectedRoute(select) {
  if (!select?.value || select.value === 'automatic') return { provider: 'automatic', model: 'automatic' };
  try { return JSON.parse(select.value); } catch { return { provider: 'automatic', model: 'automatic' }; }
}

function switchCreateMode(mode) {
  state.createMode = mode === 'advanced' ? 'advanced' : 'simple';
  $('#simple-studio').classList.toggle('is-hidden', state.createMode !== 'simple');
  $('#advanced-studio').classList.toggle('is-hidden', state.createMode !== 'advanced');
  $$('[data-create-mode]').forEach((button) => button.classList.toggle('is-active', button.dataset.createMode === state.createMode));
}

const STUDIO_MODES = {
  create: {
    heading: 'What do you want to make?',
    copy: 'Create images, video, and complete media from one prompt, one model router, and one durable run.',
    placeholder: 'Create a 20-second product launch ad with a hard pattern interrupt, three cinematic scenes, and a direct CTA…',
    submit: 'Plan creation',
    attachment: 'Images',
  },
  edit: {
    heading: 'What should change?',
    copy: 'Add one or more ordered references, describe the transformation, and keep every result in the same asset history.',
    placeholder: 'Replace the background with a warm editorial studio while preserving the product, framing, and lighting direction…',
    submit: 'Plan edit',
    attachment: 'References',
  },
  animate: {
    heading: 'What should move?',
    copy: 'Animate an idea or attached frame with the same video models, run history, provenance, and approvals.',
    placeholder: 'Animate this frame with a slow push-in, subtle fabric movement, natural parallax, and a clean final hold…',
    submit: 'Plan animation',
    attachment: 'Start frame',
  },
  workflow: {
    heading: 'Build the complete workflow',
    copy: 'Control scenes, providers, voice, assembly, publishing, budget, and policy in one production form.',
    placeholder: '',
    submit: 'Create production',
    attachment: 'Images',
  },
};

function selectNativeStudioMode(mode) {
  const selected = Object.hasOwn(STUDIO_MODES, mode) ? mode : 'create';
  state.studioMode = selected;
  const config = STUDIO_MODES[selected];
  const createView = $('[data-view="create"]');
  createView.dataset.studioMode = selected;
  $$('[data-studio-mode]').forEach((button) => {
    const active = button.dataset.studioMode === selected;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('#simple-heading').textContent = config.heading;
  $('#simple-hero-copy').textContent = config.copy;
  $('#simple-prompt').placeholder = config.placeholder;
  $('#simple-attach b').textContent = config.attachment;
  $('#simple-submit span').textContent = config.submit;
  switchCreateMode(selected === 'workflow' ? 'advanced' : 'simple');
}

function modelOptionLabel(model) {
  const vision = model.vision ? ' · vision' : '';
  const suffix = model.recommended ? ' · recommended' : '';
  return `${model.id}${vision}${suffix}`;
}

const ROUTE_AUTH_SECTIONS = {
  api: { label: 'API key', detail: 'Uses credentials loaded server-side from the shared Hive environment.' },
  oauth: { label: 'OAuth', detail: 'Uses a connected HivemindOS account. Tokens never enter this browser.' },
  local: { label: 'Local & managed', detail: 'Runs locally, on your fleet, through a consumer session, or with HivemindOS credits.' },
};

const DIRECT_API_MEDIA_PROVIDERS = new Set(['openai-gpt-image', 'xai-imagine-api', 'muapi', 'higgsfield-cloud']);

function mediaAuthSection(providerId) {
  if (providerId.endsWith('-oauth')) return 'oauth';
  if (DIRECT_API_MEDIA_PROVIDERS.has(providerId)) return 'api';
  return 'local';
}

function routePickerProviders(kind) {
  if (kind === 'brain') {
    return (state.simpleCatalog?.brains || []).flatMap((provider) => ['api', 'oauth'].map((authSection) => ({
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
  return (state.simpleCatalog?.media?.[kind] || []).map((provider) => ({
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

function selectedRoutePickerItem(kind) {
  const route = selectedRoute($(`#simple-${kind === 'brain' ? 'brain' : `${kind}-route`}`));
  if (route.provider === 'automatic') return null;
  for (const provider of routePickerProviders(kind)) {
    const model = provider.models.find((candidate) => candidate.value === routeValue(route.provider, route.model, route.auth));
    if (model) return { provider, model };
  }
  return null;
}

function updateRoutePickerTrigger(kind) {
  const selected = selectedRoutePickerItem(kind);
  const label = $(`[data-route-trigger-label="${kind}"]`);
  const auth = $(`[data-route-trigger-auth="${kind}"]`);
  if (!selected) {
    label.textContent = kind === 'brain' ? 'No model available' : 'Automatic · brain chooses';
    auth.textContent = kind === 'brain' ? '' : 'Auto';
    auth.className = `route-auth-chip${kind === 'brain' ? ' is-hidden' : ' is-automatic'}`;
    return;
  }
  label.textContent = `${selected.provider.label} · ${selected.model.label}`;
  auth.textContent = ROUTE_AUTH_SECTIONS[selected.provider.authSection].label;
  auth.className = `route-auth-chip is-${selected.provider.authSection}`;
}

function routePickerMatches(provider, model, query) {
  if (!query) return true;
  const haystack = `${provider.label} ${provider.id} ${model.label} ${model.id} ${ROUTE_AUTH_SECTIONS[provider.authSection].label}`.toLowerCase();
  return query.split(/\s+/).every((token) => haystack.includes(token));
}

function renderRoutePicker(kind) {
  const list = $(`[data-route-list="${kind}"]`);
  if (!list) return;
  const query = state.routePickerQuery[kind].trim().toLowerCase();
  const selectedValue = $(`#simple-${kind === 'brain' ? 'brain' : `${kind}-route`}`).value;
  const providers = routePickerProviders(kind);
  const sections = Object.entries(ROUTE_AUTH_SECTIONS).map(([sectionId, section]) => {
    const sectionProviders = providers.filter((provider) => provider.authSection === sectionId).map((provider) => {
      const matchingModels = provider.models.filter((model) => routePickerMatches(provider, model, query));
      if (!matchingModels.length) return '';
      const expansionKey = `${sectionId}:${provider.id}`;
      const expanded = Boolean(query) || Boolean(state.routePickerExpanded[kind][expansionKey]);
      const selectedHere = matchingModels.some((model) => model.value === selectedValue);
      const modelRows = expanded ? `<div class="route-provider-models" role="group" aria-label="${esc(provider.label)} models">${matchingModels.map((model) => {
        const selected = model.value === selectedValue;
        return `<button class="route-model-choice${selected ? ' is-selected' : ''}" type="button" role="menuitemradio" aria-checked="${selected}" data-route-choice="${esc(kind)}" data-route-value="${esc(model.value)}"${model.disabled ? ' disabled' : ''}>
          <span><b>${esc(model.label)}</b>${model.disabled ? `<small>${esc(model.disabledReason)}</small>` : ''}</span><i aria-hidden="true">${selected ? '✓' : ''}</i>
        </button>`;
      }).join('')}</div>` : '';
      return `<section class="route-provider${selectedHere ? ' has-selection' : ''}">
        <button class="route-provider-toggle" type="button" data-provider-toggle="${esc(kind)}" data-provider-key="${esc(expansionKey)}" aria-expanded="${expanded}">
          <span class="route-provider-state${provider.available ? ' is-ready' : ''}" aria-hidden="true"></span>
          <span><b>${esc(provider.label)}</b><small>${provider.models.length} model${provider.models.length === 1 ? '' : 's'}${provider.available ? ' · ready' : ' · unavailable'}</small></span>
          <i aria-hidden="true">⌄</i>
        </button>${modelRows}
      </section>`;
    }).join('');
    if (!sectionProviders) return '';
    const count = providers.filter((provider) => provider.authSection === sectionId).length;
    return `<section class="route-auth-section is-${esc(sectionId)}">
      <header><span><b>${esc(section.label)}</b><em>${count} provider${count === 1 ? '' : 's'}</em></span><p>${esc(section.detail)}</p></header>
      <div class="route-auth-providers">${sectionProviders}</div>
    </section>`;
  }).join('');
  const automatic = kind === 'brain' ? '' : `<button class="route-automatic-choice${selectedValue === 'automatic' ? ' is-selected' : ''}" type="button" role="menuitemradio" aria-checked="${selectedValue === 'automatic'}" data-route-automatic="${esc(kind)}"><span><b>Automatic</b><small>The planning brain chooses the best compatible route.</small></span><i aria-hidden="true">${selectedValue === 'automatic' ? '✓' : ''}</i></button>`;
  list.innerHTML = `${automatic}${sections || '<p class="route-picker-empty">No matching providers or models.</p>'}`;
  updateRoutePickerTrigger(kind);
}

function closeRoutePickers({ restoreFocus = false } = {}) {
  const openKind = state.routePickerOpen;
  if (!openKind) return;
  $(`[data-route-popover="${openKind}"]`)?.classList.add('is-hidden');
  $(`[data-route-trigger="${openKind}"]`)?.setAttribute('aria-expanded', 'false');
  state.routePickerOpen = '';
  if (restoreFocus) $(`[data-route-trigger="${openKind}"]`)?.focus();
}

function openRoutePicker(kind) {
  if (state.routePickerOpen === kind) {
    closeRoutePickers({ restoreFocus: true });
    return;
  }
  closeRoutePickers();
  state.routePickerOpen = kind;
  state.routePickerQuery[kind] = '';
  const search = $(`[data-route-search="${kind}"]`);
  const trigger = $(`[data-route-trigger="${kind}"]`);
  const popover = $(`[data-route-popover="${kind}"]`);
  search.value = '';
  renderRoutePicker(kind);
  popover.style.maxHeight = window.matchMedia('(max-width: 600px)').matches
    ? ''
    : `${Math.max(180, Math.min(520, trigger.getBoundingClientRect().top - 104))}px`;
  popover.classList.remove('is-hidden');
  trigger.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => search.focus());
}

function setRoutePickerValue(kind, value) {
  const input = $(`#simple-${kind === 'brain' ? 'brain' : `${kind}-route`}`);
  input.value = value;
  closeRoutePickers({ restoreFocus: true });
  renderRoutePicker(kind);
  if (kind === 'brain') {
    const model = selectedBrainModel();
    if (state.simpleAttachments.length && model?.vision === false) toast(`${model.id} is text-only — it can't see your attached images.`, 'error');
  } else {
    updateCapabilityNote();
  }
}

function savedRouteValue(kind, route) {
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

function selectedBrainModel() {
  const route = selectedRoute($('#simple-brain'));
  const provider = (state.simpleCatalog?.brains || []).find((item) => item.slug === route.provider);
  return provider?.models.find((model) => model.id === route.model && (!route.auth || model.auth === route.auth)) || null;
}

function preferVisionBrain() {
  // Only auto-switch away from a brain the catalog marks as known text-only
  // (vision === false). Unknown modality (no flag) stays put — the planner
  // degrades to a text-only plan with a warning if the route rejects images.
  if (!state.simpleAttachments.length) return;
  const current = selectedBrainModel();
  if (!current || current.vision !== false) return;
  const candidates = (state.simpleCatalog?.brains || []).flatMap((provider) => provider.models
    .filter((model) => model.vision && !model.disabled)
    .map((model) => ({ provider, model })));
  const target = candidates.find((item) => item.model.recommended) || candidates[0];
  if (!target) return;
  setRoutePickerValue('brain', routeValue(target.provider.slug, target.model.id, target.model.auth));
  toast(`Brain switched to ${target.model.id} — ${current.id} is text-only and can't see attached images.`);
}

function renderBrainSelector() {
  const groups = state.simpleCatalog?.brains || [];
  if (!groups.length) {
    $('#simple-brain').value = '';
    renderRoutePicker('brain');
    $('[data-route-trigger="brain"]').disabled = true;
    return;
  }
  $('[data-route-trigger="brain"]').disabled = false;
  const available = groups.flatMap((provider) => provider.models.map((model) => ({ provider, model }))).filter((item) => !item.model.disabled);
  const recommended = available.find((item) => item.model.recommended) || available[0];
  if (recommended) $('#simple-brain').value = routeValue(recommended.provider.slug, recommended.model.id, recommended.model.auth);
  renderRoutePicker('brain');
}

function renderMediaSelector(kind) {
  $(`#simple-${kind}-route`).value = 'automatic';
  renderRoutePicker(kind);
}

function selectedMediaModel(kind) {
  const route = selectedRoute($(`#simple-${kind}-route`));
  if (route.provider === 'automatic') return null;
  const provider = (state.simpleCatalog?.media?.[kind] || []).find((item) => item.id === route.provider);
  return provider?.models.find((model) => model.id === route.model) || null;
}

function updateCapabilityNote() {
  const models = ['image', 'video'].map(selectedMediaModel).filter(Boolean);
  if (!models.length) {
    $('#simple-capability-note').textContent = state.simpleCatalog?.attachment_note || 'Up to 30 ordered reference images. Automatic lets the brain choose compatible roles and providers.';
    return;
  }
  $('#simple-capability-note').textContent = models.map((model) => {
    const roles = model.reference_roles?.length ? model.reference_roles.join(', ') : 'no image input';
    const limit = model.max_reference_images == null ? `validated from ${model.limit_source}` : `${model.max_reference_images} image${model.max_reference_images === 1 ? '' : 's'} max`;
    return `${model.label}: ${roles} · ${limit}`;
  }).join('  •  ');
}

function renderSimpleAttachments() {
  $('#simple-attachments').innerHTML = state.simpleAttachments.map((item, index) => {
    const role = state.simpleAttachments.length === 1 ? 'Reference' : index === 0 ? 'Start' : index === state.simpleAttachments.length - 1 ? 'End' : `Reference ${index}`;
    const name = item.name || item.file?.name || `Reference ${index + 1}`;
    return `<article class="simple-attachment"><img src="${esc(item.url)}" alt="${esc(name)} preview" /><span>${esc(role)}</span><button type="button" data-remove-simple-image="${index}" aria-label="Remove ${esc(name)}">×</button></article>`;
  }).join('');
  $('#simple-attach b').textContent = state.simpleAttachments.length ? `${state.simpleAttachments.length}/30` : 'Images';
}

const isImageFile = (file) => (file.type || '').startsWith('image/') || /\.(avif|heic|heif|png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file.name || '');

function addSimpleImages(files) {
  const all = [...files];
  const accepted = all.filter(isImageFile);
  if (accepted.length < all.length) toast(`${all.length - accepted.length} file${all.length - accepted.length === 1 ? ' is' : 's are'} not an image and ${all.length - accepted.length === 1 ? 'was' : 'were'} skipped.`, 'error');
  const remaining = 30 - state.simpleAttachments.length;
  if (accepted.length > remaining) toast(`Only the first ${remaining} image${remaining === 1 ? '' : 's'} were added.`, 'error');
  accepted.slice(0, Math.max(0, remaining)).forEach((file) => state.simpleAttachments.push({ file, url: URL.createObjectURL(file) }));
  renderSimpleAttachments();
  preferVisionBrain();
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
  return Promise.all(state.simpleAttachments.map(async (item, index) => {
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

function removeSimpleImage(index) {
  const [removed] = state.simpleAttachments.splice(index, 1);
  if (removed?.file) URL.revokeObjectURL(removed.url);
  renderSimpleAttachments();
}

function simpleAssistantCopy(plan) {
  const questions = Array.isArray(plan.questions) ? `<ol>${plan.questions.map((question) => `<li>${esc(question)}</li>`).join('')}</ol>` : '';
  return `<p>${esc(plan.message || (plan.mode === 'confirmation' ? 'Review the production plan before it starts.' : 'The production plan is ready.'))}</p>${questions}`;
}

function simpleDraftSummary(plan) {
  const draft = plan?.draft || {};
  const scenes = Array.isArray(draft.scenes) ? draft.scenes : [];
  return `<article class="generation-card plan-card" data-status="ready">
    <header><span class="generation-icon">✦</span><div><p class="section-kicker">Production plan</p><h3>${esc(draft.title || 'Draft ready')}</h3></div><span class="generation-status">Ready</span></header>
    <div class="generation-meta"><span>${esc(titleCase(draft.lane || 'automatic'))}</span><span>${esc(draft.aspect_ratio || 'Auto')}</span><span>${scenes.length || 'Auto'} scene${scenes.length === 1 ? '' : 's'}</span></div>
    <p class="generation-prompt">${esc(draft.concept || plan.message || '')}</p>
    ${scenes.length ? `<div class="plan-scenes">${scenes.map((scene, index) => `<span><b>${String(index + 1).padStart(2, '0')}</b>${esc(scene.title || scene.beat || `Scene ${index + 1}`)}</span>`).join('')}</div>` : ''}
    ${plan.mode === 'confirmation' ? '<button class="confirm-plan-button" type="button" data-confirm-simple-plan>Confirm &amp; create production</button>' : ''}
  </article>`;
}

function scrollThreadToLatest() {
  // New thread content should always come into view above the sticky composer.
  // Immediate + delayed: rAF/smooth scrolling stalls on occluded surfaces, and
  // the delayed pass catches async card/image layout growth.
  const toBottom = () => {
    const scroller = document.scrollingElement || document.documentElement;
    scroller.scrollTo({ top: scroller.scrollHeight });
  };
  toBottom();
  setTimeout(toBottom, 120);
}

function appendSimpleMessage(role, html) {
  const article = document.createElement('article');
  article.className = `simple-message is-${role}`;
  article.innerHTML = role === 'assistant' ? `<span class="message-mark">H</span><div>${html}</div>` : `<div>${html}</div>`;
  $('#simple-thread').append(article);
  scrollThreadToLatest();
}

function generationArtifactUrl(run, artifact) {
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

function buildRunGenerationCards(run) {
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

function generationStatusLabel(status) {
  return ({ waiting: 'waiting', running: 'generating', ready: 'ready', error: 'error' })[status] || status;
}

function generationIcon(kind, status) {
  if (status === 'running') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3Zm6 10 .8 2.2L21 16l-2.2.8L18 19l-.8-2.2L15 16l2.2-.8L18 13ZM5 13l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z"/></svg>';
  if (kind === 'video') return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2Z"/></svg>';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 17 5-4 4 3 3-2 4 3"/></svg>';
}

function generationTiming(card) {
  if (!Number.isFinite(card.createdAt)) return '';
  const end = Number.isFinite(card.completedAt) ? card.completedAt : Date.now();
  const label = card.status === 'running' ? 'elapsed' : card.status === 'error' ? 'failed after' : 'generated in';
  return ` · ${label} ${formatTelemetryDuration(end - card.createdAt)}`;
}

function generationProgress(card) {
  if (card.status !== 'running' || !Number.isFinite(card.createdAt)) return '';
  const providerMetrics = (state.telemetry?.by_provider || []).find((row) => row.provider === card.provider);
  const estimate = Number(providerMetrics?.average_duration_ms || 0);
  if (!estimate) return '';
  const progress = Math.min(96, Math.max(2, Math.round(((Date.now() - card.createdAt) / estimate) * 100)));
  return `<span class="application-generation-progress" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100" aria-label="Estimated generation progress"><i style="width:${progress}%"></i></span>`;
}

function renderGenerationArtifacts(run, card) {
  if (!card.artifacts.length) return '';
  if (card.kind === 'video') return `<div class="application-generation-media">${card.artifacts.map((artifact) => `<video controls preload="metadata" src="${esc(generationArtifactUrl(run, artifact))}"></video>`).join('')}</div>`;
  return `<div class="application-generation-image-grid">${card.artifacts.map((artifact, index) => {
    const url = generationArtifactUrl(run, artifact);
    return `<button type="button" data-generation-preview="${esc(url)}" aria-label="Open generated image ${index + 1}"><img src="${esc(url)}" alt="Generated image ${index + 1}" loading="lazy" /></button>`;
  }).join('')}</div>`;
}

function renderGenerationSource(run, card) {
  const source = card.sourceArtifacts?.[0];
  if (!source) return '';
  const url = generationArtifactUrl(run, source);
  return `<button class="application-generation-source" type="button" data-generation-preview="${esc(url)}" aria-label="Open source image preview"><img src="${esc(url)}" alt="Source image" /></button>`;
}

function renderApplicationGenerationCard(run, card) {
  const artifacts = renderGenerationArtifacts(run, card);
  const canvas = artifacts || `<div class="application-generation-canvas is-${esc(card.status)}"><span>${card.status === 'running' ? 'Generating with the selected provider' : card.detail}</span></div>`;
  return `<article class="application-generation-card" data-status="${esc(card.status)}" data-generation-kind="${esc(card.kind)}">
    <header class="application-generation-header">
      <span class="application-generation-icon">${generationIcon(card.kind, card.status)}</span>
      <span class="application-generation-title"><strong>${esc(card.title)}</strong><small>${esc(providerLabel(card.provider))} · ${esc(card.model)}${esc(generationTiming(card))}</small></span>
      <span class="application-generation-status">${esc(generationStatusLabel(card.status))}</span>
    </header>
    ${canvas}${generationProgress(card)}
    ${card.status === 'error' ? `<p class="application-generation-error">${esc(card.error || card.detail)}</p>` : ''}
    <div class="application-generation-prompt"><div><strong>Prompt</strong><span>${esc(card.prompt)}</span></div>${renderGenerationSource(run, card)}</div>
    <div class="application-generation-actions"><button type="button" data-open-simple-run="${esc(run.run_id)}">Open generation step</button></div>
  </article>`;
}

function renderRunGenerationCards(run) {
  const cards = buildRunGenerationCards(run);
  return `<section class="application-generation-stack" data-simple-run-cards="${esc(run.run_id)}">${cards.map((card) => renderApplicationGenerationCard(run, card)).join('')}</section>`;
}

function refreshSimpleRunGenerationCards() {
  $$('[data-simple-run-cards]').forEach((container) => {
    const run = state.runs.find((item) => item.run_id === container.dataset.simpleRunCards);
    if (run) container.innerHTML = buildRunGenerationCards(run).map((card) => renderApplicationGenerationCard(run, card)).join('');
  });
}

function openGenerationPreview(url) {
  const overlay = document.createElement('div');
  overlay.className = 'application-generation-preview';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Generated image preview');
  overlay.innerHTML = `<button type="button" data-close-generation-preview aria-label="Close preview">×</button><img src="${esc(url)}" alt="Generated image preview" />`;
  document.body.append(overlay);
  overlay.querySelector('[data-close-generation-preview]').focus();
}

function setSimpleBusy(busy, label = 'Planning') {
  const button = $('#simple-submit');
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.innerHTML = busy ? `<span>${esc(label)}</span><i class="spinner" aria-hidden="true"></i>` : `<span>${esc(STUDIO_MODES[state.studioMode].submit)}</span><i aria-hidden="true">↑</i>`;
}

async function createSimpleRun(plan) {
  setSimpleBusy(true, 'Creating');
  const card = document.createElement('article');
  card.className = 'generation-card generation-loading';
  card.setAttribute('role', 'status');
  card.setAttribute('aria-label', 'Creating production run');
  card.innerHTML = '<div class="generation-card-skeleton"><i></i><span></span><span></span><span></span></div>';
  $('#simple-thread').append(card);
  scrollThreadToLatest();
  try {
    const form = new FormData();
    const referenceArtifacts = state.simpleAttachments.filter((item) => item.artifactId).map((item) => ({ run_id: item.sourceRunId, artifact_id: item.artifactId }));
    form.append('plan_json', JSON.stringify({ ...plan, reference_artifacts: referenceArtifacts }));
    state.simpleAttachments.filter((item) => item.file).forEach((item) => form.append('images', item.file, item.file.name));
    const run = await api('/api/simple/runs', { method: 'POST', body: form });
    card.outerHTML = renderRunGenerationCards(run);
    await Promise.all([loadRuns(), loadGenerationTelemetry({ quiet: true })]);
    state.selectedRunId = run.run_id;
    toast('Production created. Agents can continue from the durable run.');
    void loadPrompts({ quiet: true });
  } catch (error) {
    card.className = 'generation-card is-error';
    card.innerHTML = `<header><span class="generation-icon">!</span><div><p class="section-kicker">Production failed</p><h3>Could not create the run</h3></div></header><p class="generation-prompt">${esc(error.message)}</p>`;
    toast(error.message, 'error');
  } finally { setSimpleBusy(false); scrollThreadToLatest(); }
}

async function submitSimplePrompt(event) {
  event.preventDefault();
  const prompt = $('#simple-prompt').value.trim();
  if (!prompt) { toast('Describe what you want to create.', 'error'); return; }
  if (state.studioMode === 'edit' && !state.simpleAttachments.length) { toast('Add at least one reference image before planning an edit.', 'error'); return; }
  const brain = selectedRoute($('#simple-brain'));
  if (!brain.provider || brain.provider === 'automatic') { toast('Connect or select an LLM brain first.', 'error'); return; }
  appendSimpleMessage('user', `<p>${esc(prompt)}</p>`);
  state.simpleHistory.push({ role: 'user', content: prompt });
  setSimpleBusy(true);
  try {
    const imageSelection = selectedRoute($('#simple-image-route'));
    const videoSelection = selectedRoute($('#simple-video-route'));
    const payload = await api('/api/simple/plan', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        studioMode: state.studioMode,
        ...brain,
        promptHelper: $('#simple-prompt-helper').checked,
        walkthrough: $('#simple-walkthrough').checked,
        confirmed: false,
        history: state.simpleHistory.slice(0, -1),
        attachments: await simpleAttachmentsPayload(),
        imageSelection,
        videoSelection,
      }),
    });
    const plan = payload.plan;
    plan.user_prompt = prompt;
    state.simplePlan = plan;
    const assistant = simpleAssistantCopy(plan);
    appendSimpleMessage('assistant', `${assistant}${plan.draft ? simpleDraftSummary(plan) : ''}`);
    state.simpleHistory.push({ role: 'assistant', content: plan.message || JSON.stringify(plan.questions || []) });
    $('#simple-prompt').value = '';
    if (plan.mode === 'brief') await createSimpleRun(plan);
  } catch (error) {
    appendSimpleMessage('assistant', `<p class="message-error">${esc(error.message)}</p>`);
    toast(error.message, 'error');
  } finally { setSimpleBusy(false); }
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast${type === 'error' ? ' is-error' : ''}`;
  item.textContent = message;
  $('#toast-region').append(item);
  setTimeout(() => item.remove(), 4200);
}

function lane() {
  return state.catalog?.lanes.find((item) => item.id === state.selectedLane);
}

function navigate(view) {
  const selected = ['create', 'runs', 'history', 'telemetry', 'providers'].includes(view) ? view : 'create';
  $$('.view').forEach((item) => item.classList.toggle('is-active', item.dataset.view === selected));
  $$('.nav-item').forEach((item) => item.classList.toggle('is-active', item.dataset.viewTarget === selected));
  const copy = {
    create: ['Unified creation', 'Studio'],
    runs: ['Durable workflow', 'Runs'],
    history: ['Prompt library', 'History'],
    telemetry: ['Generation operations', 'Telemetry'],
    providers: ['Capability routing', 'Providers'],
  }[selected];
  $('#view-eyebrow').textContent = copy[0];
  $('#view-title').textContent = copy[1];
  location.hash = selected;
  if (selected === 'runs') renderRuns();
  if (selected === 'history') void loadPrompts({ quiet: true });
  if (selected === 'telemetry') void loadGenerationTelemetry({ quiet: true });
  if (selected === 'providers') renderProviders();
}

async function loadPrompts({ quiet = false } = {}) {
  try {
    const payload = await api('/api/simple/prompts');
    state.prompts = payload.prompts || [];
  } catch (error) {
    if (!quiet) toast(error.message, 'error');
  }
  renderPromptHistory();
  renderIngredients();
}

function formatTelemetryDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function renderGenerationTelemetry() {
  if (!state.telemetry) return;
  const summary = state.telemetry.summary || {};
  const rate = Number(summary.success_rate || 0) * 100;
  $('#telemetry-summary').removeAttribute('role');
  $('#telemetry-summary').removeAttribute('aria-label');
  $('#telemetry-summary').innerHTML = [
    ['Attempts', summary.attempts || 0, `${summary.running || 0} running`],
    ['Success rate', `${rate.toFixed(rate % 1 ? 1 : 0)}%`, `${summary.failed || 0} failed`],
    ['Average time', formatTelemetryDuration(summary.average_duration_ms), `p95 ${formatTelemetryDuration(summary.p95_duration_ms)}`],
    ['Generation cost', `$${Number(summary.charged_usd || 0).toFixed(2)}`, `${summary.artifacts || 0} artifacts`],
  ].map(([label, value, detail]) => `<article class="telemetry-stat"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(detail)}</small></article>`).join('');

  const providers = state.telemetry.by_provider || [];
  $('#telemetry-providers').innerHTML = providers.length ? providers.map((provider) => `
    <article class="telemetry-provider-row">
      <div><b>${esc(providerLabel(provider.provider))}</b><small>${esc(provider.attempts)} attempt${provider.attempts === 1 ? '' : 's'} · ${esc(provider.completed)} completed · ${esc(provider.failed)} failed</small></div>
      <div><b>${esc(Math.round(Number(provider.success_rate || 0) * 100))}%</b><small>${esc(formatTelemetryDuration(provider.average_duration_ms))} average · $${esc(Number(provider.charged_usd || 0).toFixed(2))}</small></div>
    </article>`).join('') : '<div class="empty-telemetry"><b>No generation samples yet</b><small>Agent-routed image, video, voice, and music attempts will appear here.</small></div>';

  const attempts = state.telemetry.recent_attempts || [];
  $('#telemetry-attempts').innerHTML = attempts.length ? attempts.map((attempt) => `
    <article class="telemetry-attempt-row">
      <div><span class="status-pill" data-status="${esc(attempt.status)}">${esc(titleCase(attempt.status))}</span><b>${esc(titleCase(attempt.kind))} · ${esc(providerLabel(attempt.provider))}</b></div>
      <small>${esc(attempt.model || 'automatic')} · ${esc(formatTelemetryDuration(attempt.duration_ms))} · $${esc(Number(attempt.charged_usd || 0).toFixed(2))}</small>
      <small>Run ${esc(attempt.run_id)}${attempt.error_type ? ` · ${esc(attempt.error_type)}` : ''}</small>
    </article>`).join('') : '<div class="empty-telemetry"><b>No recent attempts</b><small>Telemetry begins when a run dispatches a generation intent.</small></div>';
}

async function loadGenerationTelemetry({ quiet = false } = {}) {
  try {
    state.telemetry = await api('/api/telemetry/generations');
    renderGenerationTelemetry();
    refreshSimpleRunGenerationCards();
  } catch (error) {
    if (!quiet) toast(error.message, 'error');
  }
}

function promptHistoryEntryCard(entry) {
  const meta = [titleCase(entry.lane || ''), entry.title, new Date(entry.updated_at).toLocaleString(), entry.use_count > 1 ? `used ${entry.use_count}×` : '']
    .filter(Boolean).map((item) => `<span>${esc(item)}</span>`).join('');
  const original = entry.user_prompt && entry.user_prompt !== entry.prompt
    ? `<details class="prompt-original"><summary>Your original wording</summary><p>${esc(entry.user_prompt)}</p></details>` : '';
  return `<article class="prompt-card${entry.favorite ? ' is-favorite' : ''}" data-prompt-id="${esc(entry.prompt_id)}">
    <button class="prompt-star" type="button" data-favorite-prompt="${esc(entry.prompt_id)}" data-favorite-next="${entry.favorite ? 'false' : 'true'}" aria-label="${entry.favorite ? 'Remove from favorites' : 'Add to favorites'}" aria-pressed="${entry.favorite}">${entry.favorite ? '★' : '☆'}</button>
    <div class="prompt-card-body">
      <p class="prompt-text">${esc(entry.prompt)}</p>
      ${original}
      <div class="prompt-meta">${meta}</div>
    </div>
    <div class="prompt-card-actions">
      <button type="button" data-use-prompt="${esc(entry.prompt_id)}">Use in composer</button>
      <button class="danger" type="button" data-delete-prompt="${esc(entry.prompt_id)}" aria-label="Delete prompt from history">×</button>
    </div>
  </article>`;
}

function renderPromptHistory() {
  const list = $('#prompt-history-list');
  if (!list) return;
  const entries = state.historyFilter === 'favorites' ? state.prompts.filter((entry) => entry.favorite) : state.prompts;
  list.innerHTML = entries.length ? entries.map(promptHistoryEntryCard).join('')
    : `<div class="empty-detail"><span>☆</span><b>${state.historyFilter === 'favorites' ? 'No favorites yet' : 'No prompts yet'}</b><small>${state.historyFilter === 'favorites' ? 'Star a prompt to keep it as a reusable ingredient.' : 'Create a production and its final generation prompt will be recorded here.'}</small></div>`;
}

function renderIngredients() {
  const menu = $('#ingredients-menu');
  if (!menu) return;
  const favorites = state.prompts.filter((entry) => entry.favorite);
  menu.innerHTML = favorites.length
    ? favorites.map((entry) => `<button class="ingredient-item" type="button" data-insert-prompt="${esc(entry.prompt_id)}" title="${esc(entry.prompt)}"><b>★</b><span>${esc(entry.prompt.length > 140 ? `${entry.prompt.slice(0, 140)}…` : entry.prompt)}</span></button>`).join('')
    : '<p class="ingredients-empty">Favorite a prompt in History to reuse it here.</p>';
}

const TEMPLATE_CATEGORY_LABELS = { ugc: 'UGC realism', formats: 'Winning formats', animation: 'Animation' };

function renderTemplates() {
  const menu = $('#templates-menu');
  if (!menu) return;
  const templates = state.simpleCatalog?.templates || [];
  if (!templates.length) {
    menu.innerHTML = '<p class="ingredients-empty">No production templates are installed.</p>';
    return;
  }
  const categories = [...new Set(templates.map((entry) => entry.category))];
  menu.innerHTML = categories.map((category) => `
    <p class="templates-group">${esc(TEMPLATE_CATEGORY_LABELS[category] || titleCase(category))}</p>
    ${templates.filter((entry) => entry.category === category).map((entry) => `
      <button class="ingredient-item template-item" type="button" data-insert-template="${esc(entry.id)}" title="${esc(entry.description)}">
        <b>▤</b><span><strong>${esc(entry.title)}</strong><small>${esc(entry.description)}</small></span>
      </button>`).join('')}`).join('');
}

function insertPromptIntoComposer(text) {
  navigate('create');
  switchCreateMode('simple');
  const box = $('#simple-prompt');
  box.value = box.value.trim() ? `${box.value.replace(/\s+$/, '')}\n${text}` : text;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

function promptEntryForRun(runId) {
  return state.prompts.find((entry) => entry.run_id === runId) || null;
}

function mediaRouteFromRun(run, kind) {
  const role = kind === 'image' ? 'image' : 'motion';
  const provider = run.brief?.providers?.[role] || run.providers?.[role] || '';
  if (!provider) return null;
  const options = run.brief?.provider_options?.[provider];
  return { provider, model: options?.model || 'automatic' };
}

function restoreRunAttachments(run) {
  state.simpleAttachments.filter((item) => item.file).forEach((item) => URL.revokeObjectURL(item.url));
  const references = (run.artifact_records || []).filter((item) =>
    String(item.role || '').startsWith('reference-') && String(item.mime_type || '').startsWith('image/')
  ).sort((left, right) => Number(left.scene || 0) - Number(right.scene || 0));
  state.simpleAttachments = references.map((artifact, index) => ({
    file: null,
    name: `${artifact.role || 'reference-image'}-${index + 1}`,
    type: artifact.mime_type,
    size: artifact.size_bytes || 0,
    url: `/api/runs/${encodeURIComponent(run.run_id)}/artifacts/${encodeURIComponent(artifact.id)}`,
    sourceRunId: run.run_id,
    artifactId: artifact.id,
  }));
  renderSimpleAttachments();
  preferVisionBrain();
}

function loadRunIntoSimpleComposer(runId, { notify = true, focus = true, navigateToCreate = true } = {}) {
  const run = state.runs.find((item) => item.run_id === runId);
  if (!run) return false;
  const entry = promptEntryForRun(runId);
  const runComposer = run.composer && Object.keys(run.composer).length ? run.composer : null;
  const composer = runComposer || entry?.composer || {};
  const prompt = run.user_prompt || entry?.user_prompt || entry?.prompt || run.brief?.concept || run.brief?.title || '';
  $('#simple-prompt').value = prompt;

  const routes = {
    brain: composer.brain,
    image: composer.imageSelection || mediaRouteFromRun(run, 'image'),
    video: composer.videoSelection || mediaRouteFromRun(run, 'video'),
  };
  Object.entries(routes).forEach(([kind, route]) => {
    const value = savedRouteValue(kind, route);
    if (value) setRoutePickerValue(kind, value);
  });
  if (typeof composer.promptHelper === 'boolean') $('#simple-prompt-helper').checked = composer.promptHelper;
  if (typeof composer.walkthrough === 'boolean') $('#simple-walkthrough').checked = composer.walkthrough;
  restoreRunAttachments(run);
  state.simpleHistory = [];
  state.simplePlan = null;
  switchCreateMode('simple');
  selectNativeStudioMode(composer.studioMode || 'create');
  if (navigateToCreate) navigate('create');
  if (focus) {
    $('#simple-prompt').focus();
    $('#simple-prompt').setSelectionRange(prompt.length, prompt.length);
  }
  if (notify) toast('Loaded this run’s prompt, saved settings, and reference images into the composer.');
  return true;
}

function restoreLatestRunInComposer() {
  const latest = [...state.runs].sort((left, right) => new Date(right.created_at) - new Date(left.created_at))[0];
  if (!latest) return;
  loadRunIntoSimpleComposer(latest.run_id, { notify: false, focus: false, navigateToCreate: false });
  if (!$('#simple-thread').children.length && buildRunGenerationCards(latest).length) {
    $('#simple-thread').insertAdjacentHTML('beforeend', renderRunGenerationCards(latest));
  }
}

async function setPromptFavorite(promptId, favorite) {
  try {
    const payload = await api(`/api/simple/prompts/${encodeURIComponent(promptId)}/favorite`, { method: 'POST', body: JSON.stringify({ favorite }) });
    const index = state.prompts.findIndex((entry) => entry.prompt_id === promptId);
    if (index >= 0) state.prompts[index] = payload.prompt;
    renderPromptHistory();
    renderIngredients();
  } catch (error) { toast(error.message, 'error'); }
}

async function deletePrompt(promptId) {
  try {
    await api(`/api/simple/prompts/${encodeURIComponent(promptId)}`, { method: 'DELETE' });
    state.prompts = state.prompts.filter((entry) => entry.prompt_id !== promptId);
    renderPromptHistory();
    renderIngredients();
  } catch (error) { toast(error.message, 'error'); }
}

function renderLaneCards() {
  $('#lane-grid').innerHTML = state.catalog.lanes.map((item, index) => `
    <button class="lane-card${item.id === state.selectedLane ? ' is-selected' : ''}" type="button" role="radio" aria-checked="${item.id === state.selectedLane}" data-lane="${esc(item.id)}">
      <span class="lane-number">${String(index + 1).padStart(2, '0')}</span>
      <b>${esc(item.label)}</b>
      <small>${esc(item.eyebrow)}</small>
    </button>`).join('');
}

function selectLane(laneId, { resetDefaults = true } = {}) {
  state.selectedLane = laneId;
  const selected = lane();
  if (!selected) return;
  if (resetDefaults) {
    $('#aspect-ratio').value = selected.default_aspect_ratio;
    $('#runtime-seconds').value = selected.default_runtime_seconds;
  }
  renderLaneCards();
  $('#lane-selection').textContent = selected.eyebrow;
  $('#launch-lane-mark').textContent = String(state.catalog.lanes.findIndex((item) => item.id === laneId) + 1).padStart(2, '0');
  $('#launch-lane-label').textContent = selected.label;
  $('#launch-lane-description').textContent = selected.description;
  $('#scene-editor-section').classList.toggle('is-hidden', !selected.supports.scenes);
  $('#voice-details').classList.toggle('is-hidden', !selected.supports.voice);
  $('#source-section').classList.toggle('is-hidden', !selected.supports.source);
  $('#source').required = selected.supports.source;
  $('#creator-field').classList.toggle('is-hidden', laneId !== 'clip');
  $('#source-heading').textContent = laneId === 'clip' ? 'Long-form source' : 'Existing media';
  $('#faceless-options').classList.toggle('is-hidden', !selected.supports.media_source);
  renderProviderSelectors();
  updateLaunchSummary();
}

function providerRolesForLane() {
  const rolesByLane = {
    'first-frame-animation-ad': ['script', 'image', 'motion', 'voice', 'assembly', 'publish'],
    'stickman-performance-ad': ['script', 'image', 'voice', 'assembly', 'publish'],
    'static-text-ad': ['script', 'image', 'publish'],
    animation: ['script', 'image', 'motion', 'voice', 'music', 'assembly', 'publish'],
    faceless: ['script', 'stock', 'voice', 'assembly', 'publish'],
    clip: ['clip', 'publish'],
    'social-post': ['publish'],
  };
  return rolesByLane[state.selectedLane] || [];
}

function renderProviderSelectors() {
  if (!state.catalog) return;
  const roles = providerRolesForLane();
  $('#provider-selectors').innerHTML = roles.map((role) => {
    const choices = state.catalog.providers_by_role[role] || [];
    return `<label class="field"><span>${esc(titleCase(role))}</span><select data-provider-role="${esc(role)}">
      <option value="">Automatic</option>
      ${choices.map((provider) => `<option value="${esc(provider.id)}">${esc(providerLabel(provider.id))}${provider.available ? ' · ready' : ''}</option>`).join('')}
    </select></label>`;
  }).join('') || '<p class="fine-print">This lane does not choose a generation provider.</p>';
}

function renderPlatforms() {
  $('#platform-grid').innerHTML = state.catalog.platforms.map((platform) => `
    <label class="platform-chip"><input type="checkbox" name="platform" value="${esc(platform)}" /><span>${esc(platform)}</span></label>`).join('');
}

function renderScenes() {
  $('#scene-list').innerHTML = state.scenes.map((scene, index) => `
    <article class="scene-card" data-scene-index="${index}">
      <div class="scene-main">
        <span class="scene-index">${String(index + 1).padStart(2, '0')}</span>
        <input class="scene-title" data-scene-field="title" value="${esc(scene.title)}" aria-label="Scene ${index + 1} title" placeholder="Scene title" />
        <input class="scene-beat" data-scene-field="beat" value="${esc(scene.beat)}" aria-label="Scene ${index + 1} visual beat" placeholder="What happens in this scene?" />
        <label class="scene-duration"><input data-scene-field="duration_seconds" type="number" min="0.5" max="300" step="0.5" value="${esc(scene.duration_seconds)}" aria-label="Scene ${index + 1} duration" /><span>sec</span></label>
        <button class="remove-scene" type="button" data-remove-scene="${index}" aria-label="Remove scene ${index + 1}">×</button>
      </div>
      <details class="scene-more">
        <summary>Scene copy and generation direction</summary>
        <div class="scene-more-fields">
          <label class="field"><span>On-screen copy</span><input data-scene-field="overlay" value="${esc(scene.overlay)}" /></label>
          <label class="field"><span>Voice line</span><input data-scene-field="voice" value="${esc(scene.voice)}" /></label>
          <label class="field"><span>Image direction</span><textarea data-scene-field="image_prompt" rows="2">${esc(scene.image_prompt)}</textarea></label>
          <label class="field"><span>Motion direction</span><textarea data-scene-field="motion_prompt" rows="2">${esc(scene.motion_prompt)}</textarea></label>
        </div>
      </details>
    </article>`).join('');
  updateLaunchSummary();
}

function updateScene(index, field, value) {
  if (!state.scenes[index]) return;
  state.scenes[index][field] = field === 'duration_seconds' ? Number(value) : value;
  updateLaunchSummary();
}

function updateLaunchSummary() {
  const selected = lane();
  $('#launch-aspect').textContent = $('#aspect-ratio').value || selected?.default_aspect_ratio || '—';
  $('#launch-runtime').textContent = `${$('#runtime-seconds').value || selected?.default_runtime_seconds || 0} sec`;
  $('#launch-scenes').textContent = selected?.supports.scenes ? String(state.scenes.length) : 'Auto';
  const budget = Number($('#max-cost').value || 0);
  $('#launch-budget').textContent = budget > 0 ? `$${budget.toFixed(2)} max` : '$0 local';
}

function collectProviders() {
  return Object.fromEntries($$('[data-provider-role]').map((select) => [select.dataset.providerRole, select.value]).filter(([, value]) => value));
}

function draftPayload() {
  const selected = lane();
  return {
    lane: state.selectedLane,
    title: $('#title').value.trim(),
    concept: $('#concept').value.trim(),
    audience: $('#audience').value.trim(),
    goal: $('#goal').value.trim(),
    tone: $('#tone').value.trim(),
    source: $('#source').value.trim(),
    creator: $('#creator').value.trim(),
    aspect_ratio: $('#aspect-ratio').value,
    runtime_seconds: Number($('#runtime-seconds').value || selected.default_runtime_seconds),
    privacy: $('#privacy').value,
    max_cost_usd: Number($('#max-cost').value || 0),
    scenes: selected.supports.scenes ? state.scenes : [],
    voice: {
      enabled: $('#voice-enabled').checked,
      provider: $('[data-provider-role="voice"]')?.value || 'universal-tts',
      delivery: $('#voice-delivery').value.trim(),
      voice_id: $('#voice-id').value.trim(),
    },
    subtitles: { enabled: $('#subtitles-enabled').checked, position: $('#subtitle-position').value, font_size: Number($('#subtitle-size').value) },
    providers: collectProviders(),
    publish: {
      platforms: $$('input[name="platform"]:checked').map((input) => input.value),
      caption: $('#publish-caption').value.trim(),
      cta: $('#publish-cta').value.trim(),
    },
    faceless: {
      media_source: $('#media-source').value,
      count: Number($('#video-count').value),
      clip_duration_seconds: Number($('#clip-duration').value),
    },
  };
}

async function createRun(event) {
  event.preventDefault();
  const button = $('#create-run-button');
  const original = button.innerHTML;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = '<span>Creating…</span><i class="spinner" aria-hidden="true"></i>';
  try {
    const run = await api('/api/runs', { method: 'POST', body: JSON.stringify(draftPayload()) });
    await loadRuns();
    state.selectedRunId = run.run_id;
    renderRecentRun();
    toast('Production created. The first bounded action is ready.');
    navigate('runs');
    renderRuns();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.innerHTML = original;
  }
}

async function loadRuns() {
  const payload = await api('/api/runs');
  state.runs = payload.runs;
  $('#run-count').textContent = state.runs.length;
  renderRecentRun();
  refreshSimpleRunGenerationCards();
}

function runTitle(run) {
  return run.brief?.title || run.brief?.subject || run.run_id;
}

function renderRecentRun() {
  const recent = state.runs[0];
  $('#recent-run-card').innerHTML = recent ? `<button type="button" data-open-run="${esc(recent.run_id)}"><p class="section-kicker">Latest run</p><b>${esc(runTitle(recent))}</b><small>${esc(titleCase(recent.lane))} · ${esc(titleCase(recent.status))}</small></button>` : '<p class="section-kicker">Latest run</p><b>No productions yet</b><small>Your first run will appear here.</small>';
}

function filteredRuns() {
  if (!state.statusFilter) return state.runs;
  if (state.statusFilter === 'completed') return state.runs.filter((run) => run.status === 'completed');
  return state.runs.filter((run) => !['completed', 'cancelled', 'failed'].includes(run.status));
}

function renderRuns() {
  const runs = filteredRuns();
  $('#run-list').innerHTML = runs.length ? runs.map((run) => `
    <button class="run-card${run.run_id === state.selectedRunId ? ' is-selected' : ''}" type="button" data-open-run="${esc(run.run_id)}">
      <b>${esc(runTitle(run))}</b><span class="status-pill" data-status="${esc(run.status)}">${esc(titleCase(run.status))}</span>
      <small>${esc(titleCase(run.lane))} · ${esc(run.current_step ? `step: ${run.current_step}` : 'complete')}</small>
    </button>`).join('') : '<div class="empty-detail"><span>◫</span><b>No matching runs</b><small>Create a production or change the filter.</small></div>';
  const selected = state.runs.find((run) => run.run_id === state.selectedRunId);
  renderRunDetail(selected);
}

function artifactPreview(run, artifact) {
  const url = `/api/runs/${encodeURIComponent(run.run_id)}/artifacts/${encodeURIComponent(artifact.id)}`;
  if (artifact.mime_type?.startsWith('image/')) return `<img class="artifact-preview" src="${url}" alt="${esc(artifact.role)} preview" loading="lazy" />`;
  if (artifact.mime_type?.startsWith('video/')) return `<video class="artifact-preview" src="${url}" muted controls preload="metadata"></video>`;
  if (artifact.mime_type?.startsWith('audio/')) return `<audio class="artifact-preview" src="${url}" controls preload="metadata"></audio>`;
  return '';
}

function renderRunDetail(run) {
  if (!run) {
    $('#run-detail').innerHTML = '<div class="empty-detail"><span>◫</span><b>Select a run</b><small>Inspect its scenes, steps, artifacts, and next action.</small></div>';
    return;
  }
  const action = run.next_actions?.[0];
  $('#run-detail').innerHTML = `
    <div class="detail-head"><div><p class="section-kicker">${esc(titleCase(run.lane))}</p><h3>${esc(runTitle(run))}</h3></div><span class="status-pill" data-status="${esc(run.status)}">${esc(titleCase(run.status))}</span></div>
    ${action ? `<section class="detail-section"><h4>Next action</h4><div class="next-action"><b>${esc(titleCase(action.intent))}</b><small>${esc(action.reason)}</small></div></section>` : ''}
    <section class="detail-section"><h4>Workflow</h4><div class="step-list">${run.steps.map((step) => `<div class="step-row" data-status="${esc(step.status)}"><i></i><span>${esc(titleCase(step.step_id))}</span><small>${esc(titleCase(step.status))}</small></div>`).join('')}</div></section>
    <section class="detail-section"><h4>Artifacts</h4><div class="artifact-grid">${run.artifact_records.length ? run.artifact_records.map((artifact) => { const url = `/api/runs/${encodeURIComponent(run.run_id)}/artifacts/${encodeURIComponent(artifact.id)}`; return `<a class="artifact-card" href="${url}" target="_blank" rel="noreferrer">${artifactPreview(run, artifact)}<b>${esc(titleCase(artifact.role))}</b><small>${esc(artifact.provider || 'studio')} · ${Math.max(1, Math.round((artifact.size_bytes || 0) / 1024))} KB</small></a>`; }).join('') : '<small>No artifacts yet.</small>'}</div></section>
    <section class="detail-section"><h4>Actions</h4><div class="detail-actions"><button type="button" data-use-run-in-composer="${esc(run.run_id)}">Use prompt &amp; settings</button><button type="button" data-duplicate-run="${esc(run.run_id)}">Duplicate &amp; edit</button>${run.current_step ? `<button type="button" data-run-action="resume" data-run-id="${esc(run.run_id)}">Resume</button><button type="button" data-run-action="retry" data-run-id="${esc(run.run_id)}" data-step-id="${esc(run.current_step)}">Retry step</button>` : ''}${!['completed','cancelled'].includes(run.status) ? `<button class="danger" type="button" data-run-action="cancel" data-run-id="${esc(run.run_id)}">Cancel</button>` : ''}</div></section>`;
}

function duplicateRun(runId) {
  const run = state.runs.find((item) => item.run_id === runId);
  if (!run) return;
  const brief = run.brief || {};
  $('#title').value = `${brief.title || runTitle(run)} — variant`;
  $('#concept').value = brief.concept || '';
  $('#audience').value = brief.audience || '';
  $('#goal').value = brief.goal || '';
  $('#tone').value = brief.tone || '';
  $('#source').value = brief.source || '';
  state.scenes = (brief.scenes || []).map((scene) => ({ title: scene.title || '', beat: scene.beat || '', overlay: scene.overlay || '', voice: scene.voice || '', duration_seconds: scene.duration_seconds || 4, image_prompt: scene.image_prompt || '', motion_prompt: scene.motion_prompt || '' }));
  if (!state.scenes.length) state.scenes = [{ title: 'Opening', beat: brief.concept || brief.title || '', overlay: '', voice: '', duration_seconds: 4, image_prompt: '', motion_prompt: '' }];
  selectLane(run.lane, { resetDefaults: false });
  $('#aspect-ratio').value = brief.aspect_ratio || lane().default_aspect_ratio;
  $('#runtime-seconds').value = brief.runtime_seconds || lane().default_runtime_seconds;
  $('#privacy').value = run.policy?.privacy || 'local-first';
  $('#max-cost').value = run.cost?.max_cost_usd || 0;
  $('#voice-enabled').checked = brief.voice?.enabled !== false;
  $('#voice-delivery').value = brief.voice?.delivery || '';
  $('#voice-id').value = brief.voice?.voice_id || '';
  $('#subtitles-enabled').checked = brief.subtitles?.enabled !== false;
  $('#subtitle-position').value = brief.subtitles?.position || 'bottom';
  $('#subtitle-size').value = brief.subtitles?.font_size || 56;
  $('#media-source').value = brief.media_source || 'pexels';
  $('#video-count').value = String(brief.count || 1);
  $('#clip-duration').value = String(brief.clip_duration_seconds || 5);
  const publish = run.publish || brief.publish || {};
  $('#publish-caption').value = publish.caption || '';
  $('#publish-cta').value = publish.cta || '';
  $$('input[name="platform"]').forEach((input) => { input.checked = (publish.platforms || []).includes(input.value); });
  Object.entries(run.providers || brief.providers || {}).forEach(([role, provider]) => {
    const selector = $(`[data-provider-role="${role}"]`);
    if (selector) selector.value = provider;
  });
  renderScenes();
  selectNativeStudioMode('workflow');
  navigate('create');
  $('#title').focus();
  toast('Loaded as a new editable variant. The original run stays immutable.');
}

function authHeaders() {
  state.operatorToken = $('#operator-token').value;
  return state.operatorToken ? { Authorization: `Bearer ${state.operatorToken}` } : {};
}

async function runAction(action, runId, stepId) {
  if (!$('#operator-token').value) {
    $('#operator-details').open = true;
    $('#operator-token').focus();
    toast('Enter the operator token under Advanced to use protected run controls.', 'error');
    return;
  }
  try {
    const path = action === 'retry' ? `/api/runs/${encodeURIComponent(runId)}/retry` : `/api/runs/${encodeURIComponent(runId)}/${action}`;
    const body = action === 'retry' ? { step_id: stepId } : action === 'cancel' ? { reason: 'Cancelled from Content Studio' } : undefined;
    const run = await api(path, { method: 'POST', headers: authHeaders(), ...(body ? { body: JSON.stringify(body) } : {}) });
    await loadRuns();
    state.selectedRunId = run.run_id;
    renderRuns();
    toast(`${titleCase(action)} completed.`);
  } catch (error) { toast(error.message, 'error'); }
}

function renderProviders() {
  if (!state.catalog) return;
  const providers = Object.values(state.catalog.providers_by_role).flat();
  const unique = [...new Map(providers.map((provider) => [provider.id, provider])).values()];
  $('#provider-board').innerHTML = unique.map((provider) => `
    <article class="provider-card">
      <div class="provider-card-head"><h3>${esc(providerLabel(provider.id))}</h3><i class="provider-ready${provider.available ? ' is-ready' : ''}" title="${provider.available ? 'Ready' : 'Needs setup'}"></i></div>
      <p>${esc(provider.detail || provider.requirement)}</p>
      <div class="role-list">${provider.roles.map((role) => `<span>${esc(role)}</span>`).join('')}</div>
      <div class="provider-cost">${esc(provider.mode)} · ${esc(provider.cost)}</div>
    </article>`).join('');
  renderOAuth();
}

function renderOAuth() {
  const providers = state.oauth?.providers || {};
  const cards = [
    {
      id: 'openai',
      label: 'OpenAI',
      ready: Boolean(providers.openai?.connected),
      needsReconnect: false,
      detail: providers.openai?.detail || 'Checking the HivemindOS OpenAI OAuth session…',
      note: 'GPT Image OAuth uses the Codex Responses image tool. The official Image API remains a separate OPENAI_API_KEY provider.',
    },
    {
      id: 'xai',
      label: 'xAI',
      ready: Boolean(providers.xai?.usable),
      needsReconnect: Boolean(providers.xai?.needs_reconnect),
      detail: providers.xai?.detail || 'Checking the HivemindOS xAI OAuth session…',
      note: 'A usable api:access session enables Grok Imagine image and video generation.',
    },
  ];
  $('#oauth-board').innerHTML = cards.map((card) => `
    <article class="oauth-card">
      <div class="oauth-card-head"><h4>${esc(card.label)}</h4><span class="oauth-status${card.ready ? ' is-ready' : ''}"><i></i>${card.ready ? 'Connected' : 'Needs setup'}</span></div>
      <p>${esc(card.detail)}<br>${esc(card.note)}</p>
      <button class="oauth-button" type="button" data-oauth-provider="${esc(card.id)}">${card.ready || card.needsReconnect ? `Reconnect ${esc(card.label)}` : `Connect ${esc(card.label)}`}</button>
    </article>`).join('');
}

async function loadOAuth() {
  state.oauth = await api('/api/oauth');
  renderOAuth();
}

async function startOAuth(provider, button) {
  const original = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = '<i class="spinner" aria-hidden="true"></i><span>Opening sign in…</span>';
  try {
    const result = await api(`/api/oauth/${provider}/start`, { method: 'POST' });
    window.open(result.authorize_url, '_blank', 'noopener,noreferrer');
    toast(`Finish ${providerLabel(provider)} sign in in the new tab, then refresh provider status.`);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = original;
  }
}

function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.viewTarget)));
  $('#native-studio-modes').addEventListener('click', (event) => { const button = event.target.closest('[data-studio-mode]'); if (button) selectNativeStudioMode(button.dataset.studioMode); });
  $('#simple-composer').addEventListener('submit', submitSimplePrompt);
  $('#simple-attach').addEventListener('click', () => $('#simple-image-input').click());
  $('#simple-image-input').addEventListener('change', (event) => { addSimpleImages(event.target.files); event.target.value = ''; });
  const composer = $('#simple-composer');
  let dragDepth = 0;
  composer.addEventListener('dragenter', (event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth += 1; composer.classList.add('is-dropping'); } });
  composer.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
  composer.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) composer.classList.remove('is-dropping'); });
  composer.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    composer.classList.remove('is-dropping');
    if (event.dataTransfer?.files?.length) addSimpleImages(event.dataTransfer.files);
  });
  $('#ingredients-menu').addEventListener('click', (event) => {
    const button = event.target.closest('[data-insert-prompt]');
    if (!button) return;
    const entry = state.prompts.find((item) => item.prompt_id === button.dataset.insertPrompt);
    if (entry) insertPromptIntoComposer(entry.prompt);
    $('#simple-ingredients').open = false;
  });
  $('#templates-menu').addEventListener('click', (event) => {
    const button = event.target.closest('[data-insert-template]');
    if (!button) return;
    const entry = (state.simpleCatalog?.templates || []).find((item) => item.id === button.dataset.insertTemplate);
    if (entry) insertPromptIntoComposer(entry.prompt);
    $('#simple-templates').open = false;
  });
  $('#simple-ingredients').addEventListener('toggle', () => { if ($('#simple-ingredients').open) void loadPrompts({ quiet: true }); });
  $('#history-filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-history-filter]');
    if (!button) return;
    $$('[data-history-filter]').forEach((item) => item.classList.toggle('is-active', item === button));
    state.historyFilter = button.dataset.historyFilter;
    renderPromptHistory();
  });
  $('#prompt-history-list').addEventListener('click', (event) => {
    const favorite = event.target.closest('[data-favorite-prompt]');
    if (favorite) { void setPromptFavorite(favorite.dataset.favoritePrompt, favorite.dataset.favoriteNext === 'true'); return; }
    const use = event.target.closest('[data-use-prompt]');
    if (use) {
      const entry = state.prompts.find((item) => item.prompt_id === use.dataset.usePrompt);
      if (entry?.run_id && loadRunIntoSimpleComposer(entry.run_id)) return;
      if (entry) insertPromptIntoComposer(entry.user_prompt || entry.prompt);
      return;
    }
    const remove = event.target.closest('[data-delete-prompt]');
    if (remove) void deletePrompt(remove.dataset.deletePrompt);
  });
  $('#simple-attachments').addEventListener('click', (event) => { const button = event.target.closest('[data-remove-simple-image]'); if (button) removeSimpleImage(Number(button.dataset.removeSimpleImage)); });
  $('#simple-composer').addEventListener('click', (event) => {
    if (event.target.closest('.route-picker')) event.stopPropagation();
    const trigger = event.target.closest('[data-route-trigger]');
    if (trigger) { openRoutePicker(trigger.dataset.routeTrigger); return; }
    const provider = event.target.closest('[data-provider-toggle]');
    if (provider) {
      const kind = provider.dataset.providerToggle;
      const key = provider.dataset.providerKey;
      state.routePickerExpanded[kind][key] = !state.routePickerExpanded[kind][key];
      renderRoutePicker(kind);
      return;
    }
    const choice = event.target.closest('[data-route-choice]');
    if (choice) { setRoutePickerValue(choice.dataset.routeChoice, choice.dataset.routeValue); return; }
    const automatic = event.target.closest('[data-route-automatic]');
    if (automatic) setRoutePickerValue(automatic.dataset.routeAutomatic, 'automatic');
  });
  $$('[data-route-search]').forEach((search) => {
    search.addEventListener('input', () => {
      const kind = search.dataset.routeSearch;
      state.routePickerQuery[kind] = search.value;
      renderRoutePicker(kind);
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.preventDefault();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        $(`[data-route-list="${search.dataset.routeSearch}"] button:not(:disabled)`)?.focus();
      }
    });
  });
  document.addEventListener('click', (event) => { if (state.routePickerOpen && !event.target.closest('.route-picker')) closeRoutePickers(); });
  document.addEventListener('click', (event) => {
    const close = event.target.closest('[data-close-generation-preview]');
    if (close || event.target.classList?.contains('application-generation-preview')) event.target.closest('.application-generation-preview')?.remove();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.routePickerOpen) closeRoutePickers({ restoreFocus: true });
      document.querySelector('.application-generation-preview')?.remove();
    }
  });
  $('#simple-thread').addEventListener('click', (event) => {
    const preview = event.target.closest('[data-generation-preview]');
    if (preview) { openGenerationPreview(preview.dataset.generationPreview); return; }
    const confirm = event.target.closest('[data-confirm-simple-plan]');
    if (confirm && state.simplePlan) { confirm.disabled = true; void createSimpleRun(state.simplePlan); }
    const open = event.target.closest('[data-open-simple-run]');
    if (open) { state.selectedRunId = open.dataset.openSimpleRun; navigate('runs'); }
  });
  $('#refresh-button').addEventListener('click', refreshAll);
  $('#create-run-form').addEventListener('submit', createRun);
  $('#add-scene-button').addEventListener('click', () => { state.scenes.push({ title: `Scene ${state.scenes.length + 1}`, beat: '', overlay: '', voice: '', duration_seconds: 4, image_prompt: '', motion_prompt: '' }); renderScenes(); });
  $('#lane-grid').addEventListener('click', (event) => { const button = event.target.closest('[data-lane]'); if (button) selectLane(button.dataset.lane); });
  $('#scene-list').addEventListener('input', (event) => { const card = event.target.closest('[data-scene-index]'); if (card && event.target.dataset.sceneField) updateScene(Number(card.dataset.sceneIndex), event.target.dataset.sceneField, event.target.value); });
  $('#scene-list').addEventListener('click', (event) => { const button = event.target.closest('[data-remove-scene]'); if (!button || state.scenes.length === 1) return; state.scenes.splice(Number(button.dataset.removeScene), 1); renderScenes(); });
  ['aspect-ratio', 'runtime-seconds', 'max-cost'].forEach((id) => $(`#${id}`).addEventListener('input', updateLaunchSummary));
  $('#run-list').addEventListener('click', (event) => { const button = event.target.closest('[data-open-run]'); if (button) { state.selectedRunId = button.dataset.openRun; renderRuns(); } });
  $('#recent-run-card').addEventListener('click', (event) => { const button = event.target.closest('[data-open-run]'); if (button) { state.selectedRunId = button.dataset.openRun; navigate('runs'); } });
  $('#run-detail').addEventListener('click', (event) => {
    const use = event.target.closest('[data-use-run-in-composer]');
    if (use) { loadRunIntoSimpleComposer(use.dataset.useRunInComposer); return; }
    const duplicate = event.target.closest('[data-duplicate-run]');
    if (duplicate) duplicateRun(duplicate.dataset.duplicateRun);
    const action = event.target.closest('[data-run-action]');
    if (action) runAction(action.dataset.runAction, action.dataset.runId, action.dataset.stepId);
  });
  $('#run-filters').addEventListener('click', (event) => { const button = event.target.closest('[data-status-filter]'); if (!button) return; $$('[data-status-filter]').forEach((item) => item.classList.toggle('is-active', item === button)); state.statusFilter = button.dataset.statusFilter; renderRuns(); });
  $('#oauth-board').addEventListener('click', (event) => { const button = event.target.closest('[data-oauth-provider]'); if (button) startOAuth(button.dataset.oauthProvider, button); });
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll({ quiet: true }); });
}

async function refreshAll({ quiet = false } = {}) {
  $('#refresh-button').setAttribute('aria-busy', 'true');
  try {
    if (!state.catalog || !quiet) state.catalog = await api('/api/catalog');
    if (!state.oauth || !quiet) await loadOAuth();
    await Promise.all([loadRuns(), loadGenerationTelemetry({ quiet: true })]);
    $('#api-status').className = 'api-status is-online';
    $('#api-status').innerHTML = '<i></i>Local API ready';
    const providerCount = Object.values(state.catalog.providers_by_role).flat().filter((provider) => provider.available).length;
    $('#provider-health').classList.toggle('is-ready', providerCount > 0);
    renderRuns();
    renderProviders();
    if (!quiet) renderRecentRun();
  } catch (error) {
    $('#api-status').className = 'api-status is-offline';
    $('#api-status').innerHTML = '<i></i>API unavailable';
    if (!quiet) toast(error.message, 'error');
  } finally { $('#refresh-button').removeAttribute('aria-busy'); }
}

async function boot() {
  bindEvents();
  try {
    [state.catalog, state.simpleCatalog] = await Promise.all([api('/api/catalog'), api('/api/simple/catalog')]);
    await loadOAuth();
    $('#aspect-ratio').innerHTML = state.catalog.aspect_ratios.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
    $('#privacy').innerHTML = state.catalog.privacy_modes.map((value) => `<option value="${esc(value)}">${esc(titleCase(value))}</option>`).join('');
    renderPlatforms();
    renderBrainSelector();
    renderMediaSelector('image');
    renderMediaSelector('video');
    renderTemplates();
    updateCapabilityNote();
    selectNativeStudioMode('create');
    state.selectedLane = state.catalog.lanes[0].id;
    selectLane(state.selectedLane);
    renderScenes();
    await refreshAll({ quiet: true });
    await loadPrompts({ quiet: true });
    restoreLatestRunInComposer();
    navigate(location.hash.slice(1) || 'create');
  } catch (error) {
    $('#api-status').className = 'api-status is-offline';
    $('#api-status').innerHTML = '<i></i>API unavailable';
    toast(error.message, 'error');
  }
  setInterval(() => { if (!document.hidden) refreshAll({ quiet: true }); }, 10000);
  setInterval(() => {
    if (!document.hidden && document.querySelector('.application-generation-card[data-status="running"]')) refreshSimpleRunGenerationCards();
  }, 1000);
}

boot();
