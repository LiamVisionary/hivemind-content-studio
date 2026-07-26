// Pure logic for the Video Studio React port.
// The helper functions here are copied VERBATIM from src/components/VideoStudio.js
// (the old vanilla factory, which stays on disk untouched) — they are the
// spec-listed pure helpers plus the state-transition rules rewritten as pure
// functions over an immutable `setup` object so React renders labels from state
// instead of the old getElementById sync layer.
import {
  t2vModels,
  i2vModels,
  v2vModels,
  getAspectRatiosForVideoModel,
  getDurationsForModel,
  getResolutionsForVideoModel,
  getAspectRatiosForI2VModel,
  getDurationsForI2VModel,
  getResolutionsForI2VModel,
  getModesForModel,
} from '../../lib/models.js';
import {
  getHivemindVideoModelById,
  isHivemindStudioEnabled,
  isHivemindVideoModelId,
} from '../../lib/hivemindStudio.js';
import {
  getLocalModelById,
  isWan2gpModelId,
  localT2VModels,
  localI2VModels,
} from '../../lib/localModels.js';
import { isLocalAIAvailable } from '../../lib/localInferenceClient.js';
import { resolveMediaSrc } from '../../lib/e2eMedia.js';
import { getLang, t } from '../../lib/i18n.js';

export const zh = () => getLang() === 'zh-CN';

export const VIDEO_PREFERENCES_KEY = 'video_generation_preferences';

const VIDEO_ADVANCED_EXCLUDED_INPUTS = new Set([
  'prompt',
  'aspect_ratio',
  'duration',
  'resolution',
  'quality',
  'mode',
  'name',
  'request_id',
  'images_list',
  'video_files',
  'image_url',
  'video_url',
  'last_image',
  'audio',
]);

/* ------------------------------------------------------------------ */
/* Catalog adapters (verbatim)                                         */
/* ------------------------------------------------------------------ */

export const adaptLocalToVideoEntry = (m) => ({
  id: m.id,
  name: m.name,
  provider: 'wan2gp',
  inputs: {
    prompt: { type: 'string', name: 'prompt', title: 'Prompt' },
    aspect_ratio: { type: 'string', name: 'aspect_ratio', enum: m.aspectRatios || ['16:9', '1:1', '9:16'], default: (m.aspectRatios || ['16:9'])[0] },
  },
});

export const adaptHivemindToVideoEntry = (m) => ({
  id: m.id,
  name: m.name,
  provider: 'hivemind-media-studio',
  workflowId: m.workflowId,
  tierGroup: m.tierGroup || null,
  tier: m.tier || null,
  supportsVideoInput: Boolean(m.supportsVideoInput),
  supportsLoras: Boolean(m.supportsLoras),
  compatibleBaseModels: Array.isArray(m.compatibleBaseModels) ? m.compatibleBaseModels : [],
  supportsIngredientImages: Boolean(m.supportsIngredientImages),
  ingredientInputs: m.ingredientInputs && typeof m.ingredientInputs === 'object' ? m.ingredientInputs : null,
  videoModes: m.videoModes || [],
  inputs: {
    prompt: { type: 'string', name: 'prompt', title: 'Prompt' },
    aspect_ratio: { type: 'string', name: 'aspect_ratio', enum: m.aspectRatios || ['1:1', '16:9', '9:16'], default: (m.aspectRatios || ['1:1'])[0] },
    duration: { type: 'number', name: 'duration', enum: m.durations || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], default: m.defaultDuration || 4 },
  },
});

/* ------------------------------------------------------------------ */
/* Pure helpers (verbatim from VideoStudio.js lines 77-267)            */
/* ------------------------------------------------------------------ */

export { activeTierFor, groupModelTiers, tierPairFor } from '../../lib/modelTiers.js';

export function getAdvancedVideoInputs(model) {
  return Object.entries(model?.inputs || {})
    .filter(([name, input]) => {
      if (VIDEO_ADVANCED_EXCLUDED_INPUTS.has(name) || !input || typeof input !== 'object') return false;
      return ['boolean', 'string', 'int', 'float', 'number'].includes(input.type);
    })
    .map(([name, input]) => ({ name, ...input }));
}

export function getDefaultAdvancedVideoValues(model) {
  return Object.fromEntries(getAdvancedVideoInputs(model).map((input) => {
    if (Object.prototype.hasOwnProperty.call(input, 'default')) return [input.name, input.default];
    if (input.type === 'boolean') return [input.name, false];
    if (Array.isArray(input.enum) && input.enum.length > 0) return [input.name, input.enum[0]];
    if (['int', 'float', 'number'].includes(input.type)) return [input.name, input.minValue ?? 0];
    return [input.name, ''];
  }));
}

export function getAdvancedVideoPayload(model, values) {
  return Object.fromEntries(getAdvancedVideoInputs(model)
    .filter((input) => Object.prototype.hasOwnProperty.call(values || {}, input.name))
    .map((input) => [input.name, values[input.name]]));
}

export function getRestoredAdvancedVideoValues(model, values) {
  const defaults = getDefaultAdvancedVideoValues(model);
  if (!values || typeof values !== 'object' || Array.isArray(values)) return defaults;
  return Object.fromEntries(getAdvancedVideoInputs(model).map((input) => {
    const saved = values[input.name];
    if (saved == null) return [input.name, defaults[input.name]];
    if (input.type === 'boolean') return [input.name, Boolean(saved)];
    if (Array.isArray(input.enum) && input.enum.length > 0) {
      const match = input.enum.find((value) => String(value) === String(saved));
      return [input.name, match ?? defaults[input.name]];
    }
    if (['int', 'float', 'number'].includes(input.type)) {
      const numeric = Number(saved);
      if (!Number.isFinite(numeric)) return [input.name, defaults[input.name]];
      const bounded = Math.min(input.maxValue ?? numeric, Math.max(input.minValue ?? numeric, numeric));
      return [input.name, input.type === 'int' ? Math.round(bounded) : bounded];
    }
    return [input.name, typeof saved === 'string' ? saved : defaults[input.name]];
  }));
}

export function normalizeVideoPreferences(value) {
  if (!value || typeof value !== 'object') return null;
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  if (!modelId || modelId.length > 256) return null;
  const duration = Number(value.duration);
  const stringValue = (candidate) => typeof candidate === 'string' ? candidate.trim() : '';
  const advancedValues = value.advancedValues && typeof value.advancedValues === 'object' && !Array.isArray(value.advancedValues)
    ? Object.fromEntries(Object.entries(value.advancedValues).filter(([, candidate]) => (
      ['string', 'number', 'boolean'].includes(typeof candidate) && (typeof candidate !== 'number' || Number.isFinite(candidate))
    )))
    : {};
  const loraSelections = {};
  if (value.loraSelections && typeof value.loraSelections === 'object' && !Array.isArray(value.loraSelections)) {
    Object.entries(value.loraSelections).forEach(([model, selections]) => {
      if (!model || !Array.isArray(selections)) return;
      loraSelections[model] = selections.flatMap((selection) => {
        const id = stringValue(selection?.id);
        if (!id) return [];
        const rawStrength = Number(selection.strength);
        const strength = Number.isFinite(rawStrength) ? Math.max(-10, Math.min(10, rawStrength)) : 1;
        return [{
          id,
          name: stringValue(selection.name) || id,
          displayName: stringValue(selection.displayName) || stringValue(selection.name) || id,
          previewUrl: stringValue(selection.previewUrl),
          strength,
          // Muted LoRAs stay in the list (with their weight) across reloads.
          enabled: selection.enabled !== false,
        }];
      });
    });
  }
  const ingredientSelections = normalizeVideoIngredientSelections(value.ingredientSelections);
  const ingredientSheets = normalizeVideoIngredientSelections(value.ingredientSheets);
  const ingredientSelectedSheet = normalizeSelectedVideoIngredientSheet(
    value.ingredientSelectedSheet,
    ingredientSelections,
    ingredientSheets,
  );
  return {
    modelId,
    localMode: typeof value.localMode === 'boolean' ? value.localMode : null,
    aspectRatio: stringValue(value.aspectRatio),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    resolution: stringValue(value.resolution),
    quality: stringValue(value.quality),
    mode: stringValue(value.mode),
    effectName: stringValue(value.effectName),
    matchStartFrameAr: typeof value.matchStartFrameAr === 'boolean' ? value.matchStartFrameAr : null,
    denoise: ['light', 'strong'].includes(value.denoise) ? value.denoise : '',
    // NAG strength is a setting, not prompt text, so it persists here. The
    // negative prompt itself deliberately does not — it lives in the encrypted
    // composer with the positive prompt.
    nagScale: (typeof value.nagScale === 'number' && Number.isFinite(value.nagScale)) ? value.nagScale : null,
    seed: (typeof value.seed === 'number' && Number.isFinite(value.seed) && value.seed >= 0) ? Math.floor(value.seed) : -1,
    advancedValues,
    loraSelections,
    ingredientSelections,
    ingredientSheets,
    ingredientSelectedSheet,
    // The completion ping is a shared all-studio setting (lib/completionPing.js),
    // not a video preference — legacy values here are migrated once on load.
  };
}

export function normalizeVideoIngredientSelections(value) {
  const lists = Array.isArray(value)
    ? [value]
    : (value && typeof value === 'object'
      ? Object.values(value).filter(Array.isArray)
      : []);
  const normalized = [];
  const indexesByUrl = new Map();
  for (const selections of lists) {
    for (const selection of selections) {
      const url = typeof selection?.url === 'string' ? selection.url.trim() : '';
      if (!url.startsWith('/api/media-studio/references/')) continue;
      const description = typeof selection?.description === 'string'
        ? selection.description.trim().slice(0, 1000)
        : '';
      const existingIndex = indexesByUrl.get(url);
      if (existingIndex !== undefined) {
        if (!normalized[existingIndex].description && description) {
          normalized[existingIndex] = { ...normalized[existingIndex], description };
        }
        continue;
      }
      if (normalized.length >= 12) continue;
      indexesByUrl.set(url, normalized.length);
      normalized.push({ url, description });
    }
  }
  return normalized;
}

export function normalizeSelectedVideoIngredientSheet(value, ingredientSelections, ingredientSheets) {
  const views = Array.isArray(ingredientSelections) ? ingredientSelections : [];
  const sheets = Array.isArray(ingredientSheets) ? ingredientSheets : [];
  // Legacy state carries no explicit selection: saved reference views were implicitly active.
  if (typeof value !== 'string') return views.length ? 'stitched' : '';
  const candidate = value.trim();
  if (candidate === 'stitched') return views.length ? 'stitched' : '';
  return sheets.some((sheet) => sheet?.url === candidate) ? candidate : '';
}

export function normalizeVideoGenerationProgress(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = value > 1 ? value / 100 : value;
  return Math.min(1, Math.max(0, normalized));
}

// Smoothed, MONOTONIC progress for the generation bar — now shared with the image
// studio; re-exported so existing videoLogic importers keep working.
export { computeSmoothProgress } from '../../lib/genProgress.js';

export function classifyVideoGenerationStage(status) {
  const value = String(status || '').toLowerCase();
  if (/load|model|startup|prepar/.test(value)) return 'loading';
  if (/encod|decod|export|sav|final/.test(value)) return 'finishing';
  if (/queue|pending|submit/.test(value)) return 'queued';
  return 'rendering';
}

export function formatVideoGenerationElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function clampVideoDropdownMaxHeight(anchorTop, minimum = 180, margin = 24) {
  return Math.max(minimum, Math.round(Number(anchorTop) || 0) - margin);
}

export function clampVideoDropdownViewportLeft(preferredLeft, dropdownWidth, viewportWidth, padding = 12) {
  const safePadding = Math.max(0, Number(padding) || 0);
  const width = Math.max(0, Number(dropdownWidth) || 0);
  const viewport = Math.max(0, Number(viewportWidth) || 0);
  const maximum = Math.max(safePadding, viewport - width - safePadding);
  return Math.min(maximum, Math.max(safePadding, Number(preferredLeft) || 0));
}

export function closestVideoAspectRatio(width, height, availableRatios = []) {
  const sourceWidth = Number(width);
  const sourceHeight = Number(height);
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;
  const sourceRatio = sourceWidth / sourceHeight;
  return availableRatios.reduce((best, value) => {
    const match = String(value).match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/);
    if (!match) return best;
    const ratio = Number(match[1]) / Number(match[2]);
    if (!(ratio > 0)) return best;
    const distance = Math.abs(Math.log(ratio / sourceRatio));
    return !best || distance < best.distance ? { value, distance } : best;
  }, null)?.value || null;
}

export function imageDimensions(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('Could not inspect the selected start frame.'));
    // The start frame may be an E2E-sealed generated output; decrypt in-page
    // first (legacy/upload sources pass through untouched).
    void resolveMediaSrc(source).then((resolved) => { image.src = resolved; });
  });
}

/* ------------------------------------------------------------------ */
/* Catalogs                                                            */
/* ------------------------------------------------------------------ */

export { t2vModels, i2vModels, v2vModels };

export const isLocalVideoModel = (id) => isHivemindVideoModelId(id) || isWan2gpModelId(id);

// Wan2GP entries are merged in only when the Electron bridge is present —
// same probe the old factory ran at build time (lines 290-291).
export function buildCatalogs(hivemindI2V) {
  const localT2V = isLocalAIAvailable() ? localT2VModels.map(adaptLocalToVideoEntry) : [];
  const localI2V = isLocalAIAvailable() ? localI2VModels.map(adaptLocalToVideoEntry) : [];
  return {
    hivemindI2V,
    allT2V: [...t2vModels, ...localT2V],
    // Ordering contract (old line 1243): [hivemindI2V, ...i2vModels, ...localI2V].
    allI2V: [...hivemindI2V, ...i2vModels, ...localI2V],
  };
}

export const modelsFor = (s, c) => (s.v2vMode ? v2vModels : (s.imageMode ? c.allI2V : c.allT2V));
export const currentModel = (s, c) => modelsFor(s, c).find((m) => m.id === s.modelId);
export const isMotionControlV2V = (s, c) => s.v2vMode && !!currentModel(s, c)?.imageField;
export const isHivemindVideoInputMode = (s) => isHivemindVideoModelId(s.modelId) && Boolean(s.videoUrl);

export const aspectRatiosFor = (s, id) => {
  const hive = getHivemindVideoModelById(id);
  if (hive) return hive.aspectRatios || ['1:1', '16:9', '9:16'];
  const local = getLocalModelById(id);
  if (local) return local.aspectRatios || ['16:9', '1:1', '9:16'];
  return s.imageMode ? getAspectRatiosForI2VModel(id) : getAspectRatiosForVideoModel(id);
};

export const durationsFor = (s, id) => {
  const hive = getHivemindVideoModelById(id);
  if (hive) return hive.durations || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  if (getLocalModelById(id)) return [];
  return s.imageMode ? getDurationsForI2VModel(id) : getDurationsForModel(id);
};

export const resolutionsFor = (s, id) => {
  // Local Media Studio workflows render at aspect buckets; High requests the
  // larger bucket (~2.5x pixels) — synthetic list, old line 394.
  // High leads because the first entry becomes the default: Standard is 0.34 MP
  // at 16:9, roughly a third of what LTX 2.3 workflows in the wild generate at,
  // and LTX anatomy degrades sharply below its trained resolution. High (0.86 MP)
  // lands near that mark. Standard stays available for quick drafts.
  if (getHivemindVideoModelById(id)) return ['High', 'Standard'];
  if (getLocalModelById(id)) return [];
  return s.imageMode ? getResolutionsForI2VModel(id) : getResolutionsForVideoModel(id);
};

export const modesFor = (id) => getModesForModel(id);

export const qualitiesFor = (s, c, id) => {
  const model = modelsFor(s, c).find((m) => m.id === id);
  return model?.inputs?.quality?.enum || [];
};

export const effectNamesFor = (s, c, id) => {
  const model = modelsFor(s, c).find((m) => m.id === id);
  return model?.inputs?.name?.enum || [];
};

/* ------------------------------------------------------------------ */
/* Setup-state transitions (port of the imperative cascades)           */
/* ------------------------------------------------------------------ */

export function buildInitialSetup(c) {
  const defaultModel = c.allT2V[0];
  return {
    modelId: defaultModel.id,
    modelName: defaultModel.name,
    localMode: isHivemindStudioEnabled() && isLocalAIAvailable()
      ? true
      : isLocalVideoModel(defaultModel.id),
    imageMode: false,
    v2vMode: false,
    ar: defaultModel.inputs?.aspect_ratio?.default || '16:9',
    duration: defaultModel.inputs?.duration?.default || 5,
    resolution: defaultModel.inputs?.resolution?.default || '',
    quality: defaultModel.inputs?.quality?.default || '',
    mode: '',
    effectName: '',
    advancedValues: getDefaultAdvancedVideoValues(defaultModel),
    // -1 = random (a fresh seed is rolled per generation); >= 0 = a locked seed.
    seed: -1,
    imageUrl: null,
    endImageUrl: null,
    ltxMiddleUrl: null,
    ltxEndUrl: null,
    matchStartFrameAr: true,
    // Post-generation grain cleanup: '' (off), 'light', 'strong'.
    denoise: '',
    videoUrl: null,
    videoName: null,
    prompt: '',
  };
}

// Port of updateControlsForModel (1001-1100): re-derives the per-model default
// selections. Visibility is derived at render time via deriveControlVisibility.
export function applyModelDefaults(prev, c) {
  const s = { ...prev };
  const model = modelsFor(s, c).find((m) => m.id === s.modelId);
  s.advancedValues = getDefaultAdvancedVideoValues(model);
  if (s.v2vMode) return s; // v2v hides all parameter controls; values untouched
  const localVideoInput = isHivemindVideoInputMode(s);
  const availableArs = aspectRatiosFor(s, s.modelId);
  if (!localVideoInput && availableArs.length > 0) s.ar = availableArs[0];
  const durations = durationsFor(s, s.modelId);
  if (durations.length > 0) {
    s.duration = durations.find((d) => Number(d) === Number(model?.inputs?.duration?.default)) ?? durations[0];
  }
  const resolutions = resolutionsFor(s, s.modelId);
  if (resolutions.length > 0) s.resolution = resolutions[0];
  const qualities = qualitiesFor(s, c, s.modelId);
  s.quality = qualities.length > 0 ? (model?.inputs?.quality?.default || qualities[0]) : '';
  const modes = modesFor(s.modelId);
  s.mode = modes.length > 0 ? (model?.inputs?.mode?.default || modes[0]) : '';
  const effectNames = effectNamesFor(s, c, s.modelId);
  s.effectName = effectNames.length > 0 ? (model?.inputs?.name?.default || effectNames[0]) : '';
  return s;
}

export function deriveControlVisibility(s, c) {
  if (s.v2vMode) {
    return { ar: false, duration: false, resolution: false, quality: false, mode: false, effect: false };
  }
  const localVideoInput = isHivemindVideoInputMode(s);
  return {
    ar: !localVideoInput && aspectRatiosFor(s, s.modelId).length > 0,
    duration: durationsFor(s, s.modelId).length > 0,
    resolution: resolutionsFor(s, s.modelId).length > 0,
    quality: qualitiesFor(s, c, s.modelId).length > 0,
    mode: modesFor(s.modelId).length > 0,
    effect: effectNamesFor(s, c, s.modelId).length > 0,
  };
}

// Extend banner (old 1087-1099): '' means hidden.
export function deriveExtendBanner(s, c) {
  if (s.v2vMode) return '';
  const model = currentModel(s, c);
  if (isHivemindVideoInputMode(s)) {
    return zh()
      ? '正在延长已上传的 LTX 镜头；时长控制追加多少新画面'
      : 'Extending the uploaded LTX shot; duration controls how much new footage is appended';
  }
  if (model?.requiresRequestId) {
    return zh()
      ? '正在延长上一次 Seedance 2.0 生成；可添加可选提示词引导延续'
      : 'Extending previous Seedance 2.0 generation; add an optional prompt to guide the continuation';
  }
  return '';
}

// Derived textarea placeholder/disabled — replaces the ~14 imperative
// textarea.placeholder writes in the old file with one state-derived rule.
export function derivePromptUi(s, c) {
  const model = currentModel(s, c);
  if (s.v2vMode) {
    if (model?.imageField) {
      if (s.videoUrl && s.imageUrl) {
        return {
          placeholder: model.promptRequired
            ? (zh() ? '描述动作' : 'Describe the motion')
            : (zh() ? '描述动作（可选）' : 'Describe the motion (optional)'),
          disabled: false,
        };
      }
      if (s.imageUrl) return { placeholder: zh() ? '现在请添加参考视频' : 'Now attach a reference video', disabled: false };
      if (s.videoUrl) return { placeholder: zh() ? '现在请添加参考图片' : 'Now attach a reference image', disabled: false };
      return {
        placeholder: model.promptRequired
          ? (zh() ? '上传参考视频和图片，然后描述动作' : 'Upload a reference video and image, then describe the motion')
          : (zh() ? '上传参考视频和图片，然后描述动作（可选）' : 'Upload a reference video and image, then describe the motion (optional)'),
        disabled: false,
      };
    }
    const disabled = !(model?.hasPrompt || model?.promptRequired);
    if (s.videoUrl) return { placeholder: zh() ? '视频已就绪 — 点击生成' : 'Video ready — click Generate', disabled };
    return { placeholder: zh() ? '先添加一个视频，然后点击生成' : 'Attach a video, then click Generate', disabled };
  }
  if (isHivemindVideoInputMode(s)) {
    return { placeholder: zh() ? '描述镜头应如何延续' : 'Describe how the shot should continue', disabled: false };
  }
  if (model?.requiresRequestId) {
    return { placeholder: zh() ? '可选：描述视频如何继续…' : 'Optional: describe how to continue the video...', disabled: false };
  }
  if (s.imageMode) {
    if (model?.supportsIngredientImages) {
      return { placeholder: zh() ? '使用所选角色参考来描述镜头' : 'Describe the shot using the selected character references', disabled: false };
    }
    if (isHivemindVideoModelId(s.modelId) && !s.imageUrl) {
      return { placeholder: zh() ? '上传起始帧图片，然后描述动作' : 'Upload a start frame image, then describe the motion', disabled: false };
    }
    return { placeholder: zh() ? '描述动作或效果（可选）' : 'Describe the motion or effect (optional)', disabled: false };
  }
  return { placeholder: t('video.placeholder'), disabled: false };
}

// Start-frame selected (old picker onSelect, 449-483).
export function startFrameSelectedTransition(prev, url, c) {
  let s = prev;
  if (isHivemindVideoInputMode(s)) s = clearVideoUploadTransition(s, c);
  s = { ...s, imageUrl: url };
  // Motion-control v2v: image is a second input alongside the video, not a mode switch
  if (isMotionControlV2V(s, c)) return { setup: s, matchAspect: false, modelChanged: false };
  if (s.v2vMode) s = { ...s, v2vMode: false, videoUrl: null, videoName: null };
  let modelChanged = false;
  if (!s.imageMode) {
    const currentT2V = c.allT2V.find((m) => m.id === s.modelId);
    const sibling = currentT2V?.family ? c.allI2V.find((m) => m.family === currentT2V.family) : null;
    const target = sibling || c.allI2V[0];
    s = applyModelDefaults({ ...s, imageMode: true, modelId: target.id, modelName: target.name }, c);
    modelChanged = true;
  }
  return { setup: s, matchAspect: true, modelChanged };
}

// Start-frame cleared (old picker onClear, 484-499).
export function startFrameClearedTransition(prev, c) {
  let s = { ...prev, imageUrl: null };
  // Motion-control v2v: keep the model selection; just lose the image
  if (isMotionControlV2V(s, c)) return s;
  // Clearing the start frame invalidates any selected end frame.
  s = {
    ...s,
    imageMode: false,
    endImageUrl: null,
    modelId: c.allT2V[0].id,
    modelName: c.allT2V[0].name,
  };
  return applyModelDefaults(s, c);
}

// Clearing the reference video (old clearVideoUpload, 605-634).
export function clearVideoUploadTransition(prev, c) {
  const wasHivemindVideo = isHivemindVideoInputMode(prev);
  let s = { ...prev, videoUrl: null, videoName: null };
  // Motion-control v2v: keep the model and image; user can re-upload a video
  if (isMotionControlV2V(s, c)) return s;
  if (wasHivemindVideo) {
    s = { ...s, imageMode: false, modelId: c.allT2V[0].id, modelName: c.allT2V[0].name };
    return applyModelDefaults(s, c);
  }
  s = { ...s, v2vMode: false, modelId: c.allT2V[0].id, modelName: c.allT2V[0].name };
  return applyModelDefaults(s, c);
}

// After a reference video finished uploading (old videoFileInput.onchange, 663-706).
export function videoUploadedTransition(prev, { url, name, useHivemind, preferredHive }, c) {
  let s = { ...prev, videoUrl: url, videoName: name };
  if (useHivemind) {
    s = {
      ...s,
      imageUrl: null,
      endImageUrl: null,
      v2vMode: false,
      imageMode: true,
      modelId: preferredHive.id,
      modelName: preferredHive.name,
    };
    return applyModelDefaults(s, c);
  }
  // If a motion-control v2v model is already selected, keep it and the image upload
  if (isMotionControlV2V(s, c)) return s;
  // Default v2v flow — auto-pick the first v2v model
  if (s.imageMode) s = { ...s, imageUrl: null, imageMode: false };
  s = { ...s, v2vMode: true, modelId: v2vModels[0].id, modelName: v2vModels[0].name };
  return applyModelDefaults(s, c);
}

// Model dropdown selections (old makeModelItem onclick, 2026-2072).
export function selectV2VModelTransition(prev, m, c) {
  let s = { ...prev, v2vMode: true, imageMode: false };
  // Single-input v2v (watermark remover etc.) — drop any image
  if (!m.imageField) s = { ...s, imageUrl: null };
  s = { ...s, modelId: m.id, modelName: m.name };
  return applyModelDefaults(s, c);
}

export function selectRegularModelTransition(prev, m, c) {
  let s = prev;
  if (s.v2vMode) s = { ...s, v2vMode: false, videoUrl: null, videoName: null };
  s = { ...s, modelId: m.id, modelName: m.name };
  return applyModelDefaults(s, c);
}

// selectHivemindWorkflowModel (old 1208-1232) — caller checks target exists.
export function selectHivemindWorkflowTransition(prev, target, c) {
  let s = prev;
  if (s.v2vMode) s = { ...s, v2vMode: false, videoUrl: null, videoName: null };
  s = { ...s, imageMode: true, localMode: true, modelId: target.id, modelName: target.name };
  return applyModelDefaults(s, c);
}

// "+ New" full reset (old newPromptBtn, 2940-2962).
export function newPromptTransition(prev, c) {
  const s = {
    ...prev,
    prompt: '',
    imageUrl: null,
    endImageUrl: null,
    ltxMiddleUrl: null,
    ltxEndUrl: null,
    matchStartFrameAr: true,
    // Post-generation grain cleanup: '' (off), 'light', 'strong'.
    denoise: '',
    imageMode: false,
    videoUrl: null,
    videoName: null,
    v2vMode: false,
    modelId: c.allT2V[0].id,
    modelName: c.allT2V[0].name,
  };
  return applyModelDefaults(s, c);
}

// Extend flow (old extendBtn, 2964-2978).
export function extendTransition(prev, c) {
  const s = {
    ...prev,
    prompt: '',
    imageUrl: null,
    imageMode: false,
    modelId: 'seedance-v2.0-extend',
    modelName: 'Seedance 2.0 Extend',
  };
  return applyModelDefaults(s, c);
}

// Restore persisted preferences (old restorePersistedVideoPreferences, 1126-1206).
// Returns null when the saved model no longer resolves. Resolution priority is
// v2v -> i2v -> t2v, exactly as the old code.
export function applyRestoredPreferences(prev, preferences, c) {
  if (!preferences) return null;
  const v2vModel = v2vModels.find((model) => model.id === preferences.modelId);
  const i2vModel = c.allI2V.find((model) => model.id === preferences.modelId);
  const t2vModel = c.allT2V.find((model) => model.id === preferences.modelId);
  const target = v2vModel || i2vModel || t2vModel;
  if (!target) return null;
  let s = {
    ...prev,
    v2vMode: Boolean(v2vModel),
    imageMode: !v2vModel && Boolean(i2vModel),
    modelId: target.id,
    modelName: target.name,
    localMode: preferences.localMode ?? isLocalVideoModel(target.id),
  };
  s = applyModelDefaults(s, c);
  const matchingDuration = durationsFor(s, s.modelId)
    .find((duration) => Number(duration) === preferences.duration);
  if (matchingDuration != null) s.duration = matchingDuration;
  const restoreChoice = (values, saved, apply) => {
    const match = values.find((value) => String(value) === String(saved));
    if (match != null) apply(match);
  };
  restoreChoice(aspectRatiosFor(s, s.modelId), preferences.aspectRatio, (value) => { s.ar = value; });
  restoreChoice(resolutionsFor(s, s.modelId), preferences.resolution, (value) => { s.resolution = value; });
  restoreChoice(qualitiesFor(s, c, s.modelId), preferences.quality, (value) => { s.quality = value; });
  restoreChoice(modesFor(s.modelId), preferences.mode, (value) => { s.mode = value; });
  restoreChoice(effectNamesFor(s, c, s.modelId), preferences.effectName, (value) => { s.effectName = value; });
  if (typeof preferences.matchStartFrameAr === 'boolean') s.matchStartFrameAr = preferences.matchStartFrameAr;
  if (['light', 'strong', ''].includes(preferences.denoise)) s.denoise = preferences.denoise;
  if (typeof preferences.seed === 'number') s.seed = preferences.seed;
  s.advancedValues = getRestoredAdvancedVideoValues(target, preferences.advancedValues);
  return s;
}

// Restore a captured generation context (old restoreGenerationContext, 2831-2909).
// Returns { setup, model } or null; the caller handles loras/ingredients/persist.
export function applyGenerationContext(prev, context, c) {
  if (!context?.model) return null;
  const s0 = { ...prev, imageMode: Boolean(context.imageMode), v2vMode: Boolean(context.v2vMode) };
  const model = modelsFor(s0, c).find((entry) => entry.id === context.model);
  if (!model) return null;
  let s = {
    ...s0,
    modelId: context.model,
    modelName: context.modelName || model.name,
    imageUrl: context.imageUrl || null,
    endImageUrl: context.endImageUrl || null,
    videoUrl: context.videoUrl || null,
    videoName: context.videoName || null,
    prompt: context.prompt || '',
  };
  s = applyModelDefaults(s, c);
  s.ar = context.aspectRatio || s.ar;
  s.duration = context.duration ?? s.duration;
  s.resolution = context.resolution ?? s.resolution;
  s.quality = context.quality ?? s.quality;
  s.mode = context.mode ?? s.mode;
  s.effectName = context.effectName ?? s.effectName;
  s.advancedValues = {
    ...getDefaultAdvancedVideoValues(model),
    ...(context.advancedValues || {}),
  };
  return { setup: s, model };
}

/* ------------------------------------------------------------------ */
/* Ingredients helpers                                                 */
/* ------------------------------------------------------------------ */

// Fallback chain (old getIngredientsWorkflow, 955-961).
export function getIngredientsWorkflow(s, hivemindI2V) {
  const selected = hivemindI2V.find((model) => model.id === s.modelId && model.supportsIngredientImages);
  return selected
    || hivemindI2V.find((model) => model.workflowId === 'ltx23-ic-ingredients-lora')
    || hivemindI2V.find((model) => model.supportsIngredientImages)
    || null;
}

export function currentIngredientModel(s, c) {
  const model = currentModel(s, c);
  return model?.provider === 'hivemind-media-studio' && model.supportsIngredientImages ? model : null;
}

// The references the next generation actually conditions on (old 1336-1341).
export function activeIngredientSheetItems(ingredientModel, ing) {
  if (!ingredientModel) return [];
  if (ing.selectedSheet === 'stitched') return ing.selections;
  const sheet = ing.sheets.find((entry) => entry.url === ing.selectedSheet) || null;
  return sheet ? [sheet] : [];
}

export function ingredientSelectionSignature(model, selection, ar) {
  return JSON.stringify([
    Boolean(model),
    ar,
    ...selection.map((item) => item.url),
  ]);
}

// History privacy: Hivemind prompts never persist (old 2677-2681).
export const redactPrivateHistoryEntry = (entry) => (
  isHivemindVideoModelId(entry?.model)
    ? { ...entry, prompt: '', prompt_private: true }
    : entry
);
