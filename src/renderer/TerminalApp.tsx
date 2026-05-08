import { useCallback, useRef, useEffect, useState } from 'react'
import { useTerminalStore } from './stores/terminal'
import { useAppStore } from './stores/app'
import { useSettingsStore, applyTheme } from './stores/settings'
import { useNetworkStore } from './stores/network'
import { TerminalView } from './views/terminal/TerminalView'
import { Sidebar } from './views/sidebar/Sidebar'
import { SetupScreen, startInstall, startToolsInstall } from './views/setup/SetupScreen'
import { SettingsPanel } from './views/settings/SettingsPanel'
import { StatusBar } from './views/statusbar/StatusBar'
import { CommandPalette } from './views/command-palette/CommandPalette'
import { HistoryView } from './views/history/HistoryView'
import { StatsView } from './views/stats/StatsView'
import { FilePreview } from './views/preview/FilePreview'
import { LoginPage } from './views/subscription/LoginPage'
import { TunGate } from './views/tun/TunGate'
import { ChatDrawer } from './views/chat/ChatDrawer'
import { ChatErrorBoundary } from './views/chat/ChatErrorBoundary'
import { useChatStream } from './views/chat/hooks/useChatStream'
import { useChatList } from './views/chat/hooks/useChatList'
import { useI18n } from './i18n'

const DEFAULT_CWD = window.api?.homedir || '/'
const isMac = window.api?.platform === 'darwin'

// Module-level cache: survive TerminalApp unmount/remount during mode switches.
// Without this, every chat→CLI switch re-runs the full subscription+TUN check,
// causing a 200-500ms TunGate flash (tunOk starts false, waits for IPC roundtrip).
let _cachedSubscriptionState: {
  loggedIn: boolean
  username: string | null
  expiry: string | null
  exitIp: string
  tunnelUrl: string
  plan: string
  tunOk: boolean
} | null = null

/** Shorten absolute path: replace home dir with ~, normalize separators */
export function shortenPath(p: string): string {
  const home = window.api?.homedir || ''
  if (home && p.startsWith(home)) {
    p = '~' + p.slice(home.length)
  }
  return p.replace(/\\/g, '/')
}

/** Get last segment of a path (works with both / and \) */
function pathBasename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || 'terminal'
}

const IDE_SCHEMES: Record<string, string> = {
  vscode: 'vscode://',
  cursor: 'cursor://',
  zed: 'zed://',
}

export function TerminalApp() {
  const { tabs, activeTabId, addTab, removeTab, setActiveTab } = useTerminalStore()
  const { phase, setPhase, setCliInfo } = useAppStore()
  const proxyUrl = useSettingsStore(s => s.proxyUrl)
  const initRef = useRef(false)
  const [showSettings, setShowSettings] = useState(false)
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const pendingCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [appUpdateStatus, setAppUpdateStatus] = useState<{
    type: string; version?: string; percent?: number; message?: string
  } | null>(null)
  const [appUpdateDismissed, setAppUpdateDismissed] = useState(false)
  const { t } = useI18n()
  const [dragOver, setDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  const [showHistory, setShowHistory] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [previewFile, setPreviewFile] = useState<string | null>(null)
  // Transient alert shown when connectivity fails mid-session and we're
  // auto-recovering. Distinct from NetworkIndicator (statusbar) — this is
  // a foreground toast because users miss the small dot.
  const [networkAlert, setNetworkAlert] = useState<{
    type: 'warning' | 'error'; message: string; actionLabel?: string; onAction?: () => void
  } | null>(null)
  const [tunOk, setTunOk] = useState(_cachedSubscriptionState?.tunOk ?? false)
  const chatDrawerOpen = useSettingsStore(s => s.chatDrawerOpen)
  const setChatDrawerOpen = useSettingsStore(s => s.setChatDrawerOpen)

  // Chat mode hooks — always active so events aren't missed when drawer is closed
  useChatStream()
  useChatList()

  // Trigger xterm refit after chat drawer open/close changes flex layout
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event('resize')), 250)
    return () => clearTimeout(t)
  }, [chatDrawerOpen])

  const tunOkRef = useRef(_cachedSubscriptionState?.tunOk ?? false)
  const tunWasOkRef = useRef(_cachedSubscriptionState?.tunOk ?? false)
  const handleNewTabRef = useRef<(cwd?: string) => void>(() => {})
  useEffect(() => {
    if (tunOk) tunWasOkRef.current = true
    tunOkRef.current = tunOk
    console.log(`[App] tunOk changed → ${tunOk}`)
    // Persist to module-level cache so mode switches don't flash TunGate
    if (_cachedSubscriptionState) _cachedSubscriptionState.tunOk = tunOk
  }, [tunOk])

  const [subscriptionLoggedIn, setSubscriptionLoggedIn] = useState<boolean | null>(_cachedSubscriptionState?.loggedIn ?? null) // null = checking
  const [subscriptionUsername, setSubscriptionUsername] = useState<string | null>(_cachedSubscriptionState?.username ?? null)
  const [subscriptionExpiry, setSubscriptionExpiry] = useState<string | null>(_cachedSubscriptionState?.expiry ?? null)
  const [subscriptionExitIp, setSubscriptionExitIp] = useState<string>(_cachedSubscriptionState?.exitIp ?? '')
  const [subscriptionTunnelUrl, setSubscriptionTunnelUrl] = useState<string>(_cachedSubscriptionState?.tunnelUrl ?? '')
  const [subscriptionPlan, setSubscriptionPlan] = useState<string>(_cachedSubscriptionState?.plan ?? 'monthly')
  const [expiryMinutesRemaining, setExpiryMinutesRemaining] = useState<number | null>(null)
  const expiryAtRef = useRef<string | null>(null)
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // TUN health monitoring:
  // 1. Process check: 5s poll, 2 consecutive failures → kill PTYs + disconnect
  // 2. Exit IP check: 60s poll (was 5min), verify exit IP matches expected
  // 3. Interface alert: detect new TUN devices (e.g. Clash Verge), trigger immediate IP check
  useEffect(() => {
    if (!tunOk || !subscriptionLoggedIn) return
    let failCount = 0

    // Process liveness check (lightweight, every 5s)
    // Skipped while useNetworkStore.reconnecting is true — during a manual
    // reconnect sing-box is briefly down by design, we don't want to kill
    // terminals or force TunGate full-screen to reappear.
    const processInterval = setInterval(async () => {
      if (useNetworkStore.getState().reconnecting) {
        failCount = 0
        return
      }
      const info = await window.api.tun.getInfo()
      if (!info.tunRunning) {
        failCount++
        if (failCount >= 2) {
          window.api.pty.killAll()
          setTunOk(false)
          window.api.browser.closeAll()
        }
      } else {
        failCount = 0
      }
    }, 5000)

    // Exit IP verification — adaptive cadence:
    //   - Healthy: 60s between probes.
    //   - Failing: probe again in 15s to quickly confirm (vs wait a full minute).
    //
    // Outcomes:
    //   - success → reset counters, clear any alert.
    //   - IP changed → route hijacked by another VPN, drop PTYs + force TunGate.
    //   - fetch failed (consecutive):
    //       1 fail  → silent, wait the short retry
    //       2 fails → toast "unstable, retrying"
    //       3 fails → auto tun.reconnect() once; reconnect re-runs Smart
    //                 Fallback (probeDirectProxy), which will now see the
    //                 failing direct path and switch to chain mode.
    //       post-reconnect fail → toast "reconnect failed", stop auto-retry
    //                             (avoid reconnect loop); user can retry manually
    //                             via NetworkPopover.
    const exitIp = subscriptionExitIp
    let consecutiveFailures = 0
    let autoReconnectAttempted = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const scheduleNextCheck = (delay: number) => {
      if (cancelled) return
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = setTimeout(runCheck, delay)
    }

    const runCheck = async () => {
      if (cancelled || !exitIp) return
      if (useNetworkStore.getState().reconnecting) {
        scheduleNextCheck(60 * 1000)
        return
      }
      try {
        const result = await window.api.tun.testConnectivity(exitIp)
        if (cancelled) return

        if (result.success) {
          consecutiveFailures = 0
          autoReconnectAttempted = false
          setNetworkAlert(null)
          scheduleNextCheck(60 * 1000)
          return
        }

        if (result.actualIp && result.actualIp !== exitIp) {
          console.warn(`[App] exit IP changed: expected ${exitIp}, got ${result.actualIp} — reconnecting`)
          window.api.pty.killAll()
          setTunOk(false)
          window.api.browser.closeAll()
          return
        }

        // Fetch failed / no actualIp.
        consecutiveFailures++
        console.warn(`[App] exit IP check failed (${consecutiveFailures}): ${result.error}`)

        if (consecutiveFailures === 2) {
          setNetworkAlert({
            type: 'warning',
            message: t('network.alert.unstable'),
            actionLabel: t('network.alert.reconnectNow'),
            // Mark auto-reconnect as done so the next runCheck iteration (already
            // scheduled) won't race with this manual reconnect and trigger a
            // second tun.reconnect() once the failure count crosses 3.
            onAction: () => { autoReconnectAttempted = true; void triggerReconnect() },
          })
        }

        if (consecutiveFailures >= 3 && !autoReconnectAttempted) {
          autoReconnectAttempted = true
          setNetworkAlert({ type: 'error', message: t('network.alert.reconnecting') })
          void triggerReconnect()
          return
        }

        scheduleNextCheck(15 * 1000)
      } catch (err) {
        console.warn('[App] exit IP check error', err)
        scheduleNextCheck(60 * 1000)
      }
    }

    const triggerReconnect = async () => {
      const store = useNetworkStore.getState()
      if (store.reconnecting) return
      store.setReconnecting(true)
      try {
        const result = await window.api.tun.reconnect()
        if (cancelled) return
        if (result.success) {
          // Re-verify immediately; on success the probe resets counters.
          try {
            const verify = await window.api.tun.testConnectivity(exitIp)
            if (cancelled) return
            if (verify.success) {
              consecutiveFailures = 0
              autoReconnectAttempted = false
              setNetworkAlert(null)
            } else {
              setNetworkAlert({ type: 'error', message: t('network.alert.reconnectFailed') })
            }
          } catch {
            setNetworkAlert({ type: 'error', message: t('network.alert.reconnectFailed') })
          }
        } else {
          // If reconnect failed due to auth denial OR an un-killable orphan
          // sing-box process from a previous denied prompt, surface TunGate
          // so the user explicitly re-authorizes — we do NOT keep auto-retrying,
          // because each retry triggers another sudo prompt that macOS will
          // auto-deny while the cooldown is active.
          const errMsg = result.error || ''
          const needsManualAction = errMsg.includes('AUTH_DENIED') || errMsg.includes('ORPHAN_PROCESS')
          if (needsManualAction) {
            // Force TunGate overlay to appear — user needs to authorize manually
            setTunOk(false)
          } else {
            setNetworkAlert({ type: 'error', message: errMsg || t('network.alert.reconnectFailed') })
          }
        }
      } catch (err) {
        if (!cancelled) {
          setNetworkAlert({
            type: 'error',
            message: err instanceof Error ? err.message : t('network.alert.reconnectFailed'),
          })
        }
      } finally {
        useNetworkStore.getState().setReconnecting(false)
        if (!cancelled) scheduleNextCheck(60 * 1000)
      }
    }

    // Kick off the adaptive loop. Uses chained setTimeout rather than setInterval
    // so cadence can switch between healthy (60s) and failing (15s).
    if (exitIp) scheduleNextCheck(60 * 1000)

    // Interface alert: external VPN detected, immediately verify IP.
    // Skipped during manual reconnect (see ipCheckInterval rationale above).
    const unsubscribeAlert = window.api.tun.onInterfaceAlert?.(async (event) => {
      console.warn(`[App] external TUN detected: ${event.interfaces.join(', ')}`)
      if (!exitIp) return
      if (useNetworkStore.getState().reconnecting) return
      try {
        const result = await window.api.tun.testConnectivity(exitIp)
        if (result.actualIp && result.actualIp !== exitIp) {
          // IP changed after external VPN appeared — route hijacked
          console.warn(`[App] IP changed after external TUN: expected ${exitIp}, got ${result.actualIp}`)
          window.api.pty.killAll()
          setTunOk(false)
          window.api.browser.closeAll()
        }
      } catch { /* ignore */ }
    })

    return () => {
      cancelled = true
      clearInterval(processInterval)
      if (retryTimer) clearTimeout(retryTimer)
      unsubscribeAlert?.()
      setNetworkAlert(null)
    }
  }, [tunOk, subscriptionLoggedIn, subscriptionExitIp, t])

  // Startup: check subscription login, then CLI.
  // If we already have cached state from a previous mount (mode switch),
  // skip the full re-init to avoid TunGate flash.
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    if (_cachedSubscriptionState?.loggedIn) {
      // Already initialized in a previous mount — just ensure phase is ready
      if (useAppStore.getState().phase !== 'ready') {
        checkCliAndProceed()
      }
      return
    }
    checkSubscriptionAndProceed()
  }, [])

  const checkSubscriptionAndProceed = useCallback(async () => {
    const session = await window.api.subscription.getSession()
    if (session.isLoggedIn) {
      // Verify session is still valid on server before proceeding.
      // checkStatus() returns null on BOTH network error and 401.
      // On 401, main process already called logout() internally (session.json deleted).
      // On network error, session.json is intact. We distinguish by re-checking session.
      const status = await window.api.subscription.checkStatus()
      if (status && (status.status === 'expired' || status.status === 'suspended')) {
        console.log('[App] session expired/suspended on server, redirecting to login')
        await window.api.subscription.logout()
        setSubscriptionLoggedIn(false)
        return
      }
      if (!status) {
        // checkStatus returned null — could be network error or 401.
        // Re-check if session was cleared by 401 handler in main process.
        const recheck = await window.api.subscription.getSession()
        if (!recheck.isLoggedIn) {
          console.log('[App] session cleared (likely 401), redirecting to login')
          setSubscriptionLoggedIn(false)
          return
        }
        // Network error but session intact — proceed with local session, TunGate will connect
      }

      setSubscriptionLoggedIn(true)
      setSubscriptionUsername(session.username)
      setSubscriptionExpiry(status?.expiresAt || session.session?.expiresAt || null)
      expiryAtRef.current = status?.expiresAt || session.session?.expiresAt || null
      setSubscriptionPlan(session.session?.plan || 'monthly')
      // Use server-returned proxyUrl/region if available (may have been updated by admin),
      // otherwise fall back to local session values
      const proxyUrlToUse = status?.proxyUrl || session.session?.proxyUrl
      if (proxyUrlToUse) {
        const store = useSettingsStore.getState()
        store.setProxyEnabled(true)
        store.setProxyMode('tun')
        store.setProxyUrl(proxyUrlToUse)
        const region = status?.proxyRegion || session.session?.proxyRegion
        if (region) store.setProxyRegion(region)
      }
      setSubscriptionExitIp(status?.exitIp || session.session?.exitIp || '')
      // Prefer server-returned tunnelUrl (may have been added by admin after first login).
      // Old sessions from pre-tunnel builds lack this field — without this fallback,
      // those users would be stuck in single-proxy mode forever.
      setSubscriptionTunnelUrl(status?.tunnelUrl || session.session?.tunnelUrl || '')
      // Cache state so mode switches skip the full re-init
      _cachedSubscriptionState = {
        loggedIn: true,
        username: session.username,
        expiry: status?.expiresAt || session.session?.expiresAt || null,
        exitIp: status?.exitIp || session.session?.exitIp || '',
        tunnelUrl: status?.tunnelUrl || session.session?.tunnelUrl || '',
        plan: session.session?.plan || 'monthly',
        tunOk: false, // will be set to true by setTunOk callback
      }
      // Check if subscription already expired before proceeding
      const expiresAt = status?.expiresAt || session.session?.expiresAt
      if (expiresAt) {
        const minutesLeft = calcMinutesRemaining(expiresAt)
        if (minutesLeft <= 0) {
          forceExpiredLogout()
          return
        }
      }
      startStatusPolling(session.session?.plan || 'monthly')
      // Check if TUN is already running and connected
      const tunInfo = await window.api.tun.getInfo()
      if (tunInfo.tunRunning) {
        const exitIp = status?.exitIp || session.session?.exitIp || undefined
        const test = await window.api.tun.testConnectivity(exitIp)
        if (test.success) {
          setTunOk(true)
          checkCliAndProceed()
          return
        }
      }
      // TUN not ready — TunGate will show (tunOk remains false)
    } else {
      setSubscriptionLoggedIn(false)
    }
  }, [])

  const handleSubscriptionLogin = useCallback(async (config: {
    claudeEmail: string; claudePassword: string; proxyUrl: string; proxyRegion: string; exitIp?: string; expiresAt: string; status: string; plan?: string
  }) => {
    setSubscriptionLoggedIn(true)
    setSubscriptionExpiry(config.expiresAt)
    expiryAtRef.current = config.expiresAt
    setSubscriptionPlan(config.plan || 'monthly')
    setSubscriptionExitIp(config.exitIp || '')

    // 1. Auto-configure proxy
    const store = useSettingsStore.getState()
    store.setProxyEnabled(true)
    store.setProxyMode('tun')
    store.setProxyUrl(config.proxyUrl)
    store.setProxyRegion(config.proxyRegion)

    // 2. Send Claude credentials to main process for browser auto-fill
    if (config.claudeEmail && config.claudePassword) {
      window.api.claude.setCredentials(config.claudeEmail, config.claudePassword)
    }

    // 3. Start status polling
    startStatusPolling(config.plan || 'monthly')

    // 4. Get username
    const session = await window.api.subscription.getSession()
    setSubscriptionUsername(session.username)

    // Cache for mode-switch resilience
    _cachedSubscriptionState = {
      loggedIn: true,
      username: session.username,
      expiry: config.expiresAt,
      exitIp: config.exitIp || '',
      tunnelUrl: '', // populated later by TunGate
      plan: config.plan || 'monthly',
      tunOk: false, // will be set true by setTunOk callback
    }

    // TunGate will show automatically (tunOk is false)
    // TunGate.onReady → setTunOk(true) + checkCliAndProceed()
  }, [])

  const forceExpiredLogout = useCallback(() => {
    // Kill all active PTY sessions
    const store = useTerminalStore.getState()
    store.tabs.forEach(tab => {
      if (tab.ptyId && !tab.isExited) {
        window.api.pty.kill(tab.ptyId)
      }
    })
    // Clear polling
    if (statusPollRef.current) { clearInterval(statusPollRef.current); statusPollRef.current = null }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
    // Stop TUN and close browser windows
    window.api.tun.stop()
    window.api.browser.closeAll()
    // Clear Claude credentials and logout
    window.api.claude.clearCredentials()
    window.api.subscription.logout()
    setTunOk(false)
    setSubscriptionLoggedIn(false)
    setSubscriptionExpiry(null)
    setSubscriptionExitIp('')
    setSubscriptionTunnelUrl('')
    expiryAtRef.current = null
    setExpiryMinutesRemaining(null)
    _cachedSubscriptionState = null
  }, [])

  /** Refresh proxy config from server — re-fetches latest proxyUrl/exitIp without re-login */
  const handleRefreshConfig = useCallback(async () => {
    const status = await window.api.subscription.checkStatus()
    if (!status) return
    if (status.proxyUrl) {
      const store = useSettingsStore.getState()
      store.setProxyUrl(status.proxyUrl)
      if (status.proxyRegion) store.setProxyRegion(status.proxyRegion)
    }
    if (status.exitIp) setSubscriptionExitIp(status.exitIp)
    // TunGate will auto-retry with updated proxyUrl/exitIp from props
  }, [])

  /** Switch account — logout current, show login page */
  const handleSwitchAccount = useCallback(async () => {
    await window.api.tun.stop()
    await window.api.pty.killAll()
    window.api.browser.closeAll()
    window.api.claude.clearCredentials()
    window.api.subscription.logout()
    if (statusPollRef.current) { clearInterval(statusPollRef.current); statusPollRef.current = null }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
    setTunOk(false)
    setSubscriptionLoggedIn(false)
    setSubscriptionExpiry(null)
    setSubscriptionExitIp('')
    setSubscriptionTunnelUrl('')
    expiryAtRef.current = null
    setExpiryMinutesRemaining(null)
    _cachedSubscriptionState = null
  }, [])

  /** Compute minutes remaining from expiresAt string */
  const calcMinutesRemaining = (expiresAt: string): number => {
    return Math.max(0, (new Date(expiresAt).getTime() - Date.now()) / 60000)
  }

  const startStatusPolling = useCallback((plan: string) => {
    if (statusPollRef.current) return

    const isDaily = plan === 'daily'
    const pollInterval = isDaily ? 60000 : 3600000

    const poll = async () => {
      const status = await window.api.subscription.checkStatus()
      if (!status) {
        // null = token expired (401, already logged out by manager) OR network error.
        // Only force logout if manager already cleared session (401 case).
        const session = await window.api.subscription.getSession()
        if (!session.isLoggedIn) {
          forceExpiredLogout()
        }
        // Network error: do nothing, let local countdown continue but don't force logout
        return
      }

      setSubscriptionExpiry(status.expiresAt)
      expiryAtRef.current = status.expiresAt
      if (status.plan) setSubscriptionPlan(status.plan)

      if (status.status === 'expired' || status.status === 'suspended') {
        forceExpiredLogout()
        return
      }

      // Update remaining from server (authoritative, replaces local estimate)
      setExpiryMinutesRemaining(calcMinutesRemaining(status.expiresAt))

      // Update proxy/exitIp if server pushed new values (admin changed account config)
      if (status.proxyUrl) {
        const store = useSettingsStore.getState()
        const oldUrl = store.proxyUrl
        store.setProxyUrl(status.proxyUrl)
        if (status.proxyRegion) store.setProxyRegion(status.proxyRegion)
        // If proxy URL changed while TUN is running, force reconnect
        if (oldUrl && oldUrl !== status.proxyUrl) {
          console.log(`[StatusPoll] proxyUrl changed, triggering TUN reconnect`)
          setTunOk(false) // Shows TunGate overlay which will reconnect
          await window.api.tun.stop()
          await window.api.pty.killAll()
        }
      }
      if (status.exitIp) {
        setSubscriptionExitIp(status.exitIp)
      }
      // Propagate admin-side tunnelUrl changes (add/remove) to React state so
      // the next startTun/reconnect uses the current value. Session.json is
      // already updated by subscription-manager.checkStatus; this mirrors that
      // to the in-memory state that feeds TunGate.
      if (status.tunnelUrl !== undefined) {
        setSubscriptionTunnelUrl(status.tunnelUrl || '')
      }
    }

    // Seed countdown immediately from stored expiresAt (before first poll)
    if (isDaily) {
      const session = window.api.subscription.getSession()
      session.then(s => {
        if (s.session?.expiresAt) {
          setExpiryMinutesRemaining(calcMinutesRemaining(s.session.expiresAt))
        }
      })
    }

    // Initial poll (will correct the seed value with server truth)
    poll()
    statusPollRef.current = setInterval(poll, pollInterval)

    // Local countdown — ticks every 30s, uses expiresAt-based calculation
    if (isDaily) {
      countdownRef.current = setInterval(async () => {
        setExpiryMinutesRemaining(prev => {
          if (prev === null) return null
          const next = prev - 0.5
          return next <= 0 ? 0 : next
        })
        // Check expiry using ref (avoids stale state read)
        const expiresAt = expiryAtRef.current
        if (!expiresAt) return
        const msRemaining = new Date(expiresAt).getTime() - Date.now()
        if (msRemaining <= 0) {
          const status = await window.api.subscription.checkStatus()
          if (status && (status.status === 'expired' || status.status === 'suspended')) {
            forceExpiredLogout()
          } else if (status) {
            setExpiryMinutesRemaining(calcMinutesRemaining(status.expiresAt))
            expiryAtRef.current = status.expiresAt
          } else {
            setExpiryMinutesRemaining(5)
          }
        }
      }, 30000)
    }
  }, [forceExpiredLogout])

  const checkCliAndProceed = useCallback(async () => {
    console.log('[checkCli] start')
    const info = await window.api.cli.getInfo()
    console.log('[checkCli] cli:', info.installed, info.version)
    setCliInfo(info.installed, info.version)

    if (!info.installed) {
      console.log('[checkCli] installing CLI...')
      await startInstall()
      const newInfo = await window.api.cli.getInfo()
      if (!newInfo.installed) { console.log('[checkCli] CLI install failed'); return }
    } else {
      const toolsInstalled = await window.api.tools.isAllInstalled()
      console.log('[checkCli] tools installed:', toolsInstalled)
      if (!toolsInstalled) {
        console.log('[checkCli] installing tools...')
        await startToolsInstall()
        console.log('[checkCli] tools install done')
      }
    }

    console.log('[checkCli] → ready')
    setPhase('ready')

    // Background: ensure Codex CLI is installed too. Best-effort, non-blocking,
    // idempotent. If the user already has it we skip. Failures (no network,
    // OSS down) are logged but don't affect Claude's flow.
    void (async () => {
      try {
        const codex = await window.api.cli.getInfo('codex')
        if (codex.installed) return
        console.log('[checkCli] installing Codex CLI (background)...')
        const r = await window.api.cli.install('codex')
        if (!r.success) console.warn('[checkCli] codex install failed:', r.error)
        else console.log('[checkCli] codex installed')
      } catch (err) {
        console.warn('[checkCli] codex install threw:', err)
      }
    })()
  }, [setCliInfo, setPhase])

  const handleNewTab = useCallback(async (cwd?: string) => {
    console.log(`[handleNewTab] tunOkRef=${tunOkRef.current} cwd=${cwd}`)
    // Block new sessions if TUN is not connected
    if (!tunOkRef.current) {
      console.warn('[handleNewTab] BLOCKED — tunOkRef is false')
      return
    }

    const targetCwd = cwd || (tabs.length > 0 ? tabs[tabs.length - 1].cwd : DEFAULT_CWD)

    // Open a plain shell — user picks `claude` or `codex` themselves.
    // Both binaries are on PATH (see main/index.ts engine PATH injection).
    const result = await window.api.pty.create({
      cwd: targetCwd,
      launchClaude: false,
    })

    if (result.error || !result.id) {
      console.error(`[handleNewTab] pty.create failed:`, result.error || 'no id returned')
      return
    }

    const id = crypto.randomUUID()
    const title = pathBasename(targetCwd)
    addTab({ id, ptyId: result.id, title, cwd: targetCwd })

    // Persist to recent projects
    saveRecentProject(targetCwd)
  }, [tabs, addTab])

  useEffect(() => { handleNewTabRef.current = handleNewTab }, [handleNewTab])

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId)
      if (tab?.isExited || tabs.length <= 1) {
        if (tab?.ptyId) window.api.pty.kill(tab.ptyId)
        removeTab(tabId)
        setPendingCloseTabId(null)
        return
      }
      if (pendingCloseTabId === tabId) {
        if (tab?.ptyId) window.api.pty.kill(tab.ptyId)
        removeTab(tabId)
        setPendingCloseTabId(null)
        if (pendingCloseTimerRef.current) clearTimeout(pendingCloseTimerRef.current)
        return
      }
      setPendingCloseTabId(tabId)
      if (pendingCloseTimerRef.current) clearTimeout(pendingCloseTimerRef.current)
      pendingCloseTimerRef.current = setTimeout(() => setPendingCloseTabId(null), 3000)
    },
    [tabs, removeTab, pendingCloseTabId]
  )

  const handleSelectDirectory = useCallback(async () => {
    const dir = await window.api.shell.selectDirectory()
    if (dir) handleNewTab(dir)
  }, [handleNewTab])

  useEffect(() => {
    return () => {
      if (pendingCloseTimerRef.current) clearTimeout(pendingCloseTimerRef.current)
      if (statusPollRef.current) clearInterval(statusPollRef.current)
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [])

  // Menu keyboard shortcuts
  useEffect(() => {
    const unsubs = [
      window.api.menu.onNewTab(() => handleSelectDirectory()),
      window.api.menu.onCloseTab(() => {
        if (activeTabId) handleCloseTab(activeTabId)
      }),
      window.api.menu.onSwitchTab((index) => {
        if (tabs[index]) setActiveTab(tabs[index].id)
      }),
      window.api.menu.onOpenFolder((path) => handleNewTab(path))
    ]
    return () => unsubs.forEach(fn => { try { fn?.() } catch { /* ignore */ } })
  }, [handleSelectDirectory, handleCloseTab, activeTabId, tabs, setActiveTab])

  // Mark tabs as exited when PTY exits
  useEffect(() => {
    const unsub = window.api.pty.onExit((event) => {
      const { updateTab } = useTerminalStore.getState()
      const tab = useTerminalStore.getState().tabs.find(t => t.ptyId === event.id)
      if (tab) updateTab(tab.id, { isExited: true })
    })
    return () => { unsub() }
  }, [])

  // App auto-update status listener
  useEffect(() => {
    const unsub = window.api.appUpdate.onStatus((status) => {
      setAppUpdateStatus(status)
      // Auto-show toast when status changes to actionable states
      if (status.type === 'available' || status.type === 'downloaded' || status.type === 'downloading' || status.type === 'error') {
        setAppUpdateDismissed(false)
      }
    })
    // Periodic re-check every 2 hours
    const recheckTimer = setInterval(() => {
      window.api.appUpdate.check()
    }, 2 * 60 * 60 * 1000)
    return () => { unsub(); clearInterval(recheckTimer) }
  }, [])

  // Network status push — keeps useNetworkStore in sync with sing-box
  // manager state so the StatusBar indicator always shows current latency.
  useEffect(() => {
    const unsub = window.api.tun.onStatusUpdate((update) => {
      useNetworkStore.getState().applyStatusUpdate(update)
    })
    return () => { unsub() }
  }, [])

  // Desktop notifications
  useEffect(() => {
    const unsub = window.api.notification.onShouldShow(() => {
      const settings = useSettingsStore.getState()
      if (!settings.notificationsEnabled) return
      window.api.notification.show('Task Complete', 'Claude Code has finished the task.')
    })
    return () => { unsub() }
  }, [])

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setShowCommandPalette(prev => !prev)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        const { sidebarCollapsed, setSidebarCollapsed } = useSettingsStore.getState()
        setSidebarCollapsed(!sidebarCollapsed)
      }
      // Cmd+Shift+H: open session history
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        setShowHistory(prev => !prev)
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        setShowStats(prev => !prev)
      }
      // Cmd+Shift+L: toggle chat drawer
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        useSettingsStore.getState().toggleChatDrawer()
      }
      // Cmd+Shift+1~5: open pinned project
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key >= '1' && e.key <= '5') {
        e.preventDefault()
        const idx = parseInt(e.key) - 1
        const { pinnedProjects } = useSettingsStore.getState()
        if (pinnedProjects[idx]) {
          const dir = pinnedProjects[idx]
          const store = useTerminalStore.getState()
          const existing = store.tabs.find(t => t.cwd === dir)
          if (existing) {
            store.setActiveTab(existing.id)
          } else {
            handleNewTabRef.current(dir)
          }
        }
      }
      if (e.shiftKey && e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
        const active = document.activeElement
        if (active?.closest('.xterm') || active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return
        e.preventDefault()
        const store = useTerminalStore.getState()
        const tab = store.tabs.find(t => t.id === store.activeTabId)
        if (!tab?.ptyId || tab.isRunning) return
        const modes = ['suggest', 'autoedit', 'fullauto'] as const
        const cmds: Record<string, string> = { suggest: '/permissions suggest\n', autoedit: '/permissions auto-edit\n', fullauto: '/permissions full-auto\n' }
        const idx = modes.indexOf((tab.mode || 'suggest') as any)
        const next = modes[(idx + 1) % modes.length]
        window.api.pty.write(tab.ptyId, cmds[next])
        store.updateTab(tab.id, { mode: next })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Listen for system theme changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = () => applyTheme(useSettingsStore.getState().theme)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // --- Drag & Drop ---
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setDragOver(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return

    for (const file of files) {
      const filePath = window.api.getPathForFile(file)
      if (!filePath) continue

      const isDir = await window.api.fs.isDirectory(filePath)
      if (isDir) {
        // Directory → new tab
        handleNewTab(filePath)
      } else {
        // File → insert path into active PTY
        const store = useTerminalStore.getState()
        const activeTab = store.tabs.find(t => t.id === store.activeTabId)
        if (activeTab?.ptyId) {
          const escaped = filePath.includes(' ') ? `"${filePath}"` : filePath
          window.api.pty.write(activeTab.ptyId, escaped)
        }
      }
    }
  }, [handleNewTab])

  const plainTitleBar = (
    <div
      className="titlebar-drag"
      style={{
        height: 38, background: 'var(--bg-secondary)', display: 'flex',
        alignItems: 'center', padding: '0 16px',
        borderBottom: '1px solid var(--border)', flexShrink: 0
      }}
    >
      {isMac && <div style={{ width: 70 }} />}
      <div style={{ flex: 1, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
        {t('app.title')}
      </div>
      {isMac && <div style={{ width: 70 }} />}
    </div>
  )

  // Determine which layer to show as main content
  const showLogin = subscriptionLoggedIn === false
  const showLoading = subscriptionLoggedIn === null
  const showSetup = subscriptionLoggedIn === true && (phase === 'checking' || phase === 'installing' || phase === 'error')
  const showTerminal = subscriptionLoggedIn === true && phase === 'ready'

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}
      onDragEnter={showTerminal ? handleDragEnter : undefined}
      onDragLeave={showTerminal ? handleDragLeave : undefined}
      onDragOver={showTerminal ? handleDragOver : undefined}
      onDrop={showTerminal ? handleDrop : undefined}
    >
      {/* === Layer 0: Login / Loading / Setup === */}
      {showLogin && (
        <>
          {plainTitleBar}
          <LoginPage onLoginSuccess={handleSubscriptionLogin} />
        </>
      )}
      {showLoading && (
        <>
          {plainTitleBar}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-primary)' }}>
            <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.75s linear infinite' }} />
          </div>
        </>
      )}
      {showSetup && (
        <>
          {plainTitleBar}
          <SetupScreen />
        </>
      )}

      {/* === Layer 1: Terminal UI (renders when ready, stays mounted on TUN disconnect) === */}
      {showTerminal && (
        <>
      {/* Drag overlay */}
      {dragOver && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(139, 115, 85, 0.08)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
          animation: 'fadeIn 0.15s ease-out',
        }}>
          <div style={{
            padding: '32px 48px', borderRadius: 16,
            border: '2px dashed var(--accent)',
            background: 'var(--bg-secondary)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              <line x1="12" y1="11" x2="12" y2="17" /><polyline points="9 14 12 11 15 14" />
            </svg>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('drag.dropToOpen')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('drag.hint')}
            </div>
          </div>
        </div>
      )}
      <TitleTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        pendingCloseTabId={pendingCloseTabId}
        onSelect={setActiveTab}
        onClose={handleCloseTab}
        onNew={handleSelectDirectory}
        onCommandPalette={() => setShowCommandPalette(true)}
        onSettings={() => { setShowSettings(true); window.api.analytics?.track('settings_open') }}
        onToggleChat={() => useSettingsStore.getState().toggleChatDrawer()}
        chatDrawerOpen={chatDrawerOpen}
      />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar
          onSettings={() => { setShowSettings(true); window.api.analytics?.track('settings_open') }}
          onNewSession={handleSelectDirectory}
          onCommandPalette={() => setShowCommandPalette(true)}
          onStats={() => setShowStats(true)}
          onFileClick={(path) => setPreviewFile(path)}
          onOpenProject={(cwd) => {
            const existing = tabs.find(t => t.cwd === cwd)
            if (existing) {
              setActiveTab(existing.id)
            } else {
              handleNewTab(cwd)
            }
          }}
        />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {showHistory ? (
            <HistoryView
              onClose={() => setShowHistory(false)}
              onOpenProject={(cwd) => { setShowHistory(false); handleNewTab(cwd) }}
            />
          ) : tabs.length === 0 ? (
            <WelcomeScreen onOpenFolder={handleSelectDirectory} onOpenProject={handleNewTab} />
          ) : (
            <>
              <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex' }}>
                <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'var(--terminal-bg, var(--bg-primary))' }}>
                  {tabs.map((tab) => (
                    <TerminalView
                      key={tab.id}
                      ptyId={tab.ptyId}
                      isActive={tab.id === activeTabId}
                      cwd={tab.cwd}
                      onFileClick={(path) => setPreviewFile(path)}
                    />
                  ))}
                </div>
                {previewFile && (
                  <FilePreview
                    filePath={previewFile}
                    cwd={tabs.find(t => t.id === activeTabId)?.cwd || DEFAULT_CWD}
                    onClose={() => setPreviewFile(null)}
                  />
                )}
              </div>
              <StatusBar expiryMinutesRemaining={expiryMinutesRemaining} subscriptionPlan={subscriptionPlan} />
            </>
          )}
        </div>
        {chatDrawerOpen && (
          <ChatErrorBoundary onFallbackToCliMode={() => setChatDrawerOpen(false)}>
            <ChatDrawer onClose={() => setChatDrawerOpen(false)} />
          </ChatErrorBoundary>
        )}
      </div>
      </>
      )}

      {/* === TunGate overlay — renders independently when logged in but TUN not ready === */}
      {subscriptionLoggedIn && !tunOk && (
        <TunGate
          proxyUrl={proxyUrl}
          tunnelUrl={subscriptionTunnelUrl}
          exitIp={subscriptionExitIp}
          isReconnect={tunWasOkRef.current}
          onReady={() => {
            console.log(`[App] TunGate onReady (reconnect=${tunWasOkRef.current})`)
            setTunOk(true)
            if (!tunWasOkRef.current) {
              // First connection: full initialization
              checkCliAndProceed()
              window.api.browser.open('https://browserleaks.com/ip').catch(() => {})
              window.api.browserSync.startPeriodicUpload().catch(() => {})
            }
            // Run network diagnostics after TUN is ready
            window.api.tun.diagnostics().then(r => {
              console.log('[App] Network diagnostics:', JSON.stringify(r, null, 2))
            }).catch(() => {})
          }}
          onRefreshConfig={handleRefreshConfig}
          onSwitchAccount={handleSwitchAccount}
        />
      )}

      {showStats && <StatsView onClose={() => setShowStats(false)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} onLogout={() => { setShowSettings(false); forceExpiredLogout() }} onTunStatusChange={setTunOk} />}
      {showCommandPalette && (
        <CommandPalette
          onClose={() => setShowCommandPalette(false)}
          onNewTab={handleSelectDirectory}
          onSettings={() => { setShowCommandPalette(false); setShowSettings(true) }}
          onToggleTheme={() => {
            const { theme, setTheme } = useSettingsStore.getState()
            setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'auto' : 'dark')
          }}
        />
      )}
      {appUpdateStatus && !appUpdateDismissed && appUpdateStatus.type === 'available' && (
        <AppUpdateToast
          status={appUpdateStatus}
          bottomOffset={16}
          onDownload={() => {
            const v = appUpdateStatus.version || ''
            const url = `https://download.inkessai.com/code-releases/latest/macos-arm64-v${v}.dmg`
            window.api.shell.openExternal(url)
          }}
          onDismiss={() => setAppUpdateDismissed(true)}
        />
      )}
      {networkAlert && (
        <NetworkAlertToast
          type={networkAlert.type}
          message={networkAlert.message}
          actionLabel={networkAlert.actionLabel}
          onAction={networkAlert.onAction}
          onDismiss={() => setNetworkAlert(null)}
          bottomOffset={appUpdateStatus && !appUpdateDismissed ? 88 : 16}
        />
      )}
    </div>
  )
}

// --- Recent projects persistence ---

const RECENT_PROJECTS_KEY = 'inkess-recent-projects'
const MAX_RECENT = 10

function saveRecentProject(cwd: string) {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY)
    const list: string[] = raw ? JSON.parse(raw) : []
    const filtered = list.filter(p => p !== cwd)
    filtered.unshift(cwd)
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(filtered.slice(0, MAX_RECENT)))
  } catch { /* ignore */ }
}

export function getRecentProjects(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

// --- Sub-components ---

import type { TerminalTab } from './stores/terminal'

function TitleTabBar({ tabs, activeTabId, onSelect, onClose, onNew, pendingCloseTabId, onCommandPalette, onSettings, onToggleChat, chatDrawerOpen }: {
  tabs: TerminalTab[]; activeTabId: string | null; pendingCloseTabId: string | null
  onSelect: (id: string) => void; onClose: (id: string) => void; onNew: () => void
  onCommandPalette?: () => void; onSettings?: () => void
  onToggleChat?: () => void; chatDrawerOpen?: boolean
}) {
  const [hoveredTab, setHoveredTab] = useState<string | null>(null)
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const { t } = useI18n()

  return (
    <div
      className="titlebar-drag"
      style={{
        height: 38, background: 'var(--bg-secondary)', display: 'flex',
        alignItems: 'stretch', borderBottom: '1px solid var(--border)', flexShrink: 0,
        padding: '0 8px'
      }}
    >
      {isMac && <div style={{ width: 70 }} />}
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId
        const isHovered = tab.id === hoveredTab
        const isPendingClose = tab.id === pendingCloseTabId
        return (
          <div
            key={tab.id}
            className="titlebar-no-drag"
            onClick={() => onSelect(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
            }}
            onMouseEnter={() => setHoveredTab(tab.id)}
            onMouseLeave={() => setHoveredTab(null)}
            title={shortenPath(tab.cwd)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', fontSize: 12,
              color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
              cursor: 'pointer',
              background: isActive ? 'var(--bg-hover)' : 'transparent',
              borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              transition: 'background 0.12s',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            {tab.title}
            {tabs.length > 1 && (
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <span
                  onClick={(e) => { e.stopPropagation(); onClose(tab.id) }}
                  style={{
                    width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: 4, fontSize: 14, marginLeft: 2,
                    opacity: (isHovered || isActive || isPendingClose) ? 0.7 : 0,
                    background: isPendingClose ? 'var(--error)' : 'transparent',
                    color: isPendingClose ? '#fff' : 'var(--text-muted)',
                    transition: 'opacity 0.15s, background 0.15s, color 0.15s',
                  }}
                  onMouseEnter={(e) => { if (!isPendingClose) { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'var(--bg-active)' } }}
                  onMouseLeave={(e) => { if (!isPendingClose) { e.currentTarget.style.opacity = (isHovered || isActive) ? '0.7' : '0'; e.currentTarget.style.background = 'transparent' } }}
                >×</span>
                {isPendingClose && (
                  <span style={{
                    position: 'absolute', top: -28, left: '50%', transform: 'translateX(-50%)',
                    background: 'var(--bg-active)', color: 'var(--text-primary)',
                    padding: '2px 8px', borderRadius: 4, fontSize: 11, whiteSpace: 'nowrap',
                    animation: 'slideUp 0.15s ease-out',
                  }}>
                    {t('tab.pressAgainToClose')}
                  </span>
                )}
              </span>
            )}
          </div>
        )
      })}
      <div
        className="titlebar-no-drag"
        onClick={onNew}
        onMouseEnter={() => setHoveredBtn('new')}
        onMouseLeave={() => setHoveredBtn(null)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, alignSelf: 'center',
          color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16,
          borderRadius: 6,
          background: hoveredBtn === 'new' ? 'var(--bg-hover)' : 'transparent',
          transition: 'background 0.12s',
        }}
      >+</div>
      <div style={{ flex: 1 }} />
      <div className="titlebar-no-drag" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <div
          onClick={onCommandPalette}
          onMouseEnter={() => setHoveredBtn('cmd')}
          onMouseLeave={() => setHoveredBtn(null)}
          title="Commands (⌘K)"
          style={{
            width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 6, cursor: 'pointer', color: 'var(--text-muted)',
            background: hoveredBtn === 'cmd' ? 'var(--bg-hover)' : 'transparent',
            transition: 'background 0.12s',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>
        <div
          onClick={onSettings}
          onMouseEnter={() => setHoveredBtn('settings')}
          onMouseLeave={() => setHoveredBtn(null)}
          title="Settings"
          style={{
            width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 6, cursor: 'pointer', color: 'var(--text-muted)',
            background: hoveredBtn === 'settings' ? 'var(--bg-hover)' : 'transparent',
            transition: 'background 0.12s',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </div>
        <div
          onClick={onToggleChat}
          onMouseEnter={() => setHoveredBtn('chat')}
          onMouseLeave={() => setHoveredBtn(null)}
          title={`Chat (${isMac ? '⌘' : 'Ctrl+'}⇧L)`}
          className="titlebar-no-drag"
          style={{
            width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 6, cursor: 'pointer',
            color: chatDrawerOpen ? 'var(--accent)' : 'var(--text-muted)',
            background: chatDrawerOpen ? 'var(--accent-subtle)' : hoveredBtn === 'chat' ? 'var(--bg-hover)' : 'transparent',
            transition: 'background 0.12s, color 0.12s',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
        </div>
        {!isMac && <>
          <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
          {[
            { id: 'min', title: 'Minimize', action: () => window.api.window.minimize(), icon: <rect x="3" y="11" width="18" height="2" rx="1" /> },
            { id: 'max', title: 'Maximize', action: () => window.api.window.maximize(), icon: <rect x="3" y="3" width="18" height="18" rx="2" /> },
            { id: 'close', title: 'Close', action: () => window.api.window.close(), icon: <><line x1="4" y1="4" x2="20" y2="20" /><line x1="20" y1="4" x2="4" y2="20" /></> },
          ].map(({ id, title, action, icon }) => (
            <div
              key={id}
              onClick={action}
              onMouseEnter={() => setHoveredBtn(id)}
              onMouseLeave={() => setHoveredBtn(null)}
              title={title}
              style={{
                width: 40, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', color: id === 'close' && hoveredBtn === 'close' ? '#fff' : 'var(--text-muted)',
                background: hoveredBtn === id ? (id === 'close' ? '#e81123' : 'var(--bg-hover)') : 'transparent',
                transition: 'background 0.12s, color 0.12s',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill={id === 'max' ? 'none' : 'none'} stroke="currentColor" strokeWidth="2">
                {icon}
              </svg>
            </div>
          ))}
        </>}
      </div>
      {contextMenu && (
        <TabContextMenu
          tab={tabs.find(t => t.id === contextMenu.tabId)!}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => { onClose(contextMenu.tabId); setContextMenu(null) }}
          onDismiss={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

function TabContextMenu({ tab, x, y, onClose, onDismiss }: {
  tab: TerminalTab; x: number; y: number
  onClose: () => void; onDismiss: () => void
}) {
  const { t } = useI18n()
  const ideChoice = useSettingsStore((s) => s.ideChoice)
  const [hoveredItem, setHoveredItem] = useState<string | null>(null)

  const ideScheme = IDE_SCHEMES[ideChoice] || 'vscode://'
  const ideName = ideChoice === 'vscode' ? 'VS Code' : ideChoice === 'cursor' ? 'Cursor' : 'Zed'

  useEffect(() => {
    const handler = () => onDismiss()
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [onDismiss])

  const menuItems: { key: string; label: string; onClick: () => void; separator?: boolean }[] = [
    {
      key: 'finder',
      label: isMac ? t('tab.openInFinder') : t('tab.openInExplorer'),
      onClick: () => { window.api.shell.openPath(tab.cwd); onDismiss() }
    },
    {
      key: 'ide',
      label: t('tab.openInIde', { ide: ideName }),
      onClick: () => { window.api.shell.openExternal(`${ideScheme}file/${tab.cwd}`); onDismiss() }
    },
    {
      key: 'copy',
      label: t('tab.copyPath'),
      onClick: () => { window.api.clipboard.writeText(tab.cwd); onDismiss() }
    },
    {
      key: 'close',
      label: t('tab.closeTab'),
      separator: true,
      onClick: onClose
    }
  ]

  return (
    <div
      style={{
        position: 'fixed', left: x, top: y, zIndex: 9999,
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 6, padding: '4px 0', minWidth: 180,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)', fontSize: 13
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {menuItems.map((item) => (
        <div key={item.key}>
          {item.separator && (
            <div style={{ height: 1, background: 'var(--border)', margin: '4px 8px' }} />
          )}
          <div
            onClick={item.onClick}
            onMouseEnter={() => setHoveredItem(item.key)}
            onMouseLeave={() => setHoveredItem(null)}
            style={{
              padding: '6px 16px', cursor: 'pointer',
              color: 'var(--text-primary)',
              background: hoveredItem === item.key ? 'var(--bg-hover)' : 'transparent',
              transition: 'background 0.1s'
            }}
          >
            {item.label}
          </div>
        </div>
      ))}
    </div>
  )
}

function WelcomeScreen({ onOpenFolder, onOpenProject }: { onOpenFolder: () => void; onOpenProject: (cwd: string) => void }) {
  const { t } = useI18n()
  const [hovered, setHovered] = useState<string | null>(null)
  const recentDirs = getRecentProjects()

  const cards = [
    ...(recentDirs.length > 0
      ? [{
          key: 'recent',
          icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
          ),
          title: t('welcome.cardRecent'),
          desc: t('welcome.cardRecentDesc'),
          onClick: () => onOpenProject(recentDirs[0]),
        }]
      : []),
    {
      key: 'open',
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        </svg>
      ),
      title: t('welcome.cardNew'),
      desc: t('welcome.cardNewDesc'),
      onClick: onOpenFolder,
    },
  ]

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 16, padding: 32
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: 16, background: 'var(--accent-subtle)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4
      }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5">
          <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      </div>

      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          {t('welcome.letsBuild')}
        </div>
        <div
          onClick={onOpenFolder}
          onMouseEnter={() => setHovered('title')}
          onMouseLeave={() => setHovered(null)}
          style={{
            fontSize: 15, color: 'var(--text-muted)', cursor: 'pointer',
            opacity: hovered === 'title' ? 0.8 : 1, transition: 'opacity 0.15s',
          }}
        >
          {t('welcome.openProject')} <span style={{ fontSize: 12 }}>▾</span>
        </div>
      </div>

      <div style={{
        display: 'flex', gap: 12, marginTop: 24, marginBottom: 16, flexWrap: 'wrap', justifyContent: 'center'
      }}>
        {cards.map((card) => (
          <div
            key={card.key}
            onClick={card.onClick}
            onMouseEnter={() => setHovered(card.key)}
            onMouseLeave={() => setHovered(null)}
            style={{
              width: 200, padding: '16px 16px 14px', borderRadius: 10,
              border: '1px solid var(--border)', cursor: 'pointer',
              background: hovered === card.key ? 'var(--bg-hover)' : 'transparent',
              transform: hovered === card.key ? 'translateY(-2px)' : 'none',
              boxShadow: hovered === card.key ? '0 4px 12px rgba(0,0,0,0.15)' : 'none',
              transition: 'all 0.2s ease',
            }}
          >
            <div style={{ marginBottom: 10 }}>{card.icon}</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 3 }}>{card.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{card.desc}</div>
          </div>
        ))}
      </div>

      {recentDirs.length > 0 && (
        <div style={{ width: '100%', maxWidth: 420, marginTop: 8 }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8
          }}>
            {t('welcome.recentProjects')}
          </div>
          {recentDirs.map((dir) => (
            <div
              key={dir}
              onClick={() => onOpenProject(dir)}
              onMouseEnter={() => setHovered(dir)}
              onMouseLeave={() => setHovered(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: 8,
                borderRadius: 6, cursor: 'pointer', fontSize: 13,
                color: hovered === dir ? 'var(--text-primary)' : 'var(--text-secondary)',
                background: hovered === dir ? 'var(--bg-hover)' : 'transparent',
                transition: 'background 0.12s, color 0.12s',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              </svg>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {shortenPath(dir)}
              </span>
            </div>
          ))}
        </div>
      )}

      {recentDirs.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {t('welcome.noRecent')}
        </div>
      )}

      {/* Keyboard shortcut hints */}
      <div style={{
        display: 'flex', gap: 16, marginTop: 24, fontSize: 11, color: 'var(--text-muted)',
      }}>
        <span><kbd style={kbdStyle}>⌘K</kbd> {t('welcome.hintCommands')}</span>
        <span><kbd style={kbdStyle}>⇧Tab</kbd> {t('welcome.hintMode')}</span>
        <span><kbd style={kbdStyle}>⌘F</kbd> {t('welcome.hintSearch')}</span>
      </div>
    </div>
  )
}

const kbdStyle: React.CSSProperties = {
  display: 'inline-block', padding: '1px 5px', borderRadius: 3,
  border: '1px solid var(--border)', background: 'var(--bg-tertiary)',
  fontFamily: 'inherit', fontSize: 10, lineHeight: '16px',
}

function AppUpdateToast({ status, bottomOffset, onDownload, onDismiss }: {
  status: { type: string; version?: string }
  bottomOffset?: number
  onDownload?: () => void; onDismiss: () => void
}) {
  const { t } = useI18n()
  const version = status.version || ''
  const btnStyle: React.CSSProperties = {
    padding: '4px 12px', borderRadius: 4, border: 'none',
    background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
  }
  return (
    <div style={{
      position: 'fixed', bottom: bottomOffset ?? 16, right: 16, background: 'var(--bg-secondary)',
      border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px',
      display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--text-primary)',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)', zIndex: 1000, minWidth: 260, maxWidth: 340,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ flex: 1 }}>{t('appUpdate.available', { version })}</span>
        <button onClick={onDownload} style={btnStyle}>{t('appUpdate.download')}</button>
        <span onClick={onDismiss} style={{ cursor: 'pointer', opacity: 0.5, fontSize: 16, lineHeight: 1 }}>×</span>
      </div>
    </div>
  )
}

/**
 * Foreground toast for connectivity issues detected by the ipCheck loop.
 * Lives above AppUpdateToast (bottomOffset is computed by caller).
 * Color: warning (yellow) on first notice, error (red) once we've given up.
 */
function NetworkAlertToast({ type, message, actionLabel, onAction, onDismiss, bottomOffset }: {
  type: 'warning' | 'error'
  message: string
  actionLabel?: string
  onAction?: () => void
  onDismiss: () => void
  bottomOffset: number
}) {
  const accentColor = type === 'error' ? 'var(--error, #ef4444)' : 'var(--warning-text, #f59e0b)'
  const btnStyle: React.CSSProperties = {
    padding: '4px 12px', borderRadius: 4, border: 'none',
    background: accentColor, color: '#fff', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
  }
  return (
    <div style={{
      position: 'fixed', bottom: bottomOffset, right: 16,
      background: 'var(--bg-secondary)',
      border: `1px solid ${accentColor}`,
      borderRadius: 8, padding: '12px 16px',
      display: 'flex', alignItems: 'center', gap: 12,
      fontSize: 13, color: 'var(--text-primary)',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)', zIndex: 1000, minWidth: 260, maxWidth: 360,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%', background: accentColor,
        flexShrink: 0,
        animation: type === 'error' ? 'pulse 1s infinite' : undefined,
      }} />
      <span style={{ flex: 1 }}>{message}</span>
      {actionLabel && onAction && (
        <button onClick={() => { onAction(); onDismiss() }} style={btnStyle}>{actionLabel}</button>
      )}
      <span onClick={onDismiss} style={{ cursor: 'pointer', opacity: 0.5, fontSize: 16, lineHeight: 1 }}>×</span>
    </div>
  )
}
