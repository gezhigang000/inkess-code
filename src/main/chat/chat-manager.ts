import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import * as os from 'os'
import log from '../logger'
import { buildCleanEnv } from '../utils/clean-env'
import { StreamJsonParser } from './stream-parser'
import { getEngineHandler, type Engine } from './engines'
import type { ChatStore } from './chat-store'
import type { ChatEndPayload, ChatStreamPayload } from './chat-types'
import { CANCEL_GRACE_MS, MAX_CONCURRENT, TURN_TIMEOUT_MS } from './constants'

export interface ChatManagerDeps {
  store: ChatStore
  /** Returns absolute path to the CLI binary for the requested engine.
   *  Returns empty string if not installed. */
  getCliBinaryPath: (engine: Engine) => string
  /**
   * Optional args to prepend before the normal buildArgs output. Used by
   * tests to invoke `node fake-claude.mjs <args>` where the binary is 'node'
   * and the prefix is the fixture path. Production code leaves this empty.
   */
  argsPrefix?: string[]
  regionEnv: () => Record<string, string>
  extraEnv: () => Record<string, string>
  onEvent: (p: ChatStreamPayload) => void
  onEnd: (p: ChatEndPayload) => void
}

interface Inflight {
  child: ChildProcess
  requestId: string
  watchdog: NodeJS.Timeout
  killTimer: NodeJS.Timeout | null
  cancelled: boolean
  timedOut: boolean
}

export class ChatManager {
  private inflight = new Map<string, Inflight>()

  /** Test-only override — set by integration tests via `(mgr as any).__testOverrideTimeoutMs`. */
  private __testOverrideTimeoutMs?: number

  constructor(private readonly deps: ChatManagerDeps) {}

  inflightCount(): number {
    return this.inflight.size
  }

  async send(chatId: string, text: string): Promise<{ requestId: string }> {
    if (this.inflight.has(chatId)) {
      throw new Error('busy')
    }
    if (this.inflight.size >= MAX_CONCURRENT) {
      throw new Error('too_many_concurrent_chats')
    }

    const meta = this.deps.store.get(chatId)
    if (!meta) throw new Error('invalid_chat_id')

    const engine: Engine = meta.engine === 'codex' ? 'codex' : 'claude'
    const handler = getEngineHandler(engine)

    const binary = this.deps.getCliBinaryPath(engine)
    if (!binary) throw new Error('cli_missing')

    const baseArgs = handler.buildArgs({ meta, text })
    const args = [...(this.deps.argsPrefix ?? []), ...baseArgs]
    const env = buildCleanEnv(this.deps.regionEnv(), this.deps.extraEnv())

    // Codex pre-flight: `codex exec` requires an auth file. Codex stores it at
    // $CODEX_HOME/auth.json (defaulting to ~/.codex/auth.json). We check both
    // locations so the friendly `codex_not_logged_in` error fires regardless
    // of how the user logged in (terminal with our isolated CODEX_HOME, or a
    // pre-existing system-wide login at ~/.codex/auth.json).
    if (engine === 'codex') {
      const candidates: string[] = []
      if (env.CODEX_HOME) candidates.push(join(env.CODEX_HOME, 'auth.json'))
      candidates.push(join(os.homedir(), '.codex', 'auth.json'))
      const hasAuth = candidates.some((p) => {
        try { return existsSync(p) } catch { return false }
      })
      if (!hasAuth) {
        throw new Error('codex_not_logged_in')
      }
    }

    let child: ChildProcess
    try {
      child = spawn(binary, args, {
        cwd: meta.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      log.warn('[chat] spawn failed:', err)
      throw new Error('spawn_failed')
    }

    const requestId = randomUUID()
    const parser = new StreamJsonParser()
    let sessionFromInit: string | null = null

    const emitParsed = (objects: unknown[]) => {
      for (const raw of objects) {
        const events = handler.normalize(raw)
        for (const event of events) {
          if (event.kind === 'meta' && event.sessionId) {
            sessionFromInit = event.sessionId
          }
          this.deps.onEvent({ requestId, event })
        }
      }
    }

    child.stdout!.on('data', (chunk: Buffer) => {
      emitParsed(parser.feed(chunk))
    })

    // Flush any incomplete UTF-8 bytes buffered in the StringDecoder
    child.stdout!.on('end', () => {
      emitParsed(parser.end())
    })

    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd()
      if (text) log.warn('[chat] stderr:', text)
    })

    const rec: Inflight = {
      child,
      requestId,
      watchdog: undefined as unknown as NodeJS.Timeout,
      killTimer: null,
      cancelled: false,
      timedOut: false,
    }
    this.inflight.set(chatId, rec)

    const timeoutMs = this.__testOverrideTimeoutMs ?? TURN_TIMEOUT_MS
    rec.watchdog = setTimeout(() => {
      log.warn('[chat] turn timeout', { chatId })
      const cur = this.inflight.get(chatId)
      if (!cur) return
      cur.timedOut = true
      this.killChild(cur)
    }, timeoutMs)

    child.on('error', (err) => {
      log.warn('[chat] child error:', err)
    })

    child.on('exit', (code, signal) => {
      clearTimeout(rec.watchdog)
      if (rec.killTimer) clearTimeout(rec.killTimer)
      this.inflight.delete(chatId)

      const finalSession = sessionFromInit ?? meta.claudeSessionId ?? null

      let ok = code === 0
      let error: string | undefined
      if (rec.timedOut) {
        ok = false
        error = 'timeout'
      } else if (rec.cancelled) {
        ok = false
        error = 'cancelled'
      } else if (!ok) {
        error = `exit_${code ?? signal ?? 'unknown'}`
      }

      if (ok) {
        // Successful turn — bump counter and persist session id
        this.deps.store
          .update(chatId, {
            messageCount: meta.messageCount + 1,
            claudeSessionId: finalSession,
          })
          .catch((err) => log.warn('[chat] store.update failed:', err))
      } else if (finalSession && !meta.claudeSessionId) {
        // First-turn failure — still persist the session id so retry can resume
        this.deps.store
          .update(chatId, { claudeSessionId: finalSession })
          .catch((err) => log.warn('[chat] failed to persist sessionId on first-turn failure:', err))
      }

      this.deps.onEnd({
        requestId,
        ok,
        error,
        claudeSessionId: finalSession ?? undefined,
      })
    })

    return { requestId }
  }

  cancel(chatId: string): void {
    const rec = this.inflight.get(chatId)
    if (!rec) return
    rec.cancelled = true
    this.killChild(rec)
  }

  /**
   * Cancel + wait for the child to exit (up to CANCEL_GRACE_MS + 500ms slack).
   * Callers that immediately delete or reuse the chat's cwd must use this
   * rather than fire-and-forget `cancel()` — otherwise the child can keep
   * writing to a soon-to-be-deleted directory during the SIGTERM→SIGKILL
   * grace window (spec §6.5).
   */
  async cancelAndWait(chatId: string): Promise<void> {
    if (!this.inflight.has(chatId)) return
    const deadline = Date.now() + CANCEL_GRACE_MS + 500
    this.cancel(chatId)
    while (this.inflight.has(chatId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30))
    }
  }

  cancelAll(): void {
    for (const id of Array.from(this.inflight.keys())) this.cancel(id)
  }

  private killChild(rec: Inflight): void {
    // Note on Windows: Node's child.kill('SIGTERM') is internally translated
    // to TerminateProcess(), which is equivalent to SIGKILL — there is no
    // graceful-exit signal for non-GUI processes. The CANCEL_GRACE_MS delay
    // and SIGKILL escalation below are therefore no-ops on Windows but harmless.
    // Callers that need to flush filesystem state (e.g. before deleting a
    // chat's cwd) should use cancelAndWait() and accept that codex on Windows
    // cannot run cleanup handlers.
    try {
      rec.child.kill('SIGTERM')
    } catch {
      // ignore
    }
    rec.killTimer = setTimeout(() => {
      rec.killTimer = null
      if (rec.child.exitCode === null && rec.child.signalCode === null) {
        try {
          rec.child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
    }, CANCEL_GRACE_MS)
  }
}
