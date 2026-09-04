//! The supervisor: spawn, watch, restart and reap — by pid, never by port.
//!
//! Three rules this file exists to keep:
//!
//! 1. **Nothing is signalled that this process did not spawn.** Every kill goes
//!    through a `Child` handle the shell owns. There is no `lsof`, no port
//!    scan, no "whatever is listening on 8188".
//! 2. **A crash is one service's problem.** The developer stack tears the whole
//!    tree down when any child exits; here the crashed child restarts with a
//!    backoff and its siblings never notice.
//! 3. **Quitting takes the group.** Each child leads its own process group, so
//!    a sidecar's own children go with it instead of being orphaned.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::backoff::{restart_delay, should_restart, READY_POLL_INTERVAL, READY_TIMEOUT};
use crate::health::probe;
use crate::services::{service_plans, Layout, ServicePlan};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceState {
    /// Not started yet.
    Waiting,
    /// Spawned; waiting for its health check.
    Starting,
    /// Answering its health check, and this shell started it.
    Ready,
    /// Answering its health check, and something else started it. Never killed.
    Attached,
    /// Crashed; a restart is scheduled.
    Restarting,
    /// Out of restarts, or it never came up. Carries actions.
    Failed,
    /// The person chose to continue without it.
    Skipped,
}

impl ServiceState {
    fn is_up(self) -> bool {
        matches!(self, ServiceState::Ready | ServiceState::Attached)
    }
}

/// What the boot screen may offer for a service in this state. Every failure
/// state carries at least one action; nothing is ever a dead end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceAction {
    Retry,
    ShowLogs,
    ContinueWithout,
}

pub fn actions_for(state: ServiceState, required: bool) -> Vec<ServiceAction> {
    match state {
        ServiceState::Failed => {
            let mut actions = vec![ServiceAction::Retry, ServiceAction::ShowLogs];
            // "Continue without it" is offered only where it is true. The
            // window has nothing to load without the control API, so offering
            // it there would be a button that cannot do what it says.
            if !required {
                actions.push(ServiceAction::ContinueWithout);
            }
            actions
        }
        ServiceState::Skipped => vec![ServiceAction::Retry, ServiceAction::ShowLogs],
        ServiceState::Restarting => vec![ServiceAction::ShowLogs],
        _ => Vec::new(),
    }
}

/// One row of the boot screen. Deliberately five small fields: the whole store
/// is read on every poll from the UI thread, and a large one is what made the
/// sibling app stall.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceReport {
    pub id: String,
    pub label: String,
    pub state: ServiceState,
    pub detail: String,
    pub restarts: u32,
    pub actions: Vec<ServiceAction>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BootPhase {
    Starting,
    /// The control API answered /readyz; the window may load the studio.
    Ready,
    /// The control API will not start. The screen shows the actions.
    Blocked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootReport {
    pub phase: BootPhase,
    pub studio_url: Option<String>,
    pub services: Vec<ServiceReport>,
}

struct Managed {
    plan: ServicePlan,
    /// `Some` only for a process this shell spawned. An attached process is
    /// never represented by a handle, which is what makes "never signal what
    /// you did not start" structural rather than a rule someone must remember.
    child: Option<Child>,
    state: ServiceState,
    detail: String,
    restarts: u32,
    next_attempt_at: Option<Instant>,
}

pub struct Supervisor {
    layout: Layout,
    managed: Mutex<Vec<Managed>>,
    shutting_down: AtomicBool,
}

impl Supervisor {
    pub fn new(layout: Layout) -> Self {
        let managed = service_plans(&layout)
            .into_iter()
            .map(|plan| Managed {
                plan,
                child: None,
                state: ServiceState::Waiting,
                detail: String::new(),
                restarts: 0,
                next_attempt_at: None,
            })
            .collect();
        Self {
            layout,
            managed: Mutex::new(managed),
            shutting_down: AtomicBool::new(false),
        }
    }

    /// The small store the boot screen polls.
    pub fn report(&self) -> BootReport {
        let managed = self.managed.lock().unwrap_or_else(|error| error.into_inner());
        let services: Vec<ServiceReport> = managed
            .iter()
            .map(|service| ServiceReport {
                id: service.plan.id.clone(),
                label: service.plan.label.clone(),
                state: service.state,
                detail: service.detail.clone(),
                restarts: service.restarts,
                actions: actions_for(service.state, service.plan.required),
            })
            .collect();
        let control = services.iter().find(|service| service.id == "control-api");
        let phase = match control.map(|service| service.state) {
            Some(state) if state.is_up() => BootPhase::Ready,
            Some(ServiceState::Failed) | Some(ServiceState::Skipped) => BootPhase::Blocked,
            _ => BootPhase::Starting,
        };
        BootReport {
            phase,
            studio_url: (phase == BootPhase::Ready).then(|| self.layout.studio_origin()),
            services,
        }
    }

    /// Bring every service up once, in order. Returns when the control API is
    /// either ready or out of attempts; the slower optional services keep
    /// coming up behind the window.
    pub fn start_all(&self) {
        let count = self
            .managed
            .lock()
            .map(|managed| managed.len())
            .unwrap_or(0);
        for index in 0..count {
            if self.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            self.bring_up(index);
        }
    }

    fn bring_up(&self, index: usize) {
        let (plan, already_skipped) = {
            let managed = self.managed.lock().unwrap_or_else(|error| error.into_inner());
            let Some(service) = managed.get(index) else {
                return;
            };
            (service.plan.clone(), service.state == ServiceState::Skipped)
        };
        if already_skipped {
            return;
        }

        // Something already answering on that port is a process to attach to,
        // not one to evict. This is how the packaged app coexists with a
        // hand-started developer stack instead of fighting it for the port.
        if health_ok(&plan) {
            self.write(index, |service| {
                service.state = ServiceState::Attached;
                service.detail = "Already running — attached to it.".into();
                service.next_attempt_at = None;
            });
            return;
        }

        self.write(index, |service| {
            service.state = ServiceState::Starting;
            service.detail = String::new();
        });

        match self.spawn(&plan) {
            Ok(child) => {
                self.write(index, |service| service.child = Some(child));
            }
            Err(error) => {
                self.fail(index, error);
                return;
            }
        }

        match self.wait_until_ready(index, &plan) {
            Ok(()) => self.write(index, |service| {
                service.state = ServiceState::Ready;
                service.detail = String::new();
                service.next_attempt_at = None;
            }),
            Err(reason) => self.fail(index, reason),
        }
    }

    fn spawn(&self, plan: &ServicePlan) -> Result<Child, String> {
        if !plan.cwd.is_dir() {
            return Err(format!(
                "{} is not installed here ({} is missing).",
                plan.label,
                plan.cwd.display()
            ));
        }
        let _ = std::fs::create_dir_all(&self.layout.log_dir);
        let log_path = plan.log_file(&self.layout.log_dir);
        let log = open_log(&log_path);

        let mut command = Command::new(&plan.program);
        command
            .args(&plan.args)
            .current_dir(&plan.cwd)
            // A bare environment plus exactly what this service needs. Nothing
            // is inherited, so a stray PYTHONHOME in the launching shell cannot
            // change what the packaged app runs.
            .env_clear()
            .envs(minimal_os_env())
            .envs(plan.env.iter())
            .stdin(Stdio::null())
            .stdout(
                log.as_ref()
                    .and_then(|file| file.try_clone().ok())
                    .map(Stdio::from)
                    .unwrap_or_else(Stdio::null),
            )
            .stderr(
                log.map(Stdio::from)
                    .unwrap_or_else(Stdio::null),
            );
        set_process_group(&mut command);

        command.spawn().map_err(|error| {
            format!(
                "{} could not start: {} ({}).",
                plan.label,
                error,
                plan.program.display()
            )
        })
    }

    fn wait_until_ready(&self, index: usize, plan: &ServicePlan) -> Result<(), String> {
        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            if self.shutting_down.load(Ordering::SeqCst) {
                return Err("The studio was closed while it was starting.".into());
            }
            if let Some(exit) = self.child_exit(index) {
                return Err(format!(
                    "{} stopped while starting ({exit}). Its log has the reason.",
                    plan.label
                ));
            }
            if health_ok(plan) {
                return Ok(());
            }
            std::thread::sleep(READY_POLL_INTERVAL);
        }
        Err(format!(
            "{} did not answer in {} seconds.",
            plan.label,
            READY_TIMEOUT.as_secs()
        ))
    }

    /// One pass of supervision. Called on a timer; never sleeps, so a service
    /// waiting out its backoff does not hold up the others.
    pub fn tick(&self) {
        if self.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let count = self
            .managed
            .lock()
            .map(|managed| managed.len())
            .unwrap_or(0);
        for index in 0..count {
            self.tick_one(index);
        }
    }

    fn tick_one(&self, index: usize) {
        enum Next {
            Nothing,
            Crashed(String),
            RestartNow,
        }

        let next = {
            let mut managed = self.managed.lock().unwrap_or_else(|error| error.into_inner());
            let Some(service) = managed.get_mut(index) else {
                return;
            };
            match service.state {
                ServiceState::Restarting => {
                    if service
                        .next_attempt_at
                        .is_some_and(|at| Instant::now() >= at)
                    {
                        Next::RestartNow
                    } else {
                        Next::Nothing
                    }
                }
                ServiceState::Ready => match service.child.as_mut().map(Child::try_wait) {
                    Some(Ok(Some(status))) => Next::Crashed(format!("{status}")),
                    Some(Ok(None)) | None => Next::Nothing,
                    Some(Err(error)) => Next::Crashed(error.to_string()),
                },
                // Attached, Skipped, Failed, Waiting, Starting: nothing to do.
                // An attached process is somebody else's to restart.
                _ => Next::Nothing,
            }
        };

        match next {
            Next::Nothing => {}
            Next::Crashed(status) => {
                let (label, restarts) = self.write(index, |service| {
                    service.child = None;
                    service.restarts = service.restarts.saturating_add(1);
                    (service.plan.label.clone(), service.restarts)
                });
                if should_restart(restarts) {
                    let delay = restart_delay(restarts);
                    self.write(index, |service| {
                        service.state = ServiceState::Restarting;
                        service.detail = format!(
                            "{label} stopped ({status}). Restarting in {}s — attempt {restarts}.",
                            delay.as_secs()
                        );
                        service.next_attempt_at = Some(Instant::now() + delay);
                    });
                } else {
                    self.fail(
                        index,
                        format!("{label} stopped {restarts} times ({status}). It is not being restarted again."),
                    );
                }
            }
            Next::RestartNow => {
                self.write(index, |service| service.next_attempt_at = None);
                self.bring_up(index);
            }
        }
    }

    /// The Retry action. Clears the crash counter so a person's deliberate
    /// retry is not spent against a budget the last crash loop exhausted.
    pub fn retry(&self, id: &str) -> bool {
        let Some(index) = self.index_of(id) else {
            return false;
        };
        self.stop_one(index);
        self.write(index, |service| {
            service.restarts = 0;
            service.state = ServiceState::Waiting;
            service.detail = String::new();
            service.next_attempt_at = None;
        });
        self.bring_up(index);
        true
    }

    /// The studio's own "Restart studio": every service this shell started,
    /// stopped and brought up again with its crash budget cleared.
    ///
    /// Two things it deliberately does not do. A service the person chose to
    /// continue without stays skipped — a restart is not a way to overrule
    /// them. And a service that is ATTACHED was never ours to signal, so
    /// `bring_up` re-attaches to it rather than starting a second copy; a
    /// developer's hand-started stack survives a press of this button.
    /// Returns how many services were taken through a restart.
    pub fn restart_all(&self) -> usize {
        let ids: Vec<String> = {
            let managed = self.managed.lock().unwrap_or_else(|error| error.into_inner());
            managed
                .iter()
                .filter(|service| service.state != ServiceState::Skipped)
                .map(|service| service.plan.id.clone())
                .collect()
        };
        ids.iter().filter(|id| self.retry(id)).count()
    }

    /// The "Continue without it" action. Stops trying, and stops the child if
    /// one is somehow still around.
    pub fn skip(&self, id: &str) -> bool {
        let Some(index) = self.index_of(id) else {
            return false;
        };
        let required = {
            let managed = self.managed.lock().unwrap_or_else(|error| error.into_inner());
            managed.get(index).is_some_and(|service| service.plan.required)
        };
        if required {
            return false;
        }
        self.stop_one(index);
        self.write(index, |service| {
            service.state = ServiceState::Skipped;
            service.detail = service.plan.without_it.clone();
            service.next_attempt_at = None;
        });
        true
    }

    /// Stop everything this shell started. Attached processes are left alone.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let count = self
            .managed
            .lock()
            .map(|managed| managed.len())
            .unwrap_or(0);
        for index in 0..count {
            self.stop_one(index);
        }
    }

    fn stop_one(&self, index: usize) {
        let child = self.write(index, |service| service.child.take());
        if let Some(mut child) = child {
            terminate_group(&mut child);
        }
    }

    fn child_exit(&self, index: usize) -> Option<String> {
        let mut managed = self.managed.lock().unwrap_or_else(|error| error.into_inner());
        let service = managed.get_mut(index)?;
        match service.child.as_mut()?.try_wait() {
            Ok(Some(status)) => Some(format!("{status}")),
            Ok(None) => None,
            Err(error) => Some(error.to_string()),
        }
    }

    fn fail(&self, index: usize, detail: String) {
        self.stop_one(index);
        self.write(index, |service| {
            service.state = ServiceState::Failed;
            service.detail = detail.clone();
            service.next_attempt_at = None;
        });
    }

    fn index_of(&self, id: &str) -> Option<usize> {
        let managed = self.managed.lock().unwrap_or_else(|error| error.into_inner());
        managed.iter().position(|service| service.plan.id == id)
    }

    fn write<T>(&self, index: usize, mutate: impl FnOnce(&mut Managed) -> T) -> T
    where
        T: Default,
    {
        let mut managed = self.managed.lock().unwrap_or_else(|error| error.into_inner());
        match managed.get_mut(index) {
            Some(service) => mutate(service),
            None => T::default(),
        }
    }
}

fn health_ok(plan: &ServicePlan) -> bool {
    let answer = probe(plan.health.port, &plan.health.path);
    if plan.health.any_http_answer {
        answer.answered()
    } else {
        answer.is_ok()
    }
}

/// What a child needs from the OS environment and nothing more. The rest of the
/// block is the service's own, built in `services.rs`.
fn minimal_os_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "SHELL", "PATH"] {
        if let Some(value) = std::env::var_os(key) {
            env.insert(key.to_string(), value.to_string_lossy().to_string());
        }
    }
    // A Finder launch has no PATH worth the name; ffmpeg and friends are
    // resolved by the packaged app's own PATH prefix, which the packaging item
    // prepends. This keeps the usual system locations available meanwhile.
    env.entry("PATH".to_string())
        .or_insert_with(|| "/usr/bin:/bin:/usr/sbin:/sbin".to_string());
    env
}

fn open_log(path: &PathBuf) -> Option<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

#[cfg(unix)]
fn set_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // The child leads a new group whose id is its own pid, so one signal at
    // quit reaches it and everything it started.
    command.process_group(0);
}

#[cfg(not(unix))]
fn set_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_group(child: &mut Child) {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;

    let group = Pid::from_raw(child.id() as i32);
    // SIGTERM first so uvicorn and node run their shutdown paths; the process
    // group, so nothing they spawned is orphaned.
    let _ = killpg(group, Signal::SIGTERM);
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    let _ = killpg(group, Signal::SIGKILL);
    let _ = child.wait();
}

#[cfg(not(unix))]
fn terminate_group(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_optional_service_can_be_retried_read_or_skipped() {
        assert_eq!(
            actions_for(ServiceState::Failed, false),
            vec![
                ServiceAction::Retry,
                ServiceAction::ShowLogs,
                ServiceAction::ContinueWithout
            ]
        );
    }

    #[test]
    fn a_failed_required_service_is_never_offered_a_dishonest_continue() {
        assert_eq!(
            actions_for(ServiceState::Failed, true),
            vec![ServiceAction::Retry, ServiceAction::ShowLogs]
        );
    }

    #[test]
    fn every_state_a_person_can_be_stuck_in_carries_an_action() {
        for state in [
            ServiceState::Failed,
            ServiceState::Skipped,
            ServiceState::Restarting,
        ] {
            assert!(
                !actions_for(state, false).is_empty(),
                "{state:?} would be a dead end"
            );
            assert!(!actions_for(state, true).is_empty(), "{state:?}");
        }
    }

    #[test]
    fn a_running_service_offers_nothing_to_fix() {
        assert!(actions_for(ServiceState::Ready, true).is_empty());
        assert!(actions_for(ServiceState::Attached, false).is_empty());
    }

    #[test]
    fn attached_and_ready_both_count_as_up() {
        assert!(ServiceState::Ready.is_up());
        assert!(ServiceState::Attached.is_up());
        assert!(!ServiceState::Restarting.is_up());
        assert!(!ServiceState::Failed.is_up());
    }

    #[test]
    fn the_environment_a_child_inherits_is_a_short_list() {
        let env = minimal_os_env();
        assert!(env.contains_key("PATH"));
        assert!(env.len() <= 7, "{env:?}");
    }
}
