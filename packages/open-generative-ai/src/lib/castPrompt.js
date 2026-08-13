// The cast: who is in the shot, and the one place that decides what the model
// is told to call them.
//
// Two kinds of member, and the difference is only whether they bring media:
//
//   persona   — a saved Hive Persona ID. Contributes references, so it OCCUPIES
//               <Picture N> / <Video N> / <Audio N> slots.
//   character — a name H3 already knows ("SpongeBob SquarePants from the
//               animated series (1999)"). Contributes text, occupies nothing.
//
// Both become a <Subject i>, and that is the whole trick. A prompt in the
// library addresses SUBJECTS; this module owns SLOTS. So the same template runs
// with one persona, with two personas and a cartoon character, or with a
// character alone, and the numbering underneath is re-derived every time
// instead of being baked into someone's saved text.
//
// Slot order is load-bearing: reference N is the prompt's <Kind N>, so members
// are allocated in cast order and each member's own references keep the order
// the persona saved them in. Effect-free on purpose — no vault, no network, no
// React — because the numbering rules are the part that has to be provable.
import { WORDS_PER_SECOND, referenceLabels } from './h3References.js';

const DEFAULT_LIMITS = { images: 9, videos: 3, audios: 3 };

// How a member is DRAWN, which is not the same as who they are. A persona is
// defined by photographs, so photoreal is its honest default — the failure this
// exists to stop is a scene style ("fighting game") silently restyling a real
// person into a sprite (2026-08-12: it did exactly that). A character keeps its
// native depiction unless told otherwise.
export const PERSONA_DEFAULT_STYLE =
  'photoreal live-action, real human skin texture and hair, shot on camera — not illustrated, not stylised';

/** A persona member: brings references. */
export function castPersona(name, persona, { style = PERSONA_DEFAULT_STYLE } = {}) {
  return {
    kind: 'persona',
    style: String(style || ''),
    name: String(name || 'Persona'),
    // Free text describing the member, so the definition line is not a
    // placeholder someone has to remember to fill in.
    appearance: '',
    images: (persona?.images || []).filter(Boolean).map(String),
    videos: (persona?.videos || []).filter((item) => item?.url).map((item) => ({
      url: String(item.url), name: String(item.name || ''), useAudio: Boolean(item.useAudio),
    })),
    audios: (persona?.audios || []).filter((item) => item?.url).map((item) => ({
      url: String(item.url), name: String(item.name || ''),
    })),
  };
}

/** A character member: brings a name the model already knows. */
export function castCharacter(name, sourceForm = '', { style = '', voice = '', voiceQuality = '' } = {}) {
  return {
    kind: 'character',
    name: String(name || ''),
    sourceForm: String(sourceForm || name || ''),
    style: String(style || ''),
    // How this character SOUNDS, named rather than referenced. H3 knows a
    // known character's voice the same way it knows their face, and it is
    // invoked inside the dialogue language tag — see dialogueTag().
    voice: String(voice || ''),
    // …and what that voice is LIKE, for when the name alone does not retrieve
    // it. A name the model cannot place falls back to a generic adult male, so
    // the description is the difference between a cartoon sponge and an old man.
    voiceQuality: String(voiceQuality || ''),
  };
}

/**
 * The language tag for one member's dialogue.
 *
 * Only the language tag and the exact words belong inside <d>…</d>, and the
 * tag is also where a KNOWN character's voice is named:
 *
 *   <d>[English in Willow's voice from Buffy the Vampire Slayer as played by
 *   Alyson Hannigan] …</d>
 *
 * A persona speaks in its own referenced timbre instead, so it gets the plain
 * language tag — naming a voice it does not have would invite the model to
 * invent one over the top of the reference.
 */
export function dialogueTag(role, language = 'English') {
  const voice = role?.member?.kind === 'character' ? role.member.voice : '';
  return voice ? `[${language} in ${voice}]` : `[${language}]`;
}

/**
 * Allocate the whole cast onto the three reference rows.
 *
 * Returns the merged rows (exactly what the References panel should hold), plus
 * a `roles` entry per member carrying the labels THAT member ended up with —
 * which is what every generated line has to be written against.
 *
 * Overflow is reported, never silently dropped: a nine-picture row cannot hold
 * two six-picture personas, and finding that out at generation time is how you
 * get a clip missing a character.
 */
export function allocateCast(members = [], { limits = DEFAULT_LIMITS, speakingOrder = null } = {}) {
  const cap = { ...DEFAULT_LIMITS, ...(limits || {}) };
  // Speaker ids are assigned in FIRST-VOCAL-EVENT order, per H3's own spec —
  // not in cast order, which is what this got wrong (2026-08-12: both of a
  // woman's lines came out of a cartoon's mouth). A member who never speaks
  // gets no id at all rather than consuming one.
  const order = Array.isArray(speakingOrder) && speakingOrder.length
    ? speakingOrder.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < members.length)
    : members.map((_, index) => index);
  const speakerFor = new Map(order.map((memberIndex, position) => [memberIndex, `S${position + 1}`]));
  const images = [];
  const videos = [];
  const audios = [];
  const roles = [];
  const overflow = [];

  for (const [index, member] of members.entries()) {
    const role = {
      member,
      subject: `<Subject ${index + 1}>`,
      // Per member, never per audio reference: two subjects in one clip must
      // never share an id or the model merges their lines.
      speaker: speakerFor.get(index) || '',
      pictures: [],
      videos: [],
      audios: [],
    };
    if (member.kind === 'persona') {
      const room = (kind, list) => {
        const free = Math.max(0, cap[kind] - { images, videos, audios }[kind].length);
        if (list.length > free) overflow.push({ member: member.name, kind, dropped: list.length - free });
        return list.slice(0, free);
      };
      const takenImages = room('images', member.images);
      const takenVideos = room('videos', member.videos);
      const takenAudios = room('audios', member.audios);
      // Indices into the MERGED rows are what the labels are computed from.
      role.pictureIndex = images.length;
      role.videoIndex = videos.length;
      role.audioIndex = audios.length;
      role.pictureCount = takenImages.length;
      role.videoCount = takenVideos.length;
      role.audioCount = takenAudios.length;
      images.push(...takenImages);
      videos.push(...takenVideos);
      audios.push(...takenAudios);
    }
    roles.push(role);
  }

  // One source of truth for numbering: the same function the panel's rows and
  // the submitted graph agree on, including the rule that a clip with its
  // soundtrack switched on claims an <Audio N> just BEFORE its <Video N>.
  const labels = referenceLabels({ images, videos, audios });
  for (const role of roles) {
    if (role.member.kind !== 'persona') continue;
    role.pictures = labels.images.slice(role.pictureIndex, role.pictureIndex + role.pictureCount);
    role.videos = labels.videos.slice(role.videoIndex, role.videoIndex + role.videoCount);
    role.audios = labels.audios.slice(role.audioIndex, role.audioIndex + role.audioCount);
  }
  return { images, videos, audios, roles, overflow, labels };
}

/** The voice label a member speaks in, or "" when nothing carries their voice. */
export function roleVoiceLabel(role) {
  if (role.audios?.length) return role.audios[0];
  // A motion clip with its soundtrack on IS the voice reference for its owner.
  const withSound = (role.videos || []).find((label) => label?.audio);
  return withSound ? withSound.audio : '';
}

/** How the model should be told to identify this member. */
function subjectDefinition(role, shared = false) {
  const { member, subject } = role;
  if (member.kind === 'character') {
    const lines = [`${subject} is ${member.sourceForm}.`];
    if (member.style) lines.push(`${subject} is rendered as ${member.style}.`);
    if (role.speaker) {
      lines.push(member.voice
        ? `${subject} speaks as ${role.speaker}, in ${member.voice}.`
        : `${subject} speaks as ${role.speaker}, in its own established voice.`);
      // Naming a voice only works if the model can retrieve it. When it cannot,
      // it falls back to a generic adult male — measured twice: an unattributed
      // exhale came back as an old man, and so did a named SpongeBob
      // (2026-08-13). So DESCRIBE the voice as well as naming it, and say what
      // it must not be, the same way the render style and the smile were fixed.
      if (member.voiceQuality) {
        lines.push(`${subject}'s voice is ${member.voiceQuality}.`);
      }
    }
    return lines.join('\n');
  }
  const parts = [];
  if (role.pictures.length === 1) parts.push(`the character shown in ${role.pictures[0]}`);
  else if (role.pictures.length > 1) parts.push(`the character shown in ${role.pictures.join(', ')}`);
  else parts.push(`${member.name}`);
  const voice = roleVoiceLabel(role);
  const lines = [`${subject} is ${parts[0]}: ${member.appearance || '[appearance — one or two lines]'}.`];
  // Stated per subject, so a scene style cannot quietly restyle a real person.
  if (member.style) lines.push(`${subject} is rendered as ${member.style}.`);
  // H3 binds a voice to a subject through this pairing, written out. Without
  // it a trailing (Sx) on a dialogue line is unattached and the model guesses.
  if (role.speaker) lines.push(`${subject} speaks as ${role.speaker}.`);
  if (voice) {
    // Exclusivity is stated whenever anyone else is in the shot: with one clone
    // and two speakers, nothing otherwise says which of them it belongs to, and
    // the clone was measured drifting onto the wrong character (2026-08-13).
    const only = shared ? ' It is not the voice of any other subject in this clip.' : '';
    lines.push(role.speaker
      ? `${voice} is the voice-timbre reference for ${subject} (${role.speaker}).${only}`
      : `${voice} is the voice-timbre reference for ${subject}.${only}`);
  }
  return lines.join('\n');
}

/** The retention contract for every reference this cast brought. */
function retentionLines(role) {
  if (role.member.kind === 'character') return [];
  const lines = [];
  // The SUBJECT gets a contract of its own, before the pictures that identify
  // it. A per-picture line says what that picture contributes; this says the
  // person stays the same person for the whole clip, at every distance — which
  // is a different promise, and the one that keeps a face from drifting between
  // the near and far ends of a shot.
  if (role.pictures.length) {
    lines.push(
      `${role.subject}: fully_preserved — the same face, hair, build and wardrobe in every shot `
      + 'and at every distance.',
    );
  }
  for (const label of role.pictures) {
    lines.push(`${label}: fully_preserved — ${role.subject}'s face, hair and wardrobe carry into the clip.`);
  }
  for (const label of role.videos) {
    if (label.audio) {
      lines.push(
        `${label.audio}: reference — only the timbre carries. Its words do NOT carry and its accent does NOT carry.`,
      );
    }
    lines.push(
      `${label.video}: attribute_transfer — only its manner of movement carries. Its performer's appearance, `
      + `clothing, setting and framing do NOT carry.`,
    );
  }
  for (const label of role.audios) {
    lines.push(`${label}: reference — only the timbre carries. Its words do NOT carry.`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// BEATS — the shot as a timeline instead of a paragraph.
//
// A freeform detailed_description says what happens; it does not say WHEN, and
// the model has to fit whatever it reads into the runtime it was given. Asked
// for eight seconds, handed roughly fourteen seconds of choreography written as
// prose (2026-08-12), it dropped and reordered: a one-word cry landed on the
// wrong action, and a reaction that had no room left played as a held pause.
//
// A beat is a span of the clip with one thing happening in it. Writing them as
// spans makes three things arithmetic rather than hope: whether the shot fits,
// whether each spoken line fits inside the action it belongs to, and — because
// the beats say who speaks and in what order — who is Sx. That last one is the
// error this module already exists to prevent, now removed from human hands
// entirely: with beats, nobody types a speaker id or a language tag.
//
// beats: [{ seconds, action, line?: { member, text, language } }]

/** MM:SS.mmm — the anchor notation H3's guide uses for a point in the clip. */
function timecode(seconds) {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(Math.floor(ms / 60000), 2)}:${pad(Math.floor((ms % 60000) / 1000), 2)}.${pad(ms % 1000, 3)}`;
}

/** How long a written line takes to say, at the studio's shared speech rate. */
export function lineSeconds(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length / WORDS_PER_SECOND;
}

// Under half a second there is almost nothing for the model to place a line
// against, so it slides to whichever mouth is open nearby — which is how a
// one-word "Ouch!" ended up on the kick that was supposed to provoke it rather
// than on the punch that landed.
const MIN_LINE_SECONDS = 0.5;

// A line that is still a hole — "[THE LINE THEY SAY AFTER THE FIRST HIT]" — has
// no length yet, so timing it is nonsense in both directions: its placeholder
// words get counted as speech, and shortening the placeholder would "fix" a
// warning about a line nobody has written. Starters are full of these.
const isFillIn = (text) => /^\[[^\]]*\]$/.test(String(text || '').trim());

// Which member each beat's line belongs to, in the order the lines are first
// heard. This IS the speaking order — H3 assigns speaker ids by first vocal
// event, so deriving it from the beats means the ids can never disagree with
// the script the way a hand-written order can.
export function speakingOrderFromBeats(beats = []) {
  const order = [];
  for (const beat of beats) {
    const index = Number(beat?.line?.member);
    if (Number.isInteger(index) && index >= 0 && !order.includes(index)) order.push(index);
  }
  return order;
}

/**
 * Render beats into one continuous shot.
 *
 * Every beat after the first is anchored with "At MM:SS.mmm," rather than
 * opened as [Shot N]: a new shot marker is a CUT, and these are moments inside
 * one take. Each line is emitted as its speaker's own sentence, with the
 * <Subject N> (Sx) pairing and the language tag written by the compiler.
 */
function renderBeats(beats, roles, { style = '' } = {}) {
  const lines = [];
  let at = 0;
  for (const [index, beat] of beats.entries()) {
    const action = String(beat?.action || '').trim();
    const anchor = index === 0 ? '[Shot 1] ' : `At ${timecode(at)}, `;
    const parts = [];
    if (action) parts.push(`${anchor}${action}`);
    const role = beat?.line ? roles[Number(beat.line.member)] : null;
    if (role && String(beat.line.text || '').trim()) {
      const speaker = role.speaker ? ` (${role.speaker})` : '';
      const tag = dialogueTag(role, beat.line.language || 'English');
      const said = `${role.subject}${speaker} says: <d>${tag} ${String(beat.line.text).trim()}</d>`;
      parts.push(action ? said : `${anchor}${said}`);
    }
    if (parts.length) lines.push(parts.join(' '));
    at += Math.max(0, Number(beat?.seconds) || 0);
  }
  const opening = String(style || '').trim();
  return [opening, lines.join('\n')].filter(Boolean).join('\n');
}

/** Everything the beats can be checked for before a minute of GPU time. */
function beatWarnings(beats, roles, durationSeconds) {
  const warnings = [];
  const total = beats.reduce((sum, beat) => sum + (Number(beat?.seconds) || 0), 0);
  const runtime = Number(durationSeconds) || 0;
  if (runtime && total > runtime + 0.25) {
    warnings.push(
      `The beats add up to ${total.toFixed(1)}s but the clip is ${runtime.toFixed(0)}s. `
      + 'Everything over the runtime gets dropped or compressed, and compression reorders — '
      + 'cut beats or lengthen the clip.',
    );
  }
  if (runtime && total < runtime - 1) {
    warnings.push(
      `The beats account for ${total.toFixed(1)}s of a ${runtime.toFixed(0)}s clip. `
      + `Roughly ${(runtime - total).toFixed(1)}s is unwritten, and unwritten time gets invented.`,
    );
  }
  for (const [index, beat] of beats.entries()) {
    const text = String(beat?.line?.text || '').trim();
    if (!text) continue;
    const role = roles[Number(beat.line.member)];
    if (!role) {
      warnings.push(`Beat ${index + 1} has a line but no cast member to say it.`);
      continue;
    }
    if (!role.speaker) {
      warnings.push(`Beat ${index + 1} gives ${role.subject} a line, but it was left out of the speaking order.`);
    }
    if (isFillIn(text)) continue;
    const spoken = lineSeconds(text);
    if (spoken < MIN_LINE_SECONDS) {
      warnings.push(
        `Beat ${index + 1}'s line (“${text}”) is about ${spoken.toFixed(1)}s. `
        + 'A line that short has little to lock onto and tends to slide onto a neighbouring action — '
        + 'give it more words, or describe the sound in the action instead of speaking it.',
      );
    }
    const room = Number(beat?.seconds) || 0;
    if (room && spoken > room) {
      warnings.push(
        `Beat ${index + 1}'s line needs about ${spoken.toFixed(1)}s but the beat is ${room.toFixed(1)}s. `
        + 'It will run over into the next action.',
      );
    }
  }
  return warnings;
}

// A character's own noises — breath, grunt, laugh, cry — are SYNCHRONISED
// dialogue, and H3's guide is explicit that those live in detailed_description
// while overall_soundscape is for whole-video ambience and physical sound. The
// difference is not filing: nothing in the soundscape carries a speaker id, so
// a vocalisation written there is voiced by nobody in particular and comes back
// in a generic default voice. Measured 2026-08-12 — "a sharp exhale from each
// fighter on exertion" was rendered over a cartoon sponge as a quiet old man.
// Deliberately excludes "hum" and "whistle": in a section whose whole job is
// ambience and physical sound they are overwhelmingly an electrical hum or wind
// through a gap, and this warning fired on "a faint electrical hum from the
// signage" the first time it met a real prompt. A warning that cries wolf is
// worse than no warning, so the list is only words that are a VOICE or nothing.
const SOUNDSCAPE_VOCAL = /\b(exhale[sd]?|inhale[sd]?|breath(?:s|ing|e|es)?|pant(?:s|ing)?|gasp(?:s|ing)?|sigh(?:s|ing)?|grunt(?:s|ing)?|groan(?:s|ing)?|moan(?:s|ing)?|yelp(?:s|ing)?|scream(?:s|ing)?|shout(?:s|ing)?|yell(?:s|ing)?|cry(?:ing|ies)?|laugh(?:s|ing|ter)?|chuckle[sd]?|giggle[sd]?|whimper(?:s|ing)?|snarl(?:s|ing)?|growl(?:s|ing)?|vocal(?:s|isations?|izations?)?)\b/i;

/**
 * Compile a cast and a template into H3's six-section prompt.
 *
 * `template` supplies the creative half — summary, detailed_description,
 * soundscape, music — written against <Subject 1>, <Subject 2>, … The cast
 * supplies the bookkeeping half: who those subjects ARE, what each reference is
 * allowed to carry, and which speaker id each one talks under.
 *
 * `template.beats` writes detailed_description as a timeline instead, and is the
 * form to prefer: it derives the speaking order, writes every speaker id and
 * language tag, and can be checked against `durationSeconds` before the run.
 */
export function compileCastPrompt({
  members = [], template = {}, limits = DEFAULT_LIMITS, speakingOrder = null, durationSeconds = 0,
} = {}) {
  const beats = Array.isArray(template.beats) ? template.beats : [];
  // Beats know who speaks and when, so they ARE the speaking order — an
  // explicit one is honoured, but nothing has to supply it.
  const order = speakingOrder || (beats.length ? speakingOrderFromBeats(beats) : null);
  const allocation = allocateCast(members, { limits, speakingOrder: order });
  const { roles } = allocation;
  const anyVoice = roles.some((role) => roleVoiceLabel(role));

  const sections = [];
  sections.push(['subject_definitions',
    roles.map((role, _index, all) => subjectDefinition(role, all.length > 1)).join('\n')]);

  const summary = String(template.summary || '').trim();
  if (summary) {
    // The summary audio tag is a contract about the WHOLE clip, so it is written
    // once here rather than per reference: with a voice reference attached, the
    // source's own words must not reappear.
    sections.push(['summary', anyVoice && !/\[audio (reference|reuse)\]/.test(summary)
      ? `[audio reference] ${summary}`
      : summary]);
  }

  const retention = roles.flatMap(retentionLines);
  if (retention.length) sections.push(['retention_analysis', retention.join('\n')]);

  const description = beats.length
    ? renderBeats(beats, roles, { style: template.style })
    : String(template.detailed_description || '').trim();
  if (description) sections.push(['detailed_description', description]);
  const soundscape = String(template.overall_soundscape || '').trim();
  if (soundscape) sections.push(['overall_soundscape', soundscape]);
  const music = String(template.non_diegetic_music || '').trim();
  if (music) sections.push(['non_diegetic_music', music]);

  // MiniMax's own guide asks for roughly 350-500 English words of description.
  // A thin one is not merely terse: every beat left unstated is invented, which
  // is how an 8s fight came back with the punch missing and the taunt landing
  // before the hit (2026-08-12). Reported, never enforced — dialogue density
  // and task complexity legitimately take precedence over a word count.
  const warnings = [];
  const words = description ? description.split(/\s+/).filter(Boolean).length : 0;
  if (description && words < 350) {
    warnings.push(
      `detailed_description is ${words} words; H3's guide asks for roughly 350-500. `
      + 'Unstated beats get invented — state each action, its order, and what connects with what.',
    );
  }
  const speakers = roles.filter((role) => role.speaker).length;
  if (speakers > 1 && description && !/\(S\d\)/.test(description)) {
    warnings.push('Two or more subjects speak, but no <Subject N> (Sx) pairing appears in the description.');
  }
  if (beats.length) warnings.push(...beatWarnings(beats, roles, durationSeconds));

  // Subject numbering and speaker numbering crossing over.
  //
  // H3 assigns (S1), (S2), … in first-vocal-event order (base-modes.md), so a
  // script where the second subject speaks first LEGALLY makes <Subject 1> into
  // S2. Legal, and measured to break: the only take whose numbering crossed is
  // the only take that put one subject's lines in the other's mouth
  // (2026-08-13). Both constraints are satisfiable at once — order the script so
  // the first voice heard is also <Subject 1> — so crossing is never worth it.
  const crossed = roles.filter((role, index) => role.speaker && role.speaker !== `S${index + 1}`);
  if (crossed.length) {
    const pairs = crossed.map((role) => `${role.subject}=${role.speaker}`).join(', ');
    warnings.push(
      `Subject and speaker numbering are crossed (${pairs}). H3 numbers speakers by who talks first, `
      + 'so whoever speaks first should also be the first subject — reorder the cast, or move the '
      + "first line, so <Subject 1> is S1. Crossed numbering swapped two characters' lines.",
    );
  }

  // The voice reference and the first speaker pulling apart.
  //
  // With one <Audio N> and several speakers, nothing in the prompt says which
  // speaker the clone belongs to beyond the binding line — and when the owner
  // stopped being S1, her own lines came back in someone else's voice. Keeping
  // the reference on the first speaker removes the ambiguity entirely.
  const voiced = roles.filter((role) => roleVoiceLabel(role) && role.speaker);
  const strayVoice = voiced.find((role) => role.speaker !== 'S1');
  if (strayVoice && roles.filter((role) => role.speaker).length > 1) {
    warnings.push(
      `${roleVoiceLabel(strayVoice)} is ${strayVoice.subject}'s voice, but ${strayVoice.subject} speaks `
      + `as ${strayVoice.speaker} rather than S1. Give the character who owns the voice reference the `
      + 'first line, so the clone and the first speaker are the same person.',
    );
  }
  // A voice in the soundscape belongs to nobody, so the model picks a voice.
  if (soundscape && SOUNDSCAPE_VOCAL.test(soundscape)) {
    warnings.push(
      'overall_soundscape describes a sound a character makes with their voice. Nothing there carries a '
      + 'speaker id, so it comes back in a default voice over whoever is on screen — move it into the '
      + 'beat where it happens, or drop it.',
    );
  }

  if (!description) {
    warnings.push('Nothing describes the shot. A prompt that only says who is in it leaves the whole clip to be invented.');
  }

  return {
    prompt: sections.map(([name, body]) => `${name}:\n${body}`).join('\n\n'),
    allocation,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Recasting a prompt that already exists.
//
// The point of a cast is that a saved prompt is written against SUBJECTS and
// stays reusable: the same fight runs with one persona, with two, or with a
// persona and a cartoon, and only the bookkeeping changes. So applying a cast
// to text in the composer rewrites exactly the two sections the cast owns —
// who the subjects are, and what each reference may carry — and leaves the
// creative half untouched.

export const SIX_SECTIONS = Object.freeze([
  'subject_definitions', 'summary', 'retention_analysis',
  'detailed_description', 'overall_soundscape', 'non_diegetic_music',
]);

/** Split a six-section prompt into its parts, or null if it is not one. */
export function parseSixSections(text) {
  const source = String(text || '');
  const pattern = new RegExp(`^(${SIX_SECTIONS.join('|')}):[ \\t]*$`, 'gm');
  const marks = [];
  let match = pattern.exec(source);
  while (match) {
    marks.push({ name: match[1], start: match.index, bodyAt: match.index + match[0].length });
    match = pattern.exec(source);
  }
  if (!marks.length) return null;
  const sections = {};
  for (const [index, mark] of marks.entries()) {
    const end = index + 1 < marks.length ? marks[index + 1].start : source.length;
    sections[mark.name] = source.slice(mark.bodyAt, end).trim();
  }
  return sections;
}

/**
 * Apply a cast to whatever is in the composer.
 *
 * A six-section prompt keeps its summary, description, soundscape and music.
 * Anything else — a paragraph someone typed, a prompt from the library that was
 * never in H3's format — becomes the description of a freshly framed prompt,
 * because a bare paragraph and no frame is the shape that came back with four
 * seconds of invented speech in front of the written line.
 */
export function applyCastToPrompt(prompt, { template = {}, ...options } = {}) {
  const existing = parseSixSections(prompt);
  const merged = existing
    ? { ...existing, ...template }
    : { detailed_description: String(prompt || '').trim(), ...template };
  // Derived from who is in the shot, so they are never carried over.
  delete merged.subject_definitions;
  delete merged.retention_analysis;
  return compileCastPrompt({ ...options, template: merged });
}
