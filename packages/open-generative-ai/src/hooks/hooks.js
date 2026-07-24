// Shared React hooks bridging the immutable src/lib logic layer.
import { useEffect, useState } from 'react';
import { peekResolvedMediaSrc, resolveMediaSrc } from '../lib/e2eMedia.js';
import { getLang, setLang, t, tf } from '../lib/i18n.js';

// Same-origin API media is served as an E2E envelope (ciphertext JSON). Pointing
// an <img>/<video> at that raw URL flashes a broken image until it decrypts, so
// we hold an empty src for these until the decrypted blob URL is ready. External
// URLs (muapi CDN), data:, and blob: URLs render immediately.
function needsDecryptResolve(url) {
  return typeof url === 'string' && (url.startsWith('/api/') || url.startsWith('/open-gen-api/'));
}

function initialMediaSrc(url) {
  if (!url) return url;
  return peekResolvedMediaSrc(url) || (needsDecryptResolve(url) ? '' : url);
}

// E2E-transparent media source: sync cache hit when possible, async decrypt otherwise.
// Fail-open — resolveMediaSrc returns the raw URL on any failure. Returns '' while
// a same-origin encrypted media URL is still decrypting (render a skeleton for it).
export function useMediaSrc(url) {
  const [src, setSrc] = useState(() => initialMediaSrc(url));
  useEffect(() => {
    if (!url) {
      setSrc(url);
      return undefined;
    }
    let alive = true;
    const cached = peekResolvedMediaSrc(url);
    if (cached) {
      setSrc(cached);
      return () => { alive = false; };
    }
    setSrc(needsDecryptResolve(url) ? '' : url);
    resolveMediaSrc(url).then((resolved) => {
      if (alive && resolved) setSrc(resolved);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  return src;
}

// i18n — language switch keeps its page-reload behavior (setLang default), so no
// reactive re-render plumbing is needed; this is a convenience bundle.
export function useLang() {
  const lang = getLang();
  return {
    lang,
    zh: lang === 'zh-CN',
    t,
    tf,
    toggle: () => setLang(lang === 'zh-CN' ? 'en' : 'zh-CN'),
  };
}

// Owner session probe (topbar lock button). Absent/failed = standalone mode.
export function useOwnerSession() {
  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch('/api/owner/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((session) => {
        if (alive && session?.unlocked) setUnlocked(true);
      })
      .catch(() => { /* standalone mode — no owner gate */ });
    return () => {
      alive = false;
    };
  }, []);
  return unlocked;
}

export function useWindowEvent(name, handler) {
  useEffect(() => {
    window.addEventListener(name, handler);
    return () => window.removeEventListener(name, handler);
  }, [name, handler]);
}
