// lib/financial-calculator.ts
// THE single authoritative financial calculation layer for KVRN.
//
// Pure functions only. No database access, no I/O, no framework imports.
// Every profit/margin/shipping number shown anywhere in the admin MUST come from
// here so that no two surfaces can disagree.
//
// ── CORE ACCOUNTING SEPARATION ───────────────────────────────────────────────
// Customer charges and KVRN costs are never conflated:
//   shippingRevenueCents  = what the customer paid KVRN for shipping
//   shippingCostCents     = what KVRN paid the carrier for the label
// Those are different numbers from different tables.
//
// ── UNKNOWN vs ZERO ──────────────────────────────────────────────────────────
// `null` means "not yet reconciled" and is contagious: if any cost input is null,
// the dependent profit figure is null too. A missing Stripe fee must never silently
// become $0 and inflate profit. Callers surface this via ReconciliationStatus.

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/** Integer cents, or null when the value is genuinely not yet known. */
export type CentsOrUnknown = number | null

export type ReconciliationState = 'complete' | 'partial' | 'unknown'

export interface MissingCost {
  field: 'cogs' | 'shipping_cost' | 'stripe_fee'
  label: string
}

export interface ReconciliationStatus {
  state:   ReconciliationState
  missing: MissingCost[]
}

/** Raw per-order inputs, read straight from the database with no pre-maths. */
export interface OrderFinancialInputs {
  /** orders.subtotal_cents — merchandise before any discount. */
  subtotalCents: number
  /** orders.discount_cents — merchandise/order discount only. Never shipping. */
  merchandiseDiscountCents: number
  /** orders.shipping_cents — final shipping charged to the customer (revenue). */
  shippingRevenueCents: number
  /** orders.shipping_quoted_cents — live carrier quote before any reduction. */
  shippingQuotedCents: CentsOrUnknown
  /** orders.shipping_discount_cents — reduction from a MANUAL shipping promo code. */
  shippingPromoDiscountCents: number
  /** orders.shipping_auto_free_discount_cents — waived by the automatic $150+ benefit. */
  shippingAutoFreeDiscountCents: number
  /** orders.tax_cents — pass-through liability. Not revenue, not profit. */
  taxCents: number
  /** SUM(order_items.line_cogs_cents). null when any line has no cost snapshot. */
  cogsCents: CentsOrUnknown
  /** SUM(shipments.label_cost_cents). null when no label cost is recorded. */
  shippingCostCents: CentsOrUnknown
  /** orders.stripe_fee_cents. null until reconciled from Stripe. */
  stripeFeeCents: CentsOrUnknown
  /** SUM of succeeded refunds for this order. Always known (0 when none). */
  refundCents: number
  /** SUM of processing fees Stripe returned with refunds. null = unknown. */
  refundedFeeCents: CentsOrUnknown
}

export interface OrderEconomics {
  // Revenue
  grossMerchandiseCents:    number
  merchandiseDiscountCents: number
  merchandiseRevenueCents:  number
  shippingRevenueCents:     number
  grossCustomerRevenueCents: number
  refundCents:              number
  netRevenueCents:          number
  /** Tracked and displayed separately. Never included in revenue or profit. */
  taxCollectedCents:        number

  // Costs
  cogsCents:          CentsOrUnknown
  shippingCostCents:  CentsOrUnknown
  stripeFeeCents:     CentsOrUnknown
  netStripeFeeCents:  CentsOrUnknown

  // Shipping economics
  shippingMarginCents:      CentsOrUnknown
  shippingSubsidyCents:     CentsOrUnknown
  shippingDiscountTotalCents: number
  isAutoFreeShipping:       boolean
  freeShippingCostCents:    CentsOrUnknown

  // Result
  contributionProfitCents:  CentsOrUnknown
  contributionMarginPct:    number | null

  reconciliation: ReconciliationStatus
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Sum that stays null if ANY input is null. Unknown cost must poison the total. */
export function sumOrUnknown(...values: CentsOrUnknown[]): CentsOrUnknown {
  let total = 0
  for (const v of values) {
    if (v === null || v === undefined) return null
    total += v
  }
  return total
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null
  return Math.round((numerator / denominator) * 10000) / 100
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER ECONOMICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the full economics of a single order.
 *
 * FORMULAS (authoritative — these exact lines are what the admin displays):
 *
 *   merchandiseRevenue    = subtotal - merchandiseDiscount
 *   shippingRevenue       = orders.shipping_cents
 *   grossCustomerRevenue  = merchandiseRevenue + shippingRevenue
 *   netRevenue            = grossCustomerRevenue - refunds
 *
 *   netStripeFee          = stripeFee - refundedFee
 *   shippingMargin        = shippingRevenue - shippingCost
 *
 *   contributionProfit    = netRevenue - cogs - shippingCost - netStripeFee
 *
 * The shipping subsidy is deliberately NOT subtracted separately: it is already
 * captured because shippingCost is subtracted while shippingRevenue is added.
 * Subtracting it again would double-count it.
 *
 * Tax is excluded entirely — it is collected on behalf of an authority.
 */
export function computeOrderEconomics(input: OrderFinancialInputs): OrderEconomics {
  const grossMerchandiseCents    = input.subtotalCents
  const merchandiseDiscountCents = input.merchandiseDiscountCents
  const merchandiseRevenueCents  = grossMerchandiseCents - merchandiseDiscountCents

  const shippingRevenueCents      = input.shippingRevenueCents
  const grossCustomerRevenueCents = merchandiseRevenueCents + shippingRevenueCents

  const refundCents     = input.refundCents
  const netRevenueCents = grossCustomerRevenueCents - refundCents

  // A refund may return part of the processing fee. Unknown stays unknown.
  const netStripeFeeCents: CentsOrUnknown =
    input.stripeFeeCents === null
      ? null
      : input.refundedFeeCents === null
        ? input.stripeFeeCents
        : input.stripeFeeCents - input.refundedFeeCents

  // Shipping economics
  const shippingMarginCents: CentsOrUnknown =
    input.shippingCostCents === null
      ? null
      : shippingRevenueCents - input.shippingCostCents

  const shippingSubsidyCents: CentsOrUnknown =
    shippingMarginCents === null ? null : Math.max(0, -shippingMarginCents)

  const shippingDiscountTotalCents =
    input.shippingPromoDiscountCents + input.shippingAutoFreeDiscountCents

  const isAutoFreeShipping = input.shippingAutoFreeDiscountCents > 0

  // What the automatic free-shipping benefit actually cost KVRN for this order.
  // Reporting-only: never subtracted again in the profit formula.
  const freeShippingCostCents: CentsOrUnknown =
    !isAutoFreeShipping ? 0 : input.shippingCostCents

  // Reconciliation
  const missing: MissingCost[] = []
  if (input.cogsCents === null)         missing.push({ field: 'cogs',          label: 'Product COGS' })
  if (input.shippingCostCents === null) missing.push({ field: 'shipping_cost', label: 'Shipping cost' })
  if (input.stripeFeeCents === null)    missing.push({ field: 'stripe_fee',    label: 'Stripe fee' })

  const reconciliation: ReconciliationStatus = {
    state:   missing.length === 0 ? 'complete' : missing.length === 3 ? 'unknown' : 'partial',
    missing,
  }

  const totalCostCents = sumOrUnknown(
    input.cogsCents,
    input.shippingCostCents,
    netStripeFeeCents,
  )

  const contributionProfitCents: CentsOrUnknown =
    totalCostCents === null ? null : netRevenueCents - totalCostCents

  const contributionMarginPct =
    contributionProfitCents === null ? null : pct(contributionProfitCents, netRevenueCents)

  return {
    grossMerchandiseCents,
    merchandiseDiscountCents,
    merchandiseRevenueCents,
    shippingRevenueCents,
    grossCustomerRevenueCents,
    refundCents,
    netRevenueCents,
    taxCollectedCents: input.taxCents,

    cogsCents:         input.cogsCents,
    shippingCostCents: input.shippingCostCents,
    stripeFeeCents:    input.stripeFeeCents,
    netStripeFeeCents,

    shippingMarginCents,
    shippingSubsidyCents,
    shippingDiscountTotalCents,
    isAutoFreeShipping,
    freeShippingCostCents,

    contributionProfitCents,
    contributionMarginPct,

    reconciliation,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DISCOUNT ALLOCATION (for per-product profitability)
// ─────────────────────────────────────────────────────────────────────────────

export interface AllocatableLine {
  /** Stable identifier used as the final deterministic tie-break. */
  id: string
  lineTotalCents: number
}

export interface AllocatedLine extends AllocatableLine {
  allocatedDiscountCents: number
}

/**
 * Allocate an order-level merchandise discount across its lines.
 *
 * METHOD: largest-remainder (Hamilton) apportionment, weighted by line total.
 *   1. exact share      = discount * lineTotal / merchandiseTotal
 *   2. each line takes  floor(exact share)
 *   3. leftover cents go to the largest fractional remainders
 *   4. ties broken by lineTotal DESC, then id ASC — fully deterministic
 *
 * GUARANTEE: the returned allocations sum EXACTLY to totalDiscountCents, with no
 * rounding drift. This is asserted in the test suite.
 */
export function allocateDiscountToLines(
  lines: AllocatableLine[],
  totalDiscountCents: number,
): AllocatedLine[] {
  if (lines.length === 0) return []

  if (totalDiscountCents <= 0) {
    return lines.map(l => ({ ...l, allocatedDiscountCents: 0 }))
  }

  const merchandiseTotal = lines.reduce((s, l) => s + l.lineTotalCents, 0)

  // Degenerate case: nothing to weight against. Give it all to the first line
  // (by deterministic order) so the sum still reconciles exactly.
  if (merchandiseTotal <= 0) {
    const sorted = [...lines].sort((a, b) => a.id.localeCompare(b.id))
    return lines.map(l => ({
      ...l,
      allocatedDiscountCents: l.id === sorted[0].id ? totalDiscountCents : 0,
    }))
  }

  // Never allocate more than the merchandise total.
  const distributable = Math.min(totalDiscountCents, merchandiseTotal)

  const withShares = lines.map(l => {
    const exact = (distributable * l.lineTotalCents) / merchandiseTotal
    const floor = Math.floor(exact)
    return { line: l, floor, remainder: exact - floor }
  })

  let assigned = withShares.reduce((s, w) => s + w.floor, 0)
  let leftover = distributable - assigned

  const byRemainder = [...withShares].sort((a, b) => {
    if (b.remainder !== a.remainder)               return b.remainder - a.remainder
    if (b.line.lineTotalCents !== a.line.lineTotalCents)
      return b.line.lineTotalCents - a.line.lineTotalCents
    return a.line.id.localeCompare(b.line.id)
  })

  const bonus = new Map<string, number>()
  for (let i = 0; i < leftover; i++) {
    const target = byRemainder[i % byRemainder.length].line.id
    bonus.set(target, (bonus.get(target) ?? 0) + 1)
  }

  return withShares.map(w => ({
    ...w.line,
    allocatedDiscountCents: w.floor + (bonus.get(w.line.id) ?? 0),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// PERIOD ECONOMICS
// ─────────────────────────────────────────────────────────────────────────────

export interface PeriodInputs {
  orders: OrderEconomics[]
  /**
   * RECOGNIZED operating expense for the window, EXCLUDING 'development'.
   *
   * Sourced only from real expense_transactions — never from an expected recurring
   * definition. A transaction carrying a service period is apportioned across that
   * period, so a $40 annual renewal recognises roughly $3.33 into a one-month
   * window. This is period recognition, NOT the amount paid; the cash fact stays
   * $40 and is reported separately on the Infrastructure page as ACTUAL PAID.
   */
  recognizedOperatingExpensesCents: number
  /** RECOGNIZED 'development' expense (GitHub/Codespaces), reported apart. */
  recognizedDevelopmentExpensesCents: number
  /** Advertising spend attributed to the window. */
  advertisingSpendCents: number
  /**
   * FORECAST from provider usage snapshots. Informational only — structurally
   * excluded from every realised-profit figure below.
   */
  estimatedAccruedOperatingExpensesCents: number
  /** FORECAST month-end total. Informational only. */
  projectedOperatingExpensesCents: number
}

export interface PeriodEconomics {
  orderCount: number

  grossMerchandiseCents:    number
  merchandiseDiscountCents: number
  merchandiseRevenueCents:  number
  shippingRevenueCents:     number
  grossCustomerRevenueCents: number
  refundCents:              number
  netRevenueCents:          number
  taxCollectedCents:        number

  /** Sum over orders WITH a known value. Partial when some are unknown. */
  cogsCents:         number
  shippingCostCents: number
  stripeFeeCents:    number

  ordersMissingCogs:         number
  ordersMissingShippingCost: number
  ordersMissingStripeFee:    number

  shippingMarginCents:   number
  shippingSubsidyCents:  number
  freeShippingOrders:    number
  freeShippingCostCents: number
  ordersShippingUnderwater: number
  ordersShippingProfitable: number

  // RECOGNIZED costs — real transactions apportioned to this window.
  // These reduce realised profit. Distinct from ACTUAL PAID (cash out), which is
  // reported on the Infrastructure page.
  recognizedOperatingExpensesCents:   number
  recognizedDevelopmentExpensesCents: number
  advertisingSpendCents:              number

  // FORECASTS — displayed separately, never subtracted from realised profit
  estimatedAccruedOperatingExpensesCents: number
  projectedOperatingExpensesCents:        number

  contributionProfitCents:               number
  realizedOperatingProfitBeforeAdsCents: number
  realizedOperatingProfitAfterAdsCents:  number
  realizedProfitAfterDevelopmentCents:   number

  contributionMarginPct:    number | null
  realizedOperatingMarginPct: number | null

  /** True when any cost component is missing on any order in the window. */
  isPartial: boolean
}

/**
 * Aggregate order economics over a reporting window.
 *
 * PARTIAL-DATA POLICY: unlike the per-order path, a period total cannot be null —
 * one unreconciled order would erase the whole report. Instead, known values are
 * summed and the count of orders missing each component is returned alongside.
 * `isPartial` is true whenever anything is missing, and the UI labels the figures
 * accordingly. Totals are therefore a floor on cost and a ceiling on profit.
 *
 * REALISED PROFIT USES RECOGNIZED EXPENSES FROM REAL TRANSACTIONS ONLY:
 *
 *   contributionProfit                = SUM(per-order contribution)
 *   realizedOperatingProfitBeforeAds  = contributionProfit - recognizedOperatingExpenses
 *   realizedOperatingProfitAfterAds   = above              - advertisingSpend
 *   realizedProfitAfterDevelopment    = above              - recognizedDevelopmentExpenses
 *
 * RECOGNIZED != PAID. A real transaction is apportioned across its service period,
 * so an annual renewal contributes a twelfth to a monthly window. The cash amount
 * paid is a separate fact surfaced on the Infrastructure page as ACTUAL PAID.
 *
 * estimatedAccrued* and projected* are FORECASTS. They are returned for display but
 * never subtracted from any figure named "realized" — reducing profit by a bill that
 * has not arrived would misstate history.
 */
export function computePeriodEconomics(input: PeriodInputs): PeriodEconomics {
  const o = input.orders

  const sum = (fn: (e: OrderEconomics) => number) => o.reduce((s, e) => s + fn(e), 0)
  const sumKnown = (fn: (e: OrderEconomics) => CentsOrUnknown) =>
    o.reduce((s, e) => { const v = fn(e); return v === null ? s : s + v }, 0)
  const countMissing = (fn: (e: OrderEconomics) => CentsOrUnknown) =>
    o.filter(e => fn(e) === null).length

  const grossMerchandiseCents     = sum(e => e.grossMerchandiseCents)
  const merchandiseDiscountCents  = sum(e => e.merchandiseDiscountCents)
  const merchandiseRevenueCents   = sum(e => e.merchandiseRevenueCents)
  const shippingRevenueCents      = sum(e => e.shippingRevenueCents)
  const grossCustomerRevenueCents = sum(e => e.grossCustomerRevenueCents)
  const refundCents               = sum(e => e.refundCents)
  const netRevenueCents           = sum(e => e.netRevenueCents)
  const taxCollectedCents         = sum(e => e.taxCollectedCents)

  const cogsCents         = sumKnown(e => e.cogsCents)
  const shippingCostCents = sumKnown(e => e.shippingCostCents)
  const stripeFeeCents    = sumKnown(e => e.netStripeFeeCents)

  const ordersMissingCogs         = countMissing(e => e.cogsCents)
  const ordersMissingShippingCost = countMissing(e => e.shippingCostCents)
  const ordersMissingStripeFee    = countMissing(e => e.stripeFeeCents)

  // Shipping margin only counts orders where the cost is actually known.
  const shippingMarginCents  = sumKnown(e => e.shippingMarginCents)
  const shippingSubsidyCents = sumKnown(e => e.shippingSubsidyCents)

  const freeShippingOrders    = o.filter(e => e.isAutoFreeShipping).length
  const freeShippingCostCents = o
    .filter(e => e.isAutoFreeShipping)
    .reduce((s, e) => s + (e.freeShippingCostCents ?? 0), 0)

  const ordersShippingUnderwater = o.filter(
    e => e.shippingMarginCents !== null && e.shippingMarginCents < 0
  ).length
  const ordersShippingProfitable = o.filter(
    e => e.shippingMarginCents !== null && e.shippingMarginCents > 0
  ).length

  // Known costs only; unknown treated as 0 here and flagged via isPartial.
  const contributionProfitCents =
    netRevenueCents - cogsCents - shippingCostCents - stripeFeeCents

  // RECOGNIZED expenses from real transactions only. Forecasts never subtracted.
  const realizedOperatingProfitBeforeAdsCents =
    contributionProfitCents - input.recognizedOperatingExpensesCents

  const realizedOperatingProfitAfterAdsCents =
    realizedOperatingProfitBeforeAdsCents - input.advertisingSpendCents

  // Development tooling is shown after the operating result so the core business
  // performance is legible on its own.
  const realizedProfitAfterDevelopmentCents =
    realizedOperatingProfitAfterAdsCents - input.recognizedDevelopmentExpensesCents

  return {
    orderCount: o.length,

    grossMerchandiseCents,
    merchandiseDiscountCents,
    merchandiseRevenueCents,
    shippingRevenueCents,
    grossCustomerRevenueCents,
    refundCents,
    netRevenueCents,
    taxCollectedCents,

    cogsCents,
    shippingCostCents,
    stripeFeeCents,

    ordersMissingCogs,
    ordersMissingShippingCost,
    ordersMissingStripeFee,

    shippingMarginCents,
    shippingSubsidyCents,
    freeShippingOrders,
    freeShippingCostCents,
    ordersShippingUnderwater,
    ordersShippingProfitable,

    recognizedOperatingExpensesCents:   input.recognizedOperatingExpensesCents,
    recognizedDevelopmentExpensesCents: input.recognizedDevelopmentExpensesCents,
    advertisingSpendCents:              input.advertisingSpendCents,

    estimatedAccruedOperatingExpensesCents: input.estimatedAccruedOperatingExpensesCents,
    projectedOperatingExpensesCents:        input.projectedOperatingExpensesCents,

    contributionProfitCents,
    realizedOperatingProfitBeforeAdsCents,
    realizedOperatingProfitAfterAdsCents,
    realizedProfitAfterDevelopmentCents,

    contributionMarginPct:      pct(contributionProfitCents, netRevenueCents),
    realizedOperatingMarginPct: pct(realizedOperatingProfitAfterAdsCents, netRevenueCents),

    isPartial:
      ordersMissingCogs > 0 ||
      ordersMissingShippingCost > 0 ||
      ordersMissingStripeFee > 0,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTE ON RECURRING EXPENSES
// ─────────────────────────────────────────────────────────────────────────────
//
// There is deliberately NO helper here that expands a recurring expense definition
// into countable occurrences.
//
// An expected obligation ("Neon $19/month") is not money spent. Expanding it into
// occurrences and subtracting them would reduce realised profit by invoices that may
// never arrive. Realised operating expense is read exclusively from
// expense_transactions — see getActualOperatingExpensesCents in lib/financials.ts,
// which pro-rates a transaction's own service period across the reporting window.
