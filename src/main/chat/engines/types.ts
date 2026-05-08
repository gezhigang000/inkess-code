import type { ChatMeta, ChatEvent } from '../chat-types'

/**
 * Per-engine adapter for the Chat backend.
 *
 * Each engine knows how to:
 *   1. Compose CLI arguments for one turn (`buildArgs`)
 *   2. Translate one raw stream object into ChatEvents (`normalize`)
 *
 * The chat-manager itself stays engine-agnostic — it spawns the binary,
 * pipes stdout through a line-buffered JSON parser, and feeds each parsed
 * object to `engine.normalize()`.
 */
export interface EngineHandler {
  /** Compose the CLI invocation for a single turn. */
  buildArgs(input: { meta: ChatMeta; text: string }): string[]
  /** Translate one stream-json line into 0..N ChatEvents. */
  normalize(raw: unknown): ChatEvent[]
}

export type Engine = 'claude' | 'codex'
