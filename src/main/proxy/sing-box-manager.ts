import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, chmodSync, readFileSync } from 'fs'
import { execSync, execFile, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import * as os from 'os'
import * as https from 'https'
import log from '../logger'
import { buildTunConfig, buildLocalProxyConfig, type SingBoxConfig, type SingBoxOutbound, type TunConfigOptions } from './sing-box-config'
import {
  parseStaleSingBoxInterfaces,
  parseStaleSingBoxRoutes,
  parseStaleSingBoxRouteCount,
} from './sing-box-stale-state'
import { fetchWithTimeout } from '../utils/fetch'
import { HelperClient, type HelperEvent } from './helper-client'
import { HelperInstaller } from './helper-installer'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Keep-alive HTTP agent for connectivity probes.
// Reuses TCP+TLS connections so measured latency reflects real-world usage
// (warm connections) rather than cold-start handshake overhead (~200ms vs ~1800ms).
// ---------------------------------------------------------------------------
let probeAgent = createProbeAgent()

function createProbeAgent(): https.Agent {
  return new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 60_000, // keep idle connections for 60s (probe interval is ~60s)
    maxSockets: 5,
  })
}

/** Destroy all probe connections and create a fresh agent.
 *  Call when TUN stops/restarts so stale sockets don't poison the next cycle. */
function resetProbeAgent(): void {
  probeAgent.destroy()
  probeAgent = createProbeAgent()
  log.info('[probe] connection pool reset')
}

// DNS server to set via scutil — any routable IP works because sing-box
// hijack-dns intercepts ALL DNS queries (UDP 53) at the route level.
// FakeIP returns instant fake IPs; real resolution happens on the proxy server.
const SYSTEM_DNS_OVERRIDE = '8.8.8.8'

const SINGBOX_VERSION = '1.11.15'
const SINGBOX_DOWNLOAD_BASE = 'https://download.inkessai.com/singbox-mirror'

type SingBoxMode = 'tun' | 'local-proxy' | 'off'

export interface NetworkStatus {
  mode: SingBoxMode
  tunRunning: boolean
  installed: boolean
  lastError: string | null
  internetReachable: boolean | null
  latencyMs: number | null
}

/** Push payload sent to renderer whenever tunnel state changes materially. */
export interface TunStatusUpdate {
  tunRunning: boolean
  latencyMs: number | null
  actualIp: string | null
  expectedIp: string | null
  error: string | null
  lastTestAt: number
}

export class SingBoxManager {
  private singboxDir: string
  private configPath: string
  private process: ChildProcess | null = null
  private _mode: SingBoxMode = 'off'
  private _status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped'
  private _lastError: string | null = null
  private _internetReachable: boolean | null = null
  private _latencyMs: number | null = null
  private _stopPromise: Promise<void> | null = null
  private _startPromise: Promise<{ success?: boolean; error?: string }> | null = null
  private _interfaceMonitor: ReturnType<typeof setInterval> | null = null
  private _baselineInterfaces: Set<string> = new Set()
  private _onInterfaceAlert: ((newInterfaces: string[]) => void) | null = null
  private _baselineTimer: ReturnType<typeof setTimeout> | null = null
  private _statusListeners: Array<(update: TunStatusUpdate) => void> = []
  private _lastActualIp: string | null = null
  /** Wall-clock time (ms) of the last successful connectivity probe OR the last
   *  observed sing-box outbound success. Used to suppress restart-thrashing when
   *  a single probe target (e.g. cloudflare) is being blocked but real traffic
   *  is still flowing. */
  private _lastSeenHealthyAt = 0
  /** Helper client for communicating with the privileged daemon (macOS). */
  private _helperClient = new HelperClient()
  /** Helper installer for managing the LaunchDaemon lifecycle. */
  private _helperInstaller: HelperInstaller | null = null
  /** Whether the helper was freshly installed this session (user saw password prompt). */
  private _helperJustInstalled = false
  /** Latched true once we've successfully talked to the helper this session.
   *  Once latched, status reconciliation prefers the helper as the source of
   *  truth. Stays true across transient socket errors so we don't fall back
   *  to the legacy PID-file check (which is wrong in helper mode — the helper
   *  spawns sing-box but does NOT write to our app's PID file path). */
  private _helperAuthoritative = false
  /** Cached status snapshot. Updated by reconcileStatus(). Lets sync callers
   *  (getInfo, browser config, PTY env) read a recent value without I/O. */
  private _lastReconcileAt = 0
  /** Inflight reconcile promise — deduplicates concurrent reconciliations. */
  private _reconcileInflight: Promise<void> | null = null
  /** Active helper event subscription (close handle). When the helper pushes
   *  a `singbox_started` / `singbox_exited` event, we react to it immediately
   *  — no need to wait for a 5s renderer poll. Set up lazily once the helper
   *  is confirmed available; cleaned up on dispose. */
  private _helperSubscription: { close: () => void } | null = null
  /** Consecutive helper getStatus() failures — after threshold, degrade gracefully. */
  private _helperConsecutiveFailures = 0
  private static readonly HELPER_FAILURE_THRESHOLD = 5

  constructor() {
    this.singboxDir = join(app.getPath('userData'), 'sing-box')
    this.configPath = join(this.singboxDir, 'config.json')
    mkdirSync(this.singboxDir, { recursive: true })
    if (os.platform() === 'darwin') {
      this._helperInstaller = new HelperInstaller(process.resourcesPath, this._helperClient)
    }
  }

  get mode(): SingBoxMode { return this._mode }
  get status(): string { return this._status }
  get lastError(): string | null { return this._lastError }

  /** Legacy no-op — auth cooldown removed with helper daemon. */
  clearAuthDenyCooldown(): void {
    // No-op: helper daemon eliminates per-operation sudo prompts
  }

  /** Get the helper client for external use (IPC handlers). */
  get helperClient(): HelperClient { return this._helperClient }

  /** Get the helper installer for external use (IPC handlers). */
  get helperInstaller(): HelperInstaller | null { return this._helperInstaller }

  /**
   * Subscribe to tunnel status updates. Called whenever a material change
   * happens — startTun success/failure, stop, or a connectivity test result.
   * Returns an unsubscribe function.
   */
  onStatus(listener: (update: TunStatusUpdate) => void): () => void {
    this._statusListeners.push(listener)
    return () => {
      const i = this._statusListeners.indexOf(listener)
      if (i >= 0) this._statusListeners.splice(i, 1)
    }
  }

  /** Emit the current state to all status listeners. Swallows listener errors. */
  private emitStatus(expectedIp: string | null = null, error: string | null = null): void {
    const update: TunStatusUpdate = {
      tunRunning: this._status === 'running',
      latencyMs: this._latencyMs,
      actualIp: this._lastActualIp,
      expectedIp,
      error: error ?? this._lastError,
      lastTestAt: Date.now(),
    }
    log.info(`[sing-box] emitStatus → running=${update.tunRunning}, latency=${update.latencyMs}ms, actualIp=${update.actualIp}, error=${update.error ? update.error.slice(0, 80) : 'none'} (${this._statusListeners.length} listeners)`)
    for (const listener of this._statusListeners) {
      try { listener(update) } catch (err) {
        log.warn(`[sing-box] status listener threw: ${(err as Error).message}`)
      }
    }
  }

  private get binaryPath(): string {
    const name = os.platform() === 'win32' ? 'sing-box.exe' : 'sing-box'
    return join(this.singboxDir, name)
  }

  private get pidFilePath(): string {
    return join(this.singboxDir, 'sing-box.pid')
  }

  private get platformKey(): string {
    const platform = os.platform()
    const arch = os.arch()
    if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64'
    if (platform === 'win32') return 'windows-amd64'
    return 'linux-amd64'
  }

  private get versionMarkerPath(): string {
    return join(this.singboxDir, '.version')
  }

  isInstalled(): boolean {
    return existsSync(this.binaryPath)
  }

  /** Check if installed version matches expected version */
  private isVersionMatch(): boolean {
    try {
      const marker = readFileSync(this.versionMarkerPath, 'utf-8').trim()
      return marker === SINGBOX_VERSION
    } catch { return false }
  }

  // --- Process lifecycle helpers ---

  /** Check if a process is alive. Uses `ps` on macOS (root process = EPERM from kill). */
  private isProcessAlive(pid: number): boolean {
    try {
      if (os.platform() === 'darwin' || os.platform() === 'linux') {
        execSync(`ps -p ${pid} -o pid=`, { timeout: 2000, stdio: 'pipe' })
        return true
      }
      // Windows: check via tasklist
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { timeout: 2000, encoding: 'utf-8' })
      return out.includes(String(pid))
    } catch {
      return false
    }
  }

  /** Wait for a process to die, polling every 200ms. Returns true if dead. */
  private async waitForProcessDeath(pid: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (!this.isProcessAlive(pid)) return true
      await new Promise(r => setTimeout(r, 200))
    }
    return !this.isProcessAlive(pid)
  }

  /** Kill a process by PID.
   *  - macOS: tries non-sudo kill first, falls back to osascript if needed
   *  - Windows with sudo: UAC via PowerShell
   *  Note: the helper path in _stopImpl bypasses this method entirely.
   */
  private killProcess(pid: number, signal: 'TERM' | 'KILL', sudo = true): void {
    const sig = signal === 'KILL' ? '-9' : '-TERM'
    try {
      if (os.platform() === 'win32') {
        if (sudo) {
          execSync(
            `powershell -NoProfile -Command "Start-Process -FilePath 'taskkill' -ArgumentList '/F','/PID','${pid}' -Verb RunAs -WindowStyle Hidden -Wait"`,
            { timeout: 15000, stdio: 'pipe' }
          )
        } else {
          execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, stdio: 'pipe' })
        }
      } else if (sudo) {
        // Try non-sudo first
        try {
          execSync(`kill ${sig} ${pid}`, { timeout: 3000, stdio: 'pipe' })
          log.info(`[sing-box] killed pid=${pid} signal=${signal} (non-sudo)`)
          return
        } catch {
          // Expected: "Operation not permitted" for root-owned process
        }
        // Fallback to osascript (only reached if helper is unavailable)
        try {
          execSync(
            `osascript -e 'do shell script "kill ${sig} ${pid}" with administrator privileges'`,
            { timeout: 15000, stdio: 'pipe' }
          )
        } catch (sudoErr) {
          if (!this.isProcessAlive(pid)) {
            log.info(`[sing-box] kill pid=${pid}: sudo denied but process is already dead`)
            return
          }
          throw sudoErr
        }
      } else {
        execSync(`kill ${sig} ${pid}`, { timeout: 3000, stdio: 'pipe' })
      }
      log.info(`[sing-box] killed pid=${pid} signal=${signal}`)
    } catch (err) {
      log.warn(`[sing-box] kill pid=${pid} signal=${signal} failed: ${(err as Error).message}`)
    }
  }

  /** Read PID from PID file. Returns 0 if not found or invalid. */
  private readPidFile(): number {
    try {
      if (!existsSync(this.pidFilePath)) return 0
      const content = readFileSync(this.pidFilePath, 'utf-8').trim()
      const pid = parseInt(content)
      return pid > 0 ? pid : 0
    } catch {
      return 0
    }
  }

  /** Remove PID file. */
  private removePidFile(): void {
    try { unlinkSync(this.pidFilePath) } catch { /* ignore */ }
  }

  /** Read last N lines of sing-box log (for error reporting). */
  readRecentLog(maxLines = 30): string {
    try {
      const logPath = join(this.singboxDir, 'sing-box.log')
      if (!existsSync(logPath)) return ''
      const content = readFileSync(logPath, 'utf-8').trim()
      if (!content) return ''
      const lines = content.split('\n')
      return lines.slice(-maxLines).join('\n')
    } catch {
      return ''
    }
  }

  // --- Public API ---

  /**
   * Clean up stale sing-box processes from previous app crashes.
   * Uses non-interactive kill (no sudo dialog). If the root process can't be killed
   * without sudo, it will be killed when startTun() calls stop() with sudo.
   *
   * Also detects and cleans up orphan network state (utun interfaces + split
   * routes) left behind by ungraceful shutdowns — see detectStaleNetworkState().
   */
  async cleanupStaleProcesses(): Promise<void> {
    const pid = this.readPidFile()
    if (pid > 0) {
      if (this.isProcessAlive(pid)) {
        log.info(`[sing-box] startup cleanup: found stale process pid=${pid}`)
        // Try non-interactive kill (may fail for root/elevated processes, that's OK)
        if (os.platform() === 'win32') {
          // taskkill may work if Electron has sufficient rights
          try { execSync(`taskkill /F /PID ${pid}`, { timeout: 3000, stdio: 'pipe' }) } catch { /* ignore */ }
        } else {
          this.killProcess(pid, 'TERM', false)
        }
        const dead = await this.waitForProcessDeath(pid, 2000)
        if (!dead) {
          // Root process can't be killed without sudo — leave it for stop() to handle
          log.info(`[sing-box] startup cleanup: pid=${pid} needs sudo to kill, will clean up on next startTun`)
          // Mark it as running so reconcileStatus works correctly
          this._mode = 'tun'
          this._status = 'running'
          return
        }
      }
      this.removePidFile()
    }

    // After the process is gone (or was never running), check for orphan
    // network state — utun interfaces and split routes left behind by
    // SIGKILL / force-quit scenarios. Cleanup is deferred until startTun()
    // so we don't force a sudo dialog at app launch.
    try {
      const stale = this.detectStaleNetworkState()
      if (stale.hasResiduals) {
        log.warn(
          `[sing-box] startup cleanup: detected stale network state — ` +
          `interfaces=${JSON.stringify(stale.interfaces)} routes=${stale.routeDestinations.length}. ` +
          `Will clean up on next startTun().`,
        )
        this._hasStaleNetworkState = true
      }
    } catch (err) {
      log.warn(`[sing-box] detectStaleNetworkState failed: ${(err as Error).message}`)
    }

    this._mode = 'off'
    this._status = 'stopped'
    this._lastError = null
  }

  /** Set when cleanupStaleProcesses finds orphan network state at startup. */
  private _hasStaleNetworkState = false

  /**
   * Scan the system for orphan sing-box network state.
   *
   * macOS: utun interfaces with IPs in 198.18.0.0/15 + split-default routes.
   * Windows: WinTUN adapter named "sing-tun" left behind by force-killed sing-box.
   *
   * Detection-only: caller decides whether to attempt a cleanup.
   */
  private detectStaleNetworkState(): {
    hasResiduals: boolean
    interfaces: string[]
    routeDestinations: string[]
  } {
    const empty = { hasResiduals: false, interfaces: [] as string[], routeDestinations: [] as string[] }

    if (os.platform() === 'win32') {
      // Detect orphan WinTUN adapter. sing-box names it "sing-tun" or sometimes
      // the system shows it as "tun0" / "wintun". Check for any of these when
      // no sing-box process is running (if it's running, the adapter is expected).
      const pid = this.readPidFile()
      if (pid > 0 && this.isProcessAlive(pid)) return empty // process alive = normal
      try {
        const out = execSync('netsh interface show interface', {
          timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
        }).toString()
        // Match sing-box WinTUN adapter names (sing-tun, tun0, wintun)
        const tunLine = out.split('\n').find(line =>
          /\b(sing-tun|tun\d+|wintun)\b/i.test(line)
        )
        if (tunLine) {
          const match = tunLine.match(/\b(sing-tun|tun\d+|wintun)\b/i)
          const ifName = match ? match[1] : 'tun0'
          return { hasResiduals: true, interfaces: [ifName], routeDestinations: [] }
        }
      } catch { /* ignore */ }
      return empty
    }

    if (os.platform() !== 'darwin') return empty

    let ifconfigOut = ''
    try {
      ifconfigOut = execSync('ifconfig', { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    } catch { return empty }

    const interfaces = parseStaleSingBoxInterfaces(ifconfigOut)

    let routeDestinations: string[] = []
    try {
      const routeOut = execSync('netstat -rn -f inet', {
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString()
      routeDestinations = parseStaleSingBoxRoutes(routeOut)
    } catch { /* ignore — route list optional */ }

    return {
      hasResiduals: interfaces.length > 0 || routeDestinations.length > 0,
      interfaces,
      routeDestinations,
    }
  }

  /**
   * Actively clean up orphan network state.
   * macOS: uses helper daemon (no sudo prompt) — stop + restore_dns.
   * Windows: uses PowerShell UAC.
   */
  private async cleanupStaleNetworkState(): Promise<void> {
    log.info('[sing-box] cleanupStaleNetworkState — starting (20s timeout)')
    const CLEANUP_TIMEOUT_MS = 20_000
    try {
      await Promise.race([
        this._cleanupStaleNetworkStateImpl(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('stale network cleanup timed out')), CLEANUP_TIMEOUT_MS),
        ),
      ])
    } catch (err) {
      log.error(`[sing-box] cleanupStaleNetworkState failed/timed out: ${(err as Error).message}`)
      this._hasStaleNetworkState = true
    }
  }

  private async _cleanupStaleNetworkStateImpl(): Promise<void> {
    const stale = this.detectStaleNetworkState()
    if (!stale.hasResiduals) {
      this._hasStaleNetworkState = false
      return
    }

    log.warn(
      `[sing-box] cleaning up stale network state: ` +
      `interfaces=${JSON.stringify(stale.interfaces)} ` +
      `routes=${JSON.stringify(stale.routeDestinations)}`,
    )

    if (os.platform() === 'win32') {
      const ifNames = stale.interfaces.filter(n => /^[\w-]+$/.test(n))
      try {
        const cmds = [
          ...ifNames.map(n => `netsh interface set interface '${n}' admin=disable 2>$null`),
          `Remove-NetFirewallRule -DisplayName 'sing-tun*' -ErrorAction SilentlyContinue`,
          `ipconfig /flushdns 2>$null`,
        ]
        const script = cmds.join('; ')
        execSync(
          `powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile','-Command','${script.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait"`,
          { timeout: 15000, stdio: 'pipe' },
        )
        log.info('[sing-box] Windows stale network state cleanup complete')
        this._hasStaleNetworkState = false
      } catch (err) {
        log.error(`[sing-box] Windows stale cleanup failed: ${(err as Error).message}`)
      }
      return
    }

    if (os.platform() !== 'darwin') return

    // macOS: use helper daemon for cleanup (stop sing-box + restore DNS)
    try {
      if (await this._helperClient.isAvailable()) {
        await this._helperClient.stop().catch(() => {})
        await this._helperClient.restoreDns().catch(() => {})
        log.info('[sing-box] stale network state cleanup complete (via helper)')
        this._hasStaleNetworkState = false
        return
      }
    } catch {
      log.warn('[sing-box] helper not available for stale cleanup, falling back to osascript')
    }

    // Fallback: osascript (if helper not installed yet)
    const safeDests = stale.routeDestinations.filter((d) => /^[\d./]+$/.test(d))
    const safeIfaces = stale.interfaces.filter((i) => /^utun\d+$/.test(i))

    const routeCleanup = safeDests
      .map((dest) => `route -n delete -net ${dest} 198.18.0.1 2>/dev/null || true`)
      .join('; ')
    const extraRoutes = [
      'route -n delete -net 0.0.0.0/1 198.18.0.1 2>/dev/null || true',
      'route -n delete -net 128.0.0.0/1 198.18.0.1 2>/dev/null || true',
      'route -n delete -host 198.18.0.1 2>/dev/null || true',
    ].join('; ')
    const ifaceCleanup = safeIfaces
      .map((iface) => `ifconfig ${iface} destroy 2>/dev/null || true`)
      .join('; ')
    const dnsCleanup = `scutil <<DNSEOF 2>/dev/null
remove State:/Network/Service/sing-box-tun/DNS
DNSEOF
dscacheutil -flushcache 2>/dev/null; killall -HUP mDNSResponder 2>/dev/null`

    const parts = [routeCleanup, extraRoutes, ifaceCleanup, dnsCleanup].filter(Boolean)
    const fullScript = parts.join('; ')

    try {
      execSync(
        `osascript -e 'do shell script "${fullScript.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges'`,
        { timeout: 15000, stdio: 'pipe' },
      )
      log.info('[sing-box] stale network state cleanup complete (osascript fallback)')
      this._hasStaleNetworkState = false
    } catch (err) {
      log.error(`[sing-box] stale network state cleanup failed: ${(err as Error).message}`)
    }
  }

  /**
   * Stop sing-box. Async — waits for process to be confirmed dead.
   * Safe to call multiple times (mutex prevents concurrent stop).
   */
  /**
   * @param restoreDns - Restore system DNS on stop. Default true.
   *   false: used by startTun restart (keep DNS pointing to sing-box, avoid leak window)
   *   true: used by app quit, tun:stop IPC, logout (restore DNS to system default)
   */
  async stop(restoreDns = true): Promise<void> {
    log.info(`[sing-box] stop() entry — restoreDns=${restoreDns}, mode=${this._mode}, status=${this._status}, hasMutex=${!!this._stopPromise}`)
    // Signal any in-progress startTun to abort after its internal stop()
    if (restoreDns) this._stopRequested = true
    // Mutex: if already stopping, wait for that to finish
    if (this._stopPromise) {
      log.info('[sing-box] stop() — waiting for existing stop to finish')
      await this._stopPromise
      return
    }
    this._stopPromise = this._stopImpl(restoreDns)
    try {
      await this._stopPromise
    } finally {
      this._stopPromise = null
    }
  }

  // DNS setup is handled by the helper daemon (setDns RPC) or inside the
  // osascript fallback shell command. See startViaHelper() / startWithSudoFallback().

  /** Restore macOS system DNS to default. Awaits helper, falls back to osascript. */
  private async restoreSystemDns(): Promise<void> {
    if (os.platform() !== 'darwin') return
    log.info(`[sing-box] restoreSystemDns — helperAuthoritative=${this._helperAuthoritative}`)
    try {
      await this._helperClient.restoreDns()
    } catch (err) {
      log.warn(`[sing-box] helper DNS restore failed, trying osascript fallback: ${(err as Error).message}`)
      try {
        const cmd = `scutil <<EOF
remove State:/Network/Service/sing-box-tun/DNS
EOF
dscacheutil -flushcache 2>/dev/null; killall -HUP mDNSResponder 2>/dev/null`
        execSync(
          `osascript -e 'do shell script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges'`,
          { timeout: 15000, stdio: 'pipe' }
        )
        log.info('[sing-box] system DNS restored (osascript fallback)')
      } catch (fallbackErr) {
        log.error(`[sing-box] CRITICAL: failed to restore system DNS: ${(fallbackErr as Error).message}`)
        this._lastError = 'DNS_RESTORE_FAILED: System DNS may be misconfigured. Check Network settings.'
      }
    }
  }

  private async _stopImpl(restoreDns: boolean): Promise<void> {
    log.info(`[sing-box] stop() called, mode=${this._mode} status=${this._status} restoreDns=${restoreDns}`)
    this.stopInterfaceMonitor()

    // macOS with helper: delegate stop + DNS restore to the helper daemon (no sudo prompt)
    // Retry once after 500ms — helper may be mid-restart (launchd KeepAlive bounce)
    let helperAvail1 = false
    if (os.platform() === 'darwin') {
      helperAvail1 = await this._helperClient.isAvailable()
      if (!helperAvail1) {
        log.info('[sing-box] _stopImpl: helper not available on first try, waiting 500ms...')
      }
    }
    const helperReady = os.platform() === 'darwin' && (
      helperAvail1 ||
      await new Promise<boolean>(r => setTimeout(async () => r(await this._helperClient.isAvailable()), 500))
    )
    log.info(`[sing-box] _stopImpl: helperReady=${helperReady}`)
    if (helperReady) {
      try {
        // Restore DNS first (while sing-box is still routing), then stop sing-box
        if (restoreDns) {
          await this._helperClient.restoreDns().catch((err) =>
            log.warn(`[sing-box] helper DNS restore failed: ${err.message}`)
          )
        }
        await this._helperClient.stop()
        log.info('[sing-box] stopped via helper')
      } catch (err) {
        log.warn(`[sing-box] helper stop failed: ${(err as Error).message}, trying direct kill`)
        await this._stopImplManual(restoreDns)
        return
      }
      this.removePidFile()
      this._mode = 'off'
      this._status = 'stopped'
      this._lastError = null
      this._internetReachable = null
      this._latencyMs = null
      this._lastActualIp = null
      this._lastSeenHealthyAt = 0
      resetProbeAgent()
      this.emitStatus(null, null)
      return
    }

    // Non-helper path (Windows, Linux, or helper unavailable)
    if (restoreDns) await this.restoreSystemDns()
    await this._stopImplManual(restoreDns)
  }

  /** Manual stop — kill via PID file. Used when helper is unavailable or on Windows. */
  private async _stopImplManual(_restoreDns = true): Promise<void> {
    // Kill the osascript/powershell wrapper process (if any)
    const proc = this.process
    this.process = null
    if (proc) {
      if (process.platform === 'win32') {
        try { execSync(`taskkill /F /PID ${proc.pid}`, { stdio: 'pipe' }) } catch { /* ignore */ }
      } else {
        try { proc.kill('SIGTERM') } catch { /* ignore */ }
      }
    }

    // Kill the actual sing-box root process via PID file.
    const pid = this.readPidFile()
    if (pid > 0 && this.isProcessAlive(pid)) {
      log.info(`[sing-box] stopping pid=${pid} with SIGTERM...`)
      this.killProcess(pid, 'TERM')
      const dead = await this.waitForProcessDeath(pid, 5000)

      if (!dead) {
        log.warn(`[sing-box] pid=${pid} still alive after SIGTERM, sending SIGKILL`)
        this.killProcess(pid, 'KILL')
        await this.waitForProcessDeath(pid, 3000)
      }

      if (this.isProcessAlive(pid)) {
        log.error(`[sing-box] FAILED to kill pid=${pid} — leaving PID file, marking error`)
        this._status = 'error'
        this._lastError = `ORPHAN_PROCESS: previous sing-box (pid=${pid}) is still running and could not be terminated`
        this.emitStatus(null, this._lastError)
        throw new Error(this._lastError)
      }
      log.info(`[sing-box] pid=${pid} confirmed dead`)
    }

    this.removePidFile()
    this._mode = 'off'
    this._status = 'stopped'
    this._lastError = null
    this._internetReachable = null
    this._latencyMs = null
    this._lastActualIp = null
    this._lastSeenHealthyAt = 0
    resetProbeAgent()
    this.emitStatus(null, null)
  }

  /**
   * Start sing-box in TUN mode (requires admin/root).
   * Blocks until sing-box is confirmed running or fails.
   */
  private _stopRequested = false

  async startTun(proxyUrl: string, opts?: { useHelper?: boolean }): Promise<void> {
    // Mutex: if already starting, await the existing promise
    if (this._startPromise) {
      log.info(`[sing-box] startTun — already starting, awaiting existing promise`)
      const result = await this._startPromise
      if (result.error) throw new Error(result.error)
      return
    }

    this._stopRequested = false
    this._startPromise = this._startTunImpl(proxyUrl, opts)
    try {
      const result = await this._startPromise
      if (result.error) throw new Error(result.error)
    } finally {
      this._startPromise = null
    }
  }

  private _tunnelOutbound: SingBoxOutbound | undefined

  /** Set tunnel outbound for chain proxy mode (call before startTun) */
  setTunnelOutbound(outbound: SingBoxOutbound | undefined): void {
    this._tunnelOutbound = outbound
    if (outbound) {
      log.info(`[sing-box] tunnel outbound set: type=${outbound.type}, server=${outbound.server}:${outbound.server_port}`)
    } else {
      log.info(`[sing-box] tunnel outbound cleared (single proxy mode)`)
    }
  }

  private async _startTunImpl(proxyUrl: string, opts?: { useHelper?: boolean }): Promise<{ success?: boolean; error?: string }> {
    log.info(`[sing-box] _startTunImpl entry — useHelper=${opts?.useHelper}, mode=${this._mode}, status=${this._status}, helperAuthoritative=${this._helperAuthoritative}`)
    try {
      await this.reconcileStatus()

      await this.ensureInstalled()
      await this.stop(false) // stop without restoring DNS (avoid leak window on restart)

      // Check if an external stop() was requested while we were stopping
      if (this._stopRequested) {
        log.info(`[sing-box] startTun aborted — stop was requested during startup`)
        return { error: 'Start cancelled — stop requested' }
      }

      // After stop() completes, the process is dead. If it was killed
      // ungracefully (SIGKILL, force-quit, user cancelled sudo last time),
      // utun interfaces and split routes may still be lingering. Clean them
      // up now so the new sing-box can claim a fresh interface. Checks both
      // the startup-detected flag and a fresh scan for runtime residuals.
      if (this._hasStaleNetworkState || this.detectStaleNetworkState().hasResiduals) {
        await this.cleanupStaleNetworkState()
      }

      if (this._stopRequested) {
        log.info(`[sing-box] startTun aborted — stop requested after stale cleanup`)
        return { error: 'Start cancelled — stop requested' }
      }

      log.info(`[sing-box] building TUN config for proxy: ${proxyUrl.replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:***@')}`)
      const logOutput = join(this.singboxDir, 'sing-box.log')
      // Resolve rule-set directory (pre-bundled geosite-cn.srs + geoip-cn.srs)
      const ruleSetDir = join(process.resourcesPath, 'rule-set')
      const config = buildTunConfig({
        proxyUrl,
        logOutput,
        cacheFile: join(this.singboxDir, 'cache.db'),
        tunnelOutbound: this._tunnelOutbound,
        ruleSetDir: existsSync(join(ruleSetDir, 'geosite-cn.srs')) ? ruleSetDir : undefined,
      })
      this.writeConfig(config)
      await this.validateConfig()
      const mode = this._tunnelOutbound ? 'chain (tunnel → proxy)' : 'single proxy'
      log.info(`[sing-box] config written: mode=${mode}, stack=${config.inbounds[0]?.stack}, dns=${config.dns.servers.map(s => s.tag + ':' + s.address).join(', ')}`)
      log.info(`[sing-box] outbound: type=${config.outbounds[0]?.type}, server=${config.outbounds[0]?.server}:${config.outbounds[0]?.server_port}, username=${config.outbounds[0]?.username ? 'set' : 'none'}`)

      if (this._stopRequested) {
        log.info(`[sing-box] startTun aborted — stop requested after config validation`)
        this._mode = 'off'
        this._status = 'stopped'
        return { error: 'Start cancelled — stop requested' }
      }

      this._mode = 'tun'
      this._status = 'starting'

      if (os.platform() === 'darwin') {
        if (opts?.useHelper === false) {
          log.info('[sing-box] useHelper=false (explicit), using osascript sudo directly')
          await this.startWithSudoFallback()
        } else {
          log.info(`[sing-box] useHelper=${opts?.useHelper ?? 'undefined (default→helper)'}, starting via helper`)
          await this.startViaHelper()
        }
      } else if (os.platform() === 'win32') {
        await this.startWithAdmin()
      } else {
        this.startProcess()
      }

      // DNS override is handled inside startViaHelper / startWithSudoFallback.
      // Reset probe connections — old sockets went through previous TUN routes
      // and would fail or give stale results on the new tunnel.
      resetProbeAgent()
      // Emit a status update so renderer knows TUN is up. Latency/IP remain
      // null until the caller runs a connectivity test.
      this._internetReachable = null
      this._latencyMs = null
      this._lastActualIp = null
      this.emitStatus(null, null)
      return { success: true }
    } catch (err) {
      const error = (err as Error).message
      // If the start failed AFTER we wrote the config / kicked off sudo, the
      // half-baked attempt may have left a utun interface or split route on
      // the system (especially when sing-box exited mid-init). Schedule a
      // best-effort cleanup so the next retry starts clean instead of
      // racing the residual.
      try {
        if (os.platform() !== 'win32' && this.detectStaleNetworkState().hasResiduals) {
          this._hasStaleNetworkState = true
          log.warn('[sing-box] startTun failed — stale network state detected, will clean on next attempt')
        }
      } catch { /* ignore — detection is best-effort */ }
      this.emitStatus(null, error)
      return { error }
    }
  }

  /**
   * Start sing-box in local proxy mode (no admin needed)
   */
  async startLocalProxy(proxyUrl: string, port = 7891): Promise<number> {
    await this.ensureInstalled()
    await this.stop()

    const config = buildLocalProxyConfig(proxyUrl, port)
    this.writeConfig(config)

    this._mode = 'local-proxy'
    this._status = 'starting'
    this.startProcess()

    return port
  }

  /**
   * Reconcile in-memory status with actual process state.
   *
   * Source of truth:
   *   - macOS with helper available: helper's getStatus() RPC.
   *     The helper owns the sing-box process lifecycle and never lies.
   *   - Everywhere else (Windows, Linux, macOS osascript fallback):
   *     PID file + ps/tasklist process liveness check.
   *
   * The helper-mode branch is critical: in helper mode, our app's
   * `~/Library/Application Support/inkess-code/sing-box/sing-box.pid` file
   * is NEVER written (the helper spawns sing-box under launchd, no PID
   * handshake into the app's userData dir). So the legacy PID-file check
   * always reports "stopped" → the UI sees a phantom disconnect and
   * triggers a reconnect every 5 seconds. This method picks the right
   * provider for the current mode and avoids that pitfall.
   */
  async reconcileStatus(): Promise<void> {
    // Deduplicate concurrent reconciles (e.g. UI poll + connectivity check)
    if (this._reconcileInflight) return this._reconcileInflight
    this._reconcileInflight = this._reconcileStatusImpl().finally(() => {
      this._reconcileInflight = null
      this._lastReconcileAt = Date.now()
    })
    return this._reconcileInflight
  }

  private async _reconcileStatusImpl(): Promise<void> {
    if (os.platform() === 'darwin') {
      if (!this._helperAuthoritative) {
        try {
          const avail = await this._helperClient.isAvailable()
          if (avail) {
            log.info('[sing-box] reconcile: helper became authoritative (first successful contact)')
            this._helperAuthoritative = true
            this.ensureHelperSubscription()
          }
        } catch { /* ignore — helper not yet installed */ }
      }
      if (this._helperAuthoritative) {
        try {
          const status = await this._helperClient.getStatus()
          this._helperConsecutiveFailures = 0
          if (status.ok && status.singbox_running) {
            if (this._status !== 'running') {
              this._status = 'running'
              if (this._mode === 'off') this._mode = 'tun'
            }
          } else {
            if (this._status === 'running') {
              log.warn(`[sing-box] reconcile (helper): no live sing-box — marking stopped`)
              this._status = 'stopped'
              this._mode = 'off'
              this._internetReachable = null
              this._latencyMs = null
            }
          }
          return
        } catch (err) {
          this._helperConsecutiveFailures++
          if (this._helperConsecutiveFailures >= SingBoxManager.HELPER_FAILURE_THRESHOLD) {
            log.error(`[sing-box] reconcile: helper unreachable for ${this._helperConsecutiveFailures} consecutive attempts — marking stopped`)
            this._status = 'stopped'
            this._mode = 'off'
            this._lastError = 'Helper daemon unreachable — TUN status unknown'
            this._helperAuthoritative = false
            this._helperConsecutiveFailures = 0
            this.emitStatus(null, this._lastError)
          } else {
            log.warn(`[sing-box] reconcile (helper) failed (${this._helperConsecutiveFailures}/${SingBoxManager.HELPER_FAILURE_THRESHOLD}), keeping last state: ${(err as Error).message}`)
          }
          return
        }
      }
    }

    // Non-helper path: PID file + process liveness
    const pid = this.readPidFile()
    if (pid > 0) {
      if (this.isProcessAlive(pid)) {
        if (this._status !== 'running') {
          this._status = 'running'
          if (this._mode === 'off') this._mode = 'tun'
        }
        return
      }
      // PID file exists but process dead — clean up
      log.warn(`[sing-box] reconcile: pid=${pid} is dead, cleaning up PID file`)
      this.removePidFile()
    }
    if (this._status === 'running') {
      log.warn(`[sing-box] reconcile: status was running but no live process — marking stopped`)
      this._status = 'stopped'
      this._mode = 'off'
      this._internetReachable = null
      this._latencyMs = null
    }
  }

  /** Synchronous snapshot — returns cached state without I/O. Use this from
   *  hot paths (PTY env build, browser config) where awaiting is impractical
   *  and a slightly stale value is fine. Pair with a background reconcile
   *  trigger if you need fresh data. */
  getInfo(): NetworkStatus {
    // Kick off a background reconcile if cache is stale, but don't wait for it.
    // The next call (or the explicit await in `tun:getInfo`) will see the result.
    if (Date.now() - this._lastReconcileAt > 1500) {
      void this.reconcileStatus()
    }
    return {
      mode: this._mode,
      tunRunning: this._status === 'running',
      installed: this.isInstalled(),
      lastError: this._lastError,
      internetReachable: this._internetReachable,
      latencyMs: this._latencyMs,
    }
  }

  /** Fresh status — awaits reconcile, then returns. Use for user-facing
   *  checks (renderer `tun:getInfo` IPC) where staleness shows up as UI flicker. */
  async getInfoFresh(): Promise<NetworkStatus> {
    await this.reconcileStatus()
    return this.getInfo()
  }

  /**
   * Open a long-lived Subscribe connection to the helper so we react to
   * sing-box lifecycle changes the instant they happen, instead of waiting
   * for the renderer's poll. Safe to call repeatedly — the second call is
   * a no-op while a subscription is active.
   *
   * The subscription auto-reconnects internally; on reconnect, we run a
   * one-shot reconcile so we don't miss state that changed while the
   * socket was down. On `singbox_exited`, we synchronously flip _status
   * to 'stopped' and emit a status update — which is exactly what the
   * renderer needs to show TunGate without a 5-second blind spot.
   */
  private ensureHelperSubscription(): void {
    if (this._helperSubscription) return
    if (os.platform() !== 'darwin') return

    this._helperSubscription = this._helperClient.subscribe({
      onConnect: () => {
        log.info('[sing-box] helper event subscription connected')
        // Catch up on anything we may have missed while the socket was down.
        void this.reconcileStatus()
      },
      onDisconnect: (err) => {
        if (err) log.debug(`[sing-box] helper subscription dropped: ${err.message}`)
      },
      onEvent: (event) => this.handleHelperEvent(event),
    })
  }

  /** React to a helper-pushed lifecycle event. Drives the same code paths
   *  as the renderer's status polling, but with millisecond-level latency. */
  private handleHelperEvent(event: HelperEvent): void {
    log.info(`[sing-box] helper event: ${event.event} pid=${event.singbox_pid ?? 'n/a'}`)
    if (event.event === 'singbox_started') {
      // Helper confirmed a fresh sing-box is running. If our _status was
      // already 'running' (we just called start), no-op; otherwise sync up.
      if (this._status !== 'running') {
        this._status = 'running'
        if (this._mode === 'off') this._mode = 'tun'
      }
      this._lastReconcileAt = Date.now()
      this.emitStatus(null, null)
      return
    }
    if (event.event === 'singbox_exited') {
      // Helper saw the sing-box child terminate (graceful stop, crash,
      // OOM, force-kill). Flip state to stopped + emit so the renderer
      // shows TunGate without waiting for its poll interval.
      const wasRunning = this._status === 'running'
      this._status = 'stopped'
      this._mode = 'off'
      this._internetReachable = null
      this._latencyMs = null
      this._lastActualIp = null
      this._lastReconcileAt = Date.now()
      const exitDetails = event.signal != null
        ? `signal=${event.signal}`
        : event.exit_code != null
          ? `exit_code=${event.exit_code}`
          : 'unknown'
      const err = wasRunning ? `sing-box exited unexpectedly (${exitDetails})` : null
      this._lastError = err
      this.emitStatus(null, err)
    }
  }

  /** Close the helper subscription. Called at app shutdown. */
  closeHelperSubscription(): void {
    if (this._helperSubscription) {
      try { this._helperSubscription.close() } catch { /* ignore */ }
      this._helperSubscription = null
    }
  }

  /**
   * Start monitoring for new TUN/utun interfaces.
   * Captures baseline interfaces at start, polls every 10s.
   * Calls onAlert when new TUN-like interfaces appear.
   */
  startInterfaceMonitor(onAlert: (newInterfaces: string[]) => void): void {
    this.stopInterfaceMonitor()
    this._onInterfaceAlert = onAlert

    // Delay baseline capture by 5s — sing-box TUN interface may not appear immediately
    // after PID confirmed. Without delay, sing-box's own utun is misdetected as "external VPN".
    const BASELINE_DELAY = 5000
    const POLL_INTERVAL = 10000

    const baselineTimer = setTimeout(() => {
      this._baselineInterfaces = new Set(Object.keys(os.networkInterfaces()))
      log.info(`[sing-box] interface monitor started, baseline: ${[...this._baselineInterfaces].filter(i => /^(utun|tun)/.test(i)).join(', ') || 'none'}`)

      this._interfaceMonitor = setInterval(() => {
        if (this._status !== 'running') return
        const current = Object.keys(os.networkInterfaces())
        const newTunInterfaces = current.filter(name =>
          !this._baselineInterfaces.has(name) && /^(utun|tun|wintun)/i.test(name)
        )
        if (newTunInterfaces.length > 0) {
          log.warn(`[sing-box] new TUN interface(s) detected: ${newTunInterfaces.join(', ')}`)
          this._onInterfaceAlert?.(newTunInterfaces)
          for (const name of newTunInterfaces) {
            this._baselineInterfaces.add(name)
          }
        }
      }, POLL_INTERVAL)
    }, BASELINE_DELAY)

    // Store timer ref so stopInterfaceMonitor can clear it
    this._baselineTimer = baselineTimer
  }

  /** Stop interface monitor. */
  stopInterfaceMonitor(): void {
    if (this._baselineTimer) {
      clearTimeout(this._baselineTimer)
      this._baselineTimer = null
    }
    if (this._interfaceMonitor) {
      clearInterval(this._interfaceMonitor)
      this._interfaceMonitor = null
    }
    this._onInterfaceAlert = null
    this._baselineInterfaces.clear()
  }

  /**
   * Test connectivity through TUN by verifying exit IP.
   *
   * Uses Cloudflare's `/cdn-cgi/trace` endpoint — a public, non-account,
   * globally-distributed marketing/debug URL that returns plain-text
   * key=value fields including `ip=` and `loc=` (ISO country). Chosen
   * because:
   *
   *   - The previous endpoint `ip.oxylabs.io/location` is a marketing
   *     demo page for oxylabs's commercial proxy product; they appear
   *     to soft-block specific IPs / account histories (TCP accepts
   *     but HTTP silently drops, producing 15–40 second timeouts).
   *   - Cloudflare's trace endpoint is served by their edge network
   *     everywhere, doesn't reject connections, and parses trivially.
   *   - No `timezone` field — we map `loc` → timezone via a hardcoded
   *     table (`countryCodeToTimezone` below).
   *
   * If exitIp is empty, only checks that the request succeeds.
   */
  async testConnectivity(exitIp?: string): Promise<{ success: boolean; latency?: number; error?: string; actualIp?: string }> {
    await this.reconcileStatus()
    if (this._status !== 'running') {
      this._internetReachable = false
      this._latencyMs = null
      this._lastActualIp = null
      log.info(`[testConnectivity] skipped — TUN status=${this._status}`)
      const error = 'TUN is not running'
      this.emitStatus(exitIp || null, error)
      return { success: false, error }
    }

    // Multi-target race: probe several endpoints in parallel; any 200 means
    // "network is healthy". This makes the check robust to a single target
    // (notably cloudflare) being throttled or blocked — which has historically
    // caused the app to spuriously declare the tunnel dead and tear it down
    // even while api.anthropic.com / claude.com were happily serving traffic.
    //
    // Cloudflare's `/cdn-cgi/trace` remains the source of truth for "what is
    // my exit IP" — we wait for it to land if any target succeeds, but only
    // briefly, so a slow/blocked cloudflare doesn't stretch the whole probe.
    const PROBE_TIMEOUT_MS = 8000
    const probes: Array<Promise<{ url: string; status: number; ms: number; trace?: string }>> = [
      probeOne('https://www.cloudflare.com/cdn-cgi/trace', PROBE_TIMEOUT_MS, true),
      probeOne('https://api.anthropic.com/', PROBE_TIMEOUT_MS, false),
      probeOne('https://claude.com/', PROBE_TIMEOUT_MS, false),
    ]
    log.info(`[testConnectivity] race ${probes.length} targets (timeout ${PROBE_TIMEOUT_MS}ms, expected exit ${exitIp || 'any'})...`)

    const settled = await Promise.allSettled(probes)
    const winners = settled
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.status === 'fulfilled' && (s as PromiseFulfilledResult<{ status: number }>).value.status >= 200 && (s as PromiseFulfilledResult<{ status: number }>).value.status < 400)
      .map(({ s, i }) => ({ ...((s as PromiseFulfilledResult<{ url: string; status: number; ms: number; trace?: string }>).value), idx: i }))

    if (winners.length === 0) {
      // Everyone failed. Before declaring failure, check whether sing-box
      // itself has been moving real bytes recently — if yes, the user is
      // online but our probes happen to all be blocked. Don't lie that
      // they're disconnected.
      const recent = this.recentOutboundActivity(30000)
      if (recent.successes >= 3) {
        log.warn(`[testConnectivity] all probes failed but sing-box has ${recent.successes} successful outbounds in last 30s — treating as healthy (single-probe outage)`)
        this._internetReachable = true
        this._lastSeenHealthyAt = Date.now()
        // Keep last known IP / latency; don't pretend we measured them now.
        this.emitStatus(exitIp || null, null)
        return { success: true, latency: this._latencyMs ?? undefined, actualIp: this._lastActualIp ?? undefined }
      }
      const firstError = settled.map(s => s.status === 'rejected' ? (s.reason as Error)?.message : `HTTP ${(s as PromiseFulfilledResult<{ status: number }>).value.status}`).join('; ')
      log.error('[testConnectivity] all probes failed:', firstError)
      this._internetReachable = false
      this._latencyMs = null
      this._lastActualIp = null
      this.emitStatus(exitIp || null, firstError)
      return { success: false, error: firstError }
    }

    // Pick best (lowest ms) for latency reporting.
    const best = winners.reduce((a, b) => (a.ms <= b.ms ? a : b))
    const latency = best.ms
    log.info(`[testConnectivity] healthy via ${best.url} HTTP ${best.status} (${best.ms}ms); ${winners.length}/${probes.length} probes ok`)

    // Try to extract exit IP from cloudflare trace. If cloudflare didn't
    // win (slow/blocked), the IP stays as last-known. Mismatch is
    // surfaced but no longer hard-fails the probe — we already know the
    // tunnel is moving traffic.
    const traceWinner = winners.find(w => w.trace)
    let actualIp: string | undefined
    let mismatchError: string | undefined
    if (traceWinner?.trace) {
      const fields = parseCloudflareTrace(traceWinner.trace)
      actualIp = fields.ip
      if (actualIp) {
        log.info(`[testConnectivity] exit IP: ${actualIp} (loc=${fields.loc ?? '?'})`)
        if (exitIp && actualIp !== exitIp) {
          mismatchError = `Exit IP mismatch: got ${actualIp}, expected ${exitIp}`
          log.error(`[testConnectivity] ${mismatchError}`)
        }
      }
    }

    this._latencyMs = latency
    if (actualIp) this._lastActualIp = actualIp
    this._lastSeenHealthyAt = Date.now()

    // IP mismatch IS still a hard failure — it indicates the route is
    // hijacked by another VPN or the proxy is wrong. Other probes succeeding
    // doesn't override this signal.
    if (mismatchError) {
      this._internetReachable = false
      this.emitStatus(exitIp || null, mismatchError)
      return { success: false, latency, actualIp, error: mismatchError }
    }

    this._internetReachable = true
    this.emitStatus(exitIp || null, null)
    return { success: true, latency, actualIp }
  }

  /**
   * Parse the sing-box log to gauge real outbound activity in the last
   * `windowMs` ms. Used as a sanity check against probe-target outages — if
   * the log shows actual connections succeeding we should NOT tear down the
   * tunnel just because cloudflare/etc. timed out.
   *
   * Returns counts of `outbound connection to` (success) and various error
   * lines (timeout / rejected / refused).
   */
  recentOutboundActivity(windowMs = 30000): { successes: number; failures: number } {
    try {
      const logPath = join(this.singboxDir, 'sing-box.log')
      if (!existsSync(logPath)) return { successes: 0, failures: 0 }
      const content = readFileSync(logPath, 'utf-8')
      const lines = content.split('\n')
      // Sing-box log lines look like:
      //   -0700 2026-05-08 15:55:35 INFO [...] outbound/socks[proxy]: outbound connection to host:443
      //   -0700 2026-05-08 15:55:38 ERROR [...] connection: open outbound connection: dial tcp ...
      // The leading TZ offset and "YYYY-MM-DD HH:MM:SS" portion can be parsed.
      const cutoff = Date.now() - windowMs
      let successes = 0
      let failures = 0
      // Walk from the tail — older lines won't be in window.
      for (let i = lines.length - 1; i >= 0 && i > lines.length - 5000; i--) {
        const line = lines[i]
        if (!line) continue
        // Match TZ offset + date + time: "-0700 2026-05-08 15:55:35"
        const m = line.match(/([+-]\d{4})\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/)
        if (!m) continue
        const ts = Date.parse(`${m[2]}T${m[3]}${m[1]}`)
        if (Number.isNaN(ts)) continue
        if (ts < cutoff) break
        if (line.includes('outbound connection to') && !line.includes('open outbound connection')) {
          successes++
        } else if (line.includes('open outbound connection')) {
          failures++
        }
      }
      return { successes, failures }
    } catch {
      return { successes: 0, failures: 0 }
    }
  }

  /** Last time we saw evidence of healthy traffic (probe success or recent
   *  sing-box outbound activity). Used by callers to avoid restarting a tunnel
   *  that's actually working. */
  get lastSeenHealthyAt(): number { return this._lastSeenHealthyAt }

  /**
   * Run network diagnostics — tests each hop to identify where latency comes from.
   * Returns timing for: DNS, direct connection, proxy connection, proxy DNS+connect.
   */
  async runDiagnostics(): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = { timestamp: new Date().toISOString(), tunStatus: this._status }

    // 1. DNS resolution speed (local DNS, 114.114.114.114)
    // Tests actual DNS by resolving a known CN domain. The previous version
    // did `fetch('http://114.114.114.114')` which tested HTTP to a DNS server
    // (always fails — 114 doesn't serve HTTP on port 80).
    try {
      const start = Date.now()
      const { resolve4 } = await import('dns/promises')
      const addresses = await Promise.race([
        resolve4('www.baidu.com'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dns timeout')), 5000)),
      ])
      results.localDns = { ms: Date.now() - start, ok: addresses.length > 0, resolved: addresses[0] }
    } catch (e) { results.localDns = { ms: -1, ok: false, error: (e as Error).message } }

    // 2. Direct connection to domestic site (should NOT go through proxy)
    try {
      const start = Date.now()
      const res = await fetchWithTimeout('https://www.baidu.com', {}, 10000)
      results.directDomestic = { ms: Date.now() - start, status: res.status }
    } catch (e) { results.directDomestic = { ms: -1, error: (e as Error).message } }

    // 3. Proxy connection — whitelisted domain (should go through proxy)
    try {
      const start = Date.now()
      const res = await fetchWithTimeout('https://api.anthropic.com', {}, 15000)
      results.proxyForeign = { ms: Date.now() - start, status: res.status }
    } catch (e) { results.proxyForeign = { ms: -1, error: (e as Error).message } }

    // 4. Exit IP check (through proxy) — Cloudflare trace, see testConnectivity.
    try {
      const start = Date.now()
      const res = await fetchWithTimeout('https://www.cloudflare.com/cdn-cgi/trace', {}, 15000)
      const text = await res.text()
      const fields = parseCloudflareTrace(text)
      results.exitIp = { ms: Date.now() - start, ip: fields.ip ?? null, loc: fields.loc ?? null, status: res.status }
    } catch (e) { results.exitIp = { ms: -1, error: (e as Error).message } }

    // 5. Google (through proxy)
    try {
      const start = Date.now()
      const res = await fetchWithTimeout('https://www.google.com', {}, 15000)
      results.proxyGoogle = { ms: Date.now() - start, status: res.status }
    } catch (e) { results.proxyGoogle = { ms: -1, error: (e as Error).message } }

    // 6. Read recent sing-box log (last 20 lines)
    try {
      const logPath = join(this.singboxDir, 'sing-box.log')
      const content = readFileSync(logPath, 'utf-8')
      const lines = content.trim().split('\n')
      results.recentLog = lines.slice(-20)
    } catch { results.recentLog = [] }

    log.info(`[diagnostics] results: ${JSON.stringify(results, null, 2)}`)
    return results
  }

  // --- Install ---

  async install(onProgress?: (step: string, pct: number) => void): Promise<void> {
    const key = this.platformKey
    const ext = os.platform() === 'win32' ? '.zip' : '.tar.gz'
    const filename = `sing-box-${SINGBOX_VERSION}-${key}`
    const url = `${SINGBOX_DOWNLOAD_BASE}/${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-${key}${ext}`

    onProgress?.('Downloading sing-box...', 0.1)
    log.info(`SingBox: downloading ${url}`)

    const res = await fetchWithTimeout(url, {}, 300000)
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)

    const tmpPath = join(this.singboxDir, `sing-box${ext}.tmp`)
    const { createWriteStream } = require('fs') as typeof import('fs')
    const { pipeline } = require('stream/promises') as typeof import('stream/promises')
    const { Readable } = require('stream') as typeof import('stream')

    const fileStream = createWriteStream(tmpPath)
    await pipeline(Readable.fromWeb(res.body as any), fileStream)

    onProgress?.('Extracting...', 0.7)

    if (os.platform() === 'win32') {
      const zipPath = tmpPath.replace('.tmp', '')
      const { renameSync } = require('fs') as typeof import('fs')
      renameSync(tmpPath, zipPath)
      try {
        execSync(
          `powershell -NoProfile -Command "try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{}; Expand-Archive -Force -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${this.singboxDir.replace(/'/g, "''")}'"`
          , { timeout: 120000 }
        )
      } finally {
        try { unlinkSync(zipPath) } catch { /* ignore */ }
      }
      const extractedDir = join(this.singboxDir, filename)
      const extractedExe = join(extractedDir, 'sing-box.exe')
      if (existsSync(extractedExe)) {
        const { copyFileSync, rmSync } = require('fs') as typeof import('fs')
        copyFileSync(extractedExe, this.binaryPath)
        // Copy wintun.dll — required for Windows TUN mode
        const wintunSrc = join(extractedDir, 'wintun.dll')
        if (existsSync(wintunSrc)) {
          copyFileSync(wintunSrc, join(this.singboxDir, 'wintun.dll'))
          log.info('SingBox: wintun.dll copied')
        } else {
          log.warn('SingBox: wintun.dll not found in archive — TUN may not work on Windows')
        }
        // Clean up extracted subdirectory
        try { rmSync(extractedDir, { recursive: true }) } catch { /* ignore */ }
      }
    } else {
      try {
        execSync(`tar -xzf "${tmpPath}" -C "${this.singboxDir}"`, { timeout: 60000 })
      } finally {
        try { unlinkSync(tmpPath) } catch { /* ignore */ }
      }
      const extractedDir = join(this.singboxDir, filename)
      const extracted = join(extractedDir, 'sing-box')
      if (existsSync(extracted)) {
        const { copyFileSync, rmSync } = require('fs') as typeof import('fs')
        copyFileSync(extracted, this.binaryPath)
        chmodSync(this.binaryPath, 0o755)
        // Clean up extracted subdirectory
        try { rmSync(extractedDir, { recursive: true }) } catch { /* ignore */ }
      }
    }

    if (os.platform() === 'darwin') {
      try { execSync(`xattr -cr "${this.binaryPath}"`, { timeout: 5000 }) } catch { /* ignore */ }
    }

    onProgress?.('Verifying...', 0.9)
    try {
      execSync(`"${this.binaryPath}" version`, { timeout: 5000, encoding: 'utf-8' })
      writeFileSync(this.versionMarkerPath, SINGBOX_VERSION)
      log.info(`SingBox: installed v${SINGBOX_VERSION} successfully`)
    } catch (err) {
      throw new Error(`sing-box verification failed: ${(err as Error).message}`)
    }

    onProgress?.('Ready', 1.0)
  }

  // --- Internal start methods ---

  private writeConfig(config: SingBoxConfig): void {
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
  }

  /** Pre-flight config validation via `sing-box check`. Catches malformed configs
   *  before attempting TUN start (which would crash sing-box with opaque errors). */
  private async validateConfig(): Promise<void> {
    try {
      await execFileAsync(this.binaryPath, ['check', '-c', this.configPath], { timeout: 10_000 })
      log.info('[sing-box] config validation passed')
    } catch (err: any) {
      const stderr = err.stderr?.toString?.() || err.message || 'unknown error'
      throw new Error(`Config validation failed: ${stderr.slice(0, 500)}`)
    }
  }

  private async ensureInstalled(): Promise<void> {
    if (!this.isInstalled() || !this.isVersionMatch()) {
      log.info(`SingBox: need install/upgrade to ${SINGBOX_VERSION}`)
      await this.install()
    }
  }

  private startProcess(): void {
    this.process = spawn(this.binaryPath, ['run', '-c', this.configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.process.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) log.info(`[sing-box] ${msg}`)
      if (msg.includes('started')) {
        this._status = 'running'
      }
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) log.warn(`[sing-box] ${msg}`)
      this._lastError = msg
    })

    this.process.on('exit', (code) => {
      log.info(`[sing-box] exited with code ${code}`)
      this._status = code === 0 ? 'stopped' : 'error'
      this.process = null
    })

    setTimeout(() => {
      if (this._status === 'starting' && this.process) {
        this._status = 'running'
      }
    }, 2000)
  }

  /**
   * Start sing-box via the privileged helper daemon (macOS).
   * The helper runs as root and manages sing-box lifecycle — no sudo prompt needed.
   * Falls back to osascript if helper is not available.
   */
  private async startViaHelper(): Promise<void> {
    log.info(`[sing-box] startViaHelper entry — helperInstaller=${!!this._helperInstaller}, helperAuthoritative=${this._helperAuthoritative}`)
    // Ensure the helper daemon is installed and running
    if (this._helperInstaller) {
      try {
        this._helperJustInstalled = await this._helperInstaller.ensureReady()
        log.info(`[sing-box] startViaHelper — ensureReady done, justInstalled=${this._helperJustInstalled}`)
      } catch (err) {
        const msg = (err as Error).message
        if (msg.includes('AUTH_DENIED')) {
          this._status = 'stopped'
          this._lastError = msg
          throw err
        }
        // If helper was installed but not yet available, retry with longer waits
        if (msg.includes('did not become available') && this._helperInstaller.isInstalled()) {
          log.info('[sing-box] helper installed but slow to start, retrying...')
          let available = false
          for (let attempt = 1; attempt <= 3; attempt++) {
            log.info(`[sing-box] helper retry ${attempt}/3 (waiting 5s)...`)
            await this._helperInstaller.waitForHelper(5000)
              .then(() => { available = true })
              .catch(() => { /* try next */ })
            if (available) break
          }
          if (!available) {
            log.warn(`[sing-box] helper not available after retries, falling back to osascript`)
            await this.startWithSudoFallback()
            return
          }
        } else {
          log.warn(`[sing-box] helper not available: ${msg}, falling back to osascript`)
          await this.startWithSudoFallback()
          return
        }
      }
    }

    // Start sing-box via helper RPC
    log.info(`[sing-box] startViaHelper — calling helper.start(binary=${this.binaryPath}, appPid=${process.pid})`)
    try {
      await this._helperClient.start(this.binaryPath, this.configPath, process.pid)
    } catch (err) {
      log.error(`[sing-box] helper start failed: ${(err as Error).message}`)
      throw err
    }

    // Abort gate: if stop was requested while helper was starting, roll back
    if (this._stopRequested) {
      log.info('[sing-box] startViaHelper: stop requested after start, stopping immediately')
      await this._helperClient.stop().catch(() => {})
      throw new Error('Start cancelled — stop requested during helper start')
    }

    // Set DNS via helper
    try {
      await this._helperClient.setDns(SYSTEM_DNS_OVERRIDE)
    } catch (err) {
      log.warn(`[sing-box] helper DNS setup failed: ${(err as Error).message}`)
      // Non-fatal — sing-box hijack-dns can still work in some configurations
    }

    // Verify sing-box is running via helper status
    const status = await this._helperClient.getStatus()
    if (status.singbox_running) {
      this._status = 'running'
      this._helperAuthoritative = true
      this._lastReconcileAt = Date.now()
      // Helper now owns the lifecycle — any leftover PID file from a previous
      // osascript-mode run is now meaningless and would only confuse cleanup
      // paths. Remove it once helper is confirmed authoritative.
      this.removePidFile()
      this.ensureHelperSubscription()
      log.info(`[sing-box] confirmed running via helper, pid=${status.singbox_pid}`)
    } else {
      // Give it a moment to start
      await new Promise(r => setTimeout(r, 2000))
      const retry = await this._helperClient.getStatus()
      if (retry.singbox_running) {
        this._status = 'running'
        this._helperAuthoritative = true
        this._lastReconcileAt = Date.now()
        this.ensureHelperSubscription()
        log.info(`[sing-box] confirmed running via helper (retry), pid=${retry.singbox_pid}`)
      } else {
        throw new Error('sing-box failed to start via helper')
      }
    }
  }

  /**
   * Fallback: start sing-box via osascript (macOS sudo) when helper is unavailable.
   * This is the legacy path — each start requires a password prompt.
   */
  private startWithSudoFallback(): Promise<void> {
    log.info('[sing-box] startWithSudoFallback entry — will prompt for password via osascript')
    return new Promise((resolve, reject) => {
      const safeBin = this.binaryPath.replace(/'/g, "'\\''")
      const safeCfg = this.configPath.replace(/'/g, "'\\''")
      const safePid = this.pidFilePath.replace(/'/g, "'\\''")
      const logFile = join(this.singboxDir, 'sing-box.log').replace(/'/g, "'\\''")
      const parentPid = process.pid

      const dnsSetup = `scutil <<DNSEOF
d.init
d.add ServerAddresses * ${SYSTEM_DNS_OVERRIDE}
d.add SupplementalMatchDomains * ""
set State:/Network/Service/sing-box-tun/DNS
DNSEOF
dscacheutil -flushcache 2>/dev/null; killall -HUP mDNSResponder 2>/dev/null`

      const dnsCleanup = `scutil <<DNSEOF
remove State:/Network/Service/sing-box-tun/DNS
DNSEOF
dscacheutil -flushcache 2>/dev/null; killall -HUP mDNSResponder 2>/dev/null`

      const shellCmd = `'${safeBin}' run -c '${safeCfg}' > '${logFile}' 2>&1 & SB_PID=$!; echo $SB_PID > '${safePid}'; sleep 1; ${dnsSetup}; while kill -0 ${parentPid} 2>/dev/null && kill -0 $SB_PID 2>/dev/null; do sleep 2; done; ${dnsCleanup}; kill -TERM $SB_PID 2>/dev/null; for _i in 1 2 3 4 5 6 7 8 9 10; do kill -0 $SB_PID 2>/dev/null || break; sleep 0.5; done; kill -9 $SB_PID 2>/dev/null`

      let settled = false
      let pidPollInterval: ReturnType<typeof setInterval> | null = null
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        if (pidPollInterval) { clearInterval(pidPollInterval); pidPollInterval = null }
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null }
      }

      const settle = (ok: boolean, err?: string) => {
        if (settled) return
        settled = true
        cleanup()
        if (ok) {
          this._status = 'running'
          log.info('[sing-box] confirmed running via PID file (osascript fallback)')
          resolve()
        } else {
          this._status = 'error'
          this._lastError = err || 'Failed to start sing-box'
          log.error(`[sing-box] startWithSudoFallback failed: ${err}`)
          reject(new Error(err))
        }
      }

      try {
        this.process = spawn('osascript', [
          '-e', `do shell script "${shellCmd.replace(/"/g, '\\"')}" with administrator privileges`,
        ], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        pidPollInterval = setInterval(() => {
          const pid = this.readPidFile()
          if (pid > 0) {
            if (this.isProcessAlive(pid)) {
              settle(true)
            } else if (!timeoutTimer) {
              timeoutTimer = setTimeout(() => {
                const retryPid = this.readPidFile()
                if (retryPid > 0 && this.isProcessAlive(retryPid)) {
                  settle(true)
                } else {
                  settle(false, 'sing-box exited immediately after start')
                }
              }, 15000)
            }
          }
        }, 300)

        this.process.on('exit', (code) => {
          this.process = null
          const pid = this.readPidFile()
          if (pid > 0 && this.isProcessAlive(pid)) {
            settle(true)
            return
          }
          if (!settled) {
            settle(false, code === 0 ? 'sing-box exited' : `osascript exited with code ${code}`)
          }
        })

        this.process.stderr?.on('data', (data: Buffer) => {
          const msg = data.toString().trim()
          if (msg) log.warn(`[sing-box sudo] ${msg}`)
          if (msg.includes('-60005') || msg.includes('密码不正确') || msg.includes('User canceled')) {
            this._status = 'stopped'
            this._lastError = 'AUTH_DENIED: Admin authorization was denied'
            settle(false, 'AUTH_DENIED: Admin authorization was denied. Click Retry and enter your Mac password.')
          }
        })

      } catch (err) {
        settle(false, (err as Error).message)
      }
    })
  }

  /** Start sing-box via PowerShell UAC (Windows). Event-driven like startWithSudo. */
  private startWithAdmin(): Promise<void> {
    return new Promise((resolve, reject) => {
      const safeBin = this.binaryPath.replace(/'/g, "''")
      const safeCfg = this.configPath.replace(/'/g, "''")
      const pidFile = this.pidFilePath.replace(/'/g, "''")
      // Start sing-box elevated, write PID, then monitor parent (Electron) process.
      // When parent dies, the watchdog kills sing-box to prevent process leak.
      // Note: -Verb RunAs (UAC) conflicts with -RedirectStandardOutput in PowerShell,
      // so sing-box logging is configured via log.output in the JSON config instead.
      const parentPid = process.pid
      // Force UTF-8 output so Chinese Windows (GBK/CP936) error messages don't garble in logs
      // Force UTF-8 output; try/catch for Constrained Language Mode (AppLocker/WDAC)
      const utf8Prefix = 'try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{}; '
      const wrapper = `${utf8Prefix}$p = Start-Process -FilePath '${safeBin}' -ArgumentList 'run','-c','${safeCfg}' -Verb RunAs -WindowStyle Hidden -PassThru; $p.Id | Out-File -Encoding ascii '${pidFile}'; while ((Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) -and (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 2 }; Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue`

      let settled = false
      let pidPollInterval: ReturnType<typeof setInterval> | null = null
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        if (pidPollInterval) { clearInterval(pidPollInterval); pidPollInterval = null }
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null }
      }

      const settle = (ok: boolean, err?: string) => {
        if (settled) return
        settled = true
        cleanup()
        if (ok) {
          this._status = 'running'
          log.info('[sing-box] confirmed running via PID file (Windows)')
          resolve()
        } else {
          this._status = 'error'
          this._lastError = err || 'Failed to start sing-box'
          log.error(`[sing-box] startWithAdmin failed: ${err}`)
          reject(new Error(err))
        }
      }

      try {
        this.process = spawn('powershell', ['-NoProfile', '-Command', wrapper], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })

        // No timeout while waiting for UAC prompt — user can take as long as
        // needed. Once PID file appears, start a 15s timeout for process liveness.
        pidPollInterval = setInterval(() => {
          const pid = this.readPidFile()
          if (pid > 0) {
            if (this.isProcessAlive(pid)) {
              settle(true)
            } else {
              if (!timeoutTimer) {
                timeoutTimer = setTimeout(() => {
                  const retryPid = this.readPidFile()
                  if (retryPid > 0 && this.isProcessAlive(retryPid)) {
                    settle(true)
                  } else {
                    settle(false, 'sing-box exited immediately after start')
                  }
                }, 15000)
              }
            }
          }
        }, 300)

        this.process.on('exit', (code) => {
          this.process = null
          const pid = this.readPidFile()
          if (pid > 0 && this.isProcessAlive(pid)) {
            settle(true)
            return
          }
          if (!settled) {
            settle(false, code === 0 ? 'sing-box exited' : `PowerShell exited with code ${code}`)
          }
        })

        this.process.stderr?.on('data', (data: Buffer) => {
          const msg = data.toString().trim()
          if (msg) {
            this._lastError = msg
            log.warn(`[sing-box admin] ${msg}`)
          }
        })

      } catch (err) {
        settle(false, (err as Error).message)
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Cloudflare trace parser (connectivity probe helper)
// ---------------------------------------------------------------------------

/**
 * Single connectivity probe. Uses the shared keep-alive agent so that
 * subsequent probes reuse the TCP+TLS connection — measured latency then
 * reflects real-world usage (~200ms) instead of cold-start handshake
 * overhead (~1800ms).
 *
 * `wantBody=true` reads the response text (used for cloudflare trace);
 * otherwise we drain & discard the body so the connection can be reused.
 *
 * Redirects are NOT followed — a 301/302 still proves the network is
 * up, and we measure latency to first response, not the full chain.
 */
async function probeOne(
  url: string,
  timeoutMs: number,
  wantBody: boolean
): Promise<{ url: string; status: number; ms: number; trace?: string }> {
  const start = Date.now()
  const parsed = new URL(url)

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 443,
        path: parsed.pathname + parsed.search,
        method: wantBody ? 'GET' : 'HEAD',
        agent: probeAgent,
        timeout: timeoutMs,
      },
      (res) => {
        const ms = Date.now() - start
        const reused = !!(req as any).reusedSocket
        if (wantBody) {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => { body += chunk })
          res.on('end', () => {
            log.info(`[probe] ${parsed.hostname} → ${res.statusCode} ${ms}ms (reused=${reused})`)
            resolve({ url, status: res.statusCode!, ms, trace: body })
          })
          res.on('error', (err) => reject(err))
        } else {
          // Drain body so the keep-alive connection can be reused
          res.resume()
          res.on('end', () => {
            log.info(`[probe] ${parsed.hostname} → ${res.statusCode} ${ms}ms (reused=${reused})`)
            resolve({ url, status: res.statusCode!, ms })
          })
          res.on('error', (err) => reject(err))
        }
      },
    )

    req.on('timeout', () => {
      req.destroy(new Error(`probe ${parsed.hostname} timed out (${timeoutMs}ms)`))
    })
    req.on('error', (err) => reject(err))
    req.end()
  })
}

/**
 * Parse Cloudflare's `/cdn-cgi/trace` text response.
 *
 * Cloudflare returns a plain-text body like:
 *
 *   fl=abc123
 *   h=www.cloudflare.com
 *   ip=130.255.64.52
 *   ts=1712876543.123
 *   visit_scheme=https
 *   uag=curl/8.6.0
 *   colo=PRG
 *   sliver=none
 *   http=http/2
 *   loc=CZ
 *   tls=TLSv1.3
 *   sni=plaintext
 *   warp=off
 *   gateway=off
 *
 * We only need `ip=` and `loc=` (ISO 3166 country code). Returns a
 * partial object so callers can handle missing fields explicitly.
 */
function parseCloudflareTrace(body: string): { ip?: string; loc?: string; colo?: string } {
  const out: { ip?: string; loc?: string; colo?: string } = {}
  const lines = body.split(/\r?\n/)
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'ip') out.ip = value
    else if (key === 'loc') out.loc = value
    else if (key === 'colo') out.colo = value
  }
  return out
}
