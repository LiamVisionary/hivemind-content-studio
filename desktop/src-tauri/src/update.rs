//! Installing an update, from the studio page.
//!
//! The channel itself is not new and is not configured here: `updater.json` is
//! its single source of truth (endpoint, public key, and the promotion workflow
//! that writes `latest.json`), `tauri.conf.json` mirrors it, and
//! `scripts/check_updater_config.py` is what stops the two from drifting. What
//! was missing was a way to ASK. `tauri_plugin_updater` is registered and
//! `updater:default` is granted, but nothing ever called `check()`, so the
//! channel reached nobody — the same class of dead-channel bug that script was
//! written about.
//!
//! Division of labour with the page:
//!   - the PAGE decides whether an update exists, by reading the same
//!     `latest.json` this plugin reads (lib/appUpdate.js). One manifest, one
//!     answer, and it works in a browser tab that has no shell at all.
//!   - this command APPLIES it: download the signed bundle, verify it, replace
//!     the app, relaunch. That is the whole of what "update just what changed"
//!     can honestly mean for a packaged desktop app — Tauri replaces the bundle
//!     and does not ship binary deltas — and it is what the platform's own
//!     updaters do.
//!
//! A browser tab gets neither: a page must not mutate the server that serves it.
//! It is shown the release instead (see lib/appUpdate.js).
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// Download, verify, install and relaunch.
///
/// The Err string is a REASON the page branches on, never a sentence it prints —
/// the same contract `restart_studio` uses, and for the same reason: the words a
/// person reads live in the key table, not in a Rust error.
///
///   `unsigned-channel` — this build carries no updater public key, so nothing
///                        can be verified and therefore nothing may be installed.
///                        `updater.json`'s `pubkey` is empty until a release is
///                        promoted with the signing key; `check_updater_config.py
///                        --require-key` is the gate that catches it.
///   `no-update`        — the manifest offers nothing newer than this build.
///   `failed`           — the download or the signature check did not succeed.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    // `updater()` parses the configured public key, so an unsigned channel fails
    // HERE rather than after a download the user waited for.
    let updater = app.updater().map_err(|error| {
        eprintln!("[update] updater unavailable: {error}");
        "unsigned-channel".to_string()
    })?;

    let available = updater.check().await.map_err(|error| {
        eprintln!("[update] check failed: {error}");
        "failed".to_string()
    })?;

    let Some(update) = available else {
        return Err("no-update".to_string());
    };

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|error| {
            eprintln!("[update] install failed: {error}");
            "failed".to_string()
        })?;

    // Diverges: the process is replaced, so nothing after this runs and the page
    // never receives a reply. The page treats an unresolved call as success for
    // exactly this reason.
    app.restart()
}
