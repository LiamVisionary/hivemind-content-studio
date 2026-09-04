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
import { cloudCatalogReady, t2iModels } from '../../../lib/cloudCatalog.js';
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

export async function openLocalImageModel(modelId) {
  // The cloud catalog is served, so the studio's own default lane model is not
  // known until it lands. Waiting here costs a handoff nothing and keeps the
  // written preference valid — an empty cloud modelId is rejected on arrival.
  await cloudCatalogReady();
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
  updateComposerSection('image', { preferences });
  writeJson(IMAGE_PREFERENCES_KEY, stripPromptText(preferences));
  navigate('image');
}

export function openLocalVideoModel(modelId) {
  const current = normalizeVideoPreferences(readJson(VIDEO_PREFERENCES_KEY)) || {};
  writeJson(VIDEO_PREFERENCES_KEY, { ...current, modelId: String(modelId) });
  navigate('video');
}

export async function openModelInStudio(model) {
  if (!model?.id) return;
  if (String(model.type || '').toLowerCase() === 'video') openLocalVideoModel(model.id);
  else await openLocalImageModel(model.id);
}
