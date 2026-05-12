//! Fail-closed watchdog task.
//!
//! Every 1 second, checks whether the currently-registered `app_pid` is
//! still alive. If not, immediately stops sing-box and clears the
//! watchdog. This is the mechanism that ensures sing-box never outlives
//! the app that requested it — even if the app is SIGKILLed, crashes, or
//! is force-quit, sing-box dies within ~1-2 seconds.
//!
//! The watchdog is NOT armed unless `app_pid` is set — which happens only
//! on a successful `start` with a non-zero app pid. `stop` clears it.

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::interval;

use crate::singbox;
use crate::state::HelperState;

const POLL_INTERVAL: Duration = Duration::from_secs(1);

pub async fn run(state: Arc<Mutex<HelperState>>) {
    let mut ticker = interval(POLL_INTERVAL);
    loop {
        ticker.tick().await;

        // Fast path: read app_pid under the lock, then drop it before doing
        // anything potentially expensive. We only hold the lock to read.
        let app_pid = {
            let s = state.lock().await;
            s.app_pid
        };

        let Some(pid) = app_pid else {
            // Watchdog not armed (no start with app_pid yet, or after stop)
            continue;
        };

        if !pid_alive(pid) {
            log::warn!(
                "[watchdog] app pid {} is gone — killing sing-box (fail-closed)",
                pid
            );
            // Best-effort stop; any error is logged inside singbox::stop
            if let Err(e) = singbox::stop(state.clone()).await {
                log::error!("[watchdog] singbox::stop failed: {}", e);
            }
            // singbox::stop clears app_pid, so next tick will idle
        }
    }
}

/// Returns true if the process with the given PID is still alive.
///
/// Unix:    `kill(pid, 0)` returns 0 if the target exists and we can signal
///          it; -1 otherwise. Helper runs as root so EPERM never happens —
///          non-zero unambiguously means "gone".
///
/// Windows: `OpenProcess(SYNCHRONIZE, false, pid)` succeeds for live
///          processes (and zombies that haven't been waited on yet).
///          We then immediately close the handle. PROCESS_QUERY_LIMITED_
///          INFORMATION is even less privileged but SYNCHRONIZE is enough
///          and is what `windows-sys` exposes most cleanly.
fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return false;
            }
            // GetExitCodeProcess can tell live vs. zombie, but for our
            // fail-closed purposes "the OS still has a record of it" is
            // close enough — a zombie still means the parent is alive.
            CloseHandle(handle);
            true
        }
    }
}
