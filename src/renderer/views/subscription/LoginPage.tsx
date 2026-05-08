import { useState } from 'react'
import { useI18n } from '../../i18n'
import { useSettingsStore } from '../../stores/settings'

const DEFAULT_SERVER_URL = 'https://llm.inkessai.com'

interface LoginPageProps {
  onLoginSuccess: (config: {
    claudeEmail: string; claudePassword: string
    proxyUrl: string; proxyRegion: string
    expiresAt: string; status: string
  }) => void
}

function isValidServerUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/.test(value.trim())
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { t } = useI18n()
  const serverUrl = useSettingsStore(s => s.serverUrl)
  const setServerUrl = useSettingsStore(s => s.setServerUrl)
  const [serverEditing, setServerEditing] = useState(false)
  const [serverDraft, setServerDraft] = useState(serverUrl || DEFAULT_SERVER_URL)
  const [serverError, setServerError] = useState<string | null>(null)
  const effectiveServerUrl = serverUrl || DEFAULT_SERVER_URL

  const handleLogin = async () => {
    if (!username || !password) return
    setLoading(true)
    setError(null)

    const result = await window.api.subscription.login(username, password)
    setLoading(false)

    if (result.success && result.config) {
      onLoginSuccess(result.config)
    } else {
      if (result.errorCode === 'DEVICE_ALREADY_BOUND') {
        setError(t('subscription.deviceBound'))
      } else if (result.errorCode === 'ACCOUNT_BOUND_TO_OTHER_DEVICE') {
        setError(t('subscription.accountBound'))
      } else {
        setError(result.error || t('subscription.loginFailed'))
      }
    }
  }

  const commitServerUrl = () => {
    const trimmed = serverDraft.trim()
    if (trimmed && trimmed !== DEFAULT_SERVER_URL && !isValidServerUrl(trimmed)) {
      setServerError(t('subscription.serverInvalid'))
      return
    }
    setServerError(null)
    setServerUrl(trimmed === DEFAULT_SERVER_URL ? '' : trimmed)
    setServerEditing(false)
  }

  const resetServerUrl = () => {
    setServerError(null)
    setServerDraft(DEFAULT_SERVER_URL)
    setServerUrl('')
  }

  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-primary)',
    }}>
      <div style={{ width: 360, textAlign: 'center' }}>
        {/* Logo */}
        <div style={{
          width: 64, height: 64, margin: '0 auto 24px', borderRadius: 16,
          background: 'var(--accent-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
        </div>

        <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          Inkess Code
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 32 }}>
          {t('subscription.loginHint')}
        </p>

        {/* Server URL — collapsible */}
        <div style={{ textAlign: 'left', marginBottom: 16 }}>
          {!serverEditing ? (
            <div
              style={{
                fontSize: 12, color: 'var(--text-muted)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 8, padding: '6px 2px',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t('subscription.serverLabel')}: {effectiveServerUrl}
              </span>
              <button
                type="button"
                onClick={() => {
                  setServerDraft(serverUrl || DEFAULT_SERVER_URL)
                  setServerEditing(true)
                  setServerError(null)
                }}
                style={{
                  fontSize: 12, color: 'var(--accent)', background: 'transparent',
                  border: 'none', cursor: 'pointer', padding: 0,
                }}
              >
                {t('subscription.serverEdit')}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('subscription.serverLabel')}
              </label>
              <input
                value={serverDraft}
                onChange={e => setServerDraft(e.target.value)}
                placeholder={t('subscription.serverPlaceholder')}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitServerUrl()
                  else if (e.key === 'Escape') {
                    setServerEditing(false)
                    setServerError(null)
                  }
                }}
                style={{
                  width: '100%', padding: '8px 12px', fontSize: 13, boxSizing: 'border-box',
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                  borderRadius: 8, color: 'var(--text-primary)', outline: 'none',
                }}
                onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'}
                onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
              />
              {serverError && (
                <div style={{ fontSize: 12, color: 'var(--error-text)' }}>{serverError}</div>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={resetServerUrl}
                  style={{
                    fontSize: 12, color: 'var(--text-muted)', background: 'transparent',
                    border: 'none', cursor: 'pointer', padding: 0,
                  }}
                >
                  {t('subscription.serverReset')}
                </button>
                <button
                  type="button"
                  onClick={commitServerUrl}
                  style={{
                    fontSize: 12, color: 'var(--accent)', background: 'transparent',
                    border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600,
                  }}
                >
                  OK
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'left' }}>
          <input
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder={t('subscription.username')}
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') handleLogin() }}
            style={{
              width: '100%', padding: '10px 14px', fontSize: 14, boxSizing: 'border-box',
              background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
              borderRadius: 8, color: 'var(--text-primary)', outline: 'none',
            }}
            onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'}
            onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
          />
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder={t('subscription.password')}
            onKeyDown={e => { if (e.key === 'Enter') handleLogin() }}
            style={{
              width: '100%', padding: '10px 14px', fontSize: 14, boxSizing: 'border-box',
              background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
              borderRadius: 8, color: 'var(--text-primary)', outline: 'none',
            }}
            onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'}
            onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
          />

          {error && (
            <div style={{ fontSize: 13, color: 'var(--error-text)', padding: '4px 0' }}>
              {error}
            </div>
          )}

          <button
            onClick={handleLogin}
            disabled={loading || !username || !password}
            style={{
              width: '100%', padding: '10px 0', fontSize: 14, fontWeight: 600,
              background: loading ? 'var(--bg-active)' : 'var(--accent)',
              color: '#fff', border: 'none', borderRadius: 8,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: (!username || !password) ? 0.5 : 1,
            }}
          >
            {loading ? t('subscription.loggingIn') : t('subscription.login')}
          </button>
        </div>

        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 24 }}>
          {t('subscription.contactAdmin')}
        </p>
      </div>
    </div>
  )
}
