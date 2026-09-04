// One versioned preferences document, replacing seven scattered storage keys.
//
// Before this, a language lived in `og_lang`, a chime in `completion_ping_enabled`,
// the prompt helper's last model in `prompt_helper_last_model`, model-use counts in
// `hivemind.producer.modelUse`, five collapsed-section booleans in `hive.section.*`,
// and two filter blobs in `inspo_filters_v1` / `models_discover_search_v1`. Seven
// stores meant no honest answer to "what has this app remembered about me?", nothing
// to export, and nothing to reset — which is exactly what a Settings page has to be
// able to say.
//
// So: ONE document (`hive.prefs.v1`), normalised on read the way the per-studio
// preference modules already are, with a subscribe API and a one-shot migration that
// moves the old keys in and then deletes them.
//
// What is NOT here, deliberately:
// - prompts, references, negative prompts, seeds tied to a prompt — the composer is
//   client-encrypted and that is where those belong (AGENTS.md);
// - credentials — the MUAPI key goes through lib/muapiKey.js and PassBook;
// - the search text of the Inspo and Discover filters. Filters are a shape you like;
//   a query is something you typed, and it is not written down.

export const PREFS_KEY = 'hive.prefs.v1';
export const PREFS_VERSION = 1;

// The old homes, kept only so the migration below can empty them.
export const LEGACY_KEYS = Object.freeze({
  lang: 'og_lang',
  completionPing: 'completion_ping_enabled',
  promptHelperModel: 'prompt_helper_last_model',
  modelUse: 'hivemind.producer.modelUse',
  inspoFilters: 'inspo_filters_v1',
  discoverFilters: 'models_discover_search_v1',
});
const LEGACY_SECTION_PREFIX = 'hive.section.';

export const DEFAULT_PREFS = Object.freeze({
  // '' means "never chosen" — i18n detects the browser locale in that case, and
  // a choice this build does not ship yet is still recorded rather than dropped.
  lang: '',
  completionPing: false,
  promptHelperModel: '',
  modelUse: {},
  sections: {},
  inspoFilters: null,
  discoverFilters: null,
});

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// A filter blob is a shape you like, and it is remembered. The free-text boxes
// INSIDE one are something you typed — the Discover search box, the Inspo
// creator box — and typed text does not go into plaintext browser storage, so
// those fields are session-only: they live in the view's own React state for as
// long as the tab is open and are dropped on the way into the document.
const FILTER_TEXT_FIELDS = new Set(['query', 'search', 'q', 'text', 'prompt', 'username', 'creator']);

function filtersWithoutTypedText(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FILTER_TEXT_FIELDS.has(key)) continue;
    out[key] = entry;
  }
  return out;
}

/** Every read goes through this: a corrupted or half-written document degrades
 *  field by field instead of throwing away everything the person had. */
export function normalizePrefs(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const counts = {};
  if (isPlainObject(source.modelUse)) {
    for (const [id, value] of Object.entries(source.modelUse)) {
      const count = Number(value);
      if (id && Number.isFinite(count) && count > 0) counts[id] = Math.floor(count);
    }
  }
  const sections = {};
  if (isPlainObject(source.sections)) {
    for (const [key, value] of Object.entries(source.sections)) {
      if (key) sections[key] = Boolean(value);
    }
  }
  return {
    v: PREFS_VERSION,
    lang: typeof source.lang === 'string' ? source.lang : '',
    completionPing: Boolean(source.completionPing),
    promptHelperModel: typeof source.promptHelperModel === 'string' ? source.promptHelperModel : '',
    modelUse: counts,
    sections,
    inspoFilters: filtersWithoutTypedText(source.inspoFilters),
    discoverFilters: filtersWithoutTypedText(source.discoverFilters),
  };
}

function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // a browser with storage switched off still runs the studio
  }
}

let cache = null;
const listeners = new Set();

function readRaw() {
  const store = storage();
  if (!store) return {};
  try {
    return JSON.parse(store.getItem(PREFS_KEY) || '{}');
  } catch {
    // A document we cannot read is a document we replace, not a boot failure.
    // The Settings page is where a person is told it happened.
    return { unreadable: true };
  }
}

/** True when the stored document could not be parsed on the last read — the one
 *  case worth telling someone about, because their settings silently reset. */
export function prefsWereUnreadable() {
  const store = storage();
  if (!store) return false;
  const stored = store.getItem(PREFS_KEY);
  if (!stored) return false;
  try {
    JSON.parse(stored);
    return false;
  } catch {
    return true;
  }
}

function write(next) {
  cache = next;
  const store = storage();
  if (store) {
    try { store.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* quota */ }
  }
  listeners.forEach((listener) => {
    try { listener(next); } catch { /* a listener owns its own errors */ }
  });
  return next;
}

/** The whole document, normalised. Cheap: parsed once per change. */
export function prefs() {
  if (!cache) cache = normalizePrefs(readRaw());
  return cache;
}

/** Drop the parsed copy so the next read re-parses. Tests use this after
 *  swapping the storage out from under the module; nothing else needs it. */
export function forgetPrefsCache() {
  cache = null;
}

/** One field, by name. */
export function pref(name) {
  const value = prefs()[name];
  return value === undefined ? DEFAULT_PREFS[name] : value;
}

/** Merge a patch and notify. Unknown fields are dropped by normalizePrefs, so a
 *  typo cannot quietly become a second setting nobody can find. */
export function setPrefs(patch) {
  return write(normalizePrefs({ ...prefs(), ...(isPlainObject(patch) ? patch : {}) }));
}

/** Called on every change with the new document. Returns an unsubscribe. */
export function subscribePrefs(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Back to defaults. The studio generation blobs are separate documents and are
 *  reset by resetStudioPreferences() below. */
export function resetPrefs() {
  const store = storage();
  if (store) {
    try { store.removeItem(PREFS_KEY); } catch { /* no storage */ }
  }
  return write(normalizePrefs(null));
}

// ── collapsed sections ──────────────────────────────────────────────────────

export function sectionOpen(storageKey, fallback = false) {
  if (!storageKey) return fallback;
  const sections = prefs().sections;
  return Object.hasOwn(sections, storageKey) ? sections[storageKey] : fallback;
}

export function setSectionOpen(storageKey, open) {
  if (!storageKey) return false;
  const next = Boolean(open);
  if (sectionOpen(storageKey, null) === next) return false;
  setPrefs({ sections: { ...prefs().sections, [storageKey]: next } });
  return true;
}

// ── the per-studio generation blobs ─────────────────────────────────────────
//
// These stay their own documents (they are already normalised on read, one
// normalizer each) but their KEYS are registered here so the allow-list of
// "everything this browser remembers" is one list rather than five greps.

export const STUDIO_PREFERENCE_KEYS = Object.freeze({
  image: 'image_generation_preferences',
  video: 'video_generation_preferences',
  lipsync: 'lipsync_generation_preferences',
});

/** Forget one studio's saved model/aspect/tuning. The studio re-reads on its
 *  next boot; the caller re-mounts it so the change is visible now. */
export function resetStudioPreferences(studio) {
  const key = STUDIO_PREFERENCE_KEYS[studio];
  const store = storage();
  if (!key || !store) return false;
  try {
    const had = store.getItem(key) !== null;
    store.removeItem(key);
    return had;
  } catch {
    return false;
  }
}

// ── export / import ─────────────────────────────────────────────────────────

// Anything whose NAME says it could be text a person typed or a credential is
// dropped on the way out, whatever it is. An export is a file that gets emailed
// to support; being conservative about it costs nothing.
const NEVER_EXPORT = /prompt|negative|key|token|secret|password|query|search|caption|text/i;

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (NEVER_EXPORT.test(key)) continue;
    out[key] = scrub(entry);
  }
  return out;
}

/** The document a person can save and carry to another machine. No secrets, no
 *  prompts, no search text — and the version, so an import knows what it has. */
export function exportPrefs() {
  const store = storage();
  const studios = {};
  for (const [studio, key] of Object.entries(STUDIO_PREFERENCE_KEYS)) {
    if (!store) continue;
    try {
      const parsed = JSON.parse(store.getItem(key) || 'null');
      if (isPlainObject(parsed)) studios[studio] = scrub(parsed);
    } catch { /* a blob we cannot read is a blob we do not export */ }
  }
  // promptHelperModel is a filename, modelUse is a tally — both travel. The
  // whole document still goes through scrub() so one added field cannot leak.
  return { app: 'hivemind-content-studio', kind: 'settings', v: PREFS_VERSION, prefs: scrub(prefs()), studios };
}

/** Take a document back in. Returns what it actually restored, so the caller can
 *  say "Restored preferences and 2 studios" instead of a bare success toast. */
export function importPrefs(document) {
  if (!isPlainObject(document) || document.kind !== 'settings') {
    throw new Error('That file is not a studio settings export.');
  }
  if (Number(document.v) > PREFS_VERSION) {
    throw new Error('That file was saved by a newer version of the studio.');
  }
  setPrefs(scrub(document.prefs));
  const restored = [];
  const store = storage();
  if (store && isPlainObject(document.studios)) {
    for (const [studio, key] of Object.entries(STUDIO_PREFERENCE_KEYS)) {
      const blob = document.studios[studio];
      if (!isPlainObject(blob)) continue;
      try {
        store.setItem(key, JSON.stringify(scrub(blob)));
        restored.push(studio);
      } catch { /* quota */ }
    }
  }
  return { prefs: true, studios: restored };
}

// ── the one-shot migration ──────────────────────────────────────────────────

/** Move the seven old keys into the document and delete them.
 *
 *  Runs once, at module load, before any reader can ask for a value — every
 *  caller imports this module, so there is no ordering to get wrong. Idempotent:
 *  a second run finds nothing left to move.
 */
export function migrateLegacyPrefs() {
  const store = storage();
  if (!store) return [];
  const moved = [];
  const patch = {};
  const take = (key) => {
    let raw = null;
    // A storage shim that answers `undefined` for a missing key is common
    // enough (and one of ours does it); `== null` treats both as absent, so a
    // key that was never there cannot look like a value worth migrating.
    try { raw = store.getItem(key); } catch { return null; }
    return raw == null || raw === '' ? null : raw;
  };
  const drop = (key) => {
    try { store.removeItem(key); } catch { /* no storage */ }
  };

  const lang = take(LEGACY_KEYS.lang);
  if (lang) { patch.lang = lang; moved.push(LEGACY_KEYS.lang); }

  const ping = take(LEGACY_KEYS.completionPing);
  if (ping !== null) { patch.completionPing = ping === '1'; moved.push(LEGACY_KEYS.completionPing); }

  const helper = take(LEGACY_KEYS.promptHelperModel);
  if (helper) { patch.promptHelperModel = helper; moved.push(LEGACY_KEYS.promptHelperModel); }

  const counts = take(LEGACY_KEYS.modelUse);
  if (counts) {
    try { patch.modelUse = JSON.parse(counts); moved.push(LEGACY_KEYS.modelUse); } catch { moved.push(LEGACY_KEYS.modelUse); }
  }

  const inspo = take(LEGACY_KEYS.inspoFilters);
  if (inspo) {
    try { patch.inspoFilters = JSON.parse(inspo); moved.push(LEGACY_KEYS.inspoFilters); } catch { moved.push(LEGACY_KEYS.inspoFilters); }
  }

  const discover = take(LEGACY_KEYS.discoverFilters);
  if (discover) {
    try {
      const parsed = JSON.parse(discover);
      // The old shape stored `{query, filters}`. The query is text a person
      // typed, so it is dropped here rather than carried into the new document.
      patch.discoverFilters = isPlainObject(parsed?.filters) ? parsed.filters : null;
      moved.push(LEGACY_KEYS.discoverFilters);
    } catch { moved.push(LEGACY_KEYS.discoverFilters); }
  }

  const sections = {};
  let sectionCount = 0;
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key && key.startsWith(LEGACY_SECTION_PREFIX)) {
        sections[key.slice(LEGACY_SECTION_PREFIX.length)] = store.getItem(key) === '1';
        sectionCount += 1;
      }
    }
  } catch { /* a store that will not enumerate keeps its sections */ }
  if (sectionCount) {
    patch.sections = { ...sections, ...(prefs().sections || {}) };
    moved.push(`${LEGACY_SECTION_PREFIX}*`);
  }

  if (!moved.length) return [];
  setPrefs(patch);
  [LEGACY_KEYS.lang, LEGACY_KEYS.completionPing, LEGACY_KEYS.promptHelperModel,
    LEGACY_KEYS.modelUse, LEGACY_KEYS.inspoFilters, LEGACY_KEYS.discoverFilters].forEach(drop);
  Object.keys(sections).forEach((name) => drop(`${LEGACY_SECTION_PREFIX}${name}`));
  return moved;
}

migrateLegacyPrefs();
