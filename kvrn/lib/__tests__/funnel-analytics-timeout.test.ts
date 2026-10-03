// lib/__tests__/funnel-analytics-timeout.test.ts
//
// The money-path analytics writes are hard-bounded: a slow or hung analytics query can never
// hold a checkout response or a Stripe webhook beyond MONEY_PATH_ANALYTICS_TIMEOUT_MS.
// Pure tests (no DB); the real-handler versions are in funnel-analytics-money-path.test.ts.

import fs from 'fs'
import path from 'path'
import {
  withAnalyticsTimeout, ANALYTICS_TIMEOUT, MONEY_PATH_ANALYTICS_TIMEOUT_MS,
  tryRecordCheckoutStarted, tryRecordPurchase,
} from '../funnel-analytics'

const RES = 'f4000000-0000-4000-9000-000000000001'
const ORD = 'f4000000-0000-4000-9000-000000000002'
const SID = '5f1c1c9e-6b7e-4c2c-9d0a-1a2b3c4d5e6f'

/** A sql stand-in whose every statement never settles. */
const hangingSql: any = () => new Promise(() => {})
/** A sql stand-in whose statements reject only AFTER the given delay. */
const lateFailingSql = (ms: number): any => () => new Promise((_, rej) => setTimeout(() => rej(new Error('late boom')), ms))

let unhandled: unknown[]
const onUnhandled = (r: unknown) => { unhandled.push(r) }
beforeEach(() => { unhandled = []; process.on('unhandledRejection', onUnhandled) })
afterEach(() => { process.off('unhandledRejection', onUnhandled); jest.restoreAllMocks() })
const quiet = () => jest.spyOn(console, 'error').mockImplementation(() => {})

describe('the bound', () => {
  test('is short and conservative: above ordinary Neon latency, far below a webhook/checkout timeout', () => {
    expect(MONEY_PATH_ANALYTICS_TIMEOUT_MS).toBeGreaterThanOrEqual(1000)
    expect(MONEY_PATH_ANALYTICS_TIMEOUT_MS).toBeLessThanOrEqual(5000)
  })
})

describe('withAnalyticsTimeout', () => {
  test('a normal result inside the bound is returned as-is (still awaited)', async () => {
    await expect(withAnalyticsTimeout(Promise.resolve('recorded'), 200)).resolves.toBe('recorded')
    await expect(withAnalyticsTimeout(new Promise(r => setTimeout(() => r('slow-but-ok'), 30)), 500)).resolves.toBe('slow-but-ok')
  })
  test('a never-resolving operation yields the timeout marker at about the bound', async () => {
    const t0 = Date.now()
    const r = await withAnalyticsTimeout(new Promise(() => {}), 60)
    const dt = Date.now() - t0
    expect(r).toBe(ANALYTICS_TIMEOUT)
    expect(dt).toBeGreaterThanOrEqual(50); expect(dt).toBeLessThan(400)
  })
  test('an early rejection propagates (the caller turns it into a miss)', async () => {
    await expect(withAnalyticsTimeout(Promise.reject(new Error('x')), 200)).rejects.toThrow('x')
  })
  test('a LATE rejection after the timeout is swallowed: no unhandled rejection', async () => {
    const r = await withAnalyticsTimeout(new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 80)), 20)
    expect(r).toBe(ANALYTICS_TIMEOUT)
    await new Promise(res => setTimeout(res, 200))                  // the late rejection has now happened
    expect(unhandled).toEqual([])
  })
  test('the timer is cleared when the work wins (nothing left pending)', async () => {
    jest.useFakeTimers()
    try {
      const p = withAnalyticsTimeout(Promise.resolve(1), 10_000)
      await Promise.resolve(); await Promise.resolve()
      await expect(p).resolves.toBe(1)
      expect(jest.getTimerCount()).toBe(0)
    } finally { jest.useRealTimers() }
  })
})

describe('tryRecordCheckoutStarted / tryRecordPurchase', () => {
  const cs = { sessionId: SID, reservationId: RES, subtotalCents: 1000, items: [{ variantId: RES, quantity: 1 }] }

  test('checkout_started: a never-resolving write returns "timeout" at the bound and never throws', async () => {
    const err = quiet(); const t0 = Date.now()
    const out = await tryRecordCheckoutStarted(hangingSql, cs, 80)
    expect(out).toBe('timeout'); expect(Date.now() - t0).toBeLessThan(500)
    expect(err).toHaveBeenCalledTimes(1)
    expect(String(err.mock.calls[0].join(' '))).toMatch(/checkout_started skipped \(non-fatal\): timed out after 80ms/)
  })
  test('purchase: a never-resolving write returns "timeout" at the bound and never throws', async () => {
    const err = quiet(); const t0 = Date.now()
    const out = await tryRecordPurchase(hangingSql, { orderId: ORD, reservationId: RES }, 80)
    expect(out).toBe('timeout'); expect(Date.now() - t0).toBeLessThan(500)
    expect(String(err.mock.calls[0].join(' '))).toMatch(/purchase_completed skipped \(non-fatal\): timed out after 80ms/)
  })
  test('the miss message carries no ids and no PII', async () => {
    const err = quiet()
    await tryRecordPurchase(hangingSql, { orderId: ORD, reservationId: RES }, 30)
    await tryRecordCheckoutStarted(hangingSql, cs, 30)
    const text = err.mock.calls.map(c => c.join(' ')).join('\n')
    for (const needle of [ORD, RES, SID]) expect(text).not.toContain(needle)
  })
  test('a late rejection of the underlying query after the timeout is not an unhandled rejection', async () => {
    quiet()
    expect(await tryRecordCheckoutStarted(lateFailingSql(120), cs, 20)).toBe('timeout')
    expect(await tryRecordPurchase(lateFailingSql(120), { orderId: ORD, reservationId: RES }, 20)).toBe('timeout')
    await new Promise(res => setTimeout(res, 300))
    expect(unhandled).toEqual([])
  })
  test('an early failure is a miss, not a throw', async () => {
    quiet()
    const failing: any = () => Promise.reject(new Error('relation does not exist'))
    expect(await tryRecordCheckoutStarted(failing, cs, 500)).toBe('error')
    expect(await tryRecordPurchase(failing, { orderId: ORD, reservationId: RES }, 500)).toBe('error')
    const throwing: any = () => { throw new Error('sync boom') }
    expect(await tryRecordPurchase(throwing, { orderId: ORD, reservationId: RES }, 500)).toBe('error')
  })
  test('a normal write inside the bound is captured: the real SQL result is returned', async () => {
    // Statements answer immediately: the session upsert returns nothing, the insert returns a row.
    const ok: any = async (strings: TemplateStringsArray) => /INSERT INTO analytics_events/.test(strings.join('?')) ? [{ id: 'x' }] : []
    expect(await tryRecordCheckoutStarted(ok, cs, 500)).toBe('recorded')
  })
  test('no reservation id: ignored without touching the database', async () => {
    const sql = jest.fn()
    expect(await tryRecordPurchase(sql as any, { orderId: ORD, reservationId: null })).toBe('ignored')
    expect(sql).not.toHaveBeenCalled()
  })
})

describe('wiring: the callers await only the bounded wrappers', () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8')
  test('checkout handler and webhook call the try* wrappers, never the raw service', () => {
    const h = read('lib/checkout-session-handler.ts'); const w = read('app/api/stripe/webhook/route.ts')
    expect(h).toMatch(/await tryRecordCheckoutStarted\(sql,/)
    expect(w).toMatch(/await tryRecordPurchase\(sql,/)
    for (const src of [h, w]) expect(src).not.toMatch(/createFunnelService|\.recordCheckoutStarted\(|\.recordPurchase\(/)
  })
  test('the timeout is portable: setTimeout only, no runtime-specific API', () => {
    const src = read('lib/funnel-analytics.ts')
    expect(src).not.toMatch(/waitUntil|AbortSignal\.timeout|getCloudflareContext|cloudflare:/i)
  })
})
