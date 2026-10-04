// lib/__tests__/advanced-charts-db.test.ts
//
// Real-PostgreSQL checks for the ADVANCED ADMIN CHARTS data:
//   • the funnel trend reproduces the summary funnel exactly (same cohort, same ladder)
//   • days before first-party collection began are "no data", not zero
//   • the financial series' new per-bucket counters add up to the period cards
//   • unknown costs stay unknown (never a zero) all the way into the plotted point
//   • the funnel response carries aggregates only
//
// Runs only against a LOCAL server (see helpers/fi-pg.ts); otherwise it skips visibly.
// The pure rules are covered, without a database, in advanced-charts.test.ts.

import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { createFunnelService, funnelWindow, FUNNEL_RANGES } from '../funnel-analytics'
import { createFinancialService } from '../financials'
import { plotFinancialPoint, plotFinancialSeries } from '../chart-data'
import {
  HAVE_DB, TEST_DB_URL, createFiDb, seedCatalog, mkOrder, addRefund, dayRange, ymd, oid, type FiDb,
} from './helpers/fi-pg'

jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => {
    if ((global as any).__AC_DENY) {
      return { identity: null, error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
    }
    return { identity: { email: 'charts@test.local' }, error: null }
  },
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__AC_SQL } }))

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL
    ? 'NOTE: advanced-charts DB tests skipped — TEST_DATABASE_URL is not a local server.'
    : 'NOTE: advanced-charts real-PostgreSQL tests skipped — TEST_DATABASE_URL absent.', () => {
    expect(true).toBe(true)
  })
}

let F: FiDb
let pgFail: string | null = null
const needDb = () => { if (pgFail) throw new Error('local PostgreSQL unavailable: ' + pgFail) }
const q = (t: string, p: unknown[] = []) => F.q(t, p)

beforeAll(async () => {
  if (!HAVE_DB) return
  try {
    F = await createFiDb('kvrn_charts')
    await seedCatalog(F.q)
    ;(global as any).__AC_SQL = F.sql
  } catch (e: any) { pgFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { await F?.close() })
afterEach(() => { (global as any).__AC_DENY = false })

/** Noon UTC, n days ago. */
const noon = (n: number) => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n); return d.toISOString() }

// ═════════════════════════════════════════════════════════════════════════════
// FUNNEL TREND
// ═════════════════════════════════════════════════════════════════════════════
describeDB('funnel trend (real database)', () => {
  const adminGet = (qs = '') => {
    const { GET } = require('../../app/api/admin/analytics/funnel/route')
    return GET(new NextRequest('http://localhost/api/admin/analytics/funnel' + qs))
  }
  const S = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID(), e: randomUUID(), f: randomUUID() }

  /** Start a session, optionally with a product view and a cart add, all stamped at `at`. */
  async function session(sid: string, at: string, ladder: 'visit' | 'product' | 'cart' | 'checkout' | 'purchase') {
    const svc = createFunnelService(F.sql)
    await svc.ensureSession(sid)
    if (ladder !== 'visit') {
      await svc.recordClientEvent({ event: 'product_viewed', sid, slug: 'f21', sku: 'F21-M' })
    }
    if (ladder === 'cart' || ladder === 'checkout' || ladder === 'purchase') {
      await svc.recordClientEvent({ event: 'add_to_cart', sid, eid: randomUUID(), slug: 'f21', sku: 'F21-M', qty: 1 })
    }
    if (ladder === 'checkout' || ladder === 'purchase') {
      const res = randomUUID()
      await q(`INSERT INTO reservations (id, expires_at) VALUES ($1, now() + interval '15 minutes')`, [res])
      await svc.recordCheckoutStarted({ sessionId: sid, reservationId: res, subtotalCents: 1000,
                                        items: [{ variantId: 'f2100000-0000-0000-0000-00000000bbbb', quantity: 1 }] })
      if (ladder === 'purchase') {
        const n = 700 + Object.keys(S).indexOf(Object.keys(S).find(k => (S as any)[k] === sid)!)
        await mkOrder(F.q, n, { consume: false, label: null, daysAgo: 1 })
        await q(`UPDATE orders SET reservation_id=$2 WHERE id=$1`, [oid(n), res])
        await svc.recordPurchase({ orderId: oid(n), reservationId: res })
      }
    }
    await q(`UPDATE analytics_events SET created_at = $2::timestamptz WHERE session_id = $1`, [sid, at])
  }

  describe('empty dataset', () => {
    test('no sessions ever: every bucket is "no data" (null), never a zero', async () => {
      needDb()
      await q('DELETE FROM analytics_events'); await q('DELETE FROM analytics_sessions')
      const r = await createFunnelService(F.sql).getFunnelReport(funnelWindow('7d'))
      expect(r.stages.visits).toBe(0)
      expect(r.rates.visitToPurchase).toBeNull()
      expect(r.trend.collectionStartedAt).toBeNull()
      expect(r.trend.buckets.length).toBeGreaterThanOrEqual(7)
      for (const b of r.trend.buckets) {
        expect(b.coverage).toBe('none')
        expect(b.stages).toBeNull()
        expect(b.rates).toBeNull()
      }
    })
  })

  describe('with sessions across several days', () => {
    beforeAll(async () => {
      if (!HAVE_DB || pgFail) return
      await q('DELETE FROM analytics_events'); await q('DELETE FROM analytics_sessions')
      await q('DELETE FROM orders')
      // 20 days ago: the very first recorded session (collection begins here).
      await session(S.a, noon(20), 'visit')
      // 3 days ago: visit-only, product, cart.
      await session(S.b, noon(3), 'visit')
      await session(S.c, noon(3), 'product')
      await session(S.d, noon(3), 'cart')
      // 1 day ago: a complete purchase.  2 days ago: nothing at all (a genuine zero day).
      await session(S.e, noon(1), 'purchase')
      // Outside 30d but inside 90d.
      await session(S.f, noon(45), 'product')
    }, 60_000)

    test.each([...FUNNEL_RANGES])('range %s: the buckets add up to the summary funnel exactly', async range => {
      needDb()
      const j = await (await adminGet('?range=' + range)).json()
      const sum = (k: keyof NonNullable<typeof j.trend.buckets[0]['stages']>) =>
        j.trend.buckets.reduce((s: number, b: any) => s + (b.stages ? b.stages[k] : 0), 0)
      expect(sum('visits')).toBe(j.stages.visits)
      expect(sum('reachedProduct')).toBe(j.stages.reachedProduct)
      expect(sum('reachedCart')).toBe(j.stages.reachedCart)
      expect(sum('reachedCheckout')).toBe(j.stages.reachedCheckout)
      expect(sum('purchased')).toBe(j.stages.purchased)
    })

    test('the 7/30/90 control changes both the summary and the trend window', async () => {
      needDb()
      const [a, b, c] = await Promise.all(['7d', '30d', '90d'].map(async r => (await adminGet('?range=' + r)).json()))
      expect(a.stages.visits).toBe(4)       // b, c, d, e
      expect(b.stages.visits).toBe(5)       // + a (20 days ago)
      expect(c.stages.visits).toBe(6)       // + f (45 days ago)
      expect(a.trend.buckets.length).toBeLessThan(b.trend.buckets.length)
      expect(b.trend.buckets.length).toBeLessThan(c.trend.buckets.length)
    })

    test('per-day counts, ladder order and the genuine zero day', async () => {
      needDb()
      const j = await (await adminGet('?range=30d')).json()
      const day = (n: number) => j.trend.buckets.find((x: any) => x.date === ymd(n))
      expect(day(3).stages).toEqual({ visits: 3, reachedProduct: 2, reachedCart: 1, reachedCheckout: 0, purchased: 0 })
      expect(day(1).stages).toEqual({ visits: 1, reachedProduct: 1, reachedCart: 1, reachedCheckout: 1, purchased: 1 })
      // Collection was running and nobody visited: a real zero with NO rate (not 0%).
      expect(day(2).coverage).toBe('full')
      expect(day(2).stages).toEqual({ visits: 0, reachedProduct: 0, reachedCart: 0, reachedCheckout: 0, purchased: 0 })
      expect(Object.values(day(2).rates).every(v => v === null)).toBe(true)
      // Every bucket is monotone down the funnel.
      for (const b of j.trend.buckets) {
        if (!b.stages) continue
        const s = b.stages
        expect(s.visits >= s.reachedProduct && s.reachedProduct >= s.reachedCart &&
               s.reachedCart >= s.reachedCheckout && s.reachedCheckout >= s.purchased).toBe(true)
      }
      expect(day(3).rates.visitToProduct).toBeCloseTo(66.67, 2)
    })

    test('days before the first recorded session are "no data", not zero', async () => {
      needDb()
      const j = await (await adminGet('?range=90d')).json()
      expect(j.trend.collectionStartedAt).not.toBeNull()
      const early = j.trend.buckets.filter((b: any) => b.date < ymd(45))
      expect(early.length).toBeGreaterThan(0)
      for (const b of early) { expect(b.coverage).toBe('none'); expect(b.stages).toBeNull(); expect(b.rates).toBeNull() }
      const afterStart = j.trend.buckets.find((b: any) => b.date === ymd(45))
      expect(afterStart.coverage).not.toBe('none')
    })

    test('401 without admin; the database is not consulted', async () => {
      needDb()
      ;(global as any).__AC_DENY = true
      const spy = jest.spyOn(F.db, 'query')
      const res = await adminGet('?range=30d')
      expect(res.status).toBe(401)
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    test.each(['1d', '365d', '30', '7d;drop table x'])('range %p -> 400', async r => {
      needDb()
      expect((await adminGet('?range=' + encodeURIComponent(r))).status).toBe(400)
    })

    test('the trend adds no PII, ids or raw rows to the response', async () => {
      needDb()
      const body = JSON.stringify(await (await adminGet('?range=90d')).json())
      for (const s of Object.values(S)) expect(body).not.toContain(s)
      expect(body).not.toMatch(/session_id|reservation_id|order_id|"meta"|stripe|@/i)
      const j = JSON.parse(body)
      for (const b of j.trend.buckets) {
        expect(Object.keys(b).sort()).toEqual(['coverage', 'date', 'end', 'label', 'partial', 'rates', 'stages', 'start'])
      }
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// FINANCIAL SERIES
// ═════════════════════════════════════════════════════════════════════════════
describeDB('financial series: unknown stays unknown, buckets reconcile to the period (real database)', () => {
  // day 5: one fully known order.   day 4: one order with EVERYTHING unknown.
  // day 3: one known order + one with an unknown Stripe fee.   day 2: nothing.
  const range = () => ({ start: dayRange(6).start, end: dayRange(0).end })

  beforeAll(async () => {
    if (!HAVE_DB || pgFail) return
    await q('DELETE FROM analytics_events')
    await q('DELETE FROM orders')
    await q('DELETE FROM reservations')
    await mkOrder(F.q, 1, { daysAgo: 5 })
    await mkOrder(F.q, 2, { daysAgo: 4, cogs: null, fee: null, label: null, consume: false })
    await mkOrder(F.q, 3, { daysAgo: 3 })
    await mkOrder(F.q, 4, { daysAgo: 3, fee: null })
    await addRefund(F.q, 1, 're_chart_1', 500, { fee: 0 })
  }, 60_000)

  test('per-bucket "missing" counters count exactly the orders with the unknown cost', async () => {
    needDb()
    const { buckets } = await createFinancialService(F.sql).getFinancialTimeSeries(range(), 'day')
    const at = (n: number) => buckets.find(b => b.start === dayRange(n).start)!
    expect(at(5)).toMatchObject({ orderCount: 1, ordersMissingCogs: 0, ordersMissingShippingCost: 0, ordersMissingStripeFee: 0, ordersWithUnknownCosts: 0 })
    expect(at(4)).toMatchObject({ orderCount: 1, ordersMissingCogs: 1, ordersMissingShippingCost: 1, ordersMissingStripeFee: 1 })
    expect(at(4).ordersWithUnknownCosts).toBe(1)
    expect(at(3)).toMatchObject({ orderCount: 2, ordersMissingCogs: 0, ordersMissingShippingCost: 0, ordersMissingStripeFee: 1 })
  })

  test('the buckets add up to the period cards (revenue, costs, refunds, AOV inputs, missing counts)', async () => {
    needDb()
    const svc = createFinancialService(F.sql)
    const r = range()
    const [{ period }, series] = await Promise.all([svc.getPeriodReport(r), svc.getFinancialTimeSeries(r, 'day')])
    const sum = (k: string) => series.buckets.reduce((s: number, b: any) => s + b[k], 0)
    expect(sum('orderCount')).toBe(4)
    expect(sum('netRevenueCents')).toBe(period.netRevenueCents)
    expect(sum('grossCustomerRevenueCents')).toBe(period.grossCustomerRevenueCents)
    expect(sum('refundCents')).toBe(period.refundCents)
    expect(sum('ordersMissingCogs')).toBe(period.ordersMissingCogs)
    expect(sum('ordersMissingShippingCost')).toBe(period.ordersMissingShippingCost)
    expect(sum('ordersMissingStripeFee')).toBe(period.ordersMissingStripeFee)
    expect(sum('ordersWithUnknownCosts')).toBe(period.ordersWithUnknownCosts)
    expect(sum('refundCents')).toBe(500)
    // The all-orders AOV matches the card's definition (same expression, same inputs).
    expect(Math.round(sum('grossCustomerRevenueCents') / sum('orderCount'))).toBe(period.averageOrderValueCents)
  })

  test('average order value per bucket: $15.00 for one order, $15.00 for two, null (not 0) with none', async () => {
    needDb()
    const { buckets } = await createFinancialService(F.sql).getFinancialTimeSeries(range(), 'day')
    const at = (n: number) => buckets.find(b => b.start === dayRange(n).start)!
    expect(at(5).averageOrderValueCents).toBe(1500)
    expect(at(3).averageOrderValueCents).toBe(1500)
    expect(at(2).orderCount).toBe(0)
    expect(at(2).averageOrderValueCents).toBeNull()
  })

  test('the plotted point for the all-unknown day is UNKNOWN (null), the mixed day is INCOMPLETE, the known day exact', async () => {
    needDb()
    const { buckets } = await createFinancialService(F.sql).getFinancialTimeSeries(range(), 'day')
    const at = (n: number) => buckets.find(b => b.start === dayRange(n).start)!
    // all three costs unknown on the only order of the day
    for (const key of ['cogsCents', 'shippingCostCents', 'stripeFeeCents'] as const) {
      const p = plotFinancialPoint(at(4), key)
      expect(p.status).toBe('unknown')
      expect(p.value).toBeNull()
    }
    expect(plotFinancialPoint(at(4), 'realizedProfitCents').value).toBeNull()
    // one of two orders is missing its Stripe fee: a floor, flagged
    const mixed = plotFinancialPoint(at(3), 'stripeFeeCents')
    expect(mixed.status).toBe('incomplete')
    expect(typeof mixed.value).toBe('number')
    expect(plotFinancialPoint(at(3), 'cogsCents').status).toBe('exact')
    // the fully known day is exact, and the empty day is an exact 0, never "unknown"
    expect(plotFinancialPoint(at(5), 'stripeFeeCents').status).toBe('exact')
    expect(plotFinancialPoint(at(2), 'stripeFeeCents')).toEqual({ value: 0, status: 'exact' })
    // revenue and refunds are always exact
    expect(plotFinancialPoint(at(4), 'netRevenueCents').status).toBe('exact')
    expect(plotFinancialPoint(at(5), 'refundCents')).toEqual({ value: 500, status: 'exact' })
  })

  test('the series helper never turns a missing value into 0', async () => {
    needDb()
    const { buckets } = await createFinancialService(F.sql).getFinancialTimeSeries(range(), 'day')
    const s = plotFinancialSeries(buckets as any, 'cogsCents')
    const unknownIdx = s.status.map((st, i) => (st === 'unknown' ? i : -1)).filter(i => i >= 0)
    expect(unknownIdx.length).toBeGreaterThan(0)
    for (const i of unknownIdx) expect(s.values[i]).toBeNull()
  })

  test('empty range: zero orders, null AOV, nothing flagged unknown', async () => {
    needDb()
    const old = { start: '2001-01-01T00:00:00.000Z', end: '2001-01-04T00:00:00.000Z' }
    const { buckets } = await createFinancialService(F.sql).getFinancialTimeSeries(old, 'day')
    expect(buckets.length).toBe(3)
    for (const b of buckets) {
      expect(b.orderCount).toBe(0)
      expect(b.averageOrderValueCents).toBeNull()
      expect(b.ordersMissingCogs + b.ordersMissingShippingCost + b.ordersMissingStripeFee).toBe(0)
      expect(plotFinancialPoint(b as any, 'cogsCents').status).toBe('exact')
    }
  })

  test('the real timeseries route is admin-only and returns aggregates, no ids or contact data', async () => {
    needDb()
    const { GET } = require('../../app/api/admin/financials/timeseries/route')
    ;(global as any).__AC_DENY = true
    const spy = jest.spyOn(F.db, 'query')
    expect((await GET(new NextRequest('http://localhost/api/admin/financials/timeseries?range=30d'))).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    ;(global as any).__AC_DENY = false
    const res = await GET(new NextRequest('http://localhost/api/admin/financials/timeseries?range=30d&granularity=day'))
    expect(res.status).toBe(200)
    const body = JSON.stringify(await res.json())
    expect(body).not.toMatch(/stripe_|cs_FI|pi_FI|ch_FI|txn_FI|re_chart|@|order_id|order_number|FI-0/)
    expect(body).toContain('ordersMissingCogs')
  })
})
