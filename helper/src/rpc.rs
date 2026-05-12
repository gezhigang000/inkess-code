//! RPC message types shared between Inkess Claude Code Pro (the Electron app)
//! and the privileged helper daemon.
//!
//! Wire format: newline-delimited JSON over a Unix domain socket.
//! Each request is a single JSON object on one line; each response is the
//! same. No multiplexing — requests are handled one at a time per connection.
//!
//! The app is the only legitimate client. The helper verifies the connecting
//! process's code signature before accepting any request (see `client_verify`).

use serde::{Deserialize, Serialize};

/// Request envelope. `op` determines which fields are meaningful.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// Start sing-box with the given config file.
    ///
    /// The helper will first `stop` any currently-running sing-box child
    /// (idempotent). `app_pid` enables the fail-closed watchdog — if the app
    /// process dies, the helper kills sing-box within ~1s.
    Start {
        /// Absolute path to the sing-box binary (inside the app's userData)
        binary_path: String,
        /// Absolute path to a sing-box config.json (inside the app's userData)
        config_path: String,
        /// PID of the Electron app requesting the start. Monitored for
        /// fail-closed enforcement. If 0, watchdog is disabled (tests only).
        app_pid: u32,
    },

    /// Stop sing-box gracefully. SIGTERM + 5s grace + SIGKILL.
    /// Also releases the app-pid watchdog.
    Stop,

    /// Query current helper + sing-box state.
    Status,

    /// Helper self-info (version, uptime).
    Info,

    /// macOS-only: set system DNS via scutil (forces all DNS through us).
    /// Noop on other platforms.
    SetDns { server: String },

    /// macOS-only: restore system DNS to default.
    /// Noop on other platforms.
    RestoreDns,

    /// Graceful shutdown — helper stops sing-box, then exits.
    /// launchd will normally restart it via KeepAlive, so this is only
    /// useful during app-uninstall or helper upgrade.
    Shutdown,

    /// Subscribe to sing-box lifecycle events on this connection.
    ///
    /// After the helper acknowledges with a `{ ok: true }` response, the
    /// connection stays open and the helper pushes one JSON event per line
    /// whenever sing-box's state materially changes:
    ///
    ///   - `singbox_started` — emitted right after a successful `start`.
    ///   - `singbox_exited`  — emitted when the sing-box child exits for
    ///     ANY reason (graceful stop, crash, OOM, helper-issued kill).
    ///
    /// The client should keep the socket open and read events until it
    /// chooses to close, or until the helper restarts (launchd bounce).
    /// On disconnect, the client is expected to reconnect and resubscribe;
    /// no event replay is provided — `Status` gives the current snapshot.
    Subscribe,
}

/// Response envelope. `ok=false` with `error` set on failure; `ok=true` with
/// type-specific fields otherwise.
///
/// Also doubles as the wire format for asynchronous events pushed on a
/// `Subscribe` connection — distinguished by the `event` field being set.
#[derive(Debug, Serialize, Default, Clone)]
pub struct Response {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    /// Populated by `Start` / `Stop` / `Status`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub singbox_pid: Option<u32>,

    /// Populated by `Start` / `Stop` / `Status`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub singbox_running: Option<bool>,

    /// Populated by `Start` / `Status`. ISO 8601.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,

    /// Populated by `Info`. Helper semver.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,

    /// Populated by `Info`. Helper uptime in seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_sec: Option<u64>,

    /// Set on asynchronous event pushes (`singbox_started`, `singbox_exited`).
    /// Clients on `Subscribe` connections should route on this field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,

    /// On `singbox_exited`: the OS exit code if the child exited normally.
    /// `None` for signal-induced exit (consult `signal` instead).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,

    /// On `singbox_exited`: the terminating signal number (Unix only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
}

impl Response {
    pub fn ok() -> Self {
        Self {
            ok: true,
            ..Default::default()
        }
    }

    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(msg.into()),
            ..Default::default()
        }
    }

    /// Build a `singbox_started` event push.
    pub fn singbox_started(pid: u32, started_at: chrono::DateTime<chrono::Utc>) -> Self {
        Self {
            ok: true,
            event: Some("singbox_started".to_string()),
            singbox_pid: Some(pid),
            singbox_running: Some(true),
            started_at: Some(started_at.to_rfc3339()),
            ..Default::default()
        }
    }

    /// Build a `singbox_exited` event push.
    pub fn singbox_exited(pid: u32, exit_code: Option<i32>, signal: Option<i32>) -> Self {
        Self {
            ok: true,
            event: Some("singbox_exited".to_string()),
            singbox_pid: Some(pid),
            singbox_running: Some(false),
            exit_code,
            signal,
            ..Default::default()
        }
    }
}
