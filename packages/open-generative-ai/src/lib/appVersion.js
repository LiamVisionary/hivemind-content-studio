// The product's version, as this bundle knows it.
//
// One number, one source: `[project] version` in pyproject.toml. `vite.config.mjs`
// reads that file and substitutes it for `__APP_VERSION__` at build; the control
// API reads the same value through Python package metadata and returns it from
// `GET /api/version`. The topbar chip can therefore name a version immediately,
// with no request, and the About page confirms it against the server — the two
// disagreeing is itself worth showing, because it means the page came from a
// different build than the one answering it.
//
// Outside a Vite build — `node --test`, a bare import in a tool — the constant
// does not exist. That is not an error; it means "ask the API".
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

// A commit is 40 hex characters and no one reads more than the first seven.
export function shortCommit(commit) {
  const value = String(commit || '').trim();
  return /^[0-9a-f]{7,40}$/i.test(value) ? value.slice(0, 7) : '';
}

// "v0.1.0 · 0a0fd7b" when both are known, and whichever half is known otherwise.
// Never the empty string dressed as a version: a chip that reads "v" is worse
// than a chip that reads nothing.
export function versionLabel({ version = '', commit = '' } = {}) {
  const tag = String(version || '').trim();
  const parts = [];
  if (tag) parts.push(tag.startsWith('v') ? tag : `v${tag}`);
  const short = shortCommit(commit);
  if (short) parts.push(short);
  return parts.join(' · ');
}
