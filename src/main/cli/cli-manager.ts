import { app } from 'electron'
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  chmodSync,
  createWriteStream,
  unlinkSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync
} from 'fs'
import { execSync } from 'child_process'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import * as os from 'os'
import log from '../logger'
import { fetchWithTimeout, sha256File } from '../utils/fetch'
import { type Engine, type EngineSpec, getEngineSpec } from './engine-registry'

/** Strict semver-like version pattern to prevent path traversal */
const VERSION_RE = /^\d+\.\d+\.\d+$/

interface Manifest {
  version: string
  buildDate: string
  platforms: Record<
    string,
    { binary: string; checksum: string; size: number }
  >
}

interface CliInfo {
  installed: boolean
  path: string
  version: string | null
  engine: Engine
}

/**
 * Multi-version CLI manager, one instance per engine (claude / codex).
 *
 * Storage layout:
 *   {userData}/cli/{engine}/
 *     .active          — current version string (e.g. "2.1.98")
 *     2.1.78/claude    — version-specific binary
 *     2.1.87/claude
 *     2.1.98/claude
 *
 * For the `claude` engine we also migrate the legacy pre-engine layout
 * ({userData}/cli/.active + {userData}/cli/{version}/claude) on first use.
 */
export class CliManager {
  private readonly spec: EngineSpec
  private cliDir: string
  private binaryName: string
  private _cachedInfo: CliInfo | null = null
  private _installing = false

  private get activePath(): string {
    return join(this.cliDir, '.active')
  }

  /** Legacy marker from single-binary layout */
  private get legacyMarkerPath(): string {
    return join(this.cliDir, '.installed')
  }

  constructor(engine: Engine = 'claude') {
    this.spec = getEngineSpec(engine)
    this.cliDir = join(app.getPath('userData'), 'cli', this.spec.subdir)
    this.binaryName = os.platform() === 'win32' ? this.spec.winBinary : this.spec.unixBinary
  }

  get engine(): Engine { return this.spec.engine }

  /** Get the binary path for a specific version */
  private versionBinaryPath(version: string): string {
    return join(this.cliDir, version, this.binaryName)
  }

  /** Read the active version from .active file */
  private getActiveVersion(): string | null {
    try {
      return readFileSync(this.activePath, 'utf-8').trim() || null
    } catch {
      return null
    }
  }

  /**
   * Migrate legacy pre-engine layout: {userData}/cli/{version}/claude
   * → {userData}/cli/claude/{version}/claude. Only applies to the claude
   * engine; codex is new so there's nothing to migrate.
   */
  private migrateLegacy(): void {
    if (this.spec.engine !== 'claude') return

    const legacyRoot = join(app.getPath('userData'), 'cli')
    const legacyActive = join(legacyRoot, '.active')
    // If the new layout already has an active version, we've migrated
    if (existsSync(this.activePath)) return
    // Old pre-versioned single-binary layout
    const legacyBinary = join(legacyRoot, this.binaryName)
    const legacyMarker = join(legacyRoot, '.installed')

    // Case A: pre-engine versioned layout — {userData}/cli/.active + {ver}/claude
    if (existsSync(legacyActive)) {
      try {
        const ver = readFileSync(legacyActive, 'utf-8').trim()
        if (ver && VERSION_RE.test(ver)) {
          const oldVerDir = join(legacyRoot, ver)
          const oldBin = join(oldVerDir, this.binaryName)
          if (existsSync(oldBin)) {
            const newVerDir = join(this.cliDir, ver)
            mkdirSync(newVerDir, { recursive: true })
            try { renameSync(oldVerDir, newVerDir) } catch { /* may already exist */ }
            writeFileSync(this.activePath, ver)
            try { unlinkSync(legacyActive) } catch { /* ignore */ }
            log.info(`CLI[claude]: migrated pre-engine layout (v${ver})`)
          }
        }
      } catch (err) {
        log.warn(`CLI[claude]: legacy migration failed: ${(err as Error).message}`)
      }
      return
    }

    // Case B: very old single-binary layout — {userData}/cli/claude + .installed
    if (existsSync(legacyBinary) && existsSync(legacyMarker)) {
      let version: string | null = null
      try {
        const marker = readFileSync(legacyMarker, 'utf-8').trim()
        if (marker.includes('|')) version = marker.split('|')[0]
      } catch { /* ignore */ }

      if (!version) {
        try {
          const raw = execSync(`"${legacyBinary}" --version`, {
            timeout: 5000,
            encoding: 'utf-8'
          }).trim()
          const match = raw.match(/^[\d.]+/)
          version = match ? match[0] : null
        } catch { /* ignore */ }
      }

      if (!version || !VERSION_RE.test(version)) {
        log.warn('CLI[claude]: legacy migration skipped — cannot determine version')
        return
      }

      const versionDir = join(this.cliDir, version)
      mkdirSync(versionDir, { recursive: true })
      const dest = join(versionDir, this.binaryName)
      if (!existsSync(dest)) {
        try { renameSync(legacyBinary, dest) } catch { /* ignore */ }
      } else {
        try { unlinkSync(legacyBinary) } catch { /* ignore */ }
      }

      writeFileSync(this.activePath, version)
      try { unlinkSync(legacyMarker) } catch { /* ignore */ }
      log.info(`CLI[claude]: migrated single-binary legacy layout (v${version})`)
    }
  }

  getInfo(): CliInfo {
    if (this._cachedInfo) return this._cachedInfo

    if (!existsSync(this.cliDir)) {
      mkdirSync(this.cliDir, { recursive: true })
    }

    this.migrateLegacy()

    const version = this.getActiveVersion()
    if (version) {
      const binPath = this.versionBinaryPath(version)
      if (existsSync(binPath)) {
        const info: CliInfo = { installed: true, path: binPath, version, engine: this.spec.engine }
        this._cachedInfo = info
        return info
      }
    }

    return { installed: false, path: '', version: null, engine: this.spec.engine }
  }

  invalidateCache(): void {
    this._cachedInfo = null
  }

  getBinaryPath(): string {
    return this.getInfo().path
  }

  isInstalled(): boolean {
    return this.getInfo().installed
  }

  /** List locally installed versions */
  getLocalVersions(): string[] {
    if (!existsSync(this.cliDir)) return []
    try {
      return readdirSync(this.cliDir)
        .filter(name => {
          if (name.startsWith('.')) return false
          return existsSync(this.versionBinaryPath(name))
        })
        .sort((a, b) => {
          const pa = a.split('.').map(Number)
          const pb = b.split('.').map(Number)
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const diff = (pb[i] || 0) - (pa[i] || 0)
            if (diff !== 0) return diff
          }
          return 0
        })
    } catch {
      return []
    }
  }

  async listVersions(): Promise<string[]> {
    try {
      const res = await fetchWithTimeout(`${this.spec.mirrorBase}/versions.json`)
      if (!res.ok) return []
      const raw: unknown = await res.json()
      if (!Array.isArray(raw)) return []
      return raw.filter((v): v is string => typeof v === 'string' && VERSION_RE.test(v))
    } catch {
      return []
    }
  }

  /**
   * Install a specific version (or latest if not specified).
   * Downloads to {cliDir}/{version}/{binary} and sets it as active.
   * Skips download if the version is already present locally.
   */
  async install(
    onProgress?: (step: string, progress: number) => void,
    targetVersion?: string
  ): Promise<void> {
    if (this._installing) throw new Error('Installation already in progress')
    this._installing = true
    let versionDir = ''
    try {
      if (!existsSync(this.cliDir)) {
        mkdirSync(this.cliDir, { recursive: true })
      }

      const platform = os.platform()
      const arch = os.arch()
      const platformKey = `${platform}-${arch}`

      onProgress?.('Checking latest version...', 0.05)

      let version: string
      if (targetVersion) {
        version = targetVersion.replace(/^v/, '')
      } else {
        const latestRes = await fetchWithTimeout(`${this.spec.mirrorBase}/latest`)
        if (!latestRes.ok) {
          throw new Error(`Failed to check latest ${this.spec.displayName} version`)
        }
        version = (await latestRes.text()).trim()
      }

      // Validate version string to prevent path traversal
      if (!VERSION_RE.test(version)) {
        throw new Error(`Invalid version format: ${version}`)
      }
      log.info(`CLI[${this.spec.engine}]: target version is ${version}`)

      versionDir = join(this.cliDir, version)
      const binaryPath = join(versionDir, this.binaryName)

      // Skip download if already present locally
      if (existsSync(binaryPath)) {
        log.info(`CLI[${this.spec.engine}]: v${version} already exists locally, switching`)
        onProgress?.('Version already downloaded, switching...', 0.9)
        writeFileSync(this.activePath, version)
        this.invalidateCache()
        onProgress?.('Installation complete', 1.0)
        return
      }

      if (!existsSync(versionDir)) {
        mkdirSync(versionDir, { recursive: true })
      }

      // Fetch manifest
      onProgress?.('Fetching manifest...', 0.1)
      const manifestRes = await fetchWithTimeout(
        `${this.spec.mirrorBase}/${version}/manifest.json`
      )
      if (!manifestRes.ok) {
        throw new Error(`Failed to fetch manifest for version ${version}`)
      }
      const manifest: Manifest = await manifestRes.json()

      const platInfo = manifest.platforms[platformKey]
      if (!platInfo) {
        throw new Error(`Your system (${platformKey}) is not supported yet`)
      }

      // Download binary
      const binaryUrl = `${this.spec.mirrorBase}/${version}/${platformKey}/${platInfo.binary}`
      onProgress?.(`Downloading ${this.spec.displayName} v${version}...`, 0.2)
      log.info(`CLI[${this.spec.engine}]: downloading ${binaryUrl}`)

      const res = await fetchWithTimeout(binaryUrl, {}, 300000)
      if (!res.ok || !res.body) {
        throw new Error(
          `Download failed (HTTP ${res.status}). Please try again later.`
        )
      }

      const tmpPath = binaryPath + '.tmp'
      const fileStream = createWriteStream(tmpPath)

      // Track download progress
      const totalSize = platInfo.size
      let downloaded = 0
      const reader = res.body.getReader()
      const progressStream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            return
          }
          downloaded += value.byteLength
          const pct = Math.min(0.2 + (downloaded / totalSize) * 0.6, 0.8)
          onProgress?.(
            `Downloading... ${((downloaded / totalSize) * 100).toFixed(0)}%`,
            pct
          )
          controller.enqueue(value)
        }
      })

      try {
        await pipeline(Readable.fromWeb(progressStream as any), fileStream)
      } catch (err) {
        try { unlinkSync(tmpPath) } catch { /* ignore */ }
        throw err
      }

      // Verify sha256 checksum
      onProgress?.('Verifying checksum...', 0.82)
      const actual = await sha256File(tmpPath)
      if (actual !== platInfo.checksum) {
        unlinkSync(tmpPath)
        throw new Error(
          `Checksum mismatch: expected ${platInfo.checksum}, got ${actual}`
        )
      }
      log.info(`CLI[${this.spec.engine}]: checksum verified`)

      // Move tmp to final
      renameSync(tmpPath, binaryPath)

      // Set executable permission on unix
      if (platform !== 'win32') {
        chmodSync(binaryPath, 0o755)
      }

      // macOS: clear quarantine attribute
      if (platform === 'darwin') {
        try {
          execSync(`xattr -cr "${binaryPath}"`, { timeout: 5000 })
          log.info(`CLI[${this.spec.engine}]: cleared quarantine attribute`)
        } catch {
          log.warn(`CLI[${this.spec.engine}]: failed to clear quarantine attribute (non-fatal)`)
        }
      }

      onProgress?.('Verifying installation...', 0.9)

      // Verify --version works. Timeout scales with engine + platform:
      //   - Claude JS CLI: ~1s cold start, 10s timeout is fine everywhere.
      //   - Codex Rust binary on Windows: first-run Defender scan can take
      //     20-40s on a fresh binary. Be generous here to avoid a perpetual
      //     install → verify-fail → retry loop the first time.
      const verifyTimeoutMs = this.spec.engine === 'codex'
        ? (platform === 'win32' ? 90_000 : 30_000)
        : 10_000
      try {
        execSync(`"${binaryPath}" --version`, { timeout: verifyTimeoutMs })
      } catch (verifyErr) {
        log.error(`CLI[${this.spec.engine}]: binary verification failed (timeout=${verifyTimeoutMs}ms):`, verifyErr)
        try { unlinkSync(binaryPath) } catch { /* ignore */ }
        try { rmSync(versionDir, { recursive: true, force: true }) } catch { /* ignore */ }
        throw new Error(
          `${this.spec.displayName} installation verification failed. The downloaded file may be corrupted — please try again.`
        )
      }

      // Set as active version
      writeFileSync(this.activePath, version)
      this.invalidateCache()
      onProgress?.('Installation complete', 1.0)
    } catch (err) {
      // Clean up partial install directory on failure (recursive — there may
      // be a leftover .tmp file or partial binary inside).
      if (versionDir && existsSync(versionDir)) {
        try { rmSync(versionDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
      throw err
    } finally {
      this._installing = false
    }
  }

  /**
   * Switch to a specific version. Downloads if not present locally.
   */
  async installVersion(
    version: string,
    onProgress?: (step: string, progress: number) => void
  ): Promise<void> {
    await this.install(onProgress, version)
  }
}
