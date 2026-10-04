// lib/chart-data.ts — pure data shaping for the admin charts
//
// DISPLAY SUPPORT ONLY. No I/O, no React, no database, and no import of any
// accounting module. Every number arriving here was already computed by the
// authoritative layers (lib/financials.ts -> lib/financial-calculator.ts for money,
// lib/funnel-analytics.ts for the funnel). This file decides HOW A VALUE IS SHOWN —
// exact, a floor, or unknown — and never what the value is.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: UNKNOWN IS NOT ZERO.
//   exact       drawn as a normal point
//   incomplete  a known-so-far value: drawn with a hollow marker. Its BOUND DIRECTION is typed:
//                 floor    a cost  - the true figure is at least this, shown "≥"
//                 ceiling  a profit - the true figure is at most this, shown "≤"
//                 (none)   no mathematical bound is claimed: shown as "known so far"
//               The direction is decided here, once, from the series - never guessed by the chart.
//   unknown     nothing authoritative exists for the bucket: the value is null (a gap in
//               the line), the column is shaded and the tooltip says why. It is never 0.

export type PointStatus = 'exact' | 'incomplete' | 'unknown'

/**
 * Which way an INCOMPLETE value is wrong. A cost with an unrecorded part can only grow
 * ('floor': the truth is >= the value); a profit computed without some costs can only
 * shrink ('ceiling': the truth is <= the value). Only meaningful with status 'incomplete'.
 */
export type PointBound = 'floor' | 'ceiling'

export interface PlottedPoint {
  /** null = nothing to draw (a gap), never a stand-in zero. */
  value: number | null
  status: PointStatus
  /** Set only for 'incomplete' points that have a mathematical bound. */
  bound?: PointBound
  /** Human-readable explanation for the tooltip. */
  note?: string
}

/** The per-bucket shape returned by /api/admin/financials/timeseries (only the fields used here). */
export interface FinancialBucketView {
  label: string
  orderCount: number
  netRevenueCents: number
  refundCents?: number
  cogsCents: number
  shippingCostCents: number
  stripeFeeCents: number
  operatingExpenseCents: number
  advertisingCents: number
  contributionProfitCents: number
  realizedProfitCents: number
  isPartial: boolean
  averageOrderValueCents?: number | null
  ordersMissingCogs?: number
  ordersMissingShippingCost?: number
  ordersMissingStripeFee?: number
  ordersWithUnknownCosts?: number
  unknownWriteOffs?: number
}

export type FinancialSeriesKey =
  | 'netRevenueCents' | 'refundCents' | 'cogsCents' | 'shippingCostCents' | 'stripeFeeCents'
  | 'operatingExpenseCents' | 'advertisingCents' | 'realizedProfitCents'

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

/** Which "missing" counter and wording applies to an order-derived cost series. */
const COST_UNKNOWNS: Partial<Record<FinancialSeriesKey, {
  field: 'ordersMissingCogs' | 'ordersMissingShippingCost' | 'ordersMissingStripeFee'
  what: string
}>> = {
  cogsCents:         { field: 'ordersMissingCogs',         what: 'COGS' },
  shippingCostCents: { field: 'ordersMissingShippingCost', what: 'shipping label cost' },
  stripeFeeCents:    { field: 'ordersMissingStripeFee',    what: 'Stripe fee' },
}

/**
 * Decide how one bucket's value for one series is shown.
 *
 * Older cached API responses lack the *missing counters. Then the only honest signal is
 * the bucket's own isPartial flag: a partial bucket is shown as incomplete, never exact.
 */
export function plotFinancialPoint(b: FinancialBucketView, key: FinancialSeriesKey): PlottedPoint {
  const n = b.orderCount
  const raw = (b[key as keyof FinancialBucketView] ?? 0) as number

  const cost = COST_UNKNOWNS[key]
  if (cost) {
    const m = b[cost.field]
    if (m === undefined) {
      return b.isPartial
        ? { value: raw, status: 'incomplete', bound: 'floor', note: `At least — some ${cost.what} in this period is not yet recorded` }
        : { value: raw, status: 'exact' }
    }
    if (n > 0 && m >= n) {
      return { value: null, status: 'unknown',
               note: `Unknown — ${cost.what} is not yet recorded for ${n === 1 ? 'the' : `all ${n}`} ${n === 1 ? 'order' : 'orders'} in this period` }
    }
    if (m > 0) {
      return { value: raw, status: 'incomplete', bound: 'floor',
               note: `At least — ${m} of ${plural(n, 'order')} ${m === 1 ? 'is' : 'are'} missing ${cost.what}` }
    }
    return { value: raw, status: 'exact' }
  }

  if (key === 'realizedProfitCents') {
    const u = b.ordersWithUnknownCosts
    const w = b.unknownWriteOffs ?? 0
    if (u === undefined) {
      return b.isPartial
        ? { value: raw, status: 'incomplete', bound: 'ceiling', note: 'Known so far — an upper bound; some costs in this period are not yet recorded' }
        : { value: raw, status: 'exact' }
    }
    if (n > 0 && u >= n) {
      return { value: null, status: 'unknown',
               note: `Unknown — every order in this period (${n}) has a cost that is not yet recorded` }
    }
    if (u > 0 || w > 0) {
      const parts: string[] = []
      if (u > 0) parts.push(`${u} of ${plural(n, 'order')} ha${u === 1 ? 's' : 've'} an unrecorded cost`)
      if (w > 0) parts.push(`${plural(w, 'write-off')} with unknown cost`)
      return { value: raw, status: 'incomplete', bound: 'ceiling', note: `Known so far — an upper bound; ${parts.join(' and ')}` }
    }
    return { value: raw, status: 'exact' }
  }

  // Revenue, refunds, recognised operating expense and advertising come straight from
  // recorded transactions; their completeness is not tracked per bucket here.
  return { value: raw, status: 'exact' }
}

export interface PlottedSeries {
  values: Array<number | null>
  status: PointStatus[]
  bounds: Array<PointBound | undefined>
  notes: Array<string | undefined>
}

export function plotFinancialSeries(buckets: FinancialBucketView[], key: FinancialSeriesKey): PlottedSeries {
  const pts = buckets.map(b => plotFinancialPoint(b, key))
  return {
    values: pts.map(p => p.value), status: pts.map(p => p.status),
    bounds: pts.map(p => p.bound), notes: pts.map(p => p.note),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HOW A POINT IS WORDED  (pure, so the rule is testable without rendering)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The text for one point's value, given the value ALREADY formatted for its unit.
 *   exact                  "$12.00"
 *   incomplete + floor     "≥ $12.00"   (a cost: at least this)
 *   incomplete + ceiling   "≤ $12.00"   (a profit: at most this)
 *   incomplete, no bound   "$12.00 (known so far)"  - no direction is claimed
 *   unknown / no value     "Unknown" for an unknown point, "—" otherwise. Never "0".
 */
export function formatPointValue(
  formatted: string | null, status: PointStatus | undefined, bound?: PointBound,
): string {
  if (formatted === null) return status === 'unknown' ? 'Unknown' : '—'
  if (status !== 'incomplete') return formatted
  if (bound === 'floor') return `≥ ${formatted}`
  if (bound === 'ceiling') return `≤ ${formatted}`
  return `${formatted} (known so far)`
}

/** Legend sentence for the kinds of incomplete points present in a chart (exact points are ignored). */
export function incompleteLegend(
  series: Array<{ status?: Array<PointStatus | undefined>; bounds?: Array<PointBound | undefined> }>,
): string {
  let floor = false, ceiling = false, plain = false
  for (const s of series) {
    (s.status ?? []).forEach((st, i) => {
      if (st !== 'incomplete') return
      const b = s.bounds?.[i]
      if (b === 'floor') floor = true
      else if (b === 'ceiling') ceiling = true
      else plain = true
    })
  }
  const parts: string[] = []
  if (floor) parts.push('≥ costs are at least the amount shown')
  if (ceiling) parts.push('≤ profit is at most the amount shown')
  if (plain) parts.push('other incomplete values are known so far, not final')
  return parts.join('; ')
}

// ─────────────────────────────────────────────────────────────────────────────
// WHAT A CHART'S DATA IS  (exact zero is DATA; only absence is "no data")
// ─────────────────────────────────────────────────────────────────────────────

/**
 *   empty    no buckets or series, or nothing but nulls with no unknown flag: there is
 *            genuinely nothing to show ("No data for this period")
 *   unknown  every value is null AND some points are flagged unknown: draw the chart so the
 *            shaded unknown columns are visible
 *   zero     real values exist and every one is EXACTLY 0: a known zero, not missing data
 *   data     at least one non-zero value (or an incomplete value, which is never "all zero")
 */
export type SeriesDataState = 'empty' | 'unknown' | 'zero' | 'data'

export function seriesDataState(
  bucketCount: number,
  series: Array<{ values: Array<number | null | undefined>; status?: Array<PointStatus | undefined> }>,
): SeriesDataState {
  if (bucketCount <= 0 || series.length === 0) return 'empty'
  const known: number[] = []
  let unknown = false, incomplete = false
  for (const s of series) {
    for (const v of s.values) if (typeof v === 'number' && Number.isFinite(v)) known.push(v)
    for (const st of s.status ?? []) { if (st === 'unknown') unknown = true; else if (st === 'incomplete') incomplete = true }
  }
  if (known.length === 0) return unknown ? 'unknown' : 'empty'
  if (known.some(v => v !== 0) || incomplete) return 'data'
  return 'zero'
}

/** How many buckets of the enabled series are floors/ceilings or unknown (for the caption). */
export function summarizeCompleteness(
  buckets: FinancialBucketView[], keys: FinancialSeriesKey[],
): { incomplete: number; unknown: number } {
  let incomplete = 0, unknown = 0
  buckets.forEach((_, i) => {
    const statuses = keys.map(k => plotFinancialPoint(buckets[i], k).status)
    if (statuses.includes('unknown')) unknown += 1
    else if (statuses.includes('incomplete')) incomplete += 1
  })
  return { incomplete, unknown }
}

// ─────────────────────────────────────────────────────────────────────────────
// SALES / ORDERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Paid orders per bucket (a real count: 0 means no order was paid) and average order
 * value per bucket. AOV is the server's value (same definition as the period card:
 * gross customer revenue / paid orders); a bucket with no orders has NO average, so it
 * is a gap (null) and never $0.
 */
export function salesTrend(buckets: FinancialBucketView[]): {
  orders: number[]
  averageOrderValueCents: Array<number | null>
} {
  return {
    orders: buckets.map(b => b.orderCount),
    averageOrderValueCents: buckets.map(b =>
      b.orderCount === 0 ? null : (b.averageOrderValueCents ?? null)),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNNEL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Percentage with two decimals, null when the denominator is not positive.
 * Identical in behaviour to ratePct() in lib/funnel-analytics.ts (that module imports
 * node:crypto and so cannot be bundled into the browser); the test suite asserts the
 * two agree.
 */
export function displayRatePct(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  return Math.round((numerator / denominator) * 10000) / 100
}

export interface FunnelStageCounts {
  visits: number
  reachedProduct: number
  reachedCart: number
  reachedCheckout: number
  purchased: number
}

export interface FunnelStageRates {
  visitToProduct: number | null
  productToCart: number | null
  cartToCheckout: number | null
  checkoutToPurchase: number | null
  visitToPurchase: number | null
}

/**
 * Summary-funnel state. A zero visit count is only "no data" when first-party
 * collection is not known to have existed for the selected window. Once collection
 * existed, zero sessions is an exact observed zero, not missing data.
 */
export type FunnelSummaryDataState = 'empty' | 'zero' | 'data'

export function funnelSummaryDataState(visits: number, hasCollection: boolean): FunnelSummaryDataState {
  if (Number.isFinite(visits) && visits > 0) return 'data'
  return hasCollection ? 'zero' : 'empty'
}

export interface FunnelRow {
  key: 'visits' | 'reachedProduct' | 'reachedCart' | 'reachedCheckout' | 'purchased'
  label: string
  /** The canonical event behind the stage. */
  event: 'session_start' | 'product_viewed' | 'add_to_cart' | 'checkout_started' | 'purchase_completed'
  count: number
  /** Share of all sessions in the window; null with no sessions. */
  pctOfVisits: number | null
  /** Step conversion from the previous stage (server rates); null for the first row or a zero denominator. */
  stepRatePct: number | null
  /** Sessions that reached the previous stage but record no event at this one. Not proof they skipped or left. */
  notRecordedAtStep: number | null
}

/** Canonical stage order. Counts are cumulative (a session counts at a stage or any later one). */
export function buildFunnelRows(s: FunnelStageCounts, r: FunnelStageRates): FunnelRow[] {
  const ladder: Array<Omit<FunnelRow, 'pctOfVisits' | 'stepRatePct' | 'notRecordedAtStep'> & { step: number | null }> = [
    { key: 'visits',          label: 'Visits',            event: 'session_start',      count: s.visits,          step: null },
    { key: 'reachedProduct',  label: 'Viewed a product',  event: 'product_viewed',     count: s.reachedProduct,  step: r.visitToProduct },
    { key: 'reachedCart',     label: 'Added to cart',     event: 'add_to_cart',        count: s.reachedCart,     step: r.productToCart },
    { key: 'reachedCheckout', label: 'Started checkout',  event: 'checkout_started',   count: s.reachedCheckout, step: r.cartToCheckout },
    { key: 'purchased',       label: 'Purchased',         event: 'purchase_completed', count: s.purchased,       step: r.checkoutToPurchase },
  ]
  return ladder.map((row, i) => ({
    key: row.key, label: row.label, event: row.event, count: row.count,
    pctOfVisits: displayRatePct(row.count, s.visits),
    stepRatePct: i === 0 ? null : row.step,
    notRecordedAtStep: i === 0 ? null : Math.max(0, ladder[i - 1].count - row.count),
  }))
}

export interface FunnelTrendBucketView {
  label: string
  date: string
  partial: boolean
  coverage: 'full' | 'partial' | 'none'
  stages: FunnelStageCounts | null
  rates: FunnelStageRates | null
}

export type FunnelTrendMode = 'counts' | 'conversion'

export interface FunnelTrendSeriesDef {
  key: string
  label: string
  color: string
  unit: 'count' | 'pct'
  unitLabel?: string
}

export const FUNNEL_COUNT_SERIES: FunnelTrendSeriesDef[] = [
  { key: 'visits',          label: 'Sessions',        color: '#1A1A1A', unit: 'count', unitLabel: 'sessions' },
  { key: 'reachedCart',     label: 'Added to cart',   color: '#1D4ED8', unit: 'count', unitLabel: 'sessions' },
  { key: 'reachedCheckout', label: 'Started checkout', color: '#B45309', unit: 'count', unitLabel: 'sessions' },
  { key: 'purchased',       label: 'Purchased',       color: '#047857', unit: 'count', unitLabel: 'sessions' },
]

/** Step conversions, each with its own denominator so a tiny day cannot masquerade as a trend. */
export const FUNNEL_RATE_SERIES: Array<FunnelTrendSeriesDef & {
  rate: keyof FunnelStageRates; num: keyof FunnelStageCounts; den: keyof FunnelStageCounts; denWhat: string
}> = [
  { key: 'visitToProduct',     label: 'Visit → product',     color: '#0F766E', unit: 'pct', rate: 'visitToProduct',     num: 'reachedProduct',  den: 'visits',          denWhat: 'sessions' },
  { key: 'productToCart',      label: 'Product → cart',      color: '#1D4ED8', unit: 'pct', rate: 'productToCart',      num: 'reachedCart',     den: 'reachedProduct',  denWhat: 'sessions that reached a product' },
  { key: 'cartToCheckout',     label: 'Cart → checkout',     color: '#B45309', unit: 'pct', rate: 'cartToCheckout',     num: 'reachedCheckout', den: 'reachedCart',     denWhat: 'sessions that added to cart' },
  { key: 'checkoutToPurchase', label: 'Checkout → purchase', color: '#047857', unit: 'pct', rate: 'checkoutToPurchase', num: 'purchased',       den: 'reachedCheckout', denWhat: 'sessions that started checkout' },
]

/**
 * Series for the funnel-trend chart.
 *
 * A bucket before first-party collection existed has no stages, so every series is a gap
 * there (no invented zero). A day with sessions but a zero denominator for a step has a
 * null rate, also a gap — never 0%. Tooltip notes carry the underlying counts.
 */
export function funnelTrendSeries(
  buckets: FunnelTrendBucketView[], mode: FunnelTrendMode,
): Array<FunnelTrendSeriesDef & { values: Array<number | null>; notes: Array<string | undefined> }> {
  const dayNote = (b: FunnelTrendBucketView): string | undefined =>
    b.coverage === 'none' ? 'No data — analytics collection had not started yet'
    : b.coverage === 'partial' ? 'Collection began part-way through this day'
    : b.partial ? 'Partial day (edge of the selected window)'
    : undefined

  if (mode === 'counts') {
    return FUNNEL_COUNT_SERIES.map(def => ({
      ...def,
      values: buckets.map(b => (b.stages ? b.stages[def.key as keyof FunnelStageCounts] : null)),
      notes: buckets.map(dayNote),
    }))
  }
  return FUNNEL_RATE_SERIES.map(def => ({
    key: def.key, label: def.label, color: def.color, unit: def.unit,
    values: buckets.map(b => (b.rates ? b.rates[def.rate] : null)),
    notes: buckets.map(b => {
      const base = dayNote(b)
      if (!b.stages || !b.rates) return base
      const num = b.stages[def.num], den = b.stages[def.den]
      const detail = b.rates[def.rate] === null
        ? `No rate — no ${def.denWhat} that day`
        : `${num} of ${den} ${def.denWhat}`
      return base ? `${detail} · ${base}` : detail
    }),
  }))
}

/** True when at least one bucket carries real (non-null) data. */
export function funnelTrendHasData(buckets: FunnelTrendBucketView[]): boolean {
  return buckets.some(b => b.stages !== null && b.stages.visits > 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT PERFORMANCE
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductRow {
  productId: string
  slug: string
  name: string
  views: number
  adds: number
  checkouts: number
  purchases: number
  addRatePct: number | null
  purchaseRatePct: number | null
}

export type ProductRankMetric = 'views' | 'adds' | 'purchases'

/**
 * Rank products by one metric, descending. Ties break on views (desc) then name (asc) so
 * the order is deterministic. Products with nothing recorded for the ranking metric are
 * left out: a bar of length zero is not a ranking.
 */
export function rankProducts(rows: ProductRow[], metric: ProductRankMetric, limit = 8): ProductRow[] {
  return rows
    .filter(r => r[metric] > 0)
    .slice()
    .sort((a, b) =>
      (b[metric] - a[metric]) || (b.views - a.views) || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit))
}
