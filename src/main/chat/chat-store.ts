import { randomUUID } from 'crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import type { ChatMeta, ChatsIndex } from './chat-types'

/**
 * On-disk layout (spec §1):
 *   {baseDir}/
 *     chats/
 *       index.json
 *       consents/                 (reserved for v0.2+; created lazily)
 *     ai-workspace/
 *       {chatId}/                 (per-chat working directory)
 *
 * index.json is written atomically (write .tmp then rename). If the file is
 * corrupt on load, it is renamed to index.json.broken-{ts} and rebuilt empty.
 *
 * Intentionally synchronous for reads (called on hot paths) and async for
 * writes (single-writer in main process; no concurrent write collisions).
 */
export class ChatStore {
  private readonly chatsDir: string
  private readonly workspaceDir: string
  private readonly indexPath: string
  private chats: ChatMeta[] = []

  constructor(
    private readonly baseDir: string,
    private readonly cliVersion: string,
  ) {
    this.chatsDir = join(baseDir, 'chats')
    this.workspaceDir = join(baseDir, 'ai-workspace')
    this.indexPath = join(this.chatsDir, 'index.json')
  }

  async init(): Promise<void> {
    mkdirSync(this.chatsDir, { recursive: true })
    mkdirSync(this.workspaceDir, { recursive: true })
    this.chats = this.readIndex()
  }

  list(): ChatMeta[] {
    return this.chats.slice()
  }

  get(chatId: string): ChatMeta | undefined {
    return this.chats.find((c) => c.id === chatId)
  }

  async create(opts?: string | { cwd?: string; engine?: 'claude' | 'codex' }): Promise<ChatMeta> {
    // Backward compat: callers used to pass a bare cwd string.
    const o: { cwd?: string; engine?: 'claude' | 'codex' } =
      typeof opts === 'string' ? { cwd: opts } : (opts ?? {})

    const id = randomUUID()
    const dataDir = join(this.workspaceDir, id)
    mkdirSync(dataDir, { recursive: true })
    const cwd = o.cwd || dataDir

    const now = Date.now()
    const meta: ChatMeta = {
      id,
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      cwd,
      mountedDirs: [],
      claudeSessionId: null,
      cliVersion: this.cliVersion,
      messageCount: 0,
      starred: false,
      engine: o.engine === 'codex' ? 'codex' : 'claude',
    }
    this.chats.unshift(meta)
    await this.writeIndex()
    return { ...meta }
  }

  async update(chatId: string, patch: Partial<ChatMeta>): Promise<void> {
    const i = this.chats.findIndex((c) => c.id === chatId)
    if (i < 0) throw new Error(`chat ${chatId} not found`)

    // Never allow mutation of id / createdAt / cwd / cliVersion
    const { id: _id, createdAt: _cr, cwd: _cwd, cliVersion: _cv, ...safe } = patch
    const prev = this.chats[i]
    this.chats[i] = { ...prev, ...safe, updatedAt: Date.now() }
    try {
      await this.writeIndex()
    } catch (err) {
      this.chats[i] = prev // rollback in-memory on write failure
      throw err
    }
  }

  async delete(chatId: string, opts: { removeFiles: boolean }): Promise<void> {
    const i = this.chats.findIndex((c) => c.id === chatId)
    if (i < 0) return
    const victim = this.chats[i]
    this.chats.splice(i, 1)
    await this.writeIndex()

    if (opts.removeFiles) {
      try {
        rmSync(victim.cwd, { recursive: true, force: true })
      } catch {
        // Swallow — index already reflects the deletion
      }
    }
  }

  private readIndex(): ChatMeta[] {
    if (!existsSync(this.indexPath)) return []
    let raw: string
    try {
      raw = readFileSync(this.indexPath, 'utf8')
    } catch {
      return this.backupAndReset()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return this.backupAndReset()
    }
    if (!isValidIndex(parsed)) {
      return this.backupAndReset()
    }
    return parsed.chats
  }

  private backupAndReset(): ChatMeta[] {
    try {
      const backup = join(this.chatsDir, `index.json.broken-${Date.now()}`)
      renameSync(this.indexPath, backup)
    } catch {
      // index.json might not exist — that's fine
    }
    return []
  }

  private async writeIndex(): Promise<void> {
    const idx: ChatsIndex = { version: 1, chats: this.chats }
    const tmp = `${this.indexPath}.tmp`
    writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf8')
    renameSync(tmp, this.indexPath)
  }
}

function isValidIndex(x: unknown): x is ChatsIndex {
  if (!x || typeof x !== 'object') return false
  const v = x as Record<string, unknown>
  return v.version === 1 && Array.isArray(v.chats)
}
