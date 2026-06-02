import { Buffer } from 'buffer'
import log from '../logger'
import { mainHttpRequest } from '../utils/main-http'

export interface ProxyNode {
  name: string
  type: 'socks5' | 'http' | 'https' | 'ss' | 'ssr' | 'vmess' | 'vless' | 'trojan' | 'hysteria2' | 'unknown'
  server: string
  port: number
  url: string         // full proxy URL for direct use (socks5/http only)
  region: string      // auto-detected region code: 'us', 'jp', 'sg', etc.
  regionFlag: string  // emoji flag
  usable: boolean     // true if can be used directly (socks5/http/https)
  raw: string         // original line/config for debugging
}

const REGION_DETECT: [RegExp, string, string][] = [
  [/\b(US|美国|United\s*States|America|Los\s*Angeles|San\s*Jose|New\s*York|Chicago|Dallas|Seattle|Silicon|Washington)/i, 'us', '🇺🇸'],
  [/\b(JP|日本|Japan|Tokyo|Osaka)/i, 'jp', '🇯🇵'],
  [/\b(SG|新加坡|Singapore)/i, 'sg', '🇸🇬'],
  [/\b(HK|香港|Hong\s*Kong)/i, 'hk', '🇭🇰'],
  [/\b(TW|台湾|Taiwan|Taipei)/i, 'tw', '🇹🇼'],
  [/\b(KR|韩国|Korea|Seoul)/i, 'kr', '🇰🇷'],
  [/\b(DE|德国|Germany|Frankfurt|Berlin)/i, 'de', '🇩🇪'],
  [/\b(GB|UK|英国|United\s*Kingdom|London)/i, 'gb', '🇬🇧'],
  [/\b(AU|澳大利亚|Australia|Sydney)/i, 'au', '🇦🇺'],
  [/\b(CA|加拿大|Canada|Toronto|Vancouver)/i, 'us', '🇨🇦'],
  [/\b(FR|法国|France|Paris)/i, 'de', '🇫🇷'],
  [/\b(IN|印度|India|Mumbai)/i, 'sg', '🇮🇳'],
  [/\b(RU|俄罗斯|Russia|Moscow)/i, 'de', '🇷🇺'],
]

export function detectRegion(name: string): { region: string; flag: string } {
  for (const [re, region, flag] of REGION_DETECT) {
    if (re.test(name)) return { region, flag }
  }
  return { region: 'auto', flag: '🌐' }
}

/** Parse a proxy subscription URL response into normalized node list */
export function parseSubscription(content: string): ProxyNode[] {
  const trimmed = content.trim()

  // Try Base64 decode first (most common subscription format)
  let decoded = ''
  try {
    decoded = Buffer.from(trimmed, 'base64').toString('utf-8')
    // Verify it decoded to something meaningful (has protocol-like patterns)
    if (!decoded.includes('://') && !decoded.includes('server')) {
      decoded = ''
    }
  } catch {
    decoded = ''
  }

  const text = decoded || trimmed

  // Try Clash YAML format
  if (text.includes('proxies:') || text.includes('Proxy:')) {
    return parseClashYaml(text)
  }

  // Try line-by-line proxy URLs
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const nodes: ProxyNode[] = []
  for (const line of lines) {
    const node = parseProxyLine(line)
    if (node) nodes.push(node)
  }
  return nodes
}

function parseProxyLine(line: string): ProxyNode | null {
  try {
    if (line.startsWith('socks5://') || line.startsWith('socks://')) {
      return parseDirectProxy(line, 'socks5')
    }
    if (line.startsWith('http://')) {
      return parseDirectProxy(line, 'http')
    }
    if (line.startsWith('https://')) {
      return parseDirectProxy(line, 'https')
    }
    if (line.startsWith('ss://')) {
      return parseShadowsocks(line)
    }
    if (line.startsWith('ssr://')) {
      return parseSsr(line)
    }
    if (line.startsWith('vmess://')) {
      return parseVmess(line)
    }
    if (line.startsWith('vless://')) {
      return parseVless(line)
    }
    if (line.startsWith('trojan://')) {
      return parseTrojan(line)
    }
    if (line.startsWith('hysteria2://') || line.startsWith('hy2://')) {
      return parseHysteria2(line)
    }
  } catch (err) {
    log.warn(`[Subscription] Failed to parse line: ${line.slice(0, 80)}`, err)
  }
  return null
}

function parseDirectProxy(line: string, type: 'socks5' | 'http' | 'https'): ProxyNode {
  const url = new URL(line)
  const name = url.hash ? decodeURIComponent(url.hash.slice(1)) : `${url.hostname}:${url.port}`
  const { region, flag } = detectRegion(name)
  return {
    name, type, server: url.hostname, port: Number(url.port) || (type === 'https' ? 443 : 1080),
    url: line.split('#')[0], region, regionFlag: flag, usable: true, raw: line,
  }
}

function parseShadowsocks(line: string): ProxyNode {
  // ss://base64(method:password)@server:port#name
  // or ss://base64(method:password@server:port)#name
  const hashIdx = line.indexOf('#')
  const name = hashIdx > 0 ? decodeURIComponent(line.slice(hashIdx + 1)) : 'SS Node'
  const body = line.slice(5, hashIdx > 0 ? hashIdx : undefined)

  let server = '', port = 0
  if (body.includes('@')) {
    // Format: base64(method:password)@server:port
    const [, rest] = body.split('@')
    if (rest) {
      const [s, p] = rest.split(':')
      server = s; port = Number(p)
    }
  } else {
    // Fully base64 encoded
    try {
      const decoded = Buffer.from(body, 'base64').toString('utf-8')
      const atIdx = decoded.lastIndexOf('@')
      if (atIdx > 0) {
        const [s, p] = decoded.slice(atIdx + 1).split(':')
        server = s; port = Number(p)
      }
    } catch { /* ignore */ }
  }

  const { region, flag } = detectRegion(name)
  return {
    name, type: 'ss', server, port, url: '', region, regionFlag: flag,
    usable: false, raw: line,
  }
}

function parseSsr(line: string): ProxyNode {
  const body = line.slice(6)
  let decoded = ''
  try { decoded = Buffer.from(body, 'base64').toString('utf-8') } catch { /* ignore */ }
  const parts = decoded.split(':')
  const server = parts[0] || ''
  const port = Number(parts[1]) || 0
  const name = decoded.includes('/') ? decodeURIComponent(decoded.split('remarks=')[1]?.split('&')[0] || '') : `SSR ${server}`
  const { region, flag } = detectRegion(name || server)
  return {
    name: name || `SSR ${server}:${port}`, type: 'ssr', server, port, url: '', region, regionFlag: flag,
    usable: false, raw: line,
  }
}

function parseVmess(line: string): ProxyNode {
  const body = line.slice(8)
  try {
    const json = JSON.parse(Buffer.from(body, 'base64').toString('utf-8'))
    const name = json.ps || json.remark || `VMess ${json.add}:${json.port}`
    const { region, flag } = detectRegion(name)
    return {
      name, type: 'vmess', server: json.add || '', port: Number(json.port) || 0,
      url: '', region, regionFlag: flag, usable: false, raw: line,
    }
  } catch {
    return { name: 'VMess Node', type: 'vmess', server: '', port: 0, url: '', region: 'auto', regionFlag: '🌐', usable: false, raw: line }
  }
}

function parseVless(line: string): ProxyNode {
  try {
    const url = new URL(line)
    const name = url.hash ? decodeURIComponent(url.hash.slice(1)) : `VLESS ${url.hostname}`
    const { region, flag } = detectRegion(name)
    return {
      name, type: 'vless', server: url.hostname, port: Number(url.port) || 443,
      url: '', region, regionFlag: flag, usable: false, raw: line,
    }
  } catch {
    return { name: 'VLESS Node', type: 'vless', server: '', port: 0, url: '', region: 'auto', regionFlag: '🌐', usable: false, raw: line }
  }
}

function parseTrojan(line: string): ProxyNode {
  try {
    const url = new URL(line)
    const name = url.hash ? decodeURIComponent(url.hash.slice(1)) : `Trojan ${url.hostname}`
    const { region, flag } = detectRegion(name)
    return {
      name, type: 'trojan', server: url.hostname, port: Number(url.port) || 443,
      url: '', region, regionFlag: flag, usable: false, raw: line,
    }
  } catch {
    return { name: 'Trojan Node', type: 'trojan', server: '', port: 0, url: '', region: 'auto', regionFlag: '🌐', usable: false, raw: line }
  }
}

function parseHysteria2(line: string): ProxyNode {
  try {
    const url = new URL(line.replace(/^hy2:\/\//, 'hysteria2://'))
    const name = url.hash ? decodeURIComponent(url.hash.slice(1)) : `Hysteria2 ${url.hostname}`
    const { region, flag } = detectRegion(name)
    return {
      name, type: 'hysteria2', server: url.hostname, port: Number(url.port) || 443,
      url: '', region, regionFlag: flag, usable: false, raw: line,
    }
  } catch {
    return { name: 'Hysteria2 Node', type: 'hysteria2', server: '', port: 0, url: '', region: 'auto', regionFlag: '🌐', usable: false, raw: line }
  }
}

function parseClashYaml(text: string): ProxyNode[] {
  // Simple YAML proxy parser (no full YAML lib needed)
  const nodes: ProxyNode[] = []
  const lines = text.split('\n')
  let inProxies = false
  let currentNode: Record<string, string> = {}

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === 'proxies:' || trimmed === 'Proxy:') {
      inProxies = true
      continue
    }
    // End of proxies section: a new top-level key (no leading whitespace in original line)
    if (inProxies && /^[a-zA-Z]/.test(line) && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (currentNode.name) { pushClashNode(nodes, currentNode); currentNode = {} }
      inProxies = false
      continue
    }
    if (!inProxies) continue

    if (trimmed.startsWith('- {') || trimmed.startsWith('-{')) {
      // Inline YAML: - {name: xxx, type: ss, server: xxx, port: 443, ...}
      const obj = parseInlineYaml(trimmed.slice(trimmed.indexOf('{') + 1, -1))
      if (obj.name && obj.server) {
        pushClashNode(nodes, obj)
      }
    } else if (trimmed.startsWith('- name:') || trimmed.startsWith('-name:')) {
      // Multi-line YAML block start
      if (currentNode.name) {
        pushClashNode(nodes, currentNode)
      }
      currentNode = { name: trimmed.split(':').slice(1).join(':').trim().replace(/^["']|["']$/g, '') }
    } else if (trimmed.startsWith('name:') && Object.keys(currentNode).length > 0) {
      currentNode.name = trimmed.split(':').slice(1).join(':').trim().replace(/^["']|["']$/g, '')
    } else if (/^[a-z][a-z0-9_-]*:/i.test(trimmed) && !trimmed.startsWith('- ')) {
      // Capture all key-value fields (type, server, port, password, uuid, flow, network, sni, etc.)
      const colonIdx = trimmed.indexOf(':')
      const key = trimmed.slice(0, colonIdx).trim()
      const val = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
      currentNode[key] = val
    }
  }
  if (currentNode.name) pushClashNode(nodes, currentNode)

  return nodes
}

/** Build a protocol URL from clash yaml node fields */
function buildProtocolUrl(obj: Record<string, string>): string {
  const type = (obj.type || '').toLowerCase()
  const server = obj.server || ''
  const port = obj.port || '443'
  const name = obj.name || ''
  const encoded = encodeURIComponent(name)

  if (type === 'ss') {
    const method = obj.cipher || obj.method || 'aes-256-gcm'
    const password = obj.password || ''
    const userinfo = Buffer.from(`${method}:${password}`).toString('base64url')
    return `ss://${userinfo}@${server}:${port}#${encoded}`
  }
  if (type === 'vmess') {
    const json = { v: '2', ps: name, add: server, port, id: obj.uuid || '', aid: obj.alterId || '0', net: obj.network || 'tcp', type: 'none', tls: obj.tls === 'true' ? 'tls' : '' }
    return `vmess://${Buffer.from(JSON.stringify(json)).toString('base64')}`
  }
  if (type === 'vless') {
    const uuid = obj.uuid || ''
    const params = new URLSearchParams()
    if (obj.network) params.set('type', obj.network)
    if (obj.flow) params.set('flow', obj.flow)
    const sni = obj.servername || obj.sni || ''
    if (sni) params.set('sni', sni)
    // Reality support
    if (obj['reality-opts'] || obj['public-key']) {
      params.set('security', 'reality')
      if (obj['public-key']) params.set('pbk', obj['public-key'])
      if (obj['short-id']) params.set('sid', obj['short-id'])
      if (sni) params.set('sni', sni)
    } else if (obj.tls === 'true') {
      params.set('security', 'tls')
    }
    if (obj['client-fingerprint']) params.set('fp', obj['client-fingerprint'])
    return `vless://${uuid}@${server}:${port}?${params}#${encoded}`
  }
  if (type === 'trojan') {
    const password = obj.password || ''
    const params = new URLSearchParams()
    const sni = obj.sni || obj.servername || ''
    if (sni) params.set('sni', sni)
    if (obj.network === 'ws') {
      params.set('type', 'ws')
      if (obj['ws-path'] || obj.path) params.set('path', obj['ws-path'] || obj.path || '')
      if (sni) params.set('host', sni)
    }
    return `trojan://${encodeURIComponent(password)}@${server}:${port}?${params}#${encoded}`
  }
  if (type === 'hysteria2' || type === 'hy2') {
    const password = obj.password || ''
    const params = new URLSearchParams()
    if (obj.sni || obj.servername) params.set('sni', obj.sni || obj.servername || '')
    if (obj.obfs) params.set('obfs', obj.obfs)
    if (obj['obfs-password']) params.set('obfs-password', obj['obfs-password'])
    if (obj['skip-cert-verify'] === 'true') params.set('insecure', '1')
    return `hysteria2://${encodeURIComponent(password)}@${server}:${port}?${params}#${encoded}`
  }
  if (type === 'socks5' || type === 'http' || type === 'https') {
    return `${type}://${server}:${port}`
  }
  return ''
}

function pushClashNode(nodes: ProxyNode[], obj: Record<string, string>): void {
  const type = (obj.type || 'unknown').toLowerCase() as ProxyNode['type']
  const { region, flag } = detectRegion(obj.name || '')
  const protocolUrl = buildProtocolUrl(obj)
  nodes.push({
    name: obj.name || 'Unknown', type, server: obj.server || '', port: Number(obj.port) || 0,
    url: protocolUrl, region, regionFlag: flag, usable: !!protocolUrl, raw: protocolUrl || JSON.stringify(obj),
  })
}

function parseInlineYaml(str: string): Record<string, string> {
  const obj: Record<string, string> = {}
  // Quote-aware key: value parser — handles commas inside quoted strings
  let i = 0
  while (i < str.length) {
    // Skip whitespace
    while (i < str.length && str[i] === ' ') i++
    // Find key
    const colonIdx = str.indexOf(':', i)
    if (colonIdx < 0) break
    const key = str.slice(i, colonIdx).trim()
    i = colonIdx + 1
    // Skip whitespace after colon
    while (i < str.length && str[i] === ' ') i++
    // Parse value (respect quotes)
    let val = ''
    if (str[i] === '"' || str[i] === "'") {
      const quote = str[i]
      i++ // skip opening quote
      const endQuote = str.indexOf(quote, i)
      if (endQuote >= 0) {
        val = str.slice(i, endQuote)
        i = endQuote + 1
      }
    } else {
      const commaIdx = str.indexOf(',', i)
      val = (commaIdx >= 0 ? str.slice(i, commaIdx) : str.slice(i)).trim()
      i = commaIdx >= 0 ? commaIdx : str.length
    }
    if (key) obj[key] = val
    // Skip comma
    if (i < str.length && str[i] === ',') i++
  }
  return obj
}

/** Fetch and parse a subscription URL */
export async function fetchSubscription(url: string, timeout = 15000): Promise<ProxyNode[]> {
  log.info(`[subscription] fetching — url=${url.slice(0, 50)}..., timeout=${timeout}ms`)

  try {
    const res = await mainHttpRequest(url, {
      headers: {
        'User-Agent': 'ClashForWindows/0.20.39',  // Common UA for subscriptions
      },
      timeoutMs: timeout,
      maxBuffer: 2 * 1024 * 1024 + 4096,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    const byteLength = Buffer.byteLength(text, 'utf8')
    log.info(`[subscription] response size=${byteLength} bytes`)
    if (byteLength > 2 * 1024 * 1024) {
      throw new Error('Subscription response too large (>2MB)')
    }
    const nodes = parseSubscription(text)
    log.info(`[subscription] parsed ${nodes.length} nodes: ${nodes.map(n => `${n.name}(${n.type})`).join(', ')}`)
    return nodes
  } catch (err) {
    log.error(`[subscription] fetch failed: ${(err as Error).message}`)
    throw err
  }
}
