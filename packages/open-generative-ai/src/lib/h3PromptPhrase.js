// Writing ONE sentence into a video prompt, and taking it out again.
//
// Three doors now do this — performance direction (emotionDirection.js), the
// fight-preset direction (h3CombatPreset.js), and anything that follows them —
// and all three hit the same two hazards, which is why the rules live here
// rather than in whichever module needed them first:
//
//   1. An H3 prompt ENDS in `non_diegetic_music:`, so a plain append writes
//      acting direction into the music field. The phrase belongs at the end of
//      the DESCRIPTION, in both of H3's native formats — the starters and the
//      helper write three-field, reference mode writes six-section — so never
//      gate on one of them (see h3References.parseFieldPrompt and
//      castPrompt.parseSixSections).
//
//   2. Stripping has to be surgical. cameraMotion's stripCameraMotionPhrase
//      tidies whitespace across the WHOLE string, and H3's formats are
//      whitespace-significant — the fields are separated by blank lines — so
//      that tidy flattens a three-field prompt onto one line, parseFieldPrompt
//      stops recognising it, and the next selection lands past the end in the
//      music field again.
import { parseFieldPrompt } from './h3References.js';
import { formatSixSections, isSixSectionPrompt, parseSixSections } from './castPrompt.js';

/**
 * Remove `phrase` and the whitespace that joined it, and touch nothing else.
 * Punctuation is left alone so a base that ended in a full stop comes back
 * byte for byte.
 */
export function stripPhrase(prompt, phrase) {
  const target = String(phrase || '').trim();
  if (!target) return String(prompt || '');
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(prompt || '').replace(new RegExp(`[ \\t]*\\n?[ \\t]*${escaped}`, 'g'), '');
}

/**
 * Put `phrase` at the end of an H3 prompt's DESCRIPTION, in either native
 * format, or null when the text is not an H3 prompt at all — the caller then
 * appends it the ordinary way.
 */
export function withPhraseInH3Description(prompt, phrase) {
  const fields = parseFieldPrompt(prompt);
  if (fields) {
    const body = [fields.integrated_multimodal_description, phrase].filter(Boolean).join('\n');
    return [
      fields.lead,
      `integrated_multimodal_description: ${body}`,
      `overall_soundscape: ${fields.overall_soundscape || ''}`.trim(),
      `non_diegetic_music: ${fields.non_diegetic_music || ''}`.trim(),
    ].filter(Boolean).join('\n\n');
  }
  if (isSixSectionPrompt(prompt)) {
    const sections = parseSixSections(prompt);
    return formatSixSections({
      ...sections,
      detailed_description: [sections.detailed_description, phrase].filter(Boolean).join('\n'),
    });
  }
  return null;
}

/**
 * Append `phrase` to `prompt` the way every phrase door does: into the H3
 * description when the text is an H3 prompt, after the prose otherwise.
 */
export function appendPhrase(prompt, phrase) {
  const base = String(prompt || '').trim();
  const text = String(phrase || '').trim();
  if (!text) return base;
  if (!base) return text;
  const inDescription = withPhraseInH3Description(base, text);
  if (inDescription) return inDescription;
  const separator = /[.!?]$/.test(base) ? ' ' : '. ';
  return `${base}${separator}${text}`;
}
