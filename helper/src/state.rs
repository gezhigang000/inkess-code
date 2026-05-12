//! Shared mutable state for the helper daemon.
//!
//! Wrapped in `tokio::sync::Mutex` and passed via `Arc` to all handlers +
//! the watchdog task. Only the singbox child handle and the app pid ever
//! change at runtime.

use chrono::{DateTime, Utc};
use tokio::process::Child;
use tokio::sync::broadcast;

use crate::rpc::Response;

/// Channel capacity for the lifecycle event broadcaster. Subscribers that
/// fall behind by more than this many events get a `Lagged` error and we
/// drop them — they can reconnect and call `status` to recover. Sized
/// generously: realistic event rate is < 1/sec.
const EVENT_CHANNEL_CAPACITY: usize = 64;

/// All the mutable state the helper tracks.
///
/// `singbox`: the currently-running sing-box child process, if any. Owned
/// here (not spawned and forgotten) so we can `.kill()` it on stop / on
/// helper shutdown. When `None`, sing-box is not running.
///
/// `app_pid`: the PID of the Electron app that requested the current `start`.
/// The watchdog task polls `kill(pid, 0)` against this every second; if the
/// app disappears (crash, force-quit), the watchdog kills sing-box. When
/// `None`, no watchdog is active (either sing-box is stopped, or an explicit
/// `start` with `app_pid=0` disabled it — test only).
///
/// `started_at`: wall-clock timestamp when sing-box last started. Reported
/// back in `status` for debugging. Only meaningful when `singbox.is_some()`.
///
/// `helper_started_at`: when the helper process itself started. Used for
/// `info.uptime_sec`. Never changes after construction.
///
/// `events`: broadcast channel that fan-outs sing-box lifecycle events
/// (`singbox_started`, `singbox_exited`) to all `Subscribe`-attached
/// clients. Populated by `singbox::start()` and the spawned exit-monitor
/// task; consumed by per-connection subscriber loops in `main::dispatch`.
pub struct HelperState {
    pub singbox: Option<Child>,
    pub app_pid: Option<u32>,
    pub started_at: Option<DateTime<Utc>>,
    pub helper_started_at: DateTime<Utc>,
    pub events: broadcast::Sender<Response>,
}

impl HelperState {
    pub fn new() -> Self {
        let (events, _rx) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Self {
            singbox: None,
            app_pid: None,
            started_at: None,
            helper_started_at: Utc::now(),
            events,
        }
    }

    /// Convenience: is sing-box currently running (per our records)?
    /// This checks only the owned handle — not a live `kill(pid, 0)` probe.
    /// A separate reconciliation step in `singbox::reconcile` can verify.
    pub fn is_running(&self) -> bool {
        self.singbox.is_some()
    }

    pub fn singbox_pid(&self) -> Option<u32> {
        self.singbox.as_ref().and_then(|c| c.id())
    }
}
