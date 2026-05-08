import type { Engine, EngineHandler } from './types'
import { claudeEngine } from './claude'
import { codexEngine } from './codex'

export const engines: Record<Engine, EngineHandler> = {
  claude: claudeEngine,
  codex: codexEngine,
}

export function getEngineHandler(engine: Engine | undefined): EngineHandler {
  return engines[engine || 'claude'] ?? engines.claude
}

export type { Engine, EngineHandler } from './types'
