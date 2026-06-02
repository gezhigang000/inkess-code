import { app, session as electronSession, BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import log from '../logger'
import { buildSubscriptionApiUrl } from './api-url'
import { mainHttpRequest } from '../utils/main-http'

const SYNC_INTERVAL = 10 * 60 * 1000 // 10 minutes
const UPLOAD_TIMEOUT = 15000
const LOCALSTORAGE_TIMEOUT = 30000 // 30s — must exceed Cloudflare JS challenge time
const CLAUDE_ORIGIN = 'https://claude.ai'
const BROWSER_COOKIE_ALLOWED_BASE_DOMAINS = [
  'claude.ai',
  'claude.com',
  'anthropic.com',
  'openai.com',
  'chatgpt.com',
]

function normalizeCookieDomain(domain?: string): string {
  return (domain || '').trim().toLowerCase().replace(/^\.+/, '')
}

function isAllowedBrowserCookieDomain(domain?: string): boolean {
  const normalized = normalizeCookieDomain(domain)
  return BROWSER_COOKIE_ALLOWED_BASE_DOMAINS.some(base =>
    normalized === base || normalized.endsWith(`.${base}`)
  )
}

export function filterBrowserSyncCookies<T extends { domain?: string }>(cookies: T[]): T[] {
  return cookies.filter(cookie => isAllowedBrowserCookieDomain(cookie.domain))
}

/**
 * v2 sync payload — carries BOTH the claude-dedicated session and the
 * general "browser" session. The browser session is intentionally narrowed
 * to Claude/OpenAI product domains during import/upload; arbitrary sites the
 * user manually opens are not restored because the full generic cookie pool
 * has caused reproducible native Electron crashes when opening browser tabs.
 * localStorage is only synced for claude.ai (single origin), because
 * cross-site localStorage sync would require loading every origin in a hidden
 * window — infeasible and privacy-hostile.
 */
interface SyncDataV2 {
  version: 2
  claude: {
    cookies: Electron.Cookie[]
    localStorage: Record<string, string>
  }
  browser: {
    cookies: Electron.Cookie[]
  }
  timestamp: string
}

// v1 legacy format (flat { cookies, localStorage }) is no longer supported.
// Server returns 204 for stale v1 data, and rejects v1 POSTs with 400.

export class BrowserSync {
  private timer: NodeJS.Timeout | null = null
  private username: string | null = null
  private token: string | null = null
  private lastHash: string | null = null
  private pendingLocalStorage: Record<string, string> | null = null
  private _uploadPromise: Promise<void> | null = null

  private async ensureAppReady(): Promise<void> {
    if (!app.isReady()) {
      await app.whenReady()
    }
  }

  /**
   * Phase 1: Download remote data, import cookies immediately.
   * Stores localStorage in memory for Phase 2 (after TUN ready + claude.ai
   * tab loads). Called before TUN starts — API is on inkess server (China),
   * no TUN needed.
   */
  async downloadAndImportCookies(username: string, token: string): Promise<void> {
    this.username = username
    this.token = token
    this.pendingLocalStorage = null
    log.info(`[BrowserSync] downloadAndImportCookies start for ${username}`)

    try {
      await this.ensureAppReady()

      const res = await mainHttpRequest(buildSubscriptionApiUrl('/api/subscription/browser-data'), {
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: UPLOAD_TIMEOUT,
      })

      if (res.status === 204) {
        log.info('[BrowserSync] no remote data (first-time user)')
        return
      }
      if (!res.ok) {
        log.warn(`[BrowserSync] download failed: HTTP ${res.status}`)
        return
      }

      const data = (await res.json()) as SyncDataV2
      if (data.version !== 2) {
        log.warn(`[BrowserSync] unexpected data version: ${data.version}, skipping`)
        return
      }
      log.info(
        `[BrowserSync] downloaded v2: claude=${data.claude?.cookies?.length ?? 0} cookies, ` +
        `browser=${data.browser?.cookies?.length ?? 0} cookies, ` +
        `claudeLocalStorage=${Object.keys(data.claude?.localStorage || {}).length} keys`,
      )
      if (data.claude?.cookies?.length) {
        await this.importCookies(this.getClaudeSession(), data.claude.cookies, 'claude')
      }
      if (data.browser?.cookies?.length) {
        const browserCookies = filterBrowserSyncCookies(data.browser.cookies)
        log.info(`[BrowserSync] browser cookies filtered for import: ${data.browser.cookies.length} -> ${browserCookies.length}`)
        if (browserCookies.length) {
          await this.importCookies(this.getBrowserSession(), browserCookies, 'browser')
        }
      }
      if (data.claude?.localStorage && Object.keys(data.claude.localStorage).length > 0) {
        this.pendingLocalStorage = data.claude.localStorage
      }
    } catch (err) {
      log.warn('[BrowserSync] download error:', err)
    }
  }

  /**
   * Phase 2: consumed once by the first claude.ai tab load. Returns the JS
   * to execute on dom-ready that restores pending localStorage entries.
   */
  getLocalStorageImportScript(): string | null {
    if (!this.pendingLocalStorage || Object.keys(this.pendingLocalStorage).length === 0) {
      return null
    }
    const data = this.pendingLocalStorage
    this.pendingLocalStorage = null
    const escaped = JSON.stringify(data)
    return `(function(){try{var d=${escaped};Object.keys(d).forEach(function(k){localStorage.setItem(k,d[k])});}catch(e){}})()`
  }

  /** Start periodic upload timer */
  startPeriodicUpload(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.upload().catch((err) => log.warn('[BrowserSync] periodic upload error:', err))
    }, SYNC_INTERVAL)
    log.info('[BrowserSync] periodic upload started (every 10 min)')
  }

  /** Stop sync (on logout or quit) */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.username = null
    this.token = null
    this.lastHash = null
    this.pendingLocalStorage = null
  }

  /** Export local sessions and upload to server. Skip if data unchanged. */
  async upload(): Promise<void> {
    if (this._uploadPromise) return this._uploadPromise
    this._uploadPromise = this._doUpload().finally(() => { this._uploadPromise = null })
    return this._uploadPromise
  }

  private async _doUpload(): Promise<void> {
    if (!this.username || !this.token) {
      log.warn('[BrowserSync] upload skipped: no credentials (username/token null)')
      return
    }

    log.info('[BrowserSync] _doUpload start')
    try {
      await this.ensureAppReady()

      // Export both session jars. The generic browser jar is restricted to
      // Claude/OpenAI product domains to avoid restoring arbitrary site state.
      const claudeCookies = await this.getClaudeSession().cookies.get({})
      const rawBrowserCookies = await this.getBrowserSession().cookies.get({})
      const browserCookies = filterBrowserSyncCookies(rawBrowserCookies)
      log.info(`[BrowserSync] browser cookies filtered for upload: ${rawBrowserCookies.length} -> ${browserCookies.length}`)
      const hash = this.hashAll(claudeCookies, browserCookies)
      log.info(
        `[BrowserSync] upload check: claude=${claudeCookies.length} browser=${browserCookies.length} hash=${hash.slice(0, 8)}`,
      )

      // Skip if nothing changed since last upload.
      if (hash === this.lastHash) {
        log.info('[BrowserSync] cookies unchanged, skipping upload')
        return
      }

      // Export claude.ai localStorage (best-effort; timeout → upload cookies only).
      log.info('[BrowserSync] exportClaudeLocalStorage start')
      let claudeLocalStorage: Record<string, string> = {}
      try {
        claudeLocalStorage = await this.exportClaudeLocalStorage()
        log.info(`[BrowserSync] exportClaudeLocalStorage returned ${Object.keys(claudeLocalStorage).length} keys`)
      } catch (err) {
        log.warn('[BrowserSync] localStorage export failed, uploading cookies only:', err)
      }

      const body: SyncDataV2 = {
        version: 2,
        claude: { cookies: claudeCookies, localStorage: claudeLocalStorage },
        browser: { cookies: browserCookies },
        timestamp: new Date().toISOString(),
      }

      const res = await mainHttpRequest(buildSubscriptionApiUrl('/api/subscription/browser-data'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        timeoutMs: UPLOAD_TIMEOUT,
      })

      if (res.ok) {
        this.lastHash = hash
        log.info(
          `[BrowserSync] uploaded v2: claude=${claudeCookies.length} cookies + ` +
          `${Object.keys(claudeLocalStorage).length} localStorage keys, ` +
          `browser=${browserCookies.length} cookies`,
        )
      } else {
        log.warn(`[BrowserSync] upload failed: HTTP ${res.status}`)
        // Token expired — stop periodic uploads
        if (res.status === 401 && this.timer) {
          clearInterval(this.timer)
          this.timer = null
          log.info('[BrowserSync] token expired, periodic upload stopped')
        }
      }
    } catch (err) {
      log.warn('[BrowserSync] upload error:', err)
    }
  }

  private getClaudeSession(): Electron.Session {
    return electronSession.fromPartition(`persist:claude-${this.username}`)
  }

  private getBrowserSession(): Electron.Session {
    return electronSession.fromPartition(`persist:browser-${this.username}`)
  }

  /**
   * Import cookies into the given session. Individual cookie errors (expired,
   * invalid domain, etc.) are silently skipped so one bad entry does not
   * abort the whole restore.
   */
  private async importCookies(
    ses: Electron.Session,
    cookies: Electron.Cookie[],
    label: string,
  ): Promise<void> {
    let imported = 0
    for (const cookie of cookies) {
      try {
        const url = `http${cookie.secure ? 's' : ''}://${cookie.domain?.replace(/^\./, '')}${cookie.path || '/'}`
        await ses.cookies.set({
          url,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expirationDate: cookie.expirationDate,
          sameSite: cookie.sameSite,
        })
        imported++
      } catch {
        // Skip individual cookie errors
      }
    }
    log.info(`[BrowserSync] imported ${imported}/${cookies.length} ${label} cookies`)
  }

  /**
   * Load claude.ai in a hidden window under the claude session and read its
   * localStorage. The hidden window must actually hit claude.ai because
   * localStorage is per-origin.
   *
   * Timeout was bumped from 10s to 30s — Cloudflare JS challenge delays the
   * first dom-ready by 5-10s, and under slow network the challenge itself
   * can take another 10s to solve. Previous 10s timeout was hitting before
   * dom-ready fired, causing localStorage to silently never upload.
   */
  private async exportClaudeLocalStorage(): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const ses = this.getClaudeSession()
      const win = new BrowserWindow({
        show: false,
        width: 100,
        height: 100,
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })

      let settled = false

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        if (!win.isDestroyed()) win.destroy()
        reject(new Error('localStorage export timeout'))
      }, LOCALSTORAGE_TIMEOUT)

      const done = (data: Record<string, string>) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (!win.isDestroyed()) win.destroy()
        resolve(data)
      }

      const readLS = () => {
        if (settled || win.isDestroyed()) return
        win.webContents
          .executeJavaScript('JSON.stringify(localStorage)')
          .then((json) => {
            try {
              done(JSON.parse(json))
            } catch {
              done({})
            }
          })
          .catch(() => done({}))
      }

      win.webContents.on('dom-ready', readLS)
      win.webContents.on('did-fail-load', readLS)

      win.loadURL(CLAUDE_ORIGIN).catch(() => {})
    })
  }

  /**
   * Combined hash used for change detection across BOTH session jars.
   * Any cookie add/update/remove in either session invalidates the hash
   * and triggers a fresh upload.
   */
  private hashAll(
    claudeCookies: Electron.Cookie[],
    browserCookies: Electron.Cookie[],
  ): string {
    const toKeys = (cs: Electron.Cookie[], prefix: string) =>
      cs.map((c) => `${prefix}:${c.domain}|${c.name}|${c.value}`)
    const sorted = [
      ...toKeys(claudeCookies, 'c'),
      ...toKeys(browserCookies, 'b'),
    ].sort().join('\n')
    return createHash('sha256').update(sorted).digest('hex').slice(0, 16)
  }
}
