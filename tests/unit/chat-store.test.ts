import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChatStore } from '../../src/main/chat/chat-store'

function newStore(): ChatStore {
  const base = mkdtempSync(join(tmpdir(), 'chat-store-test-'))
  return new ChatStore(base, '2.1.98')
}

describe('ChatStore', () => {
  let store: ChatStore

  beforeEach(() => {
    store = newStore()
  })

  it('init() creates chats/ and ai-workspace/ if missing; writes empty index', async () => {
    await store.init()
    expect(store.list()).toEqual([])
  })

  it('create() returns a ChatMeta with uuid + cwd + default values', async () => {
    await store.init()
    const meta = await store.create()
    expect(meta.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(meta.title).toBe('New chat')
    expect(meta.cwd.endsWith(meta.id)).toBe(true)
    expect(meta.mountedDirs).toEqual([])
    expect(meta.claudeSessionId).toBeNull()
    expect(meta.messageCount).toBe(0)
    expect(meta.cliVersion).toBe('2.1.98')
    expect(existsSync(meta.cwd)).toBe(true)
  })

  it('persists across reload', async () => {
    await store.init()
    const a = await store.create()
    const b = await store.create()

    const base = (store as any).baseDir as string
    const reload = new ChatStore(base, '2.1.98')
    await reload.init()
    const ids = reload.list().map((m) => m.id).sort()
    expect(ids).toEqual([a.id, b.id].sort())
  })

  it('update() patches fields and bumps updatedAt', async () => {
    await store.init()
    const m = await store.create()
    const before = m.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    await store.update(m.id, { title: 'renamed', messageCount: 1 })
    const after = store.get(m.id)!
    expect(after.title).toBe('renamed')
    expect(after.messageCount).toBe(1)
    expect(after.updatedAt).toBeGreaterThan(before)
  })

  it('delete(removeFiles=true) removes index entry and cwd', async () => {
    await store.init()
    const m = await store.create()
    writeFileSync(join(m.cwd, 'note.txt'), 'hi')
    await store.delete(m.id, { removeFiles: true })
    expect(store.get(m.id)).toBeUndefined()
    expect(existsSync(m.cwd)).toBe(false)
  })

  it('delete(removeFiles=true) does not remove legacy external cwd entries', async () => {
    await store.init()
    const base = (store as any).baseDir as string
    const externalDir = mkdtempSync(join(tmpdir(), 'legacy-external-cwd-'))
    const now = Date.now()
    const legacy = {
      id: randomUUID(),
      title: 'Legacy chat',
      createdAt: now,
      updatedAt: now,
      cwd: externalDir,
      mountedDirs: [],
      claudeSessionId: null,
      cliVersion: '2.1.98',
      messageCount: 0,
      starred: false,
      engine: 'claude' as const,
    }

    writeFileSync(
      join(base, 'chats', 'index.json'),
      JSON.stringify({ version: 1, chats: [legacy] }, null, 2),
    )

    const reload = new ChatStore(base, '2.1.98')
    await reload.init()
    await reload.delete(legacy.id, { removeFiles: true })

    expect(reload.get(legacy.id)).toBeUndefined()
    expect(existsSync(externalDir)).toBe(true)
  })

  it('delete(removeFiles=false) removes index entry but keeps cwd', async () => {
    await store.init()
    const m = await store.create()
    await store.delete(m.id, { removeFiles: false })
    expect(store.get(m.id)).toBeUndefined()
    expect(existsSync(m.cwd)).toBe(true)
  })

  it('corrupt index.json is backed up and rebuilt as empty', async () => {
    await store.init()
    const base = (store as any).baseDir as string
    const indexPath = join(base, 'chats', 'index.json')
    writeFileSync(indexPath, '{ this is not json')

    const reload = new ChatStore(base, '2.1.98')
    await reload.init()
    expect(reload.list()).toEqual([])

    const dir = join(base, 'chats')
    const files = readdirSync(dir)
    expect(files.some((f) => f.startsWith('index.json.broken-'))).toBe(true)
  })

  it('wrong schema version is treated as corrupt', async () => {
    await store.init()
    const base = (store as any).baseDir as string
    const indexPath = join(base, 'chats', 'index.json')
    writeFileSync(indexPath, JSON.stringify({ version: 99, chats: [] }))

    const reload = new ChatStore(base, '2.1.98')
    await reload.init()
    expect(reload.list()).toEqual([])
  })

  it('atomic write: no .tmp file remains after successful write', async () => {
    await store.init()
    await store.create()
    const base = (store as any).baseDir as string
    const dir = join(base, 'chats')
    const files = readdirSync(dir)
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  it('update() throws on unknown chatId', async () => {
    await store.init()
    await expect(store.update('ghost', { title: 'x' })).rejects.toThrow()
  })

  it('delete() is a no-op on unknown chatId', async () => {
    await store.init()
    await store.delete('ghost', { removeFiles: true })
    // should not throw
  })
})
