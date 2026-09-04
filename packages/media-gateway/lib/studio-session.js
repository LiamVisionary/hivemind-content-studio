// Is this cookie a signed-in studio workspace?
//
// The one session probe both gated Node surfaces make: `server.js` for the
// Canvas, and `open-generative-ai/hosted-server.js` for the local-inference
// bridge. It lives beside `canvas-gate.js` rather than inside it because the
// gate's decision table is deliberately pure and this is a network round trip
// — but there is exactly ONE of these, so the two surfaces cannot drift into
// two different ideas of what a session is.
//
// The answer is a boolean and nothing else. The control API's reply body never
// leaves this file: a caller that is refused learns where to sign in, not what
// the control API said.

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const { ACCOUNT_COOKIE } = require('./canvas-gate');

/** Where the control API answers, with any trailing slash removed. */
function studioTarget(env = process.env) {
  return String(env.HIVEMIND_STUDIO_TARGET || 'http://127.0.0.1:8765').replace(/\/+$/, '');
}

/**
 * Ask the control API whether this session cookie is a signed-in workspace.
 *
 * @param {string} cookieValue  a value `canvas-gate` has already shape-checked
 * @param {string} [target]     the control API origin
 * @returns {Promise<boolean>}  never rejects: a probe that cannot answer is a no
 */
function verifyAccountCookie(cookieValue, target = studioTarget()) {
  return new Promise((resolve) => {
    // One try/catch around the whole thing: anything that throws here — a bad
    // target URL, a header Node refuses — has to become a refusal, because a
    // promise that neither resolves nor rejects would hang the request.
    try {
      const url = new URL('/api/owner/session', target);
      const lib = url.protocol === 'https:' ? https : http;
      const request = lib.get(url, {
        headers: {
          accept: 'application/json',
          cookie: `${ACCOUNT_COOKIE}=${cookieValue}`,
        },
      }, (upstream) => {
        const chunks = [];
        upstream.on('data', (chunk) => chunks.push(chunk));
        upstream.on('end', () => {
          if ((upstream.statusCode || 500) !== 200) { resolve(false); return; }
          try { resolve(Boolean(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').unlocked)); }
          catch { resolve(false); }
        });
      });
      request.setTimeout(4000, () => request.destroy(new Error('session probe timeout')));
      request.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

module.exports = { studioTarget, verifyAccountCookie };
