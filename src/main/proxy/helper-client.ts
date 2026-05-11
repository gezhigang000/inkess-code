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
}

// --- Client ---

export class HelperClient {
  private socketPath: string

  constructor(socketPath = SOCKET_PATH) {
    this.socketPath = socketPath
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
    return await this.send({ op: 'info' }) as HelperInfoResponse
  }

  /** Get sing-box process status from the helper. */
  async getStatus(): Promise<HelperStatusResponse> {
    return await this.send({ op: 'status' }) as HelperStatusResponse
  }

  /**
   * Ask the helper to start sing-box.
   * The helper spawns sing-box as root with the given binary and config,
   * and starts a watchdog monitoring `appPid`.
   */
  async start(binaryPath: string, configPath: string, appPid: number): Promise<void> {
    const resp = await this.send({
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
    const resp = await this.send({ op: 'stop' })
    if (!resp.ok) {
      throw new Error(resp.error || 'helper: stop failed')
    }
    log.info('[helper] sing-box stopped')
  }

  /** Set system DNS via scutil (runs as root in the helper). */
  async setDns(server: string): Promise<void> {
    const resp = await this.send({ op: 'set_dns', server })
    if (!resp.ok) {
      throw new Error(resp.error || 'helper: set_dns failed')
    }
    log.info(`[helper] system DNS set to ${server}`)
  }

  /** Restore system DNS to default via scutil. */
  async restoreDns(): Promise<void> {
    const resp = await this.send({ op: 'restore_dns' })
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
}
