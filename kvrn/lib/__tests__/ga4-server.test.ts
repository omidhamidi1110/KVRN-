// lib/__tests__/ga4-server.test.ts
//
// The canonical server-side GA4 purchase: configuration, the pure canonical body, and the
// never-throws / hard-bounded send. No database and no network: sql and fetch are injected.

import { allocateDiscountAcrossLines, gaNetUnitPrice, readPublicGaMeasurementId } from '../ga-common'
import {
  resolveGaConfig, describeGaConfig, buildGaPurchaseBody, tryRecordGaPurchase,
  GA_SERVER_TIMEOUT_MS, GA_MP_ENDPOINT, type GaOrderRow, type GaOrderItemRow,
} from '../ga4-server'

const ORDER_ID = 'f5000000-0000-4000-9000-000000000001'
const ENV = { NEXT_PUBLIC_GA_MEASUREMENT_ID: 'G-TEST123456', GA4_MEASUREMENT_PROTOCOL_SECRET: 'sEcReT_abcdef123456' }
const CID = '1234567890.1696300000'
const SID = '1696300000'

const order: GaOrderRow = { order_number: 'KVRN-1001', currency: 'usd', payment_status: 'paid', subtotal_cents: 10000, discount_cents: 0, shipping_cents: 800, tax_cents: 250, total_cents: 11050 }
const items: GaOrderItemRow[] = [
  { slug: 'phantom-hoodie', sku: 'KVRN-PH-BLK-M', product_name: 'Phantom Hoodie', quantity: 1, unit_price_cents: 8000 },
  { slug: 'phantom-sweatpants', sku: 'KVRN-PS-BLK-L', product_name: 'Phantom Sweatpants', quantity: 2, unit_price_cents: 1000 },
]

/** sql stand-in: answers the order query then the items query (called in that order via Promise.all). */
const fakeSql = (o: GaOrderRow[] = [order], it: GaOrderItemRow[] = items): any => {
  const calls: string[] = []
  const fn: any = (strings: TemplateStringsArray) => {
    const text = strings.join('?'); calls.push(text)
    return Promise.resolve(/FROM orders/.test(text) && !/order_items/.test(text) ? o : it)
  }
  fn.calls = calls
  return fn
}
const okFetch = () => jest.fn(async () => ({ status: 204 })) as unknown as typeof fetch & jest.Mock

let errSpy: jest.SpyInstance, logSpy: jest.SpyInstance
let unhandled: unknown[]
const onUnhandled = (r: unknown) => { unhandled.push(r) }
beforeEach(() => {
  unhandled = []; process.on('unhandledRejection', onUnhandled)
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { process.off('unhandledRejection', onUnhandled); errSpy.mockRestore(); logSpy.mockRestore() })
const logged = () => [...errSpy.mock.calls, ...logSpy.mock.calls].map(c => c.join(' ')).join('\n')

// ═════════════════════════════════════════════════════════════════════════════
describe('configuration', () => {
  test('both present and well-formed', () => {
    expect(resolveGaConfig(ENV)).toEqual({ ok: true, measurementId: 'G-TEST123456', apiSecret: 'sEcReT_abcdef123456' })
  })
  test.each([
    [{}, 'missing'],
    [{ NEXT_PUBLIC_GA_MEASUREMENT_ID: 'G-TEST123456' }, 'missing'],
    [{ GA4_MEASUREMENT_PROTOCOL_SECRET: 'sEcReT_abcdef123456' }, 'missing'],
    [{ NEXT_PUBLIC_GA_MEASUREMENT_ID: '  ', GA4_MEASUREMENT_PROTOCOL_SECRET: 'sEcReT_abcdef123456' }, 'missing'],
    [{ NEXT_PUBLIC_GA_MEASUREMENT_ID: 'UA-123-1', GA4_MEASUREMENT_PROTOCOL_SECRET: 'sEcReT_abcdef123456' }, 'malformed'],
    [{ NEXT_PUBLIC_GA_MEASUREMENT_ID: 'G-TEST123456&x=1', GA4_MEASUREMENT_PROTOCOL_SECRET: 'sEcReT_abcdef123456' }, 'malformed'],
    [{ NEXT_PUBLIC_GA_MEASUREMENT_ID: 'G-TEST123456', GA4_MEASUREMENT_PROTOCOL_SECRET: 'short' }, 'malformed'],
    [{ NEXT_PUBLIC_GA_MEASUREMENT_ID: 'G-TEST123456', GA4_MEASUREMENT_PROTOCOL_SECRET: 'has space&and=amp_chars' }, 'malformed'],
  ])('%j -> %s', (env, reason) => {
    expect(resolveGaConfig(env as any)).toEqual({ ok: false, reason })
  })
  test('the admin status reports STATES only; the secret value is never in it', () => {
    const s = describeGaConfig(ENV)
    expect(s).toEqual({ measurementId: 'G-TEST123456', clientState: 'ok', secretState: 'ok' })
    expect(JSON.stringify(s)).not.toContain('sEcReT')
    expect(describeGaConfig({})).toEqual({ measurementId: null, clientState: 'unset', secretState: 'unset' })
    expect(describeGaConfig({ NEXT_PUBLIC_GA_MEASUREMENT_ID: 'nope', GA4_MEASUREMENT_PROTOCOL_SECRET: 'x' }))
      .toEqual({ measurementId: null, clientState: 'malformed', secretState: 'malformed' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('buildGaPurchaseBody — canonical, from the finalized order only', () => {
  const build = (o: Partial<GaOrderRow> = {}, it = items, extra: Record<string, unknown> = {}) =>
    buildGaPurchaseBody({ orderId: ORDER_ID, order: { ...order, ...o }, items: it, clientId: CID, sessionId: SID, ...extra })

  test('transaction_id is the KVRN order number; value excludes shipping and tax; cents convert only at the boundary', () => {
    const r = build()
    expect(r.ok).toBe(true)
    const e = (r as any).body.events[0]
    expect((r as any).body.client_id).toBe(CID)
    expect(e.name).toBe('purchase')
    expect(e.params).toEqual({
      session_id: SID, engagement_time_msec: 100, transaction_id: 'KVRN-1001', currency: 'USD',
      value: 100, shipping: 8, tax: 2.5,                // 11050 - 800 - 250 = 10000 cents = $100.00
      items: [
        { item_id: 'phantom-hoodie', item_name: 'Phantom Hoodie', item_variant: 'KVRN-PH-BLK-M', item_brand: 'KVRN', price: 80, quantity: 1 },
        { item_id: 'phantom-sweatpants', item_name: 'Phantom Sweatpants', item_variant: 'KVRN-PS-BLK-L', item_brand: 'KVRN', price: 10, quantity: 2 },
      ],
    })
  })
  test('item_id is the product slug (same id as the browser events); a deleted variant falls back to the sku', () => {
    const r = build({}, [{ slug: null, sku: 'KVRN-OLD-1', product_name: 'Old Tee', quantity: 1, unit_price_cents: 3000 }])
    expect((r as any).body.events[0].params.items[0]).toMatchObject({ item_id: 'KVRN-OLD-1', item_variant: 'KVRN-OLD-1' })
  })
  test('the session id is optional and shape-checked', () => {
    expect((build({}, items, { sessionId: undefined }) as any).body.events[0].params).not.toHaveProperty('session_id')
    expect((build({}, items, { sessionId: 'abc; drop' }) as any).body.events[0].params).not.toHaveProperty('session_id')
  })
  test('a free/zero-merchandise order gives value 0 only when that is the real canonical figure', () => {
    const r = build({ total_cents: 800, shipping_cents: 800, tax_cents: 0 })
    expect((r as any).body.events[0].params.value).toBe(0)
  })
  test.each([
    ['not paid', { payment_status: 'pending' }, 'not_paid'],
    ['non-USD', { currency: 'gbp' }, 'currency'],
    ['unknown total', { total_cents: null }, 'amount_unknown'],
    ['unknown shipping', { shipping_cents: null }, 'amount_unknown'],
    ['unknown tax', { tax_cents: null }, 'amount_unknown'],
    ['fractional total', { total_cents: 1050.5 }, 'amount_unknown'],
    ['negative tax', { tax_cents: -1 }, 'amount_unknown'],
    ['shipping+tax exceed total', { total_cents: 100, shipping_cents: 800, tax_cents: 0 }, 'amount_invalid'],
  ])('refuses %s instead of guessing or zeroing', (_n, over, reason) => {
    expect(build(over as any)).toEqual({ ok: false, reason })
  })
  test('refuses without a valid GA client id, or with no usable items', () => {
    for (const bad of [undefined, '', 'abc', '1.2.3', '1234567890123.1', '<x>.1']) {
      expect(buildGaPurchaseBody({ orderId: ORDER_ID, order, items, clientId: bad })).toEqual({ ok: false, reason: 'no_client_id' })
    }
    expect(build({}, [])).toEqual({ ok: false, reason: 'no_items' })
    expect(build({}, [{ slug: 'a', sku: 'a', product_name: 'A', quantity: 0, unit_price_cents: 100 }])).toEqual({ ok: false, reason: 'no_items' })
  })
  test('an invalid order number falls back to the order uuid; both invalid is refused', () => {
    expect((build({ order_number: 'bad number!' }) as any).body.events[0].params.transaction_id).toBe(ORDER_ID)
    expect(buildGaPurchaseBody({ orderId: 'not a uuid!', order: { ...order, order_number: null }, items, clientId: CID }))
      .toEqual({ ok: false, reason: 'no_transaction_id' })
  })
  test('NO PII: extra customer fields on the rows can never reach the body', () => {
    const dirtyOrder: any = { ...order, customer_email: 'buyer@example.com', customer_name: 'A Buyer', customer_phone: '+15551234567',
                              shipping_address: { line1: '1 Test St', city: 'Austin' }, stripe_payment_intent_id: 'pi_123', notes: 'leave at door' }
    const dirtyItems: any[] = items.map(i => ({ ...i, customer_email: 'buyer@example.com', color: 'Black', size: 'M' }))
    const r = buildGaPurchaseBody({ orderId: ORDER_ID, order: dirtyOrder, items: dirtyItems, clientId: CID, sessionId: SID })
    const json = JSON.stringify((r as any).body)
    for (const bad of ['buyer@example.com', 'A Buyer', '5551234567', 'Test St', 'Austin', 'pi_123', 'leave at door', 'user_id', 'user_properties', 'email']) {
      expect(json).not.toContain(bad)
    }
    expect(Object.keys((r as any).body).sort()).toEqual(['client_id', 'events'])
    expect(Object.keys((r as any).body.events[0].params).sort()).toEqual(
      ['currency', 'engagement_time_msec', 'items', 'session_id', 'shipping', 'tax', 'transaction_id', 'value'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('tryRecordGaPurchase — sends once, never throws, never blocks', () => {
  const run = (o: Partial<Parameters<typeof tryRecordGaPurchase>[1]> = {}, sql = fakeSql()) =>
    tryRecordGaPurchase(sql, { orderId: ORDER_ID, gaClientId: CID, gaSessionId: SID, env: ENV, ...o })

  test('a normal send: one POST to the Measurement Protocol with the canonical body', async () => {
    const f = okFetch()
    expect(await run({ fetchImpl: f })).toBe('sent')
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = (f as any).mock.calls[0]
    expect(url.startsWith(GA_MP_ENDPOINT + '?')).toBe(true)
    expect(new URL(url).searchParams.get('measurement_id')).toBe('G-TEST123456')
    expect(new URL(url).searchParams.get('api_secret')).toBe('sEcReT_abcdef123456')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.events[0].params.transaction_id).toBe('KVRN-1001')
    expect(init.body).not.toContain('sEcReT')                       // the secret is only ever in the request URL
    expect(logged()).not.toContain('sEcReT')
  })
  test('the order is read from the database; nothing the browser sent is a source of money', async () => {
    const sql = fakeSql(); const f = okFetch()
    await run({ fetchImpl: f }, sql)
    expect(sql.calls.some((c: string) => /FROM orders/.test(c))).toBe(true)
    expect(sql.calls.some((c: string) => /FROM order_items/.test(c))).toBe(true)
  })
  test('missing or malformed configuration: skipped cleanly, no DB read, no network, non-PII log, no secret in the log', async () => {
    for (const env of [{}, { ...ENV, GA4_MEASUREMENT_PROTOCOL_SECRET: undefined }, { ...ENV, NEXT_PUBLIC_GA_MEASUREMENT_ID: 'bad' }, { ...ENV, GA4_MEASUREMENT_PROTOCOL_SECRET: 'x y' }]) {
      const f = okFetch(); const sql = fakeSql()
      expect(await run({ env: env as any, fetchImpl: f }, sql)).toBe('skipped')
      expect(f).not.toHaveBeenCalled(); expect(sql.calls).toEqual([])
    }
    expect(logged()).toMatch(/GA4 server configuration (missing|malformed)/)
    expect(logged()).not.toMatch(/sEcReT|G-TEST123456/)
  })
  test('no GA client id (visitor not running GA: declined / DNT / GPC / blocked): nothing is sent', async () => {
    for (const cid of [undefined, null, '', 'abc', 42, { a: 1 }]) {
      const f = okFetch(); const sql = fakeSql()
      expect(await run({ gaClientId: cid, fetchImpl: f }, sql)).toBe('skipped')
      expect(f).not.toHaveBeenCalled(); expect(sql.calls).toEqual([])
    }
  })
  test('an order that is not found / not paid / not USD / has unknown amounts is skipped, not sent', async () => {
    for (const sql of [fakeSql([]), fakeSql([{ ...order, payment_status: 'refunded' }]), fakeSql([{ ...order, currency: 'eur' }]), fakeSql([{ ...order, total_cents: null }])]) {
      const f = okFetch()
      expect(await run({ fetchImpl: f }, sql)).toBe('skipped')
      expect(f).not.toHaveBeenCalled()
    }
  })
  test('a database error is a miss, not a throw', async () => {
    const sql: any = () => Promise.reject(new Error('connection terminated'))
    const f = okFetch()
    expect(await run({ fetchImpl: f }, sql)).toBe('error')
    expect(f).not.toHaveBeenCalled()
  })
  test('a network error is a miss, not a throw', async () => {
    const f = jest.fn(async () => { throw new TypeError('fetch failed') }) as any
    expect(await run({ fetchImpl: f })).toBe('error')
  })
  test('a non-2xx answer is a miss, not a throw (and the response body is never read)', async () => {
    const json = jest.fn(() => { throw new Error('must not be read') }); const text = jest.fn(() => { throw new Error('must not be read') })
    for (const status of [400, 403, 500, 503]) {
      const f = jest.fn(async () => ({ status, json, text })) as any
      expect(await run({ fetchImpl: f })).toBe('error')
    }
    expect(json).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled()
  })
  test('malformed responses of every kind cannot throw', async () => {
    for (const res of [undefined, null, {}, { status: 'abc' }, { status: NaN }, 'ok', 42]) {
      const f = jest.fn(async () => res) as any
      const out = await run({ fetchImpl: f })
      expect(['sent', 'error']).toContain(out)
      expect(out).toBe('error')
    }
    const f = jest.fn(async () => ({ status: 200, json: () => { throw new SyntaxError('Unexpected token') } })) as any
    expect(await run({ fetchImpl: f })).toBe('sent')               // 2xx with an unparseable body is still accepted
  })
  test('a hung request resolves "timeout" at the bound, aborts the fetch, and never throws', async () => {
    let signal: AbortSignal | undefined
    const f = jest.fn((_u: string, init: any) => { signal = init.signal; return new Promise(() => {}) }) as any
    const t0 = Date.now()
    const out = await run({ fetchImpl: f, timeoutMs: 80 })
    expect(out).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(500)
    expect(signal!.aborted).toBe(true)
    expect(logged()).toMatch(/timed out after 80ms/)
  })
  test('a hung database read is bounded too', async () => {
    const sql: any = () => new Promise(() => {})
    const t0 = Date.now()
    expect(await run({ timeoutMs: 80 }, sql)).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(500)
  })
  test('a LATE failure after the timeout is not an unhandled rejection', async () => {
    const f = jest.fn(() => new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 150))) as any
    expect(await run({ fetchImpl: f, timeoutMs: 20 })).toBe('timeout')
    await new Promise(r => setTimeout(r, 300))
    expect(unhandled).toEqual([])
  })
  test('the default bound is short and conservative', () => {
    expect(GA_SERVER_TIMEOUT_MS).toBeGreaterThanOrEqual(1000)
    expect(GA_SERVER_TIMEOUT_MS).toBeLessThanOrEqual(5000)
  })
  test('logs never contain the secret, the measurement id, the client id, the request URL or any customer data', async () => {
    const failing = jest.fn(async () => { throw new Error(`boom ${GA_MP_ENDPOINT}?api_secret=sEcReT_abcdef123456`) }) as any
    await run({ fetchImpl: failing })
    await run({ fetchImpl: jest.fn(async () => ({ status: 500 })) as any })
    await run({ gaClientId: undefined })
    await run({ env: {} })
    const text = logged()
    for (const bad of ['sEcReT', 'G-TEST123456', CID, 'api_secret', 'google-analytics.com', 'buyer@', 'KVRN-1001']) expect(text).not.toContain(bad)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Audit Revision 1 / correction 4 — item revenue consistent with `value` under discounts.
//
// AUDIT FACT: order_items.unit_price_cents is the PRE-discount snapshot (migrations 002/019/022);
// the merchandise discount is on the order only. The GA boundary therefore allocates it.
describe('discount-consistent GA item revenue', () => {
  const mk = (sub: number, disc: number, ship: number, tax: number): GaOrderRow =>
    ({ ...order, subtotal_cents: sub, discount_cents: disc, shipping_cents: ship, tax_cents: tax, total_cents: Math.max(0, sub - disc) + ship + tax })
  const itemsRevenueCents = (r: any): number =>
    Math.round(r.body.events[0].params.items.reduce((a: number, i: any) => a + i.price * i.quantity, 0) * 1e6) / 1e4
  const build = (o: GaOrderRow, it: GaOrderItemRow[]) => buildGaPurchaseBody({ orderId: ORDER_ID, order: o, items: it, clientId: CID, sessionId: SID })
  const row = (slug: string, q: number, unit: number): GaOrderItemRow =>
    ({ slug, sku: slug.toUpperCase(), product_name: slug, quantity: q, unit_price_cents: unit })
  /** value (event) and the sum of GA item revenue agree to a sliver (fractional per-unit prices only). */
  const consistent = (r: any) => {
    const p = r.body.events[0].params
    const sum = p.items.reduce((a: number, i: any) => a + i.price * i.quantity, 0)
    expect(Math.abs(sum - p.value)).toBeLessThan(0.003)
  }

  test('no discount: item prices are the unit prices and sum exactly to value', () => {
    const r: any = build(mk(10000, 0, 800, 250), items)
    expect(r.itemPricing).toBe('unit_price')
    expect(r.body.events[0].params.items.map((i: any) => i.price)).toEqual([80, 10])
    expect(r.body.events[0].params.value).toBe(100)
    expect(Math.abs(itemsRevenueCents(r) - 10000)).toBe(0)
  })

  test('fixed merchandise discount: spread across lines proportionally; value = sum of item revenue', () => {
    const r: any = build(mk(10000, 1500, 800, 0), items)     // total 9300 -> value 8500
    expect(r.itemPricing).toBe('discount_allocated')
    const p = r.body.events[0].params
    expect(p.value).toBe(85)
    expect(p.shipping).toBe(8)
    expect(p.items.map((i: any) => i.price)).toEqual([68, 8.5])   // 6800/1 and 1700/2
    consistent(r)
  })

  test('discount across several products and quantities that do not divide evenly', () => {
    const it = [row('a', 3, 3333), row('b', 1, 2000), row('c', 2, 1501)]   // 9999 + 2000 + 3002 = 15001
    const r: any = build(mk(15001, 1001, 995, 0), it)
    expect(r.itemPricing).toBe('discount_allocated')
    expect(r.body.events[0].params.value).toBe(140)                // 14000 cents
    consistent(r)
    // every price is a plain finite non-negative number, never NaN/negative
    for (const i of r.body.events[0].params.items) { expect(Number.isFinite(i.price)).toBe(true); expect(i.price).toBeGreaterThanOrEqual(0) }
  })

  test('fractional per-unit prices exist only in the GA payload (3 units for 10.00 net)', () => {
    const r: any = build(mk(1200, 200, 0, 0), [row('a', 3, 400)])   // net 1000 cents over 3 units
    const i = r.body.events[0].params.items[0]
    expect(i.quantity).toBe(3)
    expect(i.price).toBeCloseTo(3.333333, 6)
    consistent(r)
  })

  test('a shipping-only discount does NOT reduce item revenue (and is not subtracted twice)', () => {
    // shipping quoted 800, discounted by 500 -> final shipping 300. discount_cents (merchandise) stays 0.
    const o: any = { ...mk(10000, 0, 300, 0), shipping_before_discount_cents: 800, shipping_discount_cents: 500 }
    const r: any = build(o, items)
    expect(r.itemPricing).toBe('unit_price')
    expect(r.body.events[0].params.items.map((i: any) => i.price)).toEqual([80, 10])
    expect(r.body.events[0].params.value).toBe(100)
    expect(r.body.events[0].params.shipping).toBe(3)
    consistent(r)
  })

  test('merchandise discount + shipping discount together: only the merchandise part touches items', () => {
    const o: any = { ...mk(10000, 2000, 0, 0), shipping_before_discount_cents: 800, shipping_discount_cents: 800 }
    const r: any = build(o, items)
    expect(r.body.events[0].params.value).toBe(80)
    expect(r.body.events[0].params.items.map((i: any) => i.price)).toEqual([64, 8])
    consistent(r)
  })

  test('a 100% merchandise discount gives zero-priced items and value 0 (still consistent)', () => {
    const r: any = build(mk(10000, 10000, 800, 0), items)
    expect(r.body.events[0].params.value).toBe(0)
    expect(r.body.events[0].params.items.map((i: any) => i.price)).toEqual([0, 0])
  })

  test('the discount code and every other discount field never reach the payload', () => {
    const o: any = { ...mk(10000, 1500, 800, 0), discount_code: 'SECRETCODE15', discount_id: 'x', discount_type: 'fixed_amount' }
    const json = JSON.stringify((build(o, items) as any).body)
    for (const bad of ['SECRETCODE15', 'discount_code', 'discount_id', 'coupon', 'fixed_amount']) expect(json).not.toContain(bad)
  })

  test.each([
    ['lines do not add up to the order subtotal', mk(9000, 0, 800, 250), items, 'lines_do_not_sum_to_subtotal'],
    ['discount larger than the subtotal', { ...mk(10000, 0, 800, 0), discount_cents: 10001, total_cents: 800 }, items, 'discount_exceeds_subtotal'],
    ['total disagrees with subtotal - discount', { ...mk(10000, 1500, 800, 0), total_cents: 9900 }, items, 'value_mismatch'],
    ['unknown subtotal', { ...mk(10000, 0, 800, 250), subtotal_cents: null }, items, 'order_discount_unknown'],
    ['unknown discount', { ...mk(10000, 0, 800, 250), discount_cents: null }, items, 'order_discount_unknown'],
    ['unknown unit price', mk(10000, 0, 800, 250), [{ ...items[0], unit_price_cents: null }, items[1]], 'item_price_unknown'],
    ['an unusable line', mk(10000, 0, 800, 250), [items[0], { ...items[1], quantity: 0 }], 'item_invalid'],
  ] as Array<[string, GaOrderRow, GaOrderItemRow[], string]>)('inconsistent figures (%s): item prices are OMITTED, never fabricated; value stays canonical', (_n, o, it, reason) => {
    const r: any = build(o, it)
    expect(r.ok).toBe(true)
    expect(r.itemPricing).toBe('omitted')
    expect(r.omitReason).toBe(reason)
    for (const i of r.body.events[0].params.items) expect(i).not.toHaveProperty('price')
    expect(r.body.events[0].params.value).toBe(Number(((o.total_cents! - o.shipping_cents! - o.tax_cents!) / 100).toFixed(2)))
  })

  test('more lines than the payload cap: prices omitted rather than a partial, inconsistent sum', () => {
    const many = Array.from({ length: 51 }, (_, k) => row('p' + k, 1, 100))
    const r: any = build(mk(5100, 0, 0, 0), many)
    expect(r.itemPricing).toBe('omitted'); expect(r.omitReason).toBe('too_many_items')
    expect(r.body.events[0].params.items).toHaveLength(50)
  })

  test('tryRecordGaPurchase reads subtotal/discount from the order, sends the allocated prices and logs an omission without PII', async () => {
    const f = okFetch()
    const sqlOk = fakeSql([mk(10000, 1500, 800, 0)], items)
    expect(await tryRecordGaPurchase(sqlOk, { orderId: ORDER_ID, gaClientId: CID, env: ENV, fetchImpl: f })).toBe('sent')
    expect(sqlOk.calls.some((c: string) => /subtotal_cents/.test(c) && /discount_cents/.test(c))).toBe(true)
    expect(JSON.parse((f as any).mock.calls[0][1].body).events[0].params.items.map((i: any) => i.price)).toEqual([68, 8.5])

    const f2 = okFetch()
    expect(await tryRecordGaPurchase(fakeSql([mk(9000, 0, 800, 250)], items), { orderId: ORDER_ID, gaClientId: CID, env: ENV, fetchImpl: f2 })).toBe('sent')
    const sent = JSON.parse((f2 as any).mock.calls[0][1].body)
    expect(sent.events[0].params.items.every((i: any) => !('price' in i))).toBe(true)
    expect(logged()).toMatch(/item prices omitted \(non-fatal\): lines_do_not_sum_to_subtotal/)
  })

  describe('allocateDiscountAcrossLines (pure, integer cents)', () => {
    test('exact, proportional, deterministic; ties go to the earlier line', () => {
      expect(allocateDiscountAcrossLines([8000, 2000], 1500)).toEqual([6800, 1700])
      expect(allocateDiscountAcrossLines([100, 100, 100], 100)).toEqual([66, 67, 67])   // 34/33/33 shares -> earlier line takes the extra cent
      expect(allocateDiscountAcrossLines([100, 100, 100], 100)).toEqual(allocateDiscountAcrossLines([100, 100, 100], 100))
      expect(allocateDiscountAcrossLines([500], 0)).toEqual([500])
      expect(allocateDiscountAcrossLines([0, 500], 100)).toEqual([0, 400])
    })
    test('the net lines always sum to exactly (gross - discount) and never go negative (randomised, seeded)', () => {
      let seed = 12345
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
      for (let n = 0; n < 500; n++) {
        const gross = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => Math.floor(rnd() * 50000))
        const total = gross.reduce((a, b) => a + b, 0)
        const disc = total === 0 ? 0 : Math.floor(rnd() * (total + 1))
        const net = allocateDiscountAcrossLines(gross, disc)!
        expect(net).not.toBeNull()
        expect(net.reduce((a, b) => a + b, 0)).toBe(total - disc)
        net.forEach((v, i) => { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(gross[i]) })
      }
    })
    test('inconsistent input is refused, not guessed', () => {
      for (const [g, d] of [[[], 0], [[100], 101], [[100], -1], [[100.5], 10], [[-5, 100], 10], [[0, 0], 5], [[100], 1.5]] as Array<[number[], number]>) {
        expect(allocateDiscountAcrossLines(g, d)).toBeNull()
      }
    })
    test('gaNetUnitPrice: exact 2-dp when divisible, 6-dp fraction otherwise, null for nonsense', () => {
      expect(gaNetUnitPrice(1700, 2)).toBe(8.5)
      expect(gaNetUnitPrice(1000, 3)).toBeCloseTo(3.333333, 6)
      expect(gaNetUnitPrice(-1, 1)).toBeNull(); expect(gaNetUnitPrice(100, 0)).toBeNull(); expect(gaNetUnitPrice(1.5, 1)).toBeNull()
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Audit Revision 1 / correction 1 — the id the browser can use and the id the admin shows are the
// same runtime value, and nothing else can come out of the public reader.
describe('runtime public measurement id', () => {
  test('describeGaConfig and the browser reader agree on every kind of configuration', () => {
    for (const id of ['G-TEST123456', ' G-TEST123456 ', 'UA-1-1', 'G-TEST123456&x=1', '', undefined]) {
      const env: any = { NEXT_PUBLIC_GA_MEASUREMENT_ID: id, GA4_MEASUREMENT_PROTOCOL_SECRET: 'sEcReT_abcdef123456' }
      expect(describeGaConfig(env).measurementId).toBe(readPublicGaMeasurementId(env))
    }
  })
  test('the public reader returns only the validated id — never the secret, whatever the environment holds', () => {
    const env: any = { NEXT_PUBLIC_GA_MEASUREMENT_ID: 'G-TEST123456', GA4_MEASUREMENT_PROTOCOL_SECRET: 'sEcReT_abcdef123456', DATABASE_URL: 'postgres://u:p@h/db', CLOUDFLARE_API_TOKEN: 'cf_token' }
    expect(readPublicGaMeasurementId(env)).toBe('G-TEST123456')
    // Even a (mis)configuration that put the secret in the id variable is refused, not echoed.
    expect(readPublicGaMeasurementId({ NEXT_PUBLIC_GA_MEASUREMENT_ID: 'sEcReT_abcdef123456' })).toBeNull()
    expect(readPublicGaMeasurementId({})).toBeNull()
  })
})
