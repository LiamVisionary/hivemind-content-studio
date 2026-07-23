// Auto-detection of user ComfyUI workflows as local image models.
//
// Any API-format ComfyUI graph (ComfyUI's "Save (API format)" export) dropped
// into an auto-workflow folder is exposed through /local-ai/models with
// backend "comfy-api-image"; the media gateway's run_comfy_api_image executes
// it with the prompt/seed/dims patched in and lane routing by checkpoint name.
// No registry edit needed. Web-format editor exports (nodes[]/links[]) are
// skipped — re-export with "Save (API format)".

const fs = require('fs');
const path = require('path');
const os = require('os');

const SAMPLER_CLASSES = new Set(['KSampler', 'KSamplerAdvanced']);
const OUTPUT_CLASSES = new Set(['SaveImage', 'SaveImageWebsocket']);
const PROMPT_TEXT_KEYS = ['text', 'positive_text', 'prompt'];
const DEFAULT_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'];

function defaultAutoWorkflowDirs() {
  const fromEnv = String(process.env.OGA_AUTO_WORKFLOW_DIRS || process.env.ZIMG_AUTO_WORKFLOW_DIRS || '')
    .split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  const comfyDir = process.env.COMFY_DIR || path.join(os.homedir(), 'comfy/ComfyUI');
  return [path.join(comfyDir, 'workflows', 'auto')];
}

function isApiGraph(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return false;
  const nodes = Object.values(graph);
  return nodes.length > 0 && nodes.every((node) => node && typeof node === 'object' && !Array.isArray(node) && typeof node.class_type === 'string');
}

function findTextNode(graph, startId, seen = new Set()) {
  const nodeId = String(startId);
  if (seen.has(nodeId) || !graph[nodeId]) return null;
  seen.add(nodeId);
  const inputs = graph[nodeId].inputs || {};
  for (const key of PROMPT_TEXT_KEYS) {
    if (typeof inputs[key] === 'string') return { nodeId, key };
  }
  for (const value of Object.values(inputs)) {
    if (Array.isArray(value) && value.length) {
      const found = findTextNode(graph, value[0], seen);
      if (found) return found;
    }
  }
  return null;
}

function titleFromFilename(file) {
  return path.basename(file, '.json')
    .replace(/[-_](api|save[-_]api)$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function slugFromFilename(file) {
  return path.basename(file, '.json').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Civitai base-model strings the local LoRA catalog is tagged with, inferred
// from the workflow's checkpoint name. Empty → the model reports no LoRA
// support instead of listing incompatible files.
const LORA_BASE_HINTS = [
  [/anima/i, ['Anima']],
  [/z[-_]?image/i, ['ZImageTurbo']],
  [/krea/i, ['Krea 2']],
  [/klein|flux/i, ['Flux.2 Klein 9B']],
];

function loraBasesForCheckpoint(checkpoint) {
  for (const [pattern, bases] of LORA_BASE_HINTS) {
    if (pattern.test(checkpoint || '')) return bases;
  }
  return [];
}

function checkpointHint(graph) {
  for (const node of Object.values(graph)) {
    const inputs = node.inputs || {};
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value !== 'string') continue;
      if (/(unet_name|ckpt_name|model_name)/i.test(key)) return value.replace(/\.(safetensors|ckpt|gguf)$/i, '');
    }
  }
  return '';
}

// Inspect one API graph → hosted image model entry, or null when not a
// launchable text-to-image generation graph.
function inspectAutoWorkflow(filePath, raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  const graph = data && typeof data === 'object' && !Array.isArray(data) && data.prompt && typeof data.prompt === 'object'
    ? data.prompt
    : data;
  if (!isApiGraph(graph)) return null;

  const nodes = Object.values(graph);
  const sampler = nodes.find((node) => SAMPLER_CLASSES.has(node.class_type));
  const hasOutput = nodes.some((node) => OUTPUT_CLASSES.has(node.class_type));
  if (!sampler || !hasOutput) return null;              // utility/conversion graph
  if (nodes.some((node) => node.class_type === 'LoadImage')) return null; // v1: text-to-image only

  const positiveRef = (sampler.inputs || {}).positive;
  const promptNode = Array.isArray(positiveRef) && positiveRef.length ? findTextNode(graph, positiveRef[0]) : null;
  if (!promptNode) return null;                          // nothing to patch a prompt into

  const dimsNode = nodes.find((node) => {
    const inputs = node.inputs || {};
    return typeof inputs.width === 'number' && typeof inputs.height === 'number';
  });
  const samplerInputs = sampler.inputs || {};
  const checkpoint = checkpointHint(graph);
  // Regional-prompt graphs (ForgeCouple style) run single-subject by default;
  // the studio offers a Couple mode toggle for them.
  const coupleCapable = nodes.some((node) => typeof (node.inputs || {}).advanced_mapping === 'string');
  const loraBases = loraBasesForCheckpoint(checkpoint);

  return {
    id: `comfy-auto-${slugFromFilename(filePath)}`,
    name: titleFromFilename(filePath),
    description: checkpoint
      ? `Auto-detected ComfyUI workflow · ${checkpoint}`
      : 'Auto-detected ComfyUI workflow',
    type: 'image',
    family: 'comfy-auto',
    provider: 'hosted-media-studio',
    state: 'downloaded',
    backend: 'comfy-api-image',
    workflowFile: filePath,
    supportsLoras: loraBases.length > 0,
    compatibleBaseModels: loraBases,
    promptHelper: null,
    requires: { prompt: true, image: false },
    accepts: ['prompt', 'negative_prompt', 'seed', 'steps', 'cfg', 'width', 'height'],
    supportsImage: false,
    maxReferenceImages: 0,
    coupleCapable,
    aspectRatios: DEFAULT_ASPECT_RATIOS,
    defaultWidth: Number(dimsNode?.inputs?.width || 1024),
    defaultHeight: Number(dimsNode?.inputs?.height || 1024),
    defaultSteps: Number(samplerInputs.steps || 8),
    defaultGuidance: Number(samplerInputs.cfg ?? 1),
    tags: ['local', 'auto-detected'],
    featured: false,
  };
}

function discoverAutoImageWorkflows(dirs = defaultAutoWorkflowDirs()) {
  const models = [];
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries.sort()) {
      if (!entry.toLowerCase().endsWith('.json')) continue;
      const filePath = path.join(dir, entry);
      try {
        const model = inspectAutoWorkflow(filePath, fs.readFileSync(filePath, 'utf8'));
        if (model) models.push(model);
      } catch (error) {
        console.error(`[auto-workflows] skipping ${entry}: ${error.message}`);
      }
    }
  }
  return models;
}

module.exports = {
  defaultAutoWorkflowDirs,
  discoverAutoImageWorkflows,
  inspectAutoWorkflow,
};
