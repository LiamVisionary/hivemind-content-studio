// Who is allowed to speak to a Node surface that holds the gateway token.
//
// Written for the Canvas port (8788) and now also the local-inference bridge
// (8794, `/bridge` on the shared port). Both are proxies that attach the
// gateway's own capability token to everything they forward: to ComfyUI, which
// executes arbitrary graphs, and to the media gateway on 8787, which owns the
// whole generated library. Until this module existed neither authenticated
// anything of its own, so *reachability was authority* — anything that could
// open a socket could queue a graph, read the library, or spend the owner's
// Civitai key, and the Canvas port was published on the tailnet at boot.
//
// Loopback binding is not the answer on its own: a page on any other site can
// aim a form or a `text/plain` POST at 127.0.0.1 and the request goes through
// with whatever authority the port has. The credential is what stops that.
//
// Two credentials are accepted, because two very different callers are
// legitimate:
//
//   * the gateway token — agents, the MCP and the studio's own server-side
//     calls (`media_studio.py` sends `Authorization: Bearer <zimg-token>`),
//     none of which has a browser session;
//   * the studio account cookie — the Canvas iframe, which the webview loads
//     from `http://127.0.0.1:8788` while the studio itself is on
//     `http://127.0.0.1:8765`. Cookies are scoped by host and not by port, and
//     both origins are the same site, so the studio's own `SameSite=Lax`
//     session cookie rides along with the frame's requests. That cookie is
//     opaque here; it is checked by asking the control API, cached briefly so a
//     Canvas session does not turn one WebSocket reconnect into a request
//     storm.
//
// Everything in this file is pure except the two injected callbacks, so the
// decision table is testable without binding a port.

'use strict';

const { timingSafeEqual } = require('crypto');

// Must match ACCOUNT_COOKIE in src/hivemind_content_studio/accounts.py.
const ACCOUNT_COOKIE = 'hivemind_content_studio_account';
// Must match the cookie the media gateway mints in packages/media-gateway/app.py.
const GATEWAY_COOKIE = 'zimg_token';

// The only unauthenticated route. The supervisor (and the Tauri shell after it)
// has to know whether this child is alive before anyone has signed in, and this
// answers exactly that and nothing else — no lane list, no version, no paths.
//
// The NAME is per surface, which is why it is a parameter rather than this
// constant everywhere: the Canvas answers `/healthz`, and the bridge's probe is
// `GET /health` (docs/RELEASE.md §1, and `unified_runtime.py` polls that name
// before anyone has signed in). The rule is the same either way — one bare
// liveness path, GET or HEAD, exempt; everything else presents a credential.
const HEALTH_PATH = '/healthz';

function parseCookies(header) {
  const jar = Object.create(null);
  if (typeof header !== 'string' || !header) return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!name || name in jar) continue;
    jar[name] = part.slice(index + 1).trim();
  }
  return jar;
}

function headerValue(req, name) {
  const raw = req && req.headers ? req.headers[name] : '';
  if (Array.isArray(raw)) return String(raw[0] || '').trim();
  return String(raw || '').trim();
}

function requestUrl(req) {
  const host = headerValue(req, 'host') || 'localhost';
  try {
    return new URL((req && req.url) || '/', `http://${host}`);
  } catch {
    return new URL('/', 'http://localhost');
  }
}

/** The gateway capability token this request presents, in any accepted form. */
function presentedGatewayToken(req) {
  const authorization = headerValue(req, 'authorization');
  if (/^bearer\s+/i.test(authorization)) {
    const value = authorization.replace(/^bearer\s+/i, '').trim();
    if (value) return value;
  }
  const xToken = headerValue(req, 'x-token');
  if (xToken) return xToken;
  const cookie = parseCookies(headerValue(req, 'cookie'))[GATEWAY_COOKIE];
  if (cookie) return cookie;
  // `?token=` is how ComfyUI Mobile is opened from a link, and the gateway on
  // 8787 has always accepted it. Accepting it here does not widen anything —
  // it is the same secret in a worse place, and nothing in this repository
  // emits a new one (see `redactTokenFromUrl` in the MCP).
  const query = requestUrl(req).searchParams.get('token');
  return query ? query.trim() : '';
}

// `<id>.<expiry>.<nonce>.<b64url signature>` (accounts.py AccountAccess.issue).
// Checked here because this value is copied into an outbound Cookie header: a
// value carrying anything else is not a session, and a value carrying a control
// character would make Node throw mid-probe rather than answer.
const SESSION_COOKIE_RE = /^[A-Za-z0-9_.=-]{1,512}$/;

function accountCookieValue(req) {
  const value = parseCookies(headerValue(req, 'cookie'))[ACCOUNT_COOKIE] || '';
  return SESSION_COOKIE_RE.test(value) ? value : '';
}

function secretsMatch(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isHealthProbe(pathname, method, paths = [HEALTH_PATH]) {
  const names = Array.isArray(paths) ? paths : [paths];
  return names.includes(pathname) && (method === 'GET' || method === 'HEAD');
}

/** A browser typing the URL in, as opposed to the page's own fetch/XHR. */
function wantsHtml(req) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  // `fetch` sets Sec-Fetch-Mode: cors/no-cors; a navigation sets `navigate`.
  // Where the header exists it is the honest answer, and script cannot set it.
  const mode = headerValue(req, 'sec-fetch-mode').toLowerCase();
  if (mode) return mode === 'navigate';
  return headerValue(req, 'accept').toLowerCase().includes('text/html');
}

/**
 * Where an unauthenticated visitor should go to fix this.
 *
 * The studio's sign-in gate, on the host they already typed — so someone who
 * opened the Canvas port directly lands on the workspace picker instead of on
 * a bare 401 with nothing to press.
 */
function signInUrl(req, studioTarget) {
  let port = '8765';
  try { port = new URL(studioTarget).port || '8765'; } catch { /* keep the default */ }
  const host = headerValue(req, 'host') || '127.0.0.1:8788';
  const hostname = host.replace(/:\d+$/, '') || '127.0.0.1';
  const scheme = headerValue(req, 'x-forwarded-proto').split(',')[0].trim() || 'http';
  return `${scheme}://${hostname}:${port}/`;
}

/**
 * The refusal, as data. HTML navigations are redirected to the gate; everything
 * else gets JSON that names the same fix in a field the caller can read.
 *
 * `surface` is what the refused caller was reaching for, so the sentence names
 * the thing they were using rather than whichever surface this module was
 * written for first.
 */
function refusal(req, studioTarget, { surface = 'the Canvas' } = {}) {
  const target = signInUrl(req, studioTarget);
  if (wantsHtml(req)) {
    return {
      status: 302,
      headers: { location: target, 'cache-control': 'no-store' },
      body: '',
    };
  }
  return {
    status: 401,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify({
      error: `Sign in to the studio to use ${surface}.`,
      detail: `Open ${target} and sign in to your workspace; this tab works once you have. Agents and the MCP send the gateway token instead.`,
      privacy: 'account-locked',
      sign_in_url: target,
    }),
  };
}

/**
 * @param {object} options
 * @param {() => string} options.readGatewayToken   current on-disk gateway token
 * @param {(cookie: string) => Promise<boolean>} options.verifyAccountCookie
 * @param {string[]} [options.healthPaths]  this surface's bare liveness path(s)
 * @param {number} [options.ttlMs]      how long a positive answer is reused
 * @param {number} [options.negativeTtlMs]
 * @param {() => number} [options.now]
 */
function createCanvasGate({
  readGatewayToken,
  verifyAccountCookie,
  healthPaths = [HEALTH_PATH],
  ttlMs = 5000,
  negativeTtlMs = 1000,
  maxEntries = 64,
  now = Date.now,
} = {}) {
  const cache = new Map();
  const inflight = new Map();

  function remember(cookie, ok) {
    if (cache.size >= maxEntries) cache.clear();
    cache.set(cookie, { ok, expires: now() + (ok ? ttlMs : negativeTtlMs) });
    return ok;
  }

  async function sessionValid(cookie) {
    const cached = cache.get(cookie);
    if (cached && cached.expires > now()) return cached.ok;
    const pending = inflight.get(cookie);
    if (pending) return pending;
    // A failed probe is a refusal, never an accidental pass: if the control API
    // cannot answer, nobody gets in on a cookie.
    const probe = Promise.resolve()
      .then(() => verifyAccountCookie(cookie))
      .then((ok) => remember(cookie, Boolean(ok)))
      .catch(() => remember(cookie, false))
      .finally(() => { inflight.delete(cookie); });
    inflight.set(cookie, probe);
    return probe;
  }

  async function authorize(req, pathname, method) {
    const verb = String(method || (req && req.method) || 'GET').toUpperCase();
    if (isHealthProbe(pathname, verb, healthPaths)) return { allowed: true, reason: 'health' };
    const configured = String((readGatewayToken && readGatewayToken()) || '').trim();
    const presented = presentedGatewayToken(req);
    if (configured && presented && secretsMatch(presented, configured)) {
      return { allowed: true, reason: 'gateway-token' };
    }
    const cookie = accountCookieValue(req);
    if (!cookie) return { allowed: false, reason: 'no-credentials' };
    const ok = await sessionValid(cookie);
    return ok ? { allowed: true, reason: 'account-cookie' } : { allowed: false, reason: 'session-invalid' };
  }

  return { authorize, forget: () => cache.clear() };
}

module.exports = {
  ACCOUNT_COOKIE,
  GATEWAY_COOKIE,
  HEALTH_PATH,
  accountCookieValue,
  createCanvasGate,
  isHealthProbe,
  parseCookies,
  presentedGatewayToken,
  refusal,
  signInUrl,
  wantsHtml,
};
