//! Cross-platform IPC abstraction.
//!
//! Hides the Unix-domain-socket vs. named-pipe difference behind a single
//! `IpcListener::bind()` + `accept()` API. The accepted streams expose the
//! `tokio::io::{AsyncRead, AsyncWrite}` traits so the dispatch loop in
//! `main.rs` doesn't need to know which platform it's on.
//!
//! On macOS:    `UnixListener` bound to `/var/run/inkess-ccp-helper.sock`
//! On Windows:  Named pipe `\\.\pipe\inkess-ccp-helper`
//!
//! Tokio's named-pipe API is structurally different from `UnixListener`
//! (you create one server instance, await `connect()`, then create the
//! next one). We hide that quirk here behind a uniform `accept()` future.

use anyhow::Result;

#[cfg(unix)]
pub use unix_impl::*;
#[cfg(windows)]
pub use windows_impl::*;

/// Default IPC endpoint path. Must match the TS-side constant in
/// `code/src/main/helper/helper-client.ts`.
pub fn default_endpoint() -> &'static str {
    #[cfg(unix)]
    {
        "/var/run/inkess-ccp-helper.sock"
    }
    #[cfg(windows)]
    {
        r"\\.\pipe\inkess-ccp-helper"
    }
}

/// Resolve the endpoint actually used at runtime — env var override
/// (for tests) takes precedence over the default.
pub fn resolve_endpoint() -> String {
    std::env::var("INKESS_HELPER_SOCKET").unwrap_or_else(|_| default_endpoint().to_string())
}

#[cfg(unix)]
mod unix_impl {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use tokio::net::{UnixListener, UnixStream};

    pub type IpcStream = UnixStream;

    pub struct IpcListener {
        inner: UnixListener,
    }

    impl IpcListener {
        /// Bind a fresh socket file at `endpoint`, removing any stale file
        /// from a prior run. The socket is chmod 0660 root:wheel by default
        /// (the helper runs as root).
        pub fn bind(endpoint: &str) -> Result<Self> {
            // Clean up stale file
            if Path::new(endpoint).exists() {
                std::fs::remove_file(endpoint)?;
            }
            // Ensure parent dir exists (should always be /var/run)
            if let Some(parent) = Path::new(endpoint).parent() {
                std::fs::create_dir_all(parent)?;
            }
            let inner = UnixListener::bind(endpoint)?;

            // Allow any local user to connect (the app runs as the logged-in
            // user, not root). Phase 2 code-signature verification is the real
            // security boundary, not socket permissions.
            let mut perms = std::fs::metadata(endpoint)?.permissions();
            perms.set_mode(0o666);
            std::fs::set_permissions(endpoint, perms)?;

            Ok(Self { inner })
        }

        /// Wait for the next client and return its stream.
        pub async fn accept(&mut self) -> Result<IpcStream> {
            let (stream, _addr) = self.inner.accept().await?;
            Ok(stream)
        }
    }

    /// Best-effort cleanup of the IPC endpoint file (called from shutdown
    /// handlers). On Unix this `unlink`s the socket file; on Windows it's
    /// a no-op because named pipes are kernel objects with no filesystem
    /// representation.
    pub fn cleanup_endpoint(endpoint: &str) {
        let _ = std::fs::remove_file(endpoint);
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    pub type IpcStream = NamedPipeServer;

    pub struct IpcListener {
        endpoint: String,
        /// The "next" server instance that's ready to accept a client.
        /// On accept(), we connect this one and roll a fresh instance.
        next: Option<NamedPipeServer>,
    }

    impl IpcListener {
        /// Create the first named-pipe instance. Subsequent instances are
        /// rolled inside `accept()`. `first_pipe_instance(true)` makes
        /// `create()` fail if another process is already serving the same
        /// name — defending against helper-impersonation attacks.
        pub fn bind(endpoint: &str) -> Result<Self> {
            let next = ServerOptions::new()
                .first_pipe_instance(true)
                .create(endpoint)?;
            Ok(Self {
                endpoint: endpoint.to_string(),
                next: Some(next),
            })
        }

        /// Wait for a client to connect on the current instance, then
        /// hand it back and prepare a fresh instance for the next caller.
        pub async fn accept(&mut self) -> Result<IpcStream> {
            // Take the prepared instance; create the next one immediately
            // so a fast-arriving client doesn't get rejected.
            let server = self
                .next
                .take()
                .ok_or_else(|| anyhow::anyhow!("named pipe listener was not initialized"))?;
            let next = ServerOptions::new().create(&self.endpoint)?;
            self.next = Some(next);

            // Block until a client connects on this instance.
            server.connect().await?;
            Ok(server)
        }
    }

    /// Named pipes have no filesystem entry — nothing to clean up.
    pub fn cleanup_endpoint(_endpoint: &str) {}
}
