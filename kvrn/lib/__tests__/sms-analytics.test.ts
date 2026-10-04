// lib/__tests__/sms-analytics.test.ts
//
// Audit Revision 2 / issue 2: the SMS popup's GA events. The declared contract (SmsAnalyticsEvent in
// lib/analytics.ts) and the names actually emitted must be the same set, with no cast in between;
// the manual sign-up lifecycle emits the right names; and nothing sensitive can ride in the params.

import fs from 'fs'
import path from 'path'

jest.mock('@/context/CookiePrefsContext', () => ({
  STORAGE_KEY: 'kvrn_cookie_prefs_v2', COOKIE_PREFS_EXPIRY_MS: 365 * 24 * 60 * 60 * 1000,
}))

import { trackSmsEvent, type SmsAnalyticsEvent } from '../analytics'
import { submitSmsSignup } from '../sms-signup'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** The declared union, parsed from the source of truth. */
const DECLARED: string[] = [...strip(read('lib/analytics.ts')).slice(strip(read('lib/analytics.ts')).indexOf('export type SmsAnalyticsEvent'))
  .split('export function')[0].matchAll(/'(sms_[a-z_]+)'/g)].map(m => m[1])

// ═════════════════════════════════════════════════════════════════════════════
describe('declared contract == emitted names (no cast between them)', () => {
  const popup = strip(read('components/sms/SmsPopup.tsx'))
  const signup = strip(read('lib/sms-signup.ts'))

  test('the declared canonical set', () => {
    expect([...DECLARED].sort()).toEqual([
      'sms_deeplink_open', 'sms_manual_submit', 'sms_offer_accept', 'sms_offer_decline',
      'sms_offer_reopen', 'sms_offer_view', 'sms_signup_error', 'sms_signup_success',
    ])
  })

  test('SmsPopup has no cast through which an arbitrary string could reach trackSmsEvent', () => {
    expect(popup).not.toMatch(/as SmsAnalyticsEvent/)
    expect(popup).not.toMatch(/trackSmsEvent\([^)]*\bas\b/)
    expect(popup).not.toMatch(/\bas any\b/)
    // The wrapper takes the declared union, not string.
    expect(popup).toMatch(/function track\(e: SmsAnalyticsEvent\)/)
    expect(popup).not.toMatch(/function track\(e: string\)/)
    expect(popup).not.toMatch(/gtag/)                          // and never reaches gtag directly
  })

  test('compile-time: an undeclared name (the old ones) is rejected by the type system', () => {
    // ts-jest type-checks this file; if the union ever widened to string these directives would fail the build.
    // @ts-expect-error — not a declared SmsAnalyticsEvent
    const a = () => trackSmsEvent('sms_popup_shown')
    // @ts-expect-error — not a declared SmsAnalyticsEvent
    const b = () => trackSmsEvent('sms_manual_subscribed')
    // @ts-expect-error — not a string-accepting function
    const c = () => trackSmsEvent('anything' as string)
    void a; void b; void c
    const ok: SmsAnalyticsEvent = 'sms_offer_view'; expect(ok).toBe('sms_offer_view')
  })

  test('every event name emitted anywhere in the SMS code belongs to SmsAnalyticsEvent', () => {
    const emitted = [...popup.matchAll(/\btrack\('([^']+)'\)/g), ...signup.matchAll(/\btrack\('([^']+)'\)/g)].map(m => m[1])
    expect(emitted.length).toBeGreaterThanOrEqual(7)
    for (const n of emitted) expect(DECLARED).toContain(n)
    // Nothing else sms_* is invented in any component/lib (the old, undeclared names are gone).
    for (const f of ['components/sms/SmsPopup.tsx', 'lib/sms-signup.ts', 'components/sms/ConditionalSmsPopup.tsx']) {
      for (const m of strip(read(f)).matchAll(/'(sms_[a-z_]+)'/g)) expect(DECLARED).toContain(m[1])
    }
    for (const old of ['sms_popup_shown', 'sms_popup_dismissed', 'sms_tab_opened', 'sms_manual_subscribed']) {
      expect(popup + signup).not.toContain(old)
    }
  })

  test('the declared set and the emitted set are the same, except the one documented reserved name: sms_offer_accept', () => {
    const emitted = new Set([...popup.matchAll(/\btrack\('([^']+)'\)/g), ...signup.matchAll(/\btrack\('([^']+)'\)/g)].map(m => m[1]))
    expect(DECLARED.filter(n => !emitted.has(n))).toEqual(['sms_offer_accept'])
    expect(read('lib/analytics.ts')).toMatch(/sms_offer_accept\s+RESERVED — declared but intentionally NOT emitted/)
  })

  test('each canonical event is emitted from the right interaction', () => {
    // shown
    expect(popup).toMatch(/setVisible\(true\); setShowTab\(true\); track\('sms_offer_view'\)/)
    // dismiss / decline — but not when closing the "You're in" screen
    const dismiss = popup.slice(popup.indexOf('const dismiss = useCallback'), popup.indexOf('const onDeeplink'))
    expect(dismiss).toMatch(/if \(!signedUpRef\.current\) track\('sms_offer_decline'\)/)
    // deep link
    expect(popup.slice(popup.indexOf('const onDeeplink'), popup.indexOf('const handleSubmit'))).toMatch(/track\('sms_deeplink_open'\)/)
    // reopen tab
    expect(popup).toMatch(/const open = \(\) => \{ setVisible\(true\); track\('sms_offer_reopen'\) \}/)
    // manual lifecycle is delegated to the tested function, with the SAME gated tracker
    expect(popup).toMatch(/submitSmsSignup\(phone, 'homepage', \{ track \}\)/)
    // no fabricated accept
    expect(popup + signup).not.toMatch(/track\('sms_offer_accept'\)/)
  })

  test('submit is only tracked once validation passed (not for an empty phone / missing consent)', () => {
    const h = popup.slice(popup.indexOf('const handleSubmit'), popup.indexOf('const handleCopy'))
    expect(h.indexOf("if (!phone.trim())")).toBeLessThan(h.indexOf('submitSmsSignup('))
    expect(h.indexOf("if (!smsConsent)")).toBeLessThan(h.indexOf('submitSmsSignup('))
    expect(h).not.toMatch(/track\(/)                              // the lifecycle lives in lib/sms-signup only
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('manual sign-up lifecycle emits the canonical names, in order', () => {
  const PHONE = '+15551234567'
  const mkFetch = (impl: () => Promise<any>) => jest.fn(impl) as any
  const run = async (fetchImpl: any) => {
    const order: string[] = []
    const track = jest.fn((e: SmsAnalyticsEvent) => { order.push('track:' + e) })
    const wrapped = jest.fn(async (...a: any[]) => { order.push('fetch'); return fetchImpl(...a) }) as any
    const result = await submitSmsSignup(`  ${PHONE}  `, 'homepage', { track, fetchImpl: wrapped })
    return { result, order, track }
  }

  test('success: sms_manual_submit (before the request) -> sms_signup_success', async () => {
    const { result, order, track } = await run(mkFetch(async () => ({ ok: true, json: async () => ({ success: true, discountCode: 'WELCOME10' }) })))
    expect(order).toEqual(['track:sms_manual_submit', 'fetch', 'track:sms_signup_success'])
    expect(result).toEqual({ ok: true, discountCode: 'WELCOME10' })
    expect(track.mock.calls.map(c => c[0])).toEqual(['sms_manual_submit', 'sms_signup_success'])
  })
  test('success without a discount code is still a success', async () => {
    const { result, track } = await run(mkFetch(async () => ({ ok: true, json: async () => ({ success: true }) })))
    expect(result).toEqual({ ok: true, discountCode: null })
    expect(track.mock.calls.map(c => c[0])).toEqual(['sms_manual_submit', 'sms_signup_success'])
  })
  test.each([
    ['an HTTP error with a message', async () => ({ ok: false, status: 400, json: async () => ({ success: false, error: 'Invalid phone number.' }) }), 'Invalid phone number.'],
    ['an HTTP 500', async () => ({ ok: false, status: 500, json: async () => ({}) }), 'Could not sign up. Please try again.'],
    ['a 200 with success:false', async () => ({ ok: true, json: async () => ({ success: false }) }), 'Could not sign up. Please try again.'],
    ['a network failure', async () => { throw new TypeError('fetch failed') }, 'Network error. Please try again.'],
    ['an unparseable response', async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token') } }), 'Network error. Please try again.'],
  ])('%s: sms_manual_submit -> sms_signup_error (never success)', async (_n, impl, message) => {
    const { result, track } = await run(mkFetch(impl as any))
    expect(track.mock.calls.map(c => c[0])).toEqual(['sms_manual_submit', 'sms_signup_error'])
    expect(result).toEqual({ ok: false, error: message })
  })
  test('the tracker is only ever handed the event NAME — one argument, no params', async () => {
    const { track } = await run(mkFetch(async () => ({ ok: true, json: async () => ({ success: true, discountCode: 'WELCOME10' }) })))
    for (const c of track.mock.calls) expect(c).toHaveLength(1)
    expect(JSON.stringify(track.mock.calls)).not.toMatch(/5551234567|WELCOME10/)
  })
  test('the request itself is unchanged (same endpoint, JSON body with the trimmed phone and source)', async () => {
    const f = mkFetch(async () => ({ ok: true, json: async () => ({ success: true }) }))
    await run(f)
    const [url, init] = (f as jest.Mock).mock.calls[0]
    expect(url).toBe('/api/sms/subscribe'); expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ phone: PHONE, source: 'homepage' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Through the REAL consent-gated GA client: names reach GA, params carry nothing sensitive.
describe('through the real GA client: consent-gated, no PII / discount code in params', () => {
  const KEY = 'kvrn_cookie_prefs_v2'
  const ID = 'G-TEST123456'
  let ga: typeof import('../ga-client')
  let local: Record<string, string>
  let scripts: any[]
  const store = (m: Record<string, string>) => ({
    getItem: (k: string) => (k in m ? m[k] : null), setItem: (k: string, v: string) => { m[k] = v }, removeItem: (k: string) => { delete m[k] },
  })
  const mkEnv = (o: { dnt?: string | null } = {}) => {
    ;(global as any).window = {
      localStorage: store(local), sessionStorage: store({}),
      navigator: { doNotTrack: o.dnt ?? null }, location: { pathname: '/', search: '', origin: 'https://kvrn.shop', hostname: 'www.kvrn.shop' },
    }
    ;(global as any).document = {
      referrer: '', head: { appendChild: (el: any) => scripts.push(el) },
      getElementById: (id: string) => scripts.find(s => s.id === id) ?? null, createElement: () => ({}),
    }
    Object.defineProperty((global as any).document, 'cookie', { get: () => '', set: () => {} })
  }
  /** The SMS events (the route's own page_view, which GA sends before the first event, is not one of them). */
  const events = () => (((global as any).window.dataLayer ?? []) as any[]).map(a => Array.from(a)).filter(a => a[0] === 'event' && a[1] !== 'page_view')
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)) }
  beforeAll(async () => { ga = await import('../ga-client') })
  beforeEach(() => { local = {}; scripts = []; mkEnv(); ga.__resetGaStateForTests() })
  afterEach(() => { delete (global as any).window; delete (global as any).document })

  const ALL: SmsAnalyticsEvent[] = ['sms_offer_view', 'sms_offer_decline', 'sms_offer_reopen', 'sms_deeplink_open', 'sms_manual_submit', 'sms_signup_success', 'sms_signup_error']

  test('with consent every canonical event reaches GA with ONLY event_category', () => {
    local[KEY] = JSON.stringify({ prefs: { analytics: true }, ts: Date.now() }); ga.initGa(ID)
    for (const e of ALL) trackSmsEvent(e)
    expect(events().map(a => a[1])).toEqual(ALL)
    for (const a of events()) expect(a[2]).toEqual({ event_category: 'sms_popup' })
  })

  test('without consent (or with DNT) nothing is emitted and GA is not even loaded', async () => {
    for (const arrange of [() => {}, () => { local[KEY] = JSON.stringify({ prefs: { analytics: false }, ts: Date.now() }) },
                           () => { local[KEY] = JSON.stringify({ prefs: { analytics: true }, ts: Date.now() }); mkEnv({ dnt: '1' }) }]) {
      local = {}; scripts = []; mkEnv(); ga.__resetGaStateForTests(); arrange()
      for (const e of ALL) trackSmsEvent(e)
      await flush()
      expect((global as any).window.dataLayer).toBeUndefined(); expect(scripts).toEqual([])
    }
  })

  test('the whole manual flow with a real phone number and discount code: neither appears anywhere GA could see', async () => {
    local[KEY] = JSON.stringify({ prefs: { analytics: true }, ts: Date.now() }); ga.initGa(ID)
    const f = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, discountCode: 'WELCOME10' }) })) as any
    await submitSmsSignup('+1 (555) 123-4567', 'homepage', { track: trackSmsEvent, fetchImpl: f })
    const f2 = jest.fn(async () => ({ ok: false, json: async () => ({ error: 'bad +15551234567' }) })) as any
    await submitSmsSignup('+15551234567', 'homepage', { track: trackSmsEvent, fetchImpl: f2 })
    expect(events().map(a => a[1])).toEqual(['sms_manual_submit', 'sms_signup_success', 'sms_manual_submit', 'sms_signup_error'])
    const everything = JSON.stringify((global as any).window.dataLayer.map((a: any) => Array.from(a)))
    for (const bad of ['5551234567', '555', 'WELCOME10', 'bad +1', 'homepage', '@']) expect(everything).not.toContain(bad)
  })

  test('trackSmsEvent accepts the event name only (no params argument exists to leak through)', () => {
    expect(trackSmsEvent.length).toBe(1)
    local[KEY] = JSON.stringify({ prefs: { analytics: true }, ts: Date.now() }); ga.initGa(ID)
    ;(trackSmsEvent as any)('sms_offer_view', { phone: '+15551234567', discount_code: 'WELCOME10' })
    expect(JSON.stringify(events())).not.toMatch(/5551234567|WELCOME10|discount_code|phone/)
  })

  test('right after consent the event waits for GA readiness (not lost) — and is still name-only', async () => {
    local[KEY] = JSON.stringify({ prefs: { analytics: true }, ts: Date.now() })
    const f = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ measurementId: ID }) })) as any
    const g: any = global; const realFetch = g.fetch; g.fetch = f
    try {
      trackSmsEvent('sms_offer_view'); await flush()
      const all = (((global as any).window.dataLayer ?? []) as any[]).map(a => Array.from(a)).filter(a => a[0] === 'event')
      expect(all.map(a => a[1])).toEqual(['page_view', 'sms_offer_view'])     // page_view first, then the event
      expect(all[1][2]).toEqual({ event_category: 'sms_popup' })
    } finally { g.fetch = realFetch }
  })
})

describe('documentation matches the code', () => {
  const doc = read('GA4-INTEGRATION.md')
  test('the doc lists every declared SMS event and the readiness behaviour', () => {
    for (const n of DECLARED) expect(doc).toContain('`' + n + '`')
    expect(doc).toMatch(/runWhenGaReady\(\)/)
    expect(doc).toMatch(/`begin_checkout` and the purchase never wait for GA/)
  })
})
