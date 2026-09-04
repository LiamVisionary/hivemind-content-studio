// What a Prompt Check finding MEANS, in the reader's language.
//
// h3PromptCheck.js returns codes and numbers because the rules have to be
// testable without a browser; the sentences live here because this is where the
// studio speaks Chinese. Every line says the consequence, not the rule — "this
// cut never happens" rather than "cut > duration" — because the consequence is
// the part that tells someone whether to care.
// The six sections in plain words. H3 reads them positionally under their own
// field names; a reader should not have to. The field name itself survives in
// lib/castPrompt.js, which is what actually writes the document.
const SECTION_NAMES = {
  subject_definitions: () => 'who is in it',
  summary: () => 'the summary',
  retention_analysis: () => 'what carries over',
  detailed_description: () => 'what happens',
  overall_soundscape: () => 'the sound',
  non_diegetic_music: () => 'the music',
};

const sectionName = (name) => (SECTION_NAMES[name] ? SECTION_NAMES[name]() : name);
const seconds = (value) => `${(Number(value) || 0).toFixed(2)}s`;

// The reference budget already words itself in ReferencesMenu; here it only has
// to say enough to send someone to that panel.
function budgetText(problem) {
  switch (problem?.code) {
    case 'over-total':
      return `${problem.count} references attached — H3 takes ${problem.limit} (${problem.soundtracks} of them are clip soundtracks).`;
    case 'over-audio-clips':
      return `${problem.count} voice clips — H3 takes ${problem.limit}.`;
    case 'audio-without-visual':
      return 'A voice clip with no picture or clip to attach to.';
    case 'clip-too-short':
      return `A clip is ${problem.seconds}s — under the ${problem.limit}s floor.`;
    case 'clip-too-long':
      return `A clip is ${problem.seconds}s — over the ${problem.limit}s ceiling.`;
    case 'over-video-seconds':
      return `${problem.seconds}s of motion reference — the ceiling is ${problem.limit}s.`;
    case 'over-audio-seconds':
      return `${problem.seconds}s of audio — the ceiling is ${problem.limit}s, and ${problem.soundtracks} clip soundtrack(s) count toward it.`;
    default:
      return 'The reference budget has a problem.';
  }
}

/** One finding as a sentence. Returns '' for a code with nothing to say. */
export function describeCheckFinding(finding) {
  if (!finding) return '';
  if (finding.code.startsWith('budget:')) return budgetText(finding.budget);

  switch (finding.code) {
    case 'empty':
      return 'Nothing written yet.';

    case 'over-chars':
      return `${finding.count.toLocaleString()} characters — H3 takes ${finding.limit.toLocaleString()}, and the rest is cut off.`;
    case 'near-chars':
      return `${finding.count.toLocaleString()} characters, close to the ${finding.limit.toLocaleString()} ceiling.`;

    case 'no-sections':
      return 'References are attached but the prompt has no sections. With references H3 reads six fields; loose prose leaves it guessing who is who.';
    case 'partial-sections':
      return `Missing: ${finding.missing.map(sectionName).join(', ')}.`;
    case 'sections-out-of-order':
      return 'H3 reads the six fields positionally — out of order, the summary summarises nothing.';
    case 'empty-section':
      return `${sectionName(finding.section)} is empty.`;
    case 'no-soundscape':
      return 'Nothing says what this sounds like. H3 renders the audio too — unsaid means invented.';

    case 'shot-number':
      return `The ${finding.at}${finding.at === 2 ? 'nd' : finding.at === 3 ? 'rd' : 'th'} marker says [Shot ${finding.found}] — the numbering skips.`;
    case 'cut-past-end':
      return `[Shot ${finding.shot}] cuts at ${seconds(finding.cutSec)} but the clip is ${seconds(finding.duration)} — that shot never happens.`;
    case 'cut-out-of-order':
      return `[Shot ${finding.shot}] cuts at ${seconds(finding.cutSec)}, before the previous shot's ${seconds(finding.previous)}.`;
    case 'shot-no-cut':
      return `[Shot ${finding.shot}] has no timecode — where it cuts is the model's guess.`;

    case 'dialogue-unbalanced':
      return `${finding.opens} <d> and ${finding.closes} </d> — an unclosed line makes the model speak the description after it.`;
    case 'dialogue-no-language':
      return `Line ${finding.index} has no language tag (e.g. [English]) — the accent becomes the model's guess.`;
    case 'dialogue-empty':
      return `Line ${finding.index} has an empty <d> block.`;
    case 'scenetrans-unpaired':
      return `<scenetrans> is unpaired: ${finding.out} line(s) run on, ${finding.in} pick up.`;
    case 'cutoff-not-last':
      return `Line ${finding.index} carries <cutoff> but is not the last line — the clip is being told to end mid-word early.`;
    case 'speaker-ids-start':
      return `Speaker ids start at (S${finding.first}) — they number from (S1), in the order voices are first heard.`;
    case 'speaker-ids-skip':
      return `Speaker ids jump from (S${finding.after}) to (S${finding.found}).`;

    case 'tag-unbacked':
      if (!finding.attached) {
        return `The prompt names ${finding.tag} with none of that kind attached — the tag is ignored.`;
      }
      return `The prompt names ${finding.tag} but only ${finding.attached} ${finding.attached === 1 ? 'is' : 'are'} attached — that tag is ignored.`;
    case 'placeholder-left': {
      const where = finding.where ? sectionName(finding.where) : '';
      // Each blank fails in its own way, so each says what the clip will do.
      if (finding.blank === 'Write the line you want spoken here') {
        return 'The dialogue is still the placeholder — the model will read “Write the line you want spoken here” out loud, in the cloned voice.';
      }
      if (finding.blank === 'write it out') {
        return `The first person is still blank in ${where || 'who is in it'}. H3 takes identity from the words as much as from the pictures, so whoever the description describes is who you get — not the references you attached.`;
      }
      return `${where || 'The prompt'} still carries the placeholder “${finding.blank}” — the model will act on it.`;
    }
    case 'subject-not-in-scene':
      return `Person ${finding.subject} is defined but never appears in the summary or description — the model decides who fills that slot. Weave, or ask the helper to write them into the scene.`;
    case 'pictures-unnamed':
      return `${finding.count} picture${finding.count === 1 ? '' : 's'} attached, but the prompt never refers to them — the model is not told what to do with them.`;
    case 'motion-unnamed':
      return `${finding.labels.join(', ')} ${finding.labels.length === 1 ? 'is' : 'are'} never named in the prompt.`;
    case 'motion-no-exclusion':
      return 'A picture and a motion clip, with nothing saying what must NOT carry from the clip — its performer can replace your character.';

    case 'voice-without-line':
      return 'A voice reference with no <d> line — the cloned voice has nothing to say, so the model invents words.';
    case 'unscripted-time':
      return `About ${finding.spoken}s of speech in a ${finding.duration}s clip leaves ~${finding.gap}s unaccounted for — the model tends to fill it with invented speech.`;
    case 'overscripted-time':
      return `About ${finding.spoken}s of speech in a ${seconds(finding.duration)} clip — the model does not speed up, it runs out.`;

    default:
      return finding.code;
  }
}

/** The chip's one-line verdict. */
export function checkSummaryText(result) {
  if (!result) return '';
  if (result.findings.length === 1 && result.findings[0].code === 'empty') {
    return 'Nothing to check yet';
  }
  if (!result.findings.length) return 'Nothing to flag';
  const bits = [];
  if (result.errors) bits.push(`${result.errors} will break`);
  if (result.warnings) bits.push(`${result.warnings} worth a look`);
  return bits.join(' · ');
}
