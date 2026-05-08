import type { EngineHandler } from './types'
import type { ChatEvent, ChatMeta } from '../chat-types'

/**
 * Codex engine — wraps `codex exec --json`.
 *
 * Stream protocol: Codex emits JSON-RPC style notifications over stdout,
 * one JSON object per line. The subset we care about:
 *
 *   { "method": "turn/start",               "params": { "turnId": "…", "threadId": "…" } }
 *   { "method": "item/agentMessage/delta",  "params": { "delta": "…" } }          // assistant text chunk
 *   { "method": "item/reasoning/delta",     "params": { "delta": "…" } }          // thinking chunk (if present)
 *   { "method": "item/toolCall/started",    "params": { "id":"…","name":"…","input":… } }
 *   { "method": "item/toolCall/completed",  "params": { "id":"…","output":"…","isError":… } }
 *   { "method": "turn/completed",           "params": { "turn": { "usage": {...} } } }
 *
 * This is a best-effort mapping — the Rust app-server may add/rename events
 * over time; unknown events fall through as `meta { raw }` so the UI can
 * still show something without crashing.
 *
 * Thread continuation (v2): Codex tracks conversation state via thread id.
 * For the MVP we start a fresh `codex exec` per turn and rely on the stored
 * threadId (persisted in meta.claudeSessionId despite the name) to resume.
 * Actual resume-flag wiring depends on the codex-rs CLI surface, which
 * we'll wire once we have a running binary to test against.
 */
export const codexEngine: EngineHandler = {
  buildArgs(input: { meta: ChatMeta; text: string }): string[] {
    const { meta, text } = input
    const args: string[] = [
      'exec',
      '--json',
      // Sandbox: codex has its own approval flow; skip interactive prompts.
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
    ]
    // Workspace root
    if (meta.cwd) args.push('--cd', meta.cwd)
    for (const dir of meta.mountedDirs || []) {
      args.push('--add-dir', dir)
    }
    // Prompt as the final positional arg
    args.push(text)
    return args
  },

  normalize(raw: unknown): ChatEvent[] {
    if (!raw || typeof raw !== 'object') return []
    const r = raw as Record<string, unknown>
    const method = typeof r.method === 'string' ? r.method : ''
    const params = (r.params && typeof r.params === 'object' ? (r.params as Record<string, unknown>) : {}) as Record<string, unknown>

    // Assistant text delta
    if (method === 'item/agentMessage/delta') {
      const delta = typeof params.delta === 'string' ? params.delta : ''
      return delta ? [{ kind: 'text', delta }] : []
    }
    // Full agent message (non-streaming fallback)
    if (method === 'item/agentMessage/completed') {
      const message = typeof params.message === 'string' ? params.message : ''
      return message ? [{ kind: 'text', delta: message }] : []
    }
    // Reasoning / thinking delta
    if (method === 'item/reasoning/delta' || method === 'item/thinking/delta') {
      const delta = typeof params.delta === 'string' ? params.delta : ''
      return delta ? [{ kind: 'thinking', delta }] : []
    }
    // Tool call started
    if (method === 'item/toolCall/started' || method === 'item/commandExecution/started') {
      return [{
        kind: 'tool_use',
        id: str(params.id || params.callId),
        name: str(params.name || params.tool || 'tool'),
        input: params.input ?? params.arguments ?? params,
      }]
    }
    // Tool call completed
    if (method === 'item/toolCall/completed' || method === 'item/commandExecution/completed') {
      const output = typeof params.output === 'string' ? params.output
        : typeof params.result === 'string' ? params.result
        : ''
      return [{
        kind: 'tool_result',
        toolUseId: str(params.id || params.callId),
        content: output,
        isError: params.isError === true || params.error != null,
      }]
    }
    // Thread id — persist in meta so subsequent turns can resume
    if (method === 'turn/start') {
      const threadId = str(params.threadId)
      return threadId ? [{ kind: 'meta', sessionId: threadId, raw }] : [{ kind: 'meta', raw }]
    }
    // Usage on completion
    if (method === 'turn/completed') {
      const turn = (params.turn && typeof params.turn === 'object') ? params.turn as Record<string, unknown> : {}
      const usage = (turn.usage && typeof turn.usage === 'object') ? turn.usage as Record<string, unknown> : {}
      const out: ChatEvent[] = []
      if (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number') {
        out.push({
          kind: 'usage',
          inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
          outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
        })
      }
      out.push({ kind: 'meta', raw })
      return out
    }

    // Fallback — preserve raw for debugging without crashing the UI
    return [{ kind: 'meta', raw }]
  },
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
