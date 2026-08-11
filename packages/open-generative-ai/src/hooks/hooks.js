// Shared React hooks bridging the immutable src/lib logic layer.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCivitaiDownloads, subscribeCivitaiDownloads } from '../lib/civitaiDownloadStore.js';
import { getRentalLoras, refreshRentalLoras, subscribeRentalLoras } from '../lib/rentalLoras.js';
import { peekResolvedMediaSrc, resolveMediaSrc } from '../lib/e2eMedia.js';
import { captureVideoPoster, peekVideoPoster } from '../lib/videoPoster.js';
import { ensureLibraryLoaded, isLibraryLoaded, peekLibrary, subscribeLibrary } from '../lib/savedLibraryStore.js';
import { getLang, setLang, t, tf } from '../lib/i18n.js';

// Same-origin API media is served as an E2E envelope (ciphertext JSON). Pointing
// an <img>/<video> at that raw URL flashes a broken image until it decrypts, so
// we hold an empty src for these until the decrypted blob URL is ready. External
// URLs (muapi CDN), data:, and blob: URLs render immediately.
function needsDecryptResolve(url) {
  return typeof url === 'string' && (url.startsWith('/api/') || url.startsWith('/open-gen-api/'));
}

// Which URLs provably CANNOT be an E2E envelope, so probing them is pure waste.
//
// This deliberately lists what to SKIP rather than what to probe. An earlier
// version enumerated the sealed paths instead (/api/, /open-gen-api/, cross-origin)
// and broke generated media outright: the gateway serves outputs from `/image/…`,
// which that list missed, so the <img> was pointed at raw envelope JSON and every
// result rendered broken. Anything not named here gets probed, which is fail-safe —
// the cost of a needless probe is a wasted request, the cost of a missed one is
// undecryptable media.
function cannotBeSealed(url) {
  if (typeof url !== 'string' || !url) return true;
  // A data: URL announces its own MIME type, so it classifies itself with no probe.
  // Crucially it can still BE an envelope: the local bridge inlines whatever the
  // gateway returned as `data:<contentType>;base64,…`, and for a sealed output that
  // payload is the envelope JSON, not an image. Treating every data: URL as
  // unsealed put the raw envelope in <img src> and every generated result rendered
  // broken — a plain `data:image/png` still skips the probe, as intended.
  if (url.startsWith('data:')) return !/^data:[^,]*hivemind\.e2e/i.test(url);
  // We minted blob: URLs ourselves, from already-decrypted bytes.
  if (url.startsWith('blob:')) return true;
  // The local-AI bridge (model + LoRA card art) is never sealed, and probing it
  // downloaded every thumbnail a second time just to read a header.
  return /^(\/open-gen-api)?\/local-ai\//.test(url);
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
    if (cannotBeSealed(url)) {
      setSrc(url); // render directly; no probe possible or needed
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

// A video's first frame, as a data URL, for thumbnails. Decrypts the clip like
// useMediaSrc does, then decodes ONE frame from it — a <video> pointed at a blob
// paints nothing until it has decoded something, which is why sealed clips
// showed up as identical placeholder icons.
//
// Returns { poster, resolved, pending }: `poster` when a frame was decoded,
// `resolved` so the caller can still mount a real <video> if it prefers, and
// `pending` to tell "still working" apart from "this clip cannot be decoded".
export function useVideoPoster(url) {
  const resolved = useMediaSrc(url);
  const [poster, setPoster] = useState(() => peekVideoPoster(resolved));
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!resolved) {
      setPoster(null);
      setPending(false);
      return undefined;
    }
    const cached = peekVideoPoster(resolved);
    if (cached !== null) {
      setPoster(cached);
      setPending(false);
      return undefined;
    }
    let alive = true;
    setPending(true);
    captureVideoPoster(resolved).then((value) => {
      if (!alive) return;
      setPoster(value);
      setPending(false);
    });
    return () => { alive = false; };
  }, [resolved]);
  return { poster, resolved, pending };
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

// Every Civitai download in flight. Two views need them — a pending card each, and
// an in-place state on the LoRA card a replace supersedes — so the subscription
// lives here once.
export function useCivitaiDownloads() {
  const [list, setList] = useState(getCivitaiDownloads);
  useEffect(() => subscribeCivitaiDownloads(setList), []);
  return list;
}

// The rental-LoRA registry (which installed LoRAs rented machines download at
// provisioning). `active` gates the fetch: most sessions never open the panel
// in dev mode or Rented source, and the registry lives behind the owner-gated
// control API, so don't even ask until someone can act on the answer.
export function useRentalLoras(active = true) {
  const [registry, setRegistry] = useState(getRentalLoras);
  useEffect(() => {
    if (!active) return undefined;
    const unsubscribe = subscribeRentalLoras(setRegistry);
    void refreshRentalLoras();
    return unsubscribe;
  }, [active]);
  return registry;
}

// An owner-sealed named library (LoRA groups, saved prompts). Reads the vault
// blob once per session and re-renders every consumer on save/delete, so the LoRA
// panel and both studios' prompt menus stay in step. `locked` (no unlocked owner
// vault) is distinct from an empty library — the UI must say "unlock" rather than
// "you have none saved", which would read as data loss.
export function useSavedLibrary(library) {
  const [state, setState] = useState(() => ({
    entries: peekLibrary(library),
    loading: !isLibraryLoaded(library),
    locked: false,
  }));
  const aliveRef = useRef(true);

  // Also used to recover from `locked`: the studio can mount before the owner
  // unlocks, and the message we show tells them to go and unlock — so opening the
  // menu again has to actually re-check instead of showing that message forever.
  const read = useCallback(() => {
    setState((prev) => ({ ...prev, loading: true }));
    ensureLibraryLoaded(library)
      .then(() => { if (aliveRef.current) setState({ entries: peekLibrary(library), loading: false, locked: false }); })
      .catch((error) => { if (aliveRef.current) setState({ entries: [], loading: false, locked: Boolean(error?.locked) }); });
  }, [library]);

  useEffect(() => {
    aliveRef.current = true;
    const off = subscribeLibrary(() => {
      if (aliveRef.current) setState((prev) => ({ ...prev, entries: peekLibrary(library) }));
    });
    if (!isLibraryLoaded(library)) read();
    return () => { aliveRef.current = false; off(); };
  }, [library, read]);

  return { ...state, retry: read };
}

export function useWindowEvent(name, handler) {
  useEffect(() => {
    window.addEventListener(name, handler);
    return () => window.removeEventListener(name, handler);
  }, [name, handler]);
}
