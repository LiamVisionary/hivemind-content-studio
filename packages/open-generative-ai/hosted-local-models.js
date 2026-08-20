const fs = require('fs');
const path = require('path');

const DEFAULT_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'];

function mergeWorkflowDefinition(base, override) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return structuredClone(override);
  if (!override || typeof override !== 'object' || Array.isArray(override)) return structuredClone(override);
  const out = structuredClone(base);
  Object.entries(override).forEach(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeWorkflowDefinition(out[key], value);
    } else {
      out[key] = structuredClone(value);
    }
  });
  return out;
}

function registryItems(data) {
  const items = Array.isArray(data)
    ? data
    : (Array.isArray(data?.workflows) ? data.workflows : Object.values(data?.workflows || {}));
  const definitions = new Map(items
    .filter((item) => item && typeof item === 'object' && String(item.id || '').trim())
    .map((item) => [String(item.id).trim(), item]));
  const resolved = new Map();
  const resolving = new Set();
  const resolveDefinition = (id) => {
    if (resolved.has(id)) return resolved.get(id);
    const item = definitions.get(id);
    if (!item) throw new Error(`workflow ${id} was not found in the registry`);
    if (resolving.has(id)) throw new Error(`workflow inheritance cycle detected at ${id}`);
    resolving.add(id);
    const parentId = String(item.inherits || '').trim();
    const workflow = parentId
      ? mergeWorkflowDefinition(resolveDefinition(parentId), item)
      : structuredClone(item);
    delete workflow.inherits;
    resolving.delete(id);
    resolved.set(id, workflow);
    return workflow;
  };
  return [...definitions.keys()].map(resolveDefinition);
}

function normalizePromptHelper(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const profile = String(value.profile || '').trim();
  if (!profile) return null;
  return {
    profile,
    label: String(value.label || 'Prompt helper').trim() || 'Prompt helper',
    helperMode: String(value.helper_mode || 'None').trim() || 'None',
    timeoutSeconds: Math.max(1, Math.min(180, Number(value.timeout_seconds || 60))),
  };
}

function toHostedImageModel(workflow) {
  const defaults = workflow.defaults || {};
  const accepts = Array.isArray(workflow.accepts) ? workflow.accepts : [];
  return {
    id: workflow.id,
    name: workflow.title || workflow.id,
    description: workflow.description || '',
    type: 'image',
    family: workflow.family || 'local-image',
    provider: 'hosted-media-studio',
    state: 'downloaded',
    backend: workflow.backend || '',
    supportsLoras: Boolean(workflow.supports_loras),
    compatibleBaseModels: Array.isArray(workflow.compatible_base_models) ? workflow.compatible_base_models : [],
    promptHelper: normalizePromptHelper(workflow.prompt_helper),
    requires: workflow.requires || { prompt: true, image: false },
    accepts,
    supportsImage: accepts.some((field) => ['image_path', 'image_base64', 'image_url'].includes(field)),
    maxReferenceImages: Number(workflow.max_reference_images || 0),
    aspectRatios: Array.isArray(workflow.aspect_ratios) && workflow.aspect_ratios.length
      ? workflow.aspect_ratios
      : DEFAULT_ASPECT_RATIOS,
    // Sampler/scheduler are opt-in per workflow: only the graphs that actually
    // read them advertise a list, and the studio only shows the control then.
    samplers: Array.isArray(workflow.samplers) ? workflow.samplers.map(String) : [],
    schedulers: Array.isArray(workflow.schedulers) ? workflow.schedulers.map(String) : [],
    defaultWidth: Number(defaults.width || 1024),
    defaultHeight: Number(defaults.height || 1024),
    defaultSteps: Number(defaults.steps || 8),
    defaultGuidance: Number(defaults.cfg ?? defaults.guidance ?? 1),
    tags: Array.isArray(workflow.tags) ? workflow.tags : ['local'],
    featured: Boolean(workflow.featured),
  };
}

function loadHostedWorkflowModels(registryPath) {
  const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  return registryItems(data).filter((workflow) => workflow && workflow.id).map((workflow) => ({
    id: workflow.id,
    name: workflow.title || workflow.id,
    mediaType: workflow.media_type || '',
    family: workflow.family || '',
    supportsLoras: Boolean(workflow.supports_loras),
    compatibleBaseModels: Array.isArray(workflow.compatible_base_models) ? workflow.compatible_base_models : [],
    promptHelper: normalizePromptHelper(workflow.prompt_helper),
  }));
}

// Registry image lanes come in two shapes. `image-backend` is a Python builder
// that assembles the graph server-side. `comfy-api-image` is a ready API-format
// ComfyUI graph shipped beside the registry — the same thing auto-workflow
// discovery exposes for user drop-ins, except registered rather than found, so
// it can carry a title, capabilities and reference slots instead of being
// inferred from the file. Both end up as one image model in /local-ai/models.
function loadHostedImageModels(registryPath) {
  const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const workflowsDir = path.join(path.dirname(registryPath), 'workflows');
  return registryItems(data)
    .filter((workflow) => workflow && workflow.media_type === 'image'
      && (workflow.builder === 'image-backend' || workflow.builder === 'comfy-api-image'))
    .map((workflow) => {
      const model = toHostedImageModel(workflow);
      if (workflow.builder !== 'comfy-api-image') return model;
      // run_comfy_api_image executes the graph named here; without an absolute
      // path the gateway would look for it relative to its own cwd.
      model.backend = 'comfy-api-image';
      model.workflowFile = path.isAbsolute(String(workflow.workflow_file || ''))
        ? String(workflow.workflow_file)
        : path.join(workflowsDir, String(workflow.workflow_file || ''));
      return model;
    });
}

module.exports = {
  DEFAULT_ASPECT_RATIOS,
  loadHostedImageModels,
  loadHostedWorkflowModels,
  normalizePromptHelper,
  toHostedImageModel,
};
