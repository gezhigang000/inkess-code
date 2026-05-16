/**
 * Unix socket client for the inkess-ccp-helper privileged daemon.
 *
 * The helper runs as root via LaunchDaemon and manages sing-box lifecycle,
 * DNS setup, and process cleanup — all without per-operation sudo prompts.
 *
 * Protocol: newline-delimited JSON over /var/run/inkess-ccp-helper.sock
 * Each request is a short-lived connection: connect → write JSON line → read response → close.
 */

import * as net from 'net'
import log from '../logger'

const SOCKET_PATH = '/var/run/inkess-ccp-helper.sock'
const REQUEST_TIMEOUT_MS = 10_000

// --- Request types (must match Rust enum Request) ---

interface StartRequest {
  op: 'start'
  binary_path: string
  config_path: string
  app_pid: number
}

interface StopRequest { op: 'stop' }
interface StatusRequest { op: 'status' }
interface InfoRequest { op: 'info' }
interface SetDnsRequest { op: 'set_dns'; server: string }
interface RestoreDnsRequest { op: 'restore_dns' }
interface ShutdownRequest { op: 'shutdown' }

type HelperRequest =
  | StartRequest | StopRequest | StatusRequest | InfoRequest
  | SetDnsRequest | RestoreDnsRequest | ShutdownRequest

// --- Response types ---

export interface HelperStatusResponse {
  ok: boolean
  singbox_pid?: number
  singbox_running?: boolean
  started_at?: string
  version?: string
  uptime_sec?: number
  error?: string
}

export interface HelperInfoResponse {
  ok: boolean
  version?: string
  error?: string
}

interface HelperResponse {
  ok: boolean
  singbox_pid?: number
  singbox_running?: boolean
  started_at?: string
  version?: string
  uptime_sec?: number
  error?: string
  /** Set on asynchronous event pushes from a Subscribe connection. */
  event?: 'singbox_started' | 'singbox_exited'
  /** Populated on singbox_exited (normal exit). */
  exit_code?: number
  /** Populated on singbox_exited (signal-induced exit, Unix only). */
  signal?: number
}

/** Lifecycle event pushed by the helper over a Subscribe connection. */
export interface HelperEvent {
  event: 'singbox_started' | 'singbox_exited'
  singbox_pid?: number
  singbox_running?: boolean
  started_at?: string
  exit_code?: number
  signal?: number
}

// --- Client ---

export class HelperClient {
  private socketPath: string

  constructor(socketPath = SOCKET_PATH) {
    this.socketPath = socketPath
  }

  /**
   * Send a request with automatic retry on transient socket errors.
   * Handles helper daemon restarts (launchd KeepAlive bounce ~500ms).
   */
  private async sendWithRetry(
    request: HelperRequest,
    retries = 3,
    delayMs = 500,
  ): Promise<HelperResponse> {
    let lastError: Error | null = null
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this.send(request)
      } catch (err) {
        lastError = err as Error
        const msg = lastError.message
        const isTransient =
          msg.includes('ECONNREFUSED') ||
          msg.includes('ENOENT') ||
          msg.includes('socket error') ||
          msg.includes('closed connection without response')
        if (!isTransient || attempt === retries) break
        log.debug(`[helper] ${request.op} attempt ${attempt}/${retries} failed (${msg}), retrying in ${delayMs}ms...`)
        await new Promise(r => setTimeout(r, delayMs))
      }
    }
    throw lastError!
  }

  /**
   * Send a request to the helper and return the parsed response.
   * Each call opens a new connection (matches the Rust helper's per-connection model).
   */
  private send(request: HelperRequest): Promise<HelperResponse> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ path: this.socketPath })
      let data = ''
      let settled = false

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          socket.destroy()
          reject(new Error(`helper request '${request.op}' timed out (${REQUEST_TIMEOUT_MS}ms)`))
        }
      }, REQUEST_TIMEOUT_MS)

      const settle = (err: Error | null, result?: HelperResponse) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (err) reject(err)
        else resolve(result!)
      }

      socket.on('connect', () => {
        socket.write(JSON.stringify(request) + '\n')
      })

      socket.on('data', (chunk) => {
        data += chunk.toString()
        const newlineIdx = data.indexOf('\n')
        if (newlineIdx >= 0) {
          const line = data.slice(0, newlineIdx).trim()
          try {
            const resp = JSON.parse(line) as HelperResponse
            settle(null, resp)
          } catch (e) {
            settle(new Error(`helper returned invalid JSON: ${line}`))
          }
        }
      })

      socket.on('error', (err) => {
        settle(new Error(`helper socket error: ${err.message}`))
      })

      socket.on('end', () => {
        // If we got data but no newline, try to parse what we have
        if (!settled && data.trim()) {
          try {
            const resp = JSON.parse(data.trim()) as HelperResponse
            settle(null, resp)
          } catch {
            settle(new Error(`helper closed connection with unparseable data: ${data.trim()}`))
          }
        } else if (!settled) {
          settle(new Error('helper closed connection without response'))
        }
      })
    })
  }

  /** Check if the helper daemon is reachable. */
  async isAvailable(): Promise<boolean> {
    try {
      const resp = await this.send({ op: 'info' })
      return resp.ok === true
    } catch {
      return false
    }
  }

  /** Get helper version and uptime. */
  async getInfo(): Promise<HelperInfoResponse> {
    return await this.sendWithRetry({ op: 'info' }) as HelperInfoResponse
  }

  /** Get sing-box process status from the helper. */
  async getStatus(): Promise<HelperStatusResponse> {
    return await this.sendWithRetry({ op: 'status' }) as HelperStatusResponse
  }

  /**
   * Ask the helper to start sing-box.
   * The helper spawns sing-box as root with the given binary and config,
   * and starts a watchdog monitoring `appPid`.
   */
  async start(binaryPath: string, configPath: string, appPid: number): Promise<void> {
    const resp = await this.sendWithRetry({
      op: 'start',
      binary_path: binaryPath,
      config_path: configPath,
      app_pid: appPid,
    })
    if (!resp.ok) {
      throw new Error(resp.error || 'helper: start failed')
    }
    log.info(`[helper] sing-box started, pid=${resp.singbox_pid}`)
  }

  /** Ask the helper to stop sing-box (SIGTERM → SIGKILL escalation). */
  async stop(): Promise<void> {
    const resp = await this.sendWithRetry({ op: 'stop' })
    if (!resp.ok) {
      throw new Error(resp.error || 'helper: stop failed')
    }
    log.info('[helper] sing-box stopped')
  }

  /** Set system DNS via scutil (runs as root in the helper). */
  async setDns(server: string): Promise<void> {
    const resp = await this.sendWithRetry({ op: 'set_dns', server })
    if (!resp.ok) {
      throw new Error(resp.error || 'helper: set_dns failed')
    }
    log.info(`[helper] system DNS set to ${server}`)
  }

  /** Restore system DNS to default via scutil. */
  async restoreDns(): Promise<void> {
    const resp = await this.sendWithRetry({ op: 'restore_dns' })
    if (!resp.ok) {
      throw new Error(resp.error || 'helper: restore_dns failed')
    }
    log.info('[helper] system DNS restored')
  }

  /** Shut down the helper daemon itself. */
  async shutdown(): Promise<void> {
    try {
      await this.send({ op: 'shutdown' })
    } catch {
      // Expected — helper closes socket on shutdown
    }
  }

  /**
   * Open a long-lived subscription connection. The helper will push one
   * JSON line per sing-box lifecycle event (`singbox_started`,
   * `singbox_exited`). Auto-reconnects on disconnect with bounded backoff,
   * so callers can subscribe once at startup and forget about it.
   *
   * Returns a controller. Call `controller.close()` to stop and tear down.
   * The `onConnect` callback fires every time the socket is freshly
   * connected — use it to fetch a one-shot status snapshot so the caller
   * recovers from any events missed while reconnecting.
   */
  subscribe(opts: {
    onEvent: (event: HelperEvent) => void
    onConnect?: () => void
    onDisconnect?: (err?: Error) => void
  }): { close: () => void } {
    let closed = false
    let socket: net.Socket | null = null
    let backoffMs = 1000
    const MAX_BACKOFF_MS = 10_000
    let reconnectTimer: NodeJS.Timeout | null = null

    const connect = () => {
      if (closed) return
      let buffer = ''
      let acked = false
      socket = net.connect({ path: this.socketPath })

      socket.on('connect', () => {
        // Socket connected — helper is listening. Cap backoff to reduce
        // blind time if we disconnect again before receiving the ack.
        backoffMs = Math.min(backoffMs, 2000)
        socket!.write(JSON.stringify({ op: 'subscribe' }) + '\n')
      })

      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line) continue
          let resp: HelperResponse
          try {
            resp = JSON.parse(line) as HelperResponse
          } catch (e) {
            log.warn(`[helper] subscribe: bad JSON line: ${line}`)
            continue
          }
          if (!acked) {
            // First line is the ack for our subscribe request.
            acked = true
            if (!resp.ok) {
              log.warn(`[helper] subscribe ack error: ${resp.error}`)
              socket?.destroy()
              return
            }
            // Subscription is live — reset backoff and notify caller.
            backoffMs = 1000
            try { opts.onConnect?.() } catch (err) {
              log.warn(`[helper] subscribe onConnect threw: ${(err as Error).message}`)
            }
            continue
          }
          // Subsequent lines are event pushes.
          if (resp.event === 'singbox_started' || resp.event === 'singbox_exited') {
            try {
              opts.onEvent({
                event: resp.event,
                singbox_pid: resp.singbox_pid,
                singbox_running: resp.singbox_running,
                started_at: resp.started_at,
                exit_code: resp.exit_code,
                signal: resp.signal,
              })
            } catch (err) {
              log.warn(`[helper] subscribe onEvent threw: ${(err as Error).message}`)
            }
          } else if (!resp.ok && resp.error) {
            // Helper kicked us off — e.g. lagged subscription. Reconnect.
            log.warn(`[helper] subscribe server message: ${resp.error}`)
          }
        }
      })

      const onClosed = (err?: Error) => {
        socket = null
        if (closed) return
        try { opts.onDisconnect?.(err) } catch { /* swallow */ }
        scheduleReconnect()
      }

      socket.on('error', (err) => {
        log.debug(`[helper] subscribe socket error: ${err.message}`)
        onClosed(err)
      })
      socket.on('end', () => onClosed())
      socket.on('close', () => onClosed())
    }

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return
      const delay = backoffMs
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }

    connect()

    return {
      close: () => {
        closed = true
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
        try { socket?.destroy() } catch { /* ignore */ }
        socket = null
      },
    }
  }
}
