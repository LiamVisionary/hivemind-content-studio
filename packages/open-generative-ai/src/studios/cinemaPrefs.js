// Cinema studio preferences — extracted from CinemaStudio.jsx so the normalizer
// can be imported and tested on its own (same split as image/imagePrefs.js).
// Pure module: no DOM, no React.
import { APERTURE_EFFECT, CAMERA_MAP, FOCAL_PERSPECTIVE, LENS_MAP } from '../lib/promptUtils.js';

export const CINEMA_PREFERENCES_KEY = 'cinema_generation_preferences';
export const CINEMA_ASPECT_RATIOS = ['16:9', '21:9', '9:16', '1:1', '4:5'];
export const CINEMA_RESOLUTIONS = ['1K', '2K', '4K'];

// Every field falls back to a supported value rather than being dropped, so a
// preferences blob written by an older build (or one naming a camera/lens that
// has since been removed from the maps) still boots the studio.
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
