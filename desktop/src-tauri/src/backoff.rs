//! The restart policy.
//!
//! Per process, not per stack: the developer supervisor kills every child when
//! any one of them misses a health check, which is how a gateway hiccup used to
//! cancel a twenty-minute render. Here a crash restarts exactly the process
//! that crashed, with an exponential delay and a bounded crash counter, and a
//! process that keeps crashing stops being restarted so the boot screen can
//! offer a person something to do instead of looping in silence.

use std::time::Duration;

/// Longest wait between restarts. Past this a person is better placed to fix it
/// than another attempt is.
pub const RESTART_DELAY_CEILING: Duration = Duration::from_secs(30);
/// Restart attempts before the service is parked as failed with its actions.
pub const GIVE_UP_AFTER: u32 = 5;
/// How long the shell waits for the studio to answer /readyz before it stops
/// waiting and shows the failure with its actions. The first launch after an
/// install is the slow one: cold page cache, a first import of the whole
/// control API, and on some machines an antivirus reading every file once.
pub const READY_TIMEOUT: Duration = Duration::from_secs(90);
/// Gap between health polls while waiting. Short enough that a fast boot feels
/// immediate, long enough that ninety seconds of polling is not a busy loop.
pub const READY_POLL_INTERVAL: Duration = Duration::from_millis(400);

/// Delay before restart attempt `attempt` (1 is the first restart).
pub fn restart_delay(attempt: u32) -> Duration {
    if attempt == 0 {
        return Duration::ZERO;
    }
    // Saturating shift: attempt 40 must not wrap to a zero-second hot loop.
    let seconds = 1_u64.checked_shl(attempt - 1).unwrap_or(u64::MAX);
    Duration::from_secs(seconds).min(RESTART_DELAY_CEILING)
}

/// Whether a service that has crashed `crashes` times gets another attempt.
pub fn should_restart(crashes: u32) -> bool {
    crashes < GIVE_UP_AFTER
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_delay_doubles_and_then_stops_growing() {
        assert_eq!(restart_delay(0), Duration::ZERO);
        assert_eq!(restart_delay(1), Duration::from_secs(1));
        assert_eq!(restart_delay(2), Duration::from_secs(2));
        assert_eq!(restart_delay(3), Duration::from_secs(4));
        assert_eq!(restart_delay(4), Duration::from_secs(8));
        assert_eq!(restart_delay(5), Duration::from_secs(16));
        assert_eq!(restart_delay(6), RESTART_DELAY_CEILING);
    }

    #[test]
    fn a_huge_attempt_count_stays_at_the_ceiling_instead_of_wrapping_to_zero() {
        assert_eq!(restart_delay(64), RESTART_DELAY_CEILING);
        assert_eq!(restart_delay(u32::MAX), RESTART_DELAY_CEILING);
    }

    #[test]
    fn restarts_are_bounded_so_a_crash_loop_becomes_a_visible_failure() {
        assert!(should_restart(0));
        assert!(should_restart(GIVE_UP_AFTER - 1));
        assert!(!should_restart(GIVE_UP_AFTER));
        assert!(!should_restart(GIVE_UP_AFTER + 10));
    }

    #[test]
    fn the_ready_wait_covers_a_slow_first_launch() {
        assert!(READY_TIMEOUT >= Duration::from_secs(90));
        assert!(READY_POLL_INTERVAL < Duration::from_secs(1));
    }
}
