import { useAppStore } from '../../stores/app'
import { useI18n, getT } from '../../i18n'

export function SetupScreen() {
  const { phase, installSteps, installError, installProgress } = useAppStore()
  const { t } = useI18n()

  const handleRetry = async () => {
    useAppStore.getState().setPhase('installing')
    useAppStore.getState().setInstallError(null)
    startInstall()
  }

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary)'
      }}
    >
      <div style={{ width: 420, textAlign: 'center' }}>
        {/* Icon */}
        <div
          style={{
            width: 64,
            height: 64,
            margin: '0 auto 24px',
            borderRadius: 16,
            background: 'var(--accent-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <svg
            width="32" height="32" viewBox="0 0 24 24" fill="none"
            stroke="var(--accent)" strokeWidth="1.5"
          >
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </div>

        <h2
          style={{
            fontSize: 18,
            fontWeight: 600,
            marginBottom: 8,
            color: 'var(--text-primary)'
          }}
        >
          {phase === 'checking' ? t('setup.checking') : t('setup.settingUp')}
        </h2>
        <p
          style={{
            fontSize: 13,
            color: 'var(--text-muted)',
            marginBottom: 32
          }}
        >
          {phase === 'checking'
            ? t('setup.verifying')
            : t('setup.firstTime')}
        </p>

        {/* Spinner for checking phase (no steps yet) */}
        {phase === 'checking' && installSteps.length === 0 && (
          <div style={{
            width: 28, height: 28, margin: '0 auto 24px',
            border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
            borderRadius: '50%', animation: 'spin 0.8s linear infinite',
          }} />
        )}

        {/* Steps */}
        {installSteps.length > 0 && (
          <div style={{ textAlign: 'left' }}>
            {installSteps.map((step, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 0',
                  borderTop: i > 0 ? '1px solid rgba(58, 58, 85, 0.5)' : 'none',
                  fontSize: 13
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    background:
                      step.status === 'done'
                        ? 'rgba(56, 161, 105, 0.2)'
                        : step.status === 'active'
                          ? 'var(--accent-subtle)'
                          : 'var(--bg-tertiary)',
                    color:
                      step.status === 'done'
                        ? 'var(--success-text)'
                        : step.status === 'active'
                          ? 'var(--accent)'
                          : 'var(--text-muted)'
                  }}
                >
                  {step.status === 'done' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : step.status === 'active' ? (
                    <svg
                      width="14" height="14" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2"
                      style={{ animation: 'spin 1s linear infinite' }}
                    >
                      <path d="M21 12a9 9 0 11-6.219-8.56" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="1" />
                    </svg>
                  )}
                </div>
                <span
                  style={{
                    color:
                      step.status === 'done'
                        ? 'var(--text-secondary)'
                        : step.status === 'active'
                          ? 'var(--text-primary)'
                          : 'var(--text-muted)',
                    fontWeight: step.status === 'active' ? 500 : 400
                  }}
                >
                  {step.label}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Progress bar */}
        {phase === 'installing' && (
          <div
            style={{
              width: '100%',
              height: 4,
              background: 'var(--bg-tertiary)',
              borderRadius: 2,
              marginTop: 24,
              overflow: 'hidden'
            }}
          >
            <div
              style={{
                height: '100%',
                background: 'var(--accent)',
                borderRadius: 2,
                width: `${Math.max(installProgress, 10)}%`,
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        )}

        {/* Error */}
        {installError && (
          <div style={{ marginTop: 24 }}>
            <p style={{ fontSize: 13, color: 'var(--error-text)', marginBottom: 12 }}>
              {installError}
            </p>
            <button
              onClick={handleRetry}
              style={{
                padding: '8px 20px',
                background: 'var(--accent)',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer'
              }}
            >
              {t('setup.retry')}
            </button>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes progress-move { 0% { width: 40%; } 50% { width: 70%; } 100% { width: 40%; } }
      `}</style>
    </div>
  )
}

/** Start the CLI + tools install flow. Call from App after detecting CLI is not installed. */
export async function startInstall(): Promise<boolean> {
  const { setInstallSteps, setPhase, setCliInfo, setInstallError, setInstallProgress } = useAppStore.getState()
  const t = getT()

  setPhase('installing')
  setInstallProgress(10)
  setInstallSteps([
    { label: t('setup.checkEnv'), status: 'done' },
    { label: t('setup.downloading'), status: 'active' },
    { label: t('setup.verifyInstall'), status: 'pending' },
    { label: t('setup.downloadingTools'), status: 'pending' }
  ])

  // Listen for CLI progress
  const removeCliListener = window.api.cli.onInstallProgress(({ step, progress }) => {
    // CLI progress maps to 0-60% of total
    setInstallProgress(Math.round(progress * 60))
    if (step.includes('Verifying')) {
      setInstallSteps([
        { label: t('setup.checkEnv'), status: 'done' },
        { label: t('setup.downloadComplete'), status: 'done' },
        { label: t('setup.verifyingInstall'), status: 'active' },
        { label: t('setup.downloadingTools'), status: 'pending' }
      ])
    }
  })

  let result: { success: boolean; error?: string }
  try {
    result = await window.api.cli.install()
  } finally {
    removeCliListener()
  }

  if (!result.success) {
    setInstallError(result.error || 'Unknown error')
    setPhase('error')
    return false
  }

  const info = await window.api.cli.getInfo()
  setCliInfo(info.installed, info.version)

  // Install codex CLI in the background — best effort; if it fails the user
  // can still use Claude and we'll retry on next launch. Don't block the
  // setup flow on it (bandwidth-heavy: ~200MB binary).
  void (async () => {
    try {
      const cur = await window.api.cli.getInfo('codex')
      if (cur.installed) return
      const r = await window.api.cli.install('codex')
      if (!r.success) console.warn('[setup] codex install failed (non-fatal):', r.error)
    } catch (err) {
      console.warn('[setup] codex install threw (non-fatal):', err)
    }
  })()

  // CLI done — now install dev tools
  setInstallProgress(62)
  setInstallSteps([
    { label: t('setup.checkEnv'), status: 'done' },
    { label: t('setup.downloadComplete'), status: 'done' },
    { label: t('setup.installComplete'), status: 'done' },
    { label: t('setup.downloadingTools'), status: 'active' }
  ])

  // Check if tools already installed
  const toolsInstalled = await window.api.tools.isAllInstalled()
  if (toolsInstalled) {
    setInstallProgress(100)
    setInstallSteps([
      { label: t('setup.checkEnv'), status: 'done' },
      { label: t('setup.downloadComplete'), status: 'done' },
      { label: t('setup.installComplete'), status: 'done' },
      { label: t('setup.toolsReady'), status: 'done' }
    ])
    setPhase('ready')
    return true
  }

  // Listen for tools progress
  const removeToolsListener = window.api.tools.onInstallProgress(({ step, progress }) => {
    // Tools progress maps to 62-100% of total
    setInstallProgress(62 + Math.round(progress * 38))
    if (step.includes('Verifying')) {
      setInstallSteps([
        { label: t('setup.checkEnv'), status: 'done' },
        { label: t('setup.downloadComplete'), status: 'done' },
        { label: t('setup.installComplete'), status: 'done' },
        { label: t('setup.verifyingTools'), status: 'active' }
      ])
    }
  })

  let toolsResult: { success: boolean; error?: string }
  try {
    toolsResult = await window.api.tools.install()
  } finally {
    removeToolsListener()
  }

  if (toolsResult.success) {
    setInstallProgress(100)
    setInstallSteps([
      { label: t('setup.checkEnv'), status: 'done' },
      { label: t('setup.downloadComplete'), status: 'done' },
      { label: t('setup.installComplete'), status: 'done' },
      { label: t('setup.toolsReady'), status: 'done' }
    ])
    setPhase('ready')
    return true
  } else {
    // Windows: tools (especially git-bash) are required for Claude Code
    // macOS: tools are optional (system git exists), graceful degradation
    if (window.api.platform === 'win32') {
      setInstallError(toolsResult.error || 'Failed to install required tools (Git). Please retry.')
      setPhase('error')
      return false
    }
    // Non-Windows: non-blocking, proceed to ready
    setInstallSteps([
      { label: t('setup.checkEnv'), status: 'done' },
      { label: t('setup.downloadComplete'), status: 'done' },
      { label: t('setup.installComplete'), status: 'done' },
      { label: t('setup.toolsSkipped'), status: 'done' }
    ])
    setInstallProgress(100)
    setPhase('ready')
    return true
  }
}

/** Install only tools (CLI already installed). Non-blocking — graceful degradation. */
export async function startToolsInstall(): Promise<boolean> {
  const { setInstallSteps, setPhase, setInstallError, setInstallProgress } = useAppStore.getState()
  const t = getT()

  setPhase('installing')
  setInstallProgress(10)
  setInstallSteps([
    { label: t('setup.checkingTools'), status: 'active' }
  ])

  const removeToolsListener = window.api.tools.onInstallProgress(({ step, progress }) => {
    setInstallProgress(10 + Math.round(progress * 90))
    if (step.includes('Verifying')) {
      setInstallSteps([
        { label: t('setup.verifyingTools'), status: 'active' }
      ])
    } else if (step.includes('Downloading')) {
      setInstallSteps([
        { label: t('setup.downloadingTools'), status: 'active' }
      ])
    }
  })

  let toolsResult: { success: boolean; error?: string }
  try {
    toolsResult = await window.api.tools.install()
  } finally {
    removeToolsListener()
  }

  if (toolsResult.success) {
    setInstallProgress(100)
    setInstallSteps([
      { label: t('setup.toolsReady'), status: 'done' }
    ])
  } else {
    if (window.api.platform === 'win32') {
      setInstallError(toolsResult.error || 'Failed to install required tools (Git). Please retry.')
      setPhase('error')
      return false
    }
    // Non-Windows: non-blocking
    setInstallSteps([
      { label: t('setup.toolsSkipped'), status: 'done' }
    ])
    setInstallProgress(100)
  }

  setPhase('ready')
  return true
}
