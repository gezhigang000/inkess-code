import { describe, expect, it, vi } from 'vitest'

import {
  cleanupForAccountSwitch,
  cleanupForLoginRedirect,
  type AuthCleanupApi,
} from '../../src/renderer/auth/session-cleanup'

function createApi(): AuthCleanupApi & {
  pty: { killAll: ReturnType<typeof vi.fn> }
  tun: { stop: ReturnType<typeof vi.fn> }
  browser: { closeAll: ReturnType<typeof vi.fn> }
  claude: { clearCredentials: ReturnType<typeof vi.fn> }
  subscription: { logout: ReturnType<typeof vi.fn> }
} {
  return {
    pty: { killAll: vi.fn(async () => undefined) },
    tun: { stop: vi.fn(async () => undefined) },
    browser: { closeAll: vi.fn() },
    claude: { clearCredentials: vi.fn() },
    subscription: { logout: vi.fn(async () => undefined) },
  }
}

describe('auth session cleanup', () => {
  it('preserves terminal sessions when redirecting to login', async () => {
    const api = createApi()

    await cleanupForLoginRedirect(api)

    expect(api.pty.killAll).not.toHaveBeenCalled()
    expect(api.tun.stop).toHaveBeenCalledOnce()
    expect(api.browser.closeAll).toHaveBeenCalledOnce()
    expect(api.claude.clearCredentials).toHaveBeenCalledOnce()
    expect(api.subscription.logout).toHaveBeenCalledOnce()
  })

  it('kills terminal sessions only for explicit account switches', async () => {
    const api = createApi()

    await cleanupForAccountSwitch(api)

    expect(api.pty.killAll).toHaveBeenCalledOnce()
    expect(api.tun.stop).toHaveBeenCalledOnce()
    expect(api.browser.closeAll).toHaveBeenCalledOnce()
    expect(api.claude.clearCredentials).toHaveBeenCalledOnce()
    expect(api.subscription.logout).toHaveBeenCalledOnce()
  })
})
