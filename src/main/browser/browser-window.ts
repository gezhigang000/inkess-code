/**
 * Built-in browser window with multi-tab support.
 *
 * Uses BaseWindow + WebContentsView (Electron 41):
 * - Single BaseWindow reused for all browser opens
 * - Toolbar view: tab strip (30px) + address bar (42px) = 72px
 * - Multiple content views: one per tab, switched via setVisible()
 *
 * Tab commands from toolbar via page-title-updated:
 *   CMD:switchTab:<id>, CMD:closeTab:<id>, CMD:newTab
 *   CMD:back, CMD:forward, CMD:reload, CMD:stop
 */
import { BaseWindow, WebContentsView, session as electronSession, app } from 'electron'
import { join } from 'path'
import { writeFileSync, mkdirSync } from 'fs'
import { buildFingerprintMaskScript, FINGERPRINT_PROFILES } from './fingerprint-mask'
import log from '../logger'

const TOOLBAR_HEIGHT = 72
const MAX_TABS = 20

interface BrowserConfig {
  region: string
  regionEnv: Record<string, string>
  proxyUrl: string
  proxyEnabled: boolean
  tunRunning: boolean
  accountId: string  // subscription username — browser sessions are isolated per account
  claudeCredentials: { email: string; password: string } | null
  claudeAutoFillScript: (email: string, password: string) => string
  // Getter for one-time localStorage injection for claude.ai (from BrowserSync).
  // Using a getter instead of a pre-computed string so it's only consumed when
  // a claude.ai tab actually loads, not on every non-claude tab open.
  getLocalStorageImportScript?: () => string | null
}

interface TabInfo {
  id: number
  view: WebContentsView
  title: string
  url: string
  sessionKey: string
}

let browserWindow: BaseWindow | null = null
let toolbarView: WebContentsView | null = null
let tabs: TabInfo[] = []
let activeTabId: number = -1
let nextTabId = 1
let browserConfig: BrowserConfig | null = null
let allBrowserWindows: BaseWindow[] = []
const sessionsWithHeaderStripping = new Set<string>()

export function getAllBrowserWindows(): BaseWindow[] {
  return allBrowserWindows
}

export function closeAllBrowserWindows(): void {
  // Close all tab webContents
  for (const tab of tabs) {
    try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close() } catch { /* ignore */ }
  }
  tabs = []
  activeTabId = -1
  toolbarView = null
  browserWindow = null
  browserConfig = null

  allBrowserWindows.forEach(w => { try { if (!w.isDestroyed()) w.close() } catch { /* ignore */ } })
  allBrowserWindows = []
  // Clear header handlers so re-opened sessions get fresh Accept-Language for current region
  sessionsWithHeaderStripping.clear()
}

export async function openBrowserWindow(url: string, config: BrowserConfig): Promise<{ success?: boolean; error?: string }> {
  if (!/^https?:\/\//i.test(url)) {
    log.warn(`browser:open blocked non-http URL: ${url}`)
    return { error: 'Only http/https URLs are supported' }
  }

  if (config.proxyEnabled && !config.tunRunning) {
    log.warn('browser:open blocked — TUN not running')
    return { error: 'Network not connected. Please start TUN first.' }
  }

  browserConfig = config
  ensureBrowserWindow(config)

  const tab = await addTab(url, true, config)
  if (!tab) {
    return { error: `Maximum ${MAX_TABS} tabs reached` }
  }

  browserWindow!.focus()
  return { success: true }
}

export async function openBrowserEmpty(config: BrowserConfig): Promise<{ success?: boolean; error?: string }> {
  if (config.proxyEnabled && !config.tunRunning) {
    log.warn('browser:open blocked — TUN not running')
    return { error: 'Network not connected. Please start TUN first.' }
  }

  browserConfig = config

  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.focus()
    return { success: true }
  }

  ensureBrowserWindow(config)
  const tab = await addTab('https://www.google.com', true, config)
  if (!tab) {
    return { error: 'Failed to create tab' }
  }

  browserWindow!.focus()
  return { success: true }
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

function ensureBrowserWindow(config: BrowserConfig): void {
  if (browserWindow && !browserWindow.isDestroyed()) return

  // Reset state
  tabs = []
  activeTabId = -1
  toolbarView = null

  const win = new BaseWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'Browser',
    icon: join(__dirname, '../../resources/icon-256.png'),
  })

  browserWindow = win
  allBrowserWindows.push(win)

  // --- Toolbar view ---
  toolbarView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    }
  })
  win.contentView.addChildView(toolbarView)

  // Layout
  const layoutViews = () => {
    if (!browserWindow || browserWindow.isDestroyed() || !toolbarView) return
    const bounds = win.getContentBounds()
    const w = bounds.width
    const h = bounds.height
    toolbarView.setBounds({ x: 0, y: 0, width: w, height: TOOLBAR_HEIGHT })
    // Only layout active tab (others are hidden, will be laid out on switch)
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (activeTab) {
      activeTab.view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: h - TOOLBAR_HEIGHT })
    }
  }
  layoutViews()
  win.on('resize', layoutViews)

  // --- Toolbar interactions ---

  // Enter key in toolbar → navigate active tab
  toolbarView.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'Enter' && input.type === 'keyDown') {
      const active = tabs.find(t => t.id === activeTabId)
      if (!active || active.view.webContents.isDestroyed()) return
      toolbarView!.webContents.executeJavaScript(`document.getElementById('urlBar').value`)
        .then((val: string) => {
          const target = (val || '').trim()
          if (!target) return
          const finalUrl = /^https?:\/\//i.test(target) ? target : `https://${target}`
          if (!/^https?:\/\//i.test(finalUrl)) return
          active.view.webContents.loadURL(finalUrl)
          toolbarView!.webContents.executeJavaScript(`document.getElementById('urlBar').blur()`).catch(() => {})
        })
        .catch(() => {})
    }
  })

  // Button click handlers injected after toolbar loads
  toolbarView.webContents.on('did-finish-load', () => {
    if (!toolbarView || toolbarView.webContents.isDestroyed()) return
    toolbarView.webContents.executeJavaScript(`
      document.getElementById('backBtn').onclick = function() { document.title = 'CMD:back'; };
      document.getElementById('forwardBtn').onclick = function() { document.title = 'CMD:forward'; };
      document.getElementById('reloadBtn').onclick = function() { document.title = 'CMD:reload'; };
      document.getElementById('urlBar').onfocus = function() { this.select(); };
      true;
    `).catch(e => log.error('browser: toolbar inject failed', e))

    // Inject tab update function
    toolbarView.webContents.executeJavaScript(`
      window.__updateTabs = function(tabs) {
        var strip = document.getElementById('tabStrip');
        strip.innerHTML = tabs.map(function(t) {
          return '<div class="tab' + (t.active ? ' active' : '') + '" data-id="' + t.id + '">' +
            '<span class="tab-title">' + t.title.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>' +
            (tabs.length > 1 ? '<span class="tab-close" data-id="' + t.id + '">&times;</span>' : '') +
            '</div>';
        }).join('') + '<div class="tab-new" id="newTabBtn2">+</div>';
        strip.querySelectorAll('.tab').forEach(function(el) {
          el.onclick = function(e) {
            if (e.target.classList.contains('tab-close')) {
              document.title = 'CMD:closeTab:' + e.target.dataset.id;
            } else {
              document.title = 'CMD:switchTab:' + el.dataset.id;
            }
          };
        });
        var nb = document.getElementById('newTabBtn2');
        if (nb) nb.onclick = function() { document.title = 'CMD:newTab'; };
      };
      true;
    `).catch(e => log.error('browser: tab update inject failed', e))

    // Initial tab strip render
    updateTabStrip()
    updateToolbar()
  })

  // Command detection via title changes
  toolbarView.webContents.on('page-title-updated', (_event, title) => {
    if (!title.startsWith('CMD:')) return
    log.info('browser: toolbar command:', title)

    if (title === 'CMD:back') {
      const active = tabs.find(t => t.id === activeTabId)
      if (active && !active.view.webContents.isDestroyed()) {
        active.view.webContents.navigationHistory.goBack()
      }
    } else if (title === 'CMD:forward') {
      const active = tabs.find(t => t.id === activeTabId)
      if (active && !active.view.webContents.isDestroyed()) {
        active.view.webContents.navigationHistory.goForward()
      }
    } else if (title === 'CMD:reload') {
      const active = tabs.find(t => t.id === activeTabId)
      if (active && !active.view.webContents.isDestroyed()) {
        active.view.webContents.reload()
      }
    } else if (title === 'CMD:stop') {
      const active = tabs.find(t => t.id === activeTabId)
      if (active && !active.view.webContents.isDestroyed()) {
        active.view.webContents.stop()
      }
    } else if (title === 'CMD:newTab') {
      if (browserConfig) {
        addTab('https://www.google.com', true, browserConfig)
          .then(t => { if (!t) log.warn('browser: newTab failed — max tabs') })
          .catch(e => log.error('browser: newTab error', e))
      }
    } else if (title.startsWith('CMD:switchTab:')) {
      const tabId = parseInt(title.slice('CMD:switchTab:'.length), 10)
      if (!isNaN(tabId)) switchTab(tabId)
    } else if (title.startsWith('CMD:closeTab:')) {
      const tabId = parseInt(title.slice('CMD:closeTab:'.length), 10)
      if (!isNaN(tabId)) closeTab(tabId)
    }
  })

  // Load toolbar HTML
  const toolbarDir = join(app.getPath('userData'), 'browser')
  mkdirSync(toolbarDir, { recursive: true })
  const toolbarPath = join(toolbarDir, `toolbar-${win.id}.html`)
  writeFileSync(toolbarPath, buildToolbarHtml())
  toolbarView.webContents.loadFile(toolbarPath)

  // Cleanup on window close
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true

    // Close all tab webContents to prevent memory leaks
    for (const tab of tabs) {
      try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close() } catch { /* ignore */ }
    }
    tabs = []
    activeTabId = -1
    toolbarView = null
    browserWindow = null
    browserConfig = null

    allBrowserWindows = allBrowserWindows.filter(w => w !== win)
    try { require('fs').unlinkSync(toolbarPath) } catch { /* ignore */ }
  }
  win.once('closed', cleanup)
}

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------

async function createTab(url: string, config: BrowserConfig): Promise<TabInfo> {
  const tabId = nextTabId++
  const isClaude = /claude\.ai/i.test(url)
  // Sessions are isolated per subscription account — switching accounts gets a clean browser
  const acct = (config.accountId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
  const sessionKey = isClaude ? `persist:claude-${acct}` : `persist:browser-${acct}`
  const browserSession = electronSession.fromPartition(sessionKey)

  // TUN mode: no session proxy needed (TUN captures all traffic at network level)
  // Non-TUN mode: set session proxy for browser traffic
  if (!config.tunRunning && config.proxyEnabled && config.proxyUrl) {
    await browserSession.setProxy({ proxyRules: config.proxyUrl })
    const redacted = config.proxyUrl.replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:***@')
    log.info(`browser: tab ${tabId} proxy set to: ${redacted}`)
  } else {
    log.info(`browser: tab ${tabId} using TUN (no session proxy)`)
  }

  const lang = config.regionEnv.LANG?.split('.')[0]?.replace('_', '-') || 'en-US'

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: browserSession,
    }
  })

  // WebRTC leak prevention
  view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')

  // Strip Client Hints headers (once per session to avoid listener accumulation)
  if (!sessionsWithHeaderStripping.has(sessionKey)) {
    sessionsWithHeaderStripping.add(sessionKey)
    // Build Accept-Language from region (e.g. 'en-US' → 'en-US,en;q=0.9')
    const acceptLang = lang.includes('-') ? `${lang},${lang.split('-')[0]};q=0.9` : `${lang};q=0.9`
    view.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders }
      // Strip Client Hints
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase().startsWith('sec-ch-')) delete headers[key]
      }
      // Override Accept-Language to match region (prevents Chinese locale leaking)
      headers['Accept-Language'] = acceptLang
      callback({ requestHeaders: headers })
    })
  }

  // Fingerprint masking + language injection (dom-ready = before page JS runs)
  const fpProfile = FINGERPRINT_PROFILES[config.region] || FINGERPRINT_PROFILES.default
  const fpScript = buildFingerprintMaskScript(fpProfile)
  let localStorageInjected = false
  view.webContents.on('dom-ready', () => {
    view.webContents.executeJavaScript(fpScript).catch(() => {})
    // Inject navigator.language early (before page JS reads it)
    injectRegionMasking(view, config.regionEnv, lang)
    // One-time localStorage import from BrowserSync — only for claude.ai tabs,
    // and only consume the pending script when an actual claude.ai tab loads
    // (so opening browserleaks.com first doesn't waste the one-shot payload).
    if (isClaude && !localStorageInjected && config.getLocalStorageImportScript) {
      const script = config.getLocalStorageImportScript()
      if (script) {
        localStorageInjected = true
        view.webContents.executeJavaScript(script).catch(() => {})
        log.info('[BrowserSync] localStorage injected into claude.ai')
      }
    }
  })

  // Set language header + mask Electron/app from User-Agent
  const cleanUA = view.webContents.getUserAgent()
    .replace(/\s*Electron\/\S+/g, '')
    .replace(/\s*inkess-code\/\S+/g, '')
  // Set on webContents (not session) to avoid mutating shared persist:claude session
  view.webContents.setUserAgent(cleanUA)

  // Region masking: language + timezone injection
  view.webContents.on('did-finish-load', () => {
    injectRegionMasking(view, config.regionEnv, lang)
    // Claude auto-fill
    if (isClaude && config.claudeCredentials) {
      const pageUrl = view.webContents.getURL()
      if (pageUrl.includes('login') || pageUrl.includes('clerk') || pageUrl.includes('accounts.anthropic.com')) {
        view.webContents.executeJavaScript(
          config.claudeAutoFillScript(config.claudeCredentials.email, config.claudeCredentials.password)
        ).catch(() => {})
      }
    }
  })

  // Claude auto-fill on navigation
  if (isClaude && config.claudeCredentials) {
    let lastFilledUrl = ''
    view.webContents.on('did-navigate', (_navEvent, navUrl) => {
      if (navUrl === lastFilledUrl) return
      if (navUrl.includes('login') || navUrl.includes('clerk') || navUrl.includes('accounts.anthropic.com')) {
        lastFilledUrl = navUrl
        const creds = config.claudeCredentials!
        setTimeout(() => {
          view.webContents.executeJavaScript(
            config.claudeAutoFillScript(creds.email, creds.password)
          ).catch(() => {})
        }, 500)
      }
    })
  }

  const tabInfo: TabInfo = {
    id: tabId,
    view,
    title: 'New Tab',
    url,
    sessionKey,
  }

  // Navigation events — update toolbar only when this tab is active
  view.webContents.on('did-navigate', (_e, navUrl) => {
    tabInfo.url = navUrl
    if (tabInfo.id === activeTabId) updateToolbar()
  })
  view.webContents.on('did-navigate-in-page', (_e, navUrl) => {
    tabInfo.url = navUrl
    if (tabInfo.id === activeTabId) updateToolbar()
  })
  view.webContents.on('did-start-loading', () => {
    if (tabInfo.id === activeTabId) updateToolbar()
  })
  view.webContents.on('did-stop-loading', () => {
    if (tabInfo.id === activeTabId) updateToolbar()
  })
  view.webContents.on('page-title-updated', (_e, title) => {
    tabInfo.title = title || 'Untitled'
    updateTabStrip()
    if (tabInfo.id === activeTabId && browserWindow && !browserWindow.isDestroyed()) {
      browserWindow.setTitle(title || 'Browser')
    }
  })

  // Handle target="_blank" links — open as new tab
  view.webContents.setWindowOpenHandler(({ url: newUrl }) => {
    if (/^https?:\/\//i.test(newUrl) && browserConfig) {
      addTab(newUrl, true, browserConfig).catch(() => {})
    }
    return { action: 'deny' }
  })

  return tabInfo
}

async function addTab(url: string, activate: boolean, config: BrowserConfig): Promise<TabInfo | null> {
  if (tabs.length >= MAX_TABS) {
    log.warn(`browser: max tabs (${MAX_TABS}) reached`)
    return null
  }

  if (!browserWindow || browserWindow.isDestroyed()) return null

  const tab = await createTab(url, config)

  // Re-check window after async createTab — user may have closed it
  if (!browserWindow || browserWindow.isDestroyed()) {
    try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close() } catch { /* ignore */ }
    return null
  }

  tabs.push(tab)

  // Add view to window and set bounds
  browserWindow.contentView.addChildView(tab.view)
  layoutContentView(tab.view)

  // Start hidden unless activating
  tab.view.setVisible(false)

  if (activate) {
    switchTab(tab.id)
  }

  // Load URL
  tab.view.webContents.loadURL(url)

  updateTabStrip()
  return tab
}

function switchTab(tabId: number): void {
  const target = tabs.find(t => t.id === tabId)
  if (!target) return

  activeTabId = tabId

  for (const tab of tabs) {
    try { tab.view.setVisible(tab.id === tabId) } catch { /* view may be destroyed */ }
  }

  // Layout active tab (may have missed resize while hidden)
  layoutContentView(target.view)

  updateToolbar()
  updateTabStrip()

  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.setTitle(target.title || 'Browser')
  }
}

function closeTab(tabId: number): void {
  const idx = tabs.findIndex(t => t.id === tabId)
  if (idx === -1) return

  const tab = tabs[idx]

  // Remove view from window
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.contentView.removeChildView(tab.view)
  }

  // Critical: close webContents to prevent memory leak
  try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close() } catch { /* ignore */ }

  // Clean up session tracking for non-persist sessions (prevent Set leak)
  if (!tab.sessionKey.startsWith('persist:')) {
    sessionsWithHeaderStripping.delete(tab.sessionKey)
  }

  tabs.splice(idx, 1)

  // If last tab closed, close window
  if (tabs.length === 0) {
    if (browserWindow && !browserWindow.isDestroyed()) {
      browserWindow.close()
    }
    return
  }

  // Switch to adjacent tab if active tab was closed
  if (activeTabId === tabId) {
    const newIdx = Math.min(idx, tabs.length - 1)
    switchTab(tabs[newIdx].id)
  } else {
    updateTabStrip()
  }
}

function layoutContentView(view: WebContentsView): void {
  if (!browserWindow || browserWindow.isDestroyed()) return
  const bounds = browserWindow.getContentBounds()
  view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: bounds.width, height: bounds.height - TOOLBAR_HEIGHT })
}

// ---------------------------------------------------------------------------
// Toolbar updates
// ---------------------------------------------------------------------------

function updateToolbar(): void {
  if (!toolbarView || toolbarView.webContents.isDestroyed()) return

  const active = tabs.find(t => t.id === activeTabId)
  if (!active || active.view.webContents.isDestroyed()) return

  const safeUrl = JSON.stringify(active.view.webContents.getURL())
  const canGoBack = active.view.webContents.navigationHistory.canGoBack()
  const canGoForward = active.view.webContents.navigationHistory.canGoForward()
  const loading = active.view.webContents.isLoading()

  toolbarView.webContents.executeJavaScript(`
    document.getElementById('urlBar').value = ${safeUrl};
    document.getElementById('backBtn').disabled = ${!canGoBack};
    document.getElementById('forwardBtn').disabled = ${!canGoForward};
    document.getElementById('toolbar').classList.toggle('loading', ${loading});
  `).catch(() => {})
}

function updateTabStrip(): void {
  if (!toolbarView || toolbarView.webContents.isDestroyed()) return

  const tabData = tabs.map(t => ({
    id: t.id,
    title: (t.title || 'New Tab').slice(0, 30),
    active: t.id === activeTabId,
  }))

  const safeData = JSON.stringify(tabData)
  toolbarView.webContents.executeJavaScript(`
    if (window.__updateTabs) window.__updateTabs(${safeData});
  `).catch(() => {})
}

// ---------------------------------------------------------------------------
// Region masking (preserved as-is)
// ---------------------------------------------------------------------------

function injectRegionMasking(view: WebContentsView, regionEnv: Record<string, string>, lang: string): void {
  // ALWAYS inject navigator.language/languages — do NOT guard on regionEnv.LANG.
  //
  // The previous version had `if (regionEnv.LANG)` around the inject block,
  // which meant when proxyRegion was 'auto' (REGION_ENV['auto'] = {}), we
  // silently skipped the override and the browser fell back to the user's
  // real system locale. On a Chinese Mac that's `zh-CN`, which Claude.ai's
  // country gate uses as a strong "user is in China" signal and blocks the
  // session outright — even if the exit IP is clean.
  //
  // `lang` is always a non-empty string (the caller defaults it to 'en-US'
  // when regionEnv.LANG is missing), so injecting unconditionally is safe
  // and consistent with the rest of the browser-window code that also
  // always runs the fingerprint mask.
  const safeLang = JSON.stringify(lang)
  view.webContents.executeJavaScript(`
    Object.defineProperty(navigator, 'language', { get: () => ${safeLang} });
    Object.defineProperty(navigator, 'languages', { get: () => [${safeLang}, 'en'] });
  `).catch(() => {})

  // Intl.DateTimeFormat timezone override. Still guarded on regionEnv.TZ
  // because with the 'auto' region there's no meaningful timezone to
  // apply — leaving Intl alone in that case is fine (it'll use the
  // system default which is a separate leak we're not addressing here).
  if (regionEnv.TZ) {
    const safeTz = JSON.stringify(regionEnv.TZ)
    view.webContents.executeJavaScript(`
      (function() {
        var __tz = ${safeTz};
        var __origDTF = Intl.DateTimeFormat;
        var __newDTF = function(locale, opts) {
          return new __origDTF(locale, Object.assign({}, opts, { timeZone: (opts && opts.timeZone) || __tz }));
        };
        __newDTF.prototype = __origDTF.prototype;
        __newDTF.supportedLocalesOf = __origDTF.supportedLocalesOf.bind(__origDTF);
        Object.defineProperty(__newDTF, Symbol.hasInstance, { value: function(i) { return i instanceof __origDTF; } });
        Intl.DateTimeFormat = __newDTF;
      })();
    `).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Toolbar HTML
// ---------------------------------------------------------------------------

function buildToolbarHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 13px;
    background: #f0f0f0;
    color: #333;
    user-select: none;
    overflow: hidden;
  }
  /* --- Tab strip (top 30px) --- */
  .tab-strip {
    display: flex;
    height: 30px;
    background: #e8e8e8;
    padding: 4px 8px 0;
    gap: 2px;
    overflow-x: auto;
    align-items: flex-end;
  }
  .tab-strip::-webkit-scrollbar { display: none; }
  .tab {
    display: flex;
    align-items: center;
    height: 26px;
    padding: 0 8px 0 12px;
    background: #d8d8d8;
    border-radius: 6px 6px 0 0;
    font-size: 12px;
    cursor: pointer;
    max-width: 200px;
    min-width: 80px;
    gap: 4px;
    flex-shrink: 0;
  }
  .tab.active { background: #f0f0f0; }
  .tab-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .tab-close {
    width: 16px; height: 16px;
    border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; color: #888; flex-shrink: 0;
  }
  .tab-close:hover { background: #c0c0c0; color: #333; }
  .tab-new {
    width: 26px; height: 26px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; color: #888; cursor: pointer;
    border-radius: 6px 6px 0 0; flex-shrink: 0;
  }
  .tab-new:hover { background: #d0d0d0; }
  /* --- Address bar (bottom 42px) --- */
  .toolbar {
    display: flex;
    align-items: center;
    height: 42px;
    padding: 0 8px;
    gap: 4px;
    border-bottom: 1px solid #d0d0d0;
  }
  .nav-btn {
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #555;
    font-size: 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .nav-btn:hover { background: #e0e0e0; }
  .nav-btn:active { background: #d0d0d0; }
  .nav-btn:disabled { opacity: 0.3; cursor: default; }
  .nav-btn:disabled:hover { background: transparent; }
  .url-bar {
    flex: 1;
    height: 28px;
    border: 1px solid #c8c8c8;
    border-radius: 8px;
    padding: 0 12px;
    font-size: 13px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Mono", Menlo, monospace;
    background: #fff;
    outline: none;
    color: #333;
    min-width: 100px;
  }
  .url-bar:focus { border-color: #4a90d9; box-shadow: 0 0 0 2px rgba(74,144,217,0.2); }
  .loading .reload-btn::after { content: '\\2715'; }
  .reload-btn::after { content: '\\21BB'; }
</style>
</head>
<body>
<div class="tab-strip" id="tabStrip"></div>
<div class="toolbar" id="toolbar">
  <button class="nav-btn back-btn" id="backBtn" title="Back" disabled>&#9664;</button>
  <button class="nav-btn forward-btn" id="forwardBtn" title="Forward" disabled>&#9654;</button>
  <button class="nav-btn reload-btn" id="reloadBtn" title="Reload"></button>
  <input class="url-bar" id="urlBar" type="text" placeholder="Enter URL..." spellcheck="false" autocomplete="off">
</div>
</body>
</html>`
}
