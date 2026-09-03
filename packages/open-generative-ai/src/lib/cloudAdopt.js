// Keeping a cloud result.
//
// A provider that renders in its own cloud — every MUAPI lane: Image, Video,
// Cinema, Lip Sync — hands back a URL on someone else's CDN and nothing else.
// That link expires, and a studio that only remembers it in a React state
// object loses the result the moment the window closes. Local renders never had
// this problem: they land in this workspace's outputs root, sealed, and the
// Library lists them.
//
// This is the one call that gives a cloud result the same ending. The studio
// server fetches the bytes, seals them with the SAME key path a local render
// uses (see /api/media-studio/adopt), and answers with the in-app URL of the
// kept copy. The provider's own URL is left alone: it is still what a caller
// hands BACK to the provider as an input, and a sealed envelope is not.
//
// It never throws and never blocks a generation. When it returns '' the result
// simply was not kept — which the studios say out loud, next to Download,
// rather than letting the owner find out after a relaunch.
import { isHivemindStudioEnabled } from './hivemindStudio.js';

/**
 * Keep `url` as a sealed output of this workspace.
 * @param {string} url the provider's result URL
 * @param {{kind?: 'image'|'video'|'audio', model?: string, provider?: string}} options
 * @returns {Promise<string>} the in-app URL of the kept copy, or '' when it was not kept
 */
export async function adoptCloudOutput(url, { kind = 'image', model = '', provider = '' } = {}) {
  const source = String(url || '').trim();
  // Only a provider's own http(s) result can be adopted: a data: URL is already
  // in this browser and an in-app URL is already kept.
  if (!/^https?:\/\//i.test(source)) return '';
  // Standalone has no outputs root and no vault to seal into; there is nothing
  // to adopt into and asking would 404 on every generation.
  if (!isHivemindStudioEnabled()) return '';
  try {
    const response = await fetch('/api/media-studio/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ url: source, kind, model, provider }),
    });
    if (!response.ok) return '';
    const body = await response.json().catch(() => null);
    return typeof body?.url === 'string' ? body.url : '';
  } catch {
    // Offline, or the studio server restarted mid-generation. The result is
    // still on screen and still downloadable; it is only not kept.
    return '';
  }
}

/** What a studio shows next to Download while a result exists only on screen. */
export const UNSAVED_RESULT_LABEL = Object.freeze({
  en: 'Not saved — download to keep',
  zh: '未保存 — 下载以保留',
});
