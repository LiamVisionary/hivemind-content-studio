// Prompt Check — everything that can be known about an H3 prompt before it
// costs a generation.
//
// H3 fails quietly. A cut stamped past the end of the clip does not error, it
// just never happens; a <d> block with no language tag is read in whatever
// accent the model picks; a <Picture 4> in the text with three pictures
// attached is silently ignored, and the shot it was meant to describe comes
// back wrong. None of that is visible until the clip lands, and by then it has
// been paid for. So this runs on the prompt as WRITTEN — hand-typed, pasted
// from the library, or assembled by the Shot Builder, it makes no difference.
//
// It gathers rather than duplicates: the reference budget, the motion-takeover
// warning and the unscripted-time warning already exist in h3References.js and
// are folded in here so there is one gate instead of three scattered notes.
//
// Findings are CODES with data, not sentences — the wording lives in
// studios/video/promptCheckText.js, which is where the studio speaks Chinese.
import {
  motionReferenceRows,
  motionReferenceWarning,
  referenceBudgetReport,
  referenceLabels,
  spokenSecondsIn,
  unscriptedTimeWarning,
} from './h3References.js';

// Published H3 ceilings. The reference counts live in H3_REFERENCE_LIMITS;
// these are the ones only the prompt text can be measured against.
export const H3_PROMPT_LIMITS = Object.freeze({
  chars: 7000,
  // Past this the ceiling is close enough to be worth saying before an edit
  // pushes it over mid-session.
  charsWarnAt: 6300,
});

const SECTIONS = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'];

/**
 * The blanks the studio's own scaffolds leave for the author to fill.
 *
 * Every one of them is a sentence the model will happily act on. Liam generated
 * on 2026-08-23 with the dialogue stub still in place and the clip said the stub
 * out loud, in his cloned voice; the subject blank in the same prompt meant the
 * only description of a person was the one the pasted starter carried, so the
 * clip showed a stranger with his voice. A blank that reaches the model is not a
 * blank, it is an instruction.
 *
 * Matched as literal text rather than "any [bracket]", because H3's own grammar
 * is full of legitimate brackets — [Shot 2], [English], [audio reference].
 * referenceFrameBlanksTest in the suite pins that every blank the scaffolds
 * actually write appears here, so a new placeholder cannot be added silently.
 */
export const SCAFFOLD_BLANKS = Object.freeze([
  'write it out',
  'describe what is heard',
  'Write the line you want spoken here',
  '[setting]',
  '[lighting]',
]);

/** Which of the six sections an offset falls inside, or '' above the first one. */
function sectionHolding(text, at) {
  let name = '';
  for (const match of String(text).matchAll(new RegExp(`(?:^|\\n)\\s*(${SECTIONS.join('|')})\\s*:`, 'gi'))) {
    if (match.index > at) break;
    name = match[1].toLowerCase();
  }
  return name;
}

const error = (code, data = {}) => ({ level: 'error', code, ...data });
const warn = (code, data = {}) => ({ level: 'warn', code, ...data });

/** Which of H3's six sections the prompt actually has, in the order found. */
export function sectionsIn(prompt) {
  const text = String(prompt || '');
  const found = [];
  for (const match of text.matchAll(new RegExp(`(?:^|\\n)\\s*(${SECTIONS.join('|')})\\s*:`, 'gi'))) {
    const name = match[1].toLowerCase();
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * The body of one of H3's six sections, or null when the prompt has no such
 * section. Exported because the Shot Builder rewrites the description half of a
 * prompt and has to leave the cast's half — subject_definitions and
 * retention_analysis — exactly as the cast wrote it.
 */
export const sectionBodyIn = (prompt, name) => {
  const text = String(prompt || '');
  const start = new RegExp(`(?:^|\\n)\\s*${name}\\s*:[ \\t]*`, 'i').exec(text);
  if (!start) return null;
  const rest = text.slice(start.index + start[0].length);
  const next = new RegExp(`\\n\\s*(?:${SECTIONS.join('|')})\\s*:`, 'i').exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
};

/** Every `[Shot N] At mm:ss.mmm, …` marker the prompt carries, in order. */
export function shotMarkers(prompt) {
  const text = String(prompt || '');
  const out = [];
  for (const match of text.matchAll(/\[Shot\s+(\d+)\]([^[]*)/gi)) {
    // The keyframe anchor sentence back-REFERENCES a shot rather than opening
    // one: "…<Picture 1> (from [Shot 1]) is fully referenced." Counting it made
    // every image-to-video prompt — the form prompt_profiles._MINIMAX_H3_I2VA
    // tells the helper to emit verbatim — report that its shot numbering skips
    // and that its first shot has no cut. Only this one construction is
    // excused; a marker is otherwise a header wherever it sits, because the
    // shipped prompts legitimately open shots mid-paragraph.
    if (/\(from\s+$/i.test(text.slice(0, match.index))) continue;
    const stamp = /At\s+(\d{1,2}):(\d{2})\.(\d{1,3})/i.exec(match[2] || '');
    out.push({
      number: Number(match[1]),
      cutSec: stamp
        ? Number(stamp[1]) * 60 + Number(stamp[2]) + Number(String(stamp[3]).padEnd(3, '0')) / 1000
        : null,
    });
  }
  return out;
}

/** Every `<d>…</d>` block, with the language tag it declares (or does not). */
export function dialogueBlocks(prompt) {
  const text = String(prompt || '');
  return (text.match(/<d>[\s\S]*?<\/d>/g) || []).map((block) => {
    const inner = block.replace(/^<d>/, '').replace(/<\/d>$/, '');
    const lang = /^\s*(?:<scenetrans>\s*)?\[([^\]]+)\]/.exec(inner);
    return {
      block,
      lang: lang ? lang[1].trim() : '',
      carriesIn: /^\s*(?:\[[^\]]*\]\s*)?<scenetrans>/.test(inner),
      carriesOut: /<scenetrans>\s*(?:<cutoff>\s*)?$/.test(inner),
      cutoff: /<cutoff>/.test(inner),
      words: inner.replace(/<[^>]*>/g, '').replace(/^\s*\[[^\]]*\]\s*/, '').trim(),
    };
  });
}

/** Speaker ids the prompt uses, as written: "(S1)", "(S2)" … */
export function speakerIdsIn(prompt) {
  const found = String(prompt || '').match(/\(S(\d+)\)/g) || [];
  return [...new Set(found.map((token) => Number(token.replace(/\D/g, ''))))].sort((a, b) => a - b);
}

/** Reference tags the prompt names, split by kind. */
export function referenceTagsIn(prompt) {
  const out = { Picture: new Set(), Video: new Set(), Audio: new Set(), Subject: new Set() };
  for (const match of String(prompt || '').matchAll(/<(Subject|Picture|Video|Audio)\s+(\d+)>/g)) {
    out[match[1]].add(Number(match[2]));
  }
  return out;
}

/**
 * The whole check.
 *
 * `prompt` is the only required input — everything else sharpens it. With no
 * references passed, the reference findings simply do not fire, which is what
 * makes this usable on a prompt in the library that has no run behind it yet.
 */
export function checkH3Prompt({
  prompt = '',
  durationSeconds = 0,
  images = [],
  videos = [],
  audios = [],
  durations = {},
} = {}) {
  const text = String(prompt || '');
  const findings = [];
  const duration = Number(durationSeconds) || 0;

  if (!text.trim()) {
    return { findings: [warn('empty')], errors: 0, warnings: 1, ok: true, sections: [], mode: 'plain' };
  }

  // ── length ────────────────────────────────────────────────────────────────
  if (text.length > H3_PROMPT_LIMITS.chars) {
    findings.push(error('over-chars', { count: text.length, limit: H3_PROMPT_LIMITS.chars }));
  } else if (text.length > H3_PROMPT_LIMITS.charsWarnAt) {
    findings.push(warn('near-chars', { count: text.length, limit: H3_PROMPT_LIMITS.chars }));
  }

  // ── structure ─────────────────────────────────────────────────────────────
  const sections = sectionsIn(text);
  const motion = motionReferenceRows(videos);
  const referenced = images.length > 0 || motion.length > 0 || audios.length > 0;
  const mode = referenced ? 'reference' : 'plain';

  if (referenced && !sections.length) findings.push(warn('no-sections'));
  else if (referenced && sections.length < SECTIONS.length) {
    findings.push(warn('partial-sections', { missing: SECTIONS.filter((name) => !sections.includes(name)) }));
  }
  // Written in the six-section form but out of order: H3 reads the sections
  // positionally, and a summary below the description is a summary of nothing.
  if (sections.length > 1) {
    const expected = SECTIONS.filter((name) => sections.includes(name));
    if (expected.join('|') !== sections.join('|')) findings.push(warn('sections-out-of-order', { order: sections }));
  }
  for (const name of ['overall_soundscape', 'non_diegetic_music']) {
    if (sections.includes(name) && !sectionBodyIn(text, name)) findings.push(warn('empty-section', { section: name }));
  }
  // H3 renders the audio. A prompt with no soundscape at all gets whatever the
  // model invents, which is the single most common surprise in a finished clip.
  if (!sections.includes('overall_soundscape')) findings.push(warn('no-soundscape'));

  // ── blanks the scaffold left behind ───────────────────────────────────────
  for (const blank of SCAFFOLD_BLANKS) {
    const at = text.toLowerCase().indexOf(blank.toLowerCase());
    if (at < 0) continue;
    findings.push(error('placeholder-left', { blank, where: sectionHolding(text, at) }));
  }

  // ── the shot timeline ─────────────────────────────────────────────────────
  const shots = shotMarkers(text);
  shots.forEach((shot, index) => {
    if (shot.number !== index + 1) findings.push(error('shot-number', { at: index + 1, found: shot.number }));
    if (index === 0) return;
    if (shot.cutSec == null) { findings.push(warn('shot-no-cut', { shot: shot.number })); return; }
    if (duration && shot.cutSec >= duration) {
      findings.push(error('cut-past-end', { shot: shot.number, cutSec: shot.cutSec, duration }));
    }
    const previous = shots[index - 1];
    if (previous.cutSec != null && shot.cutSec <= previous.cutSec) {
      findings.push(error('cut-out-of-order', { shot: shot.number, cutSec: shot.cutSec, previous: previous.cutSec }));
    }
  });

  // ── dialogue ──────────────────────────────────────────────────────────────
  const opens = (text.match(/<d>/g) || []).length;
  const closes = (text.match(/<\/d>/g) || []).length;
  if (opens !== closes) findings.push(error('dialogue-unbalanced', { opens, closes }));

  const blocks = dialogueBlocks(text);
  blocks.forEach((block, index) => {
    if (!block.lang) findings.push(error('dialogue-no-language', { index: index + 1, preview: block.words.slice(0, 40) }));
    if (!block.words) findings.push(warn('dialogue-empty', { index: index + 1 }));
  });
  // A line that runs across a cut needs the other half. Unpaired, the tag tells
  // the model to continue into a shot that never picks the line up.
  const carriesOut = blocks.filter((block) => block.carriesOut).length;
  const carriesIn = blocks.filter((block) => block.carriesIn).length;
  if (carriesOut !== carriesIn) findings.push(warn('scenetrans-unpaired', { out: carriesOut, in: carriesIn }));
  // <cutoff> means "the clip ends mid-word". On anything but the last line it
  // is an instruction to stop early.
  blocks.forEach((block, index) => {
    if (block.cutoff && index !== blocks.length - 1) findings.push(warn('cutoff-not-last', { index: index + 1 }));
  });

  const ids = speakerIdsIn(text);
  if (ids.length) {
    if (ids[0] !== 1) findings.push(error('speaker-ids-start', { first: ids[0] }));
    for (let index = 1; index < ids.length; index += 1) {
      if (ids[index] !== ids[index - 1] + 1) {
        findings.push(error('speaker-ids-skip', { after: ids[index - 1], found: ids[index] }));
        break;
      }
    }
  }

  // ── reference tags vs what is actually attached ───────────────────────────
  const labels = referenceLabels({ images, videos, audios });
  const attached = {
    Picture: labels.images.length,
    Video: labels.videos.filter((label) => label.video).length,
    Audio: labels.videos.filter((label) => label.audio).length + labels.audios.length,
  };
  const tags = referenceTagsIn(text);
  for (const kind of ['Picture', 'Video', 'Audio']) {
    for (const ordinal of tags[kind]) {
      if (ordinal > attached[kind]) findings.push(error('tag-unbacked', { tag: `<${kind} ${ordinal}>`, attached: attached[kind] }));
    }
  }
  // The other direction: attached and never mentioned. A picture H3 is never
  // told what to do with is a slot spent on nothing.
  if (images.length && !tags.Picture.size && !tags.Subject.size) findings.push(warn('pictures-unnamed', { count: images.length }));

  // A subject DEFINED and never put in the shot. subject_definitions says who
  // <Subject 2> is; if the summary and the description never mention it, the
  // model renders whoever it likes in that slot — the defined member stands in
  // the background unused, or does not appear at all. The cast weave writes the
  // definition; this says when the scene has not caught up.
  if (sections.includes('subject_definitions')) {
    const defined = new Set([...sectionBodyIn(text, 'subject_definitions').matchAll(/^<Subject (\d+)> is\b/gm)].map((hit) => Number(hit[1])));
    const scene = `${sectionBodyIn(text, 'summary')}\n${sectionBodyIn(text, 'detailed_description')}`;
    const staged = new Set([...scene.matchAll(/<Subject (\d+)>/g)].map((hit) => Number(hit[1])));
    for (const number of [...defined].sort((a, b) => a - b)) {
      if (!staged.has(number)) findings.push(warn('subject-not-in-scene', { subject: number }));
    }
  }

  const takeover = motionReferenceWarning({ prompt: text, videos, images });
  if (takeover?.kind === 'unnamed') findings.push(warn('motion-unnamed', { labels: takeover.labels }));
  if (takeover?.kind === 'no-exclusion') findings.push(warn('motion-no-exclusion'));

  // ── time ──────────────────────────────────────────────────────────────────
  const unscripted = unscriptedTimeWarning({ prompt: text, durationSeconds: duration, videos, audios });
  if (unscripted?.kind === 'no-line') findings.push(warn('voice-without-line'));
  if (unscripted?.kind === 'unscripted') findings.push(warn('unscripted-time', { spoken: unscripted.spoken, duration: unscripted.duration, gap: unscripted.gap }));
  // The opposite failure: more words than there is clip to say them in. The
  // model does not speed up, it truncates.
  if (duration && blocks.length) {
    const spoken = spokenSecondsIn(text);
    if (spoken > duration + 0.5) {
      findings.push(error('overscripted-time', { spoken: Math.round(spoken * 10) / 10, duration }));
    }
  }

  // ── the reference budget, as it already reports itself ────────────────────
  if (referenced) {
    const budget = referenceBudgetReport({ images, videos, audios, durations });
    for (const problem of budget.problems) {
      const fatal = ['over-total', 'over-audio-clips', 'audio-without-visual'].includes(problem.code);
      findings.push({ level: fatal ? 'error' : 'warn', code: `budget:${problem.code}`, budget: problem });
    }
  }

  const errors = findings.filter((finding) => finding.level === 'error').length;
  const warnings = findings.filter((finding) => finding.level === 'warn').length;
  return { findings, errors, warnings, ok: errors === 0, sections, mode };
}
