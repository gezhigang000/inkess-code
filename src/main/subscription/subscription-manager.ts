import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { platform, release, arch } from 'os'
import log from '../logger'
import { getDeviceId } from './device-id'
import { encrypt, decrypt } from '../utils/crypto'
import { buildSubscriptionApiUrl } from './api-url'
import { mainHttpRequest } from '../utils/main-http'

export interface SubscriptionConfig {
  claudeEmail: string
  claudePassword: string
  proxyUrl: string
  tunnelUrl?: string
  proxyRegion: string
  exitIp?: string
  expiresAt: string
  status: 'active' | 'expired' | 'suspended'
  plan?: string
  daysRemaining?: number
  minutesRemaining?: number
}

export interface SubscriptionStatus {
  status: 'active' | 'expired' | 'suspended'
  plan?: string
  expiresAt: string
  daysRemaining: number
  minutesRemaining?: number
  proxyUrl?: string
  tunnelUrl?: string
  proxyRegion?: string
  exitIp?: string
}

interface StoredSession {
  token: string
  username: string
  plan: string
  expiresAt: string
  proxyUrl: string
  tunnelUrl?: string
  proxyRegion: string
  exitIp: string
}

export class SubscriptionManager {
  private sessionDir: string
  private session: StoredSession | null = null

  constructor() {
    this.sessionDir = join(app.getPath('userData'), 'subscription')
    mkdirSync(this.sessionDir, { recursive: true })
    this.loadSession()
  }

  private get sessionPath(): string {
    return join(this.sessionDir, 'session.json')
  }

  private loadSession(): void {
    try {
      if (existsSync(this.sessionPath)) {
        const raw = readFileSync(this.sessionPath, 'utf-8').trim()
        // Try encrypted format first, fall back to legacy plaintext JSON
        if (raw.startsWith('{')) {
          // Legacy plaintext — migrate to encrypted on next save
          this.session = JSON.parse(raw)
          log.info('[SubscriptionManager] loaded legacy plaintext session, will encrypt on next save')
        } else {
          const decrypted = decrypt(raw)
          if (decrypted) {
            this.session = JSON.parse(decrypted)
          } else {
            log.warn('[SubscriptionManager] failed to decrypt session, clearing')
            this.session = null
          }
        }
      }
    } catch {
      this.session = null
    }
  }

  private saveSession(session: StoredSession): void {
    this.session = session
    try {
      const encrypted = encrypt(JSON.stringify(session))
      writeFileSync(this.sessionPath, encrypted, { mode: 0o600 })
    } catch (err) {
      log.error('Failed to save subscription session:', err)
    }
  }

  isLoggedIn(): boolean {
    return this.session !== null
  }

  getSession(): StoredSession | null {
    return this.session
  }

  getUsername(): string | null {
    return this.session?.username || null
  }

  getPlan(): string {
    return this.session?.plan || 'monthly'
  }

  /**
   * Login with subscription credentials.
   * Returns config on success (including Claude credentials — one-time).
   */
  async login(username: string, password: string): Promise<{
    success: boolean
    config?: SubscriptionConfig
    error?: string
    errorCode?: string
  }> {
    const deviceId = getDeviceId()

    try {
      const res = await mainHttpRequest(buildSubscriptionApiUrl('/api/subscription/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username, password, deviceId,
          deviceName: `${platform()} ${release()} ${arch()}`,
          appVersion: app.getVersion(),
        }),
        timeoutMs: 15000,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        return {
          success: false,
          error: (body as { message?: string }).message || `Login failed (HTTP ${res.status})`,
          errorCode: (body as { error?: string }).error,
        }
      }

      const data = await res.json() as { token: string; config: SubscriptionConfig }
      const config = data.config as SubscriptionConfig

      // Validate exitIp — must be a valid IPv4 address, required field
      const exitIp = config.exitIp || ''
      if (!exitIp || !/^\d{1,3}(\.\d{1,3}){3}$/.test(exitIp)) {
        return { success: false, error: 'Server did not provide a valid exit IP. Contact support.' }
      }

      // Save session (without Claude password — never persist)
      this.saveSession({
        token: data.token,
        username,
        plan: config.plan || 'monthly',
        expiresAt: config.expiresAt,
        proxyUrl: config.proxyUrl,
        tunnelUrl: config.tunnelUrl || undefined,
        proxyRegion: config.proxyRegion,
        exitIp,
      })

      log.info(`Subscription login success: ${username}`)
      return { success: true, config }
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('aborted') || msg.includes('timed out')) {
        return { success: false, error: 'Connection timed out. Please check your network.' }
      }
      return { success: false, error: msg }
    }
  }

  /**
   * Check subscription status (periodic polling).
   */
  async checkStatus(): Promise<SubscriptionStatus | null> {
    if (!this.session?.token) return null

    try {
      const res = await mainHttpRequest(buildSubscriptionApiUrl('/api/subscription/status'), {
        headers: { 'Authorization': `Bearer ${this.session.token}` },
        timeoutMs: 10000,
      })

      if (res.status === 401) {
        // Token expired — clear session
        this.logout()
        return null
      }

      if (!res.ok) return null

      const status = await res.json() as SubscriptionStatus

      // Update local session with any proxy/exitIp changes from admin panel
      // Clone before mutating to ensure saveSession writes consistent state
      let changed = false
      const updated = { ...this.session }
      if (status.proxyUrl && status.proxyUrl !== updated.proxyUrl) {
        log.info(`[SubscriptionManager] proxyUrl changed`)
        updated.proxyUrl = status.proxyUrl
        changed = true
      }
      // tunnelUrl: server is authoritative. Sync even when empty → undefined
      // transitions (admin removed tunnel config). Compare strictly against
      // undefined so an empty string from server doesn't skip the update.
      if (status.tunnelUrl !== undefined && (status.tunnelUrl || '') !== (updated.tunnelUrl || '')) {
        log.info(`[SubscriptionManager] tunnelUrl changed (was=${updated.tunnelUrl ? 'set' : 'empty'}, now=${status.tunnelUrl ? 'set' : 'empty'})`)
        updated.tunnelUrl = status.tunnelUrl || undefined
        changed = true
      }
      if (status.proxyRegion && status.proxyRegion !== updated.proxyRegion) {
        updated.proxyRegion = status.proxyRegion
        changed = true
      }
      if (status.exitIp && status.exitIp !== updated.exitIp) {
        log.info(`[SubscriptionManager] exitIp changed: ${updated.exitIp} → ${status.exitIp}`)
        updated.exitIp = status.exitIp
        changed = true
      }
      if (changed) this.saveSession(updated)

      return status
    } catch {
      return null
    }
  }

  logout(): void {
    this.session = null
    try {
      if (existsSync(this.sessionPath)) unlinkSync(this.sessionPath)
    } catch { /* ignore */ }
  }
}
