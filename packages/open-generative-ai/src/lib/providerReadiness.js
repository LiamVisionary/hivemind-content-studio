// Whether a provider can actually run right now — and the action that fixes it
// when it cannot.
//
// The rule this exists for: never present a problem in a place where the
// solution could have been offered instead. Picking GPT Image 2 under the
// OAuth provider and pressing Draw used to answer "OpenAI GPT Image (ChatGPT
// sign-in): Invalid refresh token." That sentence is not an instruction, it
// arrives after the press rather than before it, and the remedy — reconnect the
// account — was two pages away.
//
// So readiness is resolved BEFORE the press, rendered on the row that offers
// the model, and carries the button that repairs it.
//
// It is deliberately one module rather than a check inside each picker: the
// same four questions (is the grant live? is the key present? is the bridge
// there? is the provider up?) are asked by every studio, and four copies would
// drift the way the dispatch did.
import { flattenApiDetail } from './muapiErrors.js';
import { needsBrowserKey, setMuapiKeyOnServer, transportFor } from './modelRunner.js';

/** Which OAuth connection a provider's credential is, when it is a grant
 *  rather than a key. Mirrors image_router.Route.oauth on the server. */
export const PROVIDER_OAUTH = Object.freeze({
  'openai-gpt-image-oauth': 'openai',
  'xai-imagine-oauth': 'xai',
});

/** Providers whose credential is an API key held on the server, named so a
 *  missing one can say WHICH key rather than "not configured".
 *
 *  The catalog row is the source of truth when it carries one (providers.py
 *  now declares `keys` on every provider that needs credentials); this map is
 *  the fallback for rows fetched from an older server, and for the hosted
 *  route whose token is not a provider key. */
export const PROVIDER_KEYS = Object.freeze({
  'openai-gpt-image': 'OPENAI_API_KEY',
  'xai-imagine-api': 'XAI_API_KEY',
  'higgsfield-cloud': 'HIGGSFIELD_API_KEY_ID and HIGGSFIELD_API_KEY_SECRET',
  'hivemindos-hosted-media': 'HIVEMINDOS_DASHBOARD_DEVICE_TOKEN',
});

/** The credential names a row is waiting for: what the catalog declared, else
 *  the map above. Returns [] when the row needs none this browser can name. */
export function keyNamesFor(row) {
  const declared = Array.isArray(row?.keys) ? row.keys.filter(Boolean).map(String) : [];
  if (declared.length) return declared;
  const known = PROVIDER_KEYS[String(row?.provider || '')];
  // The legacy map's Higgsfield entry is prose, not a name — split it back.
  return known ? known.split(/\s+and\s+/) : [];
}

/**
 * Ask this machine whether it holds the MUAPI key, and remember the answer.
 *
 * Presence only — the value never comes back. Seeded into modelRunner because
 * that is what decides whether a row still has to prompt for one.
 */
export async function refreshMuapiKeyLocation({ signal = null } = {}) {
  try {
    const response = await fetch('/api/muapi/status', { credentials: 'same-origin', signal });
    if (!response.ok) { setMuapiKeyOnServer(false); return false; }
    const body = await response.json();
    const present = Boolean(body?.server_key);
    setMuapiKeyOnServer(present);
    return present;
  } catch {
    setMuapiKeyOnServer(false);
    return false;
  }
}

/** The OAuth connections the studio knows about, or null when the status
 *  cannot be read (which is itself worth saying, rather than assuming ready). */
export async function fetchOAuthStatus({ signal = null } = {}) {
  try {
    const response = await fetch('/api/oauth', { credentials: 'same-origin', signal });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.providers && typeof body.providers === 'object' ? body.providers : null;
  } catch {
    return null;
  }
}

/**
 * Begin a reconnect. Returns the URL the owner has to visit.
 *
 * The studio opens it rather than printing it: an authorize URL a person has to
 * copy is the same failure as an error they have to interpret.
 */
export async function startOAuthLogin(provider, { signal = null } = {}) {
  const response = await fetch(`/api/oauth/${encodeURIComponent(provider)}/start`, {
    method: 'POST', credentials: 'same-origin', signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.authorize_url) {
    const detail = body?.detail;
    // A sign-in whose callback cannot land is refused BEFORE the browser opens.
    // Sending someone to authorize an account and then stranding them on
    // ERR_CONNECTION_REFUSED spends their approval and returns nothing.
    if (detail && typeof detail === 'object' && detail.remedy === 'fix-callback') {
      const error = new Error(detail.message || 'The sign-in has nowhere to come back to.');
      error.instruction = String(detail.instruction || '');
      error.target = String(detail.target || '');
      throw error;
    }
    throw new Error(flattenApiDetail(detail ?? body?.error) || 'Could not start the sign-in.');
  }
  return body.authorize_url;
}

/**
 * What state this row's provider is in, and what to do about it.
 *
 * `state` is one of:
 *   ready       nothing to do
 *   connect     there is no grant yet — offer sign-in
 *   reconnect   the grant is stale or revoked — offer sign-in again
 *   key         a server-side API key is missing — say which one
 *   browser-key the MUAPI key this browser holds is missing — offer the dialog
 *   offline     the provider is down, or the studio cannot reach its transport
 *   unroutable  nothing can run it here
 */
export function readinessFor(row, { oauth = null } = {}) {
  const route = transportFor(row);
  const provider = String(row?.provider || '');

  if (route.transport === 'none') {
    return { state: 'unroutable', label: 'Cannot run here', detail: route.reason, action: null, blocks: true };
  }
  if (!route.runnable) {
    return { state: 'offline', label: 'Unavailable', detail: route.reason, action: null, blocks: true };
  }
  if (route.transport === 'muapi') {
    // The key this machine already holds counts. Asking for one that HivemindOS
    // has had all along is the same failure as any other avoidable prompt.
    return needsBrowserKey(row)
      ? {
        state: 'browser-key',
        label: 'No API key',
        // The dialog the action opens stores it as MUAPI_API_KEY on this machine
        // — not an env var to go and set, and not a browser-only copy.
        detail: 'This machine has no MUAPI key yet. Add one and it is kept as MUAPI_API_KEY in the shared store, for every Hive app here.',
        action: { kind: 'muapi-key', label: 'Add key' },
        blocks: true,
      }
      : { state: 'ready', label: '', detail: '', action: null, blocks: false };
  }

  const connection = PROVIDER_OAUTH[provider];
  if (connection) {
    // A status we could not read is NOT a pass. Saying "ready" and failing at
    // generation time is the exact experience this module replaces.
    const status = oauth?.[connection];
    if (!status) {
      return {
        state: 'offline',
        label: 'Sign-in status unknown',
        detail: 'The studio could not reach HivemindOS to check this connection.',
        action: { kind: 'oauth', provider: connection, label: 'Check again' },
        blocks: false,
      };
    }
    if (status.needs_reconnect || (status.connected && !status.usable)) {
      return {
        state: 'reconnect',
        label: 'Sign-in expired',
        detail: status.detail || 'This connection needs authorizing again.',
        action: { kind: 'oauth', provider: connection, label: 'Reconnect' },
        blocks: true,
      };
    }
    if (!status.connected) {
      return {
        state: 'connect',
        label: 'Not connected',
        detail: status.detail || 'This account is not connected yet.',
        action: { kind: 'oauth', provider: connection, label: 'Connect' },
        blocks: true,
      };
    }
    return { state: 'ready', label: 'Connected', detail: '', action: null, blocks: false };
  }

  const keys = keyNamesFor(row);
  if (keys.length && row?.available === false) {
    return {
      state: 'key',
      label: 'Not configured',
      // The sentence the server wrote, when it wrote one — "Needs a MUAPI key"
      // rather than an env-var name aimed at whoever set the machine up.
      detail: String(row?.needs || '') || `${keys.join(' and ')} is not set in the shared Hive environment.`,
      // Never a state without its repair: this opens the same inline key field
      // the producer picker uses, rather than leaving the row a dead end.
      action: { kind: 'key', key: keys[0], keys, label: 'Add key' },
      blocks: true,
    };
  }
  // A row the server says is unavailable is unavailable, whether or not this
  // browser can name its credential. Calling it ready and failing at generation
  // time is the exact experience this module replaces.
  if (row?.available === false) {
    return {
      state: 'offline',
      label: 'Unavailable',
      detail: String(row?.needs || row?.detail || '') || 'This provider is not set up on this machine yet.',
      action: null,
      blocks: true,
    };
  }
  return { state: 'ready', label: '', detail: '', action: null, blocks: false };
}

/**
 * Turn a failed generation into the same shape a picker row uses.
 *
 * The server sends `{message, remedy, provider}` precisely so a failure can
 * become a button. A caller that renders `message` alone has thrown the fix
 * away.
 */
export function readinessFromError(detail) {
  const message = typeof detail === 'string' ? detail : String(detail?.message || '');
  const remedy = typeof detail === 'object' ? String(detail?.remedy || '') : '';
  const provider = typeof detail === 'object' ? String(detail?.provider || '') : '';
  if (remedy === 'reconnect' && provider) {
    return {
      state: 'reconnect',
      label: 'Sign-in expired',
      detail: message,
      action: { kind: 'oauth', provider, label: 'Reconnect' },
      blocks: true,
    };
  }
  return { state: 'error', label: '', detail: message, action: null, blocks: false };
}
