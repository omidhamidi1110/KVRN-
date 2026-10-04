// lib/__tests__/ga4-client.test.ts
//
// Browser-side GA4: consent gating (existing cookie preferences, DNT, GPC), no pre-consent loading,
// page_view / view_item de-duplication, the add_to_cart actual delta, begin_checkout, revocation,
// admin exclusion, and no PII in any payload. Drives the REAL lib/ga-client.ts against a fake
// window/document; "what GA received" is whatever landed in window.dataLayer.

import fs from 'fs'
import path from 'path'
import { cartReducer, computeAddedQuantity } from '../cart-reducer'
import type { CartItem } from '../../types'

// funnel-client (the consent function GA reuses) imports two constants from a .tsx context Jest does
// not transform; they are pinned to the real file in funnel-analytics.test.ts.
jest.mock('@/context/CookiePrefsContext', () => ({
  STORAGE_KEY: 'kvrn_cookie_prefs_v2', COOKIE_PREFS_EXPIRY_MS: 365 * 24 * 60 * 60 * 1000,
}))

const ID = 'G-TEST123456'
const KEY = 'kvrn_cookie_prefs_v2'

let ga: typeof import('../ga-client')
let local: Record<string, string>
let session: Record<string, string>
let scripts: any[]
let cookieJar: string
let cookieWrites: string[]

const store = (m: Record<string, string>) => ({
  getItem: (k: string) => (k in m ? m[k] : null), setItem: (k: string, v: string) => { m[k] = v },
  removeItem: (k: string) => { delete m[k] },
})
const setPrefs = (analytics: boolean, ts = Date.now()) => { local[KEY] = JSON.stringify({ prefs: { essential: true, analytics }, ts }) }
const env = (o: { dnt?: string | null; gpc?: boolean; path?: string; search?: string; referrer?: string } = {}) => {
  ;(global as any).window = {
    localStorage: store(local), sessionStorage: store(session),
    navigator: { doNotTrack: o.dnt ?? null, globalPrivacyControl: o.gpc },
    location: { pathname: o.path ?? '/products/phantom-hoodie', search: o.search ?? '',
                origin: 'https://kvrn.shop', hostname: 'www.kvrn.shop' },
    innerWidth: 1280,
  }
  const doc: any = {
    referrer: o.referrer ?? '', title: 'KVRN',
    head: { appendChild: (el: any) => { scripts.push(el) } },
    getElementById: (id: string) => scripts.find(s => s.id === id) ?? null,
    createElement: () => ({}),
  }
  Object.defineProperty(doc, 'cookie', { get: () => cookieJar, set: (v: string) => { cookieWrites.push(v) } })
  ;(global as any).document = doc
}
const goto = (pathname: string, search = '') => { const l = (global as any).window.location; l.pathname = pathname; l.search = search }

/** Everything GA was handed, as arrays (gtag pushes `arguments` objects). */
const layer = (): any[][] => (((global as any).window.dataLayer ?? []) as any[]).map(a => Array.from(a))
const sent = (name: string) => layer().filter(a => a[0] === 'event' && a[1] === name).map(a => a[2])
const anyEvents = () => layer().filter(a => a[0] === 'event')

beforeAll(async () => { ga = await import('../ga-client') })
beforeEach(() => {
  local = {}; session = {}; scripts = []; cookieJar = ''; cookieWrites = []
  env(); ga.__resetGaStateForTests()
})
afterEach(() => { delete (global as any).window; delete (global as any).document })

const fireEverything = () => {
  ga.initGa(ID)
  ga.gaPageView()
  ga.gaViewItem({ slug: 'phantom-hoodie', name: 'Phantom Hoodie', priceCents: 8000 })
  ga.gaAddToCart({ slug: 'phantom-hoodie', name: 'Phantom Hoodie', sku: 'KVRN-PH-BLK-M', priceCents: 8000, quantity: 1 })
  ga.gaBeginCheckout([{ slug: 'phantom-hoodie', name: 'Phantom Hoodie', sku: 'KVRN-PH-BLK-M', priceCents: 8000, quantity: 1 }])
  ga.gaEvent('sms_offer_view', { event_category: 'sms_popup' })
}
const expectCompletelyOff = () => {
  expect((global as any).window.gtag).toBeUndefined()
  expect((global as any).window.dataLayer).toBeUndefined()
  expect(scripts).toEqual([])                        // gtag.js never loaded
  expect(session).toEqual({})                        // nothing stored
  expect(ga.getGaIdentifiers()).toBeNull()
}

// ═════════════════════════════════════════════════════════════════════════════
describe('GA stays completely off without analytics consent', () => {
  test('no choice yet: nothing loads, nothing is queued, nothing is stored', () => {
    fireEverything()
    expectCompletelyOff()
  })
  test('analytics declined', () => { setPrefs(false); fireEverything(); expectCompletelyOff() })
  test('an expired choice counts as no choice', () => { setPrefs(true, Date.now() - 366 * 86_400_000); fireEverything(); expectCompletelyOff() })
  test('Do Not Track blocks GA even though analytics was accepted', () => { setPrefs(true); env({ dnt: '1' }); fireEverything(); expectCompletelyOff() })
  test('Global Privacy Control blocks GA even though analytics was accepted', () => { setPrefs(true); env({ gpc: true }); fireEverything(); expectCompletelyOff() })
  test('garbage in the preferences store is "no consent"', () => {
    local[KEY] = '{not json'; fireEverything(); expectCompletelyOff()
    local[KEY] = JSON.stringify({ prefs: { analytics: 'yes' }, ts: Date.now() }); fireEverything(); expectCompletelyOff()
  })
  test('a missing or malformed measurement id is "GA off" even with consent', () => {
    setPrefs(true)
    for (const bad of [undefined, null, '', 'UA-123', 'G-', 'g-abc', 'G-abc<script>', 'G-' + 'A'.repeat(40), 123, {}]) {
      expect(ga.initGa(bad)).toBe(false)
    }
    expectCompletelyOff()
  })
  test('events fired before init are dropped, not queued for later', () => {
    ga.gaViewItem({ slug: 'a', name: 'A', priceCents: 100 })      // no consent, no init
    setPrefs(true); ga.initGa(ID)
    expect(anyEvents()).toEqual([])                              // nothing from before consent is flushed
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('with consent', () => {
  beforeEach(() => { setPrefs(true) })

  test('init loads gtag.js once, sets Consent Mode (analytics granted, advertising denied) and disables automatic page_view', () => {
    expect(ga.initGa(ID)).toBe(true)
    expect(ga.initGa(ID)).toBe(true)                                // idempotent
    expect(scripts).toHaveLength(1)
    expect(scripts[0].src).toBe(`https://www.googletagmanager.com/gtag/js?id=${ID}`)
    expect(scripts[0].async).toBe(true)
    const l = layer()
    const consent = l.find(a => a[0] === 'consent' && a[1] === 'default')![2]
    expect(consent).toMatchObject({ analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' })
    const configs = l.filter(a => a[0] === 'config')
    expect(configs).toHaveLength(1)
    expect(configs[0][1]).toBe(ID)
    expect(configs[0][2]).toMatchObject({ send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false })
    // Ordering: consent mode is established before config.
    expect(l.findIndex(a => a[0] === 'consent')).toBeLessThan(l.findIndex(a => a[0] === 'config'))
  })

  test('the script id and src are fixed: the measurement id is URL-encoded and validated, never raw input', () => {
    expect(ga.initGa(ID + '&evil=1')).toBe(false)
    expect(scripts).toEqual([])
  })

  test('admin routes never initialise GA', () => {
    env({ path: '/admin/analytics' }); setPrefs(true)
    expect(ga.initGa(ID)).toBe(false)
    expectCompletelyOff()
  })

  // ── page_view ──
  test('page_view: exactly one per route; re-renders and strict-mode double effects are no-ops', () => {
    ga.initGa(ID)
    ga.gaPageView(); ga.gaPageView(); ga.gaPageView()
    expect(sent('page_view')).toHaveLength(1)
    goto('/shop'); ga.gaPageView(); ga.gaPageView()
    expect(sent('page_view')).toHaveLength(2)
    goto('/products/phantom-hoodie'); ga.gaPageView()
    expect(sent('page_view')).toHaveLength(3)
  })
  test('the automatic page_view is OFF, so the initial page is not counted twice', () => {
    ga.initGa(ID)
    expect(layer().filter(a => a[0] === 'config')[0][2].send_page_view).toBe(false)
    expect(sent('page_view')).toHaveLength(0)                       // init alone sends none
    ga.gaPageView()
    expect(sent('page_view')).toHaveLength(1)
  })
  test('page_location carries ONLY utm source/medium/campaign: no other query, no content/term, no PII', () => {
    env({ path: '/checkout/success',
          search: '?session_id=cs_test_a1&email=a%40b.com&name=Jo&utm_source=instagram&utm_medium=social&utm_campaign=fall&utm_content=ad7&utm_term=shoes&token=zzz' })
    setPrefs(true); ga.initGa(ID); ga.gaPageView()
    const loc = sent('page_view')[0].page_location as string
    expect(loc).toBe('https://kvrn.shop/checkout/success?utm_source=instagram&utm_medium=social&utm_campaign=fall')
    for (const bad of ['session_id', 'email', 'a%40b.com', 'name=', 'utm_content', 'utm_term', 'token', 'cs_test']) expect(loc).not.toContain(bad)
  })
  test('an unsafe utm value (email-like, markup, oversized) is dropped, not forwarded', () => {
    env({ path: '/', search: '?utm_source=a%40b.com&utm_medium=%3Cb%3E&utm_campaign=' + 'x'.repeat(101) })
    setPrefs(true); ga.initGa(ID); ga.gaPageView()
    expect(sent('page_view')[0].page_location).toBe('https://kvrn.shop/')
  })
  test('page_referrer: another site is reduced to its origin; later pages use the previous page (no query)', () => {
    env({ path: '/', referrer: 'https://l.instagram.com/out?u=https%3A%2F%2Fx&email=a@b.com' })
    setPrefs(true); ga.initGa(ID); ga.gaPageView()
    expect(sent('page_view')[0].page_referrer).toBe('https://l.instagram.com/')
    goto('/shop', '?q=secret'); ga.gaPageView()
    expect(sent('page_view')[1].page_referrer).toBe('https://kvrn.shop/')
    expect(JSON.stringify(sent('page_view'))).not.toMatch(/secret|email|a@b/)
  })
  test('no page_view on admin or API routes even if GA was already running', () => {
    ga.initGa(ID); ga.gaPageView()
    goto('/admin/orders'); ga.gaPageView()
    goto('/api/anything'); ga.gaPageView()
    expect(sent('page_view')).toHaveLength(1)
  })

  // ── view_item ──
  test('view_item: once per product per browsing session; a second product is a second event', () => {
    ga.initGa(ID)
    const a = { slug: 'phantom-hoodie', name: 'Phantom Hoodie', priceCents: 8000 }
    ga.gaViewItem(a); ga.gaViewItem(a); ga.gaViewItem(a)
    expect(sent('view_item')).toHaveLength(1)
    ga.gaViewItem({ slug: 'phantom-sweatpants', name: 'Phantom Sweatpants', priceCents: 6500 })
    expect(sent('view_item')).toHaveLength(2)
    expect(sent('view_item')[0]).toEqual({
      currency: 'USD', value: 80,
      items: [{ item_id: 'phantom-hoodie', item_name: 'Phantom Hoodie', item_brand: 'KVRN', price: 80, quantity: 1 }],
    })
  })
  test('view_item with an unknown price omits value and price (never 0)', () => {
    ga.initGa(ID)
    ga.gaViewItem({ slug: 'x', name: 'X', priceCents: null })
    const e = sent('view_item')[0]
    expect(e).not.toHaveProperty('value'); expect(e.items[0]).not.toHaveProperty('price')
    ga.gaViewItem({ slug: 'y', name: 'Y', priceCents: -5 })
    ga.gaViewItem({ slug: 'z', name: 'Z', priceCents: 12.5 })
    for (const ev of sent('view_item').slice(1)) { expect(ev).not.toHaveProperty('value'); expect(ev.items[0]).not.toHaveProperty('price') }
  })

  // ── add_to_cart ──
  test('add_to_cart carries the quantity the cart ACTUALLY gained (new line, room, partial clamp, at cap)', () => {
    ga.initGa(ID)
    const line = (o: Partial<CartItem> = {}): CartItem => ({
      cartItemId: 'p1-black-M', productId: 'p1', productName: 'Phantom Hoodie', slug: 'phantom-hoodie', color: 'black',
      colorName: 'Black', colorHex: '#000', size: 'M' as any, sku: 'KVRN-PH-BLK-M', price: 8000, quantity: 1, image: '/x.jpg', ...o,
    } as CartItem)
    let cart: CartItem[] = []
    // The exact addItem sequence from context/CartContext.tsx: delta from the current cart -> reduce -> record.
    const addItem = (item: CartItem) => {
      const added = computeAddedQuantity(cart, item)
      cart = cartReducer({ items: cart, isOpen: false }, { type: 'ADD_ITEM', payload: item }).items
      if (added > 0) ga.gaAddToCart({ slug: item.slug, name: item.productName, sku: item.sku, priceCents: item.price, quantity: added })
    }
    addItem(line({ quantity: 2, availableQuantity: 5 }))      // new line            -> 2
    addItem(line({ quantity: 2, availableQuantity: 5 }))      // room under the cap  -> 2
    addItem(line({ quantity: 3, availableQuantity: 5 }))      // partial clamp       -> 1
    addItem(line({ quantity: 1, availableQuantity: 5 }))      // already at the cap  -> no event
    const evs = sent('add_to_cart')
    expect(evs.map(e => e.items[0].quantity)).toEqual([2, 2, 1])
    expect(evs.map(e => e.value)).toEqual([160, 160, 80])    // price x ACTUAL quantity, cents -> dollars at the boundary
    expect(evs.reduce((n, e) => n + e.items[0].quantity, 0)).toBe(cart[0].quantity)
    expect(evs[0]).toMatchObject({ currency: 'USD', items: [{ item_id: 'phantom-hoodie', item_variant: 'KVRN-PH-BLK-M', price: 80 }] })
  })
  test('invalid quantities are never sent', () => {
    ga.initGa(ID)
    for (const q of [0, -1, 1.5, 100, NaN]) ga.gaAddToCart({ slug: 'a', name: 'A', priceCents: 100, quantity: q })
    expect(sent('add_to_cart')).toEqual([])
  })

  // ── begin_checkout ──
  test('begin_checkout: items and value from the cart lines, USD, no coupon, no PII', () => {
    ga.initGa(ID)
    ga.gaBeginCheckout([
      { slug: 'phantom-hoodie', name: 'Phantom Hoodie', sku: 'KVRN-PH-BLK-M', priceCents: 8000, quantity: 2 },
      { slug: 'phantom-sweatpants', name: 'Phantom Sweatpants', sku: 'KVRN-PS-BLK-L', priceCents: 6500, quantity: 1 },
    ])
    const e = sent('begin_checkout')
    expect(e).toHaveLength(1)
    expect(e[0].currency).toBe('USD'); expect(e[0].value).toBe(225)
    expect(e[0].items).toHaveLength(2)
    expect(e[0]).not.toHaveProperty('coupon')
  })
  test('begin_checkout with an unknown line price omits value (never a partial sum or 0)', () => {
    ga.initGa(ID)
    ga.gaBeginCheckout([{ slug: 'a', name: 'A', priceCents: 100, quantity: 1 }, { slug: 'b', name: 'B', priceCents: null, quantity: 1 }])
    expect(sent('begin_checkout')[0]).not.toHaveProperty('value')
  })
  test('begin_checkout with an empty cart sends nothing', () => { ga.initGa(ID); ga.gaBeginCheckout([]); expect(sent('begin_checkout')).toEqual([]) })

  // ── events are only sent from the places that earned them ──
  test('there is NO browser purchase: lib/ga-client exports no purchase sender', () => {
    expect(Object.keys(ga).filter(k => /purchase/i.test(k))).toEqual([])
    ga.initGa(ID)
    expect(sent('purchase')).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('consent withdrawn during the session stops GA', () => {
  test('accepted -> declined: the very next event is dropped (re-checked at call time) and GA is switched off', () => {
    setPrefs(true); ga.initGa(ID); ga.gaPageView()
    ga.gaViewItem({ slug: 'a', name: 'A', priceCents: 100 })
    expect(anyEvents()).toHaveLength(2)
    setPrefs(false)                                                    // the cookie-preferences store changes...
    ga.gaAddToCart({ slug: 'a', name: 'A', priceCents: 100, quantity: 1 })   // ...nothing calls disableGa explicitly
    goto('/shop'); ga.gaPageView()
    ga.gaBeginCheckout([{ slug: 'a', name: 'A', priceCents: 100, quantity: 1 }])
    expect(anyEvents()).toHaveLength(2)                                // no further GA activity at all
    expect((global as any).window['ga-disable-' + ID]).toBe(true)      // GA's own opt-out flag
    expect(ga.getGaIdentifiers()).toBeNull()
  })
  test('disableGa: denies consent mode, forgets dedupe state and ids, expires the _ga cookies', () => {
    setPrefs(true); cookieJar = '_ga=GA1.1.1.2; _ga_TEST123456=GS1.1.x; kvrn_cart=keep'
    ga.initGa(ID); ga.gaViewItem({ slug: 'a', name: 'A', priceCents: 100 })
    expect(session['kvrn_ga_viewed']).toBeDefined()
    ga.disableGa()
    expect(session['kvrn_ga_viewed']).toBeUndefined()
    const upd = layer().filter(a => a[0] === 'consent' && a[1] === 'update').pop()![2]
    expect(upd).toMatchObject({ analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' })
    const expired = cookieWrites.filter(c => /expires=Thu, 01 Jan 1970/.test(c)).map(c => c.split('=')[0])
    expect(expired).toEqual(expect.arrayContaining(['_ga', '_ga_TEST123456']))
    expect(expired).not.toContain('kvrn_cart')                         // only GA's cookies
  })
  test('DNT / GPC switched on mid-session stops GA the same way', () => {
    setPrefs(true); ga.initGa(ID); ga.gaPageView()
    env({ gpc: true }); (global as any).window.dataLayer = (global as any).window.dataLayer   // keep layer; flip the browser signal
    ga.gaViewItem({ slug: 'a', name: 'A', priceCents: 100 })
    expect(sent('view_item')).toEqual([])
  })
  test('re-granting consent re-enables GA without loading the script twice', () => {
    setPrefs(true); ga.initGa(ID)
    setPrefs(false); ga.gaViewItem({ slug: 'a', name: 'A', priceCents: 100 })
    expect(sent('view_item')).toEqual([])
    setPrefs(true)
    expect(ga.initGa(ID)).toBe(true)
    expect((global as any).window['ga-disable-' + ID]).toBe(false)
    ga.gaViewItem({ slug: 'a', name: 'A', priceCents: 100 })
    expect(sent('view_item')).toHaveLength(1)
    expect(scripts).toHaveLength(1)
  })
  test('disableGa before init is a harmless no-op', () => { expect(() => ga.disableGa()).not.toThrow(); expectCompletelyOff() })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('GA ids for the server-side purchase', () => {
  const answerGets = (client: unknown, sess: unknown) => {
    for (const a of layer().filter(a => a[0] === 'get')) {
      // The stub pushed the original `arguments`; invoke the callback the way gtag.js would.
      const raw = ((global as any).window.dataLayer as any[]).find(x => Array.from(x)[0] === 'get' && Array.from(x)[2] === a[2])
      const cb = Array.from(raw as any)[3] as (v: unknown) => void
      cb(a[2] === 'client_id' ? client : sess)
    }
  }
  test('not available until GA answers; then returned synchronously', () => {
    setPrefs(true); ga.initGa(ID); ga.gaPageView()
    expect(ga.getGaIdentifiers()).toBeNull()
    answerGets('1234567890.1696300000', '1696300000')
    expect(ga.getGaIdentifiers()).toEqual({ clientId: '1234567890.1696300000', sessionId: '1696300000' })
  })
  test('malformed ids from GA are rejected', () => {
    setPrefs(true); ga.initGa(ID); ga.gaPageView()
    answerGets('<script>', 'abc')
    expect(ga.getGaIdentifiers()).toBeNull()
  })
  test('never available without consent, and cleared when consent is withdrawn', () => {
    setPrefs(true); ga.initGa(ID); ga.gaPageView(); answerGets('1.2', '3')
    expect(ga.getGaIdentifiers()).not.toBeNull()
    setPrefs(false)
    expect(ga.getGaIdentifiers()).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('no PII ever reaches GA from the browser', () => {
  test('payloads contain only allowlisted item/event keys, whatever is passed in', () => {
    setPrefs(true); ga.initGa(ID)
    const evil: any = { slug: 'phantom-hoodie', name: 'Phantom Hoodie', sku: 'KVRN-PH-BLK-M', priceCents: 8000, quantity: 1,
                        email: 'a@b.com', phone: '+15551234567', address: '1 Test St', customerName: 'A Buyer', card: '4242' }
    ga.gaViewItem(evil); ga.gaAddToCart(evil); ga.gaBeginCheckout([evil])
    ga.gaEvent('sms_offer_view', { event_category: 'sms_popup', email: 'a@b.com' } as any)
    const all = JSON.stringify(anyEvents())
    for (const bad of ['a@b.com', '5551234567', 'Test St', 'A Buyer', '4242']) {
      if (bad === 'a@b.com') continue // handled just below: gaEvent forwards scalar params, see next test
      expect(all).not.toContain(bad)
    }
    for (const e of [...sent('view_item'), ...sent('add_to_cart'), ...sent('begin_checkout')]) {
      expect(Object.keys(e).sort()).toEqual(expect.arrayContaining(['currency', 'items']))
      expect(Object.keys(e).every(k => ['currency', 'value', 'items'].includes(k))).toBe(true)
      for (const it of e.items) {
        expect(Object.keys(it).every(k => ['item_id', 'item_name', 'item_variant', 'item_brand', 'price', 'quantity'].includes(k))).toBe(true)
      }
    }
  })
  test('gaEvent: only safe event/param names and scalar values; objects/arrays/odd names are dropped', () => {
    setPrefs(true); ga.initGa(ID)
    ga.gaEvent('Bad Name!', { a: 'x' })
    ga.gaEvent('ok_event', { good_param: 'x', 'Bad Param': 'y', nested: { a: 1 } as any, list: [1] as any, n: 3, b: true, nan: NaN })
    expect(sent('Bad Name!')).toEqual([])
    expect(sent('ok_event')).toEqual([{ good_param: 'x', n: 3, b: true }])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('source: nothing can load or feed Google before consent, and the secret never reaches the browser', () => {
  const ROOT = path.resolve(__dirname, '../..')
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name)
      if (e.isDirectory()) { if (!/node_modules|\.next|backup-before|__tests__/.test(rel)) walk(rel, out) }
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel)
    }
    return out
  }
  const SRC = ['app', 'components', 'context', 'lib'].flatMap(d => walk(d))

  test('the layout has no Google script, no gtag stub and no consent default: <GaTracker /> is the only entry', () => {
    const l = strip(read('app/layout.tsx'))
    expect(l).not.toMatch(/googletagmanager|google-analytics|gtag\(|gtag\/js|dataLayer/i)
    // Audit Revision 1: the id is RUNTIME config fetched by the tracker after consent — the layout
    // (inlined at build time) must neither read nor pass it.
    expect(l).toMatch(/<GaTracker \/>/)
    expect(l).not.toMatch(/measurementId|NEXT_PUBLIC_GA_MEASUREMENT_ID|normalizeMeasurementId/)
  })
  test('gtag.js is referenced in exactly one place: lib/ga-client.ts', () => {
    const hits = SRC.filter(f => /googletagmanager\.com\/gtag\/js/.test(strip(read(f))))
    expect(hits).toEqual(['lib/ga-client.ts'])
  })
  test('no file other than lib/ga-client.ts sends a GA event: window.gtag(\'event\' / gtag?.(\'event\' appear nowhere else', () => {
    const offenders = SRC.filter(f => f !== 'lib/ga-client.ts' && f !== 'components/ui/CookieBanner.tsx'
      && /gtag\??\.?\(\s*['"]event['"]/.test(strip(read(f))))
    expect(offenders).toEqual([])
  })
  test('the only other gtag callers are consent UPDATES (cookie preferences) and the unused legacy banner', () => {
    const callers = SRC.filter(f => /gtag\??\.?\(/.test(strip(read(f))) && f !== 'lib/ga-client.ts').sort()
    expect(callers).toEqual(['components/ui/CookieBanner.tsx', 'context/CookiePrefsContext.tsx'])
    for (const f of callers) expect(strip(read(f)).match(/gtag\??\.?\(\s*['"](\w+)['"]/g)!.every(m => /consent/.test(m))).toBe(true)
  })
  test('the SMS popup routes through the gated helper (no direct gtag)', () => {
    const s = strip(read('components/sms/SmsPopup.tsx'))
    expect(s).not.toMatch(/gtag/)
    expect(s).toMatch(/trackSmsEvent/)
  })
  test('the success page sends no GA purchase (the server is canonical, so a browser purchase cannot duplicate)', () => {
    const s = strip(read('app/checkout/success/page.tsx'))
    expect(s).not.toMatch(/gtag|ga-client|lib\/analytics|purchase/i)
  })
  test('GA4_MEASUREMENT_PROTOCOL_SECRET appears only in the server module (and the admin STATE helper inside it)', () => {
    const hits = SRC.filter(f => strip(read(f)).includes('GA4_MEASUREMENT_PROTOCOL_SECRET'))
    expect(hits).toEqual(['lib/ga4-server.ts'])
  })
  test('no client-reachable module imports the server GA module', () => {
    const importers = SRC.filter(f => /from ['"](@\/lib\/|\.\/|\.\.\/lib\/)ga4-server['"]/.test(read(f))).sort()
    expect(importers).toEqual(['app/admin/analytics/page.tsx', 'app/api/stripe/webhook/route.ts'])
    for (const f of importers) expect(read(f)).not.toMatch(/^['"]use client['"]/m)
    for (const f of ['lib/ga-client.ts', 'lib/ga-common.ts', 'lib/analytics.ts', 'components/analytics/GaTracker.tsx', 'app/admin/analytics/AnalyticsClient.tsx']) {
      expect(strip(read(f))).not.toMatch(/ga4-server|process\.env\.GA4_|API_SECRET|api_secret/)
    }
  })
  test('lib/ga-client.ts and ga-common.ts never reference utm_content or utm_term', () => {
    for (const f of ['lib/ga-client.ts', 'lib/ga-common.ts', 'components/analytics/GaTracker.tsx']) expect(strip(read(f))).not.toMatch(/utm_content|utm_term|['"]content['"]|['"]term['"]/)
  })
  test('GA UTM scope and token rule are identical to the first-party tracker\'s', () => {
    const fa = read('lib/funnel-analytics.ts')
    const m = fa.match(/const UTM_VALUE_RE = (\/.*\/)\n/)!
    expect(read('lib/ga-common.ts')).toContain(`export const GA_UTM_VALUE_RE = ${m[1]}`)
    expect(read('lib/ga-common.ts')).toMatch(/GA_UTM_PARAMS = \['utm_source', 'utm_medium', 'utm_campaign'\] as const/)
  })
  test('the GA and first-party trackers share ONE consent function (no second consent store)', () => {
    const c = strip(read('lib/ga-client.ts'))
    expect(c).toMatch(/import \{ analyticsConsentGranted \} from '\.\/funnel-client'/)
    expect(c).not.toMatch(/localStorage|kvrn_cookie|document\.cookie\s*=\s*['"`]kvrn/)
    expect(read('components/analytics/GaTracker.tsx')).toMatch(/useCookiePrefs\(\)/)
    // The effective-consent rule itself is ONE pure module shared by the context, funnel and GA.
    const shared = strip(read('lib/consent-effective.ts'))
    expect(shared).not.toMatch(/^\s*import /m)                       // no imports => no circular import possible
    expect(strip(read('lib/funnel-client.ts'))).toMatch(/from '\.\/consent-effective'/)
    expect(strip(read('lib/ga-client.ts'))).toMatch(/from '\.\/consent-effective'/)
    expect(strip(read('context/CookiePrefsContext.tsx'))).toMatch(/buildGtagConsentUpdate\(prefs\)/)
    expect(strip(read('context/CookiePrefsContext.tsx'))).not.toMatch(/analytics_storage:\s*prefs\.analytics/)
  })
  test('checkout page: begin_checkout fires only after the server returned a URL, never on click', () => {
    const p = read('app/checkout/page.tsx')
    const url = p.indexOf("if (!data.url) throw new Error('No checkout URL returned.')")
    const begin = p.indexOf('gaBeginCheckout(')
    const redirect = p.indexOf('window.location.href = data.url')
    expect(url).toBeGreaterThan(-1)
    expect(begin).toBeGreaterThan(url)
    expect(redirect).toBeGreaterThan(begin)
    expect(p.match(/gaBeginCheckout\(/g)).toHaveLength(1)
    expect(p.indexOf("if (!res.ok) {")).toBeLessThan(begin)       // failure paths return before it
    expect(strip(p)).not.toMatch(/ENABLE_CHECKOUT/)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// Audit Revision 1 / correction 1 — the measurement id is RUNTIME configuration, fetched only after
// effective consent. These drive the real lib/ga-client.ts (the code GaTracker delegates to).
describe('runtime measurement id (no build-time NEXT_PUBLIC dependency)', () => {
  const cfgOk = (id: unknown = ID) => jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ measurementId: id }) })) as any
  let savedEnv: string | undefined
  beforeEach(() => { savedEnv = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID; delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID })
  afterEach(() => { if (savedEnv === undefined) delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID; else process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = savedEnv })

  test('REGRESSION: build-time id ABSENT + runtime id present => a consenting browser still initialises GA', async () => {
    expect(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID).toBeUndefined()      // simulated build shell without the variable
    setPrefs(true)
    const f = cfgOk()
    await ga.syncGa(true, f)                                               // no id is passed in: only runtime config
    expect(f).toHaveBeenCalledTimes(1)
    expect(scripts).toHaveLength(1)
    expect(scripts[0].src).toBe(`https://www.googletagmanager.com/gtag/js?id=${ID}`)
    expect(layer().filter(a => a[0] === 'config')[0][1]).toBe(ID)
    expect(sent('page_view')).toHaveLength(1)
  })

  test('the request goes to the same-origin runtime route, as a plain no-store GET', async () => {
    setPrefs(true); const f = cfgOk()
    await ga.syncGa(true, f)
    expect(f).toHaveBeenCalledWith('/api/analytics/config', expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'same-origin' }))
    expect(ga.GA_CONFIG_ENDPOINT).toBe('/api/analytics/config')
  })

  test.each([
    ['no choice yet', () => {}],
    ['analytics declined', () => setPrefs(false)],
    ['an expired choice', () => setPrefs(true, Date.now() - 366 * 86_400_000)],
    ['DNT blocking an accepted choice', () => { setPrefs(true); env({ dnt: '1' }) }],
    ['GPC blocking an accepted choice', () => { setPrefs(true); env({ gpc: true }) }],
  ])('NOTHING is fetched before effective consent (%s): no config request, no GA', async (_n, arrange) => {
    arrange()
    const f = cfgOk()
    await ga.syncGa(true, f); await ga.syncGa(false, f); await ga.syncGa(null, f)
    expect(await ga.ensureGaRuntimeId(f)).toBeNull()
    expect(f).not.toHaveBeenCalled()
    expectCompletelyOff()
  })

  test('preferences not read yet (null) never fetches, even with consent already stored', async () => {
    setPrefs(true); const f = cfgOk()
    await ga.syncGa(null, f)
    expect(f).not.toHaveBeenCalled(); expectCompletelyOff()
  })

  test('idempotent: repeated syncs and route changes give ONE config request, ONE script, ONE config call, ONE page_view per path', async () => {
    setPrefs(true); const f = cfgOk()
    await ga.syncGa(true, f); await ga.syncGa(true, f); await ga.syncGa(true, f)
    expect(f).toHaveBeenCalledTimes(1)
    expect(scripts).toHaveLength(1)
    expect(layer().filter(a => a[0] === 'config')).toHaveLength(1)
    expect(sent('page_view')).toHaveLength(1)
    goto('/shop'); await ga.syncGa(true, f)
    expect(f).toHaveBeenCalledTimes(1)                                      // cached for the page lifetime
    expect(sent('page_view')).toHaveLength(2)
    expect(scripts).toHaveLength(1)
  })

  test('concurrent callers share one in-flight request', async () => {
    setPrefs(true); let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const f = jest.fn(async () => { await gate; return { ok: true, status: 200, json: async () => ({ measurementId: ID }) } }) as any
    const all = Promise.all([ga.syncGa(true, f), ga.syncGa(true, f), ga.syncGa(true, f)])
    release(); await all
    expect(f).toHaveBeenCalledTimes(1)
    expect(scripts).toHaveLength(1)
    expect(layer().filter(a => a[0] === 'config')).toHaveLength(1)
  })

  test('the server saying "GA not configured" keeps GA off and is remembered (no re-ask on every navigation)', async () => {
    setPrefs(true); const f = cfgOk(null)
    await ga.syncGa(true, f); goto('/shop'); await ga.syncGa(true, f)
    expect(f).toHaveBeenCalledTimes(1)
    expectCompletelyOff()
  })

  test.each([
    ['a malformed id', cfgOk('UA-123-1')],
    ['a script-injection attempt', cfgOk('G-ABC123"></script><script>x')],
    ['a non-string id', cfgOk({ evil: 1 })],
    ['HTTP 500', jest.fn(async () => ({ ok: false, status: 500, json: async () => ({ measurementId: ID }) })) as any],
    ['unparseable JSON', jest.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x') } })) as any],
    ['a network error', jest.fn(async () => { throw new TypeError('fetch failed') }) as any],
    ['a null body', jest.fn(async () => ({ ok: true, status: 200, json: async () => null })) as any],
  ])('%s from the config route: GA stays off and nothing throws', async (_n, f) => {
    setPrefs(true)
    await expect(ga.syncGa(true, f)).resolves.toBeUndefined()
    expectCompletelyOff()
  })

  test('a failed config request is NOT cached: the next navigation retries and can succeed', async () => {
    setPrefs(true)
    const bad = jest.fn(async () => { throw new TypeError('offline') }) as any
    await ga.syncGa(true, bad)
    expectCompletelyOff()
    const good = cfgOk()
    await ga.syncGa(true, good)
    expect(good).toHaveBeenCalledTimes(1)
    expect(scripts).toHaveLength(1)
  })

  test('consent withdrawn WHILE the config request is in flight: GA is never initialised', async () => {
    setPrefs(true)
    const f = jest.fn(async () => { setPrefs(false); return { ok: true, status: 200, json: async () => ({ measurementId: ID }) } }) as any
    await ga.syncGa(true, f)
    expectCompletelyOff()
  })

  test('DNT appearing WHILE the config request is in flight: GA is never initialised', async () => {
    setPrefs(true)
    const f = jest.fn(async () => { env({ dnt: '1' }); return { ok: true, status: 200, json: async () => ({ measurementId: ID }) } }) as any
    await ga.syncGa(true, f)
    expectCompletelyOff()
  })

  test('admin routes never fetch config and never init', async () => {
    env({ path: '/admin/analytics' }); setPrefs(true)
    const f = cfgOk()
    await ga.syncGa(true, f)
    expect(scripts).toEqual([]); expect(anyEvents()).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Audit Revision 1 / correction 2 — EFFECTIVE consent (preference AND no DNT AND no GPC) governs
// both the Consent Mode update and the tracker. A stored "yes" can never grant GA through an opt-out.
describe('effective consent: DNT / GPC can never be overridden by a stored "yes"', () => {
  const cfgOk = () => jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ measurementId: ID }) })) as any
  let consent: typeof import('../consent-effective')
  beforeAll(async () => { consent = await import('../consent-effective') })
  /** Flip the browser opt-out signals on the SAME live window (a real DNT/GPC change does not replace window/gtag). */
  const signals = (o: { dnt?: string | null; gpc?: boolean }) => {
    const n = (global as any).window.navigator; n.doNotTrack = o.dnt ?? null; n.globalPrivacyControl = o.gpc
  }
  const updates = () => layer().filter(a => a[0] === 'consent' && a[1] === 'update').map(a => a[2])
  /** What CookiePrefsContext.applyToGtag does: push buildGtagConsentUpdate(prefs) to gtag. */
  const applyToGtag = (prefs: { analytics: boolean; personalization: boolean }) => {
    const win = (global as any).window
    if (typeof win.gtag === 'function') win.gtag('consent', 'update', consent.buildGtagConsentUpdate(prefs))
  }

  test('the pure rule', () => {
    const E = consent.effectiveAnalyticsConsent
    expect(E(true, { doNotTrack: null })).toBe(true)
    expect(E(true, { doNotTrack: '1' })).toBe(false)
    expect(E(true, { globalPrivacyControl: true })).toBe(false)
    expect(E(true, { doNotTrack: '1', globalPrivacyControl: true })).toBe(false)
    expect(E(false, {})).toBe(false)
    for (const v of ['yes', 1, null, undefined, {}]) expect(E(v, {})).toBe(false)     // strictly === true
    expect(E(true, { doNotTrack: '0', globalPrivacyControl: false })).toBe(true)
  })

  test('(a) pref true + DNT: the Consent Mode update is analytics DENIED, never granted', () => {
    setPrefs(true); env({ dnt: '1' })
    expect(consent.buildGtagConsentUpdate({ analytics: true, personalization: true }, (global as any).window.navigator).analytics_storage).toBe('denied')
    // Same result through the default (window.navigator) path the context uses:
    expect(consent.buildGtagConsentUpdate({ analytics: true, personalization: true }).analytics_storage).toBe('denied')
  })
  test('(b) pref true + GPC: the same', () => {
    setPrefs(true); env({ gpc: true })
    expect(consent.buildGtagConsentUpdate({ analytics: true, personalization: false }).analytics_storage).toBe('denied')
  })
  test('(d) normal accepted analytics with no override: granted, advertising still denied, other signals unchanged', () => {
    setPrefs(true)
    expect(consent.buildGtagConsentUpdate({ analytics: true, personalization: true })).toEqual({
      analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
      personalization_storage: 'granted', functionality_storage: 'granted',
    })
    expect(consent.buildGtagConsentUpdate({ analytics: false, personalization: false })).toEqual({
      analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
      personalization_storage: 'denied', functionality_storage: 'granted',
    })
    // "Targeted advertising" can never grant a Google advertising signal.
    expect(consent.buildGtagConsentUpdate({ analytics: true, personalization: true, advertising: true } as any).ad_storage).toBe('denied')
  })

  test('(a) GA already initialised, DNT turns on, user saves analytics=true: no granted update reaches GA, GA is off', async () => {
    setPrefs(true); const f = cfgOk()
    await ga.syncGa(true, f)
    expect(ga.gaActive()).toBe(true)
    signals({ dnt: '1' })                                                // the opt-out appears; the stored pref is still "yes"
    applyToGtag({ analytics: true, personalization: true })              // "Save preferences" with analytics ON
    await ga.syncGa(true, f)                                             // tracker reacts to the pref change
    expect(updates().some(u => u.analytics_storage === 'granted' && updates().indexOf(u) > 0)).toBe(false)
    expect(updates().pop()).toMatchObject({ analytics_storage: 'denied' })
    expect((global as any).window['ga-disable-' + ID]).toBe(true)
    expect(ga.gaActive()).toBe(false)
  })

  test.each([
    ['DNT', () => signals({ dnt: '1' })],
    ['GPC', () => signals({ gpc: true })],
  ])('(c) GA active, then %s becomes effective: the tracker disables GA IMMEDIATELY and no later event can leave GA active', async (_n, flip) => {
    setPrefs(true); const f = cfgOk()
    await ga.syncGa(true, f)
    ga.gaViewItem({ slug: 'a', name: 'A', priceCents: 100 })
    const before = anyEvents().length
    expect(before).toBeGreaterThan(0)
    flip()
    // The stored preference is STILL true; only the browser signal changed. No event has been sent yet.
    await ga.syncGa(true, f)                                              // <- the immediate shutdown under test
    expect((global as any).window['ga-disable-' + ID]).toBe(true)
    expect(updates().pop()).toMatchObject({ analytics_storage: 'denied', ad_storage: 'denied' })
    // Now every kind of event: all dropped.
    goto('/shop')
    ga.gaPageView()
    ga.gaViewItem({ slug: 'b', name: 'B', priceCents: 100 })
    ga.gaAddToCart({ slug: 'b', name: 'B', priceCents: 100, quantity: 1 })
    ga.gaBeginCheckout([{ slug: 'b', name: 'B', priceCents: 100, quantity: 1 }])
    ga.gaEvent('sms_offer_view', { event_category: 'sms_popup' })
    await ga.syncGa(true, f)
    expect(anyEvents()).toHaveLength(before)
    expect(ga.gaActive()).toBe(false)
    expect(ga.getGaIdentifiers()).toBeNull()                              // no ids for a server purchase either
    expect(updates().filter(u => u.analytics_storage === 'granted')).toEqual([])   // nothing ever re-granted (see below)
  })

  test('when the opt-out goes away again, the stored "yes" works again (re-enabled, script not loaded twice)', async () => {
    setPrefs(true); const f = cfgOk()
    await ga.syncGa(true, f)
    signals({ dnt: '1' })
    await ga.syncGa(true, f)
    expect(ga.gaActive()).toBe(false)
    signals({})
    await ga.syncGa(true, f)
    expect((global as any).window['ga-disable-' + ID]).toBe(false)
    expect(scripts).toHaveLength(1)
    ga.gaViewItem({ slug: 'z', name: 'Z', priceCents: 100 })
    expect(sent('view_item')).toHaveLength(1)
  })

  test('(d) accepted, no override: normal initialisation and page_view still happen', async () => {
    setPrefs(true); const f = cfgOk()
    await ga.syncGa(true, f)
    expect(ga.gaActive()).toBe(true)
    expect(layer().find(a => a[0] === 'consent' && a[1] === 'default')![2]).toMatchObject({ analytics_storage: 'granted', ad_storage: 'denied' })
    expect(sent('page_view')).toHaveLength(1)
  })

  test('declined (pref false): an already-running GA is shut down by the tracker', async () => {
    setPrefs(true); const f = cfgOk()
    await ga.syncGa(true, f)
    setPrefs(false)
    await ga.syncGa(false, f)
    expect((global as any).window['ga-disable-' + ID]).toBe(true)
    expect(ga.gaActive()).toBe(false)
  })

  test('source: GaTracker takes no id prop, calls syncGa on pref/route changes, and keeps the cross-tab shutdown', () => {
    const t = fs.readFileSync(path.resolve(__dirname, '../../components/analytics/GaTracker.tsx'), 'utf8').replace(/\/\/.*$/gm, '')
    expect(t).toMatch(/export function GaTracker\(\)/)
    expect(t).toMatch(/syncGa\(pref\)/)
    expect(t).not.toMatch(/measurementId|NEXT_PUBLIC/)
    expect(t).toMatch(/addEventListener\('storage'/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Audit Revision 2 / issue 1 — the post-consent initialisation window.
//
// A visitor accepts analytics while staying on a product page: the PDP effect fires view_item at once,
// while GA is still fetching /api/analytics/config. Consent HAS been granted; only init is pending.
// runWhenGaReady / gaViewItemWhenReady / gaAddToCartWhenReady survive that window — and never hold
// anything before consent (no queue, no dataLayer, no storage).
describe('post-consent readiness (view_item / add_to_cart right after consent)', () => {
  const PRODUCT = { slug: 'phantom-hoodie', name: 'Phantom Hoodie', priceCents: 8000 }
  const LINE = { slug: 'phantom-hoodie', name: 'Phantom Hoodie', sku: 'KVRN-PH-BLK-M', priceCents: 8000, quantity: 2 }
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)) }
  /** A runtime-config fetch that stays unresolved until release() — the init window under test. */
  const pendingConfig = () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const f = jest.fn(async () => { await gate; return { ok: true, status: 200, json: async () => ({ measurementId: ID }) } }) as any
    return { f, release }
  }
  const signals = (o: { dnt?: string | null; gpc?: boolean }) => {
    const n = (global as any).window.navigator; n.doNotTrack = o.dnt ?? null; n.globalPrivacyControl = o.gpc
  }
  const names = () => anyEvents().map(a => a[1])
  let savedEnv: string | undefined
  beforeEach(() => { savedEnv = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID; delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID })
  afterEach(() => { if (savedEnv !== undefined) process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = savedEnv })

  test('(a) view_item right after consent while the config fetch is unresolved: after it resolves, exactly one page_view then one view_item', async () => {
    setPrefs(true)                                         // the visitor just accepted
    const { f, release } = pendingConfig()
    void ga.syncGa(true, f)                                // GaTracker's effect
    ga.gaViewItemWhenReady(PRODUCT, f)                     // PDPClient's effect, same tick
    // Still in the init window: GA exists nowhere yet — nothing queued, nothing in the data layer.
    expect((global as any).window.dataLayer).toBeUndefined()
    expect((global as any).window.gtag).toBeUndefined()
    expect(scripts).toEqual([]); expect(f).toHaveBeenCalledTimes(1)        // one shared config request
    release(); await flush()
    expect(sent('page_view')).toHaveLength(1)
    expect(sent('view_item')).toHaveLength(1)
    expect(names().filter(n => n === 'page_view' || n === 'view_item')).toEqual(['page_view', 'view_item'])   // page_view FIRST
    expect(sent('view_item')[0]).toMatchObject({ currency: 'USD', value: 80, items: [{ item_id: 'phantom-hoodie' }] })
    expect(sent('view_item')[0].items[0]).not.toHaveProperty('item_variant')      // product-level, as before
    expect(scripts).toHaveLength(1); expect(layer().filter(a => a[0] === 'config')).toHaveLength(1)
  })

  test('(a) the same result without GaTracker involved, and with the tracker finishing AFTER the PDP', async () => {
    setPrefs(true)
    const one = pendingConfig(); ga.gaViewItemWhenReady(PRODUCT, one.f); one.release(); await flush()
    expect(names().filter(n => n === 'page_view' || n === 'view_item')).toEqual(['page_view', 'view_item'])
    await ga.syncGa(true, one.f)                            // the tracker arrives late: nothing is duplicated
    expect(sent('page_view')).toHaveLength(1); expect(sent('view_item')).toHaveLength(1)
  })

  test('already ready: runs synchronously (no extra request) and the route page_view is guaranteed to precede it', async () => {
    setPrefs(true); ga.initGa(ID)
    const f = pendingConfig().f
    ga.gaViewItemWhenReady(PRODUCT, f)
    expect(f).not.toHaveBeenCalled()
    expect(names().filter(n => n === 'page_view' || n === 'view_item')).toEqual(['page_view', 'view_item'])
  })

  test.each([
    ['no choice yet', () => {}],
    ['declined', () => setPrefs(false)],
    ['an expired choice', () => setPrefs(true, Date.now() - 366 * 86_400_000)],
    ['DNT', () => { setPrefs(true); signals({ dnt: '1' }) }],
    ['GPC', () => { setPrefs(true); signals({ gpc: true }) }],
  ])('(b) %s: the config is NOT fetched and no event is ever emitted, now or later', async (_n, arrange) => {
    arrange()
    const { f, release } = pendingConfig()
    ga.gaViewItemWhenReady(PRODUCT, f); ga.gaAddToCartWhenReady(LINE, f); ga.gaEventWhenReady('sms_offer_view', { event_category: 'sms_popup' }, f)
    release(); await flush()
    expect(f).not.toHaveBeenCalled()
    expectCompletelyOff()
  })

  test('(b) nothing is queued before consent: events requested pre-consent are dropped, not replayed when consent arrives', async () => {
    const { f, release } = pendingConfig()
    ga.gaViewItemWhenReady(PRODUCT, f); ga.gaAddToCartWhenReady(LINE, f)   // no consent yet
    setPrefs(true); release()
    await ga.syncGa(true, f); await flush()                                // consent granted afterwards
    expect(sent('view_item')).toEqual([]); expect(sent('add_to_cart')).toEqual([])
    expect(sent('page_view')).toHaveLength(1)                              // only the tracker's own page_view
    expect(session).toEqual({ })                                           // not even the dedupe key was written for the dropped events
  })

  test('(c) repeated calls and re-renders while readiness is pending: exactly one view_item', async () => {
    setPrefs(true)
    const { f, release } = pendingConfig()
    for (let i = 0; i < 6; i++) ga.gaViewItemWhenReady(PRODUCT, f)         // effect re-runs / strict-mode double effect
    void ga.syncGa(true, f); void ga.syncGa(true, f)
    expect(f).toHaveBeenCalledTimes(1)
    release(); await flush()
    ga.gaViewItemWhenReady(PRODUCT, f)                                     // and once more after ready
    expect(sent('view_item')).toHaveLength(1)
    expect(sent('page_view')).toHaveLength(1)
    ga.gaViewItemWhenReady({ slug: 'phantom-sweatpants', name: 'Phantom Sweatpants', priceCents: 6000 }, f)
    expect(sent('view_item')).toHaveLength(2)                              // a different product is its own once
  })

  test('(d) add_to_cart right after consent is sent exactly once when GA becomes ready, with the actual quantity', async () => {
    setPrefs(true)
    const { f, release } = pendingConfig()
    ga.gaAddToCartWhenReady(LINE, f)
    expect(anyEvents()).toEqual([])
    release(); await flush()
    expect(names().filter(n => n === 'page_view' || n === 'add_to_cart')).toEqual(['page_view', 'add_to_cart'])
    expect(sent('add_to_cart')).toHaveLength(1)
    expect(sent('add_to_cart')[0]).toMatchObject({ currency: 'USD', value: 160, items: [{ item_id: 'phantom-hoodie', item_variant: 'KVRN-PH-BLK-M', quantity: 2 }] })
    await ga.syncGa(true, f); await flush()
    expect(sent('add_to_cart')).toHaveLength(1)                            // the tracker finishing later does not repeat it
  })
  test('(d) two genuine adds are two events — one per call, never doubled', async () => {
    setPrefs(true)
    const { f, release } = pendingConfig()
    ga.gaAddToCartWhenReady({ ...LINE, quantity: 1 }, f); ga.gaAddToCartWhenReady({ ...LINE, quantity: 3 }, f)
    release(); await flush()
    expect(sent('add_to_cart').map(e => e.items[0].quantity)).toEqual([1, 3])
  })

  test('(e) consent revoked while the config request is in flight: no event is emitted afterwards', async () => {
    setPrefs(true)
    const { f, release } = pendingConfig()
    void ga.syncGa(true, f)
    ga.gaViewItemWhenReady(PRODUCT, f); ga.gaAddToCartWhenReady(LINE, f); ga.gaEventWhenReady('sms_offer_view', { event_category: 'sms_popup' }, f)
    setPrefs(false)                                                        // withdrawn during the wait
    release(); await flush()
    expectCompletelyOff()
  })
  test.each([
    ['DNT', () => signals({ dnt: '1' })],
    ['GPC', () => signals({ gpc: true })],
  ])('(e) %s turning on while the config request is in flight: no event, GA never initialised', async (_n, flip) => {
    setPrefs(true)
    const { f, release } = pendingConfig()
    ga.gaViewItemWhenReady(PRODUCT, f)
    flip(); release(); await flush()
    expectCompletelyOff()
  })
  test('(e) consent revoked after GA became ready but before a pending send runs: the send re-checks and drops', async () => {
    setPrefs(true)
    const { f, release } = pendingConfig()
    ga.gaViewItemWhenReady(PRODUCT, f)
    release()
    await Promise.resolve()                                                // let init start...
    await flush()
    const before = anyEvents().length
    setPrefs(false)
    ga.gaViewItemWhenReady({ slug: 'x', name: 'X', priceCents: 1 }, f)
    await flush()
    expect(anyEvents()).toHaveLength(before)
  })

  test('a failed config request just drops the pending event (best-effort, never throws, nothing stored)', async () => {
    setPrefs(true)
    const bad = jest.fn(async () => { throw new TypeError('offline') }) as any
    expect(() => ga.gaViewItemWhenReady(PRODUCT, bad)).not.toThrow()
    await flush()
    expectCompletelyOff()
  })

  test('checkout never waits for GA: gaBeginCheckout stays synchronous (not-ready = dropped), triggers no config request, and nothing on the checkout path uses the readiness helpers', () => {
    setPrefs(true)
    const f = pendingConfig().f
    const out = ga.gaBeginCheckout([{ slug: 'a', name: 'A', priceCents: 100, quantity: 1 }])
    expect(out).toBeUndefined()
    expect(f).not.toHaveBeenCalled()
    expect(anyEvents()).toEqual([])
    const ROOT = path.resolve(__dirname, '../..')
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const file of ['app/checkout/page.tsx', 'lib/checkout-session-handler.ts', 'app/api/stripe/webhook/route.ts', 'lib/ga4-server.ts']) {
      expect(strip(fs.readFileSync(path.join(ROOT, file), 'utf8'))).not.toMatch(/WhenReady|runWhenGaReady|ensureGaReady/)
    }
  })

  test('source: the PDP and the cart use the readiness variants; the helper never writes the data layer or storage itself', () => {
    const ROOT = path.resolve(__dirname, '../..')
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(strip(fs.readFileSync(path.join(ROOT, 'app/products/[slug]/PDPClient.tsx'), 'utf8'))).toMatch(/gaViewItemWhenReady\(/)
    expect(strip(fs.readFileSync(path.join(ROOT, 'context/CartContext.tsx'), 'utf8'))).toMatch(/gaAddToCartWhenReady\(/)
    const c = strip(fs.readFileSync(path.join(ROOT, 'lib/ga-client.ts'), 'utf8'))
    const fn = c.slice(c.indexOf('export function runWhenGaReady'), c.indexOf('export async function syncGa'))
    expect(fn).not.toMatch(/dataLayer|sessionStorage|localStorage|\.push\(|gtag/)
    expect(fn.indexOf('analyticsConsentGranted()')).toBeLessThan(fn.indexOf('ensureGaReady('))
  })
})
