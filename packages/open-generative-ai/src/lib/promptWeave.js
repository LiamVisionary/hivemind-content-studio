// The weave: whatever you press gets woven into the prompt.
//
// The video composer used to have a dozen controls that each edited the prompt
// by its own private rules — the Prompts menu recast onto a cast only if the
// Cast menu had been used, the References panel's "Add tags" knew one subject
// and one format, the Character quick-add appended past the end of a
// three-field prompt and landed inside non_diegetic_music, the helper's output
// was re-tagged but never recast. Every control was right on its own and they
// did not compose, which is what "it doesn't weave" meant (2026-08-23).
//
// This module is the one rule that replaces them:
//
//   the prompt is a rendering of WHO is in the shot, WHAT happens, and the
//   run's length — and every door that hands a prompt to the composer, or
//   changes who is in the shot, goes through weavePrompt().
//
// WHO is the cast (castPrompt.js): an ordered list of members, each of which
// is a <Subject N>. Members come from three places and this module makes them
// one list —
//
//   references   pictures / motion clips / voice clips attached by hand or by
//                loading a Hive Persona ID. These are a member too: whoever is
//                in your references is <Subject 1> without anybody having to
//                open a Cast menu first. reconcileCast() derives that member
//                from the rows every time the rows change.
//   persona      a saved Hive Persona ID added from the Cast menu. Brings its
//                own media, which the weave loads into the rows.
//   character    a name H3 already knows. Brings text, occupies no slot.
//   scene        a place or a staging sheet — the Story studio's location plate
//                and storyboard. Occupies picture slots and carries its own
//                retention contract, but is nobody: no <Subject N>, no speaker,
//                no voice. A picture the cast cannot account for is one H3
//                reads as another person, which is how an empty room comes back
//                with a stranger in it.
//
// WHAT happens is the text in the composer — a starter, a library prompt, the
// helper's draft, the Shot Builder's timeline, or something typed. Starters
// record which words are the stand-in person (subjectTemplate.js), so a loaded
// starter binds its stand-in to whoever holds <Subject 1>; a six-section prompt
// carries its own cast in subject_definitions and recasts exactly.
//
// The TARGET decides the grammar: H3 reference mode is the six-section form
// and addresses members as <Subject N>; H3 text mode is the three-field form
// where a known character is written by its source form and a stand-in binds
// to that; every other family gets prose. weaveTarget() picks it from what is
// attached — never from a dropdown.
//
// Pure: no React, no storage, no network. The studio calls it; tests prove it.
import {
  PERSONA_DEFAULT_STYLE,
  SCENE_RETENTION,
  applyCastToPrompt,
  castCharacter,
  castPersona,
  castScene,
  isSixSectionPrompt,
  parseSixSections,
} from './castPrompt.js';
import {
  applyCharacterToPrompt,
  characterPromptText,
  characterVoiceText,
} from './h3Characters.js';
import { parseFieldPrompt } from './h3References.js';
import { normalizePersonaGender, personaGenderWords } from './personaId.js';
import { fitShotTimeline } from './shotTimeline.js';
import { bindStandIns, liveStandIns } from './subjectTemplate.js';

export const DEFAULT_LIMITS = Object.freeze({ images: 9, videos: 3, audios: 3 });

/** The key of the member that IS "the person in your references" when no persona names them. */
export const REFERENCES_KEY = 'references';

// How a cartoon is DRAWN, which is not the same as who it is. Left native by
// default; the CGI option exists because a flat-2D character standing next to a
// photographed person is the one combination people actually ask for, and
// because saying nothing let a scene style restyle BOTH of them (2026-08-12).
export const CHARACTER_STYLES = Object.freeze([
  { id: 'native', style: '' },
  {
    id: 'cgi',
    style: '3D CGI character animation with soft subsurface shading and cinematic lighting — '
      + 'semi-realistic and physically present in the scene, NOT flat 2D animation and NOT pixel art',
  },
]);

export const characterStyleById = (id) => CHARACTER_STYLES.find((option) => option.id === id) || CHARACTER_STYLES[0];

/* ---------------- members, as the studio holds them ---------------- */

/** A saved Hive Persona ID as a cast member. */
export const personaMember = (entry) => ({
  key: `persona:${entry.id}`,
  kind: 'persona',
  name: String(entry.name || ''),
  data: entry.data || {},
});

/**
 * A known character as a cast member. One constructor for the Cast menu and
 * the Character quick-add alike: two ways of adding the same cartoon that
 * produced two different members would be two casts.
 */
export const characterCastMember = (entry) => ({
  key: `character:${entry.name}`,
  kind: 'character',
  name: entry.name,
  entry,
  styleId: 'native',
  // A known character's voice is asked for by NAME, in the dialogue tag. On by
  // default: it is the only way this character can sound like itself, since it
  // brings no voice clip to clone.
  useVoice: true,
});

/** The next free `person:N` key — deterministic, so tests and replays agree. */
export function nextPersonKey(members = []) {
  const taken = (members || [])
    .map((member) => /^person:(\d+)$/.exec(member?.key || ''))
    .filter(Boolean)
    .map((hit) => Number(hit[1]));
  return `person:${(taken.length ? Math.max(...taken) : 0) + 1}`;
}

/**
 * A brand-new person, added on purpose before any media exists — "anyone can
 * be a second subject". `explicit` keeps it in the cast while its rows are
 * still empty (a derived member with no media would leave the shot); it fills
 * from the media attached FOR it (reconcileCast's `claimNew`), or stays
 * text-defined by its name, gender and look.
 */
export function newPersonMember(members = []) {
  return {
    key: nextPersonKey(members),
    kind: 'persona',
    name: '',
    explicit: true,
    data: { v: 1, gender: '', look: '', images: [], videos: [], audios: [] },
  };
}

/**
 * A place or a staging sheet, as a member.
 *
 * Held in the cast rather than beside it because the cast IS the annotation
 * that says what each reference row is: a picture the cast cannot account for
 * is one H3 reads as another person, and the whole point of an empty location
 * plate is that it holds nobody. It occupies picture slots and gets its own
 * retention contract; it never takes a <Subject N>, a speaker id or a voice.
 */
export const sceneMember = ({ key, name = '', images = [], retention = 'attribute_transfer', carries = '' } = {}) => ({
  key: String(key || 'scene'),
  kind: 'scene',
  name: String(name || ''),
  retention: SCENE_RETENTION[retention] ? retention : 'attribute_transfer',
  carries: String(carries || ''),
  data: { v: 1, images: [...images].filter(Boolean), videos: [], audios: [] },
});

/** The references attached by hand, as a member. `persona` names it when a Persona ID is loaded. */
export const referencesMember = ({ images = [], videos = [], audios = [], persona = null, gender = '', look = '' } = {}) => ({
  key: persona?.id ? `persona:${persona.id}` : REFERENCES_KEY,
  kind: 'persona',
  name: String(persona?.name || ''),
  data: {
    v: 1,
    gender: normalizePersonaGender(persona?.gender || gender),
    look: String(persona?.look || look || ''),
    images: [...images],
    videos: [...videos],
    audios: [...audios],
  },
});

/** Studio member -> the cast description castPrompt.js compiles. */
export function toCastMember(member) {
  if (member.kind === 'scene') {
    return castScene(member.name, {
      images: (member.data?.images || []).map(urlOf).filter(Boolean),
      retention: member.retention,
      carries: member.carries,
    });
  }
  // A member may carry its own render style. The photoreal default is right for
  // a Hive Persona ID — a photographed human — and wrong for a Story studio cast,
  // where the production's own style covers everyone and "real human skin
  // texture and hair" was being asserted about a cat. An empty string is a
  // deliberate choice and writes no style line at all.
  if (member.kind === 'persona') {
    if (member.style === undefined && !member.noun) return castPersona(member.name, member.data);
    return castPersona(member.name, member.data, {
      ...(member.style === undefined ? {} : { style: member.style }),
      noun: member.noun || '',
    });
  }
  return castCharacter(member.name, characterPromptText(member.entry), {
    style: characterStyleById(member.styleId).style,
    voice: member.useVoice ? characterVoiceText(member.entry) : '',
    // Naming a voice only retrieves it if the model can place the name; when it
    // cannot it falls back to a generic adult male, which is what a named
    // SpongeBob came back as (2026-08-13). The catalog's description of the
    // timbre is the fallback.
    voiceQuality: member.useVoice ? String(member.entry?.voiceQuality || '') : '',
  });
}

const isPersonaLike = (member) => member?.kind === 'persona';
const isScene = (member) => member?.kind === 'scene';
/** Members that occupy reference rows — people and places alike. */
const holdsMedia = (member) => isPersonaLike(member) || isScene(member);
const urlOf = (item) => (typeof item === 'string' ? item : String(item?.url || ''));
const ROW_KINDS = ['images', 'videos', 'audios'];

/** Whether a member brings any media at all. */
export function memberHasMedia(member) {
  if (!holdsMedia(member)) return false;
  return ROW_KINDS.some((kind) => (member.data?.[kind] || []).length > 0);
}

/**
 * Derive the cast from the reference rows.
 *
 * The rows are what the model is actually given, so they are the truth about
 * media; the cast is the annotation saying who each row belongs to. This keeps
 * the two in step whenever either changes:
 *
 *   - a persona-like member keeps the row items it owns (matched by URL), in
 *     ROW order, and drops the ones that are gone;
 *   - an item nobody owns joins the single persona-like member when there is
 *     exactly one (adding a picture to a loaded persona is editing THAT persona
 *     — the PersonaBar's "Edited" semantic), else the references member, which
 *     is created if needed right after the last persona-like member (first in
 *     the cast when there is none — a person with pictures is the protagonist);
 *   - a persona-like member with no media left leaves the shot;
 *   - a loaded Persona ID (`persona`) names the references member.
 *
 * Characters pass through untouched. Returns a NEW list; the input is never
 * mutated.
 */
export function reconcileCast(members = [], rows = {}, { persona = null, claimNew = '' } = {}) {
  const list = Array.isArray(members) ? members : [];
  const attached = {
    images: (rows.images || []).filter(Boolean),
    videos: (rows.videos || []).filter((item) => urlOf(item)),
    audios: (rows.audios || []).filter((item) => urlOf(item)),
  };
  const carriers = list.filter(holdsMedia);
  const owned = new Map(); // url -> member key
  for (const member of carriers) {
    for (const kind of ROW_KINDS) {
      for (const item of member.data?.[kind] || []) {
        const url = urlOf(item);
        if (url && !owned.has(url)) owned.set(url, member.key);
      }
    }
  }

  const next = list.map((member) => (holdsMedia(member)
    ? { ...member, data: { ...(member.data || {}), images: [], videos: [], audios: [] } }
    : member));
  const byKey = new Map(next.filter(holdsMedia).map((member) => [member.key, member]));
  const unowned = { images: [], videos: [], audios: [] };
  for (const kind of ROW_KINDS) {
    for (const item of attached[kind]) {
      const owner = byKey.get(owned.get(urlOf(item)));
      if (owner) owner.data[kind].push(item);
      else unowned[kind].push(item);
    }
  }

  const anyUnowned = ROW_KINDS.some((kind) => unowned[kind].length);
  if (anyUnowned) {
    const holders = next.filter(isPersonaLike);
    // Only PEOPLE claim unowned media. A picture dropped on the composer is a
    // person's until told otherwise; landing it on the location plate would
    // silently make it part of the room.
    // `claimNew` says WHO the newly attached media is for — set when the user
    // pressed "+ Pictures" on a member's chip, or just added another person.
    // Without it: a single person takes everything (adding a picture to the
    // one person in the shot is editing THAT person), else the anonymous
    // references member.
    let target = (claimNew && holders.find((member) => member.key === claimNew)) || null;
    if (!target && !claimNew) {
      target = holders.length === 1
        ? holders[0]
        : holders.find((member) => member.key === REFERENCES_KEY) || null;
    }
    if (!target) {
      target = claimNew && claimNew !== REFERENCES_KEY
        ? { ...newPersonMember(next), key: claimNew }
        : referencesMember({ persona });
      const lastPersona = next.map(isPersonaLike).lastIndexOf(true);
      next.splice(lastPersona + 1, 0, target);
    }
    for (const kind of ROW_KINDS) target.data[kind].push(...unowned[kind]);
  }

  // A loaded Persona ID names the anonymous references member — unless that
  // persona is already in the cast under its own key, in which case the
  // identity's gender and look (edited in the PersonaBar) flow onto it. The
  // strip edits the member and the identity is re-derived from it afterwards,
  // so the two never disagree for long whichever side was touched.
  if (persona?.id) {
    const named = next.find((member) => member.key === `persona:${persona.id}`);
    const anonymous = named ? null : next.find((member) => member.key === REFERENCES_KEY);
    const target = named || anonymous;
    if (target) {
      target.key = `persona:${persona.id}`;
      target.name = String(persona.name || target.name || '');
      target.data = { ...target.data };
      if (persona.gender !== undefined) target.data.gender = normalizePersonaGender(persona.gender || (named ? '' : target.data.gender));
      if (persona.look !== undefined && (persona.look || named)) target.data.look = String(persona.look || '');
    }
  }

  // A derived member with no media left leaves the shot; one the user added on
  // purpose (`explicit`) stays — it may be text-defined, or still waiting for
  // its pictures. Removing it is the ✕ on its chip.
  return next.filter((member) => !holdsMedia(member) || memberHasMedia(member) || member.explicit);
}

/** The rows the whole cast occupies, in cast order — what the References panel should hold. */
export function castRows(members = []) {
  const rows = { images: [], videos: [], audios: [] };
  for (const member of members) {
    if (!holdsMedia(member)) continue;
    for (const kind of ROW_KINDS) rows[kind].push(...(member.data?.[kind] || []));
  }
  return rows;
}

/** The {id, name, gender, look} the rows still ARE, or null when the cast is more than one persona. */
export function castPersonaIdentity(members = []) {
  const holders = (members || []).filter(isPersonaLike);
  if (holders.length !== 1) return null;
  const only = holders[0];
  if (!only.key.startsWith('persona:')) return null;
  return {
    id: only.key.slice('persona:'.length),
    name: only.name,
    gender: normalizePersonaGender(only.data?.gender),
    look: String(only.data?.look || ''),
  };
}

/** The gender a template should render for: whoever holds <Subject 1>. */
export function castRenderGender(members = []) {
  const first = (members || []).filter((member) => !isScene(member))[0];
  if (!first) return '';
  if (isPersonaLike(first)) return normalizePersonaGender(first.data?.gender);
  return normalizePersonaGender(first.entry?.gender);
}

/** True when a member carries something the model can hear as its voice. */
function memberHasVoice(member) {
  if (!isPersonaLike(member)) return Boolean(member.useVoice);
  const data = member.data || {};
  return (data.audios || []).length > 0 || (data.videos || []).some((item) => item?.useAudio || item?.motion === false);
}

/**
 * The cast as the prompt helper is told about it — slot, kind, gender, voice,
 * look, and a NAME only for a known character (a persona's name is sealed to
 * the owner's vault and never leaves the browser).
 */
export function castSubjects(members = []) {
  return (members || []).filter((member) => !isScene(member)).map((member, index) => ({
    subject: index + 1,
    kind: isPersonaLike(member) ? 'persona' : 'character',
    gender: isPersonaLike(member) ? normalizePersonaGender(member.data?.gender) : normalizePersonaGender(member.entry?.gender),
    name: isPersonaLike(member) ? '' : String(member.name || ''),
    voice: memberHasVoice(member),
    look: isPersonaLike(member) ? String(member.data?.look || '') : '',
  }));
}

/** "You · 3 pictures · voice" / "SpongeBob · known character" for a chip. */
export function describeMember(member, { zh = false } = {}) {
  if (isScene(member)) {
    const count = (member.data?.images || []).length;
    const staging = member.retention === 'weak_reference';
    if (zh) return staging ? `分镜参考 · ${count} 张` : `场景参考 · ${count} 张`;
    return `${staging ? 'staging sheet' : 'place'} · ${count} picture${count === 1 ? '' : 's'} · nobody`;
  }
  if (!isPersonaLike(member)) return zh ? '已知角色' : 'known character';
  const data = member.data || {};
  const parts = [];
  const images = (data.images || []).length;
  const motion = (data.videos || []).filter((item) => item?.motion !== false).length;
  const voice = (data.audios || []).length + (data.videos || []).filter((item) => item?.useAudio || item?.motion === false).length;
  if (images) parts.push(zh ? `${images} 张图` : `${images} picture${images === 1 ? '' : 's'}`);
  if (motion) parts.push(zh ? `${motion} 段动作` : `${motion} motion clip${motion === 1 ? '' : 's'}`);
  if (voice) parts.push(zh ? '声音' : 'voice');
  if (!parts.length) {
    return String(data.look || '').trim()
      ? (zh ? '仅文字定义' : 'described in text')
      : (zh ? '还没有图片' : 'no pictures yet');
  }
  return parts.join(' · ');
}

/* ---------------- the weave ---------------- */

/**
 * Which grammar the prompt is woven into, from what the run will actually do.
 *
 *   reference  MiniMax H3 with a reference lane and media attached → the
 *              six-section form, members as <Subject N>.
 *   h3-text    MiniMax H3 with nothing attached → the three-field form; a
 *              character is written by its source form.
 *   prose      every other family.
 */
export function weaveTarget({ h3 = false, referenceLane = false, rows = null } = {}) {
  if (!h3) return 'prose';
  const attached = rows && ROW_KINDS.some((kind) => (rows[kind] || []).length);
  return referenceLane && attached ? 'reference' : 'h3-text';
}

/**
 * Both halves of a cast, from the members and whatever is in the composer:
 * the recast prompt and the rows the members occupy.
 */
export function castApplication({
  members = [], prompt = '', limits = DEFAULT_LIMITS, durationSeconds = 0, standIns = [], scaffold = false,
  template = null,
} = {}) {
  const result = applyCastToPrompt(prompt, {
    members: members.map(toCastMember), limits: limits || DEFAULT_LIMITS, durationSeconds, standIns, scaffold,
    // A door that arrives with the creative half already broken out — the Story
    // studio hands over beats, a soundscape and a music rule rather than one
    // paragraph — supplies it here. Everything else passes null and the prompt
    // text is parsed for it, exactly as before.
    ...(template ? { template } : {}),
  });
  const { images, videos, audios } = result.allocation;
  return {
    prompt: result.prompt,
    images,
    videos,
    audios,
    warnings: result.warnings,
    persona: castPersonaIdentity(members),
    standIns: result.standIns,
  };
}

/**
 * A known character woven into a prompt that has no subject grammar: a bare
 * name is enriched in place; otherwise the source form is written into the
 * description — INSIDE integrated_multimodal_description for a three-field
 * prompt, never past its end where it lands in the music (2026-08-23).
 */
function weaveCharacterProse(text, entry) {
  const fields = parseFieldPrompt(text);
  if (!fields) return applyCharacterToPrompt(text, entry);
  const full = characterPromptText(entry);
  if (!full || text.toLowerCase().includes(full.toLowerCase())) return text;
  const bare = new RegExp(`\\b${String(entry.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  if (bare.test(text)) return text.replace(bare, full);
  const description = String(fields.integrated_multimodal_description || '').trim();
  const separator = !description ? '' : (/[.!?,;:]$/.test(description) ? ' ' : ', ');
  const nextDescription = `${description}${separator}${full}`;
  // Rewrite the one field and keep the rest byte-for-byte.
  return text.replace(
    /(integrated_multimodal_description[ \t]*:[ \t]*)([\s\S]*?)(?=\n[ \t]*(?:overall_soundscape|non_diegetic_music)[ \t]*:|$)/,
    (whole, head) => `${head}${nextDescription}${/\n\n$/.test(whole) ? '\n\n' : (/\n$/.test(whole) ? '\n' : '')}`,
  );
}

/**
 * Weave a prompt: bind stand-ins, recast onto the cast, write the reference
 * rows the cast occupies, and refit the shot timeline to the run's length.
 *
 * `text`      what arrived — from a starter, the library, the helper, the Shot
 *             Builder, an insert bridge, or the composer itself.
 * `cast`      the members (already reconciled with the rows).
 * `target`    from weaveTarget().
 * `standIns`  the stand-ins recorded when the text was rendered (or null).
 * `scaffold`  true for the explicit Weave button: write the dialogue stub and a
 *             placeholder shot for an empty composer.
 * `template`  the creative half already broken out (beats, summary, soundscape,
 *             music, an opening style line) for a door that HAS the structure —
 *             the Story studio's six staged decisions. Reference target only;
 *             every other target renders `text` as it arrived.
 *
 * Returns { prompt, rows, warnings, refit, persona, standIns } where `rows` is
 * null when the weave did not decide the rows (no reference target), `refit`
 * is fitShotTimeline's report, and `standIns` are the ones still unbound.
 */
export function weavePrompt(text, {
  cast = [], limits = DEFAULT_LIMITS, durationSeconds = 0, target = 'prose', standIns = null, scaffold = false,
  template = null,
} = {}) {
  const source = String(text || '');
  const live = liveStandIns(source, standIns || []);
  let prompt = source;
  let rows = null;
  let warnings = [];
  let persona = null;
  let remaining = live;

  if (target === 'reference' && cast.length) {
    const woven = castApplication({ members: cast, prompt: source, limits, durationSeconds, standIns: live, scaffold, template });
    prompt = woven.prompt;
    rows = { images: woven.images, videos: woven.videos, audios: woven.audios };
    warnings = woven.warnings;
    persona = woven.persona;
    remaining = woven.standIns?.remaining || [];
  } else if (cast.length) {
    // No subject grammar: a stand-in binds to a character's source form, or to
    // a TEXT-DEFINED person's own description (name, gender, look — a person
    // with pictures cannot be rendered here, so their stand-in stays as
    // written), and a character nothing mentions is written in.
    const people = cast.filter((member) => !isScene(member));
    const characters = people.filter((member) => !isPersonaLike(member));
    const bound = bindStandIns(source, live, (index) => {
      const member = people[index - 1];
      if (!member) return null;
      if (!isPersonaLike(member)) return characterPromptText(member.entry);
      if (memberHasMedia(member)) return null;
      return prosePersonPhrase(member);
    });
    prompt = bound.text;
    remaining = bound.remaining;
    if (target === 'h3-text' || target === 'prose') {
      for (const member of characters) {
        if (!bound.bound.includes(people.indexOf(member) + 1)) prompt = weaveCharacterProse(prompt, member.entry);
      }
    }
    persona = castPersonaIdentity(cast);
  }

  const refit = fitShotTimeline(prompt, durationSeconds);
  return {
    prompt: refit.prompt,
    rows,
    warnings,
    refit,
    persona,
    standIns: remaining,
  };
}

/** "Ana, a woman — tall, red coat —" for a text-defined person in plain prose, or '' when there is nothing to say. */
export function prosePersonPhrase(member) {
  const gender = normalizePersonaGender(member?.data?.gender);
  const noun = gender && gender !== 'nonbinary' ? personaGenderWords(gender).noun : 'person';
  const look = String(member?.data?.look || '').trim();
  const name = String(member?.name || '').trim();
  if (!look && !name) return '';
  return `${name ? `${name}, ` : ''}a ${noun}${look ? ` — ${look} —` : ''}`;
}

/** True when a prompt is already woven for reference mode (carries subject definitions). */
export function isWovenForReference(text) {
  if (!isSixSectionPrompt(text)) return false;
  const sections = parseSixSections(text) || {};
  return /<Subject \d+>/.test(String(sections.subject_definitions || ''));
}

export { PERSONA_DEFAULT_STYLE };
