// Hive Persona ID — one character, saved as the set of references that describe
// it: the pictures it is recognised by, a clip of how it moves, a clip of how it
// sounds. Loading one refills all three reference rows at once, so a character
// built over an afternoon is one click away in every session after it.
//
// A persona holds POINTERS (owner-sealed reference URLs), never media bytes. The
// library itself is one sealed blob in the owner vault (savedLibraryStore), so
// the server learns neither the character's name nor which references make it up.
//
// This module is deliberately effect-free — no vault, no network, no React — so
// the rules that matter (what counts as an edit, what happens when a reference
// has been deleted, what happens when a workflow has fewer slots than the
// persona has references) are testable on their own.

// Order is load-bearing everywhere in reference mode: reference N is the
// prompt's <Kind N>. A persona therefore stores its references as ORDERED lists
// and restores them in that order — reshuffling on load would silently
// renumber every label in a prompt written against it.

// ---------------------------------------------------------------------------
// Gender.
//
// A persona is recognised by its pictures, but the PROMPTS written around it are
// words — and English cannot describe a person for more than a sentence without
// choosing "the woman"/"her" or "the man"/"his". Left unstated, every template
// ships one default (the starters are written for "her") and the cast compiler
// has to say "the character", which also leaves H3 free to give an unvoiced
// subject its generic adult-male voice. So the gender is part of the character,
// set once when the persona is saved, and every generator that writes about the
// persona reads it from here: the cast compiler, the reference scaffold, the
// UGC deal, the prompt helper and the shipped starters.
//
// Three values plus "not set". Not set keeps today's wording everywhere — a
// persona saved before this existed changes nothing.
export const PERSONA_GENDERS = Object.freeze(['', 'female', 'male', 'nonbinary']);

export const PERSONA_GENDER_OPTIONS = Object.freeze([
  { value: '', label: 'Not set', zh: '未设置' },
  { value: 'female', label: 'Female', zh: '女' },
  { value: 'male', label: 'Male', zh: '男' },
  { value: 'nonbinary', label: 'Non-binary', zh: '非二元' },
]);

// Alternate spellings a persona file from elsewhere (or an agent) might carry.
const GENDER_ALIASES = Object.freeze({
  f: 'female', woman: 'female', women: 'female', girl: 'female', she: 'female', her: 'female',
  m: 'male', man: 'male', men: 'male', boy: 'male', he: 'male', him: 'male', his: 'male',
  'non-binary': 'nonbinary', nb: 'nonbinary', enby: 'nonbinary', they: 'nonbinary', them: 'nonbinary',
  neutral: 'nonbinary', other: 'nonbinary', x: 'nonbinary',
});

/** One of PERSONA_GENDERS, '' for anything unknown — never throws. */
export function normalizePersonaGender(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (!key) return '';
  if (PERSONA_GENDERS.includes(key)) return key;
  return GENDER_ALIASES[key] || '';
}

export function personaGenderLabel(gender, { zh = false } = {}) {
  const option = PERSONA_GENDER_OPTIONS.find((item) => item.value === normalizePersonaGender(gender));
  if (!option || !option.value) return '';
  return zh ? option.zh : option.label;
}

// The English a prompt needs. `noun` is what to call the person; `her` is the
// possessive determiner ("her phone"), `them` the object ("filming her"), and
// `she` the subject. For non-binary the subject renders as "the person" rather
// than "they", because a template's verbs were conjugated for a singular
// subject ("she walks") and "they walks" is wrong — a noun phrase keeps every
// sentence grammatical without touching its verb. Not set reads as female,
// which is what every starter was written as, so an unset persona changes
// nothing.
const GENDER_WORDS = Object.freeze({
  female: Object.freeze({ noun: 'woman', she: 'she', her: 'her', them: 'her', hers: 'hers', herself: 'herself' }),
  male: Object.freeze({ noun: 'man', she: 'he', her: 'his', them: 'him', hers: 'his', herself: 'himself' }),
  nonbinary: Object.freeze({ noun: 'person', she: 'the person', her: 'their', them: 'them', hers: 'theirs', herself: 'themself' }),
});

export function personaGenderWords(gender) {
  return GENDER_WORDS[normalizePersonaGender(gender)] || GENDER_WORDS.female;
}

// Templates write the female form in braces — `{woman}`, `{she}`, `{her}`,
// `{them}`, `{hers}`, `{herself}` — and a capitalised token (`{Her}`) renders
// capitalised. Anything else in braces is left exactly as written, so a
// prompt's own "[brackets]" and "{curly}" notes are safe.
const GENDER_TOKEN = /\{(woman|she|her|them|hers|herself)\}/gi;

// A segment that exists for some genders only: `{f:…}`, `{m:…}`, `{nb:…}`, or
// a list — `{f,nb:…}`. Pronouns are not the only thing a template genders:
// "black wavy hair in a messy side ponytail", "minimal makeup", "crop top"
// belong to the woman the starter was written about, and rendering them for a
// man hands him her hairstyle. Such a detail is written as a segment per
// gender, or once for the genders it fits, and the others simply lose it — so
// the segment is written WITH its own surrounding spaces and punctuation.
// Simple tokens may nest one level inside (`{f,nb:tucks {her} hair back and }`).
// Unset is female, like everything else here.
const GENDER_SEGMENT = /\{(f|m|nb)((?:,(?:f|m|nb))*):((?:[^{}]|\{[^{}]*\})*)\}/g;
const SEGMENT_KEY = { female: 'f', male: 'm', nonbinary: 'nb' };

/** Render a template's gender tokens and segments for one persona. '' → the female default. */
export function renderGenderTokens(text, gender) {
  const which = normalizePersonaGender(gender);
  const key = SEGMENT_KEY[which] || 'f';
  const words = personaGenderWords(which);
  return String(text || '')
    .replace(GENDER_SEGMENT, (match, first, rest, body) => (
      `${first}${rest}`.split(',').includes(key) ? body : ''
    ))
    .replace(GENDER_TOKEN, (match, token) => {
      const name = token.toLowerCase();
      const word = words[name === 'woman' ? 'noun' : name];
      if (word === undefined) return match;
      return /^[A-Z]/.test(token) ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    });
}

/**
 * The studio's handle on a loaded persona: { id, name, gender }. One function so
 * the label is shaped the same way wherever it is set — on load, on save, on
 * cast apply, on restoring a generation — and so a persona saved before gender
 * existed comes back with gender '' instead of undefined.
 */
export function personaIdentity(value) {
  if (!value?.name) return null;
  return {
    id: String(value.id || ''),
    name: String(value.name),
    gender: normalizePersonaGender(value.gender),
  };
}

/** Normalise the studio's three reference lists (and the gender) into a persona payload. */
export function personaFromReferences({ images = [], videos = [], audios = [], gender = '' } = {}) {
  return {
    v: 1,
    gender: normalizePersonaGender(gender),
    images: (Array.isArray(images) ? images : [])
      .filter((url) => typeof url === 'string' && url)
      .map(String),
    videos: (Array.isArray(videos) ? videos : [])
      .filter((item) => item?.url)
      .map((item) => ({
        url: String(item.url),
        name: String(item.name || ''),
        // Whether the clip's own soundtrack rides along as an <Audio N> of its
        // own. It changes what the model is given, so it is part of the persona.
        useAudio: Boolean(item.useAudio),
        // Whether the clip is staged compact (a 384x1152 box) when it is a
        // motion reference — see referenceVideoCanvas. Also what the model is
        // given, so also part of the persona; absent on an older save reads as
        // off, which is the default a fresh row gets.
        compact: Boolean(item.compact),
        // A clip switched to SOUND ONLY is a voice reference (<Audio N>), not a
        // motion clip: that is what the model is given, so it is part of the
        // persona too. Written only when set, so an older save reads unchanged;
        // sound only always means the soundtrack is on.
        ...(item.motion === false ? { motion: false, useAudio: true } : {}),
      })),
    audios: (Array.isArray(audios) ? audios : [])
      .filter((item) => item?.url)
      .map((item) => ({ url: String(item.url), name: String(item.name || '') })),
  };
}

export function personaCounts(data) {
  const persona = personaFromReferences(data || {});
  const images = persona.images.length;
  const videos = persona.videos.length;
  const audios = persona.audios.length;
  return { images, videos, audios, total: images + videos + audios };
}

export function personaIsEmpty(data) {
  return personaCounts(data).total === 0;
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** "Female · 9 pictures · 1 motion clip · 1 voice" — the row's one-line description. */
export function personaSummary(data) {
  const { images, videos, audios } = personaCounts(data);
  const parts = [];
  const gender = personaGenderLabel(data?.gender);
  if (gender) parts.push(gender);
  if (images) parts.push(plural(images, 'picture', 'pictures'));
  if (videos) parts.push(plural(videos, 'motion clip', 'motion clips'));
  if (audios) parts.push(plural(audios, 'voice clip', 'voice clips'));
  return parts.join(' · ') || 'No references';
}

/** The face of the persona: its first picture, for the row thumbnail. */
export function personaPrimaryImage(data) {
  return personaFromReferences(data || {}).images[0] || null;
}

// What counts as an EDIT. Filenames are excluded on purpose: the same reference
// attached from the saved list carries no filename while the freshly-uploaded
// one does, and a persona that reported itself edited the instant it was loaded
// would make the Save button meaningless.
function fingerprint(data) {
  const persona = personaFromReferences(data || {});
  return JSON.stringify({
    // The gender is part of the character: changing it changes what every
    // template writes about them, so it counts as an edit worth saving.
    gender: persona.gender,
    images: persona.images,
    videos: persona.videos.map((item) => [item.url, item.useAudio, item.compact, item.motion === false]),
    audios: persona.audios.map((item) => item.url),
  });
}

/** Whether two persona payloads would send the model the same thing. */
export function samePersonaReferences(left, right) {
  return fingerprint(left) === fingerprint(right);
}

const DEFAULT_LIMITS = { images: 9, videos: 3, audios: 3 };

// The route the saved-reference listing enumerates. Only URLs under it can be
// judged present-or-deleted by that listing; anything else it simply cannot see.
const REFERENCE_NAMESPACE = '/api/media-studio/references/';

const labelFor = (kind, item) => {
  const name = typeof item === 'string' ? '' : String(item?.name || '');
  if (name) return name;
  return { images: 'a picture', videos: 'a motion clip', audios: 'a voice clip' }[kind];
};

/**
 * Turn a saved persona back into the three reference lists.
 *
 * `known` — the set of reference URLs that still exist on the server, from the
 * saved-reference listing. A persona outlives the files it points at: deleting a
 * clip and then loading a persona that used it would otherwise attach a URL that
 * fails at generation time, minutes later, with nothing to connect it to. Pass
 * null (or omit) to skip the check — an unreachable listing must not be read as
 * "everything is gone".
 *
 * `limits` — the slot counts of the workflow that will actually run. A persona
 * saved against nine picture slots must not silently overfill a graph with six.
 *
 * Anything dropped comes back in `missing`/`trimmed` so the caller can say so
 * rather than quietly loading a smaller character than the one that was saved.
 */
export function applyPersonaToReferences(data, { limits = DEFAULT_LIMITS, known = null } = {}) {
  const persona = personaFromReferences(data || {});
  // The listing speaks for ONE namespace: the owner's saved reference uploads.
  // A reference attached from anywhere else — a generated output reused as a
  // picture, a clip from another lane — was never in it, and its absence there
  // is not evidence that it was deleted. Judging those against the listing
  // dropped perfectly good references on load, which is the same mistake the
  // `known === null` case above already guards against, made per-URL.
  const checkable = (url) => String(url || '').includes(REFERENCE_NAMESPACE);
  const exists = known instanceof Set
    ? (url) => !checkable(url) || known.has(url)
    : () => true;
  const missing = [];
  const trimmed = [];
  const take = (kind, items, urlOf) => {
    const live = items.filter((item) => {
      if (exists(urlOf(item))) return true;
      missing.push(labelFor(kind, item));
      return false;
    });
    const cap = Number(limits?.[kind] ?? DEFAULT_LIMITS[kind]);
    if (live.length > cap) trimmed.push({ kind, dropped: live.length - cap });
    return live.slice(0, Math.max(0, cap));
  };
  return {
    images: take('images', persona.images, (url) => url),
    videos: take('videos', persona.videos, (item) => item.url),
    audios: take('audios', persona.audios, (item) => item.url),
    gender: persona.gender,
    missing,
    trimmed,
  };
}

// ---------------------------------------------------------------------------
// Portable personas.
//
// A persona in the vault is POINTERS — owner-sealed reference URLs. Those mean
// nothing anywhere else: another machine cannot decrypt them, and another
// person has no business trying. So a persona that travels has to carry the
// MEDIA, inline, and be re-uploaded into the receiving vault on import.
//
// The bytes ride as data URLs, which is also the shape the MCP already accepts
// (image_base64 / video_base64 / audio_base64) — an exported persona is
// therefore directly submittable as well as re-importable.
//
// These two functions stay effect-free like the rest of this module: decrypting
// the references, fetching their bytes, and re-uploading them on the way back in
// belong to the caller. What lives here is the FORMAT and its validation.

export const PERSONA_EXPORT_KIND = 'hive-persona';
export const PERSONA_EXPORT_VERSION = 1;

const dataUrlish = (value) => typeof value === 'string' && value.startsWith('data:');

/** File name for an exported persona: readable, sortable, safe on every OS. */
export function personaExportFilename(name) {
  const slug = String(name || 'persona')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'persona';
  return `${slug}.hivepersona.json`;
}

/**
 * Build the portable document. `media` maps a reference URL to its inline data
 * URL — whatever the caller managed to decrypt and read.
 *
 * A reference whose bytes could not be read is DROPPED and reported rather than
 * exported as a dangling pointer: a persona that silently arrives with two of
 * its three pictures is worse than one that says so.
 */
export function buildPersonaExport({ name, persona, media = {}, exportedAt = '' } = {}) {
  const source = personaFromReferences(persona || {});
  const dropped = [];
  const inline = (kind, url, extra = {}) => {
    const dataUrl = media[url];
    if (!dataUrlish(dataUrl)) {
      dropped.push(labelFor(kind, extra.name ? { name: extra.name } : url));
      return null;
    }
    return { ...extra, dataUrl };
  };
  // Built BEFORE the document: these mappers are what populate `dropped`, so
  // reading it in an object literal above them would always see it empty.
  const images = source.images.map((url) => inline('images', url)).filter(Boolean);
  const videos = source.videos
    .map((item) => inline('videos', item.url, {
      name: item.name, useAudio: Boolean(item.useAudio), compact: Boolean(item.compact),
      ...(item.motion === false ? { motion: false } : {}),
    }))
    .filter(Boolean);
  const audios = source.audios
    .map((item) => inline('audios', item.url, { name: item.name }))
    .filter(Boolean);
  return {
    document: {
      kind: PERSONA_EXPORT_KIND,
      v: PERSONA_EXPORT_VERSION,
      name: String(name || '').trim().slice(0, 120) || 'Persona',
      // Travels with the character: the receiving studio's templates need it
      // as much as this one's did. Omitted when not set.
      ...(source.gender ? { gender: source.gender } : {}),
      exportedAt: String(exportedAt || ''),
      // What the persona HELD, beside what this file managed to carry. A
      // backup that quietly ships fewer references than the character had is
      // worse than no backup: it looks complete. Recorded in the document so
      // the file is self-describing long after the export toast is gone.
      savedCounts: {
        images: source.images.length,
        videos: source.videos.length,
        audios: source.audios.length,
      },
      ...(dropped.length ? { incomplete: dropped } : {}),
      images,
      videos,
      audios,
    },
    dropped,
  };
}

/**
 * Validate a document someone hands us. Returns { name, images, videos, audios }
 * with data URLs, or throws with a sentence a person can act on.
 *
 * This is the trust boundary for a shared file: it is read as DATA, never as
 * instructions, and anything that is not an inline media payload is refused —
 * an "export" carrying http(s) URLs would make the importer fetch whatever a
 * stranger points it at.
 */
export function parsePersonaExport(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('That file is not a persona export (it is not valid JSON).');
    }
  }
  if (!parsed || typeof parsed !== 'object' || parsed.kind !== PERSONA_EXPORT_KIND) {
    throw new Error('That file is not a Hive Persona export.');
  }
  if (Number(parsed.v) > PERSONA_EXPORT_VERSION) {
    throw new Error(`That persona was exported by a newer version of the studio (v${parsed.v}).`);
  }
  const media = (list, extra) => (Array.isArray(list) ? list : [])
    .filter((item) => dataUrlish(item?.dataUrl))
    .map((item) => ({ ...extra(item), dataUrl: String(item.dataUrl) }));
  const images = media(parsed.images, () => ({}));
  const videos = media(parsed.videos, (item) => ({
    name: String(item.name || ''), useAudio: Boolean(item.useAudio), compact: Boolean(item.compact),
    ...(item.motion === false ? { motion: false, useAudio: true } : {}),
  }));
  const audios = media(parsed.audios, (item) => ({ name: String(item.name || '') }));
  if (!images.length && !videos.length && !audios.length) {
    throw new Error('That persona export carries no references.');
  }
  return {
    name: String(parsed.name || '').trim().slice(0, 120) || 'Imported persona',
    gender: normalizePersonaGender(parsed.gender),
    images,
    videos,
    audios,
  };
}
