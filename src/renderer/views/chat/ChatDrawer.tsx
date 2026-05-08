import { useState, useCallback, useEffect, useRef } from 'react'
import { useChatStore } from '../../stores/chat'
import { useTerminalStore } from '../../stores/terminal'
import { ChatView } from './main/ChatView'
import { EmptyState } from './main/EmptyState'
import { ChatListItem } from './sidebar/ChatListItem'
import { DeleteConfirmDialog } from './modals/DeleteConfirmDialog'
import { groupChats } from './sidebar/groupChats'
import type { ChatMeta } from '../../../main/chat/chat-types'

const DRAWER_WIDTH = 420

interface Props {
  onClose: () => void
}

export function ChatDrawer({ onClose }: Props) {
  const chats = useChatStore((s) => s.chats)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const activeChat = useChatStore((s) => s.chats.find((c) => c.id === s.activeChatId))
  const selectChat = useChatStore((s) => s.selectChat)
  const deleteChat = useChatStore((s) => s.delete)
  const loadChatList = useChatStore((s) => s.loadChatList)

  const [listOpen, setListOpen] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ChatMeta | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const newMenuRef = useRef<HTMLDivElement>(null)
  const creatingRef = useRef(false)

  const createNewChat = useCallback(async (engine: 'claude' | 'codex' = 'claude') => {
    if (creatingRef.current) return
    creatingRef.current = true
    try {
      const { tabs, activeTabId } = useTerminalStore.getState()
      const tab = tabs.find((t) => t.id === activeTabId)
      const cwd = tab?.cwd || window.api?.homedir || '/'
      const meta = await window.api.chat.create(cwd, engine)
      await loadChatList()
      selectChat(meta.id)
      setListOpen(false)
    } catch (err) {
      console.error('[ChatDrawer] create failed:', err)
    } finally {
      creatingRef.current = false
    }
  }, [loadChatList, selectChat])

  // Close list when a chat is selected (ChatListItem calls selectChat internally)
  useEffect(() => {
    if (activeChatId) setListOpen(false)
  }, [activeChatId])

  // Close list popover when clicking outside
  useEffect(() => {
    if (!listOpen) return
    const handler = (e: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        setListOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [listOpen])

  // Close new-chat menu when clicking outside
  useEffect(() => {
    if (!newMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [newMenuOpen])

  // Escape closes list popover first, then drawer
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation() // prevent other ESC handlers (Settings, etc.)
      if (listOpen) {
        setListOpen(false)
      } else {
        onClose()
      }
    }
    // Use capture phase so we intercept before other handlers
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [listOpen, onClose])

  const groups = groupChats(chats)
  const chatTitle = activeChat?.title || 'Chat'

  return (
    <div style={{
      width: DRAWER_WIDTH,
      flex: `0 0 ${DRAWER_WIDTH}px`,
      display: 'flex',
      flexDirection: 'column',
      borderLeft: '1px solid var(--border)',
      background: 'var(--bg-primary)',
      animation: 'slideInRight 0.2s ease-out',
      position: 'relative',
    }}>
      {/* Header */}
      <div style={{
        height: 40,
        flex: '0 0 40px',
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        gap: 4,
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
      }}>
        {/* Chat list toggle */}
        <button
          onClick={() => setListOpen(!listOpen)}
          title="Chat list"
          style={{
            width: 28, height: 28, border: 'none', borderRadius: 4,
            background: listOpen ? 'var(--bg-active)' : 'transparent',
            color: 'var(--text-secondary)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onMouseEnter={(e) => {
            if (!listOpen) (e.currentTarget).style.background = 'var(--bg-hover)'
          }}
          onMouseLeave={(e) => {
            if (!listOpen) (e.currentTarget).style.background = 'transparent'
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>

        {/* Title */}
        <div
          onClick={() => setListOpen(!listOpen)}
          style={{
            flex: 1, fontSize: 13, fontWeight: 500, cursor: 'pointer',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: 'var(--text-primary)',
          }}
        >
          {activeChatId ? chatTitle : 'Chat'}
        </div>

        {/* New chat — split menu (Claude / Codex) */}
        <div ref={newMenuRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setNewMenuOpen((v) => !v)}
            title="New chat"
            style={{
              width: 28, height: 28, border: 'none', borderRadius: 4,
              background: 'transparent', color: 'var(--text-secondary)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onMouseEnter={(e) => (e.currentTarget).style.background = 'var(--bg-hover)'}
            onMouseLeave={(e) => (e.currentTarget).style.background = 'transparent'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          {newMenuOpen && (
            <div
              style={{
                position: 'absolute', top: 32, right: 0, minWidth: 160,
                background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                borderRadius: 6, padding: 4, zIndex: 30,
                boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
              }}
            >
              <button
                onClick={() => { setNewMenuOpen(false); void createNewChat('claude') }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '6px 10px', border: 'none', background: 'transparent',
                  color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer', borderRadius: 4,
                }}
                onMouseEnter={(e) => (e.currentTarget).style.background = 'var(--bg-hover)'}
                onMouseLeave={(e) => (e.currentTarget).style.background = 'transparent'}
              >
                + New Claude chat
              </button>
              <button
                onClick={() => { setNewMenuOpen(false); void createNewChat('codex') }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '6px 10px', border: 'none', background: 'transparent',
                  color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer', borderRadius: 4,
                }}
                onMouseEnter={(e) => (e.currentTarget).style.background = 'var(--bg-hover)'}
                onMouseLeave={(e) => (e.currentTarget).style.background = 'transparent'}
              >
                + New Codex chat
              </button>
            </div>
          )}
        </div>

        {/* Close */}
        <button
          onClick={onClose}
          title="Close chat"
          style={{
            width: 28, height: 28, border: 'none', borderRadius: 4,
            background: 'transparent', color: 'var(--text-secondary)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onMouseEnter={(e) => (e.currentTarget).style.background = 'var(--bg-hover)'}
          onMouseLeave={(e) => (e.currentTarget).style.background = 'transparent'}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Chat list popover */}
      {listOpen && (
        <div
          ref={listRef}
          style={{
            position: 'absolute',
            top: 40,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'var(--bg-secondary)',
            zIndex: 10,
            overflowY: 'auto',
            borderTop: '1px solid var(--border)',
          }}
        >
          {/* New chat buttons — one per engine */}
          <div
            onClick={() => void createNewChat('claude')}
            style={{
              padding: '10px 12px', cursor: 'pointer', fontSize: 13,
              color: 'var(--accent)', fontWeight: 500,
            }}
            onMouseEnter={(e) => (e.currentTarget).style.background = 'var(--bg-hover)'}
            onMouseLeave={(e) => (e.currentTarget).style.background = 'transparent'}
          >
            + New Claude chat
          </div>
          <div
            onClick={() => void createNewChat('codex')}
            style={{
              padding: '10px 12px', cursor: 'pointer', fontSize: 13,
              color: 'var(--accent)', fontWeight: 500,
              borderBottom: '1px solid var(--border)',
            }}
            onMouseEnter={(e) => (e.currentTarget).style.background = 'var(--bg-hover)'}
            onMouseLeave={(e) => (e.currentTarget).style.background = 'transparent'}
          >
            + New Codex chat
          </div>

          {groups.length === 0 && (
            <div style={{
              padding: '40px 12px', textAlign: 'center',
              color: 'var(--text-muted)', fontSize: 13,
            }}>
              No conversations yet.
            </div>
          )}

          {groups.map((group) => (
            <div key={group.key}>
              <div style={{
                padding: '8px 12px 4px', fontSize: 11, fontWeight: 600,
                color: 'var(--text-muted)', textTransform: 'uppercase',
              }}>
                {group.label}
              </div>
              {group.chats.map((chat) => (
                <ChatListItem
                  key={chat.id}
                  chat={chat}
                  active={chat.id === activeChatId}
                  onRequestDelete={(c) => setPendingDelete(c)}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Main content */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {activeChatId ? <ChatView chatId={activeChatId} /> : <EmptyState />}
      </div>

      {/* Delete dialog */}
      {pendingDelete && (
        <DeleteConfirmDialog
          chat={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            deleteChat(pendingDelete.id, true).catch(() => void 0)
            setPendingDelete(null)
          }}
        />
      )}
    </div>
  )
}
