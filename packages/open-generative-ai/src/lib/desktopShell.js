// The desktop shell, seen from the page.
//
// The studio is built ONCE and served from three places: the packaged Tauri
// window, a browser on this Mac, and the tailnet. Only the first of them has a
// supervisor, so anything the shell can do has to be asked for at runtime and
// degrade to a sentence everywhere else — the same shape `saveBytes()` uses for
// the native save dialog (lib/downloadMedia.js), and for the same reason: the
// frontend cannot import `@tauri-apps/api`, because those imports do not
// resolve in a browser build.
//
// What this exists for: the offline state's only remedy used to be
// `scripts/hivemind-studio-stack restart`, a repo-relative shell command. A
// person who installed a .dmg has no checkout and no terminal, and the shell
// that supervises the sidecars is right there — so it restarts them, and a
// browser tab says plainly that it cannot.

/** `{ invoke }` when the page is inside the desktop shell, else null. */
export function desktopShell() {
  const invoke = typeof window === 'undefined' ? null : window.__TAURI__?.core?.invoke;
  return typeof invoke === 'function' ? { invoke } : null;
}

/** Is the studio running inside the desktop shell? */
export function inDesktopShell() {
  return desktopShell() !== null;
}

/**
 * Ask the shell to restart the local services it started.
 *
 * Resolves `{ ok: true }` once they are back — the command blocks on the
 * control API answering its health check — so the caller can reload onto a
 * studio that is actually up. `{ ok: false }` never carries the shell's own
 * error text to a screen: the reason is a word this app branches on, and the
 * sentence a person reads comes from the key table.
 */
export async function restartStudio() {
  const shell = desktopShell();
  if (!shell) return { ok: false, reason: 'no-shell' };
  try {
    await shell.invoke('restart_studio');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'failed', detail: String(error?.message || error || '') };
  }
}

/**
 * Ask the shell to install a promoted update and relaunch.
 *
 * Only the packaged app can do this: it replaces its own bundle after verifying
 * the signature, which is what every platform's updater does. A browser tab gets
 * `{ ok: false, reason: 'no-shell' }` and is shown the release instead — a page
 * must not mutate the server that serves it.
 *
 * A SUCCESSFUL install never resolves: `app.restart()` replaces the process, so
 * the call is cut off mid-flight. Callers should treat the promise not settling
 * as the app going down for the relaunch, and only act on a rejection.
 *
 * Reasons, which the caller turns into a sentence from the key table (never the
 * shell's own error text):
 *   'no-shell'         — not the packaged app.
 *   'unsigned-channel' — this build carries no updater public key, so nothing can
 *                        be verified and therefore nothing may be installed.
 *   'no-update'        — the manifest offers nothing newer.
 *   'failed'           — the download or the signature check did not succeed.
 */
export async function installUpdate() {
  const shell = desktopShell();
  if (!shell) return { ok: false, reason: 'no-shell' };
  try {
    await shell.invoke('install_update');
    // Reached only if the shell declined to restart; the update is on disk.
    return { ok: true };
  } catch (error) {
    const reason = String(error?.message || error || '').trim();
    const known = ['unsigned-channel', 'no-update', 'failed'];
    return { ok: false, reason: known.includes(reason) ? reason : 'failed' };
  }
}
