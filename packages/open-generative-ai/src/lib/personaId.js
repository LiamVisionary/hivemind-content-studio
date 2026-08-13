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

/** Normalise the studio's three reference lists into a persona payload. */
export function personaFromReferences({ images = [], videos = [], audios = [] } = {}) {
  return {
    v: 1,
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

/** "9 pictures · 1 motion clip · 1 voice" — the row's one-line description. */
export function personaSummary(data) {
  const { images, videos, audios } = personaCounts(data);
  const parts = [];
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
    images: persona.images,
    videos: persona.videos.map((item) => [item.url, item.useAudio]),
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
    .map((item) => inline('videos', item.url, { name: item.name, useAudio: Boolean(item.useAudio) }))
    .filter(Boolean);
  const audios = source.audios
    .map((item) => inline('audios', item.url, { name: item.name }))
    .filter(Boolean);
  return {
    document: {
      kind: PERSONA_EXPORT_KIND,
      v: PERSONA_EXPORT_VERSION,
      name: String(name || '').trim().slice(0, 120) || 'Persona',
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
    name: String(item.name || ''), useAudio: Boolean(item.useAudio),
  }));
  const audios = media(parsed.audios, (item) => ({ name: String(item.name || '') }));
  if (!images.length && !videos.length && !audios.length) {
    throw new Error('That persona export carries no references.');
  }
  return {
    name: String(parsed.name || '').trim().slice(0, 120) || 'Imported persona',
    images,
    videos,
    audios,
  };
}
