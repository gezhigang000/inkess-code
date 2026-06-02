import { beforeEach, describe, expect, it, vi } from 'vitest'

const sessions: Record<string, { cookies: { get: ReturnType<typeof vi.fn>, set: ReturnType<typeof vi.fn> } }> = {}
const { mockMainHttpRequest } = vi.hoisted(() => ({
  mockMainHttpRequest: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    isReady: vi.fn(() => true),
    whenReady: vi.fn(async () => undefined),
  },
  session: {
    fromPartition: vi.fn((partition: string) => {
      if (!sessions[partition]) {
        sessions[partition] = {
          cookies: {
            get: vi.fn(async () => []),
            set: vi.fn(async () => {}),
          },
        }
      }
      return sessions[partition]
    }),
  },
  BrowserWindow: vi.fn(),
}))

vi.mock('@main/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('@main/utils/main-http', () => ({
  mainHttpRequest: mockMainHttpRequest,
}))

import { session as electronSession } from 'electron'
import { BrowserSync, filterBrowserSyncCookies } from '@main/subscription/browser-sync'

const cookie = (domain: string, name = domain): Electron.Cookie => ({
  name,
  value: 'v',
  domain,
  hostOnly: false,
  path: '/',
  secure: true,
  httpOnly: false,
  session: false,
  sameSite: 'no_restriction',
})

describe('BrowserSync API URL', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(sessions)) delete sessions[key]
  })

  it('downloads browser data from the default Inkess AI subscription host', async () => {
    mockMainHttpRequest.mockResolvedValueOnce({ status: 204, ok: true })

    const browserSync = new BrowserSync()
    await browserSync.downloadAndImportCookies('alice', 'token-123')

    expect(mockMainHttpRequest.mock.calls[0][0]).toBe('https://llm.inkessai.com/api/subscription/browser-data')
  })

  it('uploads browser data to the default Inkess AI subscription host', async () => {
    mockMainHttpRequest
      .mockResolvedValueOnce({ status: 204, ok: true })
      .mockResolvedValueOnce({ status: 200, ok: true })

    const browserSync = new BrowserSync()
    await browserSync.downloadAndImportCookies('alice', 'token-123')
    await browserSync.upload()

    expect(mockMainHttpRequest.mock.calls[1][0]).toBe('https://llm.inkessai.com/api/subscription/browser-data')
  })

  it('keeps only Claude and OpenAI browser cookies', () => {
    const filtered = filterBrowserSyncCookies([
      cookie('.claude.ai'),
      cookie('accounts.claude.ai'),
      cookie('.claude.com'),
      cookie('.anthropic.com'),
      cookie('auth.openai.com'),
      cookie('.openai.com'),
      cookie('.chatgpt.com'),
      cookie('.google.com'),
      cookie('example.com'),
    ])

    expect(filtered.map(c => c.domain)).toEqual([
      '.claude.ai',
      'accounts.claude.ai',
      '.claude.com',
      '.anthropic.com',
      'auth.openai.com',
      '.openai.com',
      '.chatgpt.com',
    ])
  })

  it('uploads only allowlisted generic browser cookies', async () => {
    vi.mocked(electronSession.fromPartition).mockImplementation((partition: string) => {
      if (!sessions[partition]) {
        sessions[partition] = {
          cookies: {
            get: vi.fn(async () => partition.includes('browser')
              ? [cookie('.google.com'), cookie('auth.openai.com'), cookie('.claude.com')]
              : [cookie('.claude.ai')]),
            set: vi.fn(async () => {}),
          },
        }
      }
      return sessions[partition] as any
    })

    mockMainHttpRequest
      .mockResolvedValueOnce({ status: 204, ok: true })
      .mockResolvedValueOnce({ status: 200, ok: true })

    const browserSync = new BrowserSync()
    await browserSync.downloadAndImportCookies('alice', 'token-123')
    await browserSync.upload()

    const body = JSON.parse(mockMainHttpRequest.mock.calls[1][1].body)
    expect(body.browser.cookies.map((c: Electron.Cookie) => c.domain)).toEqual(['auth.openai.com', '.claude.com'])
  })
})
