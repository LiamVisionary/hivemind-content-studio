//! The Hivemind Content Studio desktop shell.
//!
//! The window loads `http://127.0.0.1:<port>` — never `tauri://localhost`.
//! `docs/RELEASE.md` §2.1 is the reasoning: the account cookie, the Canvas
//! iframe and the WebAuthn relying-party id are all bound to the control API's
//! loopback origin, and a custom protocol breaks all three at once. The cost is
//! that the app cannot open the studio until the control API is healthy, which
//! is exactly what the boot screen in `splash/` is for.

pub mod backoff;
pub mod boot;
pub mod health;
pub mod ports;
pub mod secret;
pub mod services;
pub mod supervisor;

use std::sync::Arc;
use std::time::Duration;

use tauri::RunEvent;

use crate::boot::BootController;

pub fn run(context: tauri::Context<tauri::Wry>) {
    let controller = Arc::new(BootController::new());
    let supervision = Arc::clone(&controller);
    let shutdown = Arc::clone(&controller);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::clone(&controller))
        .setup(move |app| {
            let handle = app.handle().clone();
            let boot = Arc::clone(&supervision);
            // Boot happens on its own thread. Everything the window asks for is
            // an async command reading a five-row store, so the UI thread never
            // waits on a process starting.
            std::thread::Builder::new()
                .name("studio-boot".into())
                .spawn(move || {
                    boot.boot(&handle);
                    loop {
                        std::thread::sleep(Duration::from_secs(2));
                        if boot.is_stopping() {
                            return;
                        }
                        boot.tick();
                    }
                })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            boot::boot_status,
            boot::retry_service,
            boot::skip_service,
            boot::reveal_logs,
            boot::restart_studio,
        ])
        .build(context)
        .expect("failed to start the Hivemind Content Studio shell")
        .run(move |_app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                // Quitting takes every child's process group with it. Attached
                // processes — a developer stack, a user's ComfyUI — are left
                // exactly as they were found.
                shutdown.shutdown();
            }
        });
}
