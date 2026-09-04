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

    fn a_port_nobody_holds() -> u16 {
        let listener = TcpListener::bind((LOOPBACK, 0)).expect("ephemeral bind");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        port
    }

    #[test]
    fn the_preferred_port_is_taken_when_it_is_free() {
        let free = a_port_nobody_holds();
        assert_eq!(reserve_port(free, free).expect("reserve"), free);
    }

    #[test]
    fn an_occupied_preferred_port_is_stepped_around_not_evicted() {
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

    /// The capability's `remote.urls` literal, tested against every origin the
    /// shell can actually load.
    ///
    /// The window loads `http://127.0.0.1:<port>` (§2.1), so the capability
    /// system treats the studio as a REMOTE origin and grants it nothing unless
    /// a URLPattern in `capabilities/default.json` matches. A pattern that
    /// looks right and matches nothing produces exactly the failure this whole
    /// area exists to prevent: Download returns success and writes no file. The
    /// pattern is parsed with the same type Tauri resolves capabilities with,
    /// so this is the check, not a re-implementation of it.
    #[test]
    fn the_capability_pattern_matches_every_origin_the_shell_can_load() {
        use std::str::FromStr;
        use tauri::utils::acl::RemoteUrlPattern;

        let declared: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("capabilities/default.json is JSON");
        let literal = declared["remote"]["urls"][0]
            .as_str()
            .expect("the capability must declare a remote URL, or the studio page gets no IPC")
            .to_string();

        let pattern = RemoteUrlPattern::from_str(&literal)
            .unwrap_or_else(|error| panic!("{literal} is not a valid URLPattern: {error:?}"));

        for port in PREFERRED_CONTROL_PORT..=CONTROL_PORT_RANGE_END {
            let origin = url::Url::parse(&format!("{}/", loopback_origin(port))).expect("origin");
            assert!(
                pattern.test(&origin),
                "{literal} does not match {origin}, so the studio page would have no IPC there"
            );
        }
        // A fallback below the range is still loopback and still ours.
        let ephemeral = url::Url::parse("http://127.0.0.1:49221/studio?page=video").expect("url");
        assert!(pattern.test(&ephemeral));
        // Anything that is not loopback is not covered by it.
        for foreign in ["http://localhost:8765/", "https://example.invalid/"] {
            let url = url::Url::parse(foreign).expect("url");
            assert!(!pattern.test(&url), "{literal} must not reach {foreign}");
        }
    }
}
