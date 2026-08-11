// MiniMax H3 restyle presets — six visual-treatment prompts ported verbatim
// from Mix-Studio (GPL-3.0, public/h3-prompt-guide.js STYLE_TRANSFER_PRESETS).
// Applied as ONE idempotent "Visual style: …" phrase (same replace-not-stack
// contract as camera motions), so switching styles never accumulates text.
import { stripCameraMotionPhrase } from './cameraMotion.js';

export const H3_RESTYLE_PRESETS = Object.freeze([
  { id: 'live-action', label: 'Live action', hint: 'Cinematic and photoreal', prompt: 'cinematic photoreal live action with natural skin and material detail, physically plausible lighting, realistic depth, restrained film grain, and consistent production design' },
  { id: 'anime-2d', label: 'Anime 2D', hint: 'Drawn lines and cel shading', prompt: 'polished hand-drawn 2D anime with clean confident line art, stable cel shading, expressive but proportionally consistent faces, controlled highlights, and a cohesive cinematic color script' },
  { id: 'feature-3d', label: 'Feature 3D', hint: 'Polished feature animation', prompt: 'polished stylized 3D feature animation with appealing rounded character design, expressive readable faces, detailed materials, soft global illumination, cinematic depth, and high-end animated-film rendering' },
  { id: 'cel-3d', label: 'Cel-shaded 3D', hint: 'Graphic 3D with inked edges', prompt: 'stylized cel-shaded 3D animation with stable inked contours, deliberate two-tone shadow shapes, crisp graphic highlights, dimensional camera movement, and cohesive game-cinematic rendering' },
  { id: 'stop-motion', label: 'Stop motion', hint: 'Handmade miniature look', prompt: 'premium handcrafted stop-motion animation with tactile miniature sets, sculpted characters, visible material texture, practical lighting, subtle frame-by-frame motion character, and consistent scale' },
  { id: 'graphic-novel', label: 'Graphic novel', hint: 'Bold ink and printed color', prompt: 'cinematic graphic-novel illustration with bold stable inks, dramatic shape-based shadows, controlled halftone texture, selective printed color, and consistent illustrated anatomy' },
]);

const BY_ID = new Map(H3_RESTYLE_PRESETS.map((preset) => [preset.id, preset]));

export function restylePresetById(id) {
  return BY_ID.get(String(id || '')) || null;
}

export function restylePhrase(id) {
  const preset = restylePresetById(id);
  return preset ? `Visual style: ${preset.prompt}.` : '';
}

// Replace the previously applied style phrase (if any) with the new one.
// Passing a falsy id just strips — that is how "no style" works.
export function applyRestylePrompt(prompt, previousId, nextId) {
  const base = stripCameraMotionPhrase(prompt, restylePhrase(previousId));
  const phrase = restylePhrase(nextId);
  if (!phrase) return { prompt: base, id: null };
  if (!base) return { prompt: phrase, id: nextId };
  const separator = /[.!?]$/.test(base) ? ' ' : '. ';
  return { prompt: `${base}${separator}${phrase}`, id: nextId };
}
