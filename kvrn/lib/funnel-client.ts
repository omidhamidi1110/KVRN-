// lib/funnel-client.ts — browser side of the first-party funnel analytics.
//
// CONSENT IS ENFORCED HERE, AT THE SOURCE. Nothing is stored and nothing is sent unless the
// visitor has actively accepted analytics in KVRN's existing cookie preferences
// (localStorage 'kvrn_cookie_prefs_v2', prefs.analytics === true — the same flag that gates
// Google Analytics). No choice yet, "deny", Do Not Track and Global Privacy Control all mean
// NO tracking: no sessionStorage id, no request.
//
// The session id is a random UUID in sessionStorage: it lives for one browsing session
// (the tab), is not a cookie, is not shared across sites or tabs-after-close, and encodes
// nothing about the person. No fingerprinting, no IP, no persistent identifier.
//
// Never throws, never awaits in a user flow: analytics must not be able to break the UI.

import { STORAGE_KEY as PREFS_KEY, COOKIE_PREFS_EXPIRY_MS } from '@/context/CookiePrefsContext'
import { browserOptOutActive, effectiveAnalyticsConsent } from './consent-effective'

export const FUNNEL_SID_KEY     = 'kvrn_fa_sid'
export const FUNNEL_STARTED_KEY = 'kvrn_fa_started'
export const FUNNEL_VIEWED_KEY  = 'kvrn_fa_viewed'
export const FUNNEL_ENDPOINT    = '/api/analytics/event'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** True only when analytics consent is currently granted and the browser has not opted out. */
export function analyticsConsentGranted(): boolean {
  try {
    if (typeof window === 'undefined') return false
    if (browserOptOutActive(window.navigator)) return false   // DNT / GPC (shared rule: lib/consent-effective)
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return false
    const { prefs, ts } = JSON.parse(raw) as { prefs?: { analytics?: boolean }; ts?: number }
    if (typeof ts !== 'number' || Date.now() - ts > COOKIE_PREFS_EXPIRY_MS) return false
    return effectiveAnalyticsConsent(prefs?.analytics, window.navigator)
  } catch { return false }
}

function randomUuidV4(): string {
  const c = (globalThis as any).crypto
  if (c?.randomUUID) return c.randomUUID()
  const b = new Uint8Array(16); c.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** The session id, created on first use — but only with consent. Otherwise null (and nothing stored). */
export function getFunnelSessionIdIfConsented(): string | null {
  try {
    if (!analyticsConsentGranted()) return null
    let sid = window.sessionStorage.getItem(FUNNEL_SID_KEY)
    if (!sid || !UUID_V4.test(sid)) {
      sid = randomUuidV4()
      window.sessionStorage.setItem(FUNNEL_SID_KEY, sid)
    }
    return sid
  } catch { return null }
}

/** Existing consent-covered session only; presence never initializes a new session. */
export function getExistingFunnelSessionIdIfConsented(): string | null {
  try {
    if (!analyticsConsentGranted()) return null
    const sid = window.sessionStorage.getItem(FUNNEL_SID_KEY)
    return sid && UUID_V4.test(sid) ? sid : null
  } catch { return null }
}

/** Forget the session (consent withdrawn). */
export function clearFunnelSession(): void {
  try {
    window.sessionStorage.removeItem(FUNNEL_SID_KEY)
    window.sessionStorage.removeItem(FUNNEL_STARTED_KEY)
    window.sessionStorage.removeItem(FUNNEL_VIEWED_KEY)
  } catch { /* ignore */ }
}

/** Fire-and-forget. A failure is invisible to the shopper. */
function send(payload: Record<string, unknown>): void {
  try {
    void fetch(FUNNEL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => {})
  } catch { /* ignore */ }
}

const isInternal = (path: string) => /^\/(admin|api|_next)(\/|$)|^\/store-credit\/verify\/?$/i.test(path)

export interface EntryContext {
  landing: string | null
  referrer: string | null
  utm: Record<string, string> | null
  device: 'mobile' | 'desktop' | 'tablet' | null
}

/** Read how this visit began (path without query, referrer, UTM, coarse device class). In memory only. */
export function captureEntryContext(): EntryContext {
  try {
    const params = new URLSearchParams(window.location.search)
    const utm: Record<string, string> = {}
    for (const k of ['source', 'medium', 'campaign']) {
      const v = params.get('utm_' + k)
      if (v) utm[k] = v.slice(0, 100)
    }
    const w = window.innerWidth
    return {
      landing: window.location.pathname,
      referrer: document.referrer || null,
      utm: Object.keys(utm).length ? utm : null,
      device: w < 768 ? 'mobile' : w < 1100 ? 'tablet' : 'desktop',
    }
  } catch { return { landing: null, referrer: null, utm: null, device: null } }
}

/** Stage 1. At most once per browsing session. */
export function trackSessionStart(entry: EntryContext): void {
  try {
    if (!entry.landing || isInternal(entry.landing)) return
    const sid = getFunnelSessionIdIfConsented()
    if (!sid) return
    if (window.sessionStorage.getItem(FUNNEL_STARTED_KEY) === sid) return
    window.sessionStorage.setItem(FUNNEL_STARTED_KEY, sid)
    send({ event: 'session_start', sid, landing: entry.landing, referrer: entry.referrer,
           utm: entry.utm, device: entry.device })
  } catch { /* ignore */ }
}

/** Stage 2. Once per product per session (the server also dedupes). */
export function trackProductView(slug: string, sku?: string | null): void {
  try {
    if (!slug || isInternal(window.location.pathname)) return
    const sid = getFunnelSessionIdIfConsented()
    if (!sid) return
    const seen: string[] = JSON.parse(window.sessionStorage.getItem(FUNNEL_VIEWED_KEY) ?? '[]')
    if (seen.includes(slug)) return
    window.sessionStorage.setItem(FUNNEL_VIEWED_KEY, JSON.stringify([...seen, slug].slice(-50)))
    send({ event: 'product_viewed', sid, slug, ...(sku ? { sku } : {}) })
  } catch { /* ignore */ }
}

/** Stage 3. Call only AFTER the item was actually added. Each add gets its own event id. */
export function trackAddToCartEvent(a: { slug: string; sku?: string | null; quantity: number }): void {
  try {
    if (!a.slug || !Number.isInteger(a.quantity) || a.quantity < 1 || a.quantity > 99) return
    if (isInternal(window.location.pathname)) return
    const sid = getFunnelSessionIdIfConsented()
    if (!sid) return
    send({ event: 'add_to_cart', sid, eid: randomUuidV4(), slug: a.slug,
           ...(a.sku ? { sku: a.sku } : {}), qty: a.quantity })
  } catch { /* ignore */ }
}
