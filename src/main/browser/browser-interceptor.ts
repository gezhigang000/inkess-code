/**
 * Browser Interceptor — intercepts URL opens from PTY processes
 *
 * Problem: Claude Code CLI runs inside PTY and uses the system `open` command
 * to open URLs, which bypasses our built-in browser. We need to redirect those
 * URLs to our built-in browser that has proxy + region masking applied.
 *
 * Solution:
 * 1. Start a Unix domain socket server (macOS/Linux) or TCP localhost server (Windows)
 * 2. Create wrapper scripts (`open` for macOS, `.cmd` for Windows, `BROWSER` for all)
 * 3. Set BROWSER env var and prepend wrapper dir to PATH in PTY env
 * 4. When a URL is received via socket, open it in the built-in browser
 */
import { createServer, Server } from 'net'
import { join } from 'path'
import { app } from 'electron'
import { writeFileSync, mkdirSync, chmodSync, existsSync, unlinkSync } from 'fs'
import log from '../logger'

const SOCKET_NAME = 'browser.sock'

export class BrowserInterceptor {
  private server: Server | null = null
  private socketPath: string
  private binDir: string
  private zdotdir: string
  private onUrlOpen: ((url: string) => void) | null = null
  /** TCP port used on Windows (Unix socket not supported) */
  private tcpPort: number = 0

  constructor() {
    const userData = app.getPath('userData')
    this.socketPath = join(userData, SOCKET_NAME)
    this.binDir = join(userData, 'bin')
    this.zdotdir = join(userData, 'zdotdir')
  }

  /** Start socket server and create wrapper scripts */
  start(onUrlOpen: (url: string) => void): void {
    this.onUrlOpen = onUrlOpen
    if (process.platform === 'win32') {
      this.startTcpServer()
    } else {
      this.startSocketServer()
    }
    this.createWrapperScripts()
    if (process.platform === 'darwin') this.createZdotdir()
    log.info(`[BrowserInterceptor] started, ${process.platform === 'win32' ? `tcp port: ${this.tcpPort}` : `socket: ${this.socketPath}`}`)
  }

  /** Stop socket server and clean up */
  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    if (process.platform !== 'win32') {
      try { unlinkSync(this.socketPath) } catch { /* ignore */ }
    }
  }

  /** Get env vars to inject into PTY for browser interception */
  getEnv(): Record<string, string> {
    const browserScript = process.platform === 'win32'
      ? join(this.binDir, 'browser-open.cmd')
      : join(this.binDir, 'browser-open')

    const env: Record<string, string> = {
      BROWSER: browserScript,
    }

    if (process.platform === 'win32') {
      env.INKESS_BROWSER_PORT = String(this.tcpPort)
    } else {
      env.INKESS_BROWSER_SOCK = this.socketPath
      env.INKESS_BIN_DIR = this.binDir
    }

    // macOS: ZDOTDIR wrapper ensures our bin dir stays first in PATH
    // (path_helper in /etc/zprofile reorders PATH, moving custom dirs to end)
    if (process.platform === 'darwin') {
      env.ZDOTDIR = this.zdotdir
    }
    return env
  }

  /** Get bin dir path to prepend to PATH */
  getBinDir(): string {
    return this.binDir
  }

  private createUrlHandler(): (conn: import('net').Socket) => void {
    const MAX_URL_SIZE = 4096
    return (conn) => {
      let data = ''
      conn.on('data', (chunk) => {
        data += chunk.toString()
        if (data.length > MAX_URL_SIZE) { conn.destroy(); return }
      })
      conn.on('end', () => {
        const url = data.trim()
        if (/^https?:\/\//i.test(url)) {
          log.info(`[BrowserInterceptor] received URL: ${url}`)
          this.onUrlOpen?.(url)
        } else {
          log.warn(`[BrowserInterceptor] ignored non-http URL: ${url}`)
        }
        conn.end()
      })
      conn.on('error', () => { /* ignore connection errors */ })
    }
  }

  private startSocketServer(): void {
    // Clean up stale socket
    try { unlinkSync(this.socketPath) } catch { /* ignore */ }

    this.server = createServer(this.createUrlHandler())
    this.server.on('error', (err) => {
      log.error('[BrowserInterceptor] socket server error:', err)
    })
    this.server.listen(this.socketPath, () => {
      // Make socket accessible by child processes
      try { chmodSync(this.socketPath, 0o666) } catch { /* ignore */ }
    })
  }

  /** Windows: use TCP localhost instead of Unix socket */
  private startTcpServer(): void {
    this.server = createServer(this.createUrlHandler())
    this.server.on('error', (err) => {
      log.error('[BrowserInterceptor] TCP server error:', err)
    })
    // Listen on random port on localhost
    this.server.listen(0, '127.0.0.1', () => {
      const addr = this.server!.address()
      if (addr && typeof addr === 'object') {
        this.tcpPort = addr.port
        log.info(`[BrowserInterceptor] TCP server listening on 127.0.0.1:${this.tcpPort}`)
      }
    })
  }

  /**
   * Create ZDOTDIR wrapper files for zsh on macOS.
   *
   * Problem: macOS /etc/zprofile calls path_helper which reorders PATH,
   * pushing our bin dir to the end (after /usr/bin). This means our `open`
   * wrapper is never found by child processes like Claude Code CLI.
   *
   * Solution: Use ZDOTDIR to wrap zsh config files. Our .zshrc sources the
   * user's real .zshrc, then re-prepends our bin dir to PATH.
   */
  private createZdotdir(): void {
    mkdirSync(this.zdotdir, { recursive: true })

    // .zshenv — source user's, keep ZDOTDIR pointing here for later files
    writeFileSync(join(this.zdotdir, '.zshenv'),
      `[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"\n`,
      { mode: 0o644 })

    // .zprofile — source user's (path_helper already ran via /etc/zprofile)
    writeFileSync(join(this.zdotdir, '.zprofile'),
      `[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"\n`,
      { mode: 0o644 })

    // .zshrc — source user's, re-isolate env, fix PATH, reset ZDOTDIR
    writeFileSync(join(this.zdotdir, '.zshrc'),
      `[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"\n` +
      '# --- Post-init isolation (user .zshrc may have overridden our env) ---\n' +
      '# 1. Re-strip ANTHROPIC_*/CLAUDE_*/OPENAI_* that user\'s .zshrc may have re-set\n' +
      'for __k in $(env 2>/dev/null | grep -oE \'^(ANTHROPIC|CLAUDE|OPENAI)_[^=]*\'); do\n' +
      '  unset "$__k" 2>/dev/null\n' +
      'done; unset __k\n' +
      `# 2. Re-inject our isolated CLAUDE_CONFIG_DIR + CODEX_HOME\n` +
      `[ -n "$__INKESS_CLAUDE_CONFIG_DIR" ] && export CLAUDE_CONFIG_DIR="$__INKESS_CLAUDE_CONFIG_DIR"\n` +
      `[ -n "$__INKESS_CODEX_HOME" ] && export CODEX_HOME="$__INKESS_CODEX_HOME"\n` +
      `# 3. Re-apply region env (user's .zshrc may have set TZ/LANG to local values)\n` +
      'if [ -n "$__INKESS_REGION_ENV" ]; then\n' +
      '  IFS=\'|\' read -rA __pairs <<< "$__INKESS_REGION_ENV"\n' +
      '  for __p in "${__pairs[@]}"; do\n' +
      '    export "${__p%%=*}=${__p#*=}"\n' +
      '  done; unset __pairs __p\n' +
      'fi\n' +
      `# 4. Re-prepend Inkess bin dirs (path_helper moved them to end).\n` +
      `#    INKESS_BIN_DIR holds the open/browser-open wrapper; engine bin dirs\n` +
      `#    hold the active claude/codex binaries.\n` +
      `[ -n "$INKESS_BIN_DIR" ] && export PATH="$INKESS_BIN_DIR:$PATH"\n` +
      `if [ -n "$__INKESS_ENGINE_BIN_DIRS" ]; then\n` +
      `  export PATH="$__INKESS_ENGINE_BIN_DIRS:$PATH"\n` +
      `fi\n` +
      `hash -r\n` +
      `# 5. Clean up internal vars (keep INKESS_BROWSER_SOCK for open wrapper)\n` +
      'for __k in $(env 2>/dev/null | grep -oE \'^__INKESS_[^=]*\'); do unset "$__k" 2>/dev/null; done; unset __k\n' +
      `unset INKESS_BIN_DIR 2>/dev/null\n` +
      `ZDOTDIR="$HOME"\n`,
      { mode: 0o644 })

    // .zlogin — source user's
    writeFileSync(join(this.zdotdir, '.zlogin'),
      `[ -f "$HOME/.zlogin" ] && source "$HOME/.zlogin"\n`,
      { mode: 0o644 })
  }

  private createWrapperScripts(): void {
    mkdirSync(this.binDir, { recursive: true })

    if (process.platform === 'win32') {
      this.createWindowsWrappers()
    } else {
      this.createUnixWrappers()
    }
  }

  private createUnixWrappers(): void {
    // browser-open: used as BROWSER env var value
    // Many tools (Node.js `open` package, `xdg-open`, etc.) check BROWSER first
    const browserOpenScript = `#!/bin/bash
# Inkess browser interceptor — sends URL to built-in browser via Unix socket
URL="$1"
if [ -z "$URL" ]; then exit 0; fi
if [ -S "$INKESS_BROWSER_SOCK" ]; then
  printf '%s' "$URL" | /usr/bin/nc -U "$INKESS_BROWSER_SOCK" 2>/dev/null
  exit 0
fi
# Fallback: system open
/usr/bin/open "$URL" 2>/dev/null
`
    const browserOpenPath = join(this.binDir, 'browser-open')
    writeFileSync(browserOpenPath, browserOpenScript, { mode: 0o755 })

    // open wrapper: intercepts direct `open URL` calls on macOS
    // Only intercepts URL arguments; passes everything else to /usr/bin/open
    if (process.platform === 'darwin') {
      const logDir = app.getPath('userData')
      const openWrapperScript = `#!/bin/bash
# Inkess open wrapper — intercepts URL opens, passes everything else through
LOG="${logDir}/browser-intercept.log"
for arg in "$@"; do
  case "$arg" in
    http://*|https://*)
      echo "[$(date '+%H:%M:%S')] intercept: $arg sock=$INKESS_BROWSER_SOCK" >> "$LOG" 2>/dev/null
      if [ -S "$INKESS_BROWSER_SOCK" ]; then
        printf '%s' "$arg" | /usr/bin/nc -U "$INKESS_BROWSER_SOCK" 2>/dev/null
        exit 0
      else
        echo "[$(date '+%H:%M:%S')] WARN: socket not found, fallback to system open" >> "$LOG" 2>/dev/null
      fi
      ;;
  esac
done
# Not a URL open — pass through to real open
/usr/bin/open "$@"
`
      const openPath = join(this.binDir, 'open')
      writeFileSync(openPath, openWrapperScript, { mode: 0o755 })
    }
  }

  private createWindowsWrappers(): void {
    // browser-open.cmd: used as BROWSER env var value on Windows
    // Sends URL to TCP localhost server, falls back to system start.
    //
    // We pass the URL to PowerShell via an environment variable rather than
    // inline %URL% expansion. OAuth URLs are full of percent-encoded chars
    // (%2F, %3D, %26, etc.) and CMD's "delayed expansion" + `%X%` substitution
    // strips/duplicates them, so the URL that reaches PowerShell would be
    // mangled. `set` followed by `$env:VAR` in PowerShell is byte-safe.
    const browserOpenCmd = `@echo off
setlocal
set "URL=%~1"
if "%URL%"=="" exit /b 0
if "%INKESS_BROWSER_PORT%"=="" goto :fallback
set "INKESS_OAUTH_URL=%URL%"
powershell -NoProfile -Command "$c=[System.Net.Sockets.TcpClient]::new();try{$c.Connect('127.0.0.1',[int]$env:INKESS_BROWSER_PORT);$s=$c.GetStream();$b=[System.Text.Encoding]::UTF8.GetBytes($env:INKESS_OAUTH_URL);$s.Write($b,0,$b.Length);$s.Close()}catch{}finally{$c.Dispose()}" 2>nul
exit /b 0
:fallback
start "" "%URL%"
`
    writeFileSync(join(this.binDir, 'browser-open.cmd'), browserOpenCmd)

    // open.cmd: intercepts `open URL` calls on Windows (Claude Code may call `open`)
    // Same env-var-passing strategy as browser-open.cmd to preserve %-encoded URLs.
    const logPath = join(app.getPath('userData'), 'browser-intercept.log').replace(/\\/g, '\\\\')
    const openCmd = `@echo off
setlocal enabledelayedexpansion
set "URL="
for %%a in (%*) do (
  set "arg=%%~a"
  if "!arg:~0,7!"=="http://" set "URL=!arg!"
  if "!arg:~0,8!"=="https://" set "URL=!arg!"
)
if "%URL%"=="" goto :passthrough
if "%INKESS_BROWSER_PORT%"=="" goto :passthrough
set "INKESS_OAUTH_URL=%URL%"
echo [%time%] intercept: !URL! port=%INKESS_BROWSER_PORT% >> "${logPath}" 2>nul
powershell -NoProfile -Command "$c=[System.Net.Sockets.TcpClient]::new();try{$c.Connect('127.0.0.1',[int]$env:INKESS_BROWSER_PORT);$s=$c.GetStream();$b=[System.Text.Encoding]::UTF8.GetBytes($env:INKESS_OAUTH_URL);$s.Write($b,0,$b.Length);$s.Close()}catch{}finally{$c.Dispose()}" 2>nul
exit /b 0
:passthrough
start "" %*
`
    writeFileSync(join(this.binDir, 'open.cmd'), openCmd)
  }
}
