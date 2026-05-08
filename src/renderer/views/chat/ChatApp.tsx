import { useEffect } from 'react'
import { useChatStream } from './hooks/useChatStream'
import { useChatList } from './hooks/useChatList'
import { useChatStore } from '../../stores/chat'
import { EmptyState } from './main/EmptyState'
import { ChatSidebar } from './sidebar/ChatSidebar'
import { ChatView } from './main/ChatView'

const DRAG_REGION_STYLE: React.CSSProperties = {
  WebkitAppRegion: 'drag',
} as React.CSSProperties

export function ChatApp() {
  useChatStream()
  useChatList()

  // Cleanup: when ChatApp unmounts (mode switch to CLI, or ErrorBoundary retry),
  // cancel all in-flight chat turns so child processes aren't orphaned.
  // Also clear inflight state directly — the chat:end IPC event may arrive after
  // our stream listener is already torn down, leaving stale inflight entries
  // that block future sends with "busy".
  useEffect(() => {
    return () => {
      const state = useChatStore.getState()
      const chatIds = Object.keys(state.inflight)
      for (const chatId of chatIds) {
        state.cancel(chatId).catch(() => void 0)
      }
      if (chatIds.length > 0) {
        useChatStore.setState({ inflight: {} })
      }
    }
  }, [])

  const activeChatId = useChatStore((s) => s.activeChatId)

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    }}>
      {/* Top drag bar — matches macOS traffic-light area / Windows title bar */}
      <div style={{
        ...DRAG_REGION_STYLE,
        height: 32,
        flex: '0 0 32px',
        background: 'var(--bg-primary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
      }}>
        {/* Windows-only window controls (macOS has native traffic lights) */}
        {window.api?.platform !== 'darwin' && (
          <div style={{ display: 'flex', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {[
              { title: 'Minimize', action: () => window.api.window.minimize(), d: 'M3 12h18' },
              { title: 'Maximize', action: () => window.api.window.maximize(), d: 'M3 3h18v18H3z' },
              { title: 'Close', action: () => window.api.window.close(), d: 'M4 4l16 16M20 4L4 20' },
            ].map((btn) => (
              <button
                key={btn.title}
                onClick={btn.action}
                title={btn.title}
                style={{
                  width: 46, height: 32, border: 'none', background: 'transparent',
                  color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background =
                    btn.title === 'Close' ? '#e81123' : 'var(--bg-hover)'
                  if (btn.title === 'Close') (e.currentTarget as HTMLButtonElement).style.color = '#fff'
                }}
                onMouseLeave={(e) => {
                  ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                  ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d={btn.d} />
                </svg>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Main split */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <aside style={{
          width: 260,
          flex: '0 0 260px',
          borderRight: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <ChatSidebar />
        </aside>

        {/* Main column */}
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {activeChatId ? <ChatView chatId={activeChatId} /> : <EmptyState />}
        </main>
      </div>
    </div>
  )
}
