//! Inkess Claude Code Pro — privileged helper daemon.
//!
//! Runs as root via a LaunchDaemon. Listens on a Unix domain socket for
//! JSON-RPC commands from the Inkess CCP app, and manages a single
//! sing-box child process on its behalf. The helper itself is stateless
//! across restarts — launchd supervises it.
//!
//! See `docs/superpowers/plans/2026-04-11-privileged-helper.md` for the
//! full architecture. In one sentence: **the helper exists to eliminate
//! password prompts without changing sing-box's lifecycle guarantees** —
//! sing-box is still bound to the app's lifetime via a 1-second watchdog.

use anyhow::{Context, Result};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, Mutex};

mod client_verify;
mod dns;
mod ipc;
mod rpc;
mod singbox;
mod state;
mod watchdog;

use ipc::{IpcListener, IpcStream};

use rpc::{Request, Response};
use state::HelperState;

const HELPER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    // CLI flag handling — only `--version` is supported. Used by the
    // installer to read the bundled binary's version BEFORE launching it
    // as a daemon (so we can decide whether to upgrade an existing install).
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("inkess-ccp-helper {}", HELPER_VERSION);
        return Ok(());
    }

    setup_logging();
    log::info!(
        "[helper] inkess-ccp-helper v{} starting (pid={})",
        HELPER_VERSION,
        std::process::id()
    );

    let endpoint = ipc::resolve_endpoint();
    let mut listener = IpcListener::bind(&endpoint)
        .with_context(|| format!("binding IPC endpoint at {}", endpoint))?;
    log::info!("[helper] listening on {}", endpoint);

    let state = Arc::new(Mutex::new(HelperState::new()));

    // Spawn the app-pid watchdog task
    let wd_state = state.clone();
    tokio::spawn(async move {
        watchdog::run(wd_state).await;
    });

    // Spawn a graceful shutdown handler for SIGTERM / SIGINT (or
    // CTRL+C / CTRL+BREAK on Windows). The handler stops sing-box
    // and exits the process; launchd / SCM will restart us via KeepAlive.
    let sig_state = state.clone();
    let sig_endpoint = endpoint.clone();
    tokio::spawn(async move {
        wait_for_shutdown_signal().await;
        log::warn!("[helper] shutdown signal received — stopping sing-box");
        if let Err(e) = singbox::stop(sig_state).await {
            log::error!("[helper] singbox::stop on shutdown failed: {}", e);
        }
        ipc::cleanup_endpoint(&sig_endpoint);
        std::process::exit(0);
    });

    // Main accept loop — sequential dispatch, per-client handler in its
    // own task. sing-box lifecycle ops serialize via the state mutex.
    loop {
        let stream = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                log::error!("[helper] accept failed: {}", e);
                // Brief pause to avoid a busy loop on a broken listener
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };

        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_client(stream, state).await {
                log::warn!("[helper] client handler exited with error: {}", e);
            }
        });
    }
}

async fn handle_client(stream: IpcStream, state: Arc<Mutex<HelperState>>) -> Result<()> {
    // Verify the peer before processing any requests
    let client = match client_verify::verify_client(&stream) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[helper] rejected client: {}", e);
            return Ok(()); // drop connection silently
        }
    };
    log::debug!("[helper] accepted client: {:?}", client);

    let mut reader = BufReader::new(stream);
    let mut line = String::new();

    loop {
        line.clear();
        let n = match reader.read_line(&mut line).await {
            Ok(n) => n,
            Err(e) => {
                log::warn!("[helper] client read error: {}", e);
                break;
            }
        };
        if n == 0 {
            // EOF — client closed
            break;
        }

        let req: Request = match serde_json::from_str(line.trim()) {
            Ok(r) => r,
            Err(e) => {
                let resp = Response::err(format!("invalid JSON: {}", e));
                write_response(reader.get_mut(), &resp).await?;
                continue;
            }
        };

        log::info!("[helper] rpc op: {:?}", redact_op(&req));

        // Subscribe: ack, then transition this connection into a one-way
        // event stream. Once we enter the subscriber loop we never read
        // requests on this socket again — the client is expected to close
        // (or just disconnect) when it wants to stop receiving events.
        if matches!(req, Request::Subscribe) {
            let rx = {
                let s = state.lock().await;
                s.events.subscribe()
            };
            // Ack on the same wire so the client knows the subscription is live.
            write_response(reader.get_mut(), &Response::ok()).await?;
            return run_subscriber_loop(reader, rx).await;
        }

        let resp = dispatch(req, state.clone()).await;
        write_response(reader.get_mut(), &resp).await?;
    }

    Ok(())
}

/// Pump events from the broadcast channel out to a subscribed client until
/// the client disconnects or the channel closes. Each event is written as
/// one JSON line (same format as a Response). Lagged subscribers are
/// disconnected — they should reconnect and re-issue `Status` to recover.
async fn run_subscriber_loop(
    mut reader: BufReader<IpcStream>,
    mut rx: broadcast::Receiver<Response>,
) -> Result<()> {
    // Use a tiny scratch buffer to read from the client purely so we
    // notice EOF promptly. The client should not send anything else on
    // a Subscribe socket; if they do, we ignore it.
    let mut sink = [0u8; 64];
    loop {
        tokio::select! {
            recv = rx.recv() => match recv {
                Ok(event) => {
                    if let Err(e) = write_response(reader.get_mut(), &event).await {
                        log::debug!("[helper] subscriber write failed (client gone): {}", e);
                        return Ok(());
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    log::warn!("[helper] subscriber lagged by {} events — disconnecting", n);
                    let _ = write_response(
                        reader.get_mut(),
                        &Response::err("subscription lagged — please reconnect and refetch status"),
                    )
                    .await;
                    return Ok(());
                }
                Err(broadcast::error::RecvError::Closed) => {
                    // Sender dropped — helper is shutting down.
                    log::debug!("[helper] subscriber: event channel closed");
                    return Ok(());
                }
            },
            // Detect client disconnect: a peer close shows up here as
            // Ok(0). Any data is ignored. Any error means the socket is
            // dead.
            r = tokio::io::AsyncReadExt::read(reader.get_mut(), &mut sink) => match r {
                Ok(0) => {
                    log::debug!("[helper] subscriber EOF — closing");
                    return Ok(());
                }
                Ok(_) => continue,
                Err(e) => {
                    log::debug!("[helper] subscriber read error: {}", e);
                    return Ok(());
                }
            },
        }
    }
}

/// Returns a short, log-safe description of an incoming request so we
/// don't spam paths / pids into the log at INFO level.
fn redact_op(req: &Request) -> &'static str {
    match req {
        Request::Start { .. } => "start",
        Request::Stop => "stop",
        Request::Status => "status",
        Request::Info => "info",
        Request::SetDns { .. } => "set_dns",
        Request::RestoreDns => "restore_dns",
        Request::Shutdown => "shutdown",
        Request::Subscribe => "subscribe",
    }
}

async fn dispatch(req: Request, state: Arc<Mutex<HelperState>>) -> Response {
    match req {
        Request::Start {
            binary_path,
            config_path,
            app_pid,
        } => match singbox::start(state.clone(), &binary_path, &config_path, app_pid).await {
            Ok(pid) => {
                let s = state.lock().await;
                Response {
                    ok: true,
                    singbox_pid: Some(pid),
                    singbox_running: Some(true),
                    started_at: s.started_at.map(|t| t.to_rfc3339()),
                    ..Response::ok()
                }
            }
            Err(e) => Response::err(format!("start failed: {}", e)),
        },
        Request::Stop => match singbox::stop(state.clone()).await {
            Ok(()) => Response {
                ok: true,
                singbox_running: Some(false),
                ..Response::ok()
            },
            Err(e) => Response::err(format!("stop failed: {}", e)),
        },
        Request::Status => {
            let s = state.lock().await;
            Response {
                ok: true,
                singbox_pid: s.singbox_pid(),
                singbox_running: Some(s.is_running()),
                started_at: s.started_at.map(|t| t.to_rfc3339()),
                ..Response::ok()
            }
        }
        Request::Info => {
            let s = state.lock().await;
            let uptime = (chrono::Utc::now() - s.helper_started_at)
                .num_seconds()
                .max(0) as u64;
            Response {
                ok: true,
                version: Some(HELPER_VERSION.to_string()),
                uptime_sec: Some(uptime),
                ..Response::ok()
            }
        }
        Request::SetDns { server } => match dns::set_dns(&server).await {
            Ok(()) => Response::ok(),
            Err(e) => Response::err(format!("set_dns failed: {}", e)),
        },
        Request::RestoreDns => match dns::restore_dns().await {
            Ok(()) => Response::ok(),
            Err(e) => Response::err(format!("restore_dns failed: {}", e)),
        },
        Request::Shutdown => {
            log::warn!("[helper] shutdown requested via RPC");
            let _ = singbox::stop(state).await;
            // Write the response before exiting; return ok and rely on
            // the client's next read to see EOF.
            let endpoint = ipc::resolve_endpoint();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                ipc::cleanup_endpoint(&endpoint);
                std::process::exit(0);
            });
            Response::ok()
        }
        // Subscribe is intercepted in handle_client before dispatch, since
        // it transitions the connection into a streaming mode. Reaching
        // here would mean a logic bug in the dispatcher.
        Request::Subscribe => Response::err("subscribe must be handled at connection scope"),
    }
}

async fn write_response<W: AsyncWriteExt + Unpin>(writer: &mut W, resp: &Response) -> Result<()> {
    let mut line = serde_json::to_vec(resp).context("serializing response")?;
    line.push(b'\n');
    writer
        .write_all(&line)
        .await
        .context("writing response line")?;
    writer.flush().await.context("flushing response")?;
    Ok(())
}

/// Wait for the platform's "please shut down" signal so we can do a clean
/// stop of sing-box before exit. On Unix that's SIGTERM/SIGINT (sent by
/// launchd `bootout`); on Windows it's CTRL+C / CTRL+BREAK (sent by SCM
/// or our own service control handler — see Phase 5 windows-service work).
async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        let mut sigint = signal(SignalKind::interrupt()).expect("install SIGINT handler");
        tokio::select! {
            _ = sigterm.recv() => log::info!("[helper] received SIGTERM"),
            _ = sigint.recv() => log::info!("[helper] received SIGINT"),
        }
    }
    #[cfg(windows)]
    {
        // Windows: tokio::signal::ctrl_c covers both CTRL_C and CTRL_BREAK
        // when running interactively. As a Windows Service we'd register a
        // ServiceControlHandler instead — that's a separate phase.
        let _ = tokio::signal::ctrl_c().await;
        log::info!("[helper] received ctrl_c");
    }
}

// --- Logging ---------------------------------------------------------------
//
// We use a tiny bespoke logger that writes to stderr (launchd captures it
// via StandardErrorPath) and supports RUST_LOG-style level filtering via
// the INKESS_HELPER_LOG env var (defaulting to INFO). Using env_logger or
// tracing would pull in too many deps for a tiny helper.

struct StderrLogger {
    max_level: log::Level,
}

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= self.max_level
    }
    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        eprintln!(
            "{} {:5} {}",
            chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ"),
            record.level(),
            record.args()
        );
    }
    fn flush(&self) {}
}

fn setup_logging() {
    let level = match std::env::var("INKESS_HELPER_LOG").as_deref() {
        Ok("trace") => log::Level::Trace,
        Ok("debug") => log::Level::Debug,
        Ok("warn") => log::Level::Warn,
        Ok("error") => log::Level::Error,
        _ => log::Level::Info,
    };
    let logger = Box::leak(Box::new(StderrLogger { max_level: level }));
    log::set_logger(logger)
        .map(|()| log::set_max_level(level.to_level_filter()))
        .expect("logger init");
}
