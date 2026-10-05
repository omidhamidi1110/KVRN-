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

// ── ONE PROFIT DERIVATION (Financial Integrity batch) ────────────────────────
// There are three different money figures and they must never be mixed up:
//
//   ORDER CONTRIBUTION  per-order, cohort basis: every effect that can be tied to a
//                       paid order (refunds, lost disputes + dispute fees, COGS net
//                       of returned-stock credit, replacement COGS and shipping,
//                       return labels, Stripe fees, affiliate commission expense).
//   OPERATING PROFIT    contribution minus costs that belong to no order
//                       (operating expense, development, advertising, write-offs).
//   CASH FLOW           money that moved (supplier payments, affiliate payouts,
//                       expense payments). NEVER called profit. See lib/cash-flow.ts
//                       style reporting in financials.getCashFlow().
//
// COHORT BASIS: a period contains the orders PAID in it, together with every
// lifetime effect of those orders (a refund next month still belongs to this
// month's order). Non-order costs are recognised by their own dates. This is the
// only basis used by every route; the ledger-basis helpers in SQL
// (affiliate_commission_effect, dispute adjustments by effective_at) answer a
// different question ("what moved in the window") and are labelled as such.

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/** Integer cents, or null when the value is genuinely not yet known. */
export type CentsOrUnknown = number | null

export type ReconciliationState = 'complete' | 'partial' | 'unknown'

export interface MissingCost {
  field:
    | 'cogs' | 'shipping_cost' | 'stripe_fee'
    | 'return_cogs_credit' | 'cancellation_cogs_credit' | 'exchange_cogs' | 'exchange_shipping_cost'
    | 'return_label_cost' | 'dispute_fee' | 'affiliate_commission'
    | 'refund_fee' | 'refund_revenue_split'
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
  /**
   * Merchant carrier cost of the order's outbound shipments (SQL fi_order_shipping).
   * null = unknown: nothing recorded yet, ANY relevant shipment without a cost, or ANY
   * checkout-quote ESTIMATE (shippo_quote). A partial sum is never reported.
   */
  shippingCostCents: CentsOrUnknown
  /** orders.stripe_fee_cents. null until reconciled from Stripe. */
  stripeFeeCents: CentsOrUnknown
  /** SUM of succeeded refunds for this order: total customer CASH refunded. Always known (0 when none). */
  refundCents: number
  /**
   * The part of the refunds that reverses REVENUE: merchandise + customer shipping.
   * Refunded sales tax reverses the tax liability, never revenue.
   *   undefined  derive: equals refundCents when the order carries no tax; with tax and a
   *              refund the split is NOT guessed (treated as unresolved)
   *   null       the refund decomposition is unresolved -> exact profit is incomplete
   */
  refundRevenueCents?: CentsOrUnknown
  /**
   * SUM of processing fees Stripe returned with refunds.
   *   no succeeded refund        -> known 0 (enforced here when refundCents is 0)
   *   any refund fee unknown     -> null: the fee-refund total is UNKNOWN, never a partial sum
   *   all known                  -> their exact sum
   */
  refundedFeeCents: CentsOrUnknown

  // ── Order-attributable effects added by the Financial Integrity batch ──────
  // All OPTIONAL so existing callers keep working: `undefined` means "this order
  // has none of that effect" (0). `null` means the effect exists but its amount is
  // not known yet, and it poisons the order's profit exactly like a missing fee.

  /** Recognised revenue lost to disputes (SUM of net_revenue_impact_cents). */
  disputeLossCents?: number
  /** Stripe dispute fees (net of fee reversals). null = a dispute with no balance transaction yet. */
  disputeFeeCents?: CentsOrUnknown
  /** Net affiliate commission EXPENSE from the ledger. null = unresolved refund/dispute sources. */
  affiliateCommissionCents?: CentsOrUnknown
  /** COGS returned to stock by sellable restocks (a credit, reduces cost). null = restocked with unknown cost. */
  returnCogsCreditCents?: CentsOrUnknown
  /**
   * COGS credit of a PRE-SHIPMENT CANCELLATION (migration 025): the value of the layers restored when a
   * fully refunded, never-shipped order was cancelled. A SEPARATE term from the return credit: the original
   * sale COGS (cogsCents) is never edited, this offsets it. null = a restored unit's cost is unknown.
   */
  cancellationCogsCreditCents?: CentsOrUnknown
  /** COGS of replacement items shipped on exchanges. null = unknown. */
  exchangeCogsCents?: CentsOrUnknown
  /** Carrier cost of replacement shipments. null = a shipped exchange with no recorded cost. */
  exchangeShippingCostCents?: CentsOrUnknown
  /** Return-label cost KVRN paid. null = KVRN-paid return received with no recorded cost. */
  returnLabelCostCents?: CentsOrUnknown
  /** Extra merchandise revenue collected on exchanges (net of tax). */
  exchangeRevenueCents?: number
}

export interface OrderEconomics {
  // Revenue
  grossMerchandiseCents:    number
  merchandiseDiscountCents: number
  merchandiseRevenueCents:  number
  shippingRevenueCents:     number
  grossCustomerRevenueCents: number
  /** Total customer cash refunded (cash-flow view). */
  refundCents:              number
  /** The part of refundCents that reduced REVENUE (merchandise + shipping; never tax). */
  refundRevenueCents:       number
  /** Revenue lost to disputes AFTER removing any overlap with refunds (never double-reversed). */
  disputeLossCents:         number
  /** Dispute loss that was NOT applied because the same money was already refunded. */
  disputeRefundOverlapCents: number
  exchangeRevenueCents:     number
  netRevenueCents:          number
  /** Tracked and displayed separately. Never included in revenue or profit. */
  taxCollectedCents:        number

  // Costs
  cogsCents:          CentsOrUnknown
  shippingCostCents:  CentsOrUnknown
  stripeFeeCents:     CentsOrUnknown
  netStripeFeeCents:  CentsOrUnknown
  disputeFeeCents:           CentsOrUnknown
  affiliateCommissionCents:  CentsOrUnknown
  returnCogsCreditCents:     CentsOrUnknown
  cancellationCogsCreditCents: CentsOrUnknown
  exchangeCogsCents:         CentsOrUnknown
  exchangeShippingCostCents: CentsOrUnknown
  returnLabelCostCents:      CentsOrUnknown
  /** COGS − returned-stock credit − cancellation credit + replacement COGS. null if any part is unknown. */
  netProductCostCents:       CentsOrUnknown
  /** Every cost that is not product cost: carrier, return labels, fees, commission. */
  otherOrderCostsCents:      CentsOrUnknown

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
 *   disputeLoss           = MIN(recognised dispute loss,
 *                               grossCustomerRevenue + exchangeRevenue - revenueRefunds)   (no double reversal)
 *   netRevenue            = grossCustomerRevenue + exchangeRevenue - revenueRefunds - disputeLoss
 *                           (revenueRefunds = merchandise + shipping refunds; refunded TAX
 *                            reverses the liability, not revenue)
 *
 *   netStripeFee          = stripeFee - refundedFee   (null if either is unknown)
 *   shippingMargin        = shippingRevenue - shippingCost
 *
 *   netProductCost        = cogs - returnedStockCredit + replacementCogs
 *   otherOrderCosts       = shippingCost + replacementShipping + returnLabel
 *                           + netStripeFee + disputeFee + affiliateCommission
 *   contributionProfit    = netRevenue - netProductCost - otherOrderCosts
 *
 * Every term is null when unknown and nulls are contagious: contributionProfit is
 * null unless EVERY cost term is known. Shipping revenue and shipping expense stay
 * separate terms; the Stripe fee appears once; tax appears nowhere.
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
  const exchangeRevenueCents = input.exchangeRevenueCents ?? 0

  // Refunded sales tax reverses a liability, not revenue. Only the merchandise and
  // customer-shipping portion of a refund reduces operating revenue. When the order
  // carries tax and the split is not resolved it is NOT guessed: net revenue falls back
  // to the full refund as a diagnostic floor and exact profit becomes incomplete.
  let refundRevenueCents = refundCents
  let refundSplitUnknown = false
  if (input.refundRevenueCents === undefined) {
    if (refundCents > 0 && input.taxCents > 0) refundSplitUnknown = true
  } else if (input.refundRevenueCents === null) {
    refundSplitUnknown = true
  } else {
    refundRevenueCents = input.refundRevenueCents
  }

  // A lost dispute and a refund can cover the SAME money. Only what the customer
  // actually paid and has not already been refunded can still be lost, so the
  // dispute loss is capped there. The part removed is reported, never silently lost.
  const reversibleCents = Math.max(0, grossCustomerRevenueCents + exchangeRevenueCents - refundRevenueCents)
  const rawDisputeLoss  = Math.max(0, input.disputeLossCents ?? 0)
  const disputeLossCents = Math.min(rawDisputeLoss, reversibleCents)
  const disputeRefundOverlapCents = rawDisputeLoss - disputeLossCents

  const netRevenueCents =
    grossCustomerRevenueCents + exchangeRevenueCents - refundRevenueCents - disputeLossCents

  // A refund may return part of the processing fee (migration 015: NULL = UNKNOWN, not
  // zero). With no refund the returned fee is known to be 0; with a refund whose fee
  // return is unknown the net fee is UNKNOWN — it is never "keep the whole fee".
  const refundedFeeCents: CentsOrUnknown = refundCents === 0 ? 0 : input.refundedFeeCents
  const netStripeFeeCents: CentsOrUnknown =
    input.stripeFeeCents === null || refundedFeeCents === null
      ? null
      : input.stripeFeeCents - refundedFeeCents

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

  // Optional effects: undefined = none (0), null = exists but unknown.
  const eff = (v: CentsOrUnknown | undefined): CentsOrUnknown => (v === undefined ? 0 : v)
  const disputeFeeCents           = eff(input.disputeFeeCents)
  const affiliateCommissionCents  = eff(input.affiliateCommissionCents)
  const returnCogsCreditCents     = eff(input.returnCogsCreditCents)
  const cancellationCogsCreditCents = eff(input.cancellationCogsCreditCents)
  const exchangeCogsCents         = eff(input.exchangeCogsCents)
  const exchangeShippingCostCents = eff(input.exchangeShippingCostCents)
  const returnLabelCostCents      = eff(input.returnLabelCostCents)

  // Reconciliation
  const missing: MissingCost[] = []
  if (input.cogsCents === null)         missing.push({ field: 'cogs',          label: 'Product COGS' })
  if (input.shippingCostCents === null) missing.push({ field: 'shipping_cost', label: 'Shipping cost' })
  if (input.stripeFeeCents === null)    missing.push({ field: 'stripe_fee',    label: 'Stripe fee' })
  const coreMissing = missing.length
  if (input.stripeFeeCents !== null && refundedFeeCents === null)
    missing.push({ field: 'refund_fee', label: 'Processing fee returned on refunds' })
  if (refundSplitUnknown)
    missing.push({ field: 'refund_revenue_split', label: 'Refund split between revenue and sales tax' })
  if (returnCogsCreditCents === null)     missing.push({ field: 'return_cogs_credit',     label: 'Returned-stock COGS credit' })
  if (cancellationCogsCreditCents === null) missing.push({ field: 'cancellation_cogs_credit', label: 'Cancelled-order COGS credit' })
  if (exchangeCogsCents === null)         missing.push({ field: 'exchange_cogs',          label: 'Replacement COGS' })
  if (exchangeShippingCostCents === null) missing.push({ field: 'exchange_shipping_cost', label: 'Replacement shipping cost' })
  if (returnLabelCostCents === null)      missing.push({ field: 'return_label_cost',      label: 'Return label cost' })
  if (disputeFeeCents === null)           missing.push({ field: 'dispute_fee',            label: 'Dispute fee' })
  if (affiliateCommissionCents === null)  missing.push({ field: 'affiliate_commission',   label: 'Affiliate commission' })

  const reconciliation: ReconciliationStatus = {
    state:   missing.length === 0 ? 'complete' : coreMissing === 3 ? 'unknown' : 'partial',
    missing,
  }

  // A returned-stock credit REDUCES cost, so it enters as a negative.
  const netProductCostCents = sumOrUnknown(
    input.cogsCents,
    returnCogsCreditCents === null ? null : -returnCogsCreditCents,
    cancellationCogsCreditCents === null ? null : -cancellationCogsCreditCents,
    exchangeCogsCents,
  )
  const otherOrderCostsCents = sumOrUnknown(
    input.shippingCostCents,
    exchangeShippingCostCents,
    returnLabelCostCents,
    netStripeFeeCents,
    disputeFeeCents,
    affiliateCommissionCents,
  )
  const totalCostCents = sumOrUnknown(netProductCostCents, otherOrderCostsCents)

  const contributionProfitCents: CentsOrUnknown =
    totalCostCents === null || refundSplitUnknown ? null : netRevenueCents - totalCostCents

  const contributionMarginPct =
    contributionProfitCents === null ? null : pct(contributionProfitCents, netRevenueCents)

  return {
    grossMerchandiseCents,
    merchandiseDiscountCents,
    merchandiseRevenueCents,
    shippingRevenueCents,
    grossCustomerRevenueCents,
    refundCents,
    refundRevenueCents,
    disputeLossCents,
    disputeRefundOverlapCents,
    exchangeRevenueCents,
    netRevenueCents,
    taxCollectedCents: input.taxCents,

    cogsCents:         input.cogsCents,
    shippingCostCents: input.shippingCostCents,
    stripeFeeCents:    input.stripeFeeCents,
    netStripeFeeCents,
    disputeFeeCents,
    affiliateCommissionCents,
    returnCogsCreditCents,
    cancellationCogsCreditCents,
    exchangeCogsCents,
    exchangeShippingCostCents,
    returnLabelCostCents,
    netProductCostCents,
    otherOrderCostsCents,

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

/**
 * KNOWN-SO-FAR contribution of one order: net revenue minus every cost that IS
 * known. Used wherever a figure must be summed across orders even though some are
 * incomplete (chart buckets, period floors). Algebraically
 *   SUM(knownSoFarContribution(order)) == computePeriodEconomics(...).contributionProfitCents
 * so a chart can never disagree with the cards above it. For an order with nothing
 * unknown it equals contributionProfitCents exactly.
 */
export function knownSoFarContribution(e: OrderEconomics): number {
  const k = (v: CentsOrUnknown) => (v === null ? 0 : v)
  return e.netRevenueCents
    - (k(e.cogsCents) - k(e.returnCogsCreditCents) - k(e.cancellationCogsCreditCents) + k(e.exchangeCogsCents))
    - (k(e.shippingCostCents) + k(e.exchangeShippingCostCents) + k(e.returnLabelCostCents)
       + k(e.netStripeFeeCents) + k(e.disputeFeeCents) + k(e.affiliateCommissionCents))
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
  /**
   * Inventory written off / given away in the window (a cost with no order).
   * Known portion only; `writeOffCostUnknown` says some units had no cost.
   * Optional: undefined = none.
   */
  writeOffCostCents?: number
  writeOffCostUnknown?: boolean
}

export interface PeriodEconomics {
  orderCount: number

  grossMerchandiseCents:    number
  merchandiseDiscountCents: number
  merchandiseRevenueCents:  number
  shippingRevenueCents:     number
  grossCustomerRevenueCents: number
  refundCents:              number
  disputeLossCents:         number
  disputeRefundOverlapCents: number
  exchangeRevenueCents:     number
  netRevenueCents:          number
  taxCollectedCents:        number

  /** Sum over orders WITH a known value. Partial when some are unknown. */
  cogsCents:         number
  shippingCostCents: number
  stripeFeeCents:    number

  ordersMissingCogs:         number
  ordersMissingShippingCost: number
  ordersMissingStripeFee:    number
  /** Orders with ANY unknown order-attributable cost (the 3 above plus the new ones). */
  ordersWithUnknownCosts:    number

  // Known-so-far sums of the order effects added by the integrity batch.
  returnCogsCreditCents:     number
  /** Known-so-far COGS credits from pre-shipment cancellations (migration 025). */
  cancellationCogsCreditCents: number
  exchangeCogsCents:         number
  exchangeShippingCostCents: number
  returnLabelCostCents:      number
  disputeFeeCents:           number
  affiliateCommissionCents:  number
  writeOffCostCents:         number

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

  // ── CANONICAL, NULL-SAFE PROFIT ──────────────────────────────────────────
  // The numeric figures below this block are KNOWN-SO-FAR: unknown costs are left
  // out, so they are a ceiling on profit. The canonical figures are null the moment
  // any input is unknown, which is what the Admin must show instead of a
  // confident-looking number.
  /** ORDER CONTRIBUTION for the cohort. null if any order has an unknown cost. */
  canonicalOrderContributionCents: number | null
  /** OPERATING PROFIT = contribution - opex - development - ads - write-offs. null if unknown. */
  canonicalOperatingProfitCents:   number | null
  /**
   * 'complete'    every input is known AND the period's reconciliation is RECONCILED: the
   *               canonical figures are exact.
   * 'incomplete'  a required fact is unknown/estimated (or the period's reconciliation is
   *               INCOMPLETE): canonical figures are null, the numeric figures are floors.
   * 'exception'   the period's reconciliation reports an EXCEPTION (data contradicts an
   *               invariant): canonical figures are null — a number would be INVALID.
   * The calculator alone can only say 'complete' | 'incomplete';
   * applyIntegrityGate() adds the reconciliation verdict.
   */
  profitCompleteness: 'complete' | 'incomplete' | 'exception'
  /**
   * NON-AUTHORITATIVE diagnostic: the known-so-far figure (unknown costs left out, and
   * computed whatever the reconciliation state is). Never label it exact.
   */
  nonAuthoritativeOperatingProfitCents: number
  /** Always 'cohort': orders paid in the window with all of their lifetime effects. */
  profitBasis: 'cohort'

  contributionProfitCents:               number
  realizedOperatingProfitBeforeAdsCents: number
  realizedOperatingProfitAfterAdsCents:  number
  realizedProfitAfterDevelopmentCents:   number

  contributionMarginPct:      number | null
  realizedOperatingMarginPct: number | null

  // ── Derived operating metrics ────────────────────────────────────────────
  // All ratios are expressed against netRevenueCents so every percentage below
  // shares one denominator and they can be compared to each other directly.
  // Each is null when the denominator is zero rather than silently reported as 0%.
  totalOperatingCostCents:  number
  averageOrderValueCents:   number | null
  profitPerOrderCents:      number | null
  cogsPctOfRevenue:         number | null
  shippingCostPctOfRevenue: number | null
  stripeFeePctOfRevenue:    number | null
  advertisingPctOfRevenue:  number | null
  operatingExpensePctOfRevenue: number | null
  refundRatePct:            number | null

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
  const disputeLossCents          = sum(e => e.disputeLossCents)
  const disputeRefundOverlapCents = sum(e => e.disputeRefundOverlapCents)
  const exchangeRevenueCents      = sum(e => e.exchangeRevenueCents)
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

  const returnCogsCreditCents     = sumKnown(e => e.returnCogsCreditCents)
  const cancellationCogsCreditCents = sumKnown(e => e.cancellationCogsCreditCents)
  const exchangeCogsCents         = sumKnown(e => e.exchangeCogsCents)
  const exchangeShippingCostCents = sumKnown(e => e.exchangeShippingCostCents)
  const returnLabelCostCents      = sumKnown(e => e.returnLabelCostCents)
  const disputeFeeCents           = sumKnown(e => e.disputeFeeCents)
  const affiliateCommissionCents  = sumKnown(e => e.affiliateCommissionCents)
  const writeOffCostCents         = input.writeOffCostCents ?? 0
  const ordersWithUnknownCosts    = o.filter(e => e.reconciliation.missing.length > 0).length

  // KNOWN-SO-FAR: unknown costs are left out here and flagged via isPartial, so
  // this is a ceiling on profit. The nullable canonical figures below are the
  // exact ones.
  const contributionProfitCents =
    netRevenueCents
    - (cogsCents - returnCogsCreditCents - cancellationCogsCreditCents + exchangeCogsCents)
    - (shippingCostCents + exchangeShippingCostCents + returnLabelCostCents
       + stripeFeeCents + disputeFeeCents + affiliateCommissionCents)

  // RECOGNIZED expenses from real transactions only. Forecasts never subtracted.
  // Write-offs belong to no order, so they are recognised here by their own date.
  const realizedOperatingProfitBeforeAdsCents =
    contributionProfitCents - input.recognizedOperatingExpensesCents - writeOffCostCents

  const realizedOperatingProfitAfterAdsCents =
    realizedOperatingProfitBeforeAdsCents - input.advertisingSpendCents

  // Development tooling is shown after the operating result so the core business
  // performance is legible on its own.
  const realizedProfitAfterDevelopmentCents =
    realizedOperatingProfitAfterAdsCents - input.recognizedDevelopmentExpensesCents

  // Canonical: null as soon as ANY order contribution or the write-off cost is unknown.
  const canonicalOrderContributionCents = sumOrUnknown(...o.map(e => e.contributionProfitCents))
  const canonicalOperatingProfitCents =
    canonicalOrderContributionCents === null || input.writeOffCostUnknown
      ? null
      : canonicalOrderContributionCents
          - input.recognizedOperatingExpensesCents
          - input.recognizedDevelopmentExpensesCents
          - input.advertisingSpendCents
          - writeOffCostCents

  // Total of every cost that reduced realised profit this period.
  // Mirrors the profit chain exactly so cost + profit == revenue.
  const totalOperatingCostCents =
    (cogsCents - returnCogsCreditCents - cancellationCogsCreditCents + exchangeCogsCents) +
    (shippingCostCents + exchangeShippingCostCents + returnLabelCostCents) +
    stripeFeeCents + disputeFeeCents + affiliateCommissionCents + writeOffCostCents +
    input.recognizedOperatingExpensesCents +
    input.recognizedDevelopmentExpensesCents +
    input.advertisingSpendCents

  const orderCount = o.length

  return {
    orderCount,

    grossMerchandiseCents,
    merchandiseDiscountCents,
    merchandiseRevenueCents,
    shippingRevenueCents,
    grossCustomerRevenueCents,
    refundCents,
    disputeLossCents,
    disputeRefundOverlapCents,
    exchangeRevenueCents,
    netRevenueCents,
    taxCollectedCents,

    cogsCents,
    shippingCostCents,
    stripeFeeCents,

    ordersMissingCogs,
    ordersMissingShippingCost,
    ordersMissingStripeFee,
    ordersWithUnknownCosts,
    returnCogsCreditCents,
    cancellationCogsCreditCents,
    exchangeCogsCents,
    exchangeShippingCostCents,
    returnLabelCostCents,
    disputeFeeCents,
    affiliateCommissionCents,
    writeOffCostCents,

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

    canonicalOrderContributionCents,
    canonicalOperatingProfitCents,
    profitCompleteness: canonicalOperatingProfitCents === null ? 'incomplete' : 'complete',
    nonAuthoritativeOperatingProfitCents: realizedProfitAfterDevelopmentCents,
    profitBasis: 'cohort',

    contributionProfitCents,
    realizedOperatingProfitBeforeAdsCents,
    realizedOperatingProfitAfterAdsCents,
    realizedProfitAfterDevelopmentCents,

    contributionMarginPct:      pct(contributionProfitCents, netRevenueCents),
    realizedOperatingMarginPct: pct(realizedOperatingProfitAfterAdsCents, netRevenueCents),

    totalOperatingCostCents,
    // AOV uses gross customer revenue (merchandise + shipping, tax excluded)
    // because that is what the customer actually transacted before refunds.
    averageOrderValueCents: orderCount === 0
      ? null : Math.round(grossCustomerRevenueCents / orderCount),
    profitPerOrderCents: orderCount === 0
      ? null : Math.round(contributionProfitCents / orderCount),
    cogsPctOfRevenue:             pct(cogsCents, netRevenueCents),
    shippingCostPctOfRevenue:     pct(shippingCostCents, netRevenueCents),
    stripeFeePctOfRevenue:        pct(stripeFeeCents, netRevenueCents),
    advertisingPctOfRevenue:      pct(input.advertisingSpendCents, netRevenueCents),
    operatingExpensePctOfRevenue: pct(
      input.recognizedOperatingExpensesCents + input.recognizedDevelopmentExpensesCents,
      netRevenueCents),
    // Refunds measured against gross customer revenue (pre-refund), which is the
    // amount that was actually available to be refunded.
    refundRatePct:                pct(refundCents, grossCustomerRevenueCents),

    isPartial:
      ordersWithUnknownCosts > 0 || !!input.writeOffCostUnknown,
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

// ─────────────────────────────────────────────────────────────────────────────
// RECONCILIATION GATE
// ─────────────────────────────────────────────────────────────────────────────

export type IntegrityVerdict = 'RECONCILED' | 'INCOMPLETE' | 'EXCEPTION'

/**
 * Connect the P&L to reconciliation. The calculator proves only that no INPUT is null.
 * A figure is "exact" only if, in addition, the integrity state RELEVANT to the period
 * (financial_integrity_period_state: the order cohort paid in the window plus the
 * expenses, ad spend and write-offs actually included in it) is RECONCILED:
 *
 *   RECONCILED   canonical figures stand and may be shown as exact
 *   INCOMPLETE   canonical figures become null  -> "Unknown / not exact"
 *   EXCEPTION    canonical figures become null  -> "Invalid / Exception"
 *
 * The known-so-far numbers are kept for diagnosis but are never authoritative. Rows that
 * contradict each other are NOT repaired here by choosing a side.
 */
export function applyIntegrityGate(period: PeriodEconomics, verdict: IntegrityVerdict): PeriodEconomics {
  if (verdict === 'RECONCILED') return period
  return {
    ...period,
    canonicalOrderContributionCents: null,
    canonicalOperatingProfitCents: null,
    profitCompleteness: verdict === 'EXCEPTION' ? 'exception' : 'incomplete',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TAX SCENARIO — PLANNING ONLY
// ─────────────────────────────────────────────────────────────────────────────
//
// THIS IS NOT A TAX CALCULATION. It multiplies a period's pre-income-tax profit
// by a hypothetical rate the user types in, so the owner can sanity-check what
// they might want to set aside.
//
// It is a PURE FUNCTION BY DESIGN. It takes numbers and returns numbers. It has
// no database access, writes no expense_transaction, and cannot alter any
// financial record. Official KVRN profit stays pre-income-tax and tax-neutral:
// nothing here is ever subtracted from a reported profit figure.
//
// It does NOT determine actual tax liability. Real liability depends on entity
// type, jurisdiction, deductions, credits and carry-forwards that KVRN does not
// model. Treat the output as a planning estimate only.
//
// Sales tax is a completely separate concept and is never involved here — it is
// collected on behalf of an authority and is excluded from profit upstream.

export interface TaxScenarioInput {
  /** Pre-income-tax profit for the selected reporting period, in cents. */
  preTaxProfitCents: number
  /** Hypothetical rate the user entered, as a percentage (e.g. 25 for 25%). */
  hypotheticalRatePct: number
}

export interface TaxScenarioResult {
  preTaxProfitCents:     number
  hypotheticalRatePct:   number
  estimatedTaxCents:     number
  afterTaxProfitCents:   number
  /** True when profit is <= 0, so no tax is estimated on a loss. */
  isLoss:                boolean
  /** Always true. Callers must surface this; it is never an actual liability. */
  isHypothetical:        true
}

export const TAX_RATE_MIN_PCT = 0
export const TAX_RATE_MAX_PCT = 100

/** Clamp a user-entered rate to a sane range; non-numeric input becomes 0. */
export function normalizeTaxRatePct(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return 0
  return Math.min(TAX_RATE_MAX_PCT, Math.max(TAX_RATE_MIN_PCT, n))
}

/**
 * estimatedTax       = max(0, preTaxProfit) x rate
 * afterTaxProfit     = preTaxProfit - estimatedTax
 *
 * A loss produces zero estimated tax rather than a negative "refund", because
 * loss relief is jurisdiction-specific and KVRN does not model it.
 */
export function computeTaxScenario(input: TaxScenarioInput): TaxScenarioResult {
  const rate    = normalizeTaxRatePct(input.hypotheticalRatePct)
  const profit  = Math.round(input.preTaxProfitCents)
  const isLoss  = profit <= 0

  const estimatedTaxCents = isLoss ? 0 : Math.round(profit * (rate / 100))

  return {
    preTaxProfitCents:   profit,
    hypotheticalRatePct: rate,
    estimatedTaxCents,
    afterTaxProfitCents: profit - estimatedTaxCents,
    isLoss,
    isHypothetical:      true,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPENSE / AD-SPEND RECOGNITION PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────
//
// These are the CANONICAL recognition rules. Both the whole-period figures and
// the per-bucket chart figures call these same functions, so a cost can never be
// recognised one way on a card and a different way on a chart.
//
// They return UNROUNDED cents on purpose. Rounding at every bucket then summing
// drifts from rounding once over the whole period; callers therefore round the
// period total once and apportion it across buckets with largest-remainder,
// which is both timing-faithful and cent-exact.

const DAY_MS = 86400000

/** Parse a yyyy-mm-dd date as UTC midnight. NaN for anything malformed. */
function utcDay(d: string | null | undefined): number {
  if (!d) return NaN
  return Date.parse(String(d).slice(0, 10) + 'T00:00:00Z')
}

/**
 * Inclusive day-count overlap between two closed date ranges.
 * Returns 0 when they do not overlap.
 */
function overlapDaysInclusive(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart)
  const end   = Math.min(aEnd, bEnd)
  if (end < start) return 0
  return Math.floor((end - start) / DAY_MS) + 1
}

export interface ExpenseTxnRow {
  amountCents: number
  category:    string
  /** yyyy-mm-dd; the date money actually left. */
  paidAt:      string | null
  /** yyyy-mm-dd service period, when the charge covers a span. */
  periodStart: string | null
  periodEnd:   string | null
}

/**
 * RECOGNITION RULE (unchanged from the original period implementation):
 *
 *   No service period  -> recognised entirely on paid_at.
 *   Has service period -> apportioned across that period by overlapping days,
 *                         so a $40 annual renewal recognises ~1/12 into a month.
 *
 * Recognition follows the transaction's OWN dates. It is never influenced by how
 * much revenue a period happened to produce.
 */
export function recognizeExpenseRowsExact(
  rows: ExpenseTxnRow[],
  startDate: string,
  endDate: string,
): { operating: number; development: number } {
  const rs = utcDay(startDate)
  const re = utcDay(endDate)
  let operating = 0
  let development = 0
  if (Number.isNaN(rs) || Number.isNaN(re) || re < rs) return { operating, development }

  for (const r of rows) {
    if (!r.paidAt) continue                       // unsettled: not yet a cost
    const amount = Number(r.amountCents)
    if (!Number.isFinite(amount)) continue

    let share: number
    if (r.periodStart) {
      const ps = utcDay(r.periodStart)
      const pe = utcDay(r.periodEnd ?? r.periodStart)
      if (Number.isNaN(ps) || Number.isNaN(pe) || pe < ps) continue
      const spanDays    = Math.floor((pe - ps) / DAY_MS) + 1
      const overlapDays = overlapDaysInclusive(ps, pe, rs, re)
      if (overlapDays <= 0 || spanDays <= 0) continue
      share = amount * (overlapDays / spanDays)
    } else {
      const paid = utcDay(r.paidAt)
      if (Number.isNaN(paid) || paid < rs || paid > re) continue
      share = amount
    }

    if (r.category === 'development') development += share
    else                              operating   += share
  }
  return { operating, development }
}

export interface AdSpendRow {
  spendCents:  number
  periodStart: string
  periodEnd:   string
}

/**
 * Advertising is apportioned across its configured campaign period by overlapping
 * days, so a 30-day campaign viewed through a 7-day window contributes 7/30.
 * Driven by the campaign's own dates only.
 */
export function recognizeAdSpendRowsExact(
  rows: AdSpendRow[],
  startDate: string,
  endDate: string,
): number {
  const rs = utcDay(startDate)
  const re = utcDay(endDate)
  if (Number.isNaN(rs) || Number.isNaN(re) || re < rs) return 0

  let total = 0
  for (const r of rows) {
    const ps = utcDay(r.periodStart)
    const pe = utcDay(r.periodEnd)
    const spend = Number(r.spendCents)
    if (Number.isNaN(ps) || Number.isNaN(pe) || pe < ps || !Number.isFinite(spend)) continue
    const campaignDays = Math.floor((pe - ps) / DAY_MS) + 1
    const overlapDays  = overlapDaysInclusive(ps, pe, rs, re)
    if (overlapDays <= 0 || campaignDays <= 0) continue
    total += spend * (overlapDays / campaignDays)
  }
  return total
}
