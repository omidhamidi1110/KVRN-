const DEFAULT_TIMEOUT_MS = 12_000

export async function integrationFetch(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' })
  } finally {
    clearTimeout(timer)
  }
}

export function errorCode(provider: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'UNKNOWN')
  return `${provider}_${raw}`.toUpperCase().replace(/[^A-Z0-9_:-]/g, '_').slice(0, 120)
}

export function isoDateInZone(date: Date, timezone = 'America/Los_Angeles'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]))
  return `${map.year}-${map.month}-${map.day}`
}

export function dateRange(days = 7, finalizationLagDays = 0, timezone = 'America/Los_Angeles'): { startDate: string; endDate: string } {
  const end = new Date(Date.now() - finalizationLagDays * 86_400_000)
  const start = new Date(end.getTime() - Math.max(0, days - 1) * 86_400_000)
  return { startDate: isoDateInZone(start, timezone), endDate: isoDateInZone(end, timezone) }
}

const DEFAULT_MAX_JSON_BYTES = 8 * 1024 * 1024

async function boundedResponseText(res: Response, maxBytes: number, code: string): Promise<string> {
  const declared = Number(res.headers.get('content-length') || 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${code}_RESPONSE_TOO_LARGE`)
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`${code}_RESPONSE_TOO_LARGE`)
    }
    text += decoder.decode(value, { stream:true })
  }
  text += decoder.decode()
  return text
}

export async function jsonOrThrow(res: Response, provider: string, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<any> {
  const code = String(provider || 'PROVIDER').toUpperCase().replace(/[^A-Z0-9_:-]/g,'_').slice(0,80)
  if (!res.ok) throw new Error(`${code}_HTTP_${res.status}`)
  const boundedMax = Number.isFinite(maxBytes) ? Math.max(1, Math.min(16 * 1024 * 1024, Math.floor(maxBytes))) : DEFAULT_MAX_JSON_BYTES
  const text = await boundedResponseText(res, boundedMax, code)
  if (!text.trim()) return {}
  try { return JSON.parse(text) } catch { throw new Error(`${code}_INVALID_JSON`) }
}
