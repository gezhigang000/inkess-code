//! sing-box lifecycle management — spawn, graceful stop, force kill.
//!
//! All sing-box child processes are owned here and tracked in `HelperState`.
//! We put each child in its own process group so that if the helper itself
//! dies, the OS delivers SIGTERM to the whole group — ensuring sing-box
//! does not become an orphan root process.

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use std::path::{Path, PathBuf};
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
/// Inkess Code app-managed sing-box runtime directory, with Unix runtime
/// paths bound to the verified peer uid when available. This is a
/// defense-in-depth boundary, not full code-signature authentication:
/// arbitrary user, application, and temp paths are rejected so the helper
/// cannot be asked to run an unrelated binary or load an unrelated config.
pub async fn start(
    state: Arc<Mutex<HelperState>>,
    binary_path: &str,
    config_path: &str,
    app_pid: u32,
    peer_uid: Option<u32>,
) -> Result<u32> {
    validate_binary_path(binary_path, peer_uid).context("invalid binary_path")?;
    validate_config_path(config_path, peer_uid).context("invalid config_path")?;

    validate_existing_artifact(Path::new(binary_path)).context("invalid binary_path")?;
    validate_existing_artifact(Path::new(config_path)).context("invalid config_path")?;

    let binary_metadata = tokio::fs::metadata(binary_path)
        .await
        .with_context(|| format!("binary not found: {}", binary_path))?;
    if !binary_metadata.is_file() {
        return Err(anyhow!(
            "binary_path is not a regular file: {}",
            binary_path
        ));
    }
    let config_metadata = tokio::fs::metadata(config_path)
        .await
        .with_context(|| format!("config not found: {}", config_path))?;
    if !config_metadata.is_file() {
        return Err(anyhow!(
            "config_path is not a regular file: {}",
            config_path
        ));
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
///   3. is within an Inkess Code app-managed sing-box runtime path
///
/// We intentionally don't hardcode a specific user's home dir: the helper
/// runs as root/SYSTEM (no `$HOME` / `%USERPROFILE%`) and the client could
/// be any user session. This allowlist is intentionally narrow: arbitrary
/// user, application, and temp directories are not accepted.
fn validate_binary_path(p: &str, peer_uid: Option<u32>) -> Result<()> {
    validate_runtime_artifact_path(p, peer_uid, expected_binary_name())
}

fn validate_config_path(p: &str, peer_uid: Option<u32>) -> Result<()> {
    validate_runtime_artifact_path(p, peer_uid, "config.json")
}

#[cfg(unix)]
fn expected_binary_name() -> &'static str {
    "sing-box"
}

#[cfg(windows)]
fn expected_binary_name() -> &'static str {
    "sing-box.exe"
}

fn validate_runtime_artifact_path(
    p: &str,
    peer_uid: Option<u32>,
    expected_name: &str,
) -> Result<()> {
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
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("path must include a file name"))?;
    if file_name != expected_name {
        return Err(anyhow!("path must end with {}", expected_name));
    }
    validate_allowed_prefix(p, peer_uid)?;
    Ok(())
}

fn validate_existing_artifact(path: &Path) -> Result<()> {
    reject_symlink_components(path)?;
    Ok(())
}

fn reject_symlink_components(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        let metadata = std::fs::symlink_metadata(&current)
            .with_context(|| format!("checking path component {}", current.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(anyhow!(
                "path component is a symlink: {}",
                current.display()
            ));
        }
    }
    Ok(())
}

fn validate_allowed_prefix(p: &str, peer_uid: Option<u32>) -> Result<()> {
    if !is_allowed_prefix(p, peer_uid)? {
        return Err(anyhow!("path not under an allowed prefix: {}", p));
    }
    Ok(())
}

#[cfg(unix)]
fn is_allowed_prefix(p: &str, peer_uid: Option<u32>) -> Result<bool> {
    if is_unix_test_fixture_path(p) {
        return Ok(true);
    }
    let Some(home) = unix_user_home_for_inkess_singbox_runtime(p) else {
        return Ok(false);
    };
    if let Some(uid) = peer_uid {
        validate_unix_home_owner(&home, uid)?;
    }
    Ok(true)
}

#[cfg(unix)]
fn unix_user_home_for_inkess_singbox_runtime(p: &str) -> Option<PathBuf> {
    const USERDATA_TAILS: &[&str] = &[
        "/Library/Application Support/InkessCode/sing-box/",
        "/Library/Application Support/inkess-code/sing-box/",
    ];
    let after_users = p.strip_prefix("/Users/")?;
    let (user, after_user) = after_users.split_once('/')?;
    if user.is_empty()
        || !USERDATA_TAILS
            .iter()
            .any(|tail| after_user.starts_with(tail.strip_prefix('/').unwrap_or(tail)))
    {
        return None;
    }
    Some(PathBuf::from(format!("/Users/{}", user)))
}

#[cfg(unix)]
fn validate_unix_home_owner(home: &Path, peer_uid: u32) -> Result<()> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::metadata(home)
        .with_context(|| format!("checking owner for user home {}", home.display()))?;
    let owner_uid = metadata.uid();
    if owner_uid != peer_uid {
        return Err(anyhow!(
            "user home owner uid {} does not match peer uid {}",
            owner_uid,
            peer_uid
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn is_unix_test_fixture_path(p: &str) -> bool {
    cfg!(test) && p.starts_with("/tmp/inkess-helper-test/")
}

#[cfg(windows)]
fn is_allowed_prefix(p: &str, _peer_uid: Option<u32>) -> Result<bool> {
    let lower = p.to_ascii_lowercase().replace('/', "\\");
    let after_drive = if lower.len() >= 3
        && lower.as_bytes()[1] == b':'
        && (lower.as_bytes()[2] == b'\\' || lower.as_bytes()[2] == b'/')
    {
        &lower[2..]
    } else {
        lower.as_str()
    };

    Ok(is_windows_inkess_singbox_runtime(after_drive) || is_windows_test_fixture_path(after_drive))
}

#[cfg(windows)]
fn is_windows_inkess_singbox_runtime(p: &str) -> bool {
    const TAILS: &[&str] = &[
        "\\appdata\\roaming\\inkesscode\\sing-box\\",
        "\\appdata\\roaming\\inkess-code\\sing-box\\",
    ];
    let Some(after_users) = p.strip_prefix("\\users\\") else {
        return false;
    };
    let Some((user, after_user)) = after_users.split_once('\\') else {
        return false;
    };
    !user.is_empty()
        && TAILS
            .iter()
            .any(|tail| after_user.starts_with(tail.strip_prefix('\\').unwrap_or(tail)))
}

#[cfg(windows)]
fn is_windows_test_fixture_path(p: &str) -> bool {
    cfg!(test) && p.starts_with("\\windows\\temp\\inkess-helper-test\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_path_accepts_inkess_code_singbox_runtime_paths() {
        assert!(validate_binary_path(
            "/Users/alice/Library/Application Support/InkessCode/sing-box/sing-box",
            None
        )
        .is_ok());
        assert!(validate_config_path(
            "/Users/alice/Library/Application Support/InkessCode/sing-box/config.json",
            None
        )
        .is_ok());
        assert!(validate_binary_path(
            "/Users/alice/Library/Application Support/inkess-code/sing-box/sing-box",
            None
        )
        .is_ok());
    }

    #[test]
    fn validate_path_rejects_broad_user_application_and_temp_paths() {
        assert!(validate_binary_path("/Users/alice/Downloads/sing-box", None).is_err());
        assert!(validate_binary_path(
            "/Users/alice/Downloads/Library/Application Support/InkessCode/sing-box/sing-box",
            None
        )
        .is_err());
        assert!(
            validate_binary_path("/Applications/SomeOther.app/Contents/MacOS/sing-box", None)
                .is_err()
        );
        assert!(validate_binary_path("/tmp/inkess-evil/sing-box", None).is_err());
        assert!(validate_binary_path("/private/tmp/inkess-evil/sing-box", None).is_err());
        assert!(validate_binary_path("/private/var/folders/zz/evil/sing-box", None).is_err());
    }

    #[test]
    fn validate_path_rejects_arbitrary_files_under_runtime_dir() {
        assert!(validate_binary_path(
            "/Users/alice/Library/Application Support/InkessCode/sing-box/evil",
            None
        )
        .is_err());
        assert!(validate_config_path(
            "/Users/alice/Library/Application Support/InkessCode/sing-box/evil.json",
            None
        )
        .is_err());
    }

    #[test]
    fn validate_path_accepts_test_fixture_path_only_in_tests() {
        assert!(validate_binary_path("/tmp/inkess-helper-test/sing-box", None).is_ok());
        assert!(validate_config_path("/tmp/inkess-helper-test/config.json", None).is_ok());
    }

    #[test]
    fn validate_path_reject_traversal() {
        assert!(validate_binary_path("/Users/alice/../root/.ssh/id_rsa", None).is_err());
    }

    #[test]
    fn validate_path_reject_relative() {
        assert!(validate_config_path("sing-box/config.json", None).is_err());
    }

    #[test]
    fn validate_path_reject_system_paths() {
        assert!(validate_config_path("/etc/passwd", None).is_err());
        assert!(validate_binary_path("/bin/sh", None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn validate_path_rejects_symlink_artifacts() {
        use std::fs;
        use std::os::unix::fs::symlink;
        use std::time::{SystemTime, UNIX_EPOCH};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = PathBuf::from(format!("/tmp/inkess-helper-test/symlink-{}", unique));
        fs::create_dir_all(&dir).unwrap();
        let outside = dir.join("outside");
        fs::write(&outside, "not sing-box").unwrap();
        let link = dir.join("sing-box");
        symlink(&outside, &link).unwrap();

        assert!(validate_existing_artifact(&link).is_err());

        let _ = fs::remove_file(&link);
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn validate_path_checks_unix_home_owner_against_peer_uid() {
        use std::fs;
        use std::os::unix::fs::MetadataExt;
        use std::time::{SystemTime, UNIX_EPOCH};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = PathBuf::from(format!("/tmp/inkess-helper-test/owner-{}", unique));
        fs::create_dir_all(&dir).unwrap();
        let owner_uid = fs::metadata(&dir).unwrap().uid();
        let wrong_uid = owner_uid.wrapping_add(1);

        assert!(validate_unix_home_owner(&dir, owner_uid).is_ok());
        assert!(validate_unix_home_owner(&dir, wrong_uid).is_err());

        let _ = fs::remove_dir(&dir);
    }
}
