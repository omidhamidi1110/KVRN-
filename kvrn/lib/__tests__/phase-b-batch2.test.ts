// lib/__tests__/phase-b-batch2.test.ts
// Batch 2: chart mathematics, time bucketing, exact allocation, and the
// architectural guarantee that charts never reimplement financial formulas.

import {
  linearScale, niceTicks, seriesToPoints, buildLinePath, buildAreaPath,
  nearestIndex, buildDonut, autoGranularity, buildBuckets, bucketIndexFor,
  allocateAcrossBuckets,
} from '../chart-math'
import { resolveRangePreset, parseCustomRange } from '../financials'

const fs   = require('fs')
const path = require('path')

// ─────────────────────────────────────────────────────────────────────────────
// SCALES AND AXES
// ─────────────────────────────────────────────────────────────────────────────

describe('scales and axis ticks', () => {

  test('linearScale maps a domain onto a pixel range', () => {
    expect(linearScale(50, 0, 100, 0, 200)).toBe(100)
    expect(linearScale(0, 0, 100, 0, 200)).toBe(0)
    expect(linearScale(100, 0, 100, 0, 200)).toBe(200)
  })

  test('a zero-width domain does not divide by zero', () => {
    expect(linearScale(5, 5, 5, 0, 200)).toBe(0)
    expect(Number.isFinite(linearScale(5, 5, 5, 0, 200))).toBe(true)
  })

  test('ticks round up to human-friendly values', () => {
    const { niceMax, ticks } = niceTicks(0, 8834_17, 4)
    expect(niceMax).toBeGreaterThanOrEqual(8834_17)
    expect(ticks[0]).toBe(0)
    // Even spacing
    const step = ticks[1] - ticks[0]
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i] - ticks[i - 1]).toBeCloseTo(step, 6)
    }
  })

  test('the axis always includes zero so bars are not misleading', () => {
    expect(niceTicks(500, 900).niceMin).toBe(0)
  })

  test('negative values (a loss) extend the axis below zero', () => {
    const { niceMin, niceMax } = niceTicks(-5000, 3000)
    expect(niceMin).toBeLessThanOrEqual(-5000)
    expect(niceMax).toBeGreaterThanOrEqual(3000)
  })

  test('flat all-zero data still yields a usable axis', () => {
    const { ticks } = niceTicks(0, 0)
    expect(ticks.length).toBeGreaterThanOrEqual(2)
    expect(ticks.every(t => Number.isFinite(t))).toBe(true)
  })

  test('ticks carry no floating point drift', () => {
    for (const t of niceTicks(0, 3).ticks) {
      expect(String(t)).not.toMatch(/\d{10,}/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PATHS AND GAPS
// ─────────────────────────────────────────────────────────────────────────────

describe('line rendering', () => {

  test('values map to points across the plot width', () => {
    const pts = seriesToPoints([0, 50, 100], 0, 100, 300, 100)
    expect(pts).toHaveLength(3)
    expect(pts[0]!.x).toBeCloseTo(0)
    expect(pts[2]!.x).toBeCloseTo(300)
    // SVG y is inverted: the largest value sits at the top (smallest y).
    expect(pts[2]!.y).toBeLessThan(pts[0]!.y)
  })

  test('a null value produces a gap, not a drop to zero', () => {
    // Treating "no data" as 0 would draw a fake collapse in revenue.
    const pts = seriesToPoints([10, null, 30], 0, 30, 300, 100)
    expect(pts[1]).toBeNull()
    const d = buildLinePath(pts)
    expect((d.match(/M /g) ?? []).length).toBe(2)   // two separate strokes
  })

  test('a single point renders centred', () => {
    const pts = seriesToPoints([42], 0, 100, 300, 100)
    expect(pts[0]!.x).toBeCloseTo(150)
  })

  test('an all-null series produces an empty path rather than throwing', () => {
    expect(buildLinePath(seriesToPoints([null, null], 0, 10, 300, 100))).toBe('')
    expect(buildAreaPath(seriesToPoints([null, null], 0, 10, 300, 100), 100)).toBe('')
  })

  test('the area path closes back to the baseline', () => {
    const d = buildAreaPath(seriesToPoints([10, 20], 0, 20, 300, 100), 100)
    expect(d.startsWith('M')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HOVER / TAP
// ─────────────────────────────────────────────────────────────────────────────

describe('pointer interaction', () => {

  test('the nearest index is found across the plot', () => {
    expect(nearestIndex(0,   5, 400)).toBe(0)
    expect(nearestIndex(400, 5, 400)).toBe(4)
    expect(nearestIndex(200, 5, 400)).toBe(2)
  })

  test('positions outside the plot clamp to the ends', () => {
    // A finger dragged past the edge on mobile must not produce -1 or overflow.
    expect(nearestIndex(-90, 5, 400)).toBe(0)
    expect(nearestIndex(9999, 5, 400)).toBe(4)
  })

  test('left padding is accounted for', () => {
    expect(nearestIndex(62, 5, 400, 62)).toBe(0)
  })

  test('an empty series reports no index', () => {
    expect(nearestIndex(100, 0, 400)).toBe(-1)
  })

  test('a single point always resolves to index 0', () => {
    expect(nearestIndex(123, 1, 400)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DONUT — COMPOSITION ONLY
// ─────────────────────────────────────────────────────────────────────────────

describe('donut composition', () => {

  test('slice percentages sum to 100', () => {
    const slices = buildDonut(
      [{ label: 'a', valueCents: 5000 },
       { label: 'b', valueCents: 3000 },
       { label: 'c', valueCents: 2000 }], 100, 100, 96, 66)
    expect(slices).toHaveLength(3)
    expect(slices.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(100, 1)
    expect(slices[0].pct).toBeCloseTo(50, 1)
  })

  test('negative components are excluded — a negative slice has no area', () => {
    const slices = buildDonut(
      [{ label: 'ok', valueCents: 1000 },
       { label: 'neg', valueCents: -500 }], 100, 100, 96, 66)
    expect(slices.map(s => s.label)).toEqual(['ok'])
    expect(slices[0].pct).toBeCloseTo(100, 1)
  })

  test('an empty or all-zero breakdown renders nothing rather than NaN', () => {
    expect(buildDonut([], 100, 100, 96, 66)).toEqual([])
    expect(buildDonut([{ label: 'z', valueCents: 0 }], 100, 100, 96, 66)).toEqual([])
  })

  test('a single component does not produce a degenerate full-circle arc', () => {
    const [slice] = buildDonut([{ label: 'only', valueCents: 100 }], 100, 100, 96, 66)
    expect(slice.pct).toBeCloseTo(100, 1)
    expect(slice.path).toContain('A')
    expect(slice.path.split('NaN')).toHaveLength(1)
  })

  test('generated paths never contain NaN', () => {
    const slices = buildDonut(
      [{ label: 'a', valueCents: 1 }, { label: 'b', valueCents: 999999 }], 100, 100, 96, 66)
    for (const s of slices) expect(s.path).not.toContain('NaN')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TIME BUCKETING
// ─────────────────────────────────────────────────────────────────────────────

describe('time bucketing', () => {

  test('granularity keeps the axis readable', () => {
    expect(autoGranularity('2025-06-01T00:00:00Z', '2025-06-08T00:00:00Z')).toBe('day')
    expect(autoGranularity('2025-01-01T00:00:00Z', '2025-04-01T00:00:00Z')).toBe('week')
    expect(autoGranularity('2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z')).toBe('month')
  })

  test('daily buckets cover the range exactly once', () => {
    const b = buildBuckets('2025-06-01T00:00:00Z', '2025-06-08T00:00:00Z', 'day')
    expect(b).toHaveLength(7)
    expect(b[0].start).toBe('2025-06-01T00:00:00.000Z')
    expect(b[6].end).toBe('2025-06-08T00:00:00.000Z')
  })

  test('buckets are contiguous with no gaps or overlaps', () => {
    // This is what makes summing buckets equal the period total.
    for (const g of ['day', 'week', 'month'] as const) {
      const b = buildBuckets('2025-01-01T00:00:00Z', '2025-04-01T00:00:00Z', g)
      for (let i = 1; i < b.length; i++) expect(b[i].start).toBe(b[i - 1].end)
      expect(b[0].start).toBe('2025-01-01T00:00:00.000Z')
      expect(b[b.length - 1].end).toBe('2025-04-01T00:00:00.000Z')
    }
  })

  test('buckets never start before the requested range', () => {
    // Mid-month start must not back-fill into the previous month.
    const b = buildBuckets('2025-06-15T00:00:00Z', '2025-08-01T00:00:00Z', 'month')
    expect(Date.parse(b[0].start)).toBeGreaterThanOrEqual(Date.parse('2025-06-15T00:00:00Z'))
  })

  test('an inverted or empty range yields no buckets', () => {
    expect(buildBuckets('2025-06-08T00:00:00Z', '2025-06-01T00:00:00Z', 'day')).toEqual([])
    expect(buildBuckets('2025-06-01T00:00:00Z', '2025-06-01T00:00:00Z', 'day')).toEqual([])
  })

  test('an instant is placed in exactly one bucket', () => {
    const b = buildBuckets('2025-06-01T00:00:00Z', '2025-06-08T00:00:00Z', 'day')
    const hits = b.filter((_, i) => bucketIndexFor(b, '2025-06-03T13:45:00Z') === i)
    expect(hits).toHaveLength(1)
    expect(bucketIndexFor(b, '2025-06-03T13:45:00Z')).toBe(2)
  })

  test('boundaries are half-open — the end instant belongs to the next bucket', () => {
    const b = buildBuckets('2025-06-01T00:00:00Z', '2025-06-03T00:00:00Z', 'day')
    expect(bucketIndexFor(b, '2025-06-01T00:00:00Z')).toBe(0)
    expect(bucketIndexFor(b, '2025-06-02T00:00:00Z')).toBe(1)
  })

  test('an instant outside the range belongs to no bucket', () => {
    const b = buildBuckets('2025-06-01T00:00:00Z', '2025-06-08T00:00:00Z', 'day')
    expect(bucketIndexFor(b, '2025-05-31T23:59:59Z')).toBe(-1)
    expect(bucketIndexFor(b, '2025-06-08T00:00:00Z')).toBe(-1)
  })

  test('a one-year range produces a bounded number of monthly buckets', () => {
    const b = buildBuckets('2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'month')
    expect(b).toHaveLength(12)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// EXACT ALLOCATION — the reconciliation guarantee
// ─────────────────────────────────────────────────────────────────────────────

describe('allocation across buckets loses no cents', () => {

  test('weighted allocation sums exactly to the total', () => {
    const out = allocateAcrossBuckets(10_000, [5000, 3000, 2000])
    expect(out.reduce((s, v) => s + v, 0)).toBe(10_000)
    expect(out).toEqual([5000, 3000, 2000])
  })

  test('awkward remainders still reconcile exactly', () => {
    // 100 across 3 equal weights: naive rounding gives 99 or 102.
    const out = allocateAcrossBuckets(100, [1, 1, 1])
    expect(out.reduce((s, v) => s + v, 0)).toBe(100)
    expect(out.sort()).toEqual([33, 33, 34])
  })

  test('exhaustive: every total from 1 to 500 reconciles', () => {
    const weights = [7999, 3301, 1237, 4444]
    for (let total = 1; total <= 500; total++) {
      expect(allocateAcrossBuckets(total, weights).reduce((s, v) => s + v, 0)).toBe(total)
    }
  })

  test('zero weights fall back to an even spread that still reconciles', () => {
    // A period with no revenue must still absorb its fixed costs.
    const out = allocateAcrossBuckets(100, [0, 0, 0])
    expect(out.reduce((s, v) => s + v, 0)).toBe(100)
  })

  test('a zero total allocates zero everywhere', () => {
    expect(allocateAcrossBuckets(0, [5, 5])).toEqual([0, 0])
  })

  test('no bucket receives a negative allocation', () => {
    for (const t of [1, 7, 99, 12345]) {
      for (const v of allocateAcrossBuckets(t, [1, 500, 3])) {
        expect(v).toBeGreaterThanOrEqual(0)
      }
    }
  })

  test('allocation is deterministic', () => {
    const first = allocateAcrossBuckets(101, [1, 1, 1])
    for (let i = 0; i < 10; i++) {
      expect(allocateAcrossBuckets(101, [1, 1, 1])).toEqual(first)
    }
  })

  test('an empty bucket list returns an empty allocation', () => {
    expect(allocateAcrossBuckets(500, [])).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DATE RANGES
// ─────────────────────────────────────────────────────────────────────────────

describe('chart date ranges', () => {
  const NOW = new Date('2025-06-15T13:45:00Z')

  test('90d spans ninety calendar days inclusive of today', () => {
    const r = resolveRangePreset('90d', NOW)
    expect(r.start).toBe('2025-03-18T00:00:00.000Z')
    expect(r.end).toBe('2025-06-16T00:00:00.000Z')
  })

  test('1y spans a year ending tomorrow midnight', () => {
    const r = resolveRangePreset('1y', NOW)
    expect(r.start).toBe('2024-06-16T00:00:00.000Z')
    expect(r.end).toBe('2025-06-16T00:00:00.000Z')
  })

  test('all reaches back to a bounded floor, not unbounded time', () => {
    // An unbounded start would defeat the paid_at index.
    const r = resolveRangePreset('all', NOW)
    expect(r.start).toBe('2024-01-01T00:00:00.000Z')
    expect(Date.parse(r.end)).toBeGreaterThan(Date.parse(r.start))
  })

  test('every preset produces a valid forward range', () => {
    for (const p of ['today','7d','30d','90d','mtd','ytd','1y','all'] as const) {
      const r = resolveRangePreset(p, NOW)
      expect(Date.parse(r.end)).toBeGreaterThan(Date.parse(r.start))
    }
  })

  test('a custom range still includes the whole end day', () => {
    const r = parseCustomRange('2025-06-01', '2025-06-30')!
    expect(r.end).toBe('2025-07-01T00:00:00.000Z')
  })

  test('bucketing a preset covers the preset exactly', () => {
    // Chart x-axis and the summary window must describe the same span.
    const r = resolveRangePreset('30d', NOW)
    const b = buildBuckets(r.start, r.end, 'day')
    expect(b[0].start).toBe(r.start)
    expect(b[b.length - 1].end).toBe(r.end)
    expect(b).toHaveLength(30)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ARCHITECTURE: CHARTS MUST NOT REIMPLEMENT FINANCIAL MATH
// ─────────────────────────────────────────────────────────────────────────────

describe('charts consume the authoritative financial layer', () => {
  const chartFiles = [
    '../../components/admin/charts/LineChart.tsx',
    '../../components/admin/charts/BreakdownChart.tsx',
  ].map(f => fs.readFileSync(path.join(__dirname, f), 'utf8'))

  const stripComments = (src: string) =>
    src.split('\n').filter((l: string) =>
      !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')
    ).join('\n')

  test('no chart component defines an accounting formula', () => {
    // Revenue, COGS, profit, fees and margins are computed once, upstream.
    const forbidden = [
      'subtotalCents -', 'merchandiseDiscount', 'contributionProfit =',
      'netRevenue =', 'grossMerchandise', 'stripeFee -', 'shippingMargin',
      'computeOrderEconomics', 'computePeriodEconomics',
    ]
    for (const src of chartFiles) {
      const code = stripComments(src)
      for (const f of forbidden) expect(code).not.toContain(f)
    }
  })

  test('no chart component queries the database', () => {
    for (const src of chartFiles) {
      const code = stripComments(src)
      expect(code).not.toContain('sql`')
      expect(code).not.toContain('@/lib/db')
    }
  })

  test('chart math is display-only and imports no financial module', () => {
    const src = fs.readFileSync(path.join(__dirname, '../chart-math.ts'), 'utf8')
    expect(src).not.toContain('financial-calculator')
    expect(src).not.toContain('@/lib/db')
    expect(src).not.toContain('financials')
  })

  test('the time series is derived from the same calculator as the cards', () => {
    const src = fs.readFileSync(path.join(__dirname, '../financials.ts'), 'utf8')
    const fn = src.slice(src.indexOf('async getFinancialTimeSeries'),
                         src.indexOf('async getCostComposition'))
    // Reuses the authoritative per-order economics rather than recomputing.
    expect(fn).toContain('this.getOrderEconomicsInRange')
    // Costs go through the SAME canonical recognition primitives the period
    // totals use, applied to each bucket's real dates.
    expect(fn).toContain('recognizeExpenseRowsExact')
    expect(fn).toContain('recognizeAdSpendRowsExact')
    // And uses exact allocation so buckets reconcile to the period.
    expect(fn).toContain('allocateAcrossBuckets')
  })

  test('cost composition reuses the period report rather than re-summing', () => {
    const src = fs.readFileSync(path.join(__dirname, '../financials.ts'), 'utf8')
    const fn = src.slice(src.indexOf('async getCostComposition'),
                         src.indexOf('async getProductProfitability'))
    expect(fn).toContain('this.getPeriodReport')
  })

  test('composition excludes non-positive components', () => {
    const src = fs.readFileSync(path.join(__dirname, '../financials.ts'), 'utf8')
    const fn = src.slice(src.indexOf('async getCostComposition'),
                         src.indexOf('async getProductProfitability'))
    expect(fn).toContain('valueCents > 0')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// NO DOUBLE COUNTING ACROSS VISUALISATIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('a value shown twice is not counted twice', () => {

  test('the breakdown lists each cost exactly once', () => {
    const src = fs.readFileSync(path.join(__dirname, '../financials.ts'), 'utf8')
    const fn = src.slice(src.indexOf('async getCostComposition'),
                         src.indexOf('async getProductProfitability'))
    // Each component appears once; no component is both itemised and rolled up.
    for (const label of ['Product COGS', 'Shipping cost', 'Stripe fees',
                         'Operating expenses', 'Development', 'Advertising']) {
      // Match the quoted label so a field name like
      // recognizedDevelopmentExpensesCents is not mistaken for the slice label.
      expect((fn.match(new RegExp(`'${label}'`, 'g')) ?? []).length).toBe(1)
    }
    // The aggregate must not be listed alongside its own parts.
    expect(fn).not.toContain('totalOperatingCostCents')
  })

  test('the trend chart series are independent, not nested totals', () => {
    const ui = fs.readFileSync(
      path.join(__dirname, '../../app/admin/financials/FinancialsClient.tsx'), 'utf8')
    const defs = ui.slice(ui.indexOf('const SERIES_DEFS'), ui.indexOf('type SeriesKey'))
    // Offering both a total and its components as overlaid lines invites
    // reading the same money twice.
    expect(defs).not.toContain('totalOperatingCostCents')
    expect(defs).not.toContain('grossCustomerRevenueCents')
  })

  test('infrastructure spend and usage are never one series', () => {
    const ui = fs.readFileSync(
      path.join(__dirname,
        '../../app/admin/financials/infrastructure/InfrastructureClient.tsx'), 'utf8')
    // Money and meter readings share no axis; the operator picks a mode.
    expect(ui).toContain("chartMode === 'spend'")
    expect(ui).toContain("unit: 'count'")
    expect(ui).toContain("unit: 'cents'")
  })

  test('infrastructure spend uses billed transactions, not forecasts', () => {
    const api = fs.readFileSync(
      path.join(__dirname,
        '../../app/api/admin/financials/infrastructure/timeseries/route.ts'), 'utf8')
    expect(api).toContain('FROM expense_transactions')
    expect(api).toContain('paid_at IS NOT NULL')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UNITS, EMPTY STATES, ACCESSIBILITY
// ─────────────────────────────────────────────────────────────────────────────

describe('presentation safeguards', () => {
  const line = fs.readFileSync(
    path.join(__dirname, '../../components/admin/charts/LineChart.tsx'), 'utf8')

  test('mixed units are flagged rather than silently overlaid', () => {
    expect(line).toContain('mixedUnits')
    expect(line).toContain('not directly comparable')
  })

  test('an empty or all-zero series renders an explicit message', () => {
    expect(line).toContain('emptyMessage')
    expect(line).toContain('hasAnyValue')
  })

  test('touch works without trapping page scroll', () => {
    // touch-action pan-y keeps vertical scrolling while allowing horizontal scrub.
    expect(line).toContain("touchAction: 'pan-y'")
    expect(line).toContain('onPointerMove')
    expect(line).toContain('onPointerDown')
  })

  test('charts expose an accessible label', () => {
    expect(line).toContain('role="img"')
    expect(line).toContain('aria-label')
  })

  test('currency formatting is delegated, never reinvented', () => {
    // money() from FinancialUI is the single formatter.
    expect(line).toContain('formatCents')
    expect(line).not.toContain('toFixed(2)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REVISION: COST BUCKETS FOLLOW THEIR OWN DATES, NOT REVENUE
// ─────────────────────────────────────────────────────────────────────────────

import {
  recognizeExpenseRowsExact, recognizeAdSpendRowsExact,
  type ExpenseTxnRow, type AdSpendRow,
} from '../financial-calculator'

/** Recreates the service's bucket pipeline using the same canonical primitives. */
function bucketCosts(
  expenseRows: ExpenseTxnRow[],
  adRows: AdSpendRow[],
  rangeStart: string,
  rangeEnd: string,
  granularity: 'day' | 'week' | 'month' = 'day',
) {
  const buckets = buildBuckets(rangeStart, rangeEnd, granularity)
  const bounds = buckets.map(b => ({
    startDate: b.start.slice(0, 10),
    endDate:   new Date(Date.parse(b.end) - 1).toISOString().slice(0, 10),
  }))
  const periodBounds = {
    startDate: rangeStart.slice(0, 10),
    endDate:   new Date(Date.parse(rangeEnd) - 1).toISOString().slice(0, 10),
  }

  const opexExact = bounds.map(b => recognizeExpenseRowsExact(expenseRows, b.startDate, b.endDate))
  const adsExact  = bounds.map(b => recognizeAdSpendRowsExact(adRows, b.startDate, b.endDate))

  const periodOperating = Math.round(
    recognizeExpenseRowsExact(expenseRows, periodBounds.startDate, periodBounds.endDate).operating)
  const periodDevelopment = Math.round(
    recognizeExpenseRowsExact(expenseRows, periodBounds.startDate, periodBounds.endDate).development)
  const periodAds = Math.round(
    recognizeAdSpendRowsExact(adRows, periodBounds.startDate, periodBounds.endDate))

  return {
    labels: buckets.map(b => b.label),
    operating:   allocateAcrossBuckets(periodOperating,   opexExact.map(e => e.operating)),
    development: allocateAcrossBuckets(periodDevelopment, opexExact.map(e => e.development)),
    ads:         allocateAcrossBuckets(periodAds,         adsExact),
    periodOperating, periodDevelopment, periodAds,
  }
}

describe('cost buckets follow their own dates, not revenue', () => {

  test('an expense stays in the bucket it economically belongs to', () => {
    // Paid on the 3rd. Whatever revenue the other days produced is irrelevant.
    const rows: ExpenseTxnRow[] = [
      { amountCents: 1900, category: 'infrastructure',
        paidAt: '2025-06-03', periodStart: null, periodEnd: null },
    ]
    const r = bucketCosts(rows, [], '2025-06-01T00:00:00Z', '2025-06-06T00:00:00Z')
    expect(r.operating).toEqual([0, 0, 1900, 0, 0])
  })

  test('revenue in another bucket cannot pull an expense into it', () => {
    // The old revenue-weighted allocation would have moved this cost toward
    // whichever bucket sold the most. Recognition is now date-driven only, so
    // the result does not depend on revenue at all.
    const rows: ExpenseTxnRow[] = [
      { amountCents: 5000, category: 'software',
        paidAt: '2025-06-05', periodStart: null, periodEnd: null },
    ]
    const r = bucketCosts(rows, [], '2025-06-01T00:00:00Z', '2025-06-08T00:00:00Z')
    expect(r.operating[4]).toBe(5000)
    expect(r.operating.filter((_, i) => i !== 4).every(v => v === 0)).toBe(true)
  })

  test('a zero-revenue bucket still carries its operating expense', () => {
    // Fixed costs do not pause because nothing sold that day.
    const rows: ExpenseTxnRow[] = [
      { amountCents: 300, category: 'communications',
        paidAt: '2025-06-02', periodStart: null, periodEnd: null },
    ]
    const r = bucketCosts(rows, [], '2025-06-01T00:00:00Z', '2025-06-04T00:00:00Z')
    expect(r.operating[1]).toBe(300)
    expect(r.operating.reduce((s, v) => s + v, 0)).toBe(300)
  })

  test('a zero-revenue bucket still carries its ad spend', () => {
    const ads: AdSpendRow[] = [
      { spendCents: 900, periodStart: '2025-06-02', periodEnd: '2025-06-04' },
    ]
    const r = bucketCosts([], ads, '2025-06-01T00:00:00Z', '2025-06-06T00:00:00Z')
    expect(r.ads[0]).toBe(0)                 // campaign had not started
    expect(r.ads[1] + r.ads[2] + r.ads[3]).toBe(900)
  })

  test('ad spend follows its configured campaign range', () => {
    // A 3-day campaign spreads across exactly those 3 days, evenly.
    const ads: AdSpendRow[] = [
      { spendCents: 300, periodStart: '2025-06-02', periodEnd: '2025-06-04' },
    ]
    const r = bucketCosts([], ads, '2025-06-01T00:00:00Z', '2025-06-06T00:00:00Z')
    expect(r.ads).toEqual([0, 100, 100, 100, 0])
  })

  test('a campaign straddling the window edge contributes only its overlap', () => {
    const ads: AdSpendRow[] = [
      { spendCents: 1000, periodStart: '2025-05-28', periodEnd: '2025-06-06' },  // 10 days
    ]
    // Window covers 1-3 June = 3 of the 10 campaign days.
    const r = bucketCosts([], ads, '2025-06-01T00:00:00Z', '2025-06-04T00:00:00Z')
    expect(r.periodAds).toBe(300)
    expect(r.ads.reduce((s, v) => s + v, 0)).toBe(300)
  })

  test('an annual renewal spreads across its service period, not its payment date', () => {
    // $365 covering a full year recognises ~$1/day, and does NOT dump the whole
    // charge into the day it was paid.
    const rows: ExpenseTxnRow[] = [
      { amountCents: 36500, category: 'domain',
        paidAt: '2025-01-15', periodStart: '2025-01-01', periodEnd: '2025-12-31' },
    ]
    const r = bucketCosts(rows, [], '2025-06-01T00:00:00Z', '2025-06-06T00:00:00Z')
    // 5 days of a 365-day span
    expect(r.periodOperating).toBe(500)
    expect(r.operating.reduce((s, v) => s + v, 0)).toBe(500)
    expect(r.operating.every(v => v === 100)).toBe(true)
  })

  test('development expense stays distinguishable from operating expense', () => {
    const rows: ExpenseTxnRow[] = [
      { amountCents: 2000, category: 'development',
        paidAt: '2025-06-02', periodStart: null, periodEnd: null },
      { amountCents: 1500, category: 'infrastructure',
        paidAt: '2025-06-02', periodStart: null, periodEnd: null },
    ]
    const r = bucketCosts(rows, [], '2025-06-01T00:00:00Z', '2025-06-04T00:00:00Z')
    expect(r.development[1]).toBe(2000)
    expect(r.operating[1]).toBe(1500)
    // They are never merged into a single figure by the primitive.
    expect(r.periodOperating).toBe(1500)
    expect(r.periodDevelopment).toBe(2000)
  })

  test('bucket sums reconcile cent-exactly to the period totals', () => {
    // Deliberately awkward: a span that does not divide evenly across buckets.
    const rows: ExpenseTxnRow[] = [
      { amountCents: 10000, category: 'infrastructure',
        paidAt: '2025-06-01', periodStart: '2025-06-01', periodEnd: '2025-06-07' },
      { amountCents: 333, category: 'development',
        paidAt: '2025-06-03', periodStart: '2025-06-01', periodEnd: '2025-06-07' },
    ]
    const ads: AdSpendRow[] = [
      { spendCents: 999, periodStart: '2025-06-01', periodEnd: '2025-06-07' },
    ]
    const r = bucketCosts(rows, ads, '2025-06-01T00:00:00Z', '2025-06-08T00:00:00Z')
    expect(r.operating.reduce((s, v) => s + v, 0)).toBe(r.periodOperating)
    expect(r.development.reduce((s, v) => s + v, 0)).toBe(r.periodDevelopment)
    expect(r.ads.reduce((s, v) => s + v, 0)).toBe(r.periodAds)
  })

  test('reconciliation holds across day, week and month granularities', () => {
    const rows: ExpenseTxnRow[] = [
      { amountCents: 4321, category: 'software',
        paidAt: '2025-01-10', periodStart: '2025-01-01', periodEnd: '2025-03-31' },
    ]
    const ads: AdSpendRow[] = [
      { spendCents: 7777, periodStart: '2025-01-05', periodEnd: '2025-02-20' },
    ]
    for (const g of ['day', 'week', 'month'] as const) {
      const r = bucketCosts(rows, ads, '2025-01-01T00:00:00Z', '2025-04-01T00:00:00Z', g)
      expect(r.operating.reduce((s, v) => s + v, 0)).toBe(r.periodOperating)
      expect(r.ads.reduce((s, v) => s + v, 0)).toBe(r.periodAds)
    }
  })

  test('an unpaid transaction is recognised in no bucket', () => {
    const rows: ExpenseTxnRow[] = [
      { amountCents: 5000, category: 'infrastructure',
        paidAt: null, periodStart: null, periodEnd: null },
    ]
    const r = bucketCosts(rows, [], '2025-06-01T00:00:00Z', '2025-06-06T00:00:00Z')
    expect(r.operating.every(v => v === 0)).toBe(true)
  })

  test('the service uses the canonical primitives, not a private formula', () => {
    const src = fs.readFileSync(path.join(__dirname, '../financials.ts'), 'utf8')
    const fn = src.slice(src.indexOf('async getFinancialTimeSeries'),
                         src.indexOf('async getCostComposition'))
    expect(fn).toContain('recognizeExpenseRowsExact')
    expect(fn).toContain('recognizeAdSpendRowsExact')
    // Costs must no longer be weighted by revenue.
    expect(fn).not.toContain('revenueWeights')
  })

  test('the period path and the chart path share one recognition primitive', () => {
    const src = fs.readFileSync(path.join(__dirname, '../financials.ts'), 'utf8')
    const periodFn = src.slice(src.indexOf('async getRecognizedOperatingExpensesCents'),
                               src.indexOf('async getForecastOperatingExpensesCents'))
    expect(periodFn).toContain('recognizeExpenseRowsExact')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REVISION: AREA FILL RESPECTS NULL GAPS
// ─────────────────────────────────────────────────────────────────────────────

describe('area fill breaks at missing data', () => {

  test('[10, null, 30] produces two separate filled shapes', () => {
    // One shape spanning the gap would fill under data that does not exist.
    const pts = seriesToPoints([10, null, 30], 0, 30, 300, 100)
    const d = buildAreaPath(pts, 100)
    expect((d.match(/M /g) ?? []).length).toBe(2)
    expect((d.match(/Z/g)  ?? []).length).toBe(2)
  })

  test('a contiguous series still produces exactly one shape', () => {
    const pts = seriesToPoints([10, 20, 30], 0, 30, 300, 100)
    const d = buildAreaPath(pts, 100)
    expect((d.match(/M /g) ?? []).length).toBe(1)
    expect((d.match(/Z/g)  ?? []).length).toBe(1)
  })

  test('multiple gaps produce one shape per contiguous run', () => {
    const pts = seriesToPoints([1, null, 2, 3, null, 4], 0, 4, 500, 100)
    const d = buildAreaPath(pts, 100)
    expect((d.match(/Z/g) ?? []).length).toBe(3)
  })

  test('leading and trailing nulls do not create empty shapes', () => {
    const pts = seriesToPoints([null, 5, 6, null], 0, 6, 300, 100)
    const d = buildAreaPath(pts, 100)
    expect((d.match(/Z/g) ?? []).length).toBe(1)
  })

  test('an all-null series produces no path', () => {
    expect(buildAreaPath(seriesToPoints([null, null], 0, 10, 300, 100), 100)).toBe('')
  })

  test('every generated area sub-path is closed and free of NaN', () => {
    const d = buildAreaPath(seriesToPoints([5, null, 9, 2], 0, 9, 400, 120), 120)
    expect(d).not.toContain('NaN')
    for (const part of d.split('Z').filter(x => x.trim())) {
      expect(part.trim().startsWith('M')).toBe(true)
    }
  })

  test('the area baseline matches the line geometry', () => {
    // Area and stroke must describe the same points, or the fill will not sit
    // under the line.
    const pts = seriesToPoints([10, 20], 0, 20, 300, 100)
    const line = buildLinePath(pts)
    const area = buildAreaPath(pts, 100)
    for (const p of pts) {
      if (!p) continue
      expect(line).toContain(`${Math.round(p.x * 100) / 100}`)
      expect(area).toContain(`${Math.round(p.x * 100) / 100}`)
    }
  })
})
