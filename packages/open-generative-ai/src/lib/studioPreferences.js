// Persisted-settings normalizers for the studios whose rules are small enough to
// state in one function each.
//
// They live in src/lib rather than beside their components for the same reason
// videoTasks.js does: the node:test suite cannot load JSX, so a rule kept inside
// a .jsx file is a rule nothing can test. This one previously existed twice —
// once in the shipped React studio and once in the retired vanilla one — and the
// test imported the retired copy, so the shipped behaviour was unverified and
// the two were free to drift apart. One definition, imported by the studio,
// exercised by the test.

export const LIPSYNC_PREFERENCES_KEY = 'lipsync_generation_preferences';

/** null = nothing worth restoring (no model id means no usable selection). */
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

