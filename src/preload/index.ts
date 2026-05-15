import { contextBridge, ipcRenderer, webUtils } from 'electron'

// Platform info passed via additionalArguments from main process (avoids requiring sandbox: false)
const args = process.argv
const platform = args.find(a => a.startsWith('--platform='))?.split('=')[1] || process.platform
const homedir = args.find(a => a.startsWith('--homedir='))?.split('=')[1] || ''

const api = {
  platform,
  homedir,

  cli: {
    getInfo: (engine?: 'claude' | 'codex') => ipcRenderer.invoke('cli:getInfo', engine) as Promise<{
      installed: boolean; path: string; version: string | null; engine: 'claude' | 'codex'
    }>,
    install: (engine?: 'claude' | 'codex') => ipcRenderer.invoke('cli:install', engine) as Promise<{
      success: boolean; error?: string
    }>,
    listVersions: (engine?: 'claude' | 'codex') => ipcRenderer.invoke('cli:listVersions', engine) as Promise<string[]>,
    installVersion: (version: string, engine?: 'claude' | 'codex') => ipcRenderer.invoke('cli:installVersion', version, engine) as Promise<{
      success: boolean; error?: string
    }>,
    onInstallProgress: (callback: (event: { step: string; progress: number; engine?: 'claude' | 'codex' }) => void) => {
      const listener = (_: unknown, event: { step: string; progress: number; engine?: 'claude' | 'codex' }) => callback(event)
      ipcRenderer.on('cli:installProgress', listener)
      return () => ipcRenderer.removeListener('cli:installProgress', listener)
    }
  },

  tools: {
    getInfo: () => ipcRenderer.invoke('tools:getInfo'),
    isAllInstalled: () => ipcRenderer.invoke('tools:isAllInstalled') as Promise<boolean>,
    install: () => ipcRenderer.invoke('tools:install') as Promise<{
      success: boolean; error?: string
    }>,
    onInstallProgress: (callback: (event: { step: string; progress: number }) => void) => {
      const listener = (_: unknown, event: { step: string; progress: number }) => callback(event)
      ipcRenderer.on('tools:installProgress', listener)
      return () => ipcRenderer.removeListener('tools:installProgress', listener)
    }
  },

  proxy: {
    getSettings: () => ipcRenderer.invoke('proxy:getSettings') as Promise<{
      enabled: boolean; url: string; region: string
    }>,
    updateSettings: (settings: {
      enabled: boolean; url: string; region: string
    }) => ipcRenderer.invoke('proxy:updateSettings', settings),
    resolveUrl: (url: string) => ipcRenderer.invoke('proxy:resolveUrl', url) as Promise<{
      resolved: string; isSubscription: boolean; nodeName?: string; nodeCount?: number; detectedRegion?: string; error?: string
    }>,
    fetchSubscription: (url: string) => ipcRenderer.invoke('proxy:fetchSubscription', url) as Promise<{
      success: boolean; error?: string; nodes: Array<{
        name: string; type: string; server: string; port: number; url: string;
        region: string; regionFlag: string; usable: boolean
      }>
    }>,
    onSettingsChanged: (callback: (settings: {
      enabled: boolean; url: string; region: string
    }) => void) => {
      const listener = (_: unknown, settings: { enabled: boolean; url: string; region: string }) => callback(settings)
      ipcRenderer.on('proxy:settingsChanged', listener)
      return () => ipcRenderer.removeListener('proxy:settingsChanged', listener)
    }
  },

  pty: {
    create: (options: { cwd: string; env?: Record<string, string>; launchClaude?: boolean }) =>
      ipcRenderer.invoke('pty:create', options),
    write: (id: string, data: string) =>
      ipcRenderer.send('pty:write', { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id: string) =>
      ipcRenderer.send('pty:kill', { id }),
    killAll: () =>
      ipcRenderer.invoke('pty:killAll'),
    onData: (callback: (event: { id: string; data: string }) => void) => {
      const listener = (_: unknown, event: { id: string; data: string }) => callback(event)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },
    onExit: (callback: (event: { id: string; exitCode: number }) => void) => {
      const listener = (_: unknown, event: { id: string; exitCode: number }) => callback(event)
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.removeListener('pty:exit', listener)
    },
    onActivity: (callback: (event: { id: string; type: string; payload?: string }) => void) => {
      const listener = (_: unknown, event: { id: string; type: string; payload?: string }) => callback(event)
      ipcRenderer.on('pty:activity', listener)
      return () => { ipcRenderer.removeListener('pty:activity', listener) }
    }
  },

  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    showItemInFolder: (path: string) => ipcRenderer.invoke('shell:showItemInFolder', path),
    selectDirectory: () => ipcRenderer.invoke('shell:selectDirectory') as Promise<string | null>
  },

  menu: {
    onNewTab: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('app:newTab', listener)
      return () => ipcRenderer.removeListener('app:newTab', listener)
    },
    onCloseTab: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('app:closeTab', listener)
      return () => ipcRenderer.removeListener('app:closeTab', listener)
    },
    onSwitchTab: (callback: (index: number) => void) => {
      const listener = (_: unknown, index: number) => callback(index)
      ipcRenderer.on('app:switchTab', listener)
      return () => ipcRenderer.removeListener('app:switchTab', listener)
    },
    onOpenFolder: (callback: (path: string) => void) => {
      const listener = (_: unknown, path: string) => callback(path)
      ipcRenderer.on('app:openFolder', listener)
      return () => ipcRenderer.removeListener('app:openFolder', listener)
    }
  },

  log: {
    error: (message: string, stack?: string) =>
      ipcRenderer.send('log:error', { message, stack }),
    uploadFile: () => ipcRenderer.invoke('logs:uploadFile') as Promise<{
      success: boolean; error?: string
    }>
  },

  appUpdate: {
    check: () => ipcRenderer.invoke('appUpdate:check'),
    download: () => ipcRenderer.invoke('appUpdate:download'),
    install: () => ipcRenderer.invoke('appUpdate:install'),
    onStatus: (callback: (status: {
      type: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
      version?: string; percent?: number; message?: string
    }) => void) => {
      const listener = (_: unknown, status: {
        type: string; version?: string; percent?: number; message?: string
      }) => callback(status as any)
      ipcRenderer.on('appUpdate:status', listener)
      return () => ipcRenderer.removeListener('appUpdate:status', listener)
    }
  },

  analytics: {
    track: (event: string, props?: Record<string, unknown>) =>
      ipcRenderer.send('analytics:track', { event, props })
  },

  tun: {
    getInfo: () => ipcRenderer.invoke('tun:getInfo') as Promise<{
      mode: string; tunRunning: boolean; installed: boolean; lastError: string | null
      internetReachable: boolean | null; latencyMs: number | null
    }>,
    install: () => ipcRenderer.invoke('tun:install') as Promise<{ success: boolean; error?: string }>,
    startTun: (proxyUrl: string, tunnelUrl?: string, useHelper?: boolean) => ipcRenderer.invoke('tun:startTun', proxyUrl, tunnelUrl, useHelper) as Promise<{ success: boolean; error?: string }>,
    reconnect: () => ipcRenderer.invoke('tun:reconnect') as Promise<{ success: boolean; error?: string }>,
    stop: () => ipcRenderer.invoke('tun:stop') as Promise<{ success: boolean }>,
    clearAuthCooldown: () => ipcRenderer.invoke('tun:clearAuthCooldown') as Promise<void>,
    testConnectivity: (exitIp?: string) => ipcRenderer.invoke('tun:testConnectivity', exitIp) as Promise<{ success: boolean; latency?: number; error?: string; actualIp?: string }>,
    recentActivity: (windowMs?: number) => ipcRenderer.invoke('tun:recentActivity', windowMs) as Promise<{ successes: number; failures: number }>,
    diagnostics: () => ipcRenderer.invoke('tun:diagnostics') as Promise<Record<string, unknown>>,
    onInstallProgress: (callback: (event: { step: string; pct: number }) => void) => {
      const listener = (_: unknown, event: { step: string; pct: number }) => callback(event)
      ipcRenderer.on('tun:installProgress', listener)
      return () => ipcRenderer.removeListener('tun:installProgress', listener)
    },
    onInterfaceAlert: (callback: (event: { interfaces: string[] }) => void) => {
      const listener = (_: unknown, event: { interfaces: string[] }) => callback(event)
      ipcRenderer.on('tun:interfaceAlert', listener)
      return () => ipcRenderer.removeListener('tun:interfaceAlert', listener)
    },
    onStatusUpdate: (callback: (update: {
      tunRunning: boolean
      latencyMs: number | null
      actualIp: string | null
      expectedIp: string | null
      error: string | null
      lastTestAt: number
    }) => void) => {
      const listener = (_: unknown, update: Parameters<typeof callback>[0]) => callback(update)
      ipcRenderer.on('tun:statusUpdate', listener)
      return () => ipcRenderer.removeListener('tun:statusUpdate', listener)
    },
  },

  helper: {
    getStatus: () => ipcRenderer.invoke('helper:status') as Promise<{
      installed: boolean; running: boolean; version: string | null; platform?: string
    }>,
    install: () => ipcRenderer.invoke('helper:install') as Promise<{ success: boolean; error?: string }>,
    uninstall: () => ipcRenderer.invoke('helper:uninstall') as Promise<{ success: boolean; error?: string }>,
  },

  browser: {
    open: (url: string) => ipcRenderer.invoke('browser:open', url) as Promise<{ success?: boolean; error?: string }>,
    closeAll: () => ipcRenderer.invoke('browser:closeAll'),
    openEmpty: () => ipcRenderer.invoke('browser:openEmpty') as Promise<{ success?: boolean; error?: string }>,
  },

  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
    saveImage: (buffer: ArrayBuffer) => ipcRenderer.invoke('clipboard:saveImage', buffer) as Promise<string>,
    getImageSize: (filepath: string) => ipcRenderer.invoke('clipboard:getImageSize', filepath) as Promise<{ size: number }>,
  },

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },

  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion') as Promise<string>,
    isFocused: () => ipcRenderer.invoke('app:isFocused') as Promise<boolean>
  },

  subscription: {
    getApiBase: () => ipcRenderer.invoke('subscription:getApiBase') as Promise<string>,
    setApiBase: (base: string | null) =>
      ipcRenderer.invoke('subscription:setApiBase', base) as Promise<{
        success: boolean; base?: string; error?: string
      }>,
    login: (username: string, password: string) =>
      ipcRenderer.invoke('subscription:login', { username, password }) as Promise<{
        success: boolean; config?: { claudeEmail: string; claudePassword: string; proxyUrl: string; proxyRegion: string; expiresAt: string; status: string; plan?: string; minutesRemaining?: number }
        error?: string; errorCode?: string
      }>,
    checkStatus: () => ipcRenderer.invoke('subscription:checkStatus') as Promise<{
      status: string; plan?: string; expiresAt: string; daysRemaining: number; minutesRemaining?: number; proxyUrl?: string; tunnelUrl?: string; proxyRegion?: string; exitIp?: string
    } | null>,
    getSession: () => ipcRenderer.invoke('subscription:getSession') as Promise<{
      isLoggedIn: boolean; username: string | null; session: { plan?: string; expiresAt: string; proxyUrl: string; tunnelUrl?: string; proxyRegion: string; exitIp?: string } | null
    }>,
    logout: () => ipcRenderer.invoke('subscription:logout'),
    autoLoginClaude: (email: string, password: string) =>
      ipcRenderer.invoke('subscription:autoLoginClaude', { email, password }) as Promise<{ success: boolean }>,
    onClaudeLoginSuccess: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('subscription:claudeLoginSuccess', listener)
      return () => ipcRenderer.removeListener('subscription:claudeLoginSuccess', listener)
    },
  },

  browserSync: {
    startPeriodicUpload: () => ipcRenderer.invoke('browserSync:startPeriodicUpload'),
  },

  claude: {
    setCredentials: (email: string, password: string) =>
      ipcRenderer.invoke('claude:setCredentials', { email, password }),
    clearCredentials: () => ipcRenderer.invoke('claude:clearCredentials'),
  },

  session: {
    list: () => ipcRenderer.invoke('session:list') as Promise<Array<{
      id: string; cwd: string; title: string; createdAt: number; closedAt?: number; size: number
    }>>,
    read: (id: string) => ipcRenderer.invoke('session:read', id) as Promise<string | null>,
    delete: (id: string) => ipcRenderer.invoke('session:delete', id),
    search: (query: string) => ipcRenderer.invoke('session:search', query) as Promise<Array<{
      id: string; matches: string[]
    }>>,
    clearAll: () => ipcRenderer.invoke('session:clearAll'),
  },

  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  fs: {
    isDirectory: (path: string) => ipcRenderer.invoke('fs:isDirectory', path) as Promise<boolean>,
    exists: (path: string) => ipcRenderer.invoke('fs:exists', path) as Promise<boolean>,
    readFile: (path: string, maxSize?: number) => ipcRenderer.invoke('fs:readFile', path, maxSize) as Promise<string | null>,
    listDir: (path: string) => ipcRenderer.invoke('fs:listDir', path) as Promise<{ name: string; path: string; isDirectory: boolean }[]>,
  },

  git: {
    getBranch: (cwd: string) => ipcRenderer.invoke('git:getBranch', cwd) as Promise<string | null>
  },

  notification: {
    show: (title: string, body: string) => ipcRenderer.invoke('notification:show', { title, body }),
    onShouldShow: (callback: (event: { id: string; type: string }) => void) => {
      const listener = (_: unknown, event: { id: string; type: string }) => callback(event)
      ipcRenderer.on('notification:shouldShow', listener)
      return () => { ipcRenderer.removeListener('notification:shouldShow', listener) }
    }
  },

  power: {
    onSleepInhibitChange: (callback: (active: boolean) => void) => {
      const listener = (_: unknown, active: boolean) => callback(active)
      ipcRenderer.on('power:sleepInhibitChange', listener)
      return () => { ipcRenderer.removeListener('power:sleepInhibitChange', listener) }
    },
    setSleepInhibitorEnabled: (enabled: boolean) =>
      ipcRenderer.send('power:setSleepInhibitorEnabled', enabled)
  },

  stats: {
    getSummary: () => ipcRenderer.invoke('stats:getSummary') as Promise<{
      todayTokens: number; todaySessionCount: number
      avgPingMs: number | null; avgTtfbMs: number | null
      storageBytes: number
    }>,
    getEvents: () => ipcRenderer.invoke('stats:getEvents') as Promise<Array<{
      ts: number; event: string; detail?: string
    }>>,
    getSessions: () => ipcRenderer.invoke('stats:getSessions') as Promise<Array<{
      ts: number; sessionId: string; cwd: string; duration: number
      inputTokens?: number; outputTokens?: number; totalTokens?: number
      cost?: string; avgLatency?: number
    }>>,
    getLatency: () => ipcRenderer.invoke('stats:getLatency') as Promise<Array<{
      ts: number; type: 'ping' | 'ttfb'; ms: number; target?: string
    }>>,
    getSystemLog: () => ipcRenderer.invoke('stats:getSystemLog') as Promise<string>,
    getStorageSize: () => ipcRenderer.invoke('stats:getStorageSize') as Promise<number>,
    clear: () => ipcRenderer.invoke('stats:clear') as Promise<{ success: boolean }>,
  },

  chat: {
    list: () => ipcRenderer.invoke('chat:list') as Promise<Array<{
      id: string; title: string; createdAt: number; updatedAt: number;
      cwd: string; mountedDirs: string[]; claudeSessionId: string | null;
      cliVersion: string; messageCount: number; starred: boolean;
      engine?: 'claude' | 'codex'
    }>>,
    create: (cwd?: string, engine?: 'claude' | 'codex') => {
      const args = (cwd || engine) ? { cwd, engine } : undefined
      return ipcRenderer.invoke('chat:create', args) as Promise<{
        id: string; title: string; createdAt: number; updatedAt: number;
        cwd: string; mountedDirs: string[]; claudeSessionId: string | null;
        cliVersion: string; messageCount: number; starred: boolean;
        engine?: 'claude' | 'codex'
      }>
    },
    send: (chatId: string, text: string) =>
      ipcRenderer.invoke('chat:send', { chatId, text }) as Promise<{ requestId: string }>,
    cancel: (chatId: string) =>
      ipcRenderer.invoke('chat:cancel', { chatId }) as Promise<void>,
    loadHistory: (chatId: string) =>
      ipcRenderer.invoke('chat:loadHistory', { chatId }) as Promise<unknown[]>,
    rename: (chatId: string, title: string) =>
      ipcRenderer.invoke('chat:rename', { chatId, title }) as Promise<void>,
    delete: (chatId: string, removeFiles = true) =>
      ipcRenderer.invoke('chat:delete', { chatId, removeFiles }) as Promise<void>,
    onStream: (cb: (p: { requestId: string; event: unknown }) => void) => {
      const listener = (_: unknown, p: { requestId: string; event: unknown }) => cb(p)
      ipcRenderer.on('chat:stream', listener)
      return () => ipcRenderer.removeListener('chat:stream', listener)
    },
    onEnd: (cb: (p: { requestId: string; ok: boolean; error?: string; claudeSessionId?: string }) => void) => {
      const listener = (_: unknown, p: { requestId: string; ok: boolean; error?: string; claudeSessionId?: string }) => cb(p)
      ipcRenderer.on('chat:end', listener)
      return () => ipcRenderer.removeListener('chat:end', listener)
    },
    onListChanged: (cb: () => void) => {
      const listener = () => cb()
      ipcRenderer.on('chat:listChanged', listener)
      return () => ipcRenderer.removeListener('chat:listChanged', listener)
    },
  },
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
