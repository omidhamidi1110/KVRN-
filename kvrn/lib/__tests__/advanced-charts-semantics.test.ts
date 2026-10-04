// lib/__tests__/advanced-charts-semantics.test.ts
//
// REVISION 1 semantics, tested on the PURE helpers the charts render from (no React
// renderer is configured in this repo; the components call exactly these functions):
//
//   1. an incomplete value carries a typed BOUND DIRECTION:
//        cost   -> floor   -> "≥"      profit -> ceiling -> "≤"      no bound -> "known so far"
//   2. exact ZERO is data. Only no-buckets / all-null is "no data".
//   3. unknown is never zero, in either direction.

import fs from 'fs'
import path from 'path'
import {
  plotFinancialPoint, plotFinancialSeries, salesTrend, formatPointValue, incompleteLegend,
  seriesDataState, funnelSummaryDataState, type FinancialBucketView, type FinancialSeriesKey,
} from '../chart-data'
import { niceTicks } from '../chart-math'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

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
const money = (c: number) => `$${(c / 100).toFixed(2)}`
/** What the tooltip prints for a plotted point, through the same helper LineChart uses. */
const tip = (b: FinancialBucketView, key: FinancialSeriesKey) => {
  const p = plotFinancialPoint(b, key)
  return formatPointValue(p.value === null ? null : money(p.value), p.status, p.bound)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. BOUND DIRECTION
// ─────────────────────────────────────────────────────────────────────────────
describe('incomplete COST is a floor and reads "≥"', () => {
  test.each([
    ['cogsCents',         { ordersMissingCogs: 1 },         '≥ $6.00'],
    ['shippingCostCents', { ordersMissingShippingCost: 1 }, '≥ $9.00'],
    ['stripeFeeCents',    { ordersMissingStripeFee: 1 },    '≥ $2.00'],
  ] as const)('%s with one of two orders missing', (key, miss, text) => {
    const b = bucket(miss)
    const p = plotFinancialPoint(b, key)
    expect(p.status).toBe('incomplete')
    expect(p.bound).toBe('floor')
    expect(tip(b, key)).toBe(text)
    expect(tip(b, key)).not.toContain('≤')
  })

  test('the legacy fallback (no per-order counters, bucket isPartial) is still a floor for a cost', () => {
    const old = bucket({ ordersMissingCogs: undefined, isPartial: true })
    expect(plotFinancialPoint(old, 'cogsCents')).toMatchObject({ status: 'incomplete', bound: 'floor' })
    expect(tip(old, 'cogsCents')).toMatch(/^≥ /)
  })
})

describe('incomplete realised PROFIT is a ceiling and reads "≤", never "≥"', () => {
  test.each([
    ['an order with an unrecorded cost', { ordersWithUnknownCosts: 1 }],
    ['a write-off with unknown cost',    { unknownWriteOffs: 1 }],
    ['both',                             { ordersWithUnknownCosts: 1, unknownWriteOffs: 2 }],
  ])('%s', (_n, miss) => {
    const b = bucket({ ...miss, isPartial: true })
    const p = plotFinancialPoint(b, 'realizedProfitCents')
    expect(p.status).toBe('incomplete')
    expect(p.bound).toBe('ceiling')
    expect(p.value).toBe(1300)                                // the money value is untouched
    expect(tip(b, 'realizedProfitCents')).toBe('≤ $13.00')
    expect(tip(b, 'realizedProfitCents')).not.toContain('≥')
    expect(p.note).toMatch(/upper bound/i)
  })

  test('a NEGATIVE known-so-far profit is still a ceiling: "≤ -$5.00"', () => {
    const b = bucket({ ordersWithUnknownCosts: 1, isPartial: true, realizedProfitCents: -500 })
    expect(formatPointValue('-$5.00', 'incomplete', plotFinancialPoint(b, 'realizedProfitCents').bound)).toBe('≤ -$5.00')
  })

  test('the legacy fallback (no counters, isPartial) is a ceiling for profit, never a floor', () => {
    const old = bucket({ ordersWithUnknownCosts: undefined, isPartial: true })
    expect(plotFinancialPoint(old, 'realizedProfitCents')).toMatchObject({ status: 'incomplete', bound: 'ceiling' })
    expect(tip(old, 'realizedProfitCents')).toMatch(/^≤ /)
  })
})

describe('exact values carry no bound marker', () => {
  test.each(['netRevenueCents', 'refundCents', 'cogsCents', 'shippingCostCents', 'stripeFeeCents',
            'operatingExpenseCents', 'advertisingCents', 'realizedProfitCents'] as const)('%s', key => {
    const b = bucket()
    const p = plotFinancialPoint(b, key)
    expect(p.status).toBe('exact')
    expect(p.bound).toBeUndefined()
    expect(tip(b, key)).toBe(money(p.value as number))
    expect(tip(b, key)).not.toMatch(/[≥≤]|known so far/)
  })
  test('revenue and refunds stay exact even in a bucket with unknown costs', () => {
    const b = bucket({ ordersMissingCogs: 2, ordersWithUnknownCosts: 2, isPartial: true })
    for (const key of ['netRevenueCents', 'refundCents'] as const) {
      expect(plotFinancialPoint(b, key).bound).toBeUndefined()
      expect(plotFinancialPoint(b, key).status).toBe('exact')
    }
  })
})

describe('unknown stays "Unknown" and is never zero', () => {
  test.each([
    ['cogsCents', { ordersMissingCogs: 2 }],
    ['shippingCostCents', { ordersMissingShippingCost: 2 }],
    ['stripeFeeCents', { ordersMissingStripeFee: 2 }],
    ['realizedProfitCents', { ordersWithUnknownCosts: 2 }],
  ] as const)('%s', (key, miss) => {
    const b = bucket(miss)
    const p = plotFinancialPoint(b, key)
    expect(p).toMatchObject({ value: null, status: 'unknown' })
    expect(p.bound).toBeUndefined()                        // unknown has no bound: there is no value
    expect(tip(b, key)).toBe('Unknown')
    expect(tip(b, key)).not.toMatch(/0/)
  })
  test('a missing, non-unknown value is a dash, not a zero', () => {
    expect(formatPointValue(null, undefined)).toBe('—')
    expect(formatPointValue(null, 'exact')).toBe('—')
    expect(formatPointValue(null, 'incomplete', 'floor')).toBe('—')
  })
  test('plotFinancialSeries keeps value, status and bound arrays aligned and null where unknown', () => {
    const bs = [bucket(), bucket({ ordersMissingCogs: 2 }), bucket({ ordersMissingCogs: 1 })]
    const s = plotFinancialSeries(bs, 'cogsCents')
    expect(s.values).toEqual([600, null, 600])
    expect(s.status).toEqual(['exact', 'unknown', 'incomplete'])
    expect(s.bounds).toEqual([undefined, undefined, 'floor'])
    expect(s.notes.length).toBe(3)
  })
})

describe('a generic incomplete point claims no direction', () => {
  test('formatPointValue without a bound says "known so far", with neither symbol', () => {
    const t = formatPointValue('1,200 sessions', 'incomplete')
    expect(t).toBe('1,200 sessions (known so far)')
    expect(t).not.toMatch(/[≥≤]/)
  })
  test('exact / unknown ignore a stray bound', () => {
    expect(formatPointValue('$1.00', 'exact', 'floor')).toBe('$1.00')
    expect(formatPointValue(null, 'unknown', 'ceiling')).toBe('Unknown')
  })
})

describe('legend and ARIA wording follow the bound direction', () => {
  test('a cost series: floor wording only', () => {
    const s = plotFinancialSeries([bucket({ ordersMissingCogs: 1 })], 'cogsCents')
    const l = incompleteLegend([s])
    expect(l).toMatch(/≥ costs are at least/)
    expect(l).not.toMatch(/≤/)
  })
  test('a profit series: ceiling wording only', () => {
    const s = plotFinancialSeries([bucket({ ordersWithUnknownCosts: 1, isPartial: true })], 'realizedProfitCents')
    const l = incompleteLegend([s])
    expect(l).toMatch(/≤ profit is at most/)
    expect(l).not.toMatch(/≥/)
  })
  test('both together name both; exact-only charts have no legend text', () => {
    const a = plotFinancialSeries([bucket({ ordersMissingCogs: 1 })], 'cogsCents')
    const b = plotFinancialSeries([bucket({ ordersWithUnknownCosts: 1, isPartial: true })], 'realizedProfitCents')
    expect(incompleteLegend([a, b])).toMatch(/≥ costs.*≤ profit/)
    expect(incompleteLegend([plotFinancialSeries([bucket()], 'cogsCents')])).toBe('')
  })
  test('an incomplete point with no bound is described neutrally', () => {
    expect(incompleteLegend([{ status: ['incomplete'], bounds: [undefined] }])).toBe('other incomplete values are known so far, not final')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. EXACT ZERO IS DATA
// ─────────────────────────────────────────────────────────────────────────────
describe('seriesDataState distinguishes empty, unknown, known-zero and data', () => {
  test('exact [0,0,0] is a known ZERO, not empty', () => {
    expect(seriesDataState(3, [{ values: [0, 0, 0] }])).toBe('zero')
    expect(seriesDataState(3, [{ values: [0, 0, 0], status: ['exact', 'exact', 'exact'] }])).toBe('zero')
  })
  test('no buckets, no series: empty', () => {
    expect(seriesDataState(0, [{ values: [] }])).toBe('empty')
    expect(seriesDataState(3, [])).toBe('empty')
  })
  test('all null with no flag stays empty / no data', () => {
    expect(seriesDataState(3, [{ values: [null, null, null] }])).toBe('empty')
    expect(seriesDataState(3, [{ values: [null, undefined, null] }])).toBe('empty')
  })
  test('all null but flagged unknown is "unknown" (drawn, so the shading is visible), never empty or zero', () => {
    expect(seriesDataState(3, [{ values: [null, null, null], status: ['unknown', 'unknown', 'unknown'] }])).toBe('unknown')
  })
  test('unknown gaps beside real zeros: the known values are still a known zero', () => {
    expect(seriesDataState(3, [{ values: [0, null, 0], status: ['exact', 'unknown', 'exact'] }])).toBe('zero')
  })
  test('any non-zero value is data, including a negative profit', () => {
    expect(seriesDataState(3, [{ values: [0, 5, 0] }])).toBe('data')
    expect(seriesDataState(2, [{ values: [-1, 0] }])).toBe('data')
  })
  test('an INCOMPLETE zero is a floor, not "all zero": it is data', () => {
    expect(seriesDataState(2, [{ values: [0, 0], status: ['incomplete', 'exact'] }])).toBe('data')
  })
  test('one series all zero beside a non-zero series is data', () => {
    expect(seriesDataState(2, [{ values: [0, 0] }, { values: [3, 4] }])).toBe('data')
  })
  test('NaN / non-finite never counts as a known value or as zero', () => {
    expect(seriesDataState(2, [{ values: [NaN, Infinity] }])).toBe('empty')
  })
})

describe('real chart inputs', () => {
  test('a $0 advertising / refunds series is a known zero, not no-data', () => {
    const bs = [bucket(), bucket(), bucket()]
    for (const key of ['advertisingCents', 'refundCents', 'operatingExpenseCents'] as const) {
      const s = plotFinancialSeries(bs, key)
      expect(s.status.every(x => x === 'exact')).toBe(true)
      expect(seriesDataState(bs.length, [s])).toBe('zero')
    }
  })
  test('an unknown-cost series with every bucket unknown is "unknown", not zero and not empty', () => {
    const bs = [bucket({ ordersMissingCogs: 2 }), bucket({ ordersMissingCogs: 2 })]
    const s = plotFinancialSeries(bs, 'cogsCents')
    expect(s.values).toEqual([null, null])
    expect(seriesDataState(bs.length, [s])).toBe('unknown')
  })
  test('paid orders: all-zero counts are a known zero (BarChart shows "0 paid orders")', () => {
    const bs = [bucket({ orderCount: 0 }), bucket({ orderCount: 0 }), bucket({ orderCount: 0 })]
    const { orders } = salesTrend(bs)
    expect(orders).toEqual([0, 0, 0])
    expect(seriesDataState(bs.length, [{ values: orders }])).toBe('zero')
  })
  test('paid orders: no buckets at all is empty', () => {
    expect(seriesDataState(0, [{ values: salesTrend([]).orders }])).toBe('empty')
  })
  test('AOV: a bucket with no orders is a gap (null), never $0; all-null AOV is empty', () => {
    const bs = [bucket({ orderCount: 0, averageOrderValueCents: null }), bucket({ orderCount: 0, averageOrderValueCents: null })]
    const { averageOrderValueCents } = salesTrend(bs)
    expect(averageOrderValueCents).toEqual([null, null])
    expect(seriesDataState(bs.length, [{ values: averageOrderValueCents }])).toBe('empty')
    // even a stray 0 from a server must not become a plotted AOV for an order-less bucket
    expect(salesTrend([bucket({ orderCount: 0, averageOrderValueCents: 0 })]).averageOrderValueCents).toEqual([null])
  })
  test('AOV: a day with orders keeps the server value; order-less days stay gaps', () => {
    const { averageOrderValueCents } = salesTrend([bucket(), bucket({ orderCount: 0, averageOrderValueCents: null })])
    expect(averageOrderValueCents).toEqual([1500, null])
    expect(seriesDataState(2, [{ values: averageOrderValueCents }])).toBe('data')
  })
  test('the all-zero axis is only the baseline: niceTicks alone would invent a top tick of 1', () => {
    // documents why LineChart/BarChart override the ticks in the zero state ("$0.01" would be a lie)
    expect(niceTicks(0, 0, 4).ticks).toEqual([0, 1])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WIRING (source-level, for the parts a pure helper cannot prove)
// ─────────────────────────────────────────────────────────────────────────────
describe('the components render through the tested helpers', () => {
  const code = (f: string) => read(f).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

  test('LineChart: bound wording and data state come from chart-data, with no hard-coded "≥ ${"', () => {
    const src = code('components/admin/charts/LineChart.tsx')
    expect(src).toContain('formatPointValue')
    expect(src).toContain('seriesDataState')
    expect(src).toContain('incompleteLegend')
    expect(src).not.toMatch(/`≥ \$\{/)
    expect(src).not.toMatch(/`≤ \$\{/)
    expect(src).not.toMatch(/v !== null && v !== 0/)          // the old zero-is-absent test
  })
  test('LineChart: the known-zero state says so, and does not use the empty message', () => {
    const src = read('components/admin/charts/LineChart.tsx')
    expect(src).toMatch(/dataState === 'zero'/)
    expect(src).toMatch(/real data, not a missing period/)
  })
  test('BarChart: zero is a known state with its own wording, not the empty message', () => {
    const src = code('components/admin/charts/BarChart.tsx')
    expect(src).toContain('seriesDataState')
    expect(src).not.toMatch(/known\.some\(v => v > 0\)/)
    expect(src).toMatch(/zeroMessage/)
    expect(src).toMatch(/not missing data/)
  })
  test('FinancialsClient: paid orders use honest zero wording; AOV has its own no-orders wording; bounds are passed on', () => {
    const src = read('app/admin/financials/FinancialsClient.tsx')
    expect(src).toContain('zeroMessage="0 paid orders in this period"')
    expect(src).toContain('no paid orders in this period')
    expect(src).toContain('bounds: plotted.bounds')
    // the paid-orders chart must not call a known zero "No data"
    const bar = src.slice(src.indexOf('<BarChart'), src.indexOf('</ChartBoundary>', src.indexOf('<BarChart')))
    expect(bar).toContain('zeroMessage')
  })
  test('the profit tooltip can never be produced with "≥": only costs are floors', () => {
    const cd = read('lib/chart-data.ts')
    const profit = cd.slice(cd.indexOf("key === 'realizedProfitCents'"), cd.indexOf('// Revenue, refunds, recognised'))
    expect(profit).not.toContain("'floor'")
    expect(profit).toContain("'ceiling'")
  })
})

describe('funnel summary distinguishes exact zero from no collection', () => {
  test('zero sessions after collection began is a known zero, not empty', () => {
    expect(funnelSummaryDataState(0, true)).toBe('zero')
  })

  test('zero sessions with no known collection is empty/no-data', () => {
    expect(funnelSummaryDataState(0, false)).toBe('empty')
  })

  test('any positive session count is data', () => {
    expect(funnelSummaryDataState(1, false)).toBe('data')
    expect(funnelSummaryDataState(12, true)).toBe('data')
  })

  test('AnalyticsClient uses honest zero-session wording', () => {
    const fs = require('fs')
    const path = require('path')
    const src = fs.readFileSync(path.join(process.cwd(), 'app/admin/analytics/AnalyticsClient.tsx'), 'utf8')
    expect(src).toContain('funnelSummaryDataState')
    expect(src).toContain('0 sessions recorded in this period — a real count of zero, not missing data.')
  })
})

