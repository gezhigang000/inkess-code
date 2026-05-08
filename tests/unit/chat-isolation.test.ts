/**
 * Tests for chat mode isolation from CLI mode.
 *
 * Covers:
 * - initChatMode() independence (main process)
 * - loadChatList deduplication (renderer store logic)
 * - ChatErrorBoundary file existence & exports
 * - Architecture: ChatApp does NOT import TerminalApp or CLI-only modules
 * - Architecture: App.tsx imports ChatErrorBoundary
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const REPO = resolve(__dirname, '../..')

function read(relPath: string): string {
  return readFileSync(resolve(REPO, relPath), 'utf8')
}

describe('initChatMode extraction', () => {
  const indexTs = read('src/main/index.ts')

  it('initChatMode is a standalone function', () => {
    expect(indexTs).toMatch(/async function initChatMode\(\): Promise<void>/)
  })

  it('app.whenReady calls initChatMode()', () => {
    expect(indexTs).toMatch(/await initChatMode\(\)/)
  })

  it('initChatMode has its own try/catch (does not crash CLI on failure)', () => {
    // Extract the function body
    const fnStart = indexTs.indexOf('async function initChatMode')
    expect(fnStart).toBeGreaterThan(-1)
    const fnBody = indexTs.slice(fnStart, fnStart + 4000)
    expect(fnBody).toMatch(/try\s*\{/)
    expect(fnBody).toMatch(/\} catch \(err\)/)
    expect(fnBody).toMatch(/log\.error\('\[chat\] init failed/)
  })
})

describe('ChatErrorBoundary', () => {
  it('file exists', () => {
    expect(existsSync(resolve(REPO, 'src/renderer/views/chat/ChatErrorBoundary.tsx'))).toBe(true)
  })

  it('exports ChatErrorBoundary class', () => {
    const src = read('src/renderer/views/chat/ChatErrorBoundary.tsx')
    expect(src).toMatch(/export class ChatErrorBoundary/)
  })

  it('has onFallbackToCliMode prop', () => {
    const src = read('src/renderer/views/chat/ChatErrorBoundary.tsx')
    expect(src).toMatch(/onFallbackToCliMode/)
  })

  it('has handleRetry method', () => {
    const src = read('src/renderer/views/chat/ChatErrorBoundary.tsx')
    expect(src).toMatch(/handleRetry/)
  })
})

describe('TerminalApp.tsx chat drawer isolation', () => {
  // Chat was moved from App.tsx (full mode switch) to TerminalApp.tsx (right drawer).
  // ChatErrorBoundary now wraps ChatDrawer inside TerminalApp.
  const terminalAppTsx = read('src/renderer/TerminalApp.tsx')

  it('imports ChatErrorBoundary', () => {
    expect(terminalAppTsx).toMatch(/import.*ChatErrorBoundary.*from/)
  })

  it('wraps ChatDrawer in ChatErrorBoundary', () => {
    expect(terminalAppTsx).toMatch(/<ChatErrorBoundary/)
    expect(terminalAppTsx).toMatch(/<ChatDrawer/)
  })

  it('provides onFallbackToCliMode callback', () => {
    expect(terminalAppTsx).toMatch(/onFallbackToCliMode/)
  })

  it('App.tsx does NOT directly reference useChatStore', () => {
    const appTsx = read('src/renderer/App.tsx')
    expect(appTsx).not.toMatch(/useChatStore/)
  })
})

describe('ChatApp unmount cleanup', () => {
  const chatAppTsx = read('src/renderer/views/chat/ChatApp.tsx')

  it('has useEffect cleanup that cancels inflight and clears state', () => {
    expect(chatAppTsx).toMatch(/return \(\) =>/)
    expect(chatAppTsx).toMatch(/state\.cancel\(chatId\)/)
    expect(chatAppTsx).toMatch(/useChatStore\.setState\(\{ inflight: \{\} \}\)/)
  })
})

describe('ChatApp Windows controls', () => {
  const chatAppTsx = read('src/renderer/views/chat/ChatApp.tsx')

  it('renders window controls for non-darwin platforms', () => {
    expect(chatAppTsx).toMatch(/platform.*!==.*darwin/)
    expect(chatAppTsx).toMatch(/window\.api\.window\.minimize/)
    expect(chatAppTsx).toMatch(/window\.api\.window\.maximize/)
    expect(chatAppTsx).toMatch(/window\.api\.window\.close/)
  })
})

describe('TerminalApp mode-switch cache', () => {
  const terminalAppTsx = read('src/renderer/TerminalApp.tsx')

  it('declares _cachedSubscriptionState at module level', () => {
    expect(terminalAppTsx).toMatch(/let _cachedSubscriptionState/)
  })

  it('restores from cache on mount (skips re-init)', () => {
    expect(terminalAppTsx).toMatch(/_cachedSubscriptionState\?\.loggedIn/)
  })

  it('writes to cache after successful subscription check', () => {
    expect(terminalAppTsx).toMatch(/_cachedSubscriptionState = \{/)
  })

  it('clears cache on logout', () => {
    expect(terminalAppTsx).toMatch(/_cachedSubscriptionState = null/)
  })
})

describe('loadChatList deduplication', () => {
  const chatStoreTsx = read('src/renderer/stores/chat.ts')

  it('compares prev and new list before calling set()', () => {
    expect(chatStoreTsx).toMatch(/prev\.length === chats\.length/)
    expect(chatStoreTsx).toMatch(/prev\.every/)
    expect(chatStoreTsx).toMatch(/c\.id === chats\[i\]\.id/)
    expect(chatStoreTsx).toMatch(/c\.updatedAt === chats\[i\]\.updatedAt/)
  })
})

describe('ChatSidebar createNew error handling', () => {
  const sidebarTsx = read('src/renderer/views/chat/sidebar/ChatSidebar.tsx')

  it('wraps createNew in try/catch', () => {
    expect(sidebarTsx).toMatch(/const createNew = async \(engine: 'claude' \| 'codex' = 'claude'\) => \{/)
    expect(sidebarTsx).toMatch(/try \{/)
    expect(sidebarTsx).toMatch(/\} catch \(err\)/)
  })

  it('eagerly refreshes chat list before selecting', () => {
    expect(sidebarTsx).toMatch(/await useChatStore\.getState\(\)\.loadChatList\(\)/)
  })
})
