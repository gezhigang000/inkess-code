//! macOS system DNS override via `scutil`.
//!
//! Mirrors what the app does in `SingBoxManager.startWithSudo`'s shell
//! command today. When sing-box is running in TUN mode with `hijack-dns`,
//! the actual DNS server used doesn't matter for leak prevention — but
//! the scutil override ensures that any process NOT routed via TUN
//! (which shouldn't exist under `auto_route: true` + `strict_route: true`,
//! but defense in depth) still resolves through us.
//!
//! Called via RPC `set_dns` / `restore_dns` by the app; the helper runs
//! these commands as root (no prompt).
//!
//! On Windows: no-op. sing-box handles DNS via its WFP `strict_route`
//! rules, which intercept all DNS queries at the firewall layer regardless
//! of the system resolver setting. There's nothing for the helper to do.

#![cfg_attr(windows, allow(unused_imports))]

use anyhow::Result;
#[cfg(unix)]
use anyhow::Context;
#[cfg(unix)]
use tokio::process::Command;

#[cfg(unix)]
const DNS_SERVICE_KEY: &str = "State:/Network/Service/inkess-ccp-tun/DNS";

#[cfg(unix)]
pub async fn set_dns(server: &str) -> Result<()> {
    // Basic sanity check — server must look like an IPv4 or simple hostname
    if server.len() > 253
        || !server
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == ':' || c == '-')
    {
        anyhow::bail!("invalid DNS server format");
    }

    // scutil accepts a script on stdin — we construct one that adds the
    // DNS service dict and flushes the resolver cache.
    let script = format!(
        "d.init\nd.add ServerAddresses * {server}\nset {key}\nquit\n",
        server = server,
        key = DNS_SERVICE_KEY,
    );

    let output = Command::new("scutil")
        .arg("-")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("spawning scutil failed")?;
    feed_stdin_and_wait(output, &script).await?;

    // Flush mDNSResponder cache
    let _ = Command::new("dscacheutil").arg("-flushcache").status().await;
    let _ = Command::new("killall").arg("-HUP").arg("mDNSResponder").status().await;

    log::info!("[dns] system DNS set to {} via scutil", server);
    Ok(())
}

#[cfg(unix)]
pub async fn restore_dns() -> Result<()> {
    let script = format!("remove {key}\nquit\n", key = DNS_SERVICE_KEY);

    let output = Command::new("scutil")
        .arg("-")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("spawning scutil failed")?;
    feed_stdin_and_wait(output, &script).await?;

    let _ = Command::new("dscacheutil").arg("-flushcache").status().await;
    let _ = Command::new("killall").arg("-HUP").arg("mDNSResponder").status().await;

    log::info!("[dns] system DNS restored");
    Ok(())
}

#[cfg(unix)]
async fn feed_stdin_and_wait(mut child: tokio::process::Child, script: &str) -> Result<()> {
    use tokio::io::AsyncWriteExt;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(script.as_bytes())
            .await
            .context("writing scutil script failed")?;
        // Explicit close — scutil waits for EOF to start executing
        drop(stdin);
    }

    let status = child.wait().await.context("scutil wait failed")?;
    if !status.success() {
        anyhow::bail!("scutil exited with status {}", status);
    }
    Ok(())
}

// --- Windows: no-op stubs (sing-box WFP handles DNS hijack natively) ----

#[cfg(windows)]
pub async fn set_dns(_server: &str) -> Result<()> {
    log::info!("[dns] set_dns is a no-op on Windows (sing-box WFP handles it)");
    Ok(())
}

#[cfg(windows)]
pub async fn restore_dns() -> Result<()> {
    log::info!("[dns] restore_dns is a no-op on Windows");
    Ok(())
}
