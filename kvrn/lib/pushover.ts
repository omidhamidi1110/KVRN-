// lib/pushover.ts — fail-open owner push notifications via Pushover.
//
// This is deliberately isolated from business transactions. A notification failure
// must never roll back or fail checkout, refunds, disputes, inventory, or admin work.
// Secrets are runtime-only Cloudflare Worker secrets:
//   PUSHOVER_USER_KEY
//   PUSHOVER_API_TOKEN

export type PushoverPriority = -1 | 0 | 1

export type PushoverNotification = {
  title: string
  message: string
  priority?: PushoverPriority
  url?: string | null
  urlTitle?: string | null
}

export type PushoverOutcome =
  | { outcome: 'sent' }
  | { outcome: 'skipped'; reason: 'not_configured' }
  | { outcome: 'failed'; reason: string }

const ENDPOINT = 'https://api.pushover.net/1/messages.json'
const TITLE_MAX = 250
const MESSAGE_MAX = 1024
const URL_MAX = 512
const DEFAULT_TIMEOUT_MS = 2000

function clamp(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, Math.max(0, max - 1)) + '…'
}

export function isPushoverConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.PUSHOVER_USER_KEY?.trim() && env.PUSHOVER_API_TOKEN?.trim())
}

export async function sendPushoverNotification(
  notification: PushoverNotification,
  opts: {
    env?: NodeJS.ProcessEnv
    fetchImpl?: typeof fetch
    timeoutMs?: number
  } = {},
): Promise<PushoverOutcome> {
  const env = opts.env ?? process.env
  const user = env.PUSHOVER_USER_KEY?.trim() ?? ''
  const token = env.PUSHOVER_API_TOKEN?.trim() ?? ''
  if (!user || !token) return { outcome: 'skipped', reason: 'not_configured' }

  const title = clamp(notification.title.trim(), TITLE_MAX)
  const message = clamp(notification.message.trim(), MESSAGE_MAX)
  if (!title || !message) return { outcome: 'failed', reason: 'invalid_message' }

  const body = new URLSearchParams({
    token,
    user,
    title,
    message,
    priority: String(notification.priority ?? 0),
  })

  if (notification.url) body.set('url', clamp(notification.url, URL_MAX))
  if (notification.urlTitle) body.set('url_title', clamp(notification.urlTitle, 100))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const res = await (opts.fetchImpl ?? fetch)(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    })

    if (!res.ok) return { outcome: 'failed', reason: `http_${res.status}` }

    const payload: any = await res.json().catch(() => null)
    if (payload?.status !== 1) return { outcome: 'failed', reason: 'provider_rejected' }
    return { outcome: 'sent' }
  } catch (err: any) {
    return {
      outcome: 'failed',
      reason: err?.name === 'AbortError' ? 'timeout' : 'network_error',
    }
  } finally {
    clearTimeout(timer)
  }
}
