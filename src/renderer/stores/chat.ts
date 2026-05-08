import { create } from 'zustand'
import type { ChatMeta, ChatEvent, ChatEndPayload } from '../../main/chat/chat-types'

export interface RenderMessage {
  id: string
  role: 'user' | 'assistant'
  parts: Array<
    | { kind: 'text'; text: string }
    | { kind: 'tool'; name: string; input: unknown; result?: string; isError?: boolean; toolUseId: string }
    | { kind: 'thinking'; text: string }
  >
}

interface InflightState {
  requestId: string
  streaming: boolean
}

interface ChatState {
  chats: ChatMeta[]
  activeChatId: string | null
  messages: Record<string, RenderMessage[]>
  inflight: Record<string, InflightState>

  loadChatList: () => Promise<void>
  selectChat: (id: string) => Promise<void>
  send: (chatId: string, text: string) => Promise<void>
  cancel: (chatId: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  delete: (id: string, removeFiles?: boolean) => Promise<void>

  /** Called by useChatStream — appends an incoming event to the right message. */
  appendEvent: (chatId: string, event: ChatEvent) => void
  /** Called by useChatStream on chat:end — clears inflight and stamps final state. */
  markEnded: (chatId: string, payload: ChatEndPayload) => void
  /** Map a requestId to the chat it belongs to (inflight lookup). */
  findChatByRequestId: (requestId: string) => string | null
}

function uuid(): string {
  return crypto.randomUUID()
}

function errorMessageFor(code: string | undefined): string {
  switch (code) {
    case 'cancelled': return '✋ Cancelled.'
    case 'timeout':   return '⏱ Response timed out. Try again.'
    case 'cli_missing': return '⚠️ CLI binary is not installed. Install it from the setup screen.'
    case 'codex_not_logged_in': return '🔐 Codex is not logged in. Open a terminal and run `codex login --device-auth`, then try again.'
    case 'busy':      return '⚠️ A turn is already running for this chat.'
    case 'too_many_concurrent_chats': return '⚠️ Too many concurrent chats running. Cancel one and try again.'
    case 'spawn_failed': return '⚠️ Failed to start the CLI. Check logs.'
    default: return `⚠️ Error: ${code ?? 'unknown'}`
  }
}

function pushAssistantPart(
  messages: RenderMessage[],
  part: RenderMessage['parts'][number],
): RenderMessage[] {
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant') {
    return [
      ...messages.slice(0, -1),
      { ...last, parts: [...last.parts, part] },
    ]
  }
  return [...messages, { id: uuid(), role: 'assistant', parts: [part] }]
}

function mergeTextDelta(messages: RenderMessage[], delta: string): RenderMessage[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') {
    return [...messages, { id: uuid(), role: 'assistant', parts: [{ kind: 'text', text: delta }] }]
  }
  const lastPart = last.parts[last.parts.length - 1]
  if (lastPart?.kind === 'text') {
    const updatedPart = { ...lastPart, text: lastPart.text + delta }
    return [
      ...messages.slice(0, -1),
      { ...last, parts: [...last.parts.slice(0, -1), updatedPart] },
    ]
  }
  return pushAssistantPart(messages, { kind: 'text', text: delta })
}

export const useChatStore = create<ChatState>((set, get) => ({
  chats: [],
  activeChatId: null,
  messages: {},
  inflight: {},

  loadChatList: async () => {
    const chats = (await window.api.chat.list()) as ChatMeta[]
    // Skip update if the list hasn't changed — prevents unnecessary sidebar
    // re-renders on every chat:listChanged broadcast.
    const prev = get().chats
    if (prev.length === chats.length && prev.every((c, i) => c.id === chats[i].id && c.updatedAt === chats[i].updatedAt)) {
      return
    }
    set({ chats })
  },

  selectChat: async (id) => {
    set({ activeChatId: id })
    if (!get().messages[id]) {
      const events = (await window.api.chat.loadHistory(id)) as ChatEvent[]
      const rebuilt: RenderMessage[] = []
      for (const ev of events) {
        applyEventMutating(rebuilt, ev)
      }
      set((s) => ({ messages: { ...s.messages, [id]: rebuilt } }))
    }
  },

  send: async (chatId, text) => {
    // Optimistically add the user bubble
    const prevMessages = get().messages[chatId] ?? []
    set((s) => ({
      messages: {
        ...s.messages,
        [chatId]: [
          ...(s.messages[chatId] ?? []),
          { id: uuid(), role: 'user', parts: [{ kind: 'text', text }] },
        ],
      },
    }))
    try {
      const { requestId } = await window.api.chat.send(chatId, text)
      set((s) => ({ inflight: { ...s.inflight, [chatId]: { requestId, streaming: true } } }))
    } catch (err) {
      // Rollback the optimistic user message on failure
      set((s) => ({ messages: { ...s.messages, [chatId]: prevMessages } }))
      throw err
    }
  },

  cancel: async (chatId) => {
    await window.api.chat.cancel(chatId)
  },

  rename: async (id, title) => {
    await window.api.chat.rename(id, title)
    // chat:listChanged hook will re-fetch the list
  },

  delete: async (id, removeFiles = true) => {
    await window.api.chat.delete(id, removeFiles)
    set((s) => {
      const { [id]: _removedMessages, ...restMessages } = s.messages
      const { [id]: _removedInflight, ...restInflight } = s.inflight
      return {
        activeChatId: s.activeChatId === id ? null : s.activeChatId,
        messages: restMessages,
        inflight: restInflight,
      }
    })
  },

  appendEvent: (chatId, event) => {
    set((s) => {
      const cur = s.messages[chatId] ?? []
      const next = applyEventCopying(cur, event)
      return next === cur ? s : { messages: { ...s.messages, [chatId]: next } }
    })
  },

  markEnded: (chatId, payload) => {
    set((s) => {
      const { [chatId]: _, ...rest } = s.inflight
      if (payload.ok) {
        return { inflight: rest }
      }
      // Inject a visible error message so the user knows the turn failed
      const errorText = errorMessageFor(payload.error)
      const existing = s.messages[chatId] ?? []
      const withError: RenderMessage[] = [
        ...existing,
        { id: uuid(), role: 'assistant', parts: [{ kind: 'text', text: errorText }] },
      ]
      return { inflight: rest, messages: { ...s.messages, [chatId]: withError } }
    })
  },

  findChatByRequestId: (requestId) => {
    const inflight = get().inflight
    for (const [chatId, info] of Object.entries(inflight)) {
      if (info.requestId === requestId) return chatId
    }
    return null
  },
}))

/** Pure: apply one ChatEvent and return the (possibly new) message array. */
function applyEventCopying(messages: RenderMessage[], ev: ChatEvent): RenderMessage[] {
  switch (ev.kind) {
    case 'text':
      return mergeTextDelta(messages, ev.delta)
    case 'user_text':
      return [...messages, { id: uuid(), role: 'user', parts: [{ kind: 'text', text: ev.text }] }]
    case 'thinking':
      return pushAssistantPart(messages, { kind: 'thinking', text: ev.delta })
    case 'tool_use':
      return pushAssistantPart(messages, {
        kind: 'tool',
        name: ev.name,
        input: ev.input,
        toolUseId: ev.id,
      })
    case 'tool_result': {
      // Find the assistant tool part matching this toolUseId and fill result
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role !== 'assistant') continue
        for (let j = m.parts.length - 1; j >= 0; j--) {
          const p = m.parts[j]
          if (p.kind === 'tool' && p.toolUseId === ev.toolUseId && p.result === undefined) {
            const updated: RenderMessage = {
              ...m,
              parts: [
                ...m.parts.slice(0, j),
                { ...p, result: ev.content, isError: ev.isError },
                ...m.parts.slice(j + 1),
              ],
            }
            return [...messages.slice(0, i), updated, ...messages.slice(i + 1)]
          }
        }
      }
      return messages
    }
    case 'usage':
    case 'meta':
    default:
      return messages
  }
}

/** Mutating variant for initial history replay (builds a fresh array). */
function applyEventMutating(messages: RenderMessage[], ev: ChatEvent): void {
  const updated = applyEventCopying(messages, ev)
  messages.length = 0
  messages.push(...updated)
}
