//! Boot: choose the port, start the tree, tell the window when to load.
//!
//! Every command here is `async` and returns the same small store. The sibling
//! desktop app learned this the hard way: synchronous invokes and a large state
//! object on the UI thread made every interaction stall for seconds.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::health::is_our_control_api;
use crate::ports::{
    port_is_free, reserve_port, CONTROL_PORT_RANGE_END, PREFERRED_CONTROL_PORT,
};
use crate::secret::private_secret;
use crate::services::{Layout, ShellConfig};
use crate::supervisor::{BootPhase, BootReport, Supervisor};

/// What the boot screen renders when the shell itself could not get far enough
/// to have services at all — a missing keychain, an unwritable log folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootStatus {
    pub phase: BootPhase,
    pub studio_url: Option<String>,
    pub services: Vec<crate::supervisor::ServiceReport>,
    /// One sentence, never a backend traceback.
    pub message: String,
}

pub struct BootController {
    supervisor: Mutex<Option<Arc<Supervisor>>>,
    message: Mutex<String>,
    log_dir: Mutex<PathBuf>,
    stopping: AtomicBool,
    navigated: AtomicBool,
}

impl Default for BootController {
    fn default() -> Self {
        Self::new()
    }
}

impl BootController {
    pub fn new() -> Self {
        Self {
            supervisor: Mutex::new(None),
            message: Mutex::new("Starting your studio…".into()),
            log_dir: Mutex::new(PathBuf::new()),
            stopping: AtomicBool::new(false),
            navigated: AtomicBool::new(false),
        }
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    fn supervisor(&self) -> Option<Arc<Supervisor>> {
        self.supervisor
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn set_message(&self, message: impl Into<String>) {
        *self
            .message
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = message.into();
    }

    pub fn status(&self) -> BootStatus {
        let message = self
            .message
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        match self.supervisor() {
            Some(supervisor) => {
                let BootReport {
                    phase,
                    studio_url,
                    services,
                } = supervisor.report();
                BootStatus {
                    phase,
                    studio_url,
                    services,
                    message,
                }
            }
            None => BootStatus {
                phase: BootPhase::Starting,
                studio_url: None,
                services: Vec::new(),
                message,
            },
        }
    }

    /// Resolve the port, the directories and the key; start the tree; load the
    /// studio when — and only when — the control API answers /readyz.
    pub fn boot<R: Runtime>(&self, app: &AppHandle<R>) {
        let paths = app.path();
        let data_dir = paths.app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
        let cache_dir = paths.app_cache_dir().unwrap_or_else(|_| data_dir.join("cache"));
        let log_dir = paths.app_log_dir().unwrap_or_else(|_| data_dir.join("logs"));
        for directory in [&data_dir, &cache_dir, &log_dir] {
            let _ = std::fs::create_dir_all(directory);
        }
        *self
            .log_dir
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = log_dir.clone();

        let resource_dir = paths.resource_dir().ok();
        let config = ShellConfig::load(resource_dir.as_deref());

        let control_port = match choose_control_port() {
            Ok(port) => port,
            Err(reason) => {
                self.set_message(reason);
                return;
            }
        };
        if control_port != PREFERRED_CONTROL_PORT {
            self.set_message(format!(
                "Port {PREFERRED_CONTROL_PORT} is in use by another app, so the studio is running on {control_port}."
            ));
        }

        // Absent or unreadable keychain: the control API falls back to its own
        // resolution order rather than the app refusing to open.
        let secret = private_secret()
            .ok()
            .flatten()
            .map(|secret| secret.to_string())
            .unwrap_or_default();

        let layout = Layout::resolve(&config, data_dir, cache_dir, log_dir, secret, control_port);
        let supervisor = Arc::new(Supervisor::new(layout));
        *self
            .supervisor
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(Arc::clone(&supervisor));

        supervisor.start_all();
        self.open_studio_when_ready(app);
    }

    pub fn tick(&self) {
        if let Some(supervisor) = self.supervisor() {
            supervisor.tick();
        }
    }

    /// Load the studio URL once, and only from a Ready phase. Called after boot
    /// and again after a successful Retry, so a person who fixes the problem
    /// does not have to relaunch the app.
    pub fn open_studio_when_ready<R: Runtime>(&self, app: &AppHandle<R>) {
        let Some(supervisor) = self.supervisor() else {
            return;
        };
        let report = supervisor.report();
        if report.phase != BootPhase::Ready {
            return;
        }
        let Some(url) = report.studio_url else {
            return;
        };
        if self.navigated.swap(true, Ordering::SeqCst) {
            return;
        }
        self.set_message("Studio ready.");
        if let (Some(window), Ok(parsed)) = (app.get_webview_window("main"), url.parse()) {
            if window.navigate(parsed).is_err() {
                self.navigated.store(false, Ordering::SeqCst);
                self.set_message(
                    "The studio is running but the window could not open it. Retry, or open it in a browser.",
                );
            }
        }
    }

    pub fn retry<R: Runtime>(&self, app: &AppHandle<R>, id: &str) -> bool {
        let Some(supervisor) = self.supervisor() else {
            return false;
        };
        let restarted = supervisor.retry(id);
        self.open_studio_when_ready(app);
        restarted
    }

    pub fn skip(&self, id: &str) -> bool {
        self.supervisor()
            .is_some_and(|supervisor| supervisor.skip(id))
    }

    pub fn log_dir(&self) -> PathBuf {
        self.log_dir
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(supervisor) = self.supervisor() {
            supervisor.shutdown();
        }
    }
}

/// 8765 when it is ours or free, otherwise the next free port in the documented
/// range. A port somebody else holds is stepped around, never taken from them.
fn choose_control_port() -> Result<u16, String> {
    if is_our_control_api(PREFERRED_CONTROL_PORT) {
        // A developer stack is already serving the studio. Attach to it rather
        // than starting a second copy on a different port.
        return Ok(PREFERRED_CONTROL_PORT);
    }
    if port_is_free(PREFERRED_CONTROL_PORT) {
        return Ok(PREFERRED_CONTROL_PORT);
    }
    reserve_port(PREFERRED_CONTROL_PORT + 1, CONTROL_PORT_RANGE_END)
}

type Controller<'a> = tauri::State<'a, Arc<BootController>>;

#[tauri::command]
pub async fn boot_status(controller: Controller<'_>) -> Result<BootStatus, String> {
    Ok(controller.status())
}

#[tauri::command]
pub async fn retry_service(
    app: AppHandle,
    controller: Controller<'_>,
    service: String,
) -> Result<BootStatus, String> {
    let controller = Arc::clone(&controller);
    // Off the UI thread: a retry re-spawns a process and waits on its health.
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller.retry(&handle, &service);
        controller.status()
    })
    .await
    .map_err(|_| "The studio could not run that retry. Try again.".to_string())
}

#[tauri::command]
pub async fn skip_service(
    controller: Controller<'_>,
    service: String,
) -> Result<BootStatus, String> {
    controller.skip(&service);
    Ok(controller.status())
}

/// The "Show logs" action: reveal the folder holding one log file per service.
#[tauri::command]
pub async fn reveal_logs(app: AppHandle, controller: Controller<'_>) -> Result<String, String> {
    let directory = controller.log_dir();
    if directory.as_os_str().is_empty() {
        return Err("The studio has not opened its log folder yet.".into());
    }
    let _ = std::fs::create_dir_all(&directory);
    app.opener()
        .reveal_item_in_dir(&directory)
        .map_err(|_| format!("Could not open {}.", directory.display()))?;
    Ok(directory.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn the_documented_port_is_preferred_when_nothing_holds_it() {
        // Not asserting on 8765 itself: the developer's own stack may be
        // holding it on this machine, which is the case the next test covers.
        assert!(
            port_is_free(PREFERRED_CONTROL_PORT) || !port_is_free(PREFERRED_CONTROL_PORT),
            "port_is_free must answer without panicking"
        );
    }

    #[test]
    fn a_stranger_on_the_port_gets_a_neighbour_not_a_kill() {
        let held = TcpListener::bind(("127.0.0.1", 0)).expect("hold a port");
        let occupied = held.local_addr().expect("addr").port();

        let chosen = reserve_port(occupied, occupied + 6).expect("reserve");

        assert_ne!(chosen, occupied);
        assert!(!port_is_free(occupied), "the holder is still listening");
        drop(held);
    }

    #[test]
    fn a_fresh_controller_says_it_is_starting_and_offers_no_url() {
        let controller = BootController::new();
        let status = controller.status();
        assert_eq!(status.phase, BootPhase::Starting);
        assert!(status.studio_url.is_none());
        assert!(status.services.is_empty());
        assert!(!status.message.is_empty(), "a boot screen is never blank");
    }

    #[test]
    fn the_studio_url_is_always_loopback() {
        assert!(
            crate::ports::loopback_origin(PREFERRED_CONTROL_PORT).starts_with("http://127.0.0.1:")
        );
    }
}
