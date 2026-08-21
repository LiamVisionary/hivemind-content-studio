// Lip Sync studio preference persistence — extracted from LipSyncStudio.jsx so the
// normalizer has an importable surface (node:test cannot load .jsx). Same split as
// image/imagePrefs.js and video/videoLogic.js.
export const LIPSYNC_PREFERENCES_KEY = 'lipsync_generation_preferences';

export function normalizeLipSyncPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const inputMode = value.inputMode === 'video' ? 'video' : 'image';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  if (!modelId) return null;
  return {
    inputMode,
    modelId,
    resolution: typeof value.resolution === 'string' ? value.resolution.trim() : '',
  };
}
