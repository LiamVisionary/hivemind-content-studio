// Persisted-settings normalizers for the studios whose rules are small enough to
// state in one function each.
//
// They live in src/lib rather than beside their components for the same reason
// videoTasks.js does: the node:test suite cannot load JSX, so a rule kept inside
// a .jsx file is a rule nothing can test. Both of these previously existed twice
// — once in the shipped React studio and once in the retired vanilla one — and
// the test imported the retired copy, so the shipped behaviour was unverified
// and the two were free to drift apart. One definition, imported by the studio,
// exercised by the test.

import { APERTURE_EFFECT, CAMERA_MAP, FOCAL_PERSPECTIVE, LENS_MAP } from './promptUtils.js';

export const LIPSYNC_PREFERENCES_KEY = 'lipsync_generation_preferences';
export const CINEMA_PREFERENCES_KEY = 'cinema_generation_preferences';

export const CINEMA_ASPECT_RATIOS = ['16:9', '21:9', '9:16', '1:1', '4:5'];
export const CINEMA_RESOLUTIONS = ['1K', '2K', '4K'];

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

/** Every field falls back to its default, so a partially corrupt blob still
 *  yields a complete, valid camera setup rather than a half-applied one. */
export function normalizeCinemaPreferences(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const camera = Object.keys(CAMERA_MAP).includes(value.camera) ? value.camera : Object.keys(CAMERA_MAP)[0];
    const lens = Object.keys(LENS_MAP).includes(value.lens) ? value.lens : Object.keys(LENS_MAP)[0];
    const focalOptions = Object.keys(FOCAL_PERSPECTIVE).map(Number);
    const focal = focalOptions.includes(Number(value.focal)) ? Number(value.focal) : 35;
    const aperture = Object.keys(APERTURE_EFFECT).includes(value.aperture) ? value.aperture : 'f/1.4';
    return {
        aspect_ratio: CINEMA_ASPECT_RATIOS.includes(value.aspect_ratio) ? value.aspect_ratio : '16:9',
        resolution: CINEMA_RESOLUTIONS.includes(value.resolution) ? value.resolution : '2K',
        camera,
        lens,
        focal,
        aperture,
    };
}
