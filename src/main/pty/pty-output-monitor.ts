import { EventEmitter } from 'events'

export interface PtyActivityEvent {
  id: string
  type: 'task-complete' | 'prompt-idle' | 'streaming' | 'model-info' | 'mode-change' | 'token-usage' | 'ttfb-ready' | 'url-open'
  payload?: string
}

/**
 * Monitors PTY output streams to detect Claude Code activity patterns.
 * Emits structured events for UI consumption (notifications, status bar, etc.)
 */
export class PtyOutputMonitor extends EventEmitter {
  private sessions = new Map<string, {
    lastDataTime: number
    idleTimer: ReturnType<typeof setTimeout> | null
    isStreaming: boolean
    buffer: string
    lastIdleTime: number
    streamingStartTime: number
    openedUrls: Set<string>
  }>()

  private static IDLE_TIMEOUT = 2000 // 2s no output = idle
  private static BUFFER_MAX = 2000   // keep last N chars for pattern matching

  /** Strip ANSI escape sequences for clean pattern matching */
  private static stripAnsi(str: string): string {
    // Limit input length to prevent regex DoS on large/malformed sequences
    if (str.length > 10000) str = str.slice(-10000)
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g, '')
  }

  /** Start monitoring a PTY session */
  watch(id: string): void {
    this.sessions.set(id, {
      lastDataTime: Date.now(),
      idleTimer: null,
      isStreaming: false,
      buffer: '',
      lastIdleTime: Date.now(),
      streamingStartTime: 0,
      openedUrls: new Set()
    })
  }

  /** Stop monitoring a PTY session */
  unwatch(id: string): void {
    const session = this.sessions.get(id)
    if (session?.idleTimer) clearTimeout(session.idleTimer)
    this.sessions.delete(id)
  }

  /** Feed PTY output data for analysis */
  feed(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session) return

    session.lastDataTime = Date.now()
    session.buffer = (session.buffer + data).slice(-PtyOutputMonitor.BUFFER_MAX)

    // Mark as streaming
    if (!session.isStreaming) {
      session.isStreaming = true
      session.streamingStartTime = Date.now()
      this.emit('activity', { id, type: 'streaming' } as PtyActivityEvent)
      const ttfb = Date.now() - session.lastIdleTime
      if (ttfb > 0 && ttfb < 300000) {
        this.emit('activity', { id, type: 'ttfb-ready', payload: String(ttfb) } as PtyActivityEvent)
      }
    }

    // Check for model info (e.g. "claude-sonnet-4-6" in status output)
    const cleanData = PtyOutputMonitor.stripAnsi(data)
    const modelMatch = cleanData.match(/\b(claude-(?:opus|sonnet|haiku)-[\w.-]+)\b/)
    if (modelMatch) {
      this.emit('activity', { id, type: 'model-info', payload: modelMatch[1] } as PtyActivityEvent)
    }

    // Check for mode change (from /permissions output)
    const modeMatch = cleanData.match(/(?:permissions|mode):\s*(suggest|auto-?edit|full-?auto)/i)
    if (modeMatch) {
      const mode = modeMatch[1].toLowerCase().replace('-', '')
      this.emit('activity', { id, type: 'mode-change', payload: mode } as PtyActivityEvent)
    }

    // Detect URLs that Claude Code / Codex try to auto-open (e.g. OAuth login).
    // On Windows, `start` is a cmd builtin that can't be intercepted via PATH;
    // and Codex on macOS calls LaunchServices directly (bypasses our open
    // wrapper). In both cases we detect the URL in PTY output and route it
    // to the built-in browser. Use the accumulated buffer (not just current
    // chunk) because long URLs may arrive split across multiple PTY events.
    const cleanBuffer = PtyOutputMonitor.stripAnsi(session.buffer)
    const urlMatches = cleanBuffer.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)
    for (const urlMatch of urlMatches) {
      const url = urlMatch[0]
      // Open URLs that look like login/OAuth flows in the built-in browser.
      // Dedup: don't open the same URL twice in one session.
      if (/claude\.ai|anthropic\.com|accounts\.google|github\.com\/login|chatgpt\.com\/(auth|backend-api)|chat\.openai\.com\/auth|auth\.openai\.com|auth0\.openai\.com|platform\.openai\.com\/login/i.test(url) &&
          !session.openedUrls.has(url)) {
        session.openedUrls.add(url)
        this.emit('activity', { id, type: 'url-open', payload: url } as PtyActivityEvent)
      }
    }

    // Reset idle timer
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      if (!this.sessions.has(id)) return
      if (!session.isStreaming) return
      session.isStreaming = false
      session.lastIdleTime = Date.now()

      // Check for token usage patterns in the buffer (only on idle transition, not every feed)
      const cleanBuffer = PtyOutputMonitor.stripAnsi(session.buffer)
      const inputMatch = cleanBuffer.match(/input\s+tokens?[:\s]+([\d,]+)/i)
      const outputMatch = cleanBuffer.match(/output\s+tokens?[:\s]+([\d,]+)/i)
      const totalMatch = cleanBuffer.match(/total\s+tokens?[:\s]+([\d,]+)/i)
      const costMatch = cleanBuffer.match(/total\s+cost[:\s]+\$([\d.]+)/i)
      if (inputMatch || outputMatch || totalMatch || costMatch) {
        const input = inputMatch ? parseInt(inputMatch[1].replace(/,/g, ''), 10) : undefined
        const output = outputMatch ? parseInt(outputMatch[1].replace(/,/g, ''), 10) : undefined
        const total = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : undefined
        const cost = costMatch ? parseFloat(costMatch[1]) : undefined
        this.emit('activity', {
          id, type: 'token-usage',
          payload: JSON.stringify({ input, output, total, cost })
        } as PtyActivityEvent)
      }

      // Check if output ended with a prompt (task complete)
      const tail = PtyOutputMonitor.stripAnsi(session.buffer.slice(-200))
      // Claude Code prompt patterns: "╰─" or "❯" at end of output
      if (/[╰❯]\s*$/.test(tail) || /\$\s*$/.test(tail)) {
        this.emit('activity', { id, type: 'task-complete' } as PtyActivityEvent)
      } else {
        this.emit('activity', { id, type: 'prompt-idle' } as PtyActivityEvent)
      }
    }, PtyOutputMonitor.IDLE_TIMEOUT)
  }

  /** Check if any session is currently streaming */
  isAnyStreaming(): boolean {
    for (const session of this.sessions.values()) {
      if (session.isStreaming) return true
    }
    return false
  }

  /** Clean up all sessions */
  dispose(): void {
    const ids = [...this.sessions.keys()]
    for (const id of ids) {
      this.unwatch(id)
    }
    this.removeAllListeners()
  }
}
