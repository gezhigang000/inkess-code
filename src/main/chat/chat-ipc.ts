import { ipcMain, type BrowserWindow } from 'electron'
import log from '../logger'
import type { ChatManager } from './chat-manager'
import type { ChatStore } from './chat-store'
import { validateChatId, validateDirPath, validateText } from './validators'
import { loadHistory } from './history-loader'

export interface ChatIpcDeps {
  mainWindow: () => BrowserWindow | null
  store: ChatStore
  manager: ChatManager
  claudeConfigDir: string
}

/**
 * Register every `chat:*` IPC handler.
 *
 * Event broadcast channels (main → renderer):
 *   chat:stream       — per-event stream dispatch (wired via ChatManager.onEvent callback)
 *   chat:end          — per-turn end dispatch (wired via ChatManager.onEnd callback)
 *   chat:listChanged  — broadcast whenever the index.json changes (create / update / delete / rename)
 *
 * Call site (main/index.ts) is responsible for:
 *   1. constructing the ChatManager with onEvent/onEnd that call safeSend('chat:stream'|'chat:end', ...)
 *   2. invoking broadcastListChanged from here after each store mutation
 */
export function registerChatIPC(deps: ChatIpcDeps): void {
  const { store, manager, claudeConfigDir } = deps

  const broadcastListChanged = () => {
    try {
      deps.mainWindow()?.webContents.send('chat:listChanged')
    } catch {
      // window may be gone
    }
  }

  ipcMain.handle('chat:list', () => {
    return store.list()
  })

  ipcMain.handle('chat:create', async (_event, args?: unknown) => {
    const a = args && typeof args === 'object'
      ? args as { cwd?: unknown; engine?: string }
      : undefined
    let cwd: string | undefined
    if (a && Object.prototype.hasOwnProperty.call(a, 'cwd')) {
      validateDirPath(a.cwd)
      cwd = a.cwd
    }
    const engine = a?.engine === 'codex' ? 'codex' : 'claude'
    const meta = await store.create({ cwd, engine })
    broadcastListChanged()
    return meta
  })

  ipcMain.handle('chat:send', async (_event, args: unknown) => {
    const a = args as { chatId?: unknown; text?: unknown }
    validateChatId(a?.chatId)
    validateText(a?.text)
    return manager.send(a.chatId, a.text)
  })

  ipcMain.handle('chat:cancel', async (_event, args: unknown) => {
    const a = args as { chatId?: unknown }
    validateChatId(a?.chatId)
    manager.cancel(a.chatId)
  })

  ipcMain.handle('chat:loadHistory', async (_event, args: unknown) => {
    const a = args as { chatId?: unknown }
    validateChatId(a?.chatId)
    const meta = store.get(a.chatId)
    if (!meta) throw new Error('invalid_chat_id')
    try {
      return await loadHistory(meta, claudeConfigDir)
    } catch (err) {
      log.warn('[chat] loadHistory failed:', err)
      return []
    }
  })

  ipcMain.handle('chat:rename', async (_event, args: unknown) => {
    const a = args as { chatId?: unknown; title?: unknown }
    validateChatId(a?.chatId)
    const title = typeof a?.title === 'string' ? a.title.slice(0, 200) : ''
    if (!title) throw new Error('invalid_title')
    await store.update(a.chatId, { title })
    broadcastListChanged()
  })

  ipcMain.handle('chat:delete', async (_event, args: unknown) => {
    const a = args as { chatId?: unknown; removeFiles?: unknown }
    validateChatId(a?.chatId)
    const removeFiles = a?.removeFiles !== false // default true per spec §2
    // Spec §6.5: if a turn is running, cancel AND wait for the child to exit
    // before wiping files — otherwise the Claude Code subprocess can keep
    // writing to the soon-to-be-deleted cwd during the SIGTERM→SIGKILL grace
    // window (3s), leaving orphaned files in a re-created directory.
    if (removeFiles) {
      await manager.cancelAndWait(a.chatId)
    } else {
      manager.cancel(a.chatId)
    }
    await store.delete(a.chatId, { removeFiles })
    broadcastListChanged()
  })
}

/** Tear down all handlers — call on before-quit so tests or reloads don't stack up. */
export function unregisterChatIPC(): void {
  for (const ch of [
    'chat:list', 'chat:create', 'chat:send', 'chat:cancel',
    'chat:loadHistory', 'chat:rename', 'chat:delete',
  ]) {
    ipcMain.removeHandler(ch)
  }
}
