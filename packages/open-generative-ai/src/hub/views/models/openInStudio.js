// "Open in studio" — preselect a model in a studio, then navigate to it.
//
// The studios boot their state from persisted preferences (the studio remounts on
// every navigation), so handing a model over means writing the same preference the
// studio's own picker writes and then routing. Two details matter:
//   - the image studio reads the WARM encrypted composer cache first and only falls
//     back to localStorage, so writing localStorage alone would be overwritten by
//     the cache on arrival. Both are updated here.
//   - prompt text never goes to localStorage (it stays in the encrypted composer),
//     so the localStorage copy is written without the negative prompt.
import { getComposerSection, updateComposerSection } from '../../../lib/composerState.js';
import { t2iModels } from '../../../lib/models.js';
import { IMAGE_PREFERENCES_KEY, normalizeImagePreferences } from '../../../studios/image/imagePrefs.js';
import { VIDEO_PREFERENCES_KEY, normalizeVideoPreferences } from '../../../studios/video/videoLogic.js';

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* quota */ }
}

function stripPromptText(preferences) {
  const { negativePrompt: _negative, ...rest } = preferences;
  if (rest.modelSettings && typeof rest.modelSettings === 'object') {
    rest.modelSettings = Object.fromEntries(
      Object.entries(rest.modelSettings).map(([key, entry]) => {
        if (!entry || typeof entry !== 'object') return [key, entry];
        const { negativePrompt: _entryNegative, ...entryRest } = entry;
        return [key, entryRest];
      }),
    );
  }
  return rest;
}

function navigate(page) {
  window.dispatchEvent(new CustomEvent('navigate', { detail: { page } }));
}

export function openLocalImageModel(modelId, { prompt = '' } = {}) {
  const current = normalizeImagePreferences(
    getComposerSection('image').preferences || readJson(IMAGE_PREFERENCES_KEY),
  );
  const preferences = {
    // normalizeImagePreferences rejects preferences without a cloud `modelId`, so a
    // first-run handoff has to carry the studio's own default for that lane —
    // otherwise the studio would drop the whole object and boot on defaults.
    ...(current || { modelId: t2iModels[0]?.id || '' }),
    useLocalModel: true,
    localModelId: String(modelId),
  };
  // A starter prompt is prompt text, so it travels the ONE way prompt text is
  // allowed to travel: the encrypted composer section the studio hydrates from.
  // It never reaches the localStorage copy below (stripPromptText), and the
  // studio only adopts it when its own box is still empty.
  const draft = String(prompt || '').trim();
  updateComposerSection('image', { preferences, ...(draft ? { prompt: draft } : {}) });
  writeJson(IMAGE_PREFERENCES_KEY, stripPromptText(preferences));
  navigate('image');
}

export function openLocalVideoModel(modelId) {
  const current = normalizeVideoPreferences(readJson(VIDEO_PREFERENCES_KEY)) || {};
  writeJson(VIDEO_PREFERENCES_KEY, { ...current, modelId: String(modelId) });
  navigate('video');
}

export function openModelInStudio(model, { prompt = '' } = {}) {
  if (!model?.id) return;
  if (String(model.type || '').toLowerCase() === 'video') openLocalVideoModel(model.id);
  else openLocalImageModel(model.id, { prompt });
}
