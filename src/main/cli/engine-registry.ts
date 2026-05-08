/**
 * Engine registry — CLI engines supported by this app.
 *
 * Each engine has its own OSS mirror, binary name, and storage subdirectory
 * under `{userData}/cli/{engine}/{version}/`. A single `.active` file per
 * engine tracks the currently selected version. See CliManager.
 */
export type Engine = 'claude' | 'codex'

export interface EngineSpec {
  engine: Engine
  /** Subdirectory under {userData}/cli/ where versioned binaries live. */
  subdir: string
  /** Display name for logs / UI. */
  displayName: string
  /** OSS mirror base URL (expects {base}/versions.json, {base}/latest, {base}/{ver}/manifest.json + {ver}/{plat}/binary). */
  mirrorBase: string
  /** Executable filename per platform. */
  unixBinary: string
  winBinary: string
}

export const ENGINE_SPECS: Record<Engine, EngineSpec> = {
  claude: {
    engine: 'claude',
    subdir: 'claude',
    displayName: 'Claude Code',
    mirrorBase: 'https://inkess-app.oss-ap-northeast-1.aliyuncs.com/cli-mirror',
    unixBinary: 'claude',
    winBinary: 'claude.exe',
  },
  codex: {
    engine: 'codex',
    subdir: 'codex',
    displayName: 'Codex CLI',
    mirrorBase: 'https://inkess-app.oss-ap-northeast-1.aliyuncs.com/codex-mirror',
    unixBinary: 'codex',
    winBinary: 'codex.exe',
  },
}

export function getEngineSpec(engine: Engine): EngineSpec {
  const spec = ENGINE_SPECS[engine]
  if (!spec) throw new Error(`Unknown engine: ${engine}`)
  return spec
}
