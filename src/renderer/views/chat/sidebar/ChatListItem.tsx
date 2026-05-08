import { useState } from 'react'
import type { ChatMeta } from '../../../../main/chat/chat-types'
import { useChatStore } from '../../../stores/chat'

interface Props {
  chat: ChatMeta
  active: boolean
  onRequestDelete: (chat: ChatMeta) => void
}

export function ChatListItem({ chat, active, onRequestDelete }: Props) {
  const selectChat = useChatStore((s) => s.selectChat)
  const rename = useChatStore((s) => s.rename)
  const inflight = useChatStore((s) => s.inflight[chat.id])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(chat.title)

  const commitRename = () => {
    const next = draft.trim()
    if (next && next !== chat.title) {
      rename(chat.id, next).catch(() => void 0)
    } else {
      setDraft(chat.title)
    }
    setEditing(false)
  }

  return (
    <div
      className="chat-list-item"
      onClick={() => !editing && selectChat(chat.id)}
      onDoubleClick={() => setEditing(true)}
      style={{
        padding: '8px 12px',
        cursor: editing ? 'text' : 'pointer',
        background: active ? 'var(--bg-active)' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: 13,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        userSelect: 'none',
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)'
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLDivElement).style.background = 'transparent'
      }}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') { setDraft(chat.title); setEditing(false) }
          }}
          style={{
            flex: 1,
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--accent)',
            borderRadius: 4,
            padding: '2px 6px',
            fontSize: 13,
            outline: 'none',
          }}
        />
      ) : (
        <>
          {chat.engine === 'codex' && (
            <span
              title="Codex"
              style={{
                fontSize: 9, fontWeight: 600, padding: '1px 4px', borderRadius: 3,
                background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
                border: '1px solid var(--border)', letterSpacing: 0.3,
              }}
            >CDX</span>
          )}
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {chat.title}
          </span>
          {inflight?.streaming && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--accent)',
                animation: 'chat-pulse 1.2s ease-in-out infinite',
              }}
            />
          )}
          <button
            className="chat-item-delete"
            onClick={(e) => {
              e.stopPropagation()
              onRequestDelete(chat)
            }}
            title="Delete"
            style={{
              padding: '2px 6px',
              background: 'transparent',
              color: 'var(--text-muted)',
              border: 'none',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            ×
          </button>
        </>
      )}
    </div>
  )
}
