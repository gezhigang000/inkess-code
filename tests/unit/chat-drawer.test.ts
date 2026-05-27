import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChatStore } from '../../src/main/chat/chat-store'

function newStore(): ChatStore {
  const base = mkdtempSync(join(tmpdir(), 'chat-drawer-test-'))
  return new ChatStore(base, '2.1.98')
}

describe('ChatStore.create() with custom cwd', () => {
  let store: ChatStore

  beforeEach(async () => {
    store = newStore()
    await store.init()
  })

  it('keeps app workspace as cwd and stores provided project as a mounted dir', async () => {
    const customDir = mkdtempSync(join(tmpdir(), 'custom-cwd-'))
    const meta = await store.create(customDir)
    const base = (store as any).baseDir as string
    const expectedWorkspace = join(base, 'ai-workspace', meta.id)

    expect(meta.cwd).toBe(expectedWorkspace)
    expect(meta.mountedDirs).toEqual([customDir])
    expect(existsSync(expectedWorkspace)).toBe(true)
  })

  it('falls back to ai-workspace/{id} when no cwd provided', async () => {
    const meta = await store.create()
    const base = (store as any).baseDir as string
    const expected = join(base, 'ai-workspace', meta.id)
    expect(meta.cwd).toBe(expected)
    expect(existsSync(meta.cwd)).toBe(true)
  })

  it('falls back to ai-workspace/{id} when undefined passed', async () => {
    const meta = await store.create(undefined)
    expect(meta.cwd).toContain('ai-workspace')
  })

  it('mounted custom project is persisted and survives reload', async () => {
    const customDir = mkdtempSync(join(tmpdir(), 'custom-cwd-'))
    const meta = await store.create(customDir)

    const base = (store as any).baseDir as string
    const reload = new ChatStore(base, '2.1.98')
    await reload.init()
    const reloaded = reload.get(meta.id)

    expect(reloaded).toBeDefined()
    expect(reloaded!.cwd).toBe(join(base, 'ai-workspace', meta.id))
    expect(reloaded!.mountedDirs).toEqual([customDir])
  })

  it('custom cwd is still immutable via update()', async () => {
    const customDir = mkdtempSync(join(tmpdir(), 'custom-cwd-'))
    const meta = await store.create(customDir)
    const base = (store as any).baseDir as string
    const expectedWorkspace = join(base, 'ai-workspace', meta.id)

    await store.update(meta.id, { cwd: '/tmp/evil' } as any)

    const after = store.get(meta.id)!
    expect(after.cwd).toBe(expectedWorkspace)
    expect(after.mountedDirs).toEqual([customDir])
  })

  it('delete(removeFiles=true) removes only app workspace and keeps mounted external dir', async () => {
    const customDir = mkdtempSync(join(tmpdir(), 'custom-cwd-'))
    const meta = await store.create(customDir)
    const workspace = meta.cwd

    await store.delete(meta.id, { removeFiles: true })

    expect(store.get(meta.id)).toBeUndefined()
    expect(existsSync(workspace)).toBe(false)
    expect(existsSync(customDir)).toBe(true)
  })

  it('multiple chats can mount the same project while keeping separate workspaces', async () => {
    const sharedDir = mkdtempSync(join(tmpdir(), 'shared-cwd-'))
    const a = await store.create(sharedDir)
    const b = await store.create(sharedDir)

    expect(a.cwd).not.toBe(sharedDir)
    expect(b.cwd).not.toBe(sharedDir)
    expect(a.cwd).not.toBe(b.cwd)
    expect(a.mountedDirs).toEqual([sharedDir])
    expect(b.mountedDirs).toEqual([sharedDir])
  })
})
