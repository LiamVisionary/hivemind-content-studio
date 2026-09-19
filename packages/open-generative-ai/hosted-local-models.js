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

// `routing_only` is never inherited. It says THIS row is not a lane — a
// shared-weights declaration, or a tier reached only by routing — and that is
// not a property a lane built on those weights takes on. Inherited, it marked
// every Klein lane that shares the 9B download unpickable, which no picker
// noticed only because the image path happens not to read the flag.
const NOT_INHERITED = new Set(['routing_only']);

function mergeWorkflowDefinition(base, override) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return structuredClone(override);
  if (!override || typeof override !== 'object' || Array.isArray(override)) return structuredClone(override);
  const out = structuredClone(base);
  NOT_INHERITED.forEach((key) => { delete out[key]; });
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
    // A lane driven by its own button rather than by the model picker — the
    // Klein direction tools steer a picture that already exists, from a dialog
    // that opens on that picture. It still has to be LISTED, because that is
    // how the button finds the lane; it just must not be offered as a model to
    // generate with, which is what put "Klein Sun Direction" in the picker.
    actionOnly: Boolean(workflow.action_only),
    actionLabel: String(workflow.action_label || ''),
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

// Music lanes. Unlike an image lane there is only one shape: a ready
// API-format graph driven entirely by the registry's `slots` map, because an
// audio graph has no skeleton to infer from — no dimensions, a duration that
// lives in two nodes at once, and a "prompt" that is a style-tag list sitting
// beside a separate lyrics field. Everything the composer needs to render its
// controls therefore comes from the registry row rather than from the graph.
// Which music model leads is a PRODUCT decision, not an accident of the order
// rows were appended to workflow-registry.json. ACE-Step 1.5 goes first because
// it is the default, it is faster, and its code and weights are both MIT, so a
// track made with it can be sold; YuE2 follows because its weights are CC BY-NC.
// Sorting here rather than in the studio means every surface that lists music
// models agrees, and a third model added later lands in a defined place instead
// of wherever it happened to be typed.
function audioModelRank(workflow) {
  const licence = workflow.license || {};
  return [
    workflow.default ? 0 : 1,
    workflow.featured ? 0 : 1,
    licence.commercial === false ? 1 : 0,
    String(workflow.title || workflow.id || ''),
  ];
}

function byAudioRank(a, b) {
  const left = audioModelRank(a);
  const right = audioModelRank(b);
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}

function loadHostedAudioModels(registryPath) {
  const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const workflowsDir = path.join(path.dirname(registryPath), 'workflows');
  return registryItems(data)
    .filter((workflow) => workflow && workflow.media_type === 'audio' && workflow.builder === 'comfy-api-audio')
    .sort(byAudioRank)
    .map((workflow) => {
      const defaults = workflow.defaults || {};
      const accepts = Array.isArray(workflow.accepts) ? workflow.accepts : [];
      const lyricsFormat = accepts.includes('lyrics') && workflow.lyrics_format === 'section-plan'
        ? 'section-plan'
        : 'lyrics';
      return {
        id: workflow.id,
        name: workflow.title || workflow.id,
        description: workflow.description || '',
        type: 'audio',
        family: workflow.family || 'local-audio',
        provider: 'hosted-media-studio',
        state: 'downloaded',
        backend: 'comfy-api-audio',
        // The gateway resolves the graph from an allowed root, and without an
        // absolute path it would look relative to its own cwd.
        workflowFile: path.isAbsolute(String(workflow.workflow_file || ''))
          ? String(workflow.workflow_file)
          : path.join(workflowsDir, String(workflow.workflow_file || '')),
        requires: workflow.requires || { prompt: true, image: false },
        accepts,
        // Whether this model actually sings, rather than only playing. It
        // decides if the composer offers a lyrics box at all. A lane can take
        // the lyrics FIELD without taking words: the instrumental YuE2 lane
        // reads a section plan there, and a lyrics box over it would invite
        // exactly the text its LoRA was never trained on.
        lyricsFormat,
        supportsLyrics: accepts.includes('lyrics') && lyricsFormat === 'lyrics',
        sectionTags: Array.isArray(workflow.section_tags) ? workflow.section_tags.map(String) : [],
        defaults: {
          seconds: Number(defaults.seconds || 60),
          bpm: Number(defaults.bpm || 120),
          timesignature: String(defaults.timesignature || '4'),
          language: String(defaults.language || 'en'),
          keyscale: String(defaults.keyscale || 'C major'),
          steps: Number(defaults.steps || 8),
          cfg: Number(defaults.cfg == null ? 1 : defaults.cfg),
          seed: Number(defaults.seed == null ? -1 : defaults.seed),
          samplerName: String(defaults.sampler_name || ''),
          scheduler: String(defaults.scheduler || ''),
          generateAudioCodes: defaults.generate_audio_codes !== false,
          mode: String(defaults.mode || ''),
        },
        limits: workflow.limits || {},
        // The choices behind the `mode` token. Without them the composer renders
        // a token whose menu opens empty - which is what YuE2 shipped with.
        modes: Array.isArray(workflow.modes)
          ? workflow.modes.filter((row) => row && row.id).map((row) => ({ id: String(row.id), label: String(row.label || row.id) }))
          : [],
        samplers: Array.isArray(workflow.samplers) ? workflow.samplers.map(String) : [],
        schedulers: Array.isArray(workflow.schedulers) ? workflow.schedulers.map(String) : [],
        // Surfaced so the studio can say plainly whether a track may be sold,
        // rather than leaving the user to find out later.
        license: workflow.license || null,
        benchmarkSeconds: Number(workflow.benchmark_seconds || 0),
        tags: Array.isArray(workflow.tags) ? workflow.tags : [],
        featured: Boolean(workflow.featured),
        isDefault: Boolean(workflow.default),
      };
    });
}

module.exports = {
  DEFAULT_ASPECT_RATIOS,
  comfyModelsRoot,
  graphWeightFiles,
  missingWeightFiles,
  loadHostedAudioModels,
  loadHostedImageModels,
  loadHostedWorkflowModels,
  normalizePromptHelper,
  toHostedImageModel,
};
