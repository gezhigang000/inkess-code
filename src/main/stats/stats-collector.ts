import { app } from 'electron'
import { join } from 'path'
import {
  existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, statSync,
  readdirSync,
} from 'fs'
import { fetchWithTimeout } from '../utils/fetch'
import log from '../logger'

// ── Types ────────────────────────────────────────────────────────────────────

export interface EventEntry {
  ts: number
  event: string
  detail?: string
}

export interface SessionEntry {
  ts: number
  sessionId: string
  cwd: string
  duration: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cost?: string
  avgLatency?: number
}

export interface LatencyEntry {
  ts: number
  type: 'ping' | 'ttfb'
  ms: number
  target?: string
}

export interface StatsSummary {
  todayTokens: number
  todaySessionCount: number
  avgPingMs: number | null
  avgTtfbMs: number | null
  storageBytes: number
}

// ── Internal in-memory session state ─────────────────────────────────────────

interface ActiveSession {
  startTs: number
  cwd: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cost?: string
  ttfbValues: number[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000  // 7 days
const PING_INTERVAL_MS = 5 * 60 * 1000          // 5 minutes
const PING_TARGET = 'https://www.google.com/generate_204'
const PING_TIMEOUT_MS = 10_000

// ── StatsCollector ────────────────────────────────────────────────────────────

export class StatsCollector {
  private statsDir: string
  private eventsPath: string
  private sessionsPath: string
  private latencyPath: string

  private activeSessions = new Map<string, ActiveSession>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.statsDir = join(app.getPath('userData'), 'stats')
    mkdirSync(this.statsDir, { recursive: true })

    this.eventsPath = join(this.statsDir, 'events.jsonl')
    this.sessionsPath = join(this.statsDir, 'sessions.jsonl')
    this.latencyPath = join(this.statsDir, 'latency.jsonl')

    // Defer cleanup to avoid blocking app startup
    this.cleanupTimer = setTimeout(() => { this.cleanupTimer = null; this.cleanup() }, 5000)
    this.startPingTimer()
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  /** Remove entries older than 7 days from all JSONL files */
  private cleanup(): void {
    const cutoff = Date.now() - RETENTION_MS
    for (const filePath of [this.eventsPath, this.sessionsPath, this.latencyPath]) {
      this.filterFile(filePath, cutoff)
    }
  }

  private filterFile(filePath: string, cutoff: number): void {
    if (!existsSync(filePath)) return
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const kept = raw
        .split('\n')
        .filter(line => {
          if (!line.trim()) return false
          try {
            const entry = JSON.parse(line) as { ts: number }
            return entry.ts >= cutoff
          } catch {
            return false
          }
        })
        .join('\n')
      writeFileSync(filePath, kept ? kept + '\n' : '')
    } catch (err) {
      log.warn('StatsCollector: cleanup failed for', filePath, err)
    }
  }

  // ── Ping timer ─────────────────────────────────────────────────────────────

  private startPingTimer(): void {
    if (process.platform === 'darwin' && process.env.INKESS_ENABLE_MAC_BACKGROUND_NET !== '1') {
      log.info('StatsCollector: background ping disabled on macOS')
      return
    }

    const timer = setInterval(() => void this.doPing(), PING_INTERVAL_MS)
    timer.unref()
    this.pingTimer = timer
  }

  private async doPing(): Promise<void> {
    const start = Date.now()
    try {
      await fetchWithTimeout(PING_TARGET, {}, PING_TIMEOUT_MS)
      const ms = Date.now() - start
      this.appendLatency({ ts: Date.now(), type: 'ping', ms, target: PING_TARGET } satisfies LatencyEntry)
    } catch {
      // Network unavailable — skip recording
    }
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  sessionStart(sessionId: string, cwd: string): void {
    this.activeSessions.set(sessionId, { startTs: Date.now(), cwd, ttfbValues: [] })
  }

  sessionSetTokens(
    sessionId: string,
    tokens: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cost?: string }
  ): void {
    const session = this.activeSessions.get(sessionId)
    if (!session) return
    if (tokens.inputTokens !== undefined) session.inputTokens = tokens.inputTokens
    if (tokens.outputTokens !== undefined) session.outputTokens = tokens.outputTokens
    if (tokens.totalTokens !== undefined) session.totalTokens = tokens.totalTokens
    if (tokens.cost !== undefined) session.cost = tokens.cost
  }

  sessionRecordTtfb(sessionId: string, ms: number): void {
    const session = this.activeSessions.get(sessionId)
    if (!session) return
    session.ttfbValues.push(ms)
    this.appendLatency({ ts: Date.now(), type: 'ttfb', ms } satisfies LatencyEntry)
  }

  sessionClose(sessionId: string): void {
    const session = this.activeSessions.get(sessionId)
    if (!session) return
    this.activeSessions.delete(sessionId)

    const duration = Date.now() - session.startTs
    const entry: SessionEntry = {
      ts: session.startTs,
      sessionId,
      cwd: session.cwd,
      duration,
      ...(session.inputTokens !== undefined && { inputTokens: session.inputTokens }),
      ...(session.outputTokens !== undefined && { outputTokens: session.outputTokens }),
      ...(session.totalTokens !== undefined && { totalTokens: session.totalTokens }),
      ...(session.cost !== undefined && { cost: session.cost }),
      ...(session.ttfbValues.length > 0 && {
        avgLatency: Math.round(session.ttfbValues.reduce((a, b) => a + b, 0) / session.ttfbValues.length)
      }),
    }
    this.appendSession(entry satisfies SessionEntry)
  }

  // ── Event logging ──────────────────────────────────────────────────────────

  logEvent(event: string, detail?: string): void {
    const entry: EventEntry = { ts: Date.now(), event, ...(detail !== undefined && { detail }) }
    this.appendEvent(entry satisfies EventEntry)
  }

  // ── Internal append helpers ────────────────────────────────────────────────

  private appendEvent(entry: EventEntry): void {
    this.appendLine(this.eventsPath, entry)
  }

  private appendSession(entry: SessionEntry): void {
    this.appendLine(this.sessionsPath, entry)
  }

  private appendLatency(entry: LatencyEntry): void {
    this.appendLine(this.latencyPath, entry)
  }

  private appendLine(filePath: string, entry: object): void {
    try {
      appendFileSync(filePath, JSON.stringify(entry) + '\n')
    } catch (err) {
      log.warn('StatsCollector: failed to append to', filePath, err)
    }
  }

  // ── Query methods ──────────────────────────────────────────────────────────

  async getEvents(): Promise<EventEntry[]> {
    return this.readJsonl<EventEntry>(this.eventsPath)
  }

  async getSessions(): Promise<SessionEntry[]> {
    return this.readJsonl<SessionEntry>(this.sessionsPath)
  }

  async getLatency(): Promise<LatencyEntry[]> {
    return this.readJsonl<LatencyEntry>(this.latencyPath)
  }

  async getSummary(): Promise<StatsSummary> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayTs = todayStart.getTime()

    const sessions = (await this.getSessions()).filter(s => s.ts >= todayTs)
    const todayTokens = sessions.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0)
    const todaySessionCount = sessions.length

    const latencies = (await this.getLatency()).filter(l => l.ts >= todayTs)
    const pings = latencies.filter(l => l.type === 'ping').map(l => l.ms)
    const ttfbs = latencies.filter(l => l.type === 'ttfb').map(l => l.ms)

    const avg = (arr: number[]): number | null =>
      arr.length === 0 ? null : Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)

    return {
      todayTokens,
      todaySessionCount,
      avgPingMs: avg(pings),
      avgTtfbMs: avg(ttfbs),
      storageBytes: this.getStorageSize(),
    }
  }

  getStorageSize(): number {
    let total = 0
    try {
      for (const file of readdirSync(this.statsDir)) {
        try {
          total += statSync(join(this.statsDir, file)).size
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return total
  }

  async getSystemLog(maxLines = 500): Promise<string> {
    try {
      const logPath = log.transports.file.getFile()?.path
      if (!logPath || !existsSync(logPath)) return ''
      const { readFile } = await import('fs/promises')
      const content = await readFile(logPath, 'utf-8')
      const lines = content.split('\n')
      // Return last N lines, newest last (chronological)
      return lines.slice(-maxLines).join('\n')
    } catch (err) {
      log.warn('StatsCollector: failed to read system log:', err)
      return ''
    }
  }

  clearAll(): void {
    for (const filePath of [this.eventsPath, this.sessionsPath, this.latencyPath]) {
      try {
        if (existsSync(filePath)) writeFileSync(filePath, '')
      } catch (err) {
        log.warn('StatsCollector: failed to clear', filePath, err)
      }
    }
    log.info('StatsCollector: cleared all stats')
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  dispose(): void {
    if (this.cleanupTimer !== null) {
      clearTimeout(this.cleanupTimer)
      this.cleanupTimer = null
    }
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async readJsonl<T>(filePath: string): Promise<T[]> {
    if (!existsSync(filePath)) return []
    try {
      const { readFile } = await import('fs/promises')
      const raw = await readFile(filePath, 'utf-8')
      const results: T[] = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          results.push(JSON.parse(line) as T)
        } catch { /* skip malformed lines */ }
      }
      return results
    } catch (err) {
      log.warn('StatsCollector: failed to read', filePath, err)
      return []
    }
  }
}
