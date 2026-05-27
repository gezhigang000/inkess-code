export interface AuthCleanupApi {
  pty: {
    killAll: () => Promise<unknown>
  }
  tun: {
    stop: () => Promise<unknown>
  }
  browser: {
    closeAll: () => unknown
  }
  claude: {
    clearCredentials: () => unknown
  }
  subscription: {
    logout: () => Promise<unknown> | unknown
  }
}

export async function cleanupForLoginRedirect(api: AuthCleanupApi): Promise<void> {
  await api.tun.stop()
  api.browser.closeAll()
  api.claude.clearCredentials()
  await api.subscription.logout()
}

export async function cleanupForAccountSwitch(api: AuthCleanupApi): Promise<void> {
  await api.pty.killAll()
  await cleanupForLoginRedirect(api)
}
