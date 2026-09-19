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
// The empty-latent nodes a text-to-image graph starts from. A sampler whose
// latent traces to one of these can begin with nothing but words; one whose
// latent traces to a VAEEncode is re-noising a picture and cannot.
const EMPTY_LATENT_CLASSES = new Set([
  'EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyFlux2LatentImage',
  'EmptyLatentImagePresets', 'EmptyMochiLatentVideo', 'EmptyImage',
]);
const IMAGE_INPUT_FIELDS = ['image_path', 'image_base64', 'images_base64', 'image_url'];

function comfyInputDir() {
  const comfyDir = process.env.COMFY_DIR || path.join(os.homedir(), 'comfy/ComfyUI');
  return path.join(comfyDir, 'input');
}

// Node ids in the order a person reading the graph would fill them. Mirrors
// auto_reference_slots() in packages/media-gateway/gateway/graphs.py — the two
// must agree or the composer offers a slot the runner will not fill.
function referenceSlots(graph) {
  return Object.keys(graph)
    .filter((id) => graph[id] && graph[id].class_type === 'LoadImage')
    .sort((a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b)));
}

/** Walk a latent input upstream and say which kind of source it reaches. */
function latentSource(graph, startId, seen = new Set()) {
  const nodeId = String(startId);
  if (seen.has(nodeId) || !graph[nodeId]) return null;
  seen.add(nodeId);
  const node = graph[nodeId];
  if (EMPTY_LATENT_CLASSES.has(node.class_type)) return 'empty';
  if (node.class_type === 'VAEEncode' || node.class_type === 'VAEEncodeForInpaint') return 'picture';
  for (const value of Object.values(node.inputs || {})) {
    if (Array.isArray(value) && value.length) {
      const found = latentSource(graph, value[0], seen);
      if (found) return found;
    }
  }
  return null;
}

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

// Inspect one API graph → a hosted image model entry, or a REASON it cannot be
// one. A bare null used to come back for every rejection and nothing carried it
// anywhere, so a workflow that did not qualify simply never appeared and the
// person who wrote it got no clue why. Every `return` here now says something a
// person could act on.
function rejected(reason) { return { model: null, reason }; }
function accepted(model) { return { model, reason: '' }; }

function inspectAutoWorkflowDetailed(filePath, raw) {
  let data;
  try { data = JSON.parse(raw); } catch (error) {
    return rejected(`it is not valid JSON (${error.message})`);
  }
  const graph = data && typeof data === 'object' && !Array.isArray(data) && data.prompt && typeof data.prompt === 'object'
    ? data.prompt
    : data;
  if (!isApiGraph(graph)) {
    return rejected('it is a workflow editor export, not an API one — re-export with "Save (API format)"');
  }

  const nodes = Object.values(graph);
  const sampler = nodes.find((node) => SAMPLER_CLASSES.has(node.class_type));
  const hasOutput = nodes.some((node) => OUTPUT_CLASSES.has(node.class_type));
  if (!sampler) return rejected('it has no KSampler, so there is nothing here that generates a picture');
  if (!hasOutput) return rejected('it has no Save Image node, so it produces nothing to keep');

  const positiveRef = (sampler.inputs || {}).positive;
  const promptNode = Array.isArray(positiveRef) && positiveRef.length ? findTextNode(graph, positiveRef[0]) : null;
  if (!promptNode) return rejected("its sampler's positive input never reaches a text box, so a prompt cannot be typed into it");

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

  // What the graph does with a picture, decided by reading it rather than by
  // assuming. A latent that comes from a VAEEncode IS the source image, so the
  // run cannot start from words. A latent from an empty-latent node means any
  // LoadImage here is conditioning (ControlNet, IPAdapter, a reference sheet)
  // and the picture is optional — but only if the file the node already names
  // is really on disk, because otherwise a prompt-only run would hand ComfyUI a
  // filename that is not there and fail at submit for a reason nobody could
  // read off the composer.
  const slots = referenceSlots(graph);
  const latentRef = (sampler.inputs || {}).latent_image;
  const latentFrom = Array.isArray(latentRef) && latentRef.length ? latentSource(graph, latentRef[0]) : null;
  const inputDir = comfyInputDir();
  const defaultsPresent = slots.every((id) => {
    const named = String((graph[id].inputs || {}).image || '');
    if (!named) return false;
    try { return fs.statSync(path.join(inputDir, named)).isFile(); } catch { return false; }
  });
  const needsPicture = slots.length > 0 && (latentFrom === 'picture' || !defaultsPresent);

  return accepted({
    id: `comfy-auto-${slugFromFilename(filePath)}`,
    name: titleFromFilename(filePath),
    description: [
      checkpoint ? `Auto-detected ComfyUI workflow · ${checkpoint}` : 'Auto-detected ComfyUI workflow',
      slots.length === 0 ? '' : needsPicture
        ? `Starts from ${slots.length === 1 ? 'a picture' : `${slots.length} pictures`} you attach.`
        : `Takes ${slots.length === 1 ? 'an optional reference' : `up to ${slots.length} optional references`}.`,
    ].filter(Boolean).join(' · '),
    type: 'image',
    family: 'comfy-auto',
    provider: 'hosted-media-studio',
    state: 'downloaded',
    backend: 'comfy-api-image',
    workflowFile: filePath,
    supportsLoras: loraBases.length > 0,
    compatibleBaseModels: loraBases,
    promptHelper: null,
    requires: { prompt: true, image: needsPicture },
    accepts: [
      'prompt', 'negative_prompt', 'seed', 'steps', 'cfg', 'width', 'height',
      ...(slots.length ? IMAGE_INPUT_FIELDS : []),
    ],
    supportsImage: slots.length > 0,
    maxReferenceImages: slots.length,
    coupleCapable,
    aspectRatios: DEFAULT_ASPECT_RATIOS,
    defaultWidth: Number(dimsNode?.inputs?.width || 1024),
    defaultHeight: Number(dimsNode?.inputs?.height || 1024),
    defaultSteps: Number(samplerInputs.steps || 8),
    defaultGuidance: Number(samplerInputs.cfg ?? 1),
    tags: ['local', 'auto-detected'],
    featured: false,
  });
}

/**
 * The model this workflow becomes, or null.
 *
 * Kept as the plain contract every existing caller reads (`if (model)`), with
 * inspectAutoWorkflowDetailed underneath for the callers that want to tell a
 * person WHY a file of theirs did not become a model.
 */
function inspectAutoWorkflow(filePath, raw) {
  return inspectAutoWorkflowDetailed(filePath, raw).model;
}

/**
 * Every drop-in workflow in these folders, and every one that could not become
 * a model with the reason why.
 *
 * The skipped list is the point of the return shape. A file a person put in
 * this folder on purpose and never saw again is the worst outcome here, so the
 * caller gets something to show them instead of a shorter list.
 */
function discoverAutoImageWorkflowsDetailed(dirs = defaultAutoWorkflowDirs()) {
  const models = [];
  const skipped = [];
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries.sort()) {
      if (!entry.toLowerCase().endsWith('.json')) continue;
      const filePath = path.join(dir, entry);
      try {
        const { model, reason } = inspectAutoWorkflowDetailed(filePath, fs.readFileSync(filePath, 'utf8'));
        if (model) models.push(model);
        else skipped.push({ file: entry, reason: reason || 'it is not a workflow this studio can drive' });
      } catch (error) {
        skipped.push({ file: entry, reason: `it could not be read (${error.message})` });
      }
    }
  }
  return { models, skipped };
}

function discoverAutoImageWorkflows(dirs = defaultAutoWorkflowDirs()) {
  return discoverAutoImageWorkflowsDetailed(dirs).models;
}

module.exports = {
  defaultAutoWorkflowDirs,
  discoverAutoImageWorkflows,
  discoverAutoImageWorkflowsDetailed,
  inspectAutoWorkflow,
  inspectAutoWorkflowDetailed,
  referenceSlots,
};
