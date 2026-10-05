// lib/__tests__/advanced-charts.test.ts
//
// ADVANCED ADMIN CHARTS — everything that needs no database.
//
//   * lib/chart-data.ts     UNKNOWN is not ZERO at the point where a value becomes a mark
//   * buildFunnelTrend      daily funnel trend: bucketing, coverage, sums, zero denominators
//   * canonical funnel order and conversion maths (incl. zero denominators)
//   * product ranking
//   * the chart-data routes: admin authentication and range validation, DB never touched
//   * source guards: chart components hold no accounting formula, no SQL, no PII fields,
//     and the Financials page no longer turns missing values into zero
//
// The real-PostgreSQL counterpart (advanced-charts-db.test.ts) proves the SQL aggregation.

import fs from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'
import {
  plotFinancialPoint, plotFinancialSeries, summarizeCompleteness, salesTrend,
  displayRatePct, buildFunnelRows, funnelTrendSeries, funnelTrendHasData, rankProducts,
  FUNNEL_COUNT_SERIES, FUNNEL_RATE_SERIES,
  type FinancialBucketView, type ProductRow, type FunnelTrendBucketView,
} from '../chart-data'
import {
  FUNNEL_EVENTS, ratePct, computeFunnelRates, buildFunnelTrend, funnelWindow, FUNNEL_RANGES,
  type FunnelTrendRow,
} from '../funnel-analytics'

// ── route mocks: admin gate + a database that must NOT be touched when the gate or the
//    validation refuses the request ────────────────────────────────────────────────────
const dbCalls: unknown[] = []
jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => {
    if ((global as any).__AC_DENY) {
      return { identity: null, error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
    }
    return { identity: { email: 'charts@test.local' }, error: null }
  },
}))
jest.mock('@/lib/db', () => {
  const touched = (...a: unknown[]) => { (global as any).__AC_DB_CALLS = ((global as any).__AC_DB_CALLS ?? 0) + 1; void a; throw new Error('database touched') }
  const sql: any = Object.assign((...a: unknown[]) => touched(...a), { query: (...a: unknown[]) => touched(...a) })
  return { sql }
})

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const stripComments = (src: string) =>
  src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n')

afterEach(() => { (global as any).__AC_DENY = false; (global as any).__AC_DB_CALLS = 0; dbCalls.length = 0 })

// ─────────────────────────────────────────────────────────────────────────────
// FINANCIAL POINTS: unknown / incomplete / exact
// ─────────────────────────────────────────────────────────────────────────────

const bucket = (o: Partial<FinancialBucketView> = {}): FinancialBucketView => ({
  label: '1 Jun', orderCount: 2, netRevenueCents: 3000, refundCents: 0,
  cogsCents: 600, shippingCostCents: 900, stripeFeeCents: 200,
  operatingExpenseCents: 0, advertisingCents: 0,
  contributionProfitCents: 1300, realizedProfitCents: 1300, isPartial: false,
  averageOrderValueCents: 1500,
  ordersMissingCogs: 0, ordersMissingShippingCost: 0, ordersMissingStripeFee: 0,
  ordersWithUnknownCosts: 0, unknownWriteOffs: 0,
  ...o,
})

describe('a cost that is unknown for every order in a bucket is a gap, never $0', () => {
  test.each([
    ['cogsCents',         { ordersMissingCogs: 2 },         /COGS/],
    ['shippingCostCents', { ordersMissingShippingCost: 2 }, /shipping label cost/],
    ['stripeFeeCents',    { ordersMissingStripeFee: 2 },    /Stripe fee/],
  ] as const)('%s', (key, miss, wording) => {
    // The server's known-so-far sum is 0 here (nothing is known), which is exactly the
    // value that must NOT be drawn.
    const p = plotFinancialPoint(bucket({ ...miss, cogsCents: 0, shippingCostCents: 0, stripeFeeCents: 0 }), key)
    expect(p.status).toBe('unknown')
    expect(p.value).toBeNull()
    expect(p.note).toMatch(/^Unknown/)
    expect(p.note).toMatch(wording)
  })

  test('a single order with the cost unknown is also unknown (the whole bucket is unknown)', () => {
    const p = plotFinancialPoint(bucket({ orderCount: 1, ordersMissingCogs: 1, cogsCents: 0 }), 'cogsCents')
    expect(p).toMatchObject({ status: 'unknown', value: null })
    expect(p.note).toMatch(/the order/)
  })
})

describe('a cost unknown for SOME orders is a floor, drawn as incomplete', () => {
  test('keeps the known-so-far value and says "at least"', () => {
    const p = plotFinancialPoint(bucket({ ordersMissingCogs: 1 }), 'cogsCents')
    expect(p.status).toBe('incomplete')
    expect(p.value).toBe(600)
    expect(p.note).toMatch(/^At least/)
    expect(p.note).toMatch(/1 of 2 orders is missing COGS/)
  })
  test('fully known buckets are exact', () => {
    for (const key of ['cogsCents', 'shippingCostCents', 'stripeFeeCents'] as const) {
      expect(plotFinancialPoint(bucket(), key).status).toBe('exact')
    }
  })
  test('a bucket with no orders has a real zero cost (nothing was sold), not an unknown', () => {
    const p = plotFinancialPoint(bucket({ orderCount: 0, cogsCents: 0, netRevenueCents: 0 }), 'cogsCents')
    expect(p).toEqual({ value: 0, status: 'exact' })
  })
})

describe('profit', () => {
  test('every order has an unrecorded cost -> unknown gap, not the known-so-far figure', () => {
    const p = plotFinancialPoint(bucket({ ordersWithUnknownCosts: 2, isPartial: true }), 'realizedProfitCents')
    expect(p).toMatchObject({ status: 'unknown', value: null })
  })
  test('some orders unknown -> incomplete upper bound, value retained', () => {
    const p = plotFinancialPoint(bucket({ ordersWithUnknownCosts: 1, isPartial: true }), 'realizedProfitCents')
    expect(p.status).toBe('incomplete')
    expect(p.value).toBe(1300)
    expect(p.note).toMatch(/upper bound/)
  })
  test('an unknown-cost write-off also makes the bucket incomplete', () => {
    const p = plotFinancialPoint(bucket({ unknownWriteOffs: 1, isPartial: true }), 'realizedProfitCents')
    expect(p.status).toBe('incomplete')
    expect(p.note).toMatch(/write-off/)
  })
  test('nothing unknown -> exact', () => {
    expect(plotFinancialPoint(bucket(), 'realizedProfitCents')).toEqual({ value: 1300, status: 'exact' })
  })
  test('a no-order bucket keeps its (negative) recognised-expense profit: that is a known figure', () => {
    const p = plotFinancialPoint(bucket({ orderCount: 0, netRevenueCents: 0, realizedProfitCents: -500 }), 'realizedProfitCents')
    expect(p).toEqual({ value: -500, status: 'exact' })
  })
})

describe('older cached responses without the new counters are treated cautiously', () => {
  const old: any = bucket({ isPartial: true })
  for (const k of ['ordersMissingCogs', 'ordersMissingShippingCost', 'ordersMissingStripeFee', 'ordersWithUnknownCosts', 'unknownWriteOffs']) delete old[k]
  test('a partial bucket is incomplete, never exact', () => {
    expect(plotFinancialPoint(old, 'cogsCents').status).toBe('incomplete')
    expect(plotFinancialPoint(old, 'realizedProfitCents').status).toBe('incomplete')
  })
  test('a non-partial bucket is exact', () => {
    const ok: any = { ...old, isPartial: false }
    expect(plotFinancialPoint(ok, 'cogsCents').status).toBe('exact')
  })
})

describe('revenue, refunds, expenses and advertising come from recorded transactions', () => {
  test.each(['netRevenueCents', 'refundCents', 'operatingExpenseCents', 'advertisingCents'] as const)('%s is exact', key => {
    const p = plotFinancialPoint(bucket({ ordersMissingCogs: 2, isPartial: true, refundCents: 700, operatingExpenseCents: 50, advertisingCents: 9 }), key)
    expect(p.status).toBe('exact')
    expect(p.value).not.toBeNull()
  })
  test('an unset refund field is 0 (no refunds), not unknown', () => {
    const b: any = bucket(); delete b.refundCents
    expect(plotFinancialPoint(b, 'refundCents')).toEqual({ value: 0, status: 'exact' })
  })
})

describe('series helpers', () => {
  const bs = [bucket(), bucket({ ordersMissingCogs: 2, cogsCents: 0 }), bucket({ ordersMissingCogs: 1 }), bucket({ orderCount: 0, cogsCents: 0 })]
  test('series keep one entry per bucket and preserve nulls', () => {
    const s = plotFinancialSeries(bs, 'cogsCents')
    expect(s.values).toEqual([600, null, 600, 0])
    expect(s.status).toEqual(['exact', 'unknown', 'incomplete', 'exact'])
    expect(s.notes.filter(Boolean)).toHaveLength(2)
  })
  test('completeness counts unknown before incomplete', () => {
    expect(summarizeCompleteness(bs, ['cogsCents'])).toEqual({ unknown: 1, incomplete: 1 })
    expect(summarizeCompleteness(bs, ['netRevenueCents'])).toEqual({ unknown: 0, incomplete: 0 })
  })
  test('empty input', () => {
    expect(plotFinancialSeries([], 'cogsCents')).toEqual({ values: [], status: [], bounds: [], notes: [] })
    expect(summarizeCompleteness([], ['cogsCents'])).toEqual({ unknown: 0, incomplete: 0 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SALES TREND
// ─────────────────────────────────────────────────────────────────────────────

describe('sales / order trend', () => {
  test('orders are real counts; AOV is the server value; a no-order bucket has NO average', () => {
    const t = salesTrend([
      bucket({ orderCount: 3, averageOrderValueCents: 1999 }),
      bucket({ orderCount: 0, averageOrderValueCents: null }),
      bucket({ orderCount: 1, averageOrderValueCents: 1500 }),
    ])
    expect(t.orders).toEqual([3, 0, 1])
    expect(t.averageOrderValueCents).toEqual([1999, null, 1500])
  })
  test('a missing AOV field is unknown (null), never 0', () => {
    const b: any = bucket({ orderCount: 2 }); delete b.averageOrderValueCents
    expect(salesTrend([b]).averageOrderValueCents).toEqual([null])
  })
  test('even a stray zero AOV for a no-order bucket is not drawn', () => {
    expect(salesTrend([bucket({ orderCount: 0, averageOrderValueCents: 0 })]).averageOrderValueCents).toEqual([null])
  })
  test('empty', () => {
    expect(salesTrend([])).toEqual({ orders: [], averageOrderValueCents: [] })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FUNNEL: ORDER AND CONVERSION MATHS
// ─────────────────────────────────────────────────────────────────────────────

describe('funnel stage ordering and conversion', () => {
  const stages = { visits: 200, reachedProduct: 120, reachedCart: 40, reachedCheckout: 10, purchased: 5 }
  const rows = buildFunnelRows(stages, computeFunnelRates(stages))

  test('rows follow the canonical event order', () => {
    expect(rows.map(r => r.event)).toEqual([...FUNNEL_EVENTS])
    expect(rows.map(r => r.event)).toEqual(['session_start', 'product_viewed', 'add_to_cart', 'checkout_started', 'purchase_completed'])
    expect(rows.map(r => r.key)).toEqual(['visits', 'reachedProduct', 'reachedCart', 'reachedCheckout', 'purchased'])
  })
  test('counts are carried through unchanged and never increase down the funnel', () => {
    expect(rows.map(r => r.count)).toEqual([200, 120, 40, 10, 5])
    for (let i = 1; i < rows.length; i++) expect(rows[i].count).toBeLessThanOrEqual(rows[i - 1].count)
  })
  test('share of visits and step conversion', () => {
    expect(rows.map(r => r.pctOfVisits)).toEqual([100, 60, 20, 5, 2.5])
    expect(rows.map(r => r.stepRatePct)).toEqual([null, 60, 33.33, 25, 50])
    expect(rows.map(r => r.notRecordedAtStep)).toEqual([null, 80, 80, 30, 5])
  })
  test('step rates are the server rates, not recomputed', () => {
    const r = { visitToProduct: 1, productToCart: 2, cartToCheckout: 3, checkoutToPurchase: 4, visitToPurchase: 5 }
    expect(buildFunnelRows(stages, r).map(x => x.stepRatePct)).toEqual([null, 1, 2, 3, 4])
  })
  test('zero denominators: every rate and share is null (unknown), never 0%', () => {
    const z = { visits: 0, reachedProduct: 0, reachedCart: 0, reachedCheckout: 0, purchased: 0 }
    const zr = buildFunnelRows(z, computeFunnelRates(z))
    expect(zr.every(r => r.pctOfVisits === null && r.stepRatePct === null)).toBe(true)
    expect(zr.map(r => r.notRecordedAtStep)).toEqual([null, 0, 0, 0, 0])
  })
  test('a stage with a zero denominator mid-funnel has a null step rate', () => {
    const s = { visits: 10, reachedProduct: 0, reachedCart: 0, reachedCheckout: 0, purchased: 0 }
    const r = buildFunnelRows(s, computeFunnelRates(s))
    expect(r[1].stepRatePct).toBe(0)        // 0 of 10 visits reached a product: a real 0%
    expect(r[2].stepRatePct).toBeNull()     // 0 sessions reached a product: nothing to divide by
  })
})

describe('displayRatePct agrees with the canonical ratePct', () => {
  const cases: Array<[number, number]> = [
    [0, 0], [1, 0], [0, 1], [1, 3], [2, 3], [5, 200], [7, 9], [100, 100], [1, 1e9], [3, -1],
    [NaN, 5], [5, NaN], [Infinity, 5], [5, Infinity], [199, 200], [1, 7], [13, 17], [0.5, 2],
  ]
  test.each(cases)('(%p, %p)', (n, d) => {
    expect(displayRatePct(n, d)).toBe(ratePct(n, d))
  })
  test('randomised agreement', () => {
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let i = 0; i < 500; i++) {
      const n = Math.floor(rnd() * 500), d = Math.floor(rnd() * 500)
      expect(displayRatePct(n, d)).toBe(ratePct(n, d))
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FUNNEL TREND (pure builder)
// ─────────────────────────────────────────────────────────────────────────────

describe('funnel trend buckets', () => {
  const row = (day: string, v: number, p: number, c: number, k: number, b: number): FunnelTrendRow =>
    ({ day, visits: v, reached_product: p, reached_cart: c, reached_checkout: k, purchased: b })
  const W = { start: '2026-09-01T00:00:00.000Z', end: '2026-09-08T00:00:00.000Z' }

  test('one contiguous bucket per UTC day, labelled, covering the window exactly', () => {
    const t = buildFunnelTrend(W, [], '2026-01-01T00:00:00.000Z')
    expect(t.granularity).toBe('day')
    expect(t.buckets.map(b => b.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'])
    expect(t.buckets[0].label).toBe('1 Sep')
    for (let i = 1; i < t.buckets.length; i++) expect(t.buckets[i].start).toBe(t.buckets[i - 1].end)
    expect(t.buckets[0].start).toBe(W.start)
    expect(t.buckets[t.buckets.length - 1].end).toBe(W.end)
    expect(t.buckets.every(b => b.partial === false)).toBe(true)
  })

  test('rows land on their day; empty days after collection began are real zeros with null rates', () => {
    const t = buildFunnelTrend(W, [row('2026-09-03', 10, 6, 3, 1, 1)], '2026-01-01T00:00:00.000Z')
    const d3 = t.buckets[2]
    expect(d3.stages).toEqual({ visits: 10, reachedProduct: 6, reachedCart: 3, reachedCheckout: 1, purchased: 1 })
    expect(d3.rates).toEqual({ visitToProduct: 60, productToCart: 50, cartToCheckout: 33.33, checkoutToPurchase: 100, visitToPurchase: 10 })
    const d4 = t.buckets[3]
    expect(d4.stages).toEqual({ visits: 0, reachedProduct: 0, reachedCart: 0, reachedCheckout: 0, purchased: 0 })
    expect(Object.values(d4.rates!).every(v => v === null)).toBe(true)         // zero denominator: never 0%
    expect(d4.coverage).toBe('full')
  })

  test('days before analytics collection existed are "no data", not zero', () => {
    const t = buildFunnelTrend(W, [row('2026-09-03', 4, 2, 1, 0, 0)], '2026-09-03T08:15:00.000Z')
    expect(t.collectionStartedAt).toBe('2026-09-03T08:15:00.000Z')
    expect(t.buckets.slice(0, 2).map(b => [b.coverage, b.stages, b.rates])).toEqual([
      ['none', null, null], ['none', null, null]])
    expect(t.buckets[2].coverage).toBe('partial')      // collection began inside this day
    expect(t.buckets[3].coverage).toBe('full')
    expect(t.buckets[3].stages!.visits).toBe(0)
  })

  test('a day that ENDS exactly when collection began is still no data', () => {
    const t = buildFunnelTrend(W, [], '2026-09-03T00:00:00.000Z')
    expect(t.buckets[1].coverage).toBe('none')
    expect(t.buckets[2].coverage).toBe('full')
  })

  test('nothing ever recorded: every day is no data, collectionStartedAt is null', () => {
    const t = buildFunnelTrend(W, [], null)
    expect(t.collectionStartedAt).toBeNull()
    expect(t.buckets.every(b => b.coverage === 'none' && b.stages === null && b.rates === null)).toBe(true)
  })

  test('an unparseable collection instant is treated as "none ever recorded"', () => {
    expect(buildFunnelTrend(W, [], 'not a date').buckets.every(b => b.coverage === 'none')).toBe(true)
  })

  test('accepts a Date from the database driver', () => {
    const t = buildFunnelTrend(W, [], new Date('2026-01-01T00:00:00Z'))
    expect(t.collectionStartedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  test('summing the buckets reproduces the totals (the summary invariant)', () => {
    const rows = [row('2026-09-01', 5, 4, 2, 1, 1), row('2026-09-02', 7, 5, 3, 1, 0), row('2026-09-07', 2, 1, 0, 0, 0)]
    const t = buildFunnelTrend(W, rows, '2026-01-01T00:00:00Z')
    const sum = (k: keyof NonNullable<typeof t.buckets[0]['stages']>) => t.buckets.reduce((s, b) => s + (b.stages?.[k] ?? 0), 0)
    expect(sum('visits')).toBe(14)
    expect(sum('reachedProduct')).toBe(10)
    expect(sum('reachedCart')).toBe(5)
    expect(sum('reachedCheckout')).toBe(2)
    expect(sum('purchased')).toBe(1)
  })

  test('rows outside the window are ignored (never invented into a bucket)', () => {
    const t = buildFunnelTrend(W, [row('2026-08-30', 9, 9, 9, 9, 9), row('2026-09-09', 9, 9, 9, 9, 9)], '2026-01-01T00:00:00Z')
    expect(t.buckets.reduce((s, b) => s + (b.stages?.visits ?? 0), 0)).toBe(0)
  })

  test('a rolling window has partial first and last days, flagged', () => {
    const t = buildFunnelTrend({ start: '2026-09-01T06:30:00.000Z', end: '2026-10-01T06:30:00.000Z' }, [], '2026-01-01T00:00:00Z')
    expect(t.buckets).toHaveLength(31)
    expect(t.buckets[0].partial).toBe(true)
    expect(t.buckets[30].partial).toBe(true)
    expect(t.buckets.slice(1, 30).every(b => !b.partial)).toBe(true)
    expect(t.buckets[0].date).toBe('2026-09-01')
  })

  test.each(FUNNEL_RANGES.map(r => [r]))('the %s control produces a trend over the SAME window as the summary', r => {
    const now = new Date('2026-10-04T15:00:00.000Z')
    const w = funnelWindow(r, now)
    const days = Number(r.slice(0, -1))
    const t = buildFunnelTrend(w, [], '2020-01-01T00:00:00Z')
    expect(t.buckets[0].start).toBe(w.start)
    expect(t.buckets[t.buckets.length - 1].end).toBe(w.end)
    // N whole days back from mid-afternoon touches N + 1 UTC calendar days.
    expect(t.buckets).toHaveLength(days + 1)
    expect(t.buckets.length).toBeGreaterThan(1)                    // never one collapsed time point
  })

  test('a degenerate window yields no buckets, not a crash', () => {
    expect(buildFunnelTrend({ start: W.end, end: W.start }, [], null).buckets).toEqual([])
  })
})

describe('funnel trend series for the chart', () => {
  const view = (o: Partial<FunnelTrendBucketView> = {}): FunnelTrendBucketView => ({
    label: '1 Sep', date: '2026-09-01', partial: false, coverage: 'full',
    stages: { visits: 10, reachedProduct: 6, reachedCart: 3, reachedCheckout: 1, purchased: 1 },
    rates: computeFunnelRates({ visits: 10, reachedProduct: 6, reachedCart: 3, reachedCheckout: 1, purchased: 1 }),
    ...o,
  })
  const noData = view({ coverage: 'none', stages: null, rates: null })
  const zeroDay = view({
    stages: { visits: 0, reachedProduct: 0, reachedCart: 0, reachedCheckout: 0, purchased: 0 },
    rates: computeFunnelRates({ visits: 0, reachedProduct: 0, reachedCart: 0, reachedCheckout: 0, purchased: 0 }),
  })

  test('counts mode: four series in funnel order; a no-data day is null, a zero day is 0', () => {
    const s = funnelTrendSeries([noData, zeroDay, view()], 'counts')
    expect(s.map(x => x.key)).toEqual(['visits', 'reachedCart', 'reachedCheckout', 'purchased'])
    expect(s[0].values).toEqual([null, 0, 10])
    expect(s[3].values).toEqual([null, 0, 1])
    expect(s[0].notes[0]).toMatch(/collection had not started/)
    expect(s[0].unit).toBe('count')
  })
  test('conversion mode: step rates; a zero-denominator day is null, never 0%', () => {
    const s = funnelTrendSeries([noData, zeroDay, view()], 'conversion')
    expect(s.map(x => x.key)).toEqual(['visitToProduct', 'productToCart', 'cartToCheckout', 'checkoutToPurchase'])
    expect(s[0].values).toEqual([null, null, 60])
    expect(s[0].unit).toBe('pct')
    expect(s[0].notes[1]).toMatch(/No rate/)
    expect(s[0].notes[2]).toBe('6 of 10 sessions')
    expect(s[1].notes[2]).toBe('3 of 6 sessions that reached a product')
  })
  test('partial days are called out in the tooltip text', () => {
    const s = funnelTrendSeries([view({ partial: true }), view({ coverage: 'partial' })], 'counts')
    expect(s[0].notes[0]).toMatch(/Partial day/)
    expect(s[0].notes[1]).toMatch(/Collection began/)
  })
  test('series definitions are in canonical funnel order', () => {
    expect(FUNNEL_COUNT_SERIES.map(d => d.key)).toEqual(['visits', 'reachedCart', 'reachedCheckout', 'purchased'])
    expect(FUNNEL_RATE_SERIES.map(d => d.rate)).toEqual(['visitToProduct', 'productToCart', 'cartToCheckout', 'checkoutToPurchase'])
  })
  test('hasData: needs at least one real session', () => {
    expect(funnelTrendHasData([])).toBe(false)
    expect(funnelTrendHasData([noData, zeroDay])).toBe(false)
    expect(funnelTrendHasData([noData, view()])).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT RANKING
// ─────────────────────────────────────────────────────────────────────────────

describe('product ranking', () => {
  const p = (name: string, views: number, adds: number, purchases: number): ProductRow => ({
    productId: name, slug: name.toLowerCase(), name, views, adds, checkouts: 0, purchases,
    addRatePct: null, purchaseRatePct: null,
  })
  const rows = [p('Beta', 5, 1, 0), p('Alpha', 5, 3, 1), p('Gamma', 9, 0, 0), p('Delta', 0, 0, 0), p('Echo', 5, 3, 2)]

  test('ranks by the chosen metric, descending', () => {
    expect(rankProducts(rows, 'views').map(r => r.name)).toEqual(['Gamma', 'Alpha', 'Beta', 'Echo'])
    expect(rankProducts(rows, 'adds').map(r => r.name)).toEqual(['Alpha', 'Echo', 'Beta'])
    expect(rankProducts(rows, 'purchases').map(r => r.name)).toEqual(['Echo', 'Alpha'])
  })
  test('ties break on views, then name, deterministically', () => {
    // Alpha, Beta and Echo tie on 5 views: all three are equal, so name decides.
    expect(rankProducts([p('Beta', 5, 0, 0), p('Alpha', 5, 0, 0)], 'views').map(r => r.name)).toEqual(['Alpha', 'Beta'])
    // equal adds -> more views first
    expect(rankProducts([p('A', 2, 4, 0), p('B', 9, 4, 0)], 'adds').map(r => r.name)).toEqual(['B', 'A'])
  })
  test('products with nothing recorded for the metric are not ranked', () => {
    expect(rankProducts(rows, 'purchases').some(r => r.purchases === 0)).toBe(false)
    expect(rankProducts([p('Zero', 0, 0, 0)], 'views')).toEqual([])
  })
  test('limit, empty input and a zero limit', () => {
    expect(rankProducts(rows, 'views', 2)).toHaveLength(2)
    expect(rankProducts([], 'views')).toEqual([])
    expect(rankProducts(rows, 'views', 0)).toEqual([])
  })
  test('does not mutate its input', () => {
    const copy = JSON.stringify(rows)
    rankProducts(rows, 'views')
    expect(JSON.stringify(rows)).toBe(copy)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES: admin authentication and range validation (the database is never reached)
// ─────────────────────────────────────────────────────────────────────────────

describe('chart data routes', () => {
  const funnelGet = (qs = '') => {
    const { GET } = require('../../app/api/admin/analytics/funnel/route')
    return GET(new NextRequest('http://localhost/api/admin/analytics/funnel' + qs))
  }
  const seriesGet = (qs = '') => {
    const { GET } = require('../../app/api/admin/financials/timeseries/route')
    return GET(new NextRequest('http://localhost/api/admin/financials/timeseries' + qs))
  }

  test.each([
    ['funnel', () => funnelGet('?range=30d')],
    ['financial time series', () => seriesGet('?range=30d')],
  ])('%s: refused without admin, database untouched', async (_n, call) => {
    ;(global as any).__AC_DENY = true
    const res = await call()
    expect(res.status).toBe(401)
    expect((global as any).__AC_DB_CALLS ?? 0).toBe(0)
  })

  test.each(['1d', '365d', 'ytd', '30', '7d;drop table x', '%27', '0d', '-7d', ' 7d'])('funnel range %p -> 400, no query', async r => {
    const res = await funnelGet('?range=' + encodeURIComponent(r))
    expect(res.status).toBe(400)
    expect((global as any).__AC_DB_CALLS ?? 0).toBe(0)
  })

  test.each([
    ['end before start',      '?start=2026-10-05&end=2026-10-01'],
    ['not a date',            '?start=abc&end=2026-10-01'],
    ['injection attempt',     "?start=2026-10-01';DROP TABLE orders;--&end=2026-10-03"],
    ['absurdly long range',   '?start=2020-01-01&end=2026-10-01'],
    ['zero-length (same ms)', '?start=2026-10-01T00:00:00Z&end=2026-10-01T00:00:00Z'],
  ])('financial series custom range: %s -> 400, no query', async (_n, qs) => {
    const res = await seriesGet(qs)
    expect(res.status).toBe(400)
    expect((global as any).__AC_DB_CALLS ?? 0).toBe(0)
  })

  test('the funnel route accepts exactly the 7/30/90 day controls (and defaults to 30d)', () => {
    const { parseFunnelRange } = require('../funnel-analytics')
    expect(FUNNEL_RANGES).toEqual(['7d', '30d', '90d'])
    expect(parseFunnelRange(null)).toBe('30d')
    for (const r of FUNNEL_RANGES) expect(parseFunnelRange(r)).toBe(r)
    expect(parseFunnelRange('14d')).toBeNull()
  })

  test('the routes authenticate BEFORE doing anything else', () => {
    for (const f of ['app/api/admin/analytics/funnel/route.ts', 'app/api/admin/financials/timeseries/route.ts']) {
      const src = read(f)
      const body = src.slice(src.indexOf('export async function GET'))
      expect(body.indexOf('requireAdmin(req)')).toBeGreaterThan(-1)
      expect(body.indexOf('requireAdmin(req)')).toBeLessThan(body.indexOf('createFunnelService') >= 0
        ? body.indexOf('createFunnelService') : body.indexOf('createFinancialService'))
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE GUARDS
// ─────────────────────────────────────────────────────────────────────────────

describe('chart code is display-only', () => {
  const files = [
    'components/admin/charts/LineChart.tsx',
    'components/admin/charts/BarChart.tsx',
    'components/admin/charts/FunnelChart.tsx',
    'components/admin/charts/ProductBarChart.tsx',
    'components/admin/charts/ChartBoundary.tsx',
    'components/admin/charts/BreakdownChart.tsx',
    'lib/chart-data.ts',
  ]
  test.each(files)('%s defines no accounting formula, queries nothing, imports no financial module', f => {
    const code = stripComments(read(f))
    for (const forbidden of ['subtotalCents -', 'merchandiseDiscount', 'contributionProfit =', 'netRevenue =',
      'grossMerchandise', 'stripeFee -', 'shippingMargin', 'computeOrderEconomics', 'computePeriodEconomics',
      'financial-calculator', "from '@/lib/financials'", "@/lib/db", 'sql`', 'fetch(']) {
      expect(code).not.toContain(forbidden)
    }
    // the client bundle must never pull in node:crypto via the funnel service module
    expect(code).not.toMatch(/import\s+(?!type)[^;]*from ['"]@?\/?(\.\.\/)*(lib\/)?funnel-analytics['"]/)
  })

  test('the chart pages import types only from funnel-analytics, never values', () => {
    const src = read('app/admin/analytics/AnalyticsClient.tsx')
    expect(src).not.toMatch(/from ['"]@\/lib\/funnel-analytics['"]/)
  })

  test('the Financials chart no longer converts a missing value into zero', () => {
    const src = read('app/admin/financials/FinancialsClient.tsx')
    expect(src).not.toContain('Number(b[d.key] ?? 0)')
    expect(src).toContain('plotFinancialSeries')
  })

  test('no new response or chart module carries personal or payment identifiers', () => {
    const code = stripComments(read('lib/chart-data.ts'))
    for (const field of ['email', 'phone', 'address', 'stripe_', 'stripeId', 'customer', 'session_id', 'sessionId',
      'payment_intent', 'checkout_session', 'order_id', 'orderId']) {
      expect(code.toLowerCase()).not.toContain(field.toLowerCase())
    }
  })

  test('no migration was added for the charts', () => {
    const files = fs.readdirSync(path.join(ROOT, 'db/migrations')).filter(f => f.endsWith('.sql'))
    // The charts feature added no migration of its own. (Migrations 023+ exist for unrelated, later
    // work; this guard used to assert the chain ended at 022 and went stale when 023/024 landed.)
    expect(files.some(f => /chart/i.test(f))).toBe(false)
  })

  test('no chart library was added', () => {
    const pkg = JSON.parse(read('package.json'))
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    for (const lib of ['recharts', 'chart.js', 'react-chartjs-2', 'd3', 'victory', 'nivo', '@nivo/core', 'apexcharts', 'echarts', 'plotly.js', 'visx']) {
      expect(deps).not.toContain(lib)
    }
  })
})
