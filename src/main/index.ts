import * as dns from 'dns'
// Force IPv4-first to prevent IPv6 bypassing TUN proxy
dns.setDefaultResultOrder('ipv4first')

import log from './logger'
import { app, BrowserWindow, ipcMain, shell, dialog, Menu, session, nativeImage, clipboard, Notification, powerSaveBlocker } from 'electron'
import { join, resolve, normalize, delimiter, sep } from 'path'
import { existsSync, mkdirSync, statSync } from 'fs'
import { execSync } from 'child_process'
import * as os from 'os'
import { PtyManager } from './pty/pty-manager'
import { buildCleanEnv, buildBasePath, DEFAULT_REGION_ENV } from './utils/clean-env'
import { PtyOutputMonitor, type PtyActivityEvent } from './pty/pty-output-monitor'
import { CliManager } from './cli/cli-manager'
import { ToolsManager } from './tools/tools-manager'
import { checkForAppUpdate, downloadAppUpdate, installAppUpdate, onUpdateStatus } from './updater'
import { Analytics } from './analytics'
import { ErrorReporter } from './error-reporter'
import { SessionRecorder } from './session/session-recorder'
import { SubscriptionManager } from './subscription/subscription-manager'
import { getSubscriptionApiBase, setSubscriptionApiBase } from './subscription/api-url'
import { BrowserSync } from './subscription/browser-sync'
import { getDeviceId } from './subscription/device-id'
import { fetchSubscription, detectRegion } from './proxy/subscription'
import { parseProxyUrl } from './proxy/sing-box-config'
import { buildFingerprintMaskScript, FINGERPRINT_PROFILES } from './browser/fingerprint-mask'
import { SingBoxManager } from './proxy/sing-box-manager'
import { StatsCollector } from './stats/stats-collector'
import { BrowserInterceptor } from './browser/browser-interceptor'
import { openBrowserWindow, openBrowserEmpty, closeAllBrowserWindows } from './browser/browser-window'
import { ChatStore } from './chat/chat-store'
import { ChatManager } from './chat/chat-manager'
import { registerChatIPC, unregisterChatIPC } from './chat/chat-ipc'

// Disable IPv6 in Chromium to prevent IPv6 traffic bypassing TUN proxy
app.commandLine.appendSwitch('disable-ipv6')
// Set Chromium locale to en-US — prevents Chinese locale leaking through internal pages
// Per-window locale is further refined via JS injection based on actual region
app.commandLine.appendSwitch('lang', 'en-US')

process.on('uncaughtException', (err) => log.error('Uncaught:', err))
process.on('unhandledRejection', (reason) => log.error('Unhandled:', reason))

/**
 * E2E test mock mode. When INKESS_MOCK_MODE=true, subscription/TUN/CLI
 * IPC handlers return mock responses so Playwright tests can reach the
 * terminal and chat UI without real login or network proxy.
 *
 * NEVER set in production — only via E2E test harness env vars.
 */
const MOCK_MODE = process.env.INKESS_MOCK_MODE === 'true'
if (MOCK_MODE) log.info('[startup] MOCK_MODE enabled — IPC handlers will return mock data')

let mainWindow: BrowserWindow | null = null
const ptyManager = new PtyManager()
const ptyMonitor = new PtyOutputMonitor()
const cliManager = new CliManager('claude')
const codexManager = new CliManager('codex')
const cliManagers = { claude: cliManager, codex: codexManager } as const
type CliEngine = keyof typeof cliManagers
function pickCliManager(engine: unknown): CliManager {
  return engine === 'codex' ? codexManager : cliManager
}
const chatStore = new ChatStore(app.getPath('userData'), '')  // cliVersion patched after app-ready
let chatManager: ChatManager | null = null
const toolsManager = new ToolsManager()
const analytics = new Analytics()
const errorReporter = new ErrorReporter()
const sessionRecorder = new SessionRecorder()
const subscriptionManager = new SubscriptionManager()
const browserSync = new BrowserSync()
// Initialize BrowserSync from existing session (app restart path — no login IPC).
// Fire-and-forget here is acceptable: the download runs during module init, well
// before the window is created → renderer loaded → TunGate → browser opens
// (5-10s gap minimum). The login path (subscription:login IPC handler) is the
// critical one where we DO await the download — see that handler below.
{
  const existingSession = subscriptionManager.getSession()
  if (existingSession?.username && existingSession?.token) {
    browserSync.downloadAndImportCookies(existingSession.username, existingSession.token).catch(err =>
      log.warn('[startup] browser sync init failed:', err)
    )
  }
}
errorReporter.setTokenGetter(() => subscriptionManager.getSession()?.token ?? null)
errorReporter.setUsernameGetter(() => subscriptionManager.getUsername())
const singBoxManager = new SingBoxManager()
// Clean up any stale tunnel processes from previous crashes
singBoxManager.cleanupStaleProcesses().catch(err => {
  log.warn('[startup] Failed to clean up stale tunnel processes:', err)
})
// Forward tunnel status updates to renderer for the StatusBar network
// indicator. This fires on startTun success, stop, and every connectivity
// test — the renderer uses it to keep its cached latency / exit IP fresh.
singBoxManager.onStatus((update) => {
  safeSend('tun:statusUpdate', update)
})
const statsCollector = new StatsCollector()
const browserInterceptor = new BrowserInterceptor()

/** Safely send to renderer, swallowing errors if window is destroyed */
function safeSend(channel: string, ...args: unknown[]): void {
  try {
    mainWindow?.webContents.send(channel, ...args)
  } catch {
    // Window may be destroyed during long-running operations
  }
}

/** Validate that a path is an existing directory (guards pty:create and git:getBranch) */
function isValidDirectory(path: string): boolean {
  try {
    const resolved = resolve(normalize(path))
    return existsSync(resolved) && statSync(resolved).isDirectory()
  } catch {
    return false
  }
}

function createWindow(): void {
  // Set dock/taskbar icon (especially needed in dev mode)
  if (process.platform === 'darwin') {
    const iconPath = join(__dirname, '../../resources/icon-512.png')
    try {
      const icon = nativeImage.createFromPath(iconPath)
      if (!icon.isEmpty()) app.dock?.setIcon(icon)
    } catch { /* icon file may not exist in some builds */ }
  }

  mainWindow = new BrowserWindow({
    title: 'Inkess Code',
    width: 1100,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    backgroundColor: '#191919',
    icon: join(__dirname, '../../resources/icon-256.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--platform=${process.platform}`,
        `--homedir=${os.homedir()}`
      ]
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    log.info('Loading renderer URL:', process.env.ELECTRON_RENDERER_URL)
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    const filePath = join(__dirname, '../renderer/index.html')
    log.info('Loading renderer file:', filePath)
    mainWindow.loadFile(filePath)
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log.error(`Renderer failed to load: ${errorCode} ${errorDescription} URL: ${validatedURL}`)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    log.info('Renderer finished loading')
  })

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) {
      log.warn(`[Renderer Console] ${message}`)
    } else {
      log.info(`[R] ${message}`)
    }
  })

  // Prevent Electron from navigating to file:// URLs on drag & drop
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('focus', () => { isWindowFocused = true })
  mainWindow.on('blur', () => { isWindowFocused = false })
}

// IPC: CLI Manager
//
// IPC handlers accept an optional `engine: 'claude' | 'codex'` parameter
// (defaults to 'claude' for backward compatibility with existing callers).
ipcMain.handle('cli:getInfo', (_event, engine?: CliEngine) => {
  if (MOCK_MODE) return { installed: true, path: '/usr/bin/claude', version: '2.1.98', engine: engine || 'claude' }
  return pickCliManager(engine).getInfo()
})

ipcMain.handle('cli:install', async (_event, engine?: CliEngine) => {
  const mgr = pickCliManager(engine)
  try {
    await mgr.install((step, progress) => {
      safeSend('cli:installProgress', { step, progress, engine: mgr.engine })
    })
    analytics.track('cli_install', { engine: mgr.engine })
    statsCollector.logEvent('cli:install')
    return { success: true }
  } catch (err) {
    log.error(`CLI[${mgr.engine}] install failed:`, err)
    return { success: false, error: (err as Error).message }
  }
})

ipcMain.handle('cli:listVersions', async (_event, engine?: CliEngine) => {
  return pickCliManager(engine).listVersions()
})

ipcMain.handle('cli:installVersion', async (_event, version: string, engine?: CliEngine) => {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    return { success: false, error: 'Invalid version format' }
  }
  const mgr = pickCliManager(engine)
  try {
    await mgr.installVersion(version, (step, progress) => {
      safeSend('cli:installProgress', { step, progress, engine: mgr.engine })
    })
    analytics.track('cli_switch_version', { version, engine: mgr.engine })
    statsCollector.logEvent('cli:installVersion')
    return { success: true }
  } catch (err) {
    log.error(`CLI[${mgr.engine}] installVersion failed:`, err)
    return { success: false, error: (err as Error).message }
  }
})

// IPC: Tools Manager
ipcMain.handle('tools:getInfo', () => {
  return toolsManager.getInfo()
})

ipcMain.handle('tools:isAllInstalled', () => {
  if (MOCK_MODE) return true
  return toolsManager.isAllInstalled()
})

ipcMain.handle('tools:install', async () => {
  try {
    await toolsManager.install((step, progress) => {
      safeSend('tools:installProgress', { step, progress })
    })
    analytics.track('tools_install')
    return { success: true }
  } catch (err) {
    log.error('Tools install failed:', err)
    return { success: false, error: (err as Error).message }
  }
})

// IPC: Subscription
ipcMain.handle('subscription:getApiBase', () => getSubscriptionApiBase())

ipcMain.handle('subscription:setApiBase', (_event, base: unknown) => {
  if (base !== null && base !== undefined && typeof base !== 'string') {
    return { success: false, error: 'Invalid input' }
  }
  if (typeof base === 'string' && base.length > 200) {
    return { success: false, error: 'Server URL too long' }
  }
  try {
    setSubscriptionApiBase(typeof base === 'string' ? base : null)
    return { success: true, base: getSubscriptionApiBase() }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
})

ipcMain.handle('subscription:login', async (_event, args: unknown) => {
  const { username, password } = (args || {}) as Record<string, unknown>
  if (typeof username !== 'string' || typeof password !== 'string') {
    return { success: false, error: 'Invalid input' }
  }
  if (username.length === 0 || username.length > 50 || password.length === 0 || password.length > 200) {
    return { success: false, error: 'Invalid input length' }
  }
  const result = await subscriptionManager.login(username, password)
  if (!result.success) {
    errorReporter.reportBizError('login', result.error || 'Unknown login error', {
      username,
      deviceId: getDeviceId(),
      errorCode: result.errorCode,
    })
  } else {
    // Download and import browser cookies BEFORE returning to renderer.
    // Awaited (not fire-and-forget) to guarantee cookies are in the
    // Electron session partition before TunGate finishes and opens the
    // browser. Without this barrier, a slow API response + fast TUN
    // startup could open the browser before cookies are imported,
    // leaving the user in a logged-out state on the new device.
    // The API is on the China server — no TUN needed.
    const session = subscriptionManager.getSession()
    if (session?.username && session?.token) {
      try {
        await browserSync.downloadAndImportCookies(session.username, session.token)
      } catch (err) {
        log.warn('[subscription:login] browser sync download failed:', err)
      }
    }
  }
  return result
})

ipcMain.handle('subscription:checkStatus', async () => {
  if (MOCK_MODE) return {
    status: 'active', plan: 'monthly',
    expiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
    daysRemaining: 30, proxyUrl: 'socks5://127.0.0.1:1080',
    proxyRegion: 'us', exitIp: '1.2.3.4',
  }
  return subscriptionManager.checkStatus()
})

ipcMain.handle('subscription:getSession', () => {
  if (MOCK_MODE) return {
    isLoggedIn: true, username: 'e2e-test',
    session: {
      plan: 'monthly',
      expiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
      proxyUrl: 'socks5://127.0.0.1:1080', tunnelUrl: '',
      proxyRegion: 'us', exitIp: '1.2.3.4',
    },
  }
  const s = subscriptionManager.getSession()
  return {
    isLoggedIn: subscriptionManager.isLoggedIn(),
    username: subscriptionManager.getUsername(),
    session: s ? {
      plan: s.plan,
      expiresAt: s.expiresAt,
      proxyUrl: s.proxyUrl,
      tunnelUrl: s.tunnelUrl || '',
      proxyRegion: s.proxyRegion,
      exitIp: s.exitIp || '',
    } : null,
  }
})

ipcMain.handle('browserSync:startPeriodicUpload', () => {
  browserSync.startPeriodicUpload()
})

ipcMain.handle('subscription:logout', async () => {
  const username = subscriptionManager.getUsername() || 'default'
  browserSync.stop()
  subscriptionManager.logout()
  claudeCredentials = null
  // Clear this account's browser sessions + login session
  const { session: electronSession } = require('electron') as typeof import('electron')
  try {
    await electronSession.fromPartition(`persist:claude-${username}`).clearStorageData()
    await electronSession.fromPartition(`persist:browser-${username}`).clearStorageData()
    await electronSession.fromPartition('persist:claude-login').clearStorageData().catch(() => {})
  } catch { /* ignore */ }
})

// IPC: Auto-login Claude via browser
ipcMain.handle('subscription:autoLoginClaude', async (_event, args: unknown) => {
  const { email, password } = (args || {}) as Record<string, unknown>
  if (typeof email !== 'string' || typeof password !== 'string' ||
      email.length === 0 || email.length > 300 || password.length === 0 || password.length > 500) {
    return { success: false, error: 'Invalid credentials format' }
  }
  const { session: electronSession } = require('electron') as typeof import('electron')
  const regionEnv = proxySettings.enabled ? (REGION_ENV[proxySettings.region] || {}) : {}
  const lang = regionEnv.LANG?.split('.')[0]?.replace('_', '-') || 'en-US'

  // Use separate partition for auto-login — shared persist:claude would mutate
  // UA and proxy settings, interfering with any open built-in browser windows
  const loginSession = electronSession.fromPartition('persist:claude-login')

  // In TUN mode, don't set session proxy (traffic goes through TUN)
  const tunInfo = singBoxManager.getInfo()
  if (!tunInfo.tunRunning && proxySettings.enabled && proxySettings.url) {
    await loginSession.setProxy({ proxyRules: proxySettings.url })
  }

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Claude Login',
    icon: join(__dirname, '../../resources/icon-256.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: loginSession,
    }
  })

  // === Full browser hardening (same as built-in browser) ===
  // WebRTC IP leak prevention
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')

  // User-Agent: strip Electron/app identifiers
  const cleanUA = win.webContents.getUserAgent()
    .replace(/\s*Electron\/\S+/g, '')
    .replace(/\s*inkess-code\/\S+/g, '')
  win.webContents.setUserAgent(cleanUA)

  // Accept-Language + Client Hints headers
  const acceptLang = lang.includes('-') ? `${lang},${lang.split('-')[0]};q=0.9` : `${lang};q=0.9`
  loginSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith('sec-ch-')) delete headers[key]
    }
    headers['Accept-Language'] = acceptLang
    callback({ requestHeaders: headers })
  })

  // Fingerprint masking (canvas/WebGL/audio/timezone/locale)
  const fpProfile = FINGERPRINT_PROFILES[proxySettings.region] || FINGERPRINT_PROFILES.default
  const fpScript = buildFingerprintMaskScript(fpProfile)

  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript(fpScript).catch(() => {})
    // navigator.language/languages injection
    if (regionEnv.LANG) {
      const safeLang = JSON.stringify(lang)
      win.webContents.executeJavaScript(`
        Object.defineProperty(navigator, 'language', { get: () => ${safeLang} });
        Object.defineProperty(navigator, 'languages', { get: () => [${safeLang}, 'en'] });
      `).catch(() => {})
    }
  })

  // Auto-fill login form when page loads
  win.webContents.on('did-finish-load', () => {
    const url = win.webContents.getURL()
    if (url.includes('claude.ai/login') || url.includes('clerk') || url.includes('accounts.anthropic.com')) {
      win.webContents.executeJavaScript(claudeAutoFillScript(email, password)).catch(() => {})
    }
  })

  win.loadURL('https://claude.ai/login')

  // Auto-close browser and notify renderer when login succeeds
  let loginSucceeded = false
  win.webContents.on('did-navigate', (_event, url) => {
    if (url.includes('claude.ai') && !url.includes('login') && !url.includes('accounts')) {
      loginSucceeded = true
      safeSend('subscription:claudeLoginSuccess')
      setTimeout(() => {
        try { if (!win.isDestroyed()) win.close() } catch { /* ignore */ }
      }, 2000)
    }
  })

  // Notify renderer if window is closed without successful login
  win.on('closed', () => {
    if (!loginSucceeded) {
      safeSend('subscription:claudeLoginFailed')
    }
  })

  return { success: true }
})

// IPC: TUN proxy (sing-box)
ipcMain.handle('tun:getInfo', () => {
  if (MOCK_MODE) return {
    mode: 'mock', tunRunning: true, installed: true,
    lastError: null, internetReachable: true, latencyMs: 42,
  }
  return singBoxManager.getInfo()
})

ipcMain.handle('tun:install', async () => {
  try {
    await singBoxManager.install((step, pct) => {
      safeSend('tun:installProgress', { step, pct })
    })
    return { success: true }
  } catch (err) {
    const error = (err as Error).message
    errorReporter.reportBizError('tun_install', error, {
      username: subscriptionManager.getUsername() || undefined,
      deviceId: getDeviceId(),
    })
    return { success: false, error }
  }
})

/**
 * Quick probe: can we reach the internet through this SOCKS5/HTTP proxy
 * directly (no tunnel)? Runs BEFORE TUN starts, so the probe uses the
 * normal physical interface — no routing conflict with sing-box.
 *
 * Uses curl because Node's fetch doesn't support SOCKS5 proxy natively.
 * Timeout is aggressive (8s) — we're just checking if the TCP path works,
 * not benchmarking. Returns true if cloudflare trace returns HTTP 200.
 */
async function probeDirectProxy(proxyUrl: string): Promise<boolean> {
  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const exec = promisify(execFile)
    const { stdout } = await exec('curl', [
      '-sS', '--proxy', proxyUrl,
      '--max-time', '8',
      '-o', '/dev/null',
      '-w', '%{http_code}',
      'https://www.cloudflare.com/cdn-cgi/trace',
    ], { timeout: 10000 })
    const ok = stdout.trim() === '200'
    log.info(`[probeDirectProxy] HTTP ${stdout.trim()} → ${ok ? 'OK' : 'FAIL'}`)
    return ok
  } catch (err) {
    log.info(`[probeDirectProxy] error: ${(err as Error).message}`)
    return false
  }
}

/**
 * Shared startup flow used by both tun:startTun and tun:reconnect IPC
 * handlers. Validates the proxy URL, resolves the tunnel subscription (if
 * any), picks the best tunnel node, and starts sing-box. Throws on failure
 * so callers can do their own error reporting / IPC return value.
 */
async function startTunInternal(proxyUrl: string, tunnelUrl?: string): Promise<void> {
  if (typeof proxyUrl !== 'string' || proxyUrl.length > 500 || proxyUrl.length < 5) {
    log.error(`[startTun] invalid proxy URL (len=${proxyUrl?.length})`)
    throw new Error('Invalid proxy URL')
  }
  log.info(`[startTun] url: ${proxyUrl?.replace(/:\/\/.*@/, '://***@').replace(/:\/\/([^/]+)/, '://***.***:***')}`)
  if (tunnelUrl) log.info(`[startTun] tunnelUrl: ${tunnelUrl.slice(0, 50)}...`)

  // Resolve tunnel subscription → pick best node
  let tunnelOutbound: import('./proxy/sing-box-config').SingBoxOutbound | undefined
  if (tunnelUrl && typeof tunnelUrl === 'string' && tunnelUrl.length > 5) {
    try {
      log.info(`[startTun] fetching tunnel subscription...`)
      const nodes = await fetchSubscription(tunnelUrl)
      const tunnelNode = nodes.find(n => n.type === 'hysteria2')
        || nodes.find(n => n.type === 'vless')
        || nodes.find(n => n.type === 'trojan')
        || nodes.find(n => n.type === 'ss')
      if (tunnelNode) {
        tunnelOutbound = parseProxyUrl(tunnelNode.raw || tunnelNode.url)
        log.info(`[startTun] tunnel node: ${tunnelNode.name} (${tunnelNode.type}, ${tunnelNode.server})`)
      } else {
        log.warn(`[startTun] no usable tunnel node found in ${nodes.length} nodes`)
      }
    } catch (tunnelErr) {
      log.error(`[startTun] tunnel subscription failed:`, (tunnelErr as Error).message)
    }
  }

  // ─── Smart tunnel fallback ───────────────────────────────────────
  // When a tunnel is available, try direct SOCKS5 first (faster, lower
  // latency). Only fall back to the chain (tunnel → SOCKS5) if direct
  // fails. This probe runs BEFORE TUN starts, so it uses the normal
  // physical interface — no routing conflict.
  //
  // Direct SOCKS5 is ~600ms warm RTT vs chain ~700-2000ms with high
  // variance. The tunnel exists solely as GFW protection; when GFW
  // isn't interfering, it's pure overhead.
  if (tunnelOutbound) {
    log.info(`[startTun] smart fallback: probing direct SOCKS5 before deciding mode...`)
    const directOk = await probeDirectProxy(proxyUrl)
    if (directOk) {
      log.info(`[startTun] direct SOCKS5 works → skipping tunnel (faster)`)
      singBoxManager.setTunnelOutbound(undefined)
    } else {
      log.info(`[startTun] direct SOCKS5 failed → using tunnel (GFW protection)`)
      singBoxManager.setTunnelOutbound(tunnelOutbound)
    }
  } else {
    singBoxManager.setTunnelOutbound(undefined)
  }

  await singBoxManager.startTun(proxyUrl)
  log.info(`[startTun] success`)
  statsCollector.logEvent('tun:start')

  // Start interface monitor — alert renderer if external VPN detected
  singBoxManager.startInterfaceMonitor((newInterfaces) => {
    log.warn(`[startTun] external TUN detected: ${newInterfaces.join(', ')}`)
    safeSend('tun:interfaceAlert', { interfaces: newInterfaces })
  })
}

ipcMain.handle('tun:startTun', async (_event, proxyUrl: string, tunnelUrl?: string) => {
  if (MOCK_MODE) return { success: true }
  proxyUrl = typeof proxyUrl === 'string' ? proxyUrl.trim() : proxyUrl
  try {
    await startTunInternal(proxyUrl, tunnelUrl)
    return { success: true }
  } catch (err) {
    log.error(`[startTun] error:`, err)
    const error = (err as Error).message
    errorReporter.reportBizError('tun_start', error, {
      username: subscriptionManager.getUsername() || undefined,
      deviceId: getDeviceId(),
      proxyUrl: proxyUrl?.replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:***@'),
      singboxLog: singBoxManager.readRecentLog(),
    })
    return { success: false, error }
  }
})

ipcMain.handle('tun:reconnect', async () => {
  // Manual user-triggered reconnect: stop the running tunnel, then restart
  // from the current subscription session. Reuses startTunInternal so
  // tunnel subscriptions are re-fetched (picks up any node changes) and
  // the interface monitor is re-armed.
  const session = subscriptionManager.getSession()
  if (!session?.proxyUrl) {
    return { success: false, error: 'No active subscription session' }
  }
  log.info('[reconnect] manual reconnect requested')
  try {
    // stop(false) = skip DNS restore; we're about to re-hijack immediately
    await singBoxManager.stop(false)
    await startTunInternal(session.proxyUrl, session.tunnelUrl)
    log.info('[reconnect] success')
    return { success: true }
  } catch (err) {
    log.error('[reconnect] failed:', err)
    const error = (err as Error).message
    errorReporter.reportBizError('tun_start', `reconnect: ${error}`, {
      username: subscriptionManager.getUsername() || undefined,
      deviceId: getDeviceId(),
      proxyUrl: session.proxyUrl.replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:***@'),
      singboxLog: singBoxManager.readRecentLog(),
    })
    return { success: false, error }
  }
})

ipcMain.handle('tun:stop', async () => {
  await singBoxManager.stop()
  statsCollector.logEvent('tun:stop')
  // Close all browser windows when TUN stops
  closeAllBrowserWindows()
  return { success: true }
})

ipcMain.handle('tun:clearAuthCooldown', () => {
  singBoxManager.clearAuthDenyCooldown()
})

ipcMain.handle('tun:testConnectivity', async (_event, exitIp?: string) => {
  if (MOCK_MODE) return { success: true, latency: 42, actualIp: '1.2.3.4' }
  const result = await singBoxManager.testConnectivity(exitIp)
  if (!result.success) {
    errorReporter.reportBizError('tun_connectivity', result.error || 'Connectivity test failed', {
      username: subscriptionManager.getUsername() || undefined,
      deviceId: getDeviceId(),
      expectedIp: exitIp,
      actualIp: result.actualIp,
      singboxLog: singBoxManager.readRecentLog(),
    })
  }
  return result
})

ipcMain.handle('tun:diagnostics', async () => {
  return singBoxManager.runDiagnostics()
})

// IPC: Proxy settings (stored in main process, applied to PTY env on create)
interface ProxySettings {
  enabled: boolean
  url: string
  region: string
}

let proxySettings: ProxySettings = { enabled: false, url: '', region: 'us' }

// Claude credentials — in-memory only, never persisted to disk
let claudeCredentials: { email: string; password: string } | null = null

/** Region → environment variable overrides (timezone, locale, LC_CTYPE) */
const REGION_ENV: Record<string, Record<string, string>> = {
  us:   { TZ: 'America/New_York',    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' },
  usw:  { TZ: 'America/Los_Angeles', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' },
  gb:   { TZ: 'Europe/London',       LANG: 'en_GB.UTF-8', LC_ALL: 'en_GB.UTF-8', LC_CTYPE: 'en_GB.UTF-8' },
  de:   { TZ: 'Europe/Berlin',       LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8', LC_CTYPE: 'de_DE.UTF-8' },
  jp:   { TZ: 'Asia/Tokyo',          LANG: 'ja_JP.UTF-8', LC_ALL: 'ja_JP.UTF-8', LC_CTYPE: 'ja_JP.UTF-8' },
  kr:   { TZ: 'Asia/Seoul',          LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', LC_CTYPE: 'ko_KR.UTF-8' },
  sg:   { TZ: 'Asia/Singapore',      LANG: 'en_SG.UTF-8', LC_ALL: 'en_SG.UTF-8', LC_CTYPE: 'en_SG.UTF-8' },
  hk:   { TZ: 'Asia/Hong_Kong',      LANG: 'en_HK.UTF-8', LC_ALL: 'en_HK.UTF-8', LC_CTYPE: 'en_HK.UTF-8' },
  tw:   { TZ: 'Asia/Taipei',         LANG: 'zh_TW.UTF-8', LC_ALL: 'zh_TW.UTF-8', LC_CTYPE: 'zh_TW.UTF-8' },
  au:   { TZ: 'Australia/Sydney',    LANG: 'en_AU.UTF-8', LC_ALL: 'en_AU.UTF-8', LC_CTYPE: 'en_AU.UTF-8' },
  auto: {}, // no override — use real system locale
}

/** Validate and sanitize proxy settings from renderer */
function validateProxySettings(input: unknown): ProxySettings {
  const s = input as Record<string, unknown>
  return {
    enabled: typeof s?.enabled === 'boolean' ? s.enabled : false,
    url: typeof s?.url === 'string' ? s.url.slice(0, 500) : '',
    region: typeof s?.region === 'string' && s.region in REGION_ENV ? s.region : 'us',
  }
}

/** Build env vars from proxy URL — supports http, https, socks4, socks5 (with auth) */
function buildProxyEnv(url: string): Record<string, string> {
  if (!url) return {}
  const env: Record<string, string> = {}
  const lower = url.toLowerCase()
  if (lower.startsWith('socks5://') || lower.startsWith('socks4://') || lower.startsWith('socks://')) {
    // SOCKS proxies: use ALL_PROXY (recognized by curl, git, many CLI tools)
    env.ALL_PROXY = url
    env.all_proxy = url
    // Also set HTTP(S)_PROXY for tools that don't support ALL_PROXY
    env.HTTP_PROXY = url
    env.HTTPS_PROXY = url
    env.http_proxy = url
    env.https_proxy = url
  } else {
    // HTTP/HTTPS proxies
    env.HTTP_PROXY = url
    env.HTTPS_PROXY = url
    env.http_proxy = url
    env.https_proxy = url
  }
  return env
}

ipcMain.handle('proxy:getSettings', () => proxySettings)

ipcMain.handle('proxy:fetchSubscription', async (_event, url: string) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { success: false, error: 'Only http/https URLs are supported', nodes: [] }
  }
  try {
    const nodes = await fetchSubscription(url)
    return { success: true, nodes }
  } catch (err) {
    return { success: false, error: (err as Error).message, nodes: [] }
  }
})

// Resolve proxy URL: if it's a subscription URL (https://), fetch and return first usable node
const ALLOWED_PROXY_PROTOCOLS = ['socks5:', 'socks:', 'http:', 'https:']
ipcMain.handle('proxy:resolveUrl', async (_event, url: string) => {
  log.info(`[resolveUrl] input: ${url?.replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:***@').substring(0, 80)}...`)
  if (typeof url !== 'string' || !url) return { resolved: url, isSubscription: false }

  // Distinguish proxy URL from subscription URL:
  // - Proxy URL: socks5://..., http://user:pass@host:port (has userinfo or non-http protocol)
  // - Subscription URL: https://panel.xxx/api/sub/... (no userinfo, https)
  const isDirectProxy = !/^https?:\/\//i.test(url) || (() => {
    try { return !!new URL(url).username } catch { return false }
  })()

  if (isDirectProxy) {
    try {
      const proto = new URL(url).protocol
      if (!ALLOWED_PROXY_PROTOCOLS.includes(proto)) {
        log.warn(`[resolveUrl] unsupported protocol: ${proto}`)
        return { resolved: '', isSubscription: false, error: `Unsupported proxy protocol: ${proto} (only SOCKS5/HTTP supported)` }
      }
    } catch {
      // Not a valid URL — could be host:port, let it pass
    }
    log.info(`[resolveUrl] direct proxy URL, using directly`)
    return { resolved: url, isSubscription: false }
  }

  // Subscription URL — fetch and filter usable nodes only
  try {
    const nodes = await fetchSubscription(url)
    log.info(`[resolveUrl] fetched ${nodes.length} nodes: ${nodes.map(n => `${n.name}(${n.type}, usable=${n.usable})`).join(', ')}`)
    if (!nodes.length) return { resolved: '', isSubscription: true, error: 'No nodes found in subscription' }

    // Only use nodes marked as usable (socks5/http/https)
    const usableNodes = nodes.filter(n => n.usable && n.url)
    if (!usableNodes.length) {
      const types = [...new Set(nodes.map(n => n.type))].join(', ')
      return { resolved: '', isSubscription: true, error: `No SOCKS5/HTTP nodes in subscription (found: ${types})` }
    }

    const node = usableNodes[0]
    const resolved = node.url
    log.info(`[resolveUrl] picked node: ${node.name}, resolved: ${resolved?.substring(0, 80)}`)

    const detected = detectRegion(node.name)
    log.info(`[resolveUrl] detected region: ${detected.region} (${detected.flag}) from "${node.name}"`)
    return { resolved, isSubscription: true, nodeName: node.name, nodeCount: nodes.length, detectedRegion: detected.region }
  } catch (err) {
    log.error(`[resolveUrl] error:`, err)
    return { resolved: '', isSubscription: true, error: (err as Error).message }
  }
})

ipcMain.handle('proxy:updateSettings', (_event, settings: unknown) => {
  proxySettings = validateProxySettings(settings)
  safeSend('proxy:settingsChanged', proxySettings)
})

// IPC: PTY — supports launching claude directly
ipcMain.handle('pty:create', (_event, options: {
  cwd: string
  env?: Record<string, string>
  launchClaude?: boolean
}) => {
  try {
    log.info(`[pty:create] cwd=${options.cwd} launchClaude=${options.launchClaude}`)
    // Validate cwd exists and is a directory
    if (!isValidDirectory(options.cwd)) {
      log.error(`[pty:create] invalid cwd: ${options.cwd}`)
      return { error: `Directory does not exist: ${options.cwd}` }
    }

    let command: string | undefined
    let args: string[] = []

    if (options.launchClaude && cliManager.isInstalled()) {
      command = cliManager.getBinaryPath()
    }

    // --- Build clean PTY environment from scratch (whitelist approach) ---
    const toolsEnv = toolsManager.getEnvPatch()
    const claudeConfigDir = join(app.getPath('userData'), 'claude-config')
    const codexConfigDir = join(app.getPath('userData'), 'codex-config')
    mkdirSync(claudeConfigDir, { recursive: true })
    mkdirSync(codexConfigDir, { recursive: true })

    // Region overrides (TZ, LANG, LC_*) based on exit IP
    const regionOverrides = proxySettings.enabled ? (REGION_ENV[proxySettings.region] || {}) : {}

    const tunInfo = singBoxManager.getInfo()
    // TUN mode: no proxy env needed (TUN captures all traffic at network level)
    // Non-TUN mode: set HTTP_PROXY env for PTY processes
    const proxyEnv = proxySettings.enabled && !tunInfo.tunRunning
      ? buildProxyEnv(proxySettings.url)
      : {}

    // Browser interceptor env (BROWSER, INKESS_BROWSER_SOCK, ZDOTDIR)
    const interceptorEnv = browserInterceptor.getEnv()
    const binDir = browserInterceptor.getBinDir()
    const existingPath = toolsEnv.PATH || buildBasePath()
    // PATH for `claude` and `codex` commands inside the terminal: each engine's
    // active version lives at {userData}/cli/{engine}/{ver}/{binary}. The CLI
    // dir itself contains the binary directly (no bin/ subdir), so we add the
    // version dir of whichever version is active.
    const engineBinDirs: string[] = []
    for (const mgr of [cliManager, codexManager]) {
      const info = mgr.getInfo()
      if (info.installed && info.path) {
        const dir = info.path.substring(0, Math.max(info.path.lastIndexOf('/'), info.path.lastIndexOf('\\')))
        if (dir) engineBinDirs.push(dir)
      }
    }
    const cliPathPrefix = engineBinDirs.length > 0 ? engineBinDirs.join(delimiter) + delimiter : ''

    // Encode region vars for zdotdir .zshrc to re-apply after user's .zshrc
    const regionEnvStr = Object.entries({ ...DEFAULT_REGION_ENV, ...regionOverrides })
      .filter(([k]) => ['TZ', 'LANG', 'LC_ALL', 'LC_CTYPE'].includes(k))
      .map(([k, v]) => `${k}=${v}`).join('|')

    // Filter dangerous env vars from renderer-supplied options.env
    const BLOCKED_ENV_KEYS = new Set([
      'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
      'GIT_PROXY_COMMAND', 'GIT_SSH_COMMAND', 'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE', 'ZDOTDIR', 'SHELL', 'HOME',
      'PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
    ])
    const safeEnv: Record<string, string> = {}
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        if (!BLOCKED_ENV_KEYS.has(k) && typeof v === 'string') safeEnv[k] = v
      }
    }

    // Build from scratch: clean base + region + tools + interceptor + caller
    const ptyEnv = buildCleanEnv(regionOverrides, {
      ...toolsEnv,
      ...proxyEnv,
      ...interceptorEnv,
      ...safeEnv,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      CODEX_HOME: codexConfigDir,
      __INKESS_CLAUDE_CONFIG_DIR: claudeConfigDir,
      __INKESS_CODEX_HOME: codexConfigDir,
      __INKESS_REGION_ENV: regionEnvStr,
      // Engine bin dirs the ZDOTDIR .zshrc re-prepends after path_helper. Use
      // the platform PATH delimiter (':' on POSIX) — the .zshrc only runs on macOS.
      __INKESS_ENGINE_BIN_DIRS: engineBinDirs.join(delimiter),
      PATH: `${binDir}${delimiter}${cliPathPrefix}${existingPath}`,
    })

    const id = ptyManager.create(options.cwd, ptyEnv, command, args)
    ptyMonitor.watch(id)
    const title = options.cwd.replace(/\\/g, '/').split('/').pop() || 'terminal'
    sessionRecorder.startSession(id, options.cwd, title)
    statsCollector.sessionStart(id, options.cwd)
    statsCollector.logEvent('tab:create', options.cwd)
    ptyManager.onData(id, (data) => {
      safeSend('pty:data', { id, data })
      ptyMonitor.feed(id, data)
      sessionRecorder.recordData(id, data)
    })
    ptyManager.onExit(id, (exitCode) => {
      safeSend('pty:exit', { id, exitCode })
      ptyMonitor.unwatch(id)
      sessionRecorder.closeSession(id)
    })
    analytics.track('tab_create')
    return { id }
  } catch (err) {
    log.error('pty:create failed:', err)
    return { error: (err as Error).message }
  }
})

ipcMain.on('pty:write', (_event, payload) => {
  if (!payload || typeof payload.id !== 'string' || typeof payload.data !== 'string') return
  ptyManager.write(payload.id, payload.data)
  // sessionRecorder.recordInput removed: do not record keystrokes for security
})

ipcMain.on('pty:resize', (_event, payload) => {
  if (!payload || typeof payload.id !== 'string') return
  ptyManager.resize(payload.id, payload.cols, payload.rows)
})

ipcMain.on('pty:kill', (_event, payload: unknown) => {
  const { id } = (payload || {}) as { id?: string }
  if (typeof id !== 'string') return
  ptyManager.kill(id)
  statsCollector.sessionClose(id)
  statsCollector.logEvent('tab:close', id)
  analytics.track('tab_close')
})

ipcMain.handle('pty:killAll', () => {
  ptyManager.killAll()
})

// IPC: Shell actions
ipcMain.handle('shell:openExternal', (_event, url: string) => {
  if (!/^https?:\/\//i.test(url)) {
    log.warn(`Blocked openExternal with non-http URL: ${url}`)
    return
  }
  return shell.openExternal(url)
})

ipcMain.handle('shell:openPath', (_event, path: string) => {
  const normalized = normalize(resolve(path))
  const home = os.homedir()
  const homePrefixed = home + sep
  if (!normalized.startsWith(homePrefixed) && normalized !== home) {
    log.warn(`Blocked openPath outside home: ${normalized}`)
    return
  }
  return shell.openPath(normalized)
})

ipcMain.handle('shell:showItemInFolder', (_event, path: string) => {
  const normalized = normalize(resolve(path))
  const home = os.homedir()
  const homePrefixed = home + sep
  if (!normalized.startsWith(homePrefixed) && normalized !== home) {
    log.warn(`Blocked showItemInFolder outside home: ${normalized}`)
    return
  }
  shell.showItemInFolder(normalized)
})

ipcMain.handle('shell:selectDirectory', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})

// IPC: Stats
ipcMain.handle('stats:getSummary', () => statsCollector.getSummary())
ipcMain.handle('stats:getEvents', () => statsCollector.getEvents())
ipcMain.handle('stats:getSessions', () => statsCollector.getSessions())
ipcMain.handle('stats:getLatency', () => statsCollector.getLatency())
ipcMain.handle('stats:getSystemLog', () => statsCollector.getSystemLog())
ipcMain.handle('stats:getStorageSize', () => statsCollector.getStorageSize())
ipcMain.handle('stats:clear', () => { statsCollector.clearAll(); return { success: true } })

// IPC: Claude credentials (in-memory only)
ipcMain.handle('claude:setCredentials', (_event, args: unknown) => {
  const { email, password } = (args || {}) as Record<string, unknown>
  if (typeof email === 'string' && typeof password === 'string' &&
      email.length > 0 && email.length <= 300 && password.length > 0 && password.length <= 500) {
    claudeCredentials = { email, password }
  }
})
ipcMain.handle('claude:clearCredentials', () => {
  claudeCredentials = null
})

// IPC: Session history
ipcMain.handle('session:list', () => sessionRecorder.listSessions())
ipcMain.handle('session:read', (_event, id: string) => sessionRecorder.readSession(id))
ipcMain.handle('session:delete', (_event, id: string) => sessionRecorder.deleteSession(id))
ipcMain.handle('session:search', (_event, query: string) => sessionRecorder.searchSessions(query))
ipcMain.handle('session:clearAll', () => sessionRecorder.clearAll())

// IPC: Filesystem helpers (for drag & drop, file preview)
ipcMain.handle('fs:isDirectory', (_event, path: string) => {
  if (typeof path !== 'string') return false
  const resolved = resolve(normalize(path))
  const home = os.homedir()
  if (!resolved.startsWith(home + sep) && resolved !== home) return false
  return isValidDirectory(path)
})

ipcMain.handle('fs:exists', (_event, path: string) => {
  if (typeof path !== 'string') return false
  try {
    const resolved = resolve(normalize(path))
    const home = os.homedir()
    if (!resolved.startsWith(home + sep) && resolved !== home) return false
    return existsSync(resolved)
  } catch { return false }
})

ipcMain.handle('fs:readFile', (_event, filePath: string, maxSize?: number) => {
  try {
    const resolved = resolve(normalize(filePath))
    if (!existsSync(resolved)) return null
    // Resolve symlinks for security boundary check
    const { realpathSync } = require('fs') as typeof import('fs')
    const real = realpathSync(resolved)
    const home = os.homedir()
    const homePrefix = home + sep
    if (!real.startsWith(homePrefix) && real !== home) {
      log.warn(`fs:readFile blocked path outside home: ${real}`)
      return null
    }
    const stat = statSync(real)
    if (stat.isDirectory()) return null
    const limit = maxSize || 1024 * 1024
    if (stat.size > limit) return null
    const { readFileSync } = require('fs') as typeof import('fs')
    const extLower = real.split('.').pop()?.toLowerCase() || ''
    const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])
    const BINARY_EXTS = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pdf', 'zip', 'tar', 'gz', 'rar', '7z', 'dmg', 'exe', 'dll', 'so', 'dylib', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv'])
    if (IMAGE_EXTS.has(extLower)) {
      const mime = extLower === 'svg' ? 'image/svg+xml'
        : extLower === 'png' ? 'image/png'
        : extLower === 'gif' ? 'image/gif'
        : extLower === 'webp' ? 'image/webp'
        : extLower === 'bmp' ? 'image/bmp'
        : extLower === 'ico' ? 'image/x-icon'
        : 'image/jpeg'
      const b64 = readFileSync(real).toString('base64')
      return `__IMAGE__:data:${mime};base64,${b64}`
    }
    if (BINARY_EXTS.has(extLower)) {
      return '__BINARY__'
    }
    return readFileSync(real, 'utf-8')
  } catch {
    return null
  }
})

ipcMain.handle('fs:listDir', (_event, dirPath: string) => {
  try {
    if (typeof dirPath !== 'string') return []
    const resolved = resolve(normalize(dirPath))
    const home = os.homedir()
    const homePrefix = home + sep
    if (!resolved.startsWith(homePrefix) && resolved !== home) return []
    // Resolve symlinks to prevent symlink escape
    const { realpathSync, readdirSync } = require('fs') as typeof import('fs')
    let real: string
    try { real = realpathSync(resolved) } catch { return [] }
    if (!real.startsWith(homePrefix) && real !== home) {
      log.warn(`fs:listDir blocked path outside home: ${real}`)
      return []
    }
    if (!existsSync(real)) return []
    const MAX_ENTRIES = 2000
    const entries = readdirSync(real, { withFileTypes: true })
    const result: { name: string; path: string; isDirectory: boolean }[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      result.push({
        name: entry.name,
        path: join(resolved, entry.name),
        isDirectory: entry.isDirectory(),
      })
      if (result.length >= MAX_ENTRIES) break
    }
    result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    return result
  } catch {
    return []
  }
})

// IPC: Renderer error reporting
ipcMain.on('log:error', (_event, { message, stack }: { message: string; stack?: string }) => {
  log.error(`[Renderer] ${message}`, stack || '')
  errorReporter.report(message, stack, 'renderer')
})

// IPC: Log upload
ipcMain.handle('logs:uploadFile', () => errorReporter.uploadLogFile())

// IPC: App auto-update
ipcMain.handle('appUpdate:check', () => checkForAppUpdate())
ipcMain.handle('appUpdate:download', () => downloadAppUpdate())
ipcMain.handle('appUpdate:install', () => installAppUpdate())

// IPC: Clipboard
ipcMain.handle('clipboard:writeText', (_event, text: string) => {
  clipboard.writeText(text)
})

ipcMain.handle('clipboard:saveImage', async (_event, buffer: ArrayBuffer) => {
  const MAX_IMAGE_SIZE = 50 * 1024 * 1024 // 50MB
  if (buffer.byteLength > MAX_IMAGE_SIZE) {
    throw new Error('Image too large (max 50MB)')
  }
  const tmpDir = join(app.getPath('userData'), 'tmp')
  mkdirSync(tmpDir, { recursive: true })
  const now = new Date()
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  const filename = `paste-${ts}.png`
  const filepath = join(tmpDir, filename)
  const { writeFileSync } = require('fs') as typeof import('fs')
  writeFileSync(filepath, Buffer.from(buffer))
  return filepath
})

ipcMain.handle('clipboard:getImageSize', async (_event, filepath: string) => {
  try {
    const expectedDir = join(app.getPath('userData'), 'tmp')
    const resolved = resolve(normalize(filepath))
    if (!resolved.startsWith(expectedDir + sep)) {
      return { size: 0 }
    }
    const { statSync: fsStat } = require('fs') as typeof import('fs')
    return { size: fsStat(resolved).size }
  } catch {
    return { size: 0 }
  }
})

/** Generate auto-fill script for Claude login pages (max 10 retries) */
function claudeAutoFillScript(email: string, password: string): string {
  const safeEmail = JSON.stringify(email)
  const safePass = JSON.stringify(password)
  return `(function() {
    var attempts = 0;
    function tryFill() {
      if (++attempts > 10) return;
      var emailInput = document.querySelector('input[type="email"], input[name="email"], input[name="identifier"]');
      var passInput = document.querySelector('input[type="password"]');
      if (emailInput) {
        emailInput.value = ${safeEmail};
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (passInput) {
        passInput.value = ${safePass};
        passInput.dispatchEvent(new Event('input', { bubbles: true }));
        passInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (emailInput || passInput) {
        setTimeout(function() {
          var btn = document.querySelector('button[type="submit"]');
          if (btn) btn.click();
        }, 800);
      } else {
        setTimeout(tryFill, 1000);
      }
    }
    setTimeout(tryFill, 500);
  })()`
}

// IPC: Built-in browser (uses proxy + region env + address bar)

function getBrowserConfig() {
  const regionEnv = proxySettings.enabled ? (REGION_ENV[proxySettings.region] || {}) : {}
  const sbInfo = singBoxManager.getInfo()
  return {
    region: proxySettings.region,
    regionEnv,
    proxyUrl: proxySettings.url,
    proxyEnabled: proxySettings.enabled,
    tunRunning: sbInfo.tunRunning,
    accountId: subscriptionManager.getUsername() || 'default',
    claudeCredentials,
    claudeAutoFillScript,
    // Pass as getter so the one-shot script is only consumed when a claude.ai
    // tab actually loads, not on every browser:open call (e.g. browserleaks).
    getLocalStorageImportScript: () => browserSync.getLocalStorageImportScript(),
  }
}

async function openBuiltinBrowser(url: string): Promise<{ success?: boolean; error?: string }> {
  return openBrowserWindow(url, getBrowserConfig())
}

ipcMain.handle('browser:closeAll', () => {
  closeAllBrowserWindows()
})

ipcMain.handle('browser:open', async (_event, url: string) => {
  return openBuiltinBrowser(url)
})

ipcMain.handle('browser:openEmpty', async () => {
  return openBrowserEmpty(getBrowserConfig())
})

// IPC: Window controls (Windows only)
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on('window:close', () => mainWindow?.close())

// IPC: App version
ipcMain.handle('app:getVersion', () => {
  return app.getVersion()
})

// IPC: Analytics (renderer → main)
ipcMain.on('analytics:track', (_event, { event, props }: { event: string; props?: Record<string, unknown> }) => {
  analytics.track(event, props)
})

// --- Window focus tracking ---
let isWindowFocused = true

// --- Sleep inhibitor ---
let sleepBlockerId: number | null = null
let sleepInhibitorEnabled = true

// --- PTY Monitor: broadcast activity events + notifications + sleep ---
ptyMonitor.on('activity', (event: PtyActivityEvent) => {
  safeSend('pty:activity', event)

  if (event.type === 'ttfb-ready') {
    statsCollector.sessionRecordTtfb(event.id, parseInt(event.payload ?? '0'))
  } else if (event.type === 'token-usage') {
    try {
      const parsed = JSON.parse(event.payload ?? '{}')
      statsCollector.sessionSetTokens(event.id, {
        inputTokens: typeof parsed.input === 'number' ? parsed.input : undefined,
        outputTokens: typeof parsed.output === 'number' ? parsed.output : undefined,
        totalTokens: typeof parsed.total === 'number' ? parsed.total : undefined,
        cost: typeof parsed.cost === 'number' ? `$${parsed.cost}` : undefined,
      })
    } catch { /* ignore malformed payload */ }
  }

  // Auto-open detected URLs in built-in browser (works on all platforms,
  // especially needed on Windows where `start` cmd builtin can't be intercepted)
  if (event.type === 'url-open' && event.payload) {
    openBuiltinBrowser(event.payload).catch(err =>
      log.error('[PtyMonitor] failed to open URL:', err)
    )
  }

  if (event.type === 'task-complete' && !isWindowFocused) {
    safeSend('notification:shouldShow', event)
  }

  if (event.type === 'streaming') {
    if (sleepBlockerId === null && sleepInhibitorEnabled) {
      sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      safeSend('power:sleepInhibitChange', true)
    }
  } else if (event.type === 'task-complete' || event.type === 'prompt-idle') {
    if (sleepBlockerId !== null && !ptyMonitor.isAnyStreaming()) {
      powerSaveBlocker.stop(sleepBlockerId)
      sleepBlockerId = null
      safeSend('power:sleepInhibitChange', false)
    }
  }
})

ipcMain.handle('notification:show', (_event, { title, body }: { title: string; body: string }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show()
  }
})

ipcMain.handle('app:isFocused', () => isWindowFocused)

ipcMain.on('power:setSleepInhibitorEnabled', (_event, enabled: boolean) => {
  sleepInhibitorEnabled = enabled
  if (!enabled && sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId)
    sleepBlockerId = null
    safeSend('power:sleepInhibitChange', false)
  }
})

// IPC: Git branch
ipcMain.handle('git:getBranch', async (_event, cwd: string) => {
  try {
    if (!isValidDirectory(cwd)) return null
    const toolsEnv = toolsManager.getEnvPatch()
    const env = { ...process.env, ...toolsEnv }
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 3000, env }).trim()
    return branch || null
  } catch {
    return null
  }
})

/**
 * Initialize chat mode subsystem. Isolated from CLI initialization so that
 * a chat-mode failure cannot break the CLI experience.
 */
async function initChatMode(): Promise<void> {
  try {
    const claudeConfigDir = join(app.getPath('userData'), 'claude-config')
    const codexConfigDir = join(app.getPath('userData'), 'codex-config')
    mkdirSync(claudeConfigDir, { recursive: true })
    mkdirSync(codexConfigDir, { recursive: true })

    // Pre-create empty MCP config so buildArgs() never touches electron require()
    const { initEmptyMcpConfig } = await import('./chat/sandbox')
    initEmptyMcpConfig(app.getPath('userData'))

    await chatStore.init()
    // Patch cliVersion so newly-created chats record which CLI they started with
    ;(chatStore as unknown as { cliVersion: string }).cliVersion =
      cliManager.getInfo().version || 'unknown'

    chatManager = new ChatManager({
      store: chatStore,
      getCliBinaryPath: (engine) => {
        const mgr = engine === 'codex' ? codexManager : cliManager
        const info = mgr.getInfo()
        return info.installed ? info.path : ''
      },
      regionEnv: () => (proxySettings.enabled ? (REGION_ENV[proxySettings.region] || {}) : {}),
      extraEnv: () => {
        const tunInfo = singBoxManager.getInfo()
        const proxyEnv = proxySettings.enabled && !tunInfo.tunRunning
          ? buildProxyEnv(proxySettings.url)
          : {}
        // PATH parity with PTY mode: tools env + Homebrew/.local/bin/etc. via
        // buildBasePath, plus the active engine bin dirs prepended so codex/claude
        // can shell out to git/node/etc. on Dock-launched apps where
        // process.env.PATH is just /usr/bin:/bin.
        const toolsPatch = toolsManager.getEnvPatch()
        const enginePathSegs: string[] = []
        for (const mgr of [cliManager, codexManager]) {
          const info = mgr.getInfo()
          if (info.installed && info.path) {
            const idx = Math.max(info.path.lastIndexOf('/'), info.path.lastIndexOf('\\'))
            if (idx > 0) enginePathSegs.push(info.path.substring(0, idx))
          }
        }
        const basePath = toolsPatch.PATH || buildBasePath()
        const chatPath = enginePathSegs.length > 0
          ? enginePathSegs.join(delimiter) + delimiter + basePath
          : basePath
        return {
          CLAUDE_CONFIG_DIR: claudeConfigDir,
          CODEX_HOME: codexConfigDir,
          ...toolsPatch,
          PATH: chatPath,
          ...proxyEnv,
        }
      },
      onEvent: (p) => safeSend('chat:stream', p),
      onEnd: (p) => safeSend('chat:end', p),
    })

    registerChatIPC({
      mainWindow: () => mainWindow,
      store: chatStore,
      manager: chatManager,
      claudeConfigDir,
    })
  } catch (err) {
    log.error('[chat] init failed:', err)
  }
}

// App lifecycle
app.whenReady().then(async () => {
  // CSP — apply in both dev and production
  // Dev mode is slightly looser (allows localhost connections for HMR)
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Dev mode needs 'unsafe-inline' + 'unsafe-eval' for Vite HMR/React preamble
    const scriptSrc = isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'"
    const connectSrc = isDev
      ? "connect-src 'self' ws://localhost:* http://localhost:* https://llm.inkessai.com https://inkess-app.oss-ap-northeast-1.aliyuncs.com"
      : "connect-src https://llm.inkessai.com https://inkess-app.oss-ap-northeast-1.aliyuncs.com"
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline'; ` +
          `${connectSrc}; font-src 'self'; img-src 'self' data:;`
        ]
      }
    })
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
      callback(true)
    } else {
      callback(false)
    }
  })

  // Clean up expired temp files (older than 7 days)
  try {
    const tmpDir = join(app.getPath('userData'), 'tmp')
    if (existsSync(tmpDir)) {
      const { readdirSync, unlinkSync: rmFile, statSync: fstat } = require('fs') as typeof import('fs')
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      for (const f of readdirSync(tmpDir)) {
        const fp = join(tmpDir, f)
        try { if (fstat(fp).mtimeMs < cutoff) rmFile(fp) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // Start browser interceptor — redirects PTY `open` / BROWSER calls to built-in browser
  browserInterceptor.start((url) => {
    openBuiltinBrowser(url).catch(err => log.error('[BrowserInterceptor] failed to open URL:', err))
  })

  // --- Chat mode wiring (spec §3) -----------------------------------------
  await initChatMode()

  createWindow()
  setupMenu()

  analytics.track('app_launch', {
    claude_installed: cliManager.isInstalled() ? 'yes' : 'no',
    codex_installed: codexManager.isInstalled() ? 'yes' : 'no',
    cli_version: cliManager.isInstalled() ? 'installed' : 'not_installed', // legacy field
  })

  onUpdateStatus((status) => {
    safeSend('appUpdate:status', status)
  })

  // Delay update check until TUN is likely ready (60s instead of 5s)
  // TUN startup takes ~20-30s (sudo prompt + sing-box start + connectivity test)
  setTimeout(() => checkForAppUpdate(), 60000)
  statsCollector.logEvent('app:launch', app.getVersion())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// ─── App quit flow ─────────────────────────────────────────
//
// State machine for graceful shutdown. Prior implementation had a double-quit
// race: first Cmd+Q fires before-quit → preventDefault → starts async work.
// If the user impatiently Cmd+Q's again while the work is still running, the
// second before-quit sees `_quitting=true`, RETURNS WITHOUT preventDefault,
// and Electron proceeds with the default quit → windows close → process
// exits → the first handler's .then never reaches singBoxManager.stop().
//
// Fix: three-state flag. `running` (work in progress) → second call MUST
// preventDefault again and wait; `done` (work complete, awaiting app.quit) →
// second call allows Electron's default quit to run.
//
// All diagnostic events are logged synchronously so they survive even if
// the process is force-killed mid-shutdown.
let _quitState: 'idle' | 'running' | 'done' = 'idle'

// Upper bound on shutdown work. Anything longer than this and we force
// quit anyway — no user should be stuck with an unquittable app because of
// a misbehaving sudo prompt or hung sing-box. 30s is generous for the
// worst-case path (osascript sudo restore DNS + SIGTERM wait + SIGKILL wait).
const QUIT_WORK_HARD_TIMEOUT_MS = 30000

async function doQuitWork(): Promise<void> {
  log.info('[before-quit] doQuitWork start')

  // Chat cleanup — synchronous enough to run first (just kills children,
  // waits <3s for SIGKILL grace). Removes IPC handlers so a second Cmd+Q
  // doesn't trigger stale paths.
  try {
    chatManager?.cancelAll()
    unregisterChatIPC()
    log.info('[before-quit] chat cleanup complete')
  } catch (err) {
    log.warn('[before-quit] chat cleanup failed:', err)
  }

  const work = (async () => {
    // Upload browser data before TUN stops (5s timeout race — the underlying
    // upload may hang on Cloudflare JS challenge or a dead network, so we
    // cap the wait and let the periodic timer pick up next time).
    try {
      await Promise.race([
        browserSync.upload(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ])
      log.info('[before-quit] browser sync upload race resolved')
    } catch (err) {
      log.warn('[before-quit] browser sync upload failed:', err)
    }

    try {
      browserSync.stop()
      log.info('[before-quit] browserSync.stop() returned')
    } catch (err) {
      log.warn('[before-quit] browserSync.stop() threw:', err)
    }

    try {
      await singBoxManager.stop()
      log.info('[before-quit] singBoxManager.stop() returned')
    } catch (err) {
      log.error('[before-quit] Failed to stop tunnel:', err)
    }
  })()

  const hardTimeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      log.error(`[before-quit] doQuitWork hard timeout (${QUIT_WORK_HARD_TIMEOUT_MS}ms) — aborting`)
      resolve()
    }, QUIT_WORK_HARD_TIMEOUT_MS)
  })

  await Promise.race([work, hardTimeout])
  log.info('[before-quit] doQuitWork finished')
}

app.on('before-quit', (event) => {
  log.info(`[before-quit] fired, state=${_quitState}`)
  if (_quitState === 'done') {
    // Second call after doQuitWork completed — from our own app.quit()
    // below. Let Electron proceed with the default quit flow.
    log.info('[before-quit] state=done — allowing Electron to quit')
    return
  }
  // Any other state (idle or running) → block the default quit. Running
  // state means user double-Cmd+Q'd while our async work is still in
  // flight; we must NOT let Electron force-exit before stop() completes.
  event.preventDefault()

  if (_quitState === 'running') {
    log.info('[before-quit] state=running — ignoring duplicate, waiting for first invocation')
    return
  }

  _quitState = 'running'
  doQuitWork()
    .catch((err) => log.error('[before-quit] doQuitWork rejected:', err))
    .finally(() => {
      _quitState = 'done'
      log.info('[before-quit] transitioning to done — calling app.quit()')
      app.quit()
    })
})

app.on('will-quit', () => {
  // Last-chance diagnostic. Fires after all before-quit listeners have
  // settled and Electron is about to tear down. If we reach here without
  // `[before-quit] doQuitWork finished` in the log, the quit work was
  // interrupted (external SIGKILL or similar).
  log.info(`[will-quit] fired, state=${_quitState}`)
})

// Handle process signals for cleanup
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log.info(`[${sig}] received — cleaning up tunnel`)
    singBoxManager.stop()
      .catch(() => { /* best effort */ })
      .finally(() => process.exit(0))
  })
}

app.on('window-all-closed', async () => {
  log.info('[window-all-closed] fired')
  // Close all browser windows
  closeAllBrowserWindows()
  browserInterceptor.stop()
  statsCollector.logEvent('app:quit')
  statsCollector.dispose()
  ptyManager.killAll()
  ptyMonitor.dispose()
  analytics.flushSync()
  errorReporter.flushSync()
  if (sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId)
    sleepBlockerId = null
  }
  if (process.platform !== 'darwin') {
    // before-quit handler will stop sing-box
    setTimeout(() => app.quit(), 500)
  }
})

function setupMenu(): void {
  const isMac = process.platform === 'darwin'
  const mod = isMac ? 'Cmd' : 'Ctrl'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: `${mod}+T`, click: () => safeSend('app:newTab') },
        { label: 'Close Tab', accelerator: `${mod}+W`, click: () => safeSend('app:closeTab') },
        { type: 'separator' },
        {
          label: 'Open Folder...', accelerator: `${mod}+O`,
          click: async () => {
            if (!mainWindow) return
            const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
            if (!result.canceled && result.filePaths[0]) {
              safeSend('app:openFolder', result.filePaths[0])
            }
          }
        },
        { type: 'separator' },
        ...(isMac ? [] : [{ role: 'quit' as const }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Tabs',
      submenu: Array.from({ length: 9 }, (_, i) => ({
        label: `Tab ${i + 1}`, accelerator: `${mod}+${i + 1}`,
        click: () => safeSend('app:switchTab', i)
      }))
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const }, { role: 'zoom' as const },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [{ role: 'close' as const }])
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
