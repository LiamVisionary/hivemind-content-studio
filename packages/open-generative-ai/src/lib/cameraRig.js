// Camera rig — the body / lens / focal / aperture sentence, as a composer scaffold.
//
// This was a studio of its own (Cinema) whose entire job was to append
// buildNanoBananaPrompt's rig clause and send it to one hardcoded cloud model.
// The clause is model-agnostic prose, so it belongs in the Image composer beside
// UGC mode and the style presets — where it works with every provider, with
// references, and with a real history.
//
// Same transparency contract as UGC mode: the text lands in the prompt where it
// can be read and edited, and re-arming REPLACES it instead of stacking. The
// block is found by its opening and closing fragments rather than by exact
// match, so a rig the user has edited by hand still comes out cleanly.

import { APERTURE_EFFECT, CAMERA_MAP, FOCAL_PERSPECTIVE, LENS_MAP, buildNanoBananaPrompt } from './promptUtils.js';

// buildNanoBananaPrompt always opens the clause with "shot on a <body>" and
// closes it with the last quality tag. Both are anchors, not the whole block.
export const CAMERA_RIG_OPENING = 'shot on a ';
export const CAMERA_RIG_CLOSING = '8K resolution';

export const CAMERA_OPTIONS = Object.freeze(Object.keys(CAMERA_MAP));
export const LENS_OPTIONS = Object.freeze(Object.keys(LENS_MAP));
export const FOCAL_OPTIONS = Object.freeze(Object.keys(FOCAL_PERSPECTIVE).map(Number));
export const APERTURE_OPTIONS = Object.freeze(Object.keys(APERTURE_EFFECT));

export const DEFAULT_CAMERA_RIG = Object.freeze({
  camera: CAMERA_OPTIONS[0],
  lens: LENS_OPTIONS[0],
  focal: 35,
  aperture: 'f/1.4',
});

/**
 * Every field falls back to its default, so a partially corrupt blob still
 * yields a complete, valid rig rather than a half-applied one. Bounded by the
 * option banks above — nothing else can reach the prompt through here.
 */
export function normalizeCameraRig(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const focal = Number(source.focal);
  return {
    camera: CAMERA_OPTIONS.includes(source.camera) ? source.camera : DEFAULT_CAMERA_RIG.camera,
    lens: LENS_OPTIONS.includes(source.lens) ? source.lens : DEFAULT_CAMERA_RIG.lens,
    focal: FOCAL_OPTIONS.includes(focal) ? focal : DEFAULT_CAMERA_RIG.focal,
    aperture: APERTURE_OPTIONS.includes(source.aperture) ? source.aperture : DEFAULT_CAMERA_RIG.aperture,
  };
}

/** The rig clause on its own — what arming appends, and what the menu previews. */
export function cameraRigSentence(rig) {
  const r = normalizeCameraRig(rig);
  return buildNanoBananaPrompt('', r.camera, r.lens, r.focal, r.aperture);
}

// Whether the rig is on is a property of the PROMPT, not of a flag beside it.
// "Start fresh", loading a saved prompt, or restoring a generation's settings
// all replace the prompt without knowing about the rig; reading the block back
// is what keeps the chip from claiming a rig the composer no longer holds.
export function hasCameraRig(prompt) {
  const source = String(prompt || '');
  const start = source.indexOf(CAMERA_RIG_OPENING);
  return start >= 0 && source.indexOf(CAMERA_RIG_CLOSING, start) > start;
}

/**
 * Cut a previously applied rig out, from its opening fragment through its
 * closing one — plus the comma that joined it to the sentence before it.
 * Anchored rather than matched whole so an edited rig still comes out cleanly.
 */
export function stripCameraRig(prompt) {
  const source = String(prompt || '');
  if (!hasCameraRig(source)) return source.trim();
  const start = source.indexOf(CAMERA_RIG_OPENING);
  const end = source.indexOf(CAMERA_RIG_CLOSING, start) + CAMERA_RIG_CLOSING.length;
  const head = source.slice(0, start).replace(/[,\s]+$/, '');
  const tail = source.slice(end);
  return `${head}${tail}`.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Arm (or re-arm, or clear) the camera rig on a prompt. Passing a null rig
 * strips. Re-arming strips first, so five tweaks leave ONE rig clause, never a
 * stack of them.
 */
export function applyCameraRig(prompt, rig) {
  const base = stripCameraRig(prompt);
  if (!rig) return base;
  const block = cameraRigSentence(rig);
  if (!base) return block;
  return `${base}${/[,.!?;:]$/.test(base) ? ' ' : ', '}${block}`;
}
