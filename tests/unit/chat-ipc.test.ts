import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'os'

const handlers = new Map<string, (...args: any[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    }),
  },
}))

vi.mock('../../src/main/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { registerChatIPC, unregisterChatIPC } from '../../src/main/chat/chat-ipc'

function registerWithCreate(create = vi.fn(async (args) => ({ id: 'chat-id', ...args }))) {
  const store = {
    list: vi.fn(() => []),
    create,
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  }
  const manager = {
    send: vi.fn(),
    cancel: vi.fn(),
    cancelAndWait: vi.fn(),
  }

  registerChatIPC({
    mainWindow: () => null,
    store: store as any,
    manager: manager as any,
    claudeConfigDir: '',
  })

  const handler = handlers.get('chat:create')
  if (!handler) throw new Error('chat:create handler not registered')
  return { create, handler }
}

describe('chat:create IPC', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    unregisterChatIPC()
  })

  it('treats absent cwd as no mount and preserves codex engine', async () => {
    const { create, handler } = registerWithCreate()

    await handler({}, { engine: 'codex' })

    expect(create).toHaveBeenCalledWith({ cwd: undefined, engine: 'codex' })
  })

  it('validates and passes a present valid cwd', async () => {
    const { create, handler } = registerWithCreate()
    const cwd = homedir()

    await handler({}, { cwd, engine: 'codex' })

    expect(create).toHaveBeenCalledWith({ cwd, engine: 'codex' })
  })

  it('rejects a present empty cwd', async () => {
    const { create, handler } = registerWithCreate()

    await expect(handler({}, { cwd: '', engine: 'codex' })).rejects.toThrow(/dir_invalid/)

    expect(create).not.toHaveBeenCalled()
  })

  it('rejects a present non-string cwd', async () => {
    const { create, handler } = registerWithCreate()

    await expect(handler({}, { cwd: 42, engine: 'codex' })).rejects.toThrow(/dir_invalid/)

    expect(create).not.toHaveBeenCalled()
  })
})
