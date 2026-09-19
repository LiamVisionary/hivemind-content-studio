// Camera-angle variation prompts for image EDITS (Mix-Studio port, GPL-3.0
// lib/edit-angle.js): re-render the same subject from a new viewpoint. Two
// dialects — Qwen-family models get the terse trigger-token form, Klein gets a
// natural-language instruction whose clauses explicitly forbid collage/split-
// screen/turntable outputs (the classic failure mode of "show me the back").

export const ANGLE_AZIMUTHS = {
  front: 'front view',
  'front-right': 'front-right quarter view',
  right: 'right side view',
  'back-right': 'back-right quarter view',
  back: 'back view',
  'back-left': 'back-left quarter view',
  left: 'left side view',
  'front-left': 'front-left quarter view',
};
export const ANGLE_ELEVATIONS = ['low-angle', 'eye-level', 'elevated', 'high-angle'];
export const ANGLE_DISTANCES = ['close-up', 'medium shot', 'wide shot'];

export function normalizeEditAngle(value) {
  if (!value || typeof value !== 'object') return null;
  const angle = {};
  if (value.view && ANGLE_AZIMUTHS[String(value.view)]) angle.view = String(value.view);
  if (value.elevation && ANGLE_ELEVATIONS.includes(String(value.elevation))) angle.elevation = String(value.elevation);
  if (value.distance && ANGLE_DISTANCES.includes(String(value.distance))) angle.distance = String(value.distance);
  return Object.keys(angle).length ? angle : null;
}

export function qwenEditAnglePrompt(angle) {
  return [
    '<sks>',
    angle.view ? ANGLE_AZIMUTHS[angle.view] : '',
    angle.elevation ? `${angle.elevation} shot` : '',
    angle.distance || '',
  ].filter(Boolean).join(' ');
}

export function kleinEditAnglePrompt(angle) {
  const camera = [
    angle.view ? `from a ${ANGLE_AZIMUTHS[angle.view]}` : '',
    angle.elevation ? `using a ${angle.elevation} shot` : '',
    angle.distance ? `with ${angle.distance} framing` : '',
  ].filter(Boolean).join(', ');
  return [
    `Re-render the same subject ${camera}`,
    'Preserve the subject identity, clothing, proportions, materials, lighting, environment, and visual style',
    'Infer unseen surfaces as a coherent continuation of the same subject',
    'Show one image from only this new viewpoint; do not make a collage, split screen, turntable, or duplicate subject',
  ].join('. ');
}

export function editAnglePrompt(dialect, angle, userPrompt = '') {
  const instruction = dialect === 'qwen' ? qwenEditAnglePrompt(angle) : kleinEditAnglePrompt(angle);
  return [instruction, String(userPrompt || '').trim()].filter(Boolean).join('. ');
}

// Short human tag for history entries ("front-right · low-angle · close-up").
export function angleLabel(angle) {
  return [angle.view, angle.elevation, angle.distance].filter(Boolean).join(' · ');
}

// Which prompt dialect an installed local model speaks, or null when angle
// variations don't apply (no image input, or an unknown family).
export function angleDialectForModel(model) {
  if (!model) return null;
  const haystack = `${model.backend || ''} ${model.family || ''} ${model.id || ''}`.toLowerCase();
  if (haystack.includes('klein')) return 'klein';
  if (haystack.includes('qwen') || haystack.includes('anima')) return 'qwen';
  return null;
}
