// Where the MUAPI key is stored, and the ONE way to store it.
//
// Two doors used to exist for the same secret: PassBook (the machine's shared
// credential store, which /api/muapi proxies through so the key never enters
// the browser) and a plaintext localStorage 'muapi_key' that AuthModal and the
// Settings modal wrote and eighteen call sites read. A machine that already
// held the key was still asked for one, and the copy pasted in reply was never
// used. This module is the one door: in studio mode the key goes to the shared
// store; only the standalone build (no studio server) keeps it in the browser.
//
// Pure like the rest of src/lib — no React, no toast. Callers say what happened.
import { isHivemindStudioEnabled } from './hivemindStudio.js';
import { saveProviderKey } from './localProducer.js';
import { setMuapiKeyOnServer } from './modelRunner.js';
import { muapi } from './muapi.js';
import { refreshMuapiKeyLocation } from './providerReadiness.js';

export const MUAPI_CREDENTIAL = 'MUAPI_API_KEY';
const BROWSER_KEY = 'muapi_key';

/** The legacy browser copy, or '' — read in one place so the reads can go. */
export function browserMuapiKey() {
  try { return String(localStorage.getItem(BROWSER_KEY) || ''); } catch { return ''; }
}

export function forgetBrowserMuapiKey() {
  try { localStorage.removeItem(BROWSER_KEY); } catch { /* no storage */ }
}

// The shared store cannot take the key here: the route is not served (a
// standalone build), the home is containerised (409), or the host does not
// hold credentials (501). Every one of these is "keep it in the browser
// instead", not a dead end.
function storeUnavailable(error) {
  const status = Number(error?.status);
  return status === 404 || status === 405 || status === 409 || status === 501;
}

/**
 * Store the key where this build keeps credentials.
 *
 * Resolves to `{ where: 'machine' | 'browser' }`. On the machine the key is
 * saved as MUAPI_API_KEY in the shared store, the browser's answer to "does
 * this machine hold it" is flipped without a round trip, and the client's
 * cached route is forgotten so the very next call proxies — no reload. Any
 * stale browser copy is removed at the same time: two stores for one secret
 * is the bug this replaces.
 *
 * Throws when the store refused the value for a reason the owner has to act
 * on (a blank value, an owner gate, a server fault) — the caller renders that
 * inline, next to the field.
 */
export async function storeMuapiKey(value, { signal = null } = {}) {
  const key = String(value || '').trim();
  if (!key) throw new Error('Paste the key first.');
  if (isHivemindStudioEnabled()) {
    try {
      await saveProviderKey(MUAPI_CREDENTIAL, key, { signal });
      setMuapiKeyOnServer(true);
      forgetBrowserMuapiKey();
      muapi.resetRoute();
      return { where: 'machine' };
    } catch (error) {
      if (!storeUnavailable(error)) throw error;
    }
  }
  localStorage.setItem(BROWSER_KEY, key);
  muapi.resetRoute();
  return { where: 'browser' };
}

/**
 * Seed "does this machine hold the key" once at boot, and move a legacy
 * browser copy into the shared store while at it.
 *
 * Resolves to `{ onServer, migrated }`: `migrated` is true only when a key
 * that lived in this browser was written to the machine's store just now —
 * the caller says so, because a credential that silently changed homes is a
 * surprise the next time someone looks for it. A browser copy on a machine
 * that already holds the key is simply removed; a copy the store would not
 * take stays where it is, and the direct route keeps working with it.
 */
export async function seedMuapiKeyLocation({ signal = null } = {}) {
  const onServer = await refreshMuapiKeyLocation({ signal });
  if (!isHivemindStudioEnabled()) return { onServer, migrated: false };
  const stale = browserMuapiKey();
  if (!stale) return { onServer, migrated: false };
  if (onServer) {
    forgetBrowserMuapiKey();
    return { onServer, migrated: false };
  }
  try {
    const result = await storeMuapiKey(stale, { signal });
    return { onServer: result.where === 'machine', migrated: result.where === 'machine' };
  } catch {
    return { onServer: false, migrated: false };
  }
}
