// lib/__tests__/funnel-analytics.test.ts
//
// First-party funnel analytics: validation, consent, idempotency, aggregation, admin auth.
//
// Pure and source blocks always run. Real-PostgreSQL blocks run only with a LOCAL
// TEST_DATABASE_URL (helpers/fi-pg.ts) and drive the REAL route handlers and SQL.
// The money-path integration (real checkout handler + real webhook) is in
// funnel-analytics-money-path.test.ts.

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import {
  validateClientEvent, funnelEventId, eventKeys, computeFunnelRates, ratePct, parseFunnelRange,
  funnelWindow, isLikelyBot, cleanLandingPath, isInternalPath, createFunnelService,
  FUNNEL_EVENTS, CLIENT_EVENTS, MAX_EVENTS_PER_SESSION, type FunnelStages,
} from '../funnel-analytics'
import { HAVE_DB, TEST_DB_URL, createFiDb, seedCatalog, mkOrder, oid, P, V, type FiDb } from './helpers/fi-pg'

jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => {
    if ((global as any).__FA_DENY) {
      return { identity: null, error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
    }
    return { identity: { email: 'funnel@test.local' }, error: null }
  },
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__FA_SQL } }))
// funnel-client reads the SAME localStorage key as the cookie context; the context is a React module,
// so its two constants are substituted here and pinned to the real file by a source test below.
jest.mock('@/context/CookiePrefsContext', () => ({
  STORAGE_KEY: 'kvrn_cookie_prefs_v2', COOKIE_PREFS_EXPIRY_MS: 365 * 24 * 60 * 60 * 1000,
}))

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const sid = () => randomUUID()

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL
    ? 'NOTE: funnel DB tests skipped — TEST_DATABASE_URL is not a local server.'
    : 'NOTE: funnel real-PostgreSQL tests skipped — TEST_DATABASE_URL absent.', () => {
    expect(true).toBe(true)
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// EVENT VALIDATION / ALLOWLIST
// ═════════════════════════════════════════════════════════════════════════════
describe('event allowlist', () => {
  test('exactly five funnel stages; the browser may submit only the first three', () => {
    expect([...FUNNEL_EVENTS]).toEqual(['session_start', 'product_viewed', 'add_to_cart', 'checkout_started', 'purchase_completed'])
    expect([...CLIENT_EVENTS]).toEqual(['session_start', 'product_viewed', 'add_to_cart'])
  })
  test.each(['checkout_started', 'purchase_completed', 'pageview', 'size_selected', 'cart_viewed', '', 'ADD_TO_CART', 'add_to_cart '])(
    'event name %p is refused from the browser', ev => {
      expect(validateClientEvent({ event: ev, sid: sid(), slug: 'f21', eid: sid(), qty: 1 }).ok).toBe(false)
    })
  test.each([null, undefined, 'x', 7, [], [1]])('non-object body %p is refused', b => {
    expect(validateClientEvent(b).ok).toBe(false)
  })
  test('missing or malformed session ids are refused', () => {
    for (const bad of [undefined, null, '', 'abc', '12345678-1234-1234-1234-123456789012', sid() + 'x', 5]) {
      expect(validateClientEvent({ event: 'product_viewed', sid: bad, slug: 'f21' }).ok).toBe(false)
    }
  })
})

describe('strict shape: no arbitrary fields, no PII, no money from the browser', () => {
  const good: Record<string, any> = {
    session_start: { event: 'session_start', sid: sid(), landing: '/', referrer: 'https://instagram.com/', utm: { source: 'ig' }, device: 'mobile' },
    product_viewed: { event: 'product_viewed', sid: sid(), slug: 'f21', sku: 'F21-M' },
    add_to_cart: { event: 'add_to_cart', sid: sid(), eid: sid(), slug: 'f21', sku: 'F21-M', qty: 2 },
  }
  test('the baseline payloads are valid', () => {
    for (const k of Object.keys(good)) expect(validateClientEvent(good[k]).ok).toBe(true)
  })
  const forbidden = ['email', 'name', 'firstName', 'lastName', 'phone', 'address', 'line1', 'postalCode', 'ip',
                     'userAgent', 'card', 'token', 'customerId', 'fingerprint', 'priceCents', 'valueCents',
                     'totalCents', 'orderId', 'reservationId', 'productId', 'variantId', 'meta', 'query', 'search']
  for (const ev of Object.keys(good)) {
    test.each(forbidden)(`${ev}: unknown field %s makes the event invalid`, f => {
      expect(validateClientEvent({ ...good[ev], [f]: 'x' }).ok).toBe(false)
    })
  }
  test('nothing the validator returns can carry a field outside the allowlist', () => {
    const v = validateClientEvent({ ...good.add_to_cart }) as any
    expect(Object.keys(v.value).sort()).toEqual(['eid', 'event', 'qty', 'sid', 'sku', 'slug'])
    const s = validateClientEvent({ ...good.session_start }) as any
    expect(Object.keys(s.value).sort()).toEqual(['device', 'event', 'landing', 'referrer', 'sid', 'utm'])
  })
  test.each([0, -1, 100, 1.5, '1', NaN, null, undefined])('add_to_cart quantity %p is refused', q => {
    expect(validateClientEvent({ ...good.add_to_cart, qty: q }).ok).toBe(false)
  })
  test('add_to_cart needs its own event id', () => {
    expect(validateClientEvent({ ...good.add_to_cart, eid: undefined }).ok).toBe(false)
    expect(validateClientEvent({ ...good.add_to_cart, eid: 'nope' }).ok).toBe(false)
  })
  test.each(['', 'F21', 'a b', 'a/b', "x'--", '<script>', 'a'.repeat(101), 'a@b.com', 5])('slug %p is refused', s => {
    expect(validateClientEvent({ ...good.product_viewed, slug: s }).ok).toBe(false)
  })
  test.each(['', "x'--", 'a b', 'a@b.com', 'x'.repeat(65), 5])('sku %p is refused', s => {
    expect(validateClientEvent({ ...good.product_viewed, sku: s }).ok).toBe(false)
  })
})

describe('session_start: first-touch fields are privacy-safe', () => {
  const base = { event: 'session_start', sid: sid() }
  const ok = (extra: object) => { const v = validateClientEvent({ ...base, ...extra }); expect(v.ok).toBe(true); return (v as any).value }
  test('the landing page loses its query string and fragment', () => {
    expect(ok({ landing: '/products/f21?email=a@b.com&token=abc#frag' }).landing).toBe('/products/f21')
    expect(cleanLandingPath('/shop?utm_source=x')).toBe('/shop')
  })
  test.each(['https://evil.test/', '//evil.test', 'javascript:alert(1)', '/a b', '/a\\b', 'relative', ''])(
    'landing %p is not stored', l => { expect(ok({ landing: l }).landing).toBeNull() })
  test.each(['/admin', '/admin/financials', '/api/checkout/session', '/_next/static/x'])(
    'internal path %s is not storefront traffic', l => {
      expect(isInternalPath(l)).toBe(true)
      expect(validateClientEvent({ ...base, landing: l }).ok).toBe(false)
    })
  test('the referrer is reduced to its origin', () => {
    expect(ok({ referrer: 'https://www.google.com/search?q=my+secret&x=a@b.com#z' }).referrer).toBe('https://www.google.com')
    expect(ok({ referrer: 'https://user:pass@l.instagram.com/p/abc?e=a@b.com' }).referrer).toBe('https://l.instagram.com')
    expect(ok({ referrer: 'not a url' }).referrer).toBeNull()
    expect(ok({ referrer: 'javascript:alert(1)' }).referrer).toBeNull()
  })
  test('UTM values are kept only when they are short plain tokens; an email-like value is dropped', () => {
    expect(ok({ utm: { source: 'instagram', medium: 'social', campaign: 'fall_drop-1' } }).utm)
      .toEqual({ source: 'instagram', medium: 'social', campaign: 'fall_drop-1' })
    expect(ok({ utm: { source: 'a@b.com', medium: 'email' } }).utm).toEqual({ medium: 'email' })
    expect(ok({ utm: { source: '<x>' } }).utm).toBeNull()
    expect(ok({ utm: { source: 'x'.repeat(101) } }).utm).toBeNull()
  })
  test('only utm source / medium / campaign are accepted: content and term are refused, never stored', () => {
    for (const k of ['content', 'term', 'id', 'utm_content', 'utm_term', 'source_platform']) {
      expect(validateClientEvent({ ...base, utm: { source: 'x', [k]: 'y' } }).ok).toBe(false)
    }
    expect(ok({ utm: { source: 's', medium: 'm', campaign: 'c' } }).utm).toEqual({ source: 's', medium: 'm', campaign: 'c' })
  })
  test('unknown UTM keys and non-string values are refused', () => {
    expect(validateClientEvent({ ...base, utm: { source: 'x', email: 'a@b.com' } }).ok).toBe(false)
    expect(validateClientEvent({ ...base, utm: { source: { a: 1 } } }).ok).toBe(false)
    expect(validateClientEvent({ ...base, utm: ['x'] }).ok).toBe(false)
  })
  test('device is a coarse enum', () => {
    expect(ok({ device: 'tablet' }).device).toBe('tablet')
    expect(validateClientEvent({ ...base, device: 'iPhone 15 Pro Max iOS 18.1' }).ok).toBe(false)
  })
})

describe('bots are not counted', () => {
  test.each(['Googlebot/2.1', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'HeadlessChrome/120', 'curl/8.0', 'python-requests/2.31', 'Lighthouse', ''])(
    '%p', ua => expect(isLikelyBot(ua)).toBe(true))
  test('a normal browser is not a bot', () => {
    expect(isLikelyBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1')).toBe(false)
  })
  test('a missing user agent is treated as automation', () => { expect(isLikelyBot(null)).toBe(true) })
})

// ═════════════════════════════════════════════════════════════════════════════
// DETERMINISTIC IDS (the idempotency primitive)
// ═════════════════════════════════════════════════════════════════════════════
describe('deterministic event ids', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  test('same key -> same uuid-shaped id; different key -> different id', () => {
    const a = funnelEventId(eventKeys.purchase('order-1'))
    expect(a).toMatch(UUID)
    expect(funnelEventId(eventKeys.purchase('order-1'))).toBe(a)
    expect(funnelEventId(eventKeys.purchase('order-2'))).not.toBe(a)
  })
  test('every stage has its own namespace, so keys never collide across event types', () => {
    const ids = new Set([
      eventKeys.sessionStart('x'), eventKeys.productViewed('x', 'x'), eventKeys.addToCart('x', 'x'),
      eventKeys.checkoutStarted('x'), eventKeys.purchase('x'),
    ].map(funnelEventId))
    expect(ids.size).toBe(5)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// FUNNEL MATH
// ═════════════════════════════════════════════════════════════════════════════
describe('funnel aggregation math', () => {
  test('rates are percentages of the previous stage, to two decimals', () => {
    const s: FunnelStages = { visits: 1000, reachedProduct: 600, reachedCart: 90, reachedCheckout: 45, purchased: 18 }
    expect(computeFunnelRates(s)).toEqual({
      visitToProduct: 60, productToCart: 15, cartToCheckout: 50, checkoutToPurchase: 40, visitToPurchase: 1.8,
    })
  })
  test('rounding is to two decimals', () => {
    expect(ratePct(1, 3)).toBe(33.33)
    expect(ratePct(2, 3)).toBe(66.67)
  })
  test('an empty denominator is UNKNOWN (null), never 0%', () => {
    const none = computeFunnelRates({ visits: 0, reachedProduct: 0, reachedCart: 0, reachedCheckout: 0, purchased: 0 })
    expect(Object.values(none).every(v => v === null)).toBe(true)
    const noCart = computeFunnelRates({ visits: 10, reachedProduct: 5, reachedCart: 0, reachedCheckout: 0, purchased: 0 })
    expect(noCart.productToCart).toBe(0)           // 5 reached a product, none added: a real 0%
    expect(noCart.cartToCheckout).toBeNull()       // nobody to divide by: unknown
    expect(noCart.checkoutToPurchase).toBeNull()
  })
  test('non-finite inputs never produce a number', () => {
    expect(ratePct(NaN, 5)).toBeNull()
    expect(ratePct(5, Infinity)).toBeNull()
    expect(ratePct(-1, 0)).toBeNull()
  })
  test('ranges: 7d / 30d / 90d, default 30d, anything else refused', () => {
    expect(parseFunnelRange(null)).toBe('30d')
    expect(parseFunnelRange('')).toBe('30d')
    for (const r of ['7d', '30d', '90d']) expect(parseFunnelRange(r)).toBe(r)
    for (const r of ['1d', '365d', 'ytd', '30', '30D', '30d;drop']) expect(parseFunnelRange(r)).toBeNull()
  })
  test('the window is a half-open rolling span ending now', () => {
    const now = new Date('2026-10-03T12:00:00Z')
    expect(funnelWindow('7d', now)).toEqual({ start: '2026-09-26T12:00:00.000Z', end: '2026-10-03T12:00:00.000Z' })
    expect(funnelWindow('90d', now).start).toBe('2026-07-05T12:00:00.000Z')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// CONSENT (browser side)
// ═════════════════════════════════════════════════════════════════════════════
describe('client tracker obeys the existing analytics consent', () => {
  const KEY = 'kvrn_cookie_prefs_v2'
  let local: Record<string, string>, session: Record<string, string>, sent: any[]
  const store = (m: Record<string, string>) => ({
    getItem: (k: string) => (k in m ? m[k] : null), setItem: (k: string, v: string) => { m[k] = v },
    removeItem: (k: string) => { delete m[k] },
  })
  const setPrefs = (analytics: boolean, ts = Date.now()) =>
    { local[KEY] = JSON.stringify({ prefs: { essential: true, analytics }, ts }) }
  const env = (over: { dnt?: string | null; gpc?: boolean; path?: string; search?: string } = {}) => {
    local = local ?? {}; session = session ?? {}
    ;(global as any).window = {
      localStorage: store(local), sessionStorage: store(session),
      navigator: { doNotTrack: over.dnt ?? null, globalPrivacyControl: over.gpc },
      location: { pathname: over.path ?? '/products/f21', search: over.search ?? '' }, innerWidth: 1280,
    }
    ;(global as any).document = { referrer: '' }
  }
  let fc: typeof import('../funnel-client')
  beforeAll(async () => { fc = await import('../funnel-client') })
  beforeEach(() => {
    local = {}; session = {}; sent = []
    env()
    ;(global as any).fetch = jest.fn(async (_u: string, init: any) => { sent.push({ url: _u, body: JSON.parse(init.body) }); return {} })
  })
  afterEach(() => { delete (global as any).window; delete (global as any).document })

  const fireAll = () => {
    fc.trackSessionStart({ landing: '/', referrer: null, utm: null, device: 'desktop' })
    fc.trackProductView('f21')
    fc.trackAddToCartEvent({ slug: 'f21', sku: 'F21-M', quantity: 1 })
  }

  test('no choice yet: nothing stored, nothing sent', () => {
    fireAll()
    expect(fc.getFunnelSessionIdIfConsented()).toBeNull()
    expect(sent).toEqual([]); expect(session).toEqual({})
  })
  test('analytics declined: nothing stored, nothing sent', () => {
    setPrefs(false); fireAll()
    expect(sent).toEqual([]); expect(session).toEqual({})
  })
  test('expired consent counts as no consent', () => {
    setPrefs(true, Date.now() - 366 * 86_400_000); fireAll()
    expect(sent).toEqual([])
  })
  test('malformed stored preferences count as no consent', () => {
    local[KEY] = '{not json'; fireAll(); expect(sent).toEqual([])
    local[KEY] = JSON.stringify({ prefs: { analytics: 'true' }, ts: Date.now() }); fireAll(); expect(sent).toEqual([])
  })
  test('Do Not Track and Global Privacy Control override consent', () => {
    setPrefs(true); env({ dnt: '1' }); fireAll(); expect(sent).toEqual([])
    env({ gpc: true }); fireAll(); expect(sent).toEqual([])
  })
  test('with consent: one random UUID per browsing session, held in sessionStorage only', () => {
    setPrefs(true)
    const a = fc.getFunnelSessionIdIfConsented()!
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(fc.getFunnelSessionIdIfConsented()).toBe(a)
    expect(Object.keys(session)).toEqual([fc.FUNNEL_SID_KEY])
    expect(Object.keys(local)).toEqual([KEY])             // nothing added to localStorage
  })
  test('session_start is sent once per session', () => {
    setPrefs(true)
    const entry = { landing: '/', referrer: 'https://instagram.com', utm: { source: 'ig' }, device: 'mobile' as const }
    fc.trackSessionStart(entry); fc.trackSessionStart(entry); fc.trackSessionStart(entry)
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('/api/analytics/event')
    expect(Object.keys(sent[0].body).sort()).toEqual(['device', 'event', 'landing', 'referrer', 'sid', 'utm'])
  })
  test('admin and API pages are never tracked', () => {
    setPrefs(true); env({ path: '/admin/orders' })
    fc.trackSessionStart({ landing: '/admin/orders', referrer: null, utm: null, device: 'desktop' })
    fc.trackProductView('f21'); fc.trackAddToCartEvent({ slug: 'f21', quantity: 1 })
    expect(sent).toEqual([])
  })
  test('a product view is sent once per product per session', () => {
    setPrefs(true)
    fc.trackProductView('f21'); fc.trackProductView('f21'); fc.trackProductView('other')
    expect(sent.map(s => s.body.slug)).toEqual(['f21', 'other'])
  })
  test('each add-to-cart carries its own event id, a quantity and no price or total', () => {
    setPrefs(true)
    fc.trackAddToCartEvent({ slug: 'f21', sku: 'F21-M', quantity: 2 })
    fc.trackAddToCartEvent({ slug: 'f21', sku: 'F21-M', quantity: 1 })
    expect(sent).toHaveLength(2)
    expect(sent[0].body.eid).not.toBe(sent[1].body.eid)
    expect(Object.keys(sent[0].body).sort()).toEqual(['eid', 'event', 'qty', 'sid', 'sku', 'slug'])
    expect(sent[0].body.qty).toBe(2)
  })
  test('an invalid quantity is never sent', () => {
    setPrefs(true)
    for (const q of [0, -1, 1.5, 100, NaN]) fc.trackAddToCartEvent({ slug: 'f21', quantity: q })
    expect(sent).toEqual([])
  })
  test('withdrawing consent stops tracking at once and forgets the session', () => {
    setPrefs(true); fc.trackProductView('f21'); expect(sent).toHaveLength(1)
    setPrefs(false)
    fc.trackAddToCartEvent({ slug: 'f21', quantity: 1 })
    expect(sent).toHaveLength(1)
    fc.clearFunnelSession()
    expect(session).toEqual({})
  })
  test('a failing network call never throws into the UI', () => {
    setPrefs(true)
    ;(global as any).fetch = jest.fn(() => { throw new Error('offline') })
    expect(() => fireAll()).not.toThrow()
    ;(global as any).fetch = jest.fn(() => Promise.reject(new Error('offline')))
    expect(() => fireAll()).not.toThrow()
  })
  test('entry context reads the path WITHOUT its query, UTM and a coarse device class', () => {
    env({ path: '/shop', search: '?utm_source=ig&utm_medium=social&utm_campaign=fall&utm_content=ad7&utm_term=shoes&email=a@b.com' })
    ;(global as any).document = { referrer: 'https://l.instagram.com/x?y=1' }
    const e = fc.captureEntryContext()
    expect(e.landing).toBe('/shop')
    expect(e.utm).toEqual({ source: 'ig', medium: 'social', campaign: 'fall' })   // content/term never captured
    expect(e.device).toBe('desktop')
  })
})

describe('source: consent and trust boundaries are wired where they must be', () => {
  const client = read('lib/funnel-client.ts')
  test('the consent key and expiry are the cookie context\'s own, exported from it', () => {
    const ctx = read('context/CookiePrefsContext.tsx')
    expect(ctx).toMatch(/export const STORAGE_KEY = 'kvrn_cookie_prefs_v2'/)
    expect(ctx).toMatch(/export const COOKIE_PREFS_EXPIRY_MS = 365 \* 24 \* 60 \* 60 \* 1000/)
    // GA Audit Revision 1: the DNT/GPC + "analytics === true" rule now lives in ONE shared pure module
    // (lib/consent-effective.ts) used by this tracker, the GA client and the cookie context. The same
    // three rules are asserted — in that module — and the tracker must delegate to it.
    const shared = read('lib/consent-effective.ts')
    expect(client).toMatch(/from '\.\/consent-effective'/)
    expect(client).toMatch(/effectiveAnalyticsConsent\(prefs\?\.analytics, window\.navigator\)/)
    expect(client).toMatch(/browserOptOutActive\(window\.navigator\)/)
    expect(shared).toMatch(/prefAnalytics === true/)
    expect(shared).toMatch(/doNotTrack === '1'/)
    expect(shared).toMatch(/globalPrivacyControl === true/)
  })
  test('no fingerprinting or persistent identifiers in the client tracker', () => {
    const code = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/canvas|fingerprint|navigator\.(userAgent|platform|plugins|hardwareConcurrency)|localStorage\.setItem|document\.cookie|screen\.(width|height)/i)
  })
  test('the PDP, cart and layout call the tracker; the cart call sits after the dispatch', () => {
    expect(read('app/layout.tsx')).toMatch(/<FunnelTracker \/>/)
    expect(read('app/products/[slug]/PDPClient.tsx')).toMatch(/trackProductView\(product\.slug\)/)
    const cart = read('context/CartContext.tsx')
    expect(cart.indexOf("dispatch({ type: 'ADD_ITEM'")).toBeGreaterThan(-1)
    expect(cart.indexOf('trackAddToCartEvent(')).toBeGreaterThan(cart.indexOf("dispatch({ type: 'ADD_ITEM'"))
    expect(cart).toMatch(/computeAddedQuantity\(/)                         // only a real increase is recorded (see funnel-analytics-cart-delta.test.ts)
  })
  test('checkout_started is recorded only after the Stripe session was attached, before the response', () => {
    const h = read('lib/checkout-session-handler.ts')
    const attach = h.indexOf('if (!attached)')
    const rec = h.indexOf('tryRecordCheckoutStarted(sql')
    const ok = h.lastIndexOf('return NextResponse.json({ url: session.url')
    expect(attach).toBeGreaterThan(-1)
    expect(rec).toBeGreaterThan(attach)
    expect(ok).toBeGreaterThan(rec)
    expect(h.match(/tryRecordCheckoutStarted\(/g)).toHaveLength(1)   // the one call (the import has no paren)
    expect(h).not.toMatch(/ENABLE_CHECKOUT\s*=|isCheckoutEnabled\s*=/)
  })
  test('purchase is recorded in the webhook only after finalizePaidOrder returned an order', () => {
    const w = read('app/api/stripe/webhook/route.ts')
    expect(w.indexOf('tryRecordPurchase(sql')).toBeGreaterThan(w.indexOf('await finalizePaidOrder('))
    expect(w).toMatch(/result\.orderId && \['order_created', 'already_processed', 'already_had_order'\]/)
  })
  test('the public route cannot write stages 4 and 5 and is not admin-authenticated', () => {
    const r = read('app/api/analytics/event/route.ts')
    expect(r).not.toMatch(/requireAdmin|recordCheckoutStarted|recordPurchase/)
    expect(r).toMatch(/isSameOrigin\(req\)/)
  })
  test('the admin endpoint uses requireAdmin first', () => {
    const r = read('app/api/admin/analytics/funnel/route.ts')
    expect(r.indexOf('requireAdmin(req)')).toBeGreaterThan(-1)
    expect(r.indexOf('requireAdmin(req)')).toBeLessThan(r.indexOf('parseFunnelRange('))
  })
  test('no migration was needed: the funnel feature added none of its own', () => {
    // (Was "the chain ends at 022"; 023+ now exist for unrelated, later work.)
    const files = fs.readdirSync(path.join(ROOT, 'db/migrations')).filter(f => /^\d+_/.test(f)).sort()
    expect(files.some(f => /funnel/i.test(f))).toBe(false)
    expect(files).toContain('022_late_payment_recovery.sql')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REAL ROUTES + POSTGRES
// ═════════════════════════════════════════════════════════════════════════════
let F: FiDb
let pgFail: string | null = null
const needDb = () => { if (pgFail) throw new Error('local PostgreSQL unavailable: ' + pgFail) }
const q = (t: string, p: unknown[] = []) => F.q(t, p)
const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'

beforeAll(async () => {
  if (!HAVE_DB) return
  try {
    F = await createFiDb('kvrn_funnel')
    await seedCatalog(F.q)                               // product 'f21', sku 'F21-M', $10.00
    await q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
             VALUES ('f2100000-0000-0000-0000-00000000cccc','S','S','Second Tee','second-tee',2500,true)`)
    await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand)
             VALUES ('f2100000-0000-0000-0000-00000000dddd','f2100000-0000-0000-0000-00000000cccc','SEC-M','Black','#000','M',1,10)`)
    ;(global as any).__FA_SQL = F.sql
  } catch (e: any) { pgFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { await F?.close() })
afterEach(() => { (global as any).__FA_DENY = false })

const ingest = (body: unknown, h: Record<string, string> = {}, raw?: string) => {
  const { POST } = require('../../app/api/analytics/event/route')
  return POST(new NextRequest('http://localhost/api/analytics/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', 'user-agent': WEB_UA, ...h },
    body: raw ?? JSON.stringify(body),
  }))
}
const count = async (where = 'TRUE', p: unknown[] = []) =>
  Number((await q(`SELECT count(*)::int AS n FROM analytics_events WHERE ${where}`, p))[0].n)

describeDB('public ingestion route', () => {
  test('a same-origin session_start is stored once; repeats are absorbed', async () => {
    needDb()
    const s = sid()
    const ev = { event: 'session_start', sid: s, landing: '/shop?token=abc', referrer: 'https://l.instagram.com/p?x=a@b.com',
                 utm: { source: 'instagram', medium: 'social', campaign: 'drop1' }, device: 'mobile' }
    expect((await ingest(ev)).status).toBe(204)
    expect((await ingest(ev)).status).toBe(204)
    expect((await ingest(ev)).status).toBe(204)
    expect(await count(`session_id=$1 AND event_name='session_start'`, [s])).toBe(1)
    const row = (await q(`SELECT * FROM analytics_sessions WHERE session_id=$1`, [s]))[0]
    expect(row.landing_page).toBe('/shop')                                   // no query string
    expect(row.referrer).toBe('https://l.instagram.com')                     // origin only
    expect(row.first_touch_utm).toEqual({ source: 'instagram', medium: 'social', campaign: 'drop1' })
    expect(row.device_type).toBe('mobile')
  })
  test('a session_start carrying utm content/term is rejected and stores nothing', async () => {
    needDb()
    for (const extra of [{ content: 'x' }, { term: 'y' }]) {
      const s = sid()
      const res = await ingest({ event: 'session_start', sid: s, landing: '/', utm: { source: 'ig', ...extra } })
      expect(res.status).toBe(400)
      expect(await count('session_id=$1', [s])).toBe(0)
      expect(await q(`SELECT 1 FROM analytics_sessions WHERE session_id=$1`, [s])).toHaveLength(0)
    }
  })
  test('first-touch fields are never overwritten by a later start', async () => {
    needDb()
    const s = sid()
    await ingest({ event: 'session_start', sid: s, landing: '/', referrer: null, utm: { source: 'first' }, device: 'desktop' })
    await F.sql`DELETE FROM analytics_events WHERE session_id=${s}`          // simulate a lost start row
    await ingest({ event: 'session_start', sid: s, landing: '/later', referrer: 'https://x.test', utm: { source: 'second' }, device: 'mobile' })
    const row = (await q(`SELECT * FROM analytics_sessions WHERE session_id=$1`, [s]))[0]
    expect(row.landing_page).toBe('/')
    expect(row.first_touch_utm).toEqual({ source: 'first' })
    expect(row.last_touch_utm).toEqual({ source: 'second' })
    expect(row.device_type).toBe('desktop')
  })
  test('wrong origin, missing origin, wrong content type, oversize and bad JSON are all refused and store nothing', async () => {
    needDb()
    const s = sid(); const ev = { event: 'session_start', sid: s }
    expect((await ingest(ev, { origin: 'https://evil.test' })).status).toBe(403)
    expect((await ingest(ev, { origin: '' })).status).toBe(403)
    expect((await ingest(ev, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await ingest(null, {}, '{' + '"a":1,'.repeat(500) + '}')).status).toBe(413)
    expect((await ingest(null, {}, '{not json')).status).toBe(400)
    expect(await count('session_id=$1', [s])).toBe(0)
  })
  test('an invalid or PII-bearing event is a generic 400 and stores nothing', async () => {
    needDb()
    const s = sid()
    for (const bad of [
      { event: 'product_viewed', sid: s, slug: 'f21', email: 'a@b.com' },
      { event: 'checkout_started', sid: s },
      { event: 'purchase_completed', sid: s, orderId: oid(1) },
      { event: 'add_to_cart', sid: s, eid: sid(), slug: 'f21', qty: 1, valueCents: 1 },
    ]) {
      const res = await ingest(bad)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid event.' })          // no field names, no reasons
    }
    expect(await count('session_id=$1', [s])).toBe(0)
  })
  test('automation is acknowledged but never counted', async () => {
    needDb()
    const s = sid()
    const res = await ingest({ event: 'session_start', sid: s }, { 'user-agent': 'Googlebot/2.1' })
    expect(res.status).toBe(204)
    expect(await count('session_id=$1', [s])).toBe(0)
  })
  test('admin and API landing pages are not storefront traffic', async () => {
    needDb()
    const s = sid()
    expect((await ingest({ event: 'session_start', sid: s, landing: '/admin/financials' })).status).toBe(400)
    expect(await count('session_id=$1', [s])).toBe(0)
  })
  test('a database failure is a generic 503 that leaks nothing', async () => {
    needDb()
    const spy = jest.spyOn(F.db, 'query').mockImplementation((() => Promise.reject(new Error('relation "analytics_events" does not exist; password=hunter2'))) as any)
    const res = await ingest({ event: 'session_start', sid: sid() })
    spy.mockRestore()
    expect(res.status).toBe(503)
    expect(JSON.stringify(await res.json())).not.toMatch(/relation|password|hunter2|analytics_events/)
  })
})

describeDB('product_viewed and add_to_cart', () => {
  test('a product view is resolved against the catalog, stored once per session and product, and ensures the visit', async () => {
    needDb()
    const s = sid()
    const ev = { event: 'product_viewed', sid: s, slug: 'f21', sku: 'F21-M' }
    for (let i = 0; i < 4; i++) expect((await ingest(ev)).status).toBe(204)       // React re-render storm
    expect(await count(`session_id=$1 AND event_name='product_viewed'`, [s])).toBe(1)
    expect(await count(`session_id=$1 AND event_name='session_start'`, [s])).toBe(1)   // visit implied, once
    const r = (await q(`SELECT product_id, variant_id, variant_sku FROM analytics_events WHERE session_id=$1 AND event_name='product_viewed'`, [s]))[0]
    expect(r).toEqual({ product_id: P, variant_id: V, variant_sku: 'F21-M' })
    await ingest({ event: 'product_viewed', sid: s, slug: 'second-tee' })           // a different product counts
    expect(await count(`session_id=$1 AND event_name='product_viewed'`, [s])).toBe(2)
  })
  test('an unknown or inactive product is ignored, and a foreign sku is not trusted', async () => {
    needDb()
    const s = sid()
    expect((await ingest({ event: 'product_viewed', sid: s, slug: 'does-not-exist' })).status).toBe(204)
    expect(await count('session_id=$1', [s])).toBe(0)
    await ingest({ event: 'product_viewed', sid: s, slug: 'f21', sku: 'SEC-M' })      // other product's sku
    const r = (await q(`SELECT variant_id, variant_sku FROM analytics_events WHERE session_id=$1 AND event_name='product_viewed'`, [s]))[0]
    expect(r).toEqual({ variant_id: null, variant_sku: null })                       // unknown stays NULL
    await q(`UPDATE products SET active=false WHERE slug='second-tee'`)
    const s2 = sid()
    await ingest({ event: 'product_viewed', sid: s2, slug: 'second-tee' })
    await q(`UPDATE products SET active=true WHERE slug='second-tee'`)
    expect(await count('session_id=$1', [s2])).toBe(0)
  })
  test('each add is its own event; a retried add (same event id) is not double counted', async () => {
    needDb()
    const s = sid(); const e1 = sid(); const e2 = sid()
    const add = (eid: string, qty: number) => ({ event: 'add_to_cart', sid: s, eid, slug: 'f21', sku: 'F21-M', qty })
    await ingest(add(e1, 2)); await ingest(add(e1, 2)); await ingest(add(e1, 2))
    await ingest(add(e2, 1))
    expect(await count(`session_id=$1 AND event_name='add_to_cart'`, [s])).toBe(2)
  })
  test('the value is the SERVER price x quantity, in integer cents; a browser value is refused', async () => {
    needDb()
    const s = sid()
    await ingest({ event: 'add_to_cart', sid: s, eid: sid(), slug: 'f21', sku: 'F21-M', qty: 3 })
    const r = (await q(`SELECT value_cents, meta, variant_id FROM analytics_events WHERE session_id=$1 AND event_name='add_to_cart'`, [s]))[0]
    expect(r.value_cents).toBe(3000)
    expect(r.meta).toEqual({ qty: 3 })
    expect(r.variant_id).toBe(V)
  })
  test('an add without a resolvable variant is still recorded, with the variant UNKNOWN (null)', async () => {
    needDb()
    const s = sid()
    await ingest({ event: 'add_to_cart', sid: s, eid: sid(), slug: 'f21', qty: 1 })          // quick-add has no sku
    const r = (await q(`SELECT variant_id, value_cents FROM analytics_events WHERE session_id=$1 AND event_name='add_to_cart'`, [s]))[0]
    expect(r).toEqual({ variant_id: null, value_cents: 1000 })
  })
  test('a session cannot grow without bound', async () => {
    needDb()
    const s = sid()
    await ingest({ event: 'product_viewed', sid: s, slug: 'f21' })
    await q(`INSERT INTO analytics_events (id, session_id, event_name)
             SELECT gen_random_uuid(), $1, 'add_to_cart' FROM generate_series(1, $2)`, [s, MAX_EVENTS_PER_SESSION])
    const before = await count('session_id=$1', [s])
    await ingest({ event: 'add_to_cart', sid: s, eid: sid(), slug: 'f21', sku: 'F21-M', qty: 1 })
    expect(await count('session_id=$1', [s])).toBe(before)
  })
  test('no analytics table holds a PII-shaped column', async () => {
    needDb()
    const cols = await q(`SELECT table_name, column_name FROM information_schema.columns
                          WHERE table_name IN ('analytics_sessions','analytics_events')`)
    const names = cols.map((c: any) => c.column_name)
    for (const n of names.filter((x: string) => x !== 'event_name')) expect(n).not.toMatch(/email|name$|^name|phone|address|street|ip_?addr|user_?agent|card|fingerprint|customer/i)
    expect(names).toEqual(expect.arrayContaining(['session_id', 'event_name', 'product_id', 'variant_id', 'value_cents', 'meta']))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// AGGREGATION + ADMIN ENDPOINT
// ═════════════════════════════════════════════════════════════════════════════
describeDB('admin funnel report', () => {
  const RES = 'f2200000-0000-0000-0000-0000000000a1'
  const adminGet = (qs = '') => {
    const { GET } = require('../../app/api/admin/analytics/funnel/route')
    return GET(new NextRequest('http://localhost/api/admin/analytics/funnel' + qs))
  }
  const S = { a: sid(), b: sid(), c: sid(), d: sid(), e: sid(), old: sid(), mid: sid() }
  const add = (s: string, slug = 'f21', sku = 'F21-M') =>
    ingest({ event: 'add_to_cart', sid: s, eid: sid(), slug, sku, qty: 1 })
  const view = (s: string, slug = 'f21') => ingest({ event: 'product_viewed', sid: s, slug })

  beforeAll(async () => {
    if (!HAVE_DB || pgFail) return
    const svc = createFunnelService(F.sql)
    // Start from an empty funnel: earlier blocks in this file wrote events of their own.
    await q('DELETE FROM analytics_events'); await q('DELETE FROM analytics_sessions')
    // S.a: full funnel and a real order. S.b: cart. S.c: product only. S.d: visit only.
    // S.e: quick add with NO product view (must still count as having reached a product).
    for (const s of [S.a, S.b, S.c, S.d, S.e]) await ingest({ event: 'session_start', sid: s, landing: '/' })
    await view(S.a); await add(S.a)
    await view(S.b); await add(S.b)
    await view(S.c)
    await add(S.e)
    await mkOrder(F.q, 901)
    await q(`INSERT INTO reservations (id, expires_at) VALUES ($1, now() + interval '15 minutes')`, [RES])
    await q(`UPDATE orders SET reservation_id=$2 WHERE id=$1`, [oid(901), RES])
    await svc.recordCheckoutStarted({ sessionId: S.a, reservationId: RES, subtotalCents: 1000,
                                      items: [{ variantId: V, quantity: 1 }] })
    await svc.recordPurchase({ orderId: oid(901), reservationId: RES })
    // Outside the 30d window: a session 40 days ago (in 90d), and one 100 days ago (in none).
    for (const [s, days] of [[S.mid, 40], [S.old, 100]] as const) {
      await ingest({ event: 'session_start', sid: s, landing: '/' }); await view(s, 'second-tee')
      await q(`UPDATE analytics_events SET created_at = now() - ($2 || ' days')::interval WHERE session_id=$1`, [s, String(days)])
    }
  }, 60_000)

  test('401 without admin, and the database is not consulted', async () => {
    needDb()
    ;(global as any).__FA_DENY = true
    const spy = jest.spyOn(F.db, 'query')
    const res = await adminGet('?range=30d')
    expect(res.status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  test.each(['1d', '365d', 'ytd', '30', '7d;drop table x', '%27'])('range %p -> 400', async r => {
    needDb()
    expect((await adminGet('?range=' + encodeURIComponent(r))).status).toBe(400)
  })
  test('stage counts are cumulative sessions; the rates follow from them', async () => {
    needDb()
    const j = await (await adminGet('?range=30d')).json()
    expect(j.range).toBe('30d')
    expect(j.stages).toEqual({ visits: 5, reachedProduct: 4, reachedCart: 3, reachedCheckout: 1, purchased: 1 })
    expect(j.rates).toEqual({ visitToProduct: 80, productToCart: 75, cartToCheckout: 33.33, checkoutToPurchase: 100, visitToPurchase: 20 })
    // never larger than the stage before
    const s = j.stages
    expect(s.visits >= s.reachedProduct && s.reachedProduct >= s.reachedCart && s.reachedCart >= s.reachedCheckout && s.reachedCheckout >= s.purchased).toBe(true)
  })
  test('raw event totals, purchase value (orders.total_cents verbatim) and coverage', async () => {
    needDb()
    const j = await (await adminGet('?range=30d')).json()
    expect(j.events).toEqual({ productViews: 3, addToCarts: 3, checkoutStarts: 1, purchases: 1, purchaseValueCents: 1500 })
    expect(j.coverage).toEqual({ ordersPaid: 1, trackedPurchases: 1, trackedPurchaseSharePct: 100 })
  })
  test('the window is respected: 90d includes the 40-day-old session, no range includes the 100-day-old one', async () => {
    needDb()
    const d30 = await (await adminGet('?range=30d')).json()
    const d90 = await (await adminGet('?range=90d')).json()
    const d7 = await (await adminGet('?range=7d')).json()
    expect(d30.stages.visits).toBe(5)
    expect(d90.stages.visits).toBe(6)
    expect(d7.stages.visits).toBe(5)
    expect((await (await adminGet()).json()).range).toBe('30d')                  // default
  })
  test('the product table counts distinct sessions per stage and bounded rates', async () => {
    needDb()
    const j = await (await adminGet('?range=30d')).json()
    const f21 = j.products.find((p: any) => p.slug === 'f21')
    expect(f21).toMatchObject({ name: expect.any(String), views: 3, adds: 3, checkouts: 1, purchases: 1 })
    expect(f21.addRatePct).toBe(75)             // 3 of the 4 sessions that reached the product went on to add
    expect(f21.purchaseRatePct).toBe(25)
    expect(j.products.find((p: any) => p.slug === 'second-tee')).toBeUndefined()   // its only activity is out of window
    const d90 = await (await adminGet('?range=90d')).json()
    expect(d90.products.find((p: any) => p.slug === 'second-tee')).toMatchObject({ views: 1, adds: 0, purchases: 0 })
  })
  test('an empty window reports zeros for counts and UNKNOWN (null) for rates', async () => {
    needDb()
    const svc = createFunnelService(F.sql)
    const r = await svc.getFunnelReport({ start: '2001-01-01T00:00:00Z', end: '2001-02-01T00:00:00Z' })
    expect(r.stages.visits).toBe(0)
    expect(Object.values(r.rates).every(v => v === null)).toBe(true)
    expect(r.coverage.trackedPurchaseSharePct).toBeNull()                         // no orders: unknown, not 0%
    expect(r.products).toEqual([])
  })
  test('the response is aggregates only: no raw rows, session ids or order ids', async () => {
    needDb()
    const body = JSON.stringify(await (await adminGet('?range=90d')).json())
    for (const s of Object.values(S)) expect(body).not.toContain(s)
    expect(body).not.toContain(oid(901)); expect(body).not.toContain(RES)
    expect(body).not.toMatch(/session_id|reservation_id|order_id|"meta"/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Coverage uses ONE cohort: orders whose paid_at is in the window.
describeDB('purchase coverage: the paid-order cohort is both numerator and denominator', () => {
  const W = { start: '2020-06-01T00:00:00Z', end: '2020-07-01T00:00:00Z' }
  const A = 910, B = 911, C = 912        // A: paid in window + event; B: paid BEFORE window, event inside; C: paid in window, no event
  const purchaseEvent = (n: number, createdAt: string) =>
    q(`INSERT INTO analytics_events (id, session_id, event_name, order_id, value_cents, created_at)
       VALUES ($1, $2, 'purchase_completed', $3, 1500, $4::timestamptz)`, [randomUUID(), sid(), oid(n), createdAt])

  beforeAll(async () => {
    if (!HAVE_DB || pgFail) return
    for (const n of [A, B, C]) await mkOrder(F.q, n, { consume: false, label: null })
    await q(`UPDATE orders SET paid_at='2020-06-15T12:00:00Z' WHERE id IN ($1,$2)`, [oid(A), oid(C)])
    await q(`UPDATE orders SET paid_at='2020-05-20T12:00:00Z' WHERE id=$1`, [oid(B)])
    await purchaseEvent(A, '2020-06-16T00:00:00Z')      // normal: event right after the payment
    await purchaseEvent(B, '2020-06-10T00:00:00Z')      // backfill/heal: order paid before the window, event inside it
  })

  test('an order paid OUTSIDE the window with an event INSIDE it does not inflate coverage', async () => {
    needDb()
    const r = await createFunnelService(F.sql).getFunnelReport(W)
    expect(r.coverage.ordersPaid).toBe(2)               // A and C only
    expect(r.coverage.trackedPurchases).toBe(1)         // only A has an event; B is not in the cohort
    expect(r.coverage.trackedPurchaseSharePct).toBe(50)
    // The raw event total is reported separately and DOES include B's in-window event.
    expect(r.events.purchases).toBe(2)
  })
  test('an order paid inside the window whose event exists counts as tracked, even if the event is dated later', async () => {
    needDb()
    const r = await createFunnelService(F.sql).getFunnelReport({ start: '2020-06-01T00:00:00Z', end: '2020-06-16T00:00:00Z' })
    expect(r.coverage).toEqual({ ordersPaid: 2, trackedPurchases: 1, trackedPurchaseSharePct: 50 })   // A's event is after this window ends
    expect(r.events.purchases).toBe(1)                                                                // only B's event is inside it
  })
  test('coverage can never exceed 100%, however many events fall in the window', async () => {
    needDb()
    // A window that contains only B's event and no paid orders: unknown (null), not 100%+ and not 0%.
    const r = await createFunnelService(F.sql).getFunnelReport({ start: '2020-06-05T00:00:00Z', end: '2020-06-12T00:00:00Z' })
    expect(r.coverage).toEqual({ ordersPaid: 0, trackedPurchases: 0, trackedPurchaseSharePct: null })
    expect(r.events.purchases).toBe(1)
    // And a duplicate-looking second event for the same order cannot count the order twice.
    await purchaseEvent(A, '2020-06-20T00:00:00Z')
    const w = await createFunnelService(F.sql).getFunnelReport(W)
    expect(w.coverage.trackedPurchases).toBeLessThanOrEqual(w.coverage.ordersPaid)
    expect(w.coverage).toEqual({ ordersPaid: 2, trackedPurchases: 1, trackedPurchaseSharePct: 50 })
  })
  test('the admin copy says what is actually known and no longer claims the cause', () => {
    const ui = read('app/admin/analytics/AnalyticsClient.tsx')
    expect(ui).toMatch(/are linked to a tracked analytics session/)
    expect(ui).toMatch(/Untracked orders may reflect declined\/no analytics consent or unavailable analytics data\./)
    expect(ui).not.toMatch(/did not accept analytics/)
    expect(read('FUNNEL-ANALYTICS.md')).not.toMatch(/did not accept analytics/)
  })
})
