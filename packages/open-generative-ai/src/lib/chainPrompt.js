// Scene-chaining prompt continuity (MiniMax H3 Motion Context).
//
// The pinned context frames guarantee motion and room tone carry across the
// cut — they do NOT stop the model from cutting to a different scene when the
// prompt describes one. Upstream's measured guidance (ComfyUI-H3-Motion-Context
// README, "Writing prompts for a chain"): a chained prompt must keep describing
// the SAME scene — subjects, art style, palette — and open by holding the
// previous shot's closing framing for a beat (the "airlock") before anything
// changes. Prompts that open on a new arrangement render as a hard cut into an
// unrelated take ("two different rooms spliced together"), which reads to the
// user as the chain being ignored.
//
// Live-verified on the rented H3 lane (2026-08-10): a chained shot whose
// prompt kept the scene words continued seamlessly; the mechanism itself never
// drops the pin. So continuity is a PROMPT property, and this module makes the
// prompt carry it: arming a chain keeps whatever the composer holds (the
// previous shot's description, with its style/subject words) and appends one
// visible scaffold sentence the user finishes with the next beat. Same
// transparency contract as the camera-motion phrases — the text lives in the
// prompt where the user can see and edit it.

export const CHAIN_CONTINUITY_PHRASE =
  'The camera keeps rolling on this same scene without a cut — same subjects, '
  + 'same art style, same palette. Hold the closing framing for a breath, then:';

/**
 * Arm a prompt for a chained shot: append the continuity scaffold exactly once,
 * preserving the existing description (whose style/subject words the model
 * needs to keep the scene). The caller puts the caret after the trailing space
 * so the user types what happens next.
 */
export function armChainPrompt(prompt) {
  const text = String(prompt || '').trim();
  if (text.includes(CHAIN_CONTINUITY_PHRASE)) return text;
  return text ? `${text}\n\n${CHAIN_CONTINUITY_PHRASE} ` : `${CHAIN_CONTINUITY_PHRASE} `;
}
