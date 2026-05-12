//! sing-box lifecycle management — spawn, graceful stop, force kill.
//!
//! All sing-box child processes are owned here and tracked in `HelperState`.
//! We put each child in its own process group so that if the helper itself
//! dies, the OS delivers SIGTERM to the whole group — ensuring sing-box
//! does not become an orphan root process.

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout};

use crate::rpc::Response;
use crate::state::HelperState;

const STOP_GRACE_PERIOD: Duration = Duration::from_secs(5);
/// How often the exit-monitor task polls the child process for termination.
/// 500ms is a fine balance: responsive enough that subscribers see crashes
/// almost immediately, but cheap enough that the lock churn is negligible.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Spawn sing-box with the given binary + config paths, tracking the new
/// child in `HelperState`. Kills any previously-running sing-box first.
///
/// Validates that `binary_path` and `config_path` exist and are under the
/// user's `~/Library/Application Support/inkess-claude-code-pro/` directory
/// (the only location the app can legitimately write to) — this prevents a
/// compromised (but still code-signed) client from asking us to run an
/// arbitrary binary or load an arbitrary config.
pub async fn start(
    state: Arc<Mutex<HelperState>>,
    binary_path: &str,
    config_path: &str,
    app_pid: u32,
) -> Result<u32> {
    validate_path(binary_path).context("invalid binary_path")?;
    validate_path(config_path).context("invalid config_path")?;

    let binary_metadata = tokio::fs::metadata(binary_path)
        .await
        .with_context(|| format!("binary not found: {}", binary_path))?;
    if !binary_metadata.is_file() {
        return Err(anyhow!("binary_path is not a regular file: {}", binary_path));
    }
    let config_metadata = tokio::fs::metadata(config_path)
        .await
        .with_context(|| format!("config not found: {}", config_path))?;
    if !config_metadata.is_file() {
        return Err(anyhow!("config_path is not a regular file: {}", config_path));
    }

    // Stop any previous sing-box before starting a new one
    stop(state.clone()).await.ok();

    log::info!(
        "[singbox] spawning {} -c {} (app_pid={})",
        binary_path,
        config_path,
        app_pid
    );

    // Spawn sing-box as our direct child. `process_group(0)` puts it in a
    // new process group so a group SIGTERM (on helper shutdown) reaches it
    // regardless of any internal forks sing-box might do.
    let mut cmd = Command::new(binary_path);
    cmd.arg("run")
        .arg("-c")
        .arg(config_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    // Unix: put child in its own process group
    #[cfg(unix)]
    cmd.process_group(0);

    let child = cmd
        .spawn()
        .context("failed to spawn sing-box — check binary permissions and TUN entitlement")?;

    let pid = child.id().unwrap_or(0);
    let started_at = Utc::now();

    let mut s = state.lock().await;
    s.singbox = Some(child);
    s.app_pid = if app_pid == 0 { None } else { Some(app_pid) };
    s.started_at = Some(started_at);
    // Best-effort broadcast — `send` returns Err only when there are no
    // active receivers, which is the normal case at startup. We don't care.
    let _ = s.events.send(Response::singbox_started(pid, started_at));
    drop(s);

    // Kick off the exit monitor in a background task. It polls `try_wait`
    // on the child periodically; when it observes a termination, it emits
    // a `singbox_exited` event and clears the child handle. The monitor
    // exits silently if the child is replaced or removed by `stop()` /
    // a subsequent `start()` — those paths emit their own events as needed.
    let monitor_state = state.clone();
    tokio::spawn(monitor_child_exit(monitor_state, pid));

    log::info!("[singbox] started pid={}", pid);
    Ok(pid)
}

/// Background task: poll the currently-tracked sing-box child for exit and
/// broadcast a `singbox_exited` event when it terminates.
///
/// The task is tied to a specific PID — if the state's child is replaced
/// (e.g. by a fresh `start`) or cleared (`stop`), this task exits without
/// emitting anything. That keeps event semantics clean: each `start` →
/// at most one `singbox_exited` event for that PID.
async fn monitor_child_exit(state: Arc<Mutex<HelperState>>, pid: u32) {
    loop {
        sleep(EXIT_POLL_INTERVAL).await;

        let mut s = state.lock().await;
        // If the tracked child is no longer ours, another path took over.
        // (`stop` / next `start` already cleaned up — bail without an event.)
        let our_child_still_tracked = s
            .singbox
            .as_ref()
            .and_then(|c| c.id())
            .map(|p| p == pid)
            .unwrap_or(false);
        if !our_child_still_tracked {
            return;
        }

        let try_result = match s.singbox.as_mut() {
            Some(c) => c.try_wait(),
            None => return,
        };

        let exit_status = match try_result {
            Ok(Some(status)) => status,
            Ok(None) => continue, // still running
            Err(e) => {
                log::warn!("[singbox] monitor try_wait pid={} error: {}", pid, e);
                continue;
            }
        };

        // Pull the child out so subsequent `is_running()` returns false.
        s.singbox = None;
        s.app_pid = None;
        s.started_at = None;

        let exit_code = exit_status.code();
        #[cfg(unix)]
        let signal = {
            use std::os::unix::process::ExitStatusExt;
            exit_status.signal()
        };
        #[cfg(not(unix))]
        let signal: Option<i32> = None;

        log::warn!(
            "[singbox] child pid={} exited (code={:?} signal={:?}) — broadcasting event",
            pid,
            exit_code,
            signal
        );
        let _ = s
            .events
            .send(Response::singbox_exited(pid, exit_code, signal));
        return;
    }
}

/// Stop the currently-running sing-box gracefully: SIGTERM, wait 5s, then
/// SIGKILL if still alive. Idempotent — a no-op if sing-box is not running.
/// Also clears the app-pid watchdog target.
pub async fn stop(state: Arc<Mutex<HelperState>>) -> Result<()> {
    let (mut child, pid_for_event) = {
        let mut s = state.lock().await;
        s.app_pid = None;
        s.started_at = None;
        let child = match s.singbox.take() {
            Some(c) => c,
            None => return Ok(()),
        };
        let pid = child.id().unwrap_or(0);
        (child, pid)
    };

    let pid = pid_for_event;
    log::info!("[singbox] stopping pid={}", pid);

    // Send SIGTERM to the process group on Unix.
    // On Windows, child.kill() sends a hard TerminateProcess; sing-box on
    // Windows doesn't run signal handlers anyway because Windows lacks POSIX
    // signals. The graceful → forced escalation collapses to a single kill
    // step on Windows.
    #[cfg(unix)]
    unsafe {
        if pid > 0 {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        // Tokio's Child::start_kill is non-blocking; it returns immediately
        // and we then `wait().await` to reap. This is equivalent to
        // TerminateProcess on Windows.
        let _ = child.start_kill();
    }

    // Wait up to STOP_GRACE_PERIOD for graceful exit
    let graceful = timeout(STOP_GRACE_PERIOD, child.wait()).await;
    let exit_status_opt = match graceful {
        Ok(Ok(status)) => {
            log::info!("[singbox] pid={} exited: {}", pid, status);
            Some(status)
        }
        Ok(Err(e)) => {
            log::warn!("[singbox] wait() on pid={} failed: {}", pid, e);
            None
        }
        Err(_) => {
            log::warn!(
                "[singbox] pid={} did not exit in {}s, escalating to force-kill",
                pid,
                STOP_GRACE_PERIOD.as_secs()
            );
            #[cfg(unix)]
            unsafe {
                if pid > 0 {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            #[cfg(windows)]
            {
                // SIGTERM/TerminateProcess already issued above; on Windows
                // there's no escalation path beyond a second TerminateProcess.
                let _ = child.start_kill();
            }
            // One more short wait to reap
            let final_status = timeout(Duration::from_secs(2), child.wait()).await;
            log::info!("[singbox] pid={} killed", pid);
            match final_status {
                Ok(Ok(s)) => Some(s),
                _ => None,
            }
        }
    };

    // Emit the `singbox_exited` event for this stop. The monitor task will
    // exit silently on its next tick (it sees the child is gone). We emit
    // here directly so subscribers see the event even when stop wins the
    // race against the monitor's poll interval.
    let exit_code = exit_status_opt.as_ref().and_then(|s| s.code());
    #[cfg(unix)]
    let signal = exit_status_opt.as_ref().and_then(|s| {
        use std::os::unix::process::ExitStatusExt;
        s.signal()
    });
    #[cfg(not(unix))]
    let signal: Option<i32> = None;
    {
        let s = state.lock().await;
        let _ = s
            .events
            .send(Response::singbox_exited(pid, exit_code, signal));
    }

    // Give the kernel a moment to tear down the TUN interface and routes
    // so the next start() doesn't hit "device busy" / "route exists".
    sleep(Duration::from_millis(200)).await;

    Ok(())
}

/// Validate that a filesystem path:
///   1. is absolute
///   2. does not contain `..` segments (defense in depth against traversal)
///   3. is within an allowed prefix — the app's `Application Support` /
///      `%APPDATA%`, or the bundled Resources path
///
/// We intentionally don't hardcode a specific user's home dir: the helper
/// runs as root/SYSTEM (no `$HOME` / `%USERPROFILE%`) and the client could
/// be any user session.
fn validate_path(p: &str) -> Result<()> {
    let path = PathBuf::from(p);
    if !path.is_absolute() {
        return Err(anyhow!("path must be absolute"));
    }
    // Reject `..` components entirely — no "legitimate" use case for them here
    for component in path.components() {
        if let std::path::Component::ParentDir = component {
            return Err(anyhow!("path must not contain '..' segments"));
        }
    }
    if !is_allowed_prefix(p) {
        return Err(anyhow!("path not under an allowed prefix: {}", p));
    }
    Ok(())
}

#[cfg(unix)]
fn is_allowed_prefix(p: &str) -> bool {
    // /Users/<user>/Library/Application Support/inkess-claude-code-pro/...
    // /Applications/Inkess Claude Code Pro.app/Contents/Resources/...
    // /tmp/, /private/tmp/, /private/var/folders/ — test + macOS realpath
    const ALLOWED: &[&str] = &[
        "/Users/",
        "/Applications/",
        "/tmp/",
        "/private/tmp/",
        "/private/var/folders/",
    ];
    ALLOWED.iter().any(|prefix| p.starts_with(prefix))
}

#[cfg(windows)]
fn is_allowed_prefix(p: &str) -> bool {
    // Windows paths the app legitimately writes to or reads from. We accept
    // any drive letter under the user's AppData / Program Files / Temp.
    // Comparison is case-insensitive because Windows is.
    let lower = p.to_ascii_lowercase().replace('/', "\\");
    // Strip the drive letter ("c:") if present so the suffix tests work.
    let after_drive = if lower.len() >= 3
        && lower.as_bytes()[1] == b':'
        && (lower.as_bytes()[2] == b'\\' || lower.as_bytes()[2] == b'/')
    {
        &lower[2..]
    } else {
        lower.as_str()
    };
    const ALLOWED: &[&str] = &[
        "\\users\\",            // C:\Users\<user>\AppData\Roaming\inkess-claude-code-pro\...
        "\\program files\\",    // C:\Program Files\Inkess Claude Code Pro\resources\...
        "\\program files (x86)\\",
        "\\programdata\\",
        "\\windows\\temp\\",    // test only
    ];
    ALLOWED.iter().any(|prefix| after_drive.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_paths() {
        assert!(validate_path("/Users/alice/Library/Application Support/inkess-claude-code-pro/sing-box/sing-box").is_ok());
        assert!(validate_path("/Applications/Inkess Claude Code Pro.app/Contents/Resources/rule-set/geosite-cn.srs").is_ok());
    }

    #[test]
    fn reject_traversal() {
        assert!(validate_path("/Users/alice/../root/.ssh/id_rsa").is_err());
    }

    #[test]
    fn reject_relative() {
        assert!(validate_path("sing-box/config.json").is_err());
    }

    #[test]
    fn reject_system_paths() {
        assert!(validate_path("/etc/passwd").is_err());
        assert!(validate_path("/bin/sh").is_err());
    }
}
