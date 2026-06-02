import { app } from 'electron'
import { platform, release, arch } from 'os'
import log from './logger'
import { readFileSync } from 'fs'
import { mainHttpRequest } from './utils/main-http'

const API_BASE = 'https://llm.inkessai.com'
const FLUSH_INTERVAL = 60_000
const QUEUE_LIMIT = 10
const MAX_QUEUE_SIZE = 200

function isBackgroundNetworkDisabled(): boolean {
  return process.platform === 'darwin' && process.env.INKESS_ENABLE_MAC_BACKGROUND_NET !== '1'
}

interface ErrorEntry {
  message: string
  stack?: string
  source: 'main' | 'renderer'
  ts: number
}

export type BizErrorCategory = 'login' | 'tun_start' | 'tun_connectivity' | 'tun_install'

interface BizErrorEntry {
  category: BizErrorCategory
  error: string
  context: Record<string, string | number | boolean | undefined>
  ts: number
}

export class ErrorReporter {
  private queue: ErrorEntry[] = []
  private bizQueue: BizErrorEntry[] = []
  private timer: NodeJS.Timeout | null = null
  private tokenGetter: (() => string | null) | null = null
  private usernameGetter: (() => string | null) | null = null
  private flushing = false
  private bizFlushing = false

  constructor() {
    this.timer = setInterval(() => { this.flush(); this.flushBiz() }, FLUSH_INTERVAL)

    // Hook electron-log: intercept error-level logs from main process
    log.hooks.push((message, transport) => {
      if (transport !== log.transports.file) return message
      if (message.level === 'error') {
        const text = message.data?.map((d: unknown) =>
          typeof d === 'string' ? d : d instanceof Error ? d.message : JSON.stringify(d)
        ).join(' ') || ''
        const stack = message.data?.find((d: unknown) => d instanceof Error)?.stack
        this.report(text, stack, 'main')
      }
      return message
    })
  }

  setTokenGetter(fn: () => string | null): void {
    this.tokenGetter = fn
  }

  setUsernameGetter(fn: () => string | null): void {
    this.usernameGetter = fn
  }

  /** Queue an error for batch upload */
  report(message: string, stack?: string, source: 'main' | 'renderer' = 'main'): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) this.queue.shift() // Drop oldest to prevent memory leak
    this.queue.push({ message: message.slice(0, 2000), stack: stack?.slice(0, 4000), source, ts: Date.now() })
    if (this.queue.length >= QUEUE_LIMIT && !this.flushing) {
      this.flush()
    }
  }

  /** Queue a structured business error for batch upload */
  reportBizError(category: BizErrorCategory, error: string, context: Record<string, string | number | boolean | undefined> = {}): void {
    if (this.bizQueue.length >= MAX_QUEUE_SIZE) this.bizQueue.shift()
    this.bizQueue.push({
      category,
      error: this.redactSensitiveData(error.slice(0, 2000)),
      context: {
        ...context,
        appVersion: app.getVersion(),
        platform: `${platform()} ${release()} ${arch()}`,
      },
      ts: Date.now(),
    })
    if (this.bizQueue.length >= QUEUE_LIMIT && !this.bizFlushing) {
      this.flushBiz()
    }
  }

  /** Redact sensitive data (credentials, tokens) from text before upload */
  private redactSensitiveData(text: string): string {
    return text
      // Redact URLs with credentials (user:pass@host)
      .replace(/:\/\/([^:@\s]+):([^@\s]+)@/g, '://$1:***@')
      // Redact Bearer tokens
      .replace(/Bearer\s+\S+/gi, 'Bearer ***')
      // Redact common token/key/password patterns
      .replace(/(token|password|passwd|pass|secret|key|authorization|credential)['":\s]*[=:]\s*['"]?[^\s'"}{,]+/gi, '$1=***')
  }

  /** Upload complete log file */
  async uploadLogFile(): Promise<{ success: boolean; error?: string }> {
    try {
      const logPath = log.transports.file.getFile()?.path
      if (!logPath) return { success: false, error: 'Log file not found' }

      const rawContent = readFileSync(logPath, 'utf-8')
      if (!rawContent) return { success: false, error: 'Log file is empty' }
      const content = this.redactSensitiveData(rawContent)

      const token = this.tokenGetter?.()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await mainHttpRequest(`${API_BASE}/api/llm/desktop/client-logs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'logfile',
          content,
          version: app.getVersion(),
          platform: process.platform,
        }),
        timeoutMs: 30_000,
        maxBuffer: 256 * 1024,
      })

      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}` }
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  private async flush(): Promise<void> {
    if (this.queue.length === 0 || this.flushing) return
    if (isBackgroundNetworkDisabled()) return
    this.flushing = true
    const batch = this.queue.splice(0)
    const token = this.tokenGetter?.()

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      await mainHttpRequest(`${API_BASE}/api/llm/desktop/client-logs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'errors',
          errors: batch,
          version: app.getVersion(),
          platform: process.platform,
          username: this.usernameGetter?.() || undefined,
        }),
        timeoutMs: 10_000,
        maxBuffer: 256 * 1024,
      })
    } catch {
      // Re-queue for retry (cap at MAX_QUEUE_SIZE)
      for (const entry of batch) {
        if (this.queue.length >= MAX_QUEUE_SIZE) break
        this.queue.push(entry)
      }
    } finally {
      this.flushing = false
    }
  }

  private async flushBiz(): Promise<void> {
    if (this.bizQueue.length === 0 || this.bizFlushing) return
    if (isBackgroundNetworkDisabled()) return
    this.bizFlushing = true
    const batch = this.bizQueue.splice(0)
    const token = this.tokenGetter?.()

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      await mainHttpRequest(`${API_BASE}/api/llm/desktop/client-logs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'biz-errors',
          errors: batch,
          version: app.getVersion(),
          platform: process.platform,
          username: this.usernameGetter?.() || undefined,
        }),
        timeoutMs: 10_000,
        maxBuffer: 256 * 1024,
      })
    } catch {
      for (const entry of batch) {
        if (this.bizQueue.length >= MAX_QUEUE_SIZE) break
        this.bizQueue.push(entry)
      }
    } finally {
      this.bizFlushing = false
    }
  }

  flushSync(): void {
    // Best-effort: fire async flush, app exit will happen shortly after
    this.flush()
    this.flushBiz()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
