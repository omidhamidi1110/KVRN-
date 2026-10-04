// lib/ga-client.ts — browser side of KVRN's Google Analytics 4 integration.
//
// CONSENT IS THE GATE FOR EVERYTHING. The single source of truth is KVRN's existing cookie
// preferences (localStorage 'kvrn_cookie_prefs_v2', prefs.analytics === true), read through
// analyticsConsentGranted() — the SAME function the first-party funnel tracker uses, so Do Not
// Track and Global Privacy Control block GA exactly as they block the first-party tracker.
//
//   * Before consent: gtag.js is NOT loaded, window.gtag / window.dataLayer do NOT exist, no
//     request goes to Google, nothing is queued (so nothing can be flushed later).
//   * Consent granted: initGa() creates the dataLayer, sets Consent Mode (analytics granted, every
//     advertising signal denied), configures GA with send_page_view:false (KVRN sends page_view
//     itself, once per route — no automatic duplicate) and only then loads gtag.js.
//   * Consent withdrawn (or DNT/GPC turns on): every send re-checks consent at call time, so GA
//     activity stops immediately; disableGa() additionally sets GA's own opt-out flag, denies
//     consent, forgets the dedupe state and the captured GA ids, and removes GA's cookies.
//
// MEASUREMENT ID comes from RUNTIME configuration, never from the build. NEXT_PUBLIC_* variables are
// inlined by `next build`, and KVRN builds locally where the Cloudflare runtime variable may not
// exist — a build without it would permanently disable browser GA while the server believes GA is
// configured. So the browser asks the same-origin, no-store route GET /api/analytics/config (which
// reads the Worker's runtime variable per request and returns ONLY the validated public id), and
// it asks only AFTER effective analytics consent exists (ensureGaRuntimeId / syncGa below).
//
// PURCHASE is NOT sent from here. It is canonical and server-side (lib/ga4-server.ts, from the
// Stripe webhook), so the browser can never create a duplicate purchase.
//
// Never throws: analytics must not be able to break the storefront.

import { analyticsConsentGranted } from './funnel-client'
import { effectiveAnalyticsConsent } from './consent-effective'
import {
  normalizeMeasurementId, gaMoney, gaClientId, gaSessionId, buildGaItem, sumLineCents, safeLabel,
  isGaInternalPath, GA_CURRENCY, GA_UTM_PARAMS, GA_UTM_VALUE_RE, type GaItemInput,
} from './ga-common'

export const GA_VIEWED_KEY = 'kvrn_ga_viewed'
export const GA_SCRIPT_ID = 'kvrn-ga4-script'
export const GA_CONFIG_ENDPOINT = '/api/analytics/config'

interface GaState {
  id: string | null
  initialized: boolean
  disabled: boolean
  lastPath: string | null          // path of the last page_view sent (dedupe)
  lastLocation: string | null      // origin+path of the last page_view (next page's referrer)
  clientId: string | null
  sessionId: string | null
  runtimeId: string | null | undefined   // runtime config answer: id | null (definitively not configured) | undefined (unknown yet)
  runtimeIdInflight: Promise<string | null> | null
}
const st: GaState = {
  id: null, initialized: false, disabled: false, lastPath: null, lastLocation: null, clientId: null, sessionId: null,
  runtimeId: undefined, runtimeIdInflight: null,
}

/** Test hook: forget all module state. */
export function __resetGaStateForTests(): void {
  st.id = null; st.initialized = false; st.disabled = false; st.lastPath = null
  st.lastLocation = null; st.clientId = null; st.sessionId = null
  st.runtimeId = undefined; st.runtimeIdInflight = null
}

const w = (): any => (typeof window === 'undefined' ? null : (window as any))

/** True only when GA is loaded, enabled, consent is CURRENTLY granted, and this is a storefront route. */
export function gaActive(): boolean {
  try {
    const win = w()
    if (!win || !st.initialized || st.disabled || typeof win.gtag !== 'function') return false
    if (!analyticsConsentGranted()) { disableGa(); return false }   // revoked / DNT / GPC since init
    return !isGaInternalPath(win.location.pathname)
  } catch { return false }
}

/**
 * Load and configure GA — only if consent is granted right now. Idempotent. Returns whether GA is
 * now enabled. A malformed/absent measurement id, a declined/unknown consent state, DNT, GPC and
 * admin routes all return false without touching the DOM or the network.
 */
export function initGa(measurementId: unknown): boolean {
  try {
    const win = w()
    const id = normalizeMeasurementId(measurementId)
    if (!win || !id) return false
    if (!analyticsConsentGranted()) return false
    if (isGaInternalPath(win.location.pathname)) return false

    if (st.initialized && st.id === id) {            // already loaded: just re-enable after a withdrawal
      if (st.disabled) {
        win['ga-disable-' + id] = false
        st.disabled = false
        win.gtag('consent', 'update', { analytics_storage: 'granted' })
      }
      return true
    }

    win.dataLayer = win.dataLayer || []
    if (typeof win.gtag !== 'function') {
      // gtag.js requires the `arguments` object itself to be pushed (not an array).
      win.gtag = function gtag() { win.dataLayer.push(arguments) }
    }
    win['ga-disable-' + id] = false
    // Consent Mode: this code runs only after analytics consent, so analytics is granted;
    // KVRN never runs ads, so every advertising signal stays denied.
    win.gtag('consent', 'default', {
      analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied',
      ad_personalization: 'denied', functionality_storage: 'granted',
    })
    win.gtag('js', new Date())
    win.gtag('config', id, {
      send_page_view: false,                  // KVRN sends page_view itself, once per route
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      transport_type: 'beacon',
    })
    st.id = id; st.initialized = true; st.disabled = false

    if (!document.getElementById(GA_SCRIPT_ID)) {
      const s = document.createElement('script')
      s.id = GA_SCRIPT_ID
      s.async = true
      s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`
      document.head.appendChild(s)
    }
    return true
  } catch { return false }
}

// ── runtime measurement id + consent-driven sync ─────────────────────────────

/**
 * The validated public measurement id from RUNTIME configuration (GET /api/analytics/config).
 *   * Does NOTHING (no request) unless effective analytics consent exists right now.
 *   * Cached for the page lifetime once answered (a definitive "not configured" is cached too, so
 *     client-side navigation does not re-ask); concurrent callers share one request.
 *   * A network/HTTP/shape failure resolves null WITHOUT caching, so a later navigation can retry.
 * Never throws.
 */
export async function ensureGaRuntimeId(fetchImpl?: typeof fetch): Promise<string | null> {
  try {
    if (!analyticsConsentGranted()) return null
    if (st.runtimeId !== undefined) return st.runtimeId
    if (st.runtimeIdInflight) return await st.runtimeIdInflight
    const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
    if (!doFetch) return null
    const p = (async (): Promise<string | null> => {
      try {
        const res = await doFetch(GA_CONFIG_ENDPOINT, { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
        if (!res || !res.ok) return null
        const body = (await res.json()) as { measurementId?: unknown } | null
        if (!body || typeof body !== 'object') return null
        const id = normalizeMeasurementId(body.measurementId)
        st.runtimeId = id               // null here = the server definitively says GA is not configured
        return id
      } catch { return null }
    })()
    st.runtimeIdInflight = p
    try { return await p } finally { st.runtimeIdInflight = null }
  } catch { return null }
}

/**
 * Bring GA to "ready" for a visitor who has ALREADY given effective consent: fetch the runtime id,
 * initialise GA (idempotent) and send the route's page_view (deduped per path — a no-op if it was
 * already sent). Resolves true only if GA is active when it finishes.
 *   * Consent is verified first and RE-VERIFIED after every async wait (the runtime-config request),
 *     so consent withdrawn / DNT / GPC arriving mid-flight leaves GA uninitialised (or shuts it down).
 *   * Shares the in-flight config request with syncGa and with every other caller.
 *   * Never queues anything and never touches the data layer before consent. Never throws.
 */
export async function ensureGaReady(fetchImpl?: typeof fetch): Promise<boolean> {
  try {
    if (!analyticsConsentGranted()) return false
    const id = await ensureGaRuntimeId(fetchImpl)
    if (!id) return false
    if (!analyticsConsentGranted()) { disableGa(); return false }
    if (!initGa(id)) return false
    gaPageView()                       // the route's page_view always precedes its first ecommerce event
    return gaActive()
  } catch { return false }
}

/**
 * Run `fn` (a GA send such as gaViewItem / gaAddToCart) as soon as GA is ready — for events that
 * happen right AFTER consent, during the short window in which GA is still fetching its runtime
 * config and initialising (e.g. a visitor accepts analytics while staying on a product page).
 *
 *   * No effective consent (never chosen, declined, expired, DNT, GPC): returns at once — no config
 *     request, no queue, no storage; `fn` is dropped, exactly as before.
 *   * GA already active: the route's page_view is made sure of (deduped) and `fn` runs synchronously.
 *   * Otherwise: `fn` runs once ensureGaReady() resolves true. It is NOT held anywhere in the
 *     meantime (no dataLayer entry, no storage): it is a closure alive only inside this one pending
 *     promise, discarded if consent is gone when the wait ends. `fn` re-checks consent itself at
 *     call time as every GA send does, so nothing can be emitted after a withdrawal.
 * Duplicate protection stays where it already lives: gaViewItem's once-per-product-per-tab dedupe
 * (written at send time) and gaPageView's per-path dedupe. Fire-and-forget; never throws; never delays
 * the caller — and NOTHING on the checkout / purchase path uses it.
 */
export function runWhenGaReady(fn: () => void, fetchImpl?: typeof fetch): void {
  try {
    if (!analyticsConsentGranted()) return
    if (gaActive()) { gaPageView(); fn(); return }
    void ensureGaReady(fetchImpl)
      .then(ready => { if (ready && analyticsConsentGranted()) fn() })
      .catch(() => { /* ignore */ })
  } catch { /* ignore */ }
}

/**
 * The single decision point GaTracker runs on every consent / route change. `prefAnalytics` is the
 * stored preference (null = preferences not read yet).
 *   * not read yet            -> nothing.
 *   * declined, OR the preference is "yes" but EFFECTIVE consent is false (DNT / GPC / expired)
 *                             -> disableGa() immediately: an already-running GA is shut down now,
 *                                not on some later send.
 *   * effective consent       -> ensureGaReady(): fetch the runtime id, re-check consent, initGa
 *                                (idempotent), then one page_view (deduped per path).
 * Never throws.
 */
export async function syncGa(prefAnalytics: boolean | null | undefined, fetchImpl?: typeof fetch): Promise<void> {
  try {
    if (prefAnalytics === null || prefAnalytics === undefined) return
    if (!effectiveAnalyticsConsent(prefAnalytics) || !analyticsConsentGranted()) { disableGa(); return }
    await ensureGaReady(fetchImpl)
  } catch { /* ignore */ }
}

function expireGaCookies(): void {
  try {
    const host = window.location.hostname
    const parts = host.split('.')
    const domains = ['']
    for (let i = 0; i < parts.length - 1; i++) domains.push('; domain=' + (i === 0 ? '' : '.') + parts.slice(i).join('.'))
    for (const raw of document.cookie.split(';')) {
      const name = raw.split('=')[0].trim()
      if (name !== '_ga' && !name.startsWith('_ga_')) continue
      for (const d of domains) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d}`
    }
  } catch { /* ignore */ }
}

/** Stop all GA activity now (consent withdrawn). Safe to call at any time, including before init. */
export function disableGa(): void {
  try {
    const win = w()
    if (!win) return
    try { win.sessionStorage.removeItem(GA_VIEWED_KEY) } catch { /* ignore */ }
    if (!st.initialized) return
    st.disabled = true
    st.clientId = null; st.sessionId = null
    st.lastPath = null; st.lastLocation = null
    if (st.id) win['ga-disable-' + st.id] = true          // GA's own documented opt-out switch
    try {
      win.gtag?.('consent', 'update', {
        analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
      })
    } catch { /* ignore */ }
    expireGaCookies()
  } catch { /* ignore */ }
}

function send(name: string, params: Record<string, unknown>): void {
  try {
    if (!gaActive()) return
    w().gtag('event', name, params)
  } catch { /* ignore */ }
}

// ── page_view ────────────────────────────────────────────────────────────────

/** origin + path, plus ONLY utm_source / utm_medium / utm_campaign when they are safe plain tokens. */
export function gaPageLocation(): string {
  const loc = window.location
  const q = new URLSearchParams(loc.search)
  const keep = new URLSearchParams()
  for (const k of GA_UTM_PARAMS) {
    const v = q.get(k)
    if (v && GA_UTM_VALUE_RE.test(v)) keep.set(k, v)
  }
  const qs = keep.toString()
  return `${loc.origin}${loc.pathname}${qs ? '?' + qs : ''}`
}

function externalReferrer(): string | null {
  try {
    if (!document.referrer) return null
    const u = new URL(document.referrer)
    // Origin only for another site (enough for GA to classify the source; a referrer query string
    // can carry anything). A same-site referrer keeps its path, never its query.
    return u.origin === window.location.origin ? `${u.origin}${u.pathname}` : `${u.origin}/`
  } catch { return null }
}

/**
 * One page_view per route. send_page_view is off in the GA config, so this is the only page_view.
 * Calling it again for the same path (re-render, strict-mode double effect) is a no-op.
 */
export function gaPageView(): void {
  try {
    if (!gaActive()) return
    const path = window.location.pathname
    if (st.lastPath === path) return
    const location = gaPageLocation()
    const referrer = st.lastLocation ?? externalReferrer()
    send('page_view', { page_location: location, ...(referrer ? { page_referrer: referrer } : {}) })
    st.lastPath = path
    st.lastLocation = `${window.location.origin}${path}`
    captureGaIds()
  } catch { /* ignore */ }
}

// ── ecommerce ────────────────────────────────────────────────────────────────

/** view_item: once per product per browsing session (tab), like the first-party product_viewed. */
export function gaViewItem(i: Omit<GaItemInput, 'quantity'>): void {
  try {
    if (!gaActive()) return
    const item = buildGaItem({ ...i, quantity: 1 })
    if (!item) return
    const seen: string[] = JSON.parse(window.sessionStorage.getItem(GA_VIEWED_KEY) ?? '[]')
    if (seen.includes(item.item_id)) return
    window.sessionStorage.setItem(GA_VIEWED_KEY, JSON.stringify([...seen, item.item_id].slice(-50)))
    const value = gaMoney(i.priceCents)
    send('view_item', { currency: GA_CURRENCY, ...(value !== null ? { value } : {}), items: [item] })
  } catch { /* ignore */ }
}

/**
 * add_to_cart. `quantity` MUST be the quantity the cart actually gained (see computeAddedQuantity in
 * lib/cart-reducer.ts) — the caller only invokes this when that delta is > 0.
 */
export function gaAddToCart(i: GaItemInput): void {
  try {
    if (!gaActive()) return
    const item = buildGaItem(i)
    if (!item) return
    const value = gaMoney(sumLineCents([{ priceCents: i.priceCents, quantity: i.quantity }]))
    send('add_to_cart', { currency: GA_CURRENCY, ...(value !== null ? { value } : {}), items: [item] })
  } catch { /* ignore */ }
}

/**
 * begin_checkout. Call ONLY after the server accepted the checkout and returned a Stripe URL — the
 * same moment the first-party checkout_started is recorded server-side — never on a click.
 * No coupon code is sent.
 */
export function gaBeginCheckout(lines: GaItemInput[]): void {
  try {
    if (!gaActive()) return
    const items = lines.map(buildGaItem).filter((x): x is NonNullable<typeof x> => x !== null)
    if (!items.length) return
    const cents = sumLineCents(lines.map(l => ({ priceCents: l.priceCents, quantity: l.quantity })))
    const value = gaMoney(cents)
    send('begin_checkout', { currency: GA_CURRENCY, ...(value !== null ? { value } : {}), items })
  } catch { /* ignore */ }
}

/** Gated generic event for KVRN's own non-ecommerce events (SMS popup etc.). Scalar params only. */
export function gaEvent(name: string, params: Record<string, string | number | boolean> = {}): void {
  try {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) return
    const clean: Record<string, string | number | boolean> = {}
    for (const [k, v] of Object.entries(params)) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) continue
      if (typeof v === 'string') { const s = safeLabel(v, 100); if (s) clean[k] = s }
      else if (typeof v === 'number' ? Number.isFinite(v) : typeof v === 'boolean') clean[k] = v
    }
    send(name, clean)
  } catch { /* ignore */ }
}

// ── post-consent readiness variants (non-navigating events only) ─────────────
// Same payloads and dedupe as the plain functions above; they only add "wait for GA to finish
// initialising if consent was JUST granted" (runWhenGaReady). begin_checkout is deliberately NOT
// here: checkout never waits for GA.

/** view_item that survives the post-consent init window; still exactly once per product per tab. */
export function gaViewItemWhenReady(i: Omit<GaItemInput, 'quantity'>, fetchImpl?: typeof fetch): void {
  runWhenGaReady(() => gaViewItem(i), fetchImpl)
}
/** add_to_cart (actual delta quantity) that is not lost when it happens right after consent. */
export function gaAddToCartWhenReady(i: GaItemInput, fetchImpl?: typeof fetch): void {
  runWhenGaReady(() => gaAddToCart(i), fetchImpl)
}
/** Generic KVRN event (SMS popup, size guide, ...) that is not lost right after consent. */
export function gaEventWhenReady(name: string, params: Record<string, string | number | boolean> = {}, fetchImpl?: typeof fetch): void {
  runWhenGaReady(() => gaEvent(name, params), fetchImpl)
}

// ── GA identifiers for the server-side purchase ──────────────────────────────

/** Ask GA for its client/session ids (callbacks arrive once gtag.js has loaded). */
function captureGaIds(): void {
  try {
    const win = w()
    if (!win || !st.id || typeof win.gtag !== 'function') return
    win.gtag('get', st.id, 'client_id',  (v: unknown) => { if (!st.disabled) st.clientId  = gaClientId(String(v ?? '')) })
    win.gtag('get', st.id, 'session_id', (v: unknown) => { if (!st.disabled) st.sessionId = gaSessionId(String(v ?? '')) })
  } catch { /* ignore */ }
}

/**
 * GA's pseudonymous client/session ids, ONLY while GA is active (consent given). They are sent with
 * the checkout request so the server-side purchase attaches to the visitor's GA session. Synchronous
 * (cached after init) so it can never delay checkout. null/undefined when GA is off or not ready —
 * then the server sends no GA purchase for that order.
 */
export function getGaIdentifiers(): { clientId: string; sessionId: string | null } | null {
  try {
    if (!gaActive() || !st.clientId) return null
    return { clientId: st.clientId, sessionId: st.sessionId }
  } catch { return null }
}
