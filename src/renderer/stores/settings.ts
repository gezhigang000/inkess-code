import { create } from 'zustand'

const STORAGE_KEY = 'inkess-settings'

type ThemeChoice = 'auto' | 'dark' | 'light'
type LanguageChoice = 'auto' | 'zh' | 'en'
type AppMode = 'cli' | 'chat'
const VALID_THEMES: ThemeChoice[] = ['auto', 'dark', 'light']
const VALID_LANGUAGES: LanguageChoice[] = ['auto', 'zh', 'en']
const VALID_APP_MODES: AppMode[] = ['cli', 'chat']

interface SettingsState {
  fontSize: number
  ideChoice: string
  language: LanguageChoice
  theme: ThemeChoice
  notificationsEnabled: boolean
  notificationSound: boolean
  sleepInhibitorEnabled: boolean
  sidebarCollapsed: boolean
  pinnedProjects: string[]
  appMode: AppMode
  chatDrawerOpen: boolean

  proxyEnabled: boolean
  proxyMode: 'direct' | 'subscription' | 'tun' | 'system'
  proxyUrl: string                       // manual proxy URL (direct mode)
  proxySubUrl: string                    // subscription URL
  proxySubNodeUrl: string                // resolved URL of selected subscription node
  proxySelectedNode: string              // selected node name (subscription mode)
  proxyRegion: string
  useHelper: boolean                     // macOS: use privileged helper daemon (true) or osascript sudo (false)

  serverUrl: string                      // subscription API base override (empty = default)

  setFontSize: (v: number) => void
  setIdeChoice: (v: string) => void
  setLanguage: (v: LanguageChoice) => void
  setTheme: (v: ThemeChoice) => void
  setNotificationsEnabled: (v: boolean) => void
  setNotificationSound: (v: boolean) => void
  setSleepInhibitorEnabled: (v: boolean) => void
  setSidebarCollapsed: (v: boolean) => void
  pinProject: (path: string) => void
  unpinProject: (path: string) => void
  setAppMode: (v: AppMode) => void
  setChatDrawerOpen: (v: boolean) => void
  toggleChatDrawer: () => void
  setProxyEnabled: (v: boolean) => void
  setProxyMode: (v: 'direct' | 'subscription' | 'tun' | 'system') => void
  setProxyUrl: (v: string) => void
  setProxySubUrl: (v: string) => void
  setProxySubNodeUrl: (v: string) => void
  setProxySelectedNode: (v: string) => void
  setProxyRegion: (v: string) => void
  setUseHelper: (v: boolean) => void
  setServerUrl: (v: string) => void
}

function loadSettings(): Partial<SettingsState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}

function persistSettings(state: SettingsState) {
  try {
    // NOTE: proxyUrl, proxySubUrl, proxySubNodeUrl are NOT persisted here.
    // They contain credentials (user:pass@host) and must not be stored in plaintext localStorage.
    // These values are loaded from encrypted session.json on startup via IPC.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      fontSize: state.fontSize,
      ideChoice: state.ideChoice,
      language: state.language,
      theme: state.theme,
      notificationsEnabled: state.notificationsEnabled,
      notificationSound: state.notificationSound,
      sleepInhibitorEnabled: state.sleepInhibitorEnabled,
      sidebarCollapsed: state.sidebarCollapsed,
      pinnedProjects: state.pinnedProjects,
      appMode: state.appMode,
      chatDrawerOpen: state.chatDrawerOpen,
      proxyEnabled: state.proxyEnabled,
      proxyMode: state.proxyMode,
      proxySelectedNode: state.proxySelectedNode,
      proxyRegion: state.proxyRegion,
      useHelper: state.useHelper,
      serverUrl: state.serverUrl,
    }))
  } catch { /* ignore */ }
}

function syncProxyToMain(state: SettingsState) {
  // system/tun mode: no env var proxy (TUN handles all traffic, or user has external proxy)
  const url = state.proxyMode === 'subscription' ? state.proxySubNodeUrl
    : state.proxyMode === 'system' ? '' // system proxy — don't inject env vars
    : state.proxyMode === 'tun' ? '' // TUN mode — sing-box handles traffic
    : state.proxyUrl
  window.api?.proxy?.updateSettings({
    enabled: state.proxyEnabled && state.proxyMode !== 'system',
    url,
    region: state.proxyRegion,
  })
}

export function resolveTheme(theme: ThemeChoice): 'dark' | 'light' {
  if (theme === 'dark' || theme === 'light') return theme
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function applyTheme(theme: ThemeChoice) {
  document.documentElement.setAttribute('data-theme', resolveTheme(theme))
}

const saved = loadSettings()

const validatedTheme: ThemeChoice = VALID_THEMES.includes((saved as any).theme) ? (saved as any).theme : 'auto'
const validatedLanguage: LanguageChoice = VALID_LANGUAGES.includes((saved as any).language) ? (saved as any).language : 'auto'
const validatedFontSize = typeof saved.fontSize === 'number' && saved.fontSize >= 10 && saved.fontSize <= 24 ? saved.fontSize : 14
const validatedAppMode: AppMode = VALID_APP_MODES.includes((saved as any).appMode) ? (saved as any).appMode : 'cli'

export const useSettingsStore = create<SettingsState>((set, get) => ({
  fontSize: validatedFontSize,
  ideChoice: saved.ideChoice ?? 'vscode',
  language: validatedLanguage,
  theme: validatedTheme,
  notificationsEnabled: typeof (saved as any).notificationsEnabled === 'boolean' ? (saved as any).notificationsEnabled : true,
  notificationSound: typeof (saved as any).notificationSound === 'boolean' ? (saved as any).notificationSound : true,
  sleepInhibitorEnabled: typeof (saved as any).sleepInhibitorEnabled === 'boolean' ? (saved as any).sleepInhibitorEnabled : true,
  sidebarCollapsed: typeof (saved as any).sidebarCollapsed === 'boolean' ? (saved as any).sidebarCollapsed : false,
  pinnedProjects: Array.isArray((saved as any).pinnedProjects) ? (saved as any).pinnedProjects.filter((p: unknown) => typeof p === 'string').slice(0, 10) : [],
  appMode: validatedAppMode,
  chatDrawerOpen: typeof (saved as any).chatDrawerOpen === 'boolean' ? (saved as any).chatDrawerOpen : false,

  proxyEnabled: typeof (saved as any).proxyEnabled === 'boolean' ? (saved as any).proxyEnabled : true,
  proxyMode: 'tun' as const,  // TUN mode only — not user-configurable
  proxyUrl: '',               // loaded from encrypted session.json on startup, not localStorage
  proxySubUrl: '',             // loaded from encrypted session.json on startup, not localStorage
  proxySubNodeUrl: '',         // loaded from encrypted session.json on startup, not localStorage
  proxySelectedNode: typeof (saved as any).proxySelectedNode === 'string' ? (saved as any).proxySelectedNode : '',
  proxyRegion: typeof (saved as any).proxyRegion === 'string' ? (saved as any).proxyRegion : 'us',
  useHelper: typeof (saved as any).useHelper === 'boolean' ? (saved as any).useHelper : true,

  serverUrl: typeof (saved as any).serverUrl === 'string' ? (saved as any).serverUrl : '',

  setFontSize: (v) => { set({ fontSize: v }); persistSettings(get()) },
  setIdeChoice: (v) => { set({ ideChoice: v }); persistSettings(get()) },
  setLanguage: (v) => { set({ language: v }); persistSettings(get()) },
  setTheme: (v) => { set({ theme: v }); applyTheme(v); persistSettings(get()) },
  setNotificationsEnabled: (v) => { set({ notificationsEnabled: v }); persistSettings(get()) },
  setNotificationSound: (v) => { set({ notificationSound: v }); persistSettings(get()) },
  setSidebarCollapsed: (v) => { set({ sidebarCollapsed: v }); persistSettings(get()) },
  setAppMode: (v) => { set({ appMode: v }); persistSettings(get()) },
  setChatDrawerOpen: (v) => { set({ chatDrawerOpen: v }); persistSettings(get()) },
  toggleChatDrawer: () => { set({ chatDrawerOpen: !get().chatDrawerOpen }); persistSettings(get()) },
  pinProject: (path) => {
    const { pinnedProjects } = get()
    if (pinnedProjects.includes(path) || pinnedProjects.length >= 10) return
    set({ pinnedProjects: [...pinnedProjects, path] })
    persistSettings(get())
  },
  unpinProject: (path) => {
    set({ pinnedProjects: get().pinnedProjects.filter(p => p !== path) })
    persistSettings(get())
  },
  setSleepInhibitorEnabled: (v) => {
    set({ sleepInhibitorEnabled: v })
    persistSettings(get())
    window.api?.power?.setSleepInhibitorEnabled(v)
  },
  setProxyEnabled: (v) => {
    set({ proxyEnabled: v })
    const s = get(); persistSettings(s); syncProxyToMain(s)
  },
  setProxyMode: (v) => {
    set({ proxyMode: v })
    const s = get(); persistSettings(s); syncProxyToMain(s)
  },
  setProxyUrl: (v) => {
    set({ proxyUrl: v })
    const s = get(); persistSettings(s); syncProxyToMain(s)
  },
  setProxySubUrl: (v) => { set({ proxySubUrl: v }); persistSettings(get()) },
  setProxySubNodeUrl: (v) => {
    set({ proxySubNodeUrl: v })
    const s = get(); persistSettings(s); syncProxyToMain(s)
  },
  setProxySelectedNode: (v) => { set({ proxySelectedNode: v }); persistSettings(get()) },
  setProxyRegion: (v) => {
    set({ proxyRegion: v })
    const s = get(); persistSettings(s); syncProxyToMain(s)
  },
  setUseHelper: (v) => { set({ useHelper: v }); persistSettings(get()) },
  setServerUrl: (v) => {
    set({ serverUrl: v })
    persistSettings(get())
    window.api?.subscription?.setApiBase(v || null)
  },
}))

applyTheme(validatedTheme)

// Sync initial proxy settings to main process
setTimeout(() => syncProxyToMain(useSettingsStore.getState()), 0)

// Sync persisted server URL override to main process so subscription API
// calls hit the user-configured host before the first login attempt.
setTimeout(() => {
  const { serverUrl } = useSettingsStore.getState()
  if (serverUrl) {
    window.api?.subscription?.setApiBase(serverUrl)
  }
}, 0)
