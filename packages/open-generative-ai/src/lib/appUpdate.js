// Is there a newer build than this one?
//
// One manifest, one answer. The desktop shell's updater reads
// `<source>/releases/latest/download/latest.json` (desktop/src-tauri/updater.json
// is its single source of truth, and scripts/check_updater_config.py holds
// tauri.conf.json to it) — so the page reads the SAME file rather than inventing
// a second notion of "latest". A release the shell would install is exactly a
// release the page reports, and a promotion that has not happened is invisible
// to both: the promote workflow writes latest.json, so building a release is not
// the same as offering it (docs/RELEASE.md §4).
//
// The base URL is not hard-coded here. It is derived from the `source_url` the
// page already receives from GET /api/version — the same identity the shell's
// endpoint is built from (identity.py SOURCE_URL) — so the two cannot point at
// different repositories.
//
// Failing to reach GitHub is not a state worth a word on screen. There is no
// error path in the UI: either an update is known, or nothing is said.

/** The manifest's path under the repository. Mirrors updater.json's endpoint. */
export const UPDATE_MANIFEST_PATH = '/releases/latest/download/latest.json';
/** Where a person goes to read and fetch the release themselves. */
export const RELEASES_PATH = '/releases/latest';

// A promoted release does not appear the moment it is cut, and nobody needs to
// know within the minute. Checked once per session and then at most this often.
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CACHE_KEY = 'studio.updateCheck';

const trimRepo = (sourceUrl) => String(sourceUrl || '').trim().replace(/\/+$/, '');

/** `https://github.com/owner/repo` -> the manifest URL the shell also reads. */
export function updateManifestUrl(sourceUrl) {
  const base = trimRepo(sourceUrl);
  return base ? `${base}${UPDATE_MANIFEST_PATH}` : '';
}

/** `https://github.com/owner/repo` -> the page a person can open. */
export function releasesUrl(sourceUrl) {
  const base = trimRepo(sourceUrl);
  return base ? `${base}${RELEASES_PATH}` : '';
}

/**
 * Compare two version strings. Returns >0 when `a` is newer, <0 when older, 0
 * when the same.
 *
 * Numeric parts compare as numbers ("0.10.0" is newer than "0.9.0", which a
 * string compare gets wrong). A prerelease is OLDER than the release it leads
 * to, so "0.2.0-beta.1" < "0.2.0" — otherwise promoting 0.2.0 would look like a
 * downgrade to anyone running the beta.
 */
export function compareVersions(a, b) {
  const split = (value) => {
    const clean = String(value || '').trim().replace(/^v/i, '');
    const [core, pre = ''] = clean.split('-', 2);
    return {
      core: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
      pre: pre ? pre.split('.') : [],
    };
  };
  const left = split(a);
  const right = split(b);
  const depth = Math.max(left.core.length, right.core.length);
  for (let index = 0; index < depth; index += 1) {
    const diff = (left.core[index] || 0) - (right.core[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // Same core. No prerelease beats a prerelease.
  if (!left.pre.length && right.pre.length) return 1;
  if (left.pre.length && !right.pre.length) return -1;
  const preDepth = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < preDepth; index += 1) {
    const one = left.pre[index];
    const two = right.pre[index];
    if (one === two) continue;
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    const numeric = /^\d+$/.test(one) && /^\d+$/.test(two);
    if (numeric) return Number(one) > Number(two) ? 1 : -1;
    return one > two ? 1 : -1;
  }
  return 0;
}

function readCache() {
  try {
    const raw = window.sessionStorage?.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function writeCache(entry) {
  try { window.sessionStorage?.setItem(CACHE_KEY, JSON.stringify(entry)); } catch { /* quota */ }
}

/**
 * Ask whether a newer build has been promoted.
 *
 * @param {object}  options
 * @param {string}  options.sourceUrl  the repository, from GET /api/version
 * @param {string}  options.current    this build's version
 * @param {number}  options.now        current epoch ms (passed in, so the cache
 *                                     window is testable without a fake clock)
 * @param {boolean} options.force      ignore the cache
 * @returns {Promise<{version: string, notes: string, url: string}|null>}
 *          the newer release, or null — which also covers "no releases yet",
 *          "offline", and "this build is already the latest".
 */
export async function checkForUpdate({ sourceUrl, current, now = Date.now(), force = false } = {}) {
  const manifest = updateManifestUrl(sourceUrl);
  if (!manifest || !String(current || '').trim()) return null;

  const cached = readCache();
  if (!force && cached && cached.manifest === manifest && now - Number(cached.at || 0) < MIN_INTERVAL_MS) {
    return cached.found || null;
  }

  let found = null;
  try {
    // No credentials: this is a public release asset, and sending the studio's
    // cookies to github.com would be a leak for no gain.
    const response = await fetch(manifest, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    // 404 is the ordinary answer before the first release is promoted.
    if (response.ok) {
      const body = await response.json();
      const version = String(body?.version || '').trim();
      if (version && compareVersions(version, current) > 0) {
        found = {
          version: version.replace(/^v/i, ''),
          notes: String(body?.notes || '').trim(),
          url: releasesUrl(sourceUrl),
        };
      }
    }
  } catch { /* offline, blocked, or malformed — say nothing */ }

  writeCache({ manifest, at: now, found });
  return found;
}
