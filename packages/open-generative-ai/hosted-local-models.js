const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'];

/* ── Installed-ness, per workflow ──────────────────────────────────────────
 *
 * A registry entry describes a graph; it is not proof the weights are on disk.
 * The studio used to list every entry as runnable, so "no model installed" and
 * "four models installed" looked identical — and the first Generate was where
 * the difference showed up.
 *
 * Only the graph-shipping lanes can be checked from here: `comfy-api-image`
 * and the auto-detected drop-ins name their checkpoints IN the graph, so those
 * names resolve against ComfyUI's models directory. The Python-builder lanes
 * choose their checkpoint server-side, so this reports nothing missing for
 * them rather than guessing a filename and hiding a workflow that works.
 */
const WEIGHT_INPUT_KEYS = /^(ckpt_name|unet_name|model_name|checkpoint_name|diffusion_model)$/i;
const WEIGHT_SUFFIX = /\.(safetensors|ckpt|gguf|sft|pt|pth)$/i;
const WEIGHT_DIR_SCAN_DEPTH = 2;
const WEIGHT_INDEX_TTL_MS = 5000;

function comfyModelsRoot() {
  const explicit = String(process.env.COMFY_MODELS_DIR || '').trim();
  if (explicit) return explicit;
  return path.join(process.env.COMFY_DIR || path.join(os.homedir(), 'comfy/ComfyUI'), 'models');
}

let weightIndex = { root: '', at: 0, names: null };

// Basenames of every weight file under the models root, one bounded walk,
// cached for five seconds so a page full of model rows is one scan and not one
// stat per checkpoint per request.
function installedWeightNames(root = comfyModelsRoot()) {
  const now = Date.now();
  if (weightIndex.root === root && now - weightIndex.at < WEIGHT_INDEX_TTL_MS) return weightIndex.names;
  let names = null;                                   // null = could not look
  try {
    if (fs.statSync(root).isDirectory()) {
      names = new Set();
      const walk = (dir, depth) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          if (entry.isDirectory()) {
            if (depth < WEIGHT_DIR_SCAN_DEPTH) walk(path.join(dir, entry.name), depth + 1);
          } else if (WEIGHT_SUFFIX.test(entry.name)) {
            names.add(entry.name.toLowerCase());
          }
        }
      };
      walk(root, 0);
    }
  } catch {
    names = null;
  }
  weightIndex = { root, at: now, names };
  return names;
}

/** Weight filenames an API-format graph loads, deduplicated. */
function graphWeightFiles(workflowFile) {
  let graph;
  try {
    const data = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
    graph = data && typeof data === 'object' && !Array.isArray(data) && data.prompt && typeof data.prompt === 'object'
      ? data.prompt
      : data;
  } catch {
    return [];
  }
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return [];
  const files = new Set();
  for (const node of Object.values(graph)) {
    const inputs = (node && node.inputs) || {};
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value !== 'string' || !WEIGHT_INPUT_KEYS.test(key)) continue;
      if (!WEIGHT_SUFFIX.test(value)) continue;
      files.add(path.basename(value));
    }
  }
  return [...files];
}

/**
 * Which of a workflow's weights are not on this machine.
 *
 * Empty means "nothing known to be missing" — which is also the answer when
 * there is no graph to read or no models directory to read it against. A model
 * is only ever reported unready on positive evidence.
 */
function missingWeightFiles(workflowFile, root = comfyModelsRoot()) {
  if (!workflowFile) return [];
  const installed = installedWeightNames(root);
  if (!installed) return [];
  const wanted = graphWeightFiles(workflowFile);
  if (!wanted.length) return [];
  return wanted.filter((file) => !installed.has(file.toLowerCase()));
}

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
    // Two reference grammars, one capability: the single-source image_* fields
    // and `reference_images`, the ordered multi-slot shape H3 speaks. Mirrored
    // by IMAGE_INPUT_FIELDS in src/lib/localImageModelFilter.js.
    supportsImage: accepts.some((field) => ['image_path', 'image_base64', 'image_url', 'reference_images'].includes(field)),
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
  comfyModelsRoot,
  graphWeightFiles,
  missingWeightFiles,
  loadHostedImageModels,
  loadHostedWorkflowModels,
  normalizePromptHelper,
  toHostedImageModel,
};
