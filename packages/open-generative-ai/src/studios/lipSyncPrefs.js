// Lip sync studio preferences — extracted from LipSyncStudio.jsx so the
// normalizer can be imported and tested on its own (same split as
// image/imagePrefs.js). Pure module: no DOM, no React.

export const LIPSYNC_PREFERENCES_KEY = 'lipsync_generation_preferences';

// A stored blob naming no model is rejected outright rather than defaulted: the
// available models depend on inputMode, so the studio picks the first compatible
// one itself instead of persisting a guess here.
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
