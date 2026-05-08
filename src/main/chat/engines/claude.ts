import type { EngineHandler } from './types'
import { buildArgs as buildClaudeArgs } from '../sandbox'
import { normalize as normalizeClaude } from '../normalizer'

/**
 * Claude Code engine — wraps the existing sandbox.ts + normalizer.ts.
 * No behavior change vs. pre-engine refactor.
 */
export const claudeEngine: EngineHandler = {
  buildArgs: buildClaudeArgs,
  normalize: normalizeClaude,
}
