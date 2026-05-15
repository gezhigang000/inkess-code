/**
 * Installer for the inkess-ccp-helper LaunchDaemon.
 *
 * Handles one-time installation (via osascript), uninstallation,
 * and version-based upgrades of the privileged helper.
 *
 * After installation, all TUN operations go through the helper daemon
 * over a Unix socket — no more per-operation sudo prompts.
 */

import { existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import log from '../logger'
import { HelperClient } from './helper-client'

const HELPER_LABEL = 'com.inkess.code.helper'
const HELPER_INSTALL_DIR = '/Library/PrivilegedHelperTools'
const HELPER_BINARY_DEST = `${HELPER_INSTALL_DIR}/inkess-ccp-helper`
const PLIST_DEST = `/Library/LaunchDaemons/${HELPER_LABEL}.plist`
const SOCKET_PATH = '/var/run/inkess-ccp-helper.sock'

/** Expected helper version — bump when updating the bundled binary. */
const HELPER_VERSION = '0.2.1'

export class HelperInstaller {
  private client: HelperClient
  private resourcesPath: string

  constructor(resourcesPath: string, client?: HelperClient) {
    this.resourcesPath = resourcesPath
    this.client = client || new HelperClient()
  }

  /** Path to the bundled helper binary inside the app. */
  private get bundledBinaryPath(): string {
    return join(this.resourcesPath, 'helper', 'inkess-ccp-helper')
  }

  /** Path to the bundled plist inside the app. */
  private get bundledPlistPath(): string {
    return join(this.resourcesPath, 'helper', 'com.inkess.code.helper.plist')
  }

  /** Quick filesystem check — are the helper files in place? */
  isInstalled(): boolean {
    return existsSync(HELPER_BINARY_DEST) && existsSync(PLIST_DEST)
  }

  /** Full check — installed AND responding. */
  async isReady(): Promise<boolean> {
    if (!this.isInstalled()) return false
    return await this.client.isAvailable()
  }

  /**
   * Install the helper daemon. Requires one admin password prompt via osascript.
   * Idempotent — safe to call even if already installed (replaces binary + reloads).
   */
  async install(): Promise<void> {
    const bin = this.bundledBinaryPath
    const plist = this.bundledPlistPath

    if (!existsSync(bin)) {
      throw new Error(`Helper binary not found at ${bin}`)
    }
    if (!existsSync(plist)) {
      throw new Error(`Helper plist not found at ${plist}`)
    }

    // Escape paths for shell interpolation
    const safeBin = bin.replace(/'/g, "'\\''")
    const safePlist = plist.replace(/'/g, "'\\''")

    // Single shell script executed as root via osascript:
    // 1. Create target directory
    // 2. Copy binary + set permissions
    // 3. Copy plist + set permissions
    // 4. Unload existing daemon (if any)
    // 5. Load the daemon
    const script = [
      `mkdir -p '${HELPER_INSTALL_DIR}'`,
      `cp '${safeBin}' '${HELPER_BINARY_DEST}'`,
      `chmod 755 '${HELPER_BINARY_DEST}'`,
      `chown root:wheel '${HELPER_BINARY_DEST}'`,
      `cp '${safePlist}' '${PLIST_DEST}'`,
      `chmod 644 '${PLIST_DEST}'`,
      `chown root:wheel '${PLIST_DEST}'`,
      // bootout may fail if not loaded — ignore error.
      // After bootout, wait for launchd to fully deregister the old service
      // before bootstrapping the new one. Without this delay, bootstrap can
      // silently fail because launchd still considers the service registered.
      `launchctl bootout system/${HELPER_LABEL} 2>/dev/null || true`,
      `sleep 2`,
      // Retry bootstrap: first attempt may fail if launchd hasn't finished
      // cleaning up. A second attempt after 1s covers the race.
      `launchctl bootstrap system '${PLIST_DEST}' 2>/dev/null || { sleep 1; launchctl bootstrap system '${PLIST_DEST}'; }`,
      // Wait for daemon to create socket, then make it world-accessible
      `for i in 1 2 3 4 5 6 7 8; do [ -e '${SOCKET_PATH}' ] && break; sleep 1; done`,
      `chmod 666 '${SOCKET_PATH}' 2>/dev/null || true`,
    ].join('; ')

    log.info('[helper-installer] installing helper daemon (one-time admin prompt)...')

    try {
      execSync(
        `osascript -e 'do shell script "${script.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges'`,
        { timeout: 60_000, stdio: 'pipe' },
      )
      log.info('[helper-installer] helper daemon installed successfully')
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('-60005') || msg.includes('User canceled')) {
        throw new Error('AUTH_DENIED: Admin authorization was denied during helper installation')
      }
      throw new Error(`Helper installation failed: ${msg}`)
    }
  }

  /**
   * Uninstall the helper daemon. Requires admin password.
   */
  async uninstall(): Promise<void> {
    const script = [
      `launchctl bootout system/${HELPER_LABEL} 2>/dev/null || true`,
      `rm -f '${PLIST_DEST}'`,
      `rm -f '${HELPER_BINARY_DEST}'`,
      `rm -f /var/run/inkess-ccp-helper.sock`,
    ].join('; ')

    try {
      execSync(
        `osascript -e 'do shell script "${script.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges'`,
        { timeout: 30_000, stdio: 'pipe' },
      )
      log.info('[helper-installer] helper daemon uninstalled')
    } catch (err) {
      throw new Error(`Helper uninstallation failed: ${(err as Error).message}`)
    }
  }

  /**
   * Check if the installed helper version matches the bundled version.
   * If not, re-install (one admin prompt per app update).
   * Returns true if an upgrade was performed.
   */
  async ensureUpToDate(): Promise<boolean> {
    if (!this.isInstalled()) return false

    try {
      const info = await this.client.getInfo()
      if (info.version === HELPER_VERSION) {
        return false // already up to date
      }
      log.info(`[helper-installer] version mismatch: installed=${info.version} bundled=${HELPER_VERSION}, upgrading...`)
    } catch {
      // Can't talk to helper — try reinstalling
      log.warn('[helper-installer] cannot reach helper for version check, reinstalling...')
    }

    await this.install()
    // Wait for the daemon to come up after reload.
    // install() includes a 2s bootout delay + up to 8s socket wait,
    // but the osascript blocks until done, so we just need to wait
    // for the helper to become reachable after that.
    await this.waitForHelper(10000)
    return true
  }

  /**
   * Fix socket permissions so non-root users can connect.
   * Needed for existing installs without the Umask plist key.
   * Uses osascript since the socket is root-owned.
   */
  /**
   * Try to fix socket permissions without sudo.
   * Works when plist has Umask=0; otherwise install/reload scripts handle it.
   */
  private fixSocketPermissionsSync(): void {
    if (!existsSync(SOCKET_PATH)) return
    try {
      chmodSync(SOCKET_PATH, 0o666)
      log.info('[helper-installer] socket permissions fixed (chmod 666)')
    } catch {
      // Root-owned socket — can't chmod without sudo; install/reload scripts handle this
    }
  }

  /**
   * Wait for the helper to become available after installation/reload.
   */
  async waitForHelper(timeoutMs: number): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await this.client.isAvailable()) return
      // Socket may exist but have wrong permissions — try fixing (no sudo)
      if (existsSync(SOCKET_PATH)) {
        this.fixSocketPermissionsSync()
      }
      await new Promise(r => setTimeout(r, 300))
    }
    throw new Error(`Helper did not become available within ${timeoutMs}ms`)
  }

  /**
   * Ensure the helper is installed, running, and up to date.
   * This is the main entry point — call before any helper RPC.
   *
   * Returns true if the helper was freshly installed (user saw a password prompt).
   */
  async ensureReady(): Promise<boolean> {
    // Already running and reachable?
    if (await this.client.isAvailable()) {
      // Check version
      await this.ensureUpToDate()
      return false
    }

    // Files exist but daemon not responding — try reloading first (no sudo needed if plist correct)
    if (this.isInstalled()) {
      log.info('[helper-installer] helper files exist but daemon not responding, trying reload...')
      try {
        const reloadScript = [
          `launchctl bootout system/${HELPER_LABEL} 2>/dev/null || true`,
          `sleep 2`,
          `launchctl bootstrap system \\"${PLIST_DEST}\\" 2>/dev/null || { sleep 1; launchctl bootstrap system \\"${PLIST_DEST}\\"; }`,
          `for i in 1 2 3 4 5 6 7 8; do [ -e '${SOCKET_PATH}' ] && break; sleep 1; done`,
          `chmod 666 '${SOCKET_PATH}' 2>/dev/null || true`,
        ].join('; ')
        execSync(
          `osascript -e 'do shell script "${reloadScript}" with administrator privileges'`,
          { timeout: 30_000, stdio: 'pipe' },
        )
        await this.waitForHelper(10000)
        await this.ensureUpToDate()
        return false
      } catch {
        log.warn('[helper-installer] reload failed, performing full install...')
      }
    }

    // Fresh install
    await this.install()
    await this.waitForHelper(8000)
    return true
  }
}
