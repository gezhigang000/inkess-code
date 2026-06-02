import { execFileSync } from 'child_process'

export interface MainHttpOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBuffer?: number
}

export class MainHttpResponse {
  constructor(
    public readonly status: number,
    private readonly bodyText: string,
  ) {}

  get ok(): boolean {
    return this.status >= 200 && this.status < 300
  }

  async text(): Promise<string> {
    return this.bodyText
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.bodyText)
  }
}

export async function mainHttpRequest(url: string, options: MainHttpOptions = {}): Promise<MainHttpResponse> {
  if (process.platform === 'darwin' && process.env.INKESS_HTTP_TRANSPORT !== 'node') {
    return curlRequest(url, options)
  }
  return fetchRequest(url, options)
}

async function fetchRequest(url: string, options: MainHttpOptions): Promise<MainHttpResponse> {
  const timeoutMs = options.timeoutMs ?? 15000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    })
    return new MainHttpResponse(res.status, await res.text())
  } finally {
    clearTimeout(timer)
  }
}

async function curlRequest(url: string, options: MainHttpOptions): Promise<MainHttpResponse> {
  const timeoutMs = options.timeoutMs ?? 15000
  const marker = '\n__INKESS_STATUS__:'
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  const args = [
    '--silent',
    '--show-error',
    '--http1.1',
    '--max-time', String(timeoutSeconds),
    '--connect-timeout', String(Math.min(5, timeoutSeconds)),
    '--output', '-',
    '--write-out', `${marker}%{http_code}`,
  ]

  if (options.method) args.push('--request', options.method)
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    args.push('--header', `${name}: ${value}`)
  }
  if (options.body !== undefined) {
    args.push('--data-binary', '@-')
  }
  args.push(url)

  const output = execFileSync('curl', args, {
    input: options.body,
    timeout: timeoutMs + 1500,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
    encoding: 'utf8',
  })

  const markerIndex = output.lastIndexOf(marker)
  if (markerIndex < 0) {
    throw new Error('curl returned malformed response')
  }

  const status = Number(output.slice(markerIndex + marker.length).trim())
  if (!Number.isFinite(status) || status <= 0) {
    throw new Error(`curl returned invalid HTTP status: ${status}`)
  }
  return new MainHttpResponse(status, output.slice(0, markerIndex))
}
