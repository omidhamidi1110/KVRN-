import { createHash } from 'crypto'
import { sanitizeExternalText } from '../sanitize'

const MAX_BODY_BYTES = 512_000
const MAX_REDIRECTS = 3
const DNS_TIMEOUT_MS = 4_000
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'

function parseIpv4(value: string): number[] | null {
  const m = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const octets = m.slice(1).map(Number)
  return octets.some(n => !Number.isInteger(n) || n < 0 || n > 255) ? null : octets
}

function isUnsafeIpv4(octets: number[]): boolean {
  const [a,b,c] = octets
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
}

function parseIpv6(value: string): number[] | null {
  let input = value.toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0]
  if (!input.includes(':')) return null

  // Convert an embedded dotted IPv4 tail into two hexadecimal groups.
  const lastColon = input.lastIndexOf(':')
  const tail = input.slice(lastColon + 1)
  const v4 = parseIpv4(tail)
  if (v4) {
    input = `${input.slice(0, lastColon)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }

  const pieces = input.split('::')
  if (pieces.length > 2) return null
  const left = pieces[0] ? pieces[0].split(':').filter(Boolean) : []
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':').filter(Boolean) : []
  if (pieces.length === 1 && left.length !== 8) return null
  if (pieces.length === 2 && left.length + right.length >= 8) return null
  const fill = pieces.length === 2 ? Array(8 - left.length - right.length).fill('0') : []
  const groups = [...left, ...fill, ...right]
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map(g => Number.parseInt(g, 16))
}

function isUnsafeIpv6(groups: number[]): boolean {
  const [g0,g1,g2,g3,g4,g5,g6,g7] = groups
  const allZero = groups.every(g => g === 0)
  if (allZero || (groups.slice(0,7).every(g => g === 0) && g7 === 1)) return true // :: / ::1
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  if ((g0 & 0xffc0) === 0xfec0) return true // deprecated site local
  if ((g0 & 0xff00) === 0xff00) return true // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true // documentation

  // ::ffff:0:0/96 IPv4-mapped addresses: classify the embedded IPv4 too.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isUnsafeIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff])
  }
  return false
}

function isIpLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return parseIpv4(h) !== null || parseIpv6(h) !== null
}

function isUnsafeHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h || h.length > 253 || !h.includes('.')) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true
  if (h.endsWith('.onion') || h.endsWith('.test') || h.endsWith('.invalid') || h.endsWith('.example')) return true
  return false
}

function isUnsafeResolvedAddress(value: string): boolean {
  const v4 = parseIpv4(value)
  if (v4) return isUnsafeIpv4(v4)
  const v6 = parseIpv6(value)
  if (v6) return isUnsafeIpv6(v6)
  return true
}

async function dohAddresses(hostname: string, type: 'A' | 'AAAA', fetchImpl: typeof fetch): Promise<string[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS)
  try {
    const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`
    const res = await fetchImpl(url, {
      method:'GET', signal:controller.signal, cache:'no-store',
      headers:{ accept:'application/dns-json', 'user-agent':'KVRN-Market-Research-DNS/1.0' },
    })
    if (!res.ok) throw new Error('MARKET_DNS_PREFLIGHT_FAILED')
    const body = await res.json() as { Status?:number; Answer?:Array<{type?:number;data?:string}> }
    if (body.Status !== 0) throw new Error('MARKET_DNS_PREFLIGHT_FAILED')
    const wantedType = type === 'A' ? 1 : 28
    return (body.Answer ?? []).filter(a => a.type === wantedType && typeof a.data === 'string').map(a => String(a.data))
  } catch (error) {
    if (error instanceof Error && error.message === 'MARKET_DNS_PREFLIGHT_FAILED') throw error
    throw new Error('MARKET_DNS_PREFLIGHT_FAILED')
  } finally { clearTimeout(timer) }
}

async function assertPublicDnsResolution(hostname: string, fetchImpl: typeof fetch): Promise<void> {
  // Cloudflare Workers resolves public fetches independently. This preflight uses
  // Cloudflare's public recursive resolver so a hostname resolving to private,
  // link-local, loopback or documentation space is rejected before the fetch.
  const [v4,v6] = await Promise.all([dohAddresses(hostname,'A',fetchImpl),dohAddresses(hostname,'AAAA',fetchImpl)])
  const addresses = [...v4,...v6]
  if (!addresses.length) throw new Error('MARKET_DNS_NO_PUBLIC_ADDRESS')
  if (addresses.some(isUnsafeResolvedAddress)) throw new Error('MARKET_DNS_PRIVATE_ADDRESS')
}

export function validatePublicResearchUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('MARKET_URL_INVALID') }
  if (url.protocol !== 'https:') throw new Error('MARKET_URL_HTTPS_REQUIRED')
  if (url.username || url.password) throw new Error('MARKET_URL_CREDENTIALS_FORBIDDEN')
  if (url.port && url.port !== '443') throw new Error('MARKET_URL_PORT_FORBIDDEN')
  if (isIpLiteral(url.hostname)) throw new Error('MARKET_URL_IP_LITERAL_FORBIDDEN')
  if (isUnsafeHostname(url.hostname)) throw new Error('MARKET_URL_PRIVATE_HOST')
  return url
}

async function boundedText(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > MAX_BODY_BYTES) throw new Error('MARKET_PAGE_TOO_LARGE')
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('MARKET_PAGE_TOO_LARGE')
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(merged)
}

function htmlToVisibleText(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch?.[1]
    ? sanitizeExternalText(titleMatch[1].replace(/<[^>]+>/g, ' '), 300)
    : null
  const withoutUnsafe = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  const text = withoutUnsafe
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>|<\/li\s*>|<\/h[1-6]\s*>|<\/div\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
  return { title, text: sanitizeExternalText(text, 12_000) }
}

export type PublicMarketPage = {
  requestedUrl: string
  finalUrl: string
  status: number
  title: string | null
  visibleText: string
  contentHash: string
  contentType: string
}

export async function fetchPublicMarketPage(rawUrl: string, fetchImpl: typeof fetch = fetch, dnsFetchImpl: typeof fetch = fetch): Promise<PublicMarketPage> {
  let current = validatePublicResearchUrl(rawUrl)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await assertPublicDnsResolution(current.hostname, dnsFetchImpl)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
      const res = await fetchImpl(current.toString(), {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { 'user-agent': 'KVRN-Market-Research/1.0', accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' },
      })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) throw new Error('MARKET_REDIRECT_NO_LOCATION')
        current = validatePublicResearchUrl(new URL(location, current).toString())
        continue
      }
      if (!res.ok) throw new Error(`MARKET_HTTP_${res.status}`)
      const contentType = (res.headers.get('content-type') || '').toLowerCase()
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml') && !contentType.includes('text/plain')) {
        throw new Error('MARKET_CONTENT_TYPE_UNSUPPORTED')
      }
      const body = await boundedText(res)
      const parsed = contentType.includes('text/plain')
        ? { title:null, text:sanitizeExternalText(body, 12_000) }
        : htmlToVisibleText(body)
      if (parsed.text.length < 80) throw new Error('MARKET_PAGE_INSUFFICIENT_TEXT')
      return {
        requestedUrl: rawUrl,
        finalUrl: current.toString(),
        status: res.status,
        title: parsed.title,
        visibleText: parsed.text,
        contentHash: createHash('sha256').update(parsed.text).digest('hex'),
        contentType,
      }
    } finally { clearTimeout(timer) }
  }
  throw new Error('MARKET_TOO_MANY_REDIRECTS')
}
