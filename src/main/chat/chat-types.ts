/**
 * Chat mode type definitions (spec §1 + §2).
 *
 * Pure types only — no runtime code, no imports from other modules.
 * This file is imported by:
 *   - main/chat/** (Plan B: manager, parser, normalizer, store)
 *   - preload/** (Plan C: IPC surface)
 *   - renderer/stores/chat.ts (Plan C)
 *   - renderer/views/chat/** (Plan D: UI)
 */

export interface ChatsIndex {
  version: 1
  chats: ChatMeta[]
}

export interface ChatMeta {
  id: string                              // uuid v4
  title: string                           // first-message summary or user rename
  createdAt: number                       // unix ms
  updatedAt: number                       // last message time
  cwd: string                             // absolute path to this chat's workspace
  mountedDirs: string[]                   // user-granted extra directories
  claudeSessionId: string | null          // populated after first turn (Claude) / thread id (Codex)
  cliVersion: string                      // CLI version at creation time
  messageCount: number
  starred: boolean                        // reserved for v0.2+
  /** Backend engine. Optional for forward-compat with older chats — defaults to 'claude'. */
  engine?: 'claude' | 'codex'
}

export interface ConsentLog {
  chatId: string
  grants: Array<{
    dirPath: string
    grantedAt: number
    revoked?: boolean
    revokedAt?: number
  }>
}

/** Normalizer output — flattened events for the renderer to consume. */
export type ChatEvent =
  | { kind: 'text'; delta: string }                         // assistant text delta (streaming)
  | { kind: 'user_text'; text: string }                     // user-typed message (full, from history replay)
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'thinking'; delta: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  | { kind: 'meta'; sessionId?: string; raw?: unknown }

export interface ChatSendRequest {
  chatId: string
  text: string
  attachments?: string[]                  // absolute paths (v0.3+)
}

export interface ChatSendResponse {
  requestId: string
}

export interface ChatStreamPayload {
  requestId: string
  event: ChatEvent
}

export interface ChatEndPayload {
  requestId: string
  ok: boolean
  error?: string
  claudeSessionId?: string
}

export interface SearchHit {
  chatId: string
  title: string
  snippet: string
  matchedAt: number                       // unix ms of the matched message
}

/** Error codes that the main process may reject with. */
export type ChatErrorCode =
  | 'busy'                                // single-chat in-flight lock
  | 'too_many_concurrent_chats'           // global N=5 limit
  | 'cli_missing'                         // claude/codex binary not installed
  | 'codex_not_logged_in'                 // $CODEX_HOME/auth.json missing — run `codex login`
  | 'spawn_failed'                        // ENOENT / EACCES on spawn
  | 'cancelled'                           // user hit cancel
  | 'timeout'                             // 600s watchdog fired
  | 'dir_not_found'                       // mountDir path gone
  | 'dir_outside_home'                    // mountDir fails $HOME boundary
  | 'dir_already_mounted'                 // duplicate mount
  | 'invalid_chat_id'                     // IPC input validation
  | 'invalid_text'                        // IPC input validation (>100KB etc.)
  | 'index_corrupt'                       // index.json rebuilt from scratch
  | 'unknown_layout'                      // Claude Code JSONL path schema changed
