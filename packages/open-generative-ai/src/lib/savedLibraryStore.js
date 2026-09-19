// Named, owner-sealed libraries — LoRA groups, saved prompts, Hive Persona IDs.
//
// Privacy shape: each library is ONE AES-GCM ciphertext stored in the owner
// vault under a fixed key. The entry names live inside that ciphertext together
// with their payloads, so the server does not learn how many entries exist, what
// they are called, or what any prompt says — it holds a single opaque blob per
// library and has no key to open it. Same client-only E2E model as
// generationSetupStore.js: encryptJson under the owner masterKey (derived
// in-browser from the passphrase), PUT as ciphertext, decrypt in-page on read.
//
// One blob per library rather than one per entry is deliberate: it makes the
// whole library a single atomic read/write, and it stops the server from
// learning the entry COUNT from the row count.
//
// There is no plaintext fallback. Without an unlocked owner vault, saving fails
// loudly — writing a named prompt to localStorage would put the very text this
// app exists to protect back on disk in the clear.

import { decryptJson, encryptJson } from './e2eVault.js';
import { ensureVaultReady, getVaultBlob, putVaultBlob } from './vaultSession.js';
import { isHivemindStudioEnabled } from './hivemindStudio.js';

export const LIBRARIES = {
  loraGroups: 'lora-groups',
  prompts: 'prompts',
  // Hive Persona IDs: a named set of reference media that together describe one
  // character — its pictures, how it moves, how it sounds.
  personas: 'personas',
};

const NAMESPACE = 'library';
// Vault keys allow letters/digits/dot/dash/underscore only, so the library id is
// mapped rather than used raw.
const BLOB_KEYS = {
  [LIBRARIES.loraGroups]: 'lora_groups_v1',
  [LIBRARIES.prompts]: 'prompts_v1',
  [LIBRARIES.personas]: 'personas_v1',
};

// A named save is the user's own data — never silently evict it. These caps only
// exist so a scripted/runaway writer cannot grow the blob without bound; hitting
// one is reported to the caller instead of dropping an entry.
const MAX_ENTRIES = 500;
const MAX_LIBRARY_BYTES = 4 * 1024 * 1024;

const cache = new Map();     // library -> entries[]
const loaded = new Set();    // libraries whose blob has been read this session
// Libraries whose blob came back but could not be decrypted with this key (sealed
// under an earlier vault). Listed as empty, but a write would replace the real
// library — so writes are refused until the caller says it meant to.
const unreadable = new Set();
const listeners = new Set();

export class LibraryLockedError extends Error {
  constructor() {
    super('Unlock the studio to use your saved library — it is encrypted with your key.');
    this.name = 'LibraryLockedError';
    this.locked = true;
  }
}

export class LibraryUnreadableError extends Error {
  constructor() {
    super('Your saved library could not be decrypted with this key — it may have been sealed under an earlier vault. Saving now would replace it.');
    this.name = 'LibraryUnreadableError';
    this.unreadable = true;
  }
}

function notify() {
  listeners.forEach((fn) => { try { fn(); } catch { /* a bad subscriber must not break a save */ } });
}

export function subscribeLibrary(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Cached entries without touching the network. Empty until loadLibrary resolves. */
export function peekLibrary(library) {
  return cache.get(library) || [];
}

export function isLibraryLoaded(library) {
  return loaded.has(library);
}

/** True when the stored blob exists but this key cannot open it. */
export function isLibraryUnreadable(library) {
  return unreadable.has(library);
}

function blobKey(library) {
  const key = BLOB_KEYS[library];
  if (!key) throw new Error(`Unknown library "${library}"`);
  return key;
}

async function requireVault() {
  if (!isHivemindStudioEnabled()) throw new LibraryLockedError();
  if (!(await ensureVaultReady())) throw new LibraryLockedError();
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => (left.name || '').localeCompare(right.name || '', undefined, { sensitivity: 'base' }));
}

/**
 * Read a library from the owner vault. Resolves to [] for an empty/absent
 * library. Throws LibraryLockedError when there is no unlocked owner vault, so
 * callers can prompt for an unlock instead of showing a silently empty list.
 * A failed READ (lapsed session, server error) throws too and caches NOTHING —
 * a library that could not be read must never be shown as empty, because the
 * next save would then replace it.
 */
export async function loadLibrary(library) {
  await requireVault();
  const ciphertext = await getVaultBlob(NAMESPACE, blobKey(library));
  let entries = [];
  let opened = true;
  if (ciphertext) {
    try {
      const payload = await decryptJson(ciphertext);
      if (Array.isArray(payload?.entries)) entries = payload.entries;
    } catch {
      // A blob sealed to a superseded key can't be read. List it as empty, but
      // remember that it is not: writes refuse until the caller confirms.
      entries = [];
      opened = false;
    }
  }
  if (opened) unreadable.delete(library); else unreadable.add(library);
  cache.set(library, sortEntries(entries));
  loaded.add(library);
  notify();
  return peekLibrary(library);
}

/** Load once per session; subsequent calls serve the cache. */
export async function ensureLibraryLoaded(library) {
  if (loaded.has(library)) return peekLibrary(library);
  return loadLibrary(library);
}

// The cache only moves once the server has kept the blob: putVaultBlob throws on
// a non-OK response, so a failed write leaves the cache (and the UI) as it was.
async function writeLibrary(library, entries, { overwriteUnreadable = false } = {}) {
  if (unreadable.has(library) && !overwriteUnreadable) throw new LibraryUnreadableError();
  const next = sortEntries(entries);
  if (next.length > MAX_ENTRIES) {
    throw new Error(`That would pass ${MAX_ENTRIES} saved entries — delete a few first.`);
  }
  const blob = await encryptJson({ v: 1, entries: next });
  if (blob.length > MAX_LIBRARY_BYTES) {
    throw new Error('Your saved library is full — delete a few entries first.');
  }
  await putVaultBlob(NAMESPACE, blobKey(library), blob);
  unreadable.delete(library);
  cache.set(library, next);
  loaded.add(library);
  notify();
  return next;
}

function newId() {
  try { return crypto.randomUUID(); } catch { return `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }
}

function sameName(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

/** Whether saving under this name would overwrite an existing entry. */
export function findLibraryEntryByName(library, name) {
  return peekLibrary(library).find((entry) => sameName(entry.name, name)) || null;
}

/**
 * Upsert by NAME — saving "Anime set" twice updates that group rather than
 * leaving two identically-named entries the user cannot tell apart. Callers that
 * want to warn first can check findLibraryEntryByName.
 *
 * Rejects with LibraryUnreadableError when the stored library could not be
 * decrypted with this key; pass `{ overwriteUnreadable: true }` once the user
 * has confirmed that replacing it is what they want.
 */
export async function saveLibraryEntry(library, { name, data }, { overwriteUnreadable = false } = {}) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Give it a name first.');
  await requireVault();
  await ensureLibraryLoaded(library);
  const existing = findLibraryEntryByName(library, clean);
  const entry = {
    id: existing?.id || newId(),
    name: clean,
    savedAt: new Date().toISOString(),
    data,
  };
  const rest = peekLibrary(library).filter((item) => item.id !== entry.id);
  await writeLibrary(library, [...rest, entry], { overwriteUnreadable });
  return entry;
}

export async function deleteLibraryEntry(library, id) {
  await requireVault();
  await ensureLibraryLoaded(library);
  await writeLibrary(library, peekLibrary(library).filter((entry) => entry.id !== id));
}

export async function renameLibraryEntry(library, id, name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Give it a name first.');
  await requireVault();
  await ensureLibraryLoaded(library);
  const clash = findLibraryEntryByName(library, clean);
  if (clash && clash.id !== id) throw new Error(`You already have a “${clean}”.`);
  await writeLibrary(library, peekLibrary(library).map((entry) => (
    entry.id === id ? { ...entry, name: clean, savedAt: new Date().toISOString() } : entry
  )));
}

// Test seam: drop cached state so a fresh read hits the vault again.
export function __resetLibraryCache() {
  cache.clear();
  loaded.clear();
  unreadable.clear();
}
