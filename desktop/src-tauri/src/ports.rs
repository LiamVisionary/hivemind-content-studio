//! Port reservation.
//!
//! The developer stack's `kill_port` runs `lsof -tiTCP:PORT` and kills whatever
//! answers, which is how a desktop app ends up killing a user's own ComfyUI.
//! Nothing here signals anything: a port that is taken is either something we
//! can attach to or a port we step around.

use std::net::TcpListener;

pub const LOOPBACK: &str = "127.0.0.1";

/// The documented control-API port. Kept preferred so a developer can attach a
/// packaged app to a hand-started stack, and so an enrolled passkey keeps its
/// origin across restarts.
pub const PREFERRED_CONTROL_PORT: u16 = 8765;
/// The last port the shell will try before falling back to an ephemeral one.
pub const CONTROL_PORT_RANGE_END: u16 = 8785;

/// True when this loopback port can be bound right now.
pub fn port_is_free(port: u16) -> bool {
    TcpListener::bind((LOOPBACK, port)).is_ok()
}

/// The first free port in `preferred..=range_end`, or an ephemeral one.
///
/// The listener is dropped before returning, so this reserves by *proving the
/// port is bindable*, not by holding it: the child binds it milliseconds later.
/// That race is the same one every supervisor has and is why the caller waits
/// on a health check rather than assuming the child came up.
pub fn reserve_port(preferred: u16, range_end: u16) -> Result<u16, String> {
    for candidate in preferred..=range_end.max(preferred) {
        if let Ok(listener) = TcpListener::bind((LOOPBACK, candidate)) {
            let port = listener
                .local_addr()
                .map_err(|error| error.to_string())?
                .port();
            drop(listener);
            return Ok(port);
        }
    }
    let listener = TcpListener::bind((LOOPBACK, 0)).map_err(|error| {
        format!("No loopback port was available for the studio server: {error}")
    })?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    drop(listener);
    Ok(port)
}

/// The loopback origin the webview and the sidecars must agree on.
pub fn loopback_origin(port: u16) -> String {
    format!("http://{LOOPBACK}:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    /// Every test here asks the OS for an ephemeral port and then reasons about
    /// that exact number. Cargo runs them on threads of one binary, so two of
    /// them racing for `bind(0)` is how
    /// `the_preferred_port_is_taken_when_it_is_free` once failed with
    /// `left: 57241, right: 57240` — the neighbour port, claimed in the gap
    /// between proving one free and reserving it. Serialising them removes the
    /// only racer this binary controls; the retry below covers the rest of the
    /// machine.
    static EPHEMERAL_PORTS: Mutex<()> = Mutex::new(());

    fn one_at_a_time() -> MutexGuard<'static, ()> {
        // A panic in one test must not make every later one fail on a poisoned
        // lock: the guard protects a port number, not shared state anyone can
        // corrupt.
        EPHEMERAL_PORTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn a_port_nobody_holds() -> u16 {
        let listener = TcpListener::bind((LOOPBACK, 0)).expect("ephemeral bind");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        port
    }

    #[test]
    fn the_preferred_port_is_taken_when_it_is_free() {
        let _serialised = one_at_a_time();
        // Anything else on the runner can still take the port in the gap, so a
        // single disagreement is inconclusive; five in a row is the bug.
        let mut last = (0, 0);
        for _ in 0..5 {
            let free = a_port_nobody_holds();
            let reserved = reserve_port(free, free).expect("reserve");
            if reserved == free {
                return;
            }
            last = (free, reserved);
        }
        panic!(
            "a free preferred port was never returned: asked for {}, got {}",
            last.0, last.1
        );
    }

    #[test]
    fn an_occupied_preferred_port_is_stepped_around_not_evicted() {
        let _serialised = one_at_a_time();
        let held = TcpListener::bind((LOOPBACK, 0)).expect("hold a port");
        let occupied = held.local_addr().expect("local addr").port();

        let reserved = reserve_port(occupied, occupied + 4).expect("reserve");

        assert_ne!(reserved, occupied, "never take a port someone else holds");
        // The holder is still listening: reservation evicts nobody.
        assert!(!port_is_free(occupied));
        drop(held);
    }

    #[test]
    fn a_fully_occupied_range_falls_back_to_an_ephemeral_port() {
        let _serialised = one_at_a_time();
        let held = TcpListener::bind((LOOPBACK, 0)).expect("hold a port");
        let occupied = held.local_addr().expect("local addr").port();

        // A range of exactly one port, and that one is taken.
        let reserved = reserve_port(occupied, occupied).expect("reserve");

        assert_ne!(reserved, occupied);
        assert!(reserved > 0);
        drop(held);
    }

    #[test]
    fn the_origin_is_loopback_and_carries_the_port() {
        assert_eq!(loopback_origin(8765), "http://127.0.0.1:8765");
        assert_eq!(loopback_origin(8771), "http://127.0.0.1:8771");
    }
}
