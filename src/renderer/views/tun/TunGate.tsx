import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { useSettingsStore } from '../../stores/settings'

type Phase = 'idle' | 'installing' | 'resolving' | 'starting' | 'testing' | 'connected' | 'failed'

interface TunGateProps {
  proxyUrl: string
  tunnelUrl?: string
  exitIp: string
  onReady: () => void
  isReconnect: boolean
  onRefreshConfig?: () => void
  onSwitchAccount?: () => void
}

const WORKING_PHASES: Phase[] = ['idle', 'installing', 'resolving', 'starting', 'testing']

export function TunGate({ proxyUrl, tunnelUrl, exitIp, onReady, isReconnect, onRefreshConfig, onSwitchAccount }: TunGateProps) {
  const { t } = useI18n()
  const { useHelper, setUseHelper } = useSettingsStore()
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [latency, setLatency] = useState<number | null>(null)
  const proxyUrlRef = useRef(proxyUrl)
  const tunnelUrlRef = useRef(tunnelUrl)
  const connectingRef = useRef(false)
  useEffect(() => { proxyUrlRef.current = proxyUrl }, [proxyUrl])
  useEffect(() => { tunnelUrlRef.current = tunnelUrl }, [tunnelUrl])

  const [isAuthDenied, setIsAuthDenied] = useState(false)

  const connect = async (manualRetry = false) => {
    if (connectingRef.current) return
    connectingRef.current = true
    setPhase('idle')
    setError(null)
    setIsAuthDenied(false)
    // If user explicitly clicked Retry, clear the auth cooldown so the
    // next startTun will actually prompt for password instead of being blocked.
    if (manualRetry) {
      await window.api.tun.clearAuthCooldown().catch(() => {})
    }
    try { await _connect() } finally { connectingRef.current = false }
  }

  const _connect = async () => {
    const id = Math.random().toString(36).slice(2, 6)
    console.log(`[TunGate:${id}] connect start`)
    setPhase('idle')
    setError(null)
    setLatency(null)

    try {
      // Check if TUN already running
      const info = await window.api.tun.getInfo()
      console.log(`[TunGate:${id}] getInfo: tunRunning=${info.tunRunning}, installed=${info.installed}, reachable=${info.internetReachable}`)

      if (info.tunRunning && info.internetReachable) {
        // Already running and tested — skip directly
        console.log(`[TunGate:${id}] already connected, calling onReady`)
        setLatency(info.latencyMs)
        setPhase('connected')
        setTimeout(() => onReady(), 300)
        return
      }

      if (info.tunRunning) {
        // Running but not tested — test connectivity
        setPhase('testing')
        console.log(`[TunGate:${id}] TUN running, testing connectivity...`)
        const result = await window.api.tun.testConnectivity(exitIp)
        console.log(`[TunGate:${id}] testConnectivity: success=${result.success}, latency=${result.latency}, actualIp=${result.actualIp}`)
        if (result.success) {
          setLatency(result.latency ?? null)
          setPhase('connected')
          setTimeout(() => onReady(), 300)
          return
        }
        // Probe failed. Before tearing down a possibly-working tunnel, check
        // whether sing-box itself has been moving real traffic recently — if
        // so, our probe targets just happened to be blocked / throttled and
        // the tunnel is in fact fine. Restarting in that case interrupts
        // active conversations and triggers another sudo prompt.
        //
        // Exception: if the failure is an exit-IP MISMATCH, that's a real
        // route hijack — we DO want to restart. testConnectivity returns
        // actualIp on mismatch, so we can distinguish.
        const isMismatch = !!result.actualIp && !!exitIp && result.actualIp !== exitIp
        if (!isMismatch) {
          try {
            const activity = await window.api.tun.recentActivity(30000)
            console.log(`[TunGate:${id}] recent sing-box activity: ${activity.successes} successes / ${activity.failures} failures`)
            if (activity.successes >= 3) {
              console.log(`[TunGate:${id}] tunnel is moving real traffic — accepting as connected despite probe failure`)
              setLatency(null)
              setPhase('connected')
              setTimeout(() => onReady(), 300)
              return
            }
          } catch (err) {
            console.warn(`[TunGate:${id}] recentActivity check failed:`, err)
          }
        }
        // Connectivity test failed AND no real traffic — fall through to restart
        console.log(`[TunGate:${id}] connectivity failed and no recent activity, restarting TUN`)
        await window.api.tun.stop()
      }

      // Install if needed
      if (!info.installed) {
        setPhase('installing')
        console.log(`[TunGate:${id}] installing TUN...`)
        const installResult = await window.api.tun.install()
        if (!installResult.success) {
          setPhase('failed')
          setError(installResult.error ?? 'Installation failed')
          return
        }
      }

      // Resolve subscription URL
      setPhase('resolving')
      console.log(`[TunGate:${id}] resolving URL...`)
      const resolveResult = await window.api.proxy.resolveUrl(proxyUrlRef.current)
      if (resolveResult.error) {
        setPhase('failed')
        setError(resolveResult.error)
        return
      }
      // Auto-set environment region from detected proxy node location
      if (resolveResult.detectedRegion && resolveResult.detectedRegion !== 'auto') {
        console.log(`[TunGate:${id}] auto-setting region: ${resolveResult.detectedRegion}`)
        const { useSettingsStore } = await import('../../stores/settings')
        useSettingsStore.getState().setProxyRegion(resolveResult.detectedRegion)
      }

      // Start TUN (blocks until tunnel confirmed running or fails)
      setPhase('starting')
      const helperPref = useSettingsStore.getState().useHelper
      console.log(`[TunGate:${id}] starting TUN... (useHelper=${helperPref})`)
      const startResult = await window.api.tun.startTun(resolveResult.resolved, tunnelUrlRef.current || undefined, helperPref)
      console.log(`[TunGate:${id}] startTun result: success=${startResult.success}, error=${startResult.error}`)
      if (!startResult.success) {
        setPhase('failed')
        const errMsg = startResult.error || ''
        const isAuth = errMsg.includes('AUTH_DENIED')
        const isOrphan = errMsg.includes('ORPHAN_PROCESS')
        setIsAuthDenied(isAuth || isOrphan)
        setError(isAuth
          ? 'macOS requires administrator password to start the secure tunnel. Click Retry and enter your Mac login password when prompted.'
          : isOrphan
            ? 'A previous tunnel process is still running and could not be terminated (last admin prompt was denied). Click Retry to authorize again.'
            : (errMsg || 'Failed to start TUN'))
        return
      }

      // Test connectivity with retries (routes may take a moment to take effect).
      // Backoff between attempts so the user isn't staring at a 60s wall when
      // probe targets are slow.
      setPhase('testing')
      console.log(`[TunGate:${id}] testing connectivity (up to 3 attempts)...`)
      let connectResult: { success: boolean; latency?: number; error?: string; actualIp?: string } = { success: false }
      const delays = [500, 2000, 4000]
      for (let attempt = 1; attempt <= 3; attempt++) {
        await new Promise(resolve => setTimeout(resolve, delays[attempt - 1]))
        connectResult = await window.api.tun.testConnectivity(exitIp)
        console.log(`[TunGate:${id}] attempt ${attempt}: success=${connectResult.success}, latency=${connectResult.latency}, actualIp=${connectResult.actualIp}`)
        if (connectResult.success) break
      }

      // If all probe attempts failed but sing-box has been moving real traffic
      // (e.g. claude.com was hit during the probe window), accept the tunnel
      // as connected — see the same logic above for tunRunning case.
      if (!connectResult.success) {
        const isMismatch = !!connectResult.actualIp && !!exitIp && connectResult.actualIp !== exitIp
        if (!isMismatch) {
          try {
            const activity = await window.api.tun.recentActivity(30000)
            console.log(`[TunGate:${id}] post-start activity: ${activity.successes} successes / ${activity.failures} failures`)
            if (activity.successes >= 3) {
              console.log(`[TunGate:${id}] tunnel is moving real traffic — accepting as connected despite probe failure`)
              connectResult = { success: true }
            }
          } catch (err) {
            console.warn(`[TunGate:${id}] recentActivity check failed:`, err)
          }
        }
      }

      if (connectResult.success) {
        setLatency(connectResult.latency ?? null)
        setPhase('connected')
        setTimeout(() => onReady(), 300)
      } else {
        setPhase('failed')
        setError(connectResult.error ?? 'Connectivity test failed')
      }
    } catch (err) {
      console.error(`[TunGate:${id}] error:`, err)
      setPhase('failed')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    connect()
    // NOTE: No cancelledRef cleanup — React StrictMode double-mount is handled by
    // the idempotent nature of the operations (startTun skips if already starting,
    // getInfo returns current state). The second mount will detect TUN is already
    // running and skip to connectivity test.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isWorking = WORKING_PHASES.includes(phase) && phase !== 'idle'
  const isConnected = phase === 'connected'
  const isFailed = phase === 'failed'

  const phaseLabel = (() => {
    switch (phase) {
      case 'installing': return t('tun.installing')
      case 'resolving':  return t('tun.resolving')
      case 'starting':   return t('tun.starting')
      case 'testing':    return t('tun.testing')
      case 'connected':  return latency != null ? `${t('tun.connected')} (${latency}ms)` : t('tun.connected')
      case 'failed':     return t('tun.failed')
      default:           return t('tun.testing')
    }
  })()

  const globeColor = isConnected ? '#22c55e' : isFailed ? '#ef4444' : 'var(--accent)'

  return (
    <>
      <style>{`
        @keyframes tun-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      <div style={{
        position: 'fixed', inset: 0, zIndex: 300,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-primary)',
      }}>
        <div style={{
          width: 360, padding: '40px 32px', borderRadius: 16,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          textAlign: 'center',
        }}>
          {/* Globe icon */}
          <div style={{
            width: 64, height: 64, borderRadius: 16,
            background: 'var(--accent-subtle)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
              stroke={globeColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          </div>

          {/* Title */}
          <h2 style={{
            margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary)',
          }}>
            {t('tun.title')}
          </h2>

          {/* Phase status + spinner */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 14, color: isConnected ? '#22c55e' : isFailed ? '#ef4444' : 'var(--text-muted)',
          }}>
            {isWorking && (
              <div style={{
                width: 14, height: 14, borderRadius: '50%',
                border: '2px solid var(--accent-subtle)',
                borderTopColor: 'var(--accent)',
                animation: 'tun-spin 0.8s linear infinite',
                flexShrink: 0,
              }} />
            )}
            <span>{phaseLabel}</span>
          </div>

          {/* Cancel button — shown during connecting phases */}
          {isWorking && onSwitchAccount && (
            <button
              onClick={async () => {
                await window.api.tun.stop().catch(() => {})
                onSwitchAccount()
              }}
              style={{
                padding: '7px 16px', fontSize: 13, fontWeight: 500,
                background: 'transparent', color: 'var(--text-muted)',
                border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer',
              }}
            >
              {t('tun.cancel') || 'Cancel'}
            </button>
          )}

          {/* Error detail box */}
          {isFailed && error && (
            <div style={{
              width: '100%', padding: '10px 14px', borderRadius: 8, boxSizing: 'border-box',
              background: 'var(--bg-primary)', border: '1px solid var(--border)',
              fontSize: 12, color: 'var(--text-muted)',
              textAlign: 'left', wordBreak: 'break-word',
              maxHeight: 100, overflowY: 'auto',
            }}>
              {error}
            </div>
          )}

          {/* Retry button */}
          {isFailed && (
            <button
              onClick={() => connect(true)}
              style={{
                padding: '9px 24px', fontSize: 14, fontWeight: 600,
                background: 'var(--accent)', color: '#fff',
                border: 'none', borderRadius: 8, cursor: 'pointer',
              }}
            >
              {isAuthDenied ? (t('tun.authorize') || 'Authorize & Retry') : t('tun.retry')}
            </button>
          )}

          {/* Switch to password mode — shown on AUTH_DENIED when helper is enabled */}
          {isFailed && isAuthDenied && useHelper && (
            <button
              onClick={() => {
                setUseHelper(false)
                connect(true)
              }}
              style={{
                padding: '7px 16px', fontSize: 13, fontWeight: 500,
                background: 'transparent', color: 'var(--accent)',
                border: '1px solid var(--accent)', borderRadius: 8, cursor: 'pointer',
              }}
            >
              {t('tun.switchToPassword') || 'Use Password Mode'}
            </button>
          )}

          {/* Refresh / Switch account — shown when failed or idle */}
          {isFailed && (
            <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
              {onRefreshConfig && (
                <button
                  onClick={onRefreshConfig}
                  style={{
                    padding: '7px 16px', fontSize: 13, fontWeight: 500,
                    background: 'transparent', color: 'var(--accent)',
                    border: '1px solid var(--accent)', borderRadius: 8, cursor: 'pointer',
                  }}
                >
                  {t('tun.refreshConfig') || 'Refresh Config'}
                </button>
              )}
              {onSwitchAccount && (
                <button
                  onClick={onSwitchAccount}
                  style={{
                    padding: '7px 16px', fontSize: 13, fontWeight: 500,
                    background: 'transparent', color: 'var(--text-muted)',
                    border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer',
                  }}
                >
                  {t('tun.switchAccount') || 'Switch Account'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
