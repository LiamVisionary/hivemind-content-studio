// Shared React hooks bridging the immutable src/lib logic layer.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCivitaiDownloads, subscribeCivitaiDownloads } from '../lib/civitaiDownloadStore.js';
import { getRentalBuild, refreshRentalBuild, subscribeRentalBuild } from '../lib/rentalBuild.js';
import { getRentalLoras, refreshRentalLoras, subscribeRentalLoras } from '../lib/rentalLoras.js';
import {
  mediaSealFailure, peekResolvedMediaSrc, releaseResolvedMedia, resolveMediaSrc,
  retainResolvedMedia, subscribeMediaSealFailures,
} from '../lib/e2eMedia.js';
import { captureImagePoster, captureVideoPoster, peekMediaPoster } from '../lib/mediaPoster.js';
import { ensureLibraryLoaded, isLibraryLoaded, isLibraryUnreadable, peekLibrary, subscribeLibrary } from '../lib/savedLibraryStore.js';
import { VAULT_UNLOCKED_EVENT } from '../lib/vaultSession.js';

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

// Bumped when the vault opens in this tab (VaultUnlockModal). Every media hook
// keys its resolve effect on it, so what was drawn as a locked tile re-resolves
// in place — the reason unlocking no longer has to reload the page.
export function useVaultUnlockNonce() {
  const [nonce, setNonce] = useState(0);
  useWindowEvent(VAULT_UNLOCKED_EVENT, useCallback(() => setNonce((n) => n + 1), []));
  return nonce;
}

// E2E-transparent media source: sync cache hit when possible, async decrypt otherwise.
// Fail-open — resolveMediaSrc returns the raw URL on any failure. Returns '' while
// a same-origin encrypted media URL is still decrypting (render a skeleton for it).
export function useMediaSrc(url) {
  const [src, setSrc] = useState(() => initialMediaSrc(url));
  const unlocked = useVaultUnlockNonce();
  useEffect(() => {
    if (!url) {
      setSrc(url);
      return undefined;
    }
    let alive = true;
    // This mount is a consumer of the decrypted bytes for as long as it holds
    // them on screen. The cache evicts by least-recently-used above a byte
    // budget, and a retained URL is the one thing it will not take back — which
    // is what stops a scroll from revoking an object URL a live <img> is using.
    retainResolvedMedia(url);
    const done = () => { alive = false; releaseResolvedMedia(url); };
    const cached = peekResolvedMediaSrc(url);
    if (cached) {
      setSrc(cached);
      return done;
    }
    if (cannotBeSealed(url)) {
      setSrc(url); // render directly; no probe possible or needed
      return done;
    }
    setSrc(needsDecryptResolve(url) ? '' : url);
    resolveMediaSrc(url).then((resolved) => {
      if (alive && resolved) setSrc(resolved);
    });
    return done;
  }, [url, unlocked]);
  return src;
}

// Why the sealed media at `url` could not be opened here ('locked',
// 'undecryptable', or null), kept live by subscription.
//
// Reading the registry during render is NOT enough on its own: useMediaSrc's
// fail-open setSrc hands back the same URL the element already had, and React
// bails out of a re-render when the state value is unchanged — so the caller
// would keep showing a dead player. The subscription is what guarantees the flip.
export function useMediaSealFailure(url) {
  const [reason, setReason] = useState(() => mediaSealFailure(url));
  const unlocked = useVaultUnlockNonce();
  useEffect(() => {
    setReason(mediaSealFailure(url));
    return subscribeMediaSealFailures((changed) => {
      if (changed === url) setReason(mediaSealFailure(url));
    });
  }, [url, unlocked]);
  return reason;
}

// A small poster for a sealed reference, as a data URL.
//
// Decrypts the source like useMediaSrc does, then reduces it to a thumbnail:
// one decoded frame for a clip (a <video> pointed at a blob paints nothing
// until it decodes something, which is why sealed clips showed up as identical
// placeholder icons), or a downscale for a picture (which renders fine, but
// only after the whole multi-megabyte original has come down to fill 36px).
//
// Returns { poster, resolved, pending }: `poster` when one was produced,
// `resolved` so the caller can still mount the real media if it prefers, and
// `pending` to tell "still working" apart from "this cannot be decoded".
export function useMediaPoster(url, { kind = 'video' } = {}) {
  const resolved = useMediaSrc(url);
  const [poster, setPoster] = useState(() => peekMediaPoster(resolved));
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!resolved) {
      setPoster(null);
      setPending(false);
      return undefined;
    }
    const cached = peekMediaPoster(resolved);
    if (cached !== null) {
      setPoster(cached);
      setPending(false);
      return undefined;
    }
    let alive = true;
    setPending(true);
    const capture = kind === 'image' ? captureImagePoster : captureVideoPoster;
    capture(resolved).then((value) => {
      if (!alive) return;
      setPoster(value);
      setPending(false);
    });
    return () => { alive = false; };
  }, [resolved, kind]);
  return { poster, resolved, pending };
}

// Does this clip actually carry sound?
//
// Asked of the FILE, not of the model that made it. The stage's "Sound" badge
// used to be `/minimax/.test(model)` with a comment that other lanes were
// silent — true when it was written, and wrong since LTX 2.3, which denoises a
// joint audio+video latent and scores every clip it renders. A name test also
// could not tell a graph that wires the audio out from one that samples it and
// drops it, which is a real failure this codebase has already had.
//
// mediabunny answers it exactly, off the same probe clipPrep uses for the
// last-frame grab. Resolved URLs are blob: handles held by the media cache, so
// the fetch is a memory read rather than a second decrypt, and the answer is
// cached per URL for the session.
const clipAudioCache = new Map();

export function useClipHasAudio(url) {
  const resolved = useMediaSrc(url);
  const [hasAudio, setHasAudio] = useState(() => clipAudioCache.get(resolved) ?? false);
  useEffect(() => {
    if (!resolved) { setHasAudio(false); return undefined; }
    const cached = clipAudioCache.get(resolved);
    if (cached !== undefined) { setHasAudio(cached); return undefined; }
    let alive = true;
    // Unknown until it is known: a badge that appears a beat late is honest,
    // one that guesses is not.
    setHasAudio(false);
    (async () => {
      try {
        const blob = await (await fetch(resolved)).blob();
        const { probeClip } = await import('../lib/clipPrep.js');
        const probed = await probeClip(blob);
        clipAudioCache.set(resolved, Boolean(probed?.hasAudio));
      } catch {
        // An unreadable clip is not a silent one; say nothing rather than
        // stamping "Sound" or promising silence.
        clipAudioCache.set(resolved, false);
      }
      if (alive) setHasAudio(clipAudioCache.get(resolved) || false);
    })();
    return () => { alive = false; };
  }, [resolved]);
  return hasAudio;
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

// The project rental build (packages/gpu-rentals/rental-build.json) — which
// LoRAs and which checkpoint each rental tier's next machines are provisioned
// with. `editable` is the whole gate: it is true only where this install is a
// git checkout the control API can write that file into, which is what makes
// the page a development surface without a ?dev=1 URL nobody can type into a
// packaged window.
export function useRentalBuild(active = true) {
  const [build, setBuild] = useState(getRentalBuild);
  useEffect(() => {
    if (!active) return undefined;
    const unsubscribe = subscribeRentalBuild(setBuild);
    void refreshRentalBuild();
    return unsubscribe;
  }, [active]);
  return build;
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
    // A read that FAILED (lapsed session, server error) — distinct from locked
    // and from empty, so the menu can say "couldn't open" with a Retry instead
    // of the "nothing saved yet" hint that invites a save over the real library.
    error: '',
    // The blob is there but this key cannot open it; writes need confirming.
    unreadable: isLibraryUnreadable(library),
  }));
  const aliveRef = useRef(true);

  // Also used to recover from `locked`: the studio can mount before the owner
  // unlocks, and the message we show tells them to go and unlock — so opening the
  // menu again has to actually re-check instead of showing that message forever.
  const read = useCallback(() => {
    setState((prev) => ({ ...prev, loading: true, error: '' }));
    ensureLibraryLoaded(library)
      .then(() => {
        if (aliveRef.current) {
          setState({ entries: peekLibrary(library), loading: false, locked: false, error: '', unreadable: isLibraryUnreadable(library) });
        }
      })
      .catch((error) => {
        if (!aliveRef.current) return;
        const locked = Boolean(error?.locked);
        setState({
          entries: [],
          loading: false,
          locked,
          error: locked ? '' : (error?.message || 'Could not open your library.'),
          unreadable: false,
        });
      });
  }, [library]);

  useEffect(() => {
    aliveRef.current = true;
    const off = subscribeLibrary(() => {
      if (aliveRef.current) setState((prev) => ({ ...prev, entries: peekLibrary(library), unreadable: isLibraryUnreadable(library) }));
    });
    if (!isLibraryLoaded(library)) read();
    return () => { aliveRef.current = false; off(); };
  }, [library, read]);

  // A library that read as `locked` is exactly what an in-app unlock repairs —
  // and a locked read caches nothing, so this is the same retry the message's
  // own button offers, taken automatically the moment the vault opens.
  useWindowEvent(VAULT_UNLOCKED_EVENT, read);

  return { ...state, retry: read };
}

export function useWindowEvent(name, handler) {
  useEffect(() => {
    window.addEventListener(name, handler);
    return () => window.removeEventListener(name, handler);
  }, [name, handler]);
}

// ── studio settings, read-only ────────────────────────────────────────────────
// One cached fetch of GET /api/settings shared by every consumer; the Settings
// page owns writing and calls invalidateStudioSettings() after a save so
// gated UI elsewhere follows without a reload.
let settingsPromise = null;
const settingsListeners = new Set();

export function invalidateStudioSettings() {
    settingsPromise = null;
    for (const fn of settingsListeners) fn();
}

function loadStudioSettings() {
    if (!settingsPromise) {
        settingsPromise = fetch('/api/settings', { credentials: 'same-origin' })
            .then((r) => (r.ok ? r.json() : { settings: [] }))
            .then((payload) => Object.fromEntries((payload.settings || []).map((row) => [row.key, row.value])))
            .catch(() => ({}));
    }
    return settingsPromise;
}

/** The current value of one studio setting (e.g. 'developer.recovery_tools'), or undefined until loaded. */
export function useStudioSetting(key) {
    const [value, setValue] = useState(undefined);
    useEffect(() => {
        let alive = true;
        const read = () => loadStudioSettings().then((all) => { if (alive) setValue(all[key]); });
        read();
        settingsListeners.add(read);
        return () => { alive = false; settingsListeners.delete(read); };
    }, [key]);
    return value;
}

