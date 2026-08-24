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
import {
  DIALOGUE_STUB, WORDS_PER_SECOND, parseFieldPrompt, referenceLabels,
} from './h3References.js';
import { normalizePersonaGender, personaGenderWords } from './personaId.js';
import { bindStandIns } from './subjectTemplate.js';

const DEFAULT_LIMITS = { images: 9, videos: 3, audios: 3 };

const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    // '' for a member that was never named — the rows attached by hand. The
    // definition then binds the subject to its references alone, which is the
    // honest description; a made-up placeholder name would reach the model.
    name: String(name || ''),
    // Saved with the persona. It decides the noun the definition uses ("the
    // woman shown in <Picture 1>") and, when the subject speaks without a
    // cloned voice, which voice to ask for — H3's default for an unvoiced
    // subject is a generic adult male (measured 2026-08-13). '' = unknown:
    // the definition says "the character" and asks for no particular voice.
    gender: normalizePersonaGender(persona?.gender),
    // Free text describing the member — the persona's saved LOOK (hair, face,
    // build, wardrobe). With it the definition is complete; without it the
    // definition carries a blank the Prompt Check flags, because a blank that
    // reaches the model is read as an instruction.
    appearance: String(persona?.look || '').trim(),
    images: (persona?.images || []).filter(Boolean).map(String),
    videos: (persona?.videos || []).filter((item) => item?.url).map((item) => ({
      url: String(item.url), name: String(item.name || ''), useAudio: Boolean(item.useAudio), compact: Boolean(item.compact),
      // A clip switched to sound only stays sound only in the cast: it is a
      // voice reference, never the character or motion reference.
      ...(item.motion === false ? { motion: false, useAudio: true } : {}),
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

/**
 * The definition lines for a KNOWN character — who it is, how it is drawn, and
 * how it sounds.
 *
 * Exported because the Character quick-add writes a subject into a prompt
 * without going through a cast, and two ways of defining the same cartoon that
 * word it differently are two different prompts.
 *
 * `speaker` binds this subject's lines to a speaker id. An empty one means two
 * different things, and `unbilled` is which: a member the compiler was told to
 * leave SILENT gets no voice line at all, while a character just added to a
 * prompt has no line YET and still gets one — a subject whose voice is never
 * named comes back in H3's generic adult male the moment somebody writes it a
 * line, which is the whole failure this wording exists to prevent.
 */
export function characterSubjectLines({
  subject, sourceForm, style = '', voice = '', voiceQuality = '', speaker = '', unbilled = false,
} = {}) {
  const lines = [`${subject} is ${sourceForm}.`];
  if (style) lines.push(`${subject} is rendered as ${style}.`);
  if (speaker) {
    lines.push(voice
      ? `${subject} speaks as ${speaker}, in ${voice}.`
      : `${subject} speaks as ${speaker}, in its own established voice.`);
  } else if (unbilled && voice) {
    lines.push(`${subject} speaks in ${voice}.`);
  }
  // Naming a voice only works if the model can retrieve it. When it cannot,
  // it falls back to a generic adult male — measured twice: an unattributed
  // exhale came back as an old man, and so did a named SpongeBob
  // (2026-08-13). So DESCRIBE the voice as well as naming it, and say what
  // it must not be, the same way the render style and the smile were fixed.
  if (voiceQuality && (speaker || (unbilled && voice))) {
    lines.push(`${subject}'s voice is ${voiceQuality}.`);
  }
  return lines;
}

export const APPEARANCE_BLANK =
  '[hair, face, build, wardrobe — write it out. Identity holds from these words as much as from the pictures]';

/** How the model should be told to identify this member. */
function subjectDefinition(role, shared = false) {
  const { member, subject } = role;
  if (member.kind === 'character') {
    return characterSubjectLines({
      subject,
      sourceForm: member.sourceForm,
      style: member.style,
      voice: member.voice,
      voiceQuality: member.voiceQuality,
      speaker: role.speaker,
    }).join('\n');
  }
  const parts = [];
  // The noun comes from the persona's saved gender; "the person" when it was
  // never set — a persona is a photographed human by construction, and the
  // reference scaffold always said so (the two writers are one path now).
  const noun = member.gender ? personaGenderWords(member.gender).noun : 'person';
  if (role.pictures.length === 1) parts.push(`the ${noun} shown in ${role.pictures[0]}`);
  else if (role.pictures.length > 1) parts.push(`the ${noun} shown in ${role.pictures.join(', ')}`);
  // No picture: the first clip is the character reference — MiniMax's own
  // guide binds subjects to clips this way ("<Subject N> is the young man in
  // <Video 2>, …"). A name alone would introduce someone the model has never seen.
  else if (role.videos.some((label) => label?.video)) {
    // A sound-only row has no <Video N>: the first MOTION clip is the one the
    // subject can be bound to.
    parts.push(`the ${noun} shown in ${role.videos.find((label) => label?.video).video}`);
  } else if (member.gender) parts.push(`a ${noun}${member.name ? `, ${member.name}` : ''}`);
  else parts.push(member.name || 'a person');
  const voice = roleVoiceLabel(role);
  // The blank is the same words the reference scaffold leaves, so the Prompt
  // Check's SCAFFOLD_BLANKS catches it wherever it came from.
  const lines = [`${subject} is ${parts[0]}: ${member.appearance || APPEARANCE_BLANK}.`];
  // Stated per subject, so a scene style cannot quietly restyle a real person.
  if (member.style) lines.push(`${subject} is rendered as ${member.style}.`);
  // H3 binds a voice to a subject through this pairing, written out. Without
  // it a trailing (Sx) on a dialogue line is unattached and the model guesses.
  // With no clone to bind, at least say what KIND of voice: left unsaid, an
  // unvoiced subject comes back as a generic adult male whoever is on screen.
  if (role.speaker) {
    const kind = !voice && member.gender && member.gender !== 'nonbinary' ? `, in a ${noun}'s voice` : '';
    lines.push(`${subject} speaks as ${role.speaker}${kind}.`);
  }
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
  if (role.pictures.length || role.videos.some((label) => label?.video)) {
    lines.push(
      `${role.subject}: fully_preserved — the same face, hair, build and wardrobe in every shot `
      + 'and at every distance.',
    );
  }
  for (const label of role.pictures) {
    lines.push(`${label}: fully_preserved — ${role.subject}'s face, hair and wardrobe carry into the clip.`);
  }
  // With no picture the first MOTION clip is the character reference and
  // carries the person; any further clip is motion-only, as every clip is when
  // pictures exist. A sound-only row is a voice clip: the timbre line only.
  const identityVideo = role.pictures.length ? null : (role.videos.find((label) => label?.video) || null);
  for (const label of role.videos) {
    if (label.audio) {
      lines.push(
        `${label.audio}: reference — only the timbre carries. Its words do NOT carry and its accent does NOT carry.`,
      );
    }
    if (!label.video) continue;
    if (label === identityVideo) {
      lines.push(
        `${label.video}: fully_preserved — ${role.subject} IS the person in this clip: face, hair, build, wardrobe `
        + `and manner of movement all carry. Only the clip's setting and framing do NOT carry.`,
      );
    } else {
      lines.push(
        `${label.video}: attribute_transfer — only its manner of movement carries. Its performer's appearance, `
        + `clothing, setting and framing do NOT carry.`,
      );
    }
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
  previousCast = [], standIns = [], scaffold = false,
} = {}) {
  const beats = Array.isArray(template.beats) ? template.beats : [];
  // Beats know who speaks and when, so they ARE the speaking order — an
  // explicit one is honoured, but nothing has to supply it.
  const order = speakingOrder || (beats.length ? speakingOrderFromBeats(beats) : null);
  const allocation = allocateCast(members, { limits, speakingOrder: order });
  const { roles } = allocation;
  const anyVoice = roles.some((role) => roleVoiceLabel(role));

  // The creative half is CARRIED, not preserved: everything in it that names a
  // member rather than a subject position is re-derived from the cast attached
  // now. Beats are compiled from scratch, so they skip the pass.
  //
  // Stand-ins go first: a starter rendered about "a Korean woman" recorded
  // which words are the person (subjectTemplate.js), and whoever holds that
  // subject slot now takes her place — her look goes with her, because the
  // member's own definition carries its look. Only the slots this cast fills
  // are bound; a stand-in for a subject nobody holds stays as written.
  const CREATIVE = ['summary', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'];
  const carried = Object.fromEntries(CREATIVE.map((name) => [name, String(template[name] || '').trim()]));
  const SEAM = '\u0000';
  const binding = bindStandIns(
    CREATIVE.map((name) => carried[name]).join(SEAM),
    Array.isArray(standIns) ? standIns : [],
    (index) => roles[index - 1]?.subject || null,
  );
  binding.text.split(SEAM).forEach((text, index) => { carried[CREATIVE[index]] = text; });
  const recast = (text) => recastCreative(text, roles, previousCast);

  const sections = [];
  sections.push(['subject_definitions',
    roles.map((role, _index, all) => subjectDefinition(role, all.length > 1)).join('\n')]);

  // Description before summary: the stand-in is bound where it is first
  // written, and a summary that repeats the phrase binds on its own pass.
  let description = beats.length
    ? renderBeats(beats, roles, { style: template.style })
    : recast(carried.detailed_description);
  if (!beats.length && description && !/\[Shot\s+\d+\]/.test(description)) {
    // Loose prose is the shot. A prompt that already carries its own timeline
    // keeps it; adding [Shot 1] in front of one that opens with it gave the
    // prompt two and made the first cut unreadable.
    description = `[Shot 1] ${description}`;
  }
  if (scaffold && !description) description = `[Shot 1] ${DESCRIPTION_PLACEHOLDER}`;
  // A cloned voice with nothing to say is the other half of the problem — but
  // only the explicit scaffold writes the stub: an automatic weave would plant a
  // placeholder line in a description that deliberately has no dialogue.
  if (scaffold && anyVoice && description && !description.includes('<d>')) {
    const speaker = roles.find((role) => roleVoiceLabel(role) && role.speaker) || roles.find((role) => roleVoiceLabel(role));
    description = `${description}\n${speaker ? `${speaker.subject} ` : ''}${DIALOGUE_STUB}`;
  }

  let summary = recast(carried.summary);
  if (!summary) summary = summaryFor(roles);
  // The summary audio tag is a contract about the WHOLE clip, so it is written
  // once here rather than per reference: with a voice reference attached, the
  // source's own words must not reappear.
  sections.push(['summary', anyVoice && !/\[audio (reference|reuse)\]/.test(summary)
    ? `[audio reference] ${summary}`
    : summary]);

  const retention = roles.flatMap(retentionLines);
  if (retention.length) sections.push(['retention_analysis', retention.join('\n')]);

  if (description) sections.push(['detailed_description', description]);
  // The author's own soundscape is the more specific instruction, so it
  // carries. The default is for a prompt that had none — and its voice sentence
  // is the one that prevented four seconds of invented speech, so it is kept
  // for exactly that case.
  const soundscape = recast(carried.overall_soundscape) || (anyVoice
    ? `A quiet interior. Only ${roles.find((role) => roleVoiceLabel(role))?.subject || '<Subject 1>'}'s voice, close and dry, over faint room tone. No other speakers, no music, and no speech before or after the written lines.`
    : 'A quiet interior with faint room tone. No speech and no music.');
  sections.push(['overall_soundscape', soundscape]);
  const music = recast(carried.non_diegetic_music) || 'none';
  sections.push(['non_diegetic_music', music]);

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

  // Labels the cast cannot fill. A prompt from the library was written against
  // the rows it was saved with; dropped onto a smaller cast, <Picture 7> is a
  // condition on an attachment that is not there, and H3 conditions it on
  // nothing rather than saying so.
  const creative = [summary, description, soundscape, music].filter(Boolean).join('\n');
  const filled = {
    Subject: roles.length,
    Picture: allocation.labels.images.length,
    Video: allocation.labels.videos.filter((label) => label.video).length,
    Audio: allocation.labels.audios.length + allocation.labels.videos.filter((label) => label.audio).length,
  };
  for (const [kind, count] of Object.entries(filled)) {
    const used = [...creative.matchAll(new RegExp(`<${kind} (\\d+)>`, 'g'))].map((hit) => Number(hit[1]));
    const highest = used.length ? Math.max(...used) : 0;
    if (highest <= count) continue;
    const noun = kind === 'Subject' ? 'member' : kind.toLowerCase();
    warnings.push(
      `The prompt addresses <${kind} ${highest}>, but this cast ${kind === 'Subject' ? 'has' : 'fills'} `
      + `${count} ${noun}${count === 1 ? '' : 's'}. A label with nothing behind it conditions on nothing — `
      + 'add the member, attach the reference, or edit the line.',
    );
  }

  // The words that get SAID are never rewritten — "Take that, SpongeBob!"
  // recast into "Take that, <Subject 2>!" would be read out loud — so a name
  // the cast no longer contains is reported instead.
  for (const member of previousCast) {
    if (!member.name) continue;
    if (roles.some((role) => role.member.name === member.name)) continue;
    if (!new RegExp(`\\b${escapeRegExp(member.name)}\\b`).test(creative)) continue;
    warnings.push(
      `A spoken line still says “${member.name}”, who is no longer in the cast. Dialogue is left exactly `
      + 'as written — change the words yourself.',
    );
  }

  if (!description) {
    warnings.push('Nothing describes the shot. A prompt that only says who is in it leaves the whole clip to be invented.');
  }

  // A stand-in the text no longer contains is the one case where binding is
  // refused rather than guessed: the user edited those words, and a half-bound
  // subject — label in one sentence, the old description in the next — is the
  // exact failure this module exists to prevent.
  for (const index of binding.unmatched) {
    warnings.push(
      `<Subject ${index}>'s stand-in phrase is no longer in the text, so it was not bound. `
      + 'Write <Subject ' + index + '> into the description yourself, or ask the helper to.',
    );
  }

  return {
    prompt: sections.map(([name, body]) => `${name}:\n${body}`).join('\n\n'),
    allocation,
    warnings,
    standIns: { bound: binding.bound, remaining: binding.remaining, unmatched: binding.unmatched },
  };
}

const DESCRIPTION_PLACEHOLDER = 'Medium shot of <Subject 1> against [setting], in [lighting]. '
  + '<Subject 1> looks into the lens to speak, then holds a beat of stillness.';

/** A summary for a prompt that had none: one line naming every subject and what drives it. */
function summaryFor(roles) {
  if (!roles.length) return '';
  const clauses = roles.map((role) => {
    const voice = roleVoiceLabel(role);
    const motion = (role.videos || []).map((label) => label?.video).filter(Boolean);
    const identityVideo = role.pictures?.length ? null : (motion[0] || null);
    const manner = identityVideo ? motion.slice(1) : motion;
    const bits = [role.subject];
    if (voice) bits.push(`speaking in the voice of ${voice}`);
    if (identityVideo) bits.push(`carrying the look and manner of ${identityVideo}`);
    if (manner.length) bits.push(`moving in the manner of ${manner.join(' and ')}`);
    return bits.join(', ');
  });
  return `One continuous take of ${clauses.join('; and ')}.`;
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

// ---------------------------------------------------------------------------
// Recasting the CREATIVE half.
//
// Rewriting subject_definitions and retention_analysis used to be the whole of
// a recast, on the reasoning that everything else is what the person wrote. It
// is not, quite: three things in the creative half name a specific MEMBER
// rather than a subject position, and every one of them survived a recast still
// pointing at the cast that had just been replaced (2026-08-22 — a fight recast
// from SpongeBob onto Naruto kept "<d>[English in SpongeBob SquarePants' voice
// from SpongeBob SquarePants as voiced by Tom Kenny] Ouch!</d>", so the
// definitions asked for one character and the spoken line asked for another,
// which is worse than either one alone).
//
//   1. the dialogue LANGUAGE TAG, which is where a known character's voice is
//      named. dialogueTag() writes it when compiling from beats, so it owns it
//      when recasting too.
//   2. the (Sx) pairing, which moves whenever the speaking order does.
//   3. a bare NAME in the prose, left by whoever wrote the template by hand.
//
// All three are derivable from the cast attached NOW, so they are re-derived
// rather than preserved. Deliberately untouched: the inside of a <d>…</d> body.
// Those are the words that get SAID, and rewriting "Take that, SpongeBob!" into
// "Take that, <Subject 2>!" would have the model read a label out loud — so a
// stale name in a spoken line is reported instead of edited.

/** Sections back into H3's six-section text — the inverse of the parse above. */
export function formatSixSections(sections = {}) {
  return SIX_SECTIONS
    .filter((name) => String(sections[name] || '').trim())
    .map((name) => `${name}:\n${String(sections[name]).trim()}`)
    .join('\n\n');
}

/**
 * True when the text IS a six-section prompt rather than merely containing one.
 *
 * The distinction matters to anything that edits a section and writes the
 * prompt back out: parsing keeps only what is inside the six sections, so text
 * sitting in front of the first header would be dropped on the way back.
 */
export function isSixSectionPrompt(text) {
  const first = String(text || '').trim().split('\n')[0] || '';
  return new RegExp(`^(${SIX_SECTIONS.join('|')}):[ \\t]*$`).test(first.trim())
    && Boolean(parseSixSections(text));
}

/**
 * The cast a six-section prompt was last compiled against, read out of its own
 * subject_definitions.
 *
 * A prompt carries its own cast, which is the whole reason a recast can be
 * exact without anything being remembered between two runs: the definitions say
 * which member held which subject position, so the creative half's leftovers
 * can be traced back to a position and re-derived from whoever holds it now.
 */
export function readCastFromDefinitions(text) {
  const found = new Map();
  const at = (number) => {
    if (!found.has(number)) found.set(number, { index: number, identity: '', name: '', speaker: '' });
    return found.get(number);
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    // "is rendered as …" is a style line, not an identity, and would otherwise
    // be read as the member's name.
    const identity = /^<Subject (\d+)> is (?!rendered as\b)(.+?)\.?$/.exec(line);
    if (identity) {
      const entry = at(Number(identity[1]));
      entry.identity = identity[2];
      entry.name = properName(identity[2]);
      continue;
    }
    const speaks = /^<Subject (\d+)> speaks as (S\d+)\b/.exec(line);
    if (speaks) at(Number(speaks[1])).speaker = speaks[2];
  }
  return [...found.values()].sort((a, b) => a.index - b.index);
}

/**
 * The name a member is called in prose, from the way it was defined.
 *
 * A subject defined by its references is addressed by LABEL and never by name,
 * so a definition containing one contributes nothing — and a definition opening
 * with an article ("a woman, Cheryl") is a description rather than a name.
 */
function properName(identity) {
  const head = String(identity || '').split(': ')[0].trim();
  if (!head || /[<>]/.test(head)) return '';
  // "SpongeBob SquarePants from the animated series SpongeBob SquarePants
  // (1999)" and "Buffy Summers as played by Sarah Michelle Gellar from …" both
  // start with the name the prose would use.
  const name = head.split(/ (?:from|as played by|as voiced by) /)[0].trim();
  if (!name || /^(a|an|the) /i.test(name)) return '';
  return name;
}

/** One carried-over section, with everything that names a member re-derived. */
function recastCreative(text, roles, previous = []) {
  const source = String(text || '');
  if (!source) return source;

  // Split on dialogue, because the two halves are governed by opposite rules:
  // the tag is the cast's to write, the words inside are the writer's to keep.
  const parts = [];
  const pattern = /<d>([\s\S]*?)<\/d>/g;
  let at = 0;
  let match = pattern.exec(source);
  while (match) {
    parts.push({ prose: source.slice(at, match.index) });
    parts.push({ dialogue: match[1] });
    at = match.index + match[0].length;
    match = pattern.exec(source);
  }
  parts.push({ prose: source.slice(at) });

  // Whose line comes next: the last subject named before the <d>, which is how
  // both this module and H3's own guide write an attributed line
  // ("<Subject 2> (S2) says: <d>…</d>").
  let owner = -1;
  const out = [];
  for (const part of parts) {
    if (part.dialogue !== undefined) {
      out.push(`<d>${recastDialogue(part.dialogue, roles[owner])}</d>`);
      continue;
    }
    let prose = part.prose;
    for (const member of previous) {
      if (!member.name) continue;
      prose = prose.replace(new RegExp(`\\b${escapeRegExp(member.name)}\\b`, 'g'), `<Subject ${member.index}>`);
    }
    prose = prose.replace(/<Subject (\d+)>(\s*)\(S\d+\)/g, (whole, number, gap) => {
      const role = roles[Number(number) - 1];
      if (!role) return whole;
      return role.speaker ? `<Subject ${number}>${gap}(${role.speaker})` : `<Subject ${number}>`;
    });
    const seen = [...prose.matchAll(/<Subject (\d+)>/g)].pop();
    if (seen) owner = Number(seen[1]) - 1;
    out.push(prose);
  }
  return out.join('');
}

/** One <d>…</d> body: the language survives, the voice is the cast's to name. */
function recastDialogue(body, role) {
  const match = /^(\s*)\[([^\]]*)\]([\s\S]*)$/.exec(String(body || ''));
  if (!match || !role) return body;
  const language = match[2].split(/\s+in\s+/i)[0].trim() || 'English';
  return `${match[1]}${dialogueTag(role, language)}${match[3]}`;
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
  // A three-field prompt — every text-mode starter, the helper's output — is
  // CONVERTED field by field: description to description, soundscape to
  // soundscape, music to music. Treating it as loose text swallowed the whole
  // thing, headers and all, into detailed_description (2026-08-23).
  const fields = existing ? null : parseFieldPrompt(prompt);
  const merged = existing
    ? { ...existing, ...template }
    : fields
      ? {
        detailed_description: [fields.lead, fields.integrated_multimodal_description].filter(Boolean).join('\n\n'),
        overall_soundscape: fields.overall_soundscape || '',
        non_diegetic_music: fields.non_diegetic_music || '',
        ...template,
      }
      : { detailed_description: String(prompt || '').trim(), ...template };
  // The prompt's own definitions say who the carried-over creative half was
  // written about — which is what lets the recast pass find the outgoing cast's
  // names, voices and speaker ids in it instead of leaving them behind.
  const previousCast = readCastFromDefinitions(existing?.subject_definitions || '');
  // Derived from who is in the shot, so they are never carried over.
  delete merged.subject_definitions;
  delete merged.retention_analysis;
  return compileCastPrompt({ previousCast, ...options, template: merged });
}
