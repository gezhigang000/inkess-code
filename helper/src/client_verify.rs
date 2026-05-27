//! Client code-signature verification for the helper socket.
//!
//! When a process connects to the helper's Unix socket, we want to ensure
//! it's really the Inkess Code app — not some random local
//! process trying to abuse our root privileges to mess with routing / DNS.
//!
//! macOS provides `SecCodeCopyGuestWithAttributes` which takes a `pid=`
//! attribute and returns a `SecCodeRef` representing the process's
//! on-disk code. We then check it against a `SecRequirementRef` built
//! from a designated-requirement string, e.g.:
//!
//!   identifier "com.inkess.code"
//!   and anchor apple generic
//!   and certificate leaf[subject.CN] = "Developer ID Application: grant ge (3X5DVPNRS7)"
//!   and certificate 1[field.1.2.840.113635.100.6.2.6]
//!   and certificate leaf[field.1.2.840.113635.100.6.1.13]
//!
//! The eventual code-signature check is one security boundary for RPC
//! access. Path validation in the sing-box start path remains a separate
//! defense-in-depth boundary because the helper runs with elevated
//! privileges.
//!
//! **Current status**: this module is intentionally stubbed during Phase 1.
//! The full implementation requires calling into Security.framework via
//! raw FFI (no crate has maintained bindings for these exact APIs), which
//! is a separate focused effort. Phase 2 will replace this stub with the
//! real verification once the RPC plumbing is working end-to-end.
//!
//! Until then, the helper records the connecting process's effective
//! UID/GID (obtained via SO_PEERCRED-like API on macOS: `getpeereid`) for
//! logging and defense-in-depth checks such as binding sing-box runtime
//! paths to the peer uid. This does not provide full client authentication
//! and does not, by itself, keep other local users out.

use anyhow::Result;

use crate::ipc::IpcStream;

/// Verify the connecting client is allowed to send RPC commands.
///
/// **Phase 1 stub**: records peer identity but does not perform full
/// code-signature authentication. The helper itself is root/SYSTEM, so
/// the threat surface is "any local process with socket access can talk to
/// us" — which is what the Phase 2 code-signature check (TODO) tightens.
///
/// Platform notes:
///   - Unix:    `getpeereid(fd)` returns (uid, gid)
///   - Windows: `GetNamedPipeClientProcessId(handle)` returns the client
///              PID, which Phase 1 records for logging only. Future
///              verification work may inspect the process, token, and
///              authenticode signature against our cert thumbprint.
pub fn verify_client(stream: &IpcStream) -> Result<VerifiedClient> {
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let fd = stream.as_raw_fd();
        let (peer_uid, peer_gid) = getpeereid(fd)?;
        log::debug!("[verify] peer uid={}, gid={}", peer_uid, peer_gid);
        Ok(VerifiedClient {
            peer_uid: Some(peer_uid),
            peer_gid: Some(peer_gid),
            peer_pid: None,
        })
    }
    #[cfg(windows)]
    {
        let pid = get_named_pipe_client_pid(stream)?;
        log::debug!("[verify] peer pid={}", pid);
        Ok(VerifiedClient {
            peer_uid: None,
            peer_gid: None,
            peer_pid: Some(pid),
        })
    }
}

#[derive(Debug)]
#[allow(dead_code)] // fields used for logging in Phase 2
pub struct VerifiedClient {
    pub peer_uid: Option<u32>,
    pub peer_gid: Option<u32>,
    pub peer_pid: Option<u32>,
}

#[cfg(unix)]
fn getpeereid(fd: i32) -> Result<(u32, u32)> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    let rc = unsafe { libc::getpeereid(fd, &mut uid, &mut gid) };
    if rc != 0 {
        return Err(anyhow::anyhow!(
            "getpeereid failed: errno={}",
            std::io::Error::last_os_error()
        ));
    }
    Ok((uid, gid))
}

#[cfg(windows)]
fn get_named_pipe_client_pid(stream: &IpcStream) -> Result<u32> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;

    let handle = stream.as_raw_handle();
    let mut pid: u32 = 0;
    let ok = unsafe { GetNamedPipeClientProcessId(handle as _, &mut pid) };
    if ok == 0 {
        return Err(anyhow::anyhow!(
            "GetNamedPipeClientProcessId failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(pid)
}
