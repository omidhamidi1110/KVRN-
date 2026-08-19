// lib/__tests__/financial-calculator.test.ts
// Behavioral tests for the shared financial calculation layer.
// These call the real exported functions with real numbers — no source inspection.

import {
  computeOrderEconomics,
  computePeriodEconomics,
  allocateDiscountToLines,
  sumOrUnknown,
  type OrderFinancialInputs,
} from '../financial-calculator'

// A fully-known baseline order: $80 merchandise, $8 shipping charged, $8 label cost.
function order(overrides: Partial<OrderFinancialInputs> = {}): OrderFinancialInputs {
  return {
    subtotalCents:                 8000,
    merchandiseDiscountCents:      0,
    shippingRevenueCents:          800,
    shippingQuotedCents:           800,
    shippingPromoDiscountCents:    0,
    shippingAutoFreeDiscountCents: 0,
    taxCents:                      0,
    cogsCents:                     3000,
    shippingCostCents:             800,
    stripeFeeCents:                285,
    refundCents:                   0,
    refundedFeeCents:              null,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHIPPING ECONOMICS — the five cases from the Phase B specification
// ─────────────────────────────────────────────────────────────────────────────

describe('shipping economics', () => {

  test('CASE 1 — customer pays shipping, exactly matching cost: margin 0, no subsidy', () => {
    const e = computeOrderEconomics(order({ shippingRevenueCents: 800, shippingCostCents: 800 }))
    expect(e.shippingRevenueCents).toBe(800)
    expect(e.shippingCostCents).toBe(800)
    expect(e.shippingMarginCents).toBe(0)
    expect(e.shippingSubsidyCents).toBe(0)
  })

  test('CASE 2 — KVRN undercharges: $8 charged vs $10 cost leaves a $2 subsidy', () => {
    const e = computeOrderEconomics(order({ shippingRevenueCents: 800, shippingCostCents: 1000 }))
    expect(e.shippingMarginCents).toBe(-200)
    expect(e.shippingSubsidyCents).toBe(200)
    // The $2 must land in profit, not be quietly ignored.
    // netRevenue 8800 - cogs 3000 - shipCost 1000 - fee 285 = 4515
    expect(e.contributionProfitCents).toBe(4515)
  })

  test('CASE 3 — customer overpays: $10 charged vs $8 cost yields +$2 margin', () => {
    const e = computeOrderEconomics(order({ shippingRevenueCents: 1000, shippingCostCents: 800 }))
    expect(e.shippingMarginCents).toBe(200)
    expect(e.shippingSubsidyCents).toBe(0)
  })

  test('CASE 4 — automatic free shipping: $0 revenue, real cost still charged to profit', () => {
    const e = computeOrderEconomics(order({
      subtotalCents: 16000,
      shippingRevenueCents: 0,
      shippingQuotedCents: 800,
      shippingAutoFreeDiscountCents: 800,
      shippingCostCents: 800,
    }))
    expect(e.shippingRevenueCents).toBe(0)
    expect(e.shippingCostCents).toBe(800)
    expect(e.shippingMarginCents).toBe(-800)
    expect(e.shippingSubsidyCents).toBe(800)
    expect(e.isAutoFreeShipping).toBe(true)
    // Free shipping is NOT free to the business.
    expect(e.freeShippingCostCents).toBe(800)
  })

  test('CASE 5 — manual shipping promo: before/discount/final stay distinct', () => {
    const e = computeOrderEconomics(order({
      shippingQuotedCents: 1000,
      shippingPromoDiscountCents: 400,
      shippingRevenueCents: 600,
      shippingCostCents: 800,
    }))
    expect(e.shippingRevenueCents).toBe(600)
    expect(e.shippingCostCents).toBe(800)
    expect(e.shippingMarginCents).toBe(-200)
    expect(e.shippingDiscountTotalCents).toBe(400)
    expect(e.isAutoFreeShipping).toBe(false)
  })

  test('unknown shipping cost yields unknown margin, never a fake zero', () => {
    const e = computeOrderEconomics(order({ shippingCostCents: null }))
    expect(e.shippingMarginCents).toBeNull()
    expect(e.shippingSubsidyCents).toBeNull()
    expect(e.contributionProfitCents).toBeNull()
  })

  test('shipping subsidy is not double-counted in profit', () => {
    // Subsidy is implicit in (revenue - cost); subtracting it again would over-charge.
    const e = computeOrderEconomics(order({ shippingRevenueCents: 0, shippingCostCents: 800 }))
    // netRevenue = 8000 + 0 = 8000; costs = 3000 + 800 + 285
    expect(e.netRevenueCents).toBe(8000)
    expect(e.contributionProfitCents).toBe(8000 - 3000 - 800 - 285)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REVENUE AND PROFIT
// ─────────────────────────────────────────────────────────────────────────────

describe('revenue and profit formulas', () => {

  test('merchandise revenue subtracts the discount exactly once', () => {
    const e = computeOrderEconomics(order({ subtotalCents: 8000, merchandiseDiscountCents: 1000 }))
    expect(e.grossMerchandiseCents).toBe(8000)
    expect(e.merchandiseDiscountCents).toBe(1000)
    expect(e.merchandiseRevenueCents).toBe(7000)
    expect(e.grossCustomerRevenueCents).toBe(7800)
  })

  test('customer-paid shipping is not treated as pure profit', () => {
    const withShipping = computeOrderEconomics(order({ shippingRevenueCents: 800, shippingCostCents: 800 }))
    const noShipping   = computeOrderEconomics(order({ shippingRevenueCents: 0,   shippingCostCents: 0 }))
    // Charging $8 that costs $8 must not change profit at all.
    expect(withShipping.contributionProfitCents).toBe(noShipping.contributionProfitCents)
  })

  test('tax is excluded from revenue and profit but still reported', () => {
    const e = computeOrderEconomics(order({ taxCents: 640 }))
    expect(e.taxCollectedCents).toBe(640)
    expect(e.grossCustomerRevenueCents).toBe(8800)   // unchanged by tax
    expect(e.contributionProfitCents).toBe(8800 - 3000 - 800 - 285)
  })

  test('refunds reduce net revenue without erasing the original sale', () => {
    const e = computeOrderEconomics(order({ refundCents: 2000 }))
    expect(e.grossMerchandiseCents).toBe(8000)       // original sale intact
    expect(e.grossCustomerRevenueCents).toBe(8800)
    expect(e.netRevenueCents).toBe(6800)
    expect(e.contributionProfitCents).toBe(6800 - 3000 - 800 - 285)
  })

  test('a returned Stripe fee reduces the net fee charged to profit', () => {
    const e = computeOrderEconomics(order({ refundCents: 8800, refundedFeeCents: 285 }))
    expect(e.netStripeFeeCents).toBe(0)
    expect(e.netRevenueCents).toBe(0)
  })

  test('unknown refunded fee does not fabricate a fee return', () => {
    const e = computeOrderEconomics(order({ refundCents: 1000, refundedFeeCents: null }))
    // Full fee still counted — we must not assume Stripe gave any of it back.
    expect(e.netStripeFeeCents).toBe(285)
  })

  test('contribution margin percentage is computed from net revenue', () => {
    const e = computeOrderEconomics(order())
    expect(e.contributionProfitCents).toBe(4715)
    expect(e.contributionMarginPct).toBeCloseTo(53.58, 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UNKNOWN vs ZERO
// ─────────────────────────────────────────────────────────────────────────────

describe('unknown costs are never treated as zero', () => {

  test('missing COGS makes profit unknown, not inflated', () => {
    const e = computeOrderEconomics(order({ cogsCents: null }))
    expect(e.contributionProfitCents).toBeNull()
    expect(e.contributionMarginPct).toBeNull()
    expect(e.reconciliation.state).toBe('partial')
    expect(e.reconciliation.missing.map(m => m.field)).toContain('cogs')
  })

  test('missing Stripe fee makes profit unknown', () => {
    const e = computeOrderEconomics(order({ stripeFeeCents: null }))
    expect(e.contributionProfitCents).toBeNull()
    expect(e.reconciliation.missing.map(m => m.field)).toContain('stripe_fee')
  })

  test('all three costs missing reports state "unknown"', () => {
    const e = computeOrderEconomics(order({
      cogsCents: null, shippingCostCents: null, stripeFeeCents: null,
    }))
    expect(e.reconciliation.state).toBe('unknown')
    expect(e.reconciliation.missing).toHaveLength(3)
  })

  test('all costs known reports state "complete"', () => {
    const e = computeOrderEconomics(order())
    expect(e.reconciliation.state).toBe('complete')
    expect(e.reconciliation.missing).toHaveLength(0)
  })

  test('a genuine zero cost is distinct from an unknown cost', () => {
    const zero    = computeOrderEconomics(order({ shippingCostCents: 0 }))
    const unknown = computeOrderEconomics(order({ shippingCostCents: null }))
    expect(zero.shippingMarginCents).toBe(800)       // known: revenue 800, cost 0
    expect(unknown.shippingMarginCents).toBeNull()   // unknown: cannot say
    expect(zero.reconciliation.state).toBe('complete')
    expect(unknown.reconciliation.state).toBe('partial')
  })

  test('sumOrUnknown returns null when any input is unknown', () => {
    expect(sumOrUnknown(100, 200, 300)).toBe(600)
    expect(sumOrUnknown(100, null, 300)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DISCOUNT ALLOCATION
// ─────────────────────────────────────────────────────────────────────────────

describe('discount allocation across order lines', () => {

  test('allocations sum exactly to the order discount', () => {
    const lines = [
      { id: 'a', lineTotalCents: 8000 },
      { id: 'b', lineTotalCents: 6500 },
      { id: 'c', lineTotalCents: 3300 },
    ]
    const out = allocateDiscountToLines(lines, 1000)
    expect(out.reduce((s, l) => s + l.allocatedDiscountCents, 0)).toBe(1000)
  })

  test('cent-exact with awkward remainders across many lines', () => {
    // 3 equal lines and a discount not divisible by 3 — the classic rounding trap.
    const lines = [
      { id: 'a', lineTotalCents: 1000 },
      { id: 'b', lineTotalCents: 1000 },
      { id: 'c', lineTotalCents: 1000 },
    ]
    const out = allocateDiscountToLines(lines, 100)
    expect(out.reduce((s, l) => s + l.allocatedDiscountCents, 0)).toBe(100)
  })

  test('exhaustive: sums exactly for every discount from 1 to 500 cents', () => {
    const lines = [
      { id: 'a', lineTotalCents: 7999 },
      { id: 'b', lineTotalCents: 3301 },
      { id: 'c', lineTotalCents: 1237 },
      { id: 'd', lineTotalCents: 4444 },
    ]
    for (let d = 1; d <= 500; d++) {
      const out = allocateDiscountToLines(lines, d)
      const total = out.reduce((s, l) => s + l.allocatedDiscountCents, 0)
      expect(total).toBe(d)
    }
  })

  test('allocation is weighted by line total', () => {
    const out = allocateDiscountToLines(
      [{ id: 'big', lineTotalCents: 9000 }, { id: 'small', lineTotalCents: 1000 }],
      1000,
    )
    const big   = out.find(l => l.id === 'big')!
    const small = out.find(l => l.id === 'small')!
    expect(big.allocatedDiscountCents).toBe(900)
    expect(small.allocatedDiscountCents).toBe(100)
  })

  test('deterministic: identical input always produces identical output', () => {
    const lines = [
      { id: 'a', lineTotalCents: 1000 },
      { id: 'b', lineTotalCents: 1000 },
      { id: 'c', lineTotalCents: 1000 },
    ]
    const first = allocateDiscountToLines(lines, 101)
    for (let i = 0; i < 20; i++) {
      expect(allocateDiscountToLines(lines, 101)).toEqual(first)
    }
  })

  test('zero discount allocates zero to every line', () => {
    const out = allocateDiscountToLines(
      [{ id: 'a', lineTotalCents: 5000 }, { id: 'b', lineTotalCents: 5000 }], 0)
    expect(out.every(l => l.allocatedDiscountCents === 0)).toBe(true)
  })

  test('discount is capped at the merchandise total', () => {
    const out = allocateDiscountToLines([{ id: 'a', lineTotalCents: 500 }], 1000)
    expect(out[0].allocatedDiscountCents).toBe(500)
  })

  test('empty line list returns an empty allocation', () => {
    expect(allocateDiscountToLines([], 1000)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PERIOD AGGREGATION
// ─────────────────────────────────────────────────────────────────────────────

describe('period economics', () => {

  test('aggregates revenue and costs across orders', () => {
    const p = computePeriodEconomics({
      orders: [
        computeOrderEconomics(order()),
        computeOrderEconomics(order()),
      ],
      recognizedOperatingExpensesCents: 5000,
      recognizedDevelopmentExpensesCents: 2000,
      advertisingSpendCents:        10000,
      estimatedAccruedOperatingExpensesCents: 9999,
      projectedOperatingExpensesCents:        12345,
    })
    expect(p.orderCount).toBe(2)
    expect(p.grossMerchandiseCents).toBe(16000)
    expect(p.netRevenueCents).toBe(17600)
    expect(p.cogsCents).toBe(6000)
    expect(p.contributionProfitCents).toBe(17600 - 6000 - 1600 - 570)
    expect(p.realizedOperatingProfitBeforeAdsCents).toBe(p.contributionProfitCents - 5000)
    expect(p.realizedOperatingProfitAfterAdsCents).toBe(p.contributionProfitCents - 5000 - 10000)
    expect(p.realizedProfitAfterDevelopmentCents)
      .toBe(p.contributionProfitCents - 5000 - 10000 - 2000)
  })

  test('partial data is flagged and counted, not silently zeroed', () => {
    const p = computePeriodEconomics({
      orders: [
        computeOrderEconomics(order()),
        computeOrderEconomics(order({ cogsCents: null })),
        computeOrderEconomics(order({ stripeFeeCents: null })),
      ],
      recognizedOperatingExpensesCents: 0, recognizedDevelopmentExpensesCents: 0,
      advertisingSpendCents: 0,
      estimatedAccruedOperatingExpensesCents: 0, projectedOperatingExpensesCents: 0,
    })
    expect(p.isPartial).toBe(true)
    expect(p.ordersMissingCogs).toBe(1)
    expect(p.ordersMissingStripeFee).toBe(1)
    // Only the two known COGS values are summed.
    expect(p.cogsCents).toBe(6000)
  })

  test('complete data is not flagged as partial', () => {
    const p = computePeriodEconomics({
      orders: [computeOrderEconomics(order())],
      recognizedOperatingExpensesCents: 0, recognizedDevelopmentExpensesCents: 0,
      advertisingSpendCents: 0,
      estimatedAccruedOperatingExpensesCents: 0, projectedOperatingExpensesCents: 0,
    })
    expect(p.isPartial).toBe(false)
  })

  test('free-shipping orders are counted with their real cost', () => {
    const p = computePeriodEconomics({
      orders: [
        computeOrderEconomics(order({
          shippingRevenueCents: 0, shippingAutoFreeDiscountCents: 800, shippingCostCents: 800,
        })),
        computeOrderEconomics(order()),
      ],
      recognizedOperatingExpensesCents: 0, recognizedDevelopmentExpensesCents: 0,
      advertisingSpendCents: 0,
      estimatedAccruedOperatingExpensesCents: 0, projectedOperatingExpensesCents: 0,
    })
    expect(p.freeShippingOrders).toBe(1)
    expect(p.freeShippingCostCents).toBe(800)
    expect(p.ordersShippingUnderwater).toBe(1)
  })

  test('empty period produces zeros, not NaN', () => {
    const p = computePeriodEconomics({
      orders: [],
      recognizedOperatingExpensesCents: 0, recognizedDevelopmentExpensesCents: 0,
      advertisingSpendCents: 0,
      estimatedAccruedOperatingExpensesCents: 0, projectedOperatingExpensesCents: 0,
    })
    expect(p.orderCount).toBe(0)
    expect(p.netRevenueCents).toBe(0)
    expect(p.contributionProfitCents).toBe(0)
    expect(p.contributionMarginPct).toBeNull()
    expect(p.isPartial).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ACTUAL vs ESTIMATED vs PROJECTED — the three cost states must never merge
// ─────────────────────────────────────────────────────────────────────────────

describe('realised profit uses RECOGNIZED expense from real transactions only', () => {

  function period(over: Partial<Parameters<typeof computePeriodEconomics>[0]> = {}) {
    return computePeriodEconomics({
      orders: [computeOrderEconomics(order())],
      recognizedOperatingExpensesCents: 0,
      recognizedDevelopmentExpensesCents: 0,
      advertisingSpendCents:        0,
      estimatedAccruedOperatingExpensesCents: 0,
      projectedOperatingExpensesCents:        0,
      ...over,
    })
  }

  test('an estimated accrual does NOT reduce realised operating profit', () => {
    const withoutForecast = period()
    const withForecast    = period({ estimatedAccruedOperatingExpensesCents: 50000 })
    // A $500 usage forecast is not a bill; profit must be identical.
    expect(withForecast.realizedOperatingProfitAfterAdsCents)
      .toBe(withoutForecast.realizedOperatingProfitAfterAdsCents)
    // But it is still reported for visibility.
    expect(withForecast.estimatedAccruedOperatingExpensesCents).toBe(50000)
  })

  test('a projected month-end figure does NOT reduce realised operating profit', () => {
    const base      = period()
    const projected = period({ projectedOperatingExpensesCents: 75000 })
    expect(projected.realizedOperatingProfitAfterAdsCents)
      .toBe(base.realizedOperatingProfitAfterAdsCents)
    expect(projected.projectedOperatingExpensesCents).toBe(75000)
  })

  test('a RECOGNIZED transaction amount DOES reduce realised operating profit', () => {
    const base   = period()
    const billed = period({ recognizedOperatingExpensesCents: 1900 })
    expect(billed.realizedOperatingProfitBeforeAdsCents)
      .toBe(base.realizedOperatingProfitBeforeAdsCents - 1900)
  })

  test('estimate and projection are reported separately from each other', () => {
    const p = period({
      estimatedAccruedOperatingExpensesCents: 1200,
      projectedOperatingExpensesCents:        3400,
    })
    expect(p.estimatedAccruedOperatingExpensesCents).toBe(1200)
    expect(p.projectedOperatingExpensesCents).toBe(3400)
    // Never summed into one another or into the actual figure.
    expect(p.recognizedOperatingExpensesCents).toBe(0)
  })

  test('development spend is separated from production operating cost', () => {
    const p = period({ recognizedOperatingExpensesCents: 5000, recognizedDevelopmentExpensesCents: 2000 })
    // Operating profit reflects production overhead only.
    expect(p.realizedOperatingProfitBeforeAdsCents).toBe(p.contributionProfitCents - 5000)
    // Development is applied only in the final line.
    expect(p.realizedProfitAfterDevelopmentCents)
      .toBe(p.realizedOperatingProfitAfterAdsCents - 2000)
    expect(p.recognizedDevelopmentExpensesCents).toBe(2000)
  })

  test('development spend remains visible in overall business cost', () => {
    const p = period({ recognizedDevelopmentExpensesCents: 2000 })
    expect(p.recognizedDevelopmentExpensesCents).toBe(2000)
    expect(p.realizedProfitAfterDevelopmentCents)
      .toBeLessThan(p.realizedOperatingProfitAfterAdsCents)
  })

  test('advertising is subtracted after operating expenses, not before', () => {
    const p = period({ recognizedOperatingExpensesCents: 1000, advertisingSpendCents: 4000 })
    expect(p.realizedOperatingProfitBeforeAdsCents).toBe(p.contributionProfitCents - 1000)
    expect(p.realizedOperatingProfitAfterAdsCents)
      .toBe(p.realizedOperatingProfitBeforeAdsCents - 4000)
  })

  test('order contribution profit is unaffected by any period-level expense', () => {
    // Overhead belongs to the period, never to an individual order.
    const e = computeOrderEconomics(order())
    const p = period({ recognizedOperatingExpensesCents: 99999, advertisingSpendCents: 99999 })
    expect(p.contributionProfitCents).toBe(e.contributionProfitCents)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PACKAGING IN LANDED COGS
// ─────────────────────────────────────────────────────────────────────────────

describe('packaging is part of landed COGS', () => {

  test('packaging increases COGS and reduces contribution profit', () => {
    const withoutPackaging = computeOrderEconomics(order({ cogsCents: 3000 }))
    const withPackaging    = computeOrderEconomics(order({ cogsCents: 3000 + 150 }))
    expect(withPackaging.cogsCents).toBe(3150)
    expect(withPackaging.contributionProfitCents)
      .toBe(withoutPackaging.contributionProfitCents! - 150)
  })

  test('multi-quantity packaging scales with line quantity', () => {
    // 3 units at $1.50 packaging each = $4.50 of the line COGS
    const unitCogs = 3000
    const packagingPerUnit = 150
    const qty = 3
    const lineCogs = (unitCogs + packagingPerUnit) * qty
    const e = computeOrderEconomics(order({ subtotalCents: 24000, cogsCents: lineCogs }))
    expect(e.cogsCents).toBe(9450)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DISCOUNT ALLOCATION — cent-exact reconciliation for product profitability
// ─────────────────────────────────────────────────────────────────────────────

describe('product discount allocation reconciles exactly', () => {

  test('$1 discount across 3 equal lines sums to exactly 100 cents', () => {
    // The classic case a per-line ROUND() gets wrong: 33.33 x 3 = 99 or 102.
    const lines = [
      { id: 'l1', lineTotalCents: 5000 },
      { id: 'l2', lineTotalCents: 5000 },
      { id: 'l3', lineTotalCents: 5000 },
    ]
    const out = allocateDiscountToLines(lines, 100)
    expect(out.reduce((s, l) => s + l.allocatedDiscountCents, 0)).toBe(100)
    // Exactly one line absorbs the extra cent; none is skipped.
    const amounts = out.map(l => l.allocatedDiscountCents).sort()
    expect(amounts).toEqual([33, 33, 34])
  })

  test('tied fractional shares still reconcile and are deterministic', () => {
    const lines = [
      { id: 'a', lineTotalCents: 1000 },
      { id: 'b', lineTotalCents: 1000 },
      { id: 'c', lineTotalCents: 1000 },
      { id: 'd', lineTotalCents: 1000 },
    ]
    const first = allocateDiscountToLines(lines, 999)
    expect(first.reduce((s, l) => s + l.allocatedDiscountCents, 0)).toBe(999)
    for (let i = 0; i < 10; i++) {
      expect(allocateDiscountToLines(lines, 999)).toEqual(first)
    }
  })

  test('quantity greater than one does not break reconciliation', () => {
    // Line totals already embed quantity; allocation weights on the line total.
    const lines = [
      { id: 'qty3', lineTotalCents: 24000 },  // 3 x $80
      { id: 'qty1', lineTotalCents: 8000 },   // 1 x $80
    ]
    const out = allocateDiscountToLines(lines, 1000)
    expect(out.reduce((s, l) => s + l.allocatedDiscountCents, 0)).toBe(1000)
    expect(out.find(l => l.id === 'qty3')!.allocatedDiscountCents).toBe(750)
    expect(out.find(l => l.id === 'qty1')!.allocatedDiscountCents).toBe(250)
  })

  test('multiple orders each reconcile independently and in aggregate', () => {
    const orders = [
      { discount: 1000, lines: [
        { id: 'o1l1', lineTotalCents: 8000 }, { id: 'o1l2', lineTotalCents: 4000 }] },
      { discount: 333,  lines: [
        { id: 'o2l1', lineTotalCents: 1000 }, { id: 'o2l2', lineTotalCents: 1000 },
        { id: 'o2l3', lineTotalCents: 1000 }] },
      { discount: 1,    lines: [
        { id: 'o3l1', lineTotalCents: 5000 }, { id: 'o3l2', lineTotalCents: 5000 }] },
    ]

    let grandTotal = 0
    for (const o of orders) {
      const out = allocateDiscountToLines(o.lines, o.discount)
      const sum = out.reduce((s, l) => s + l.allocatedDiscountCents, 0)
      // Each order reconciles on its own...
      expect(sum).toBe(o.discount)
      grandTotal += sum
    }
    // ...and therefore the period aggregate reconciles too.
    expect(grandTotal).toBe(orders.reduce((s, o) => s + o.discount, 0))
  })

  test('exhaustive reconciliation across uneven lines and many discounts', () => {
    const lines = [
      { id: 'a', lineTotalCents: 3333 },
      { id: 'b', lineTotalCents: 6667 },
      { id: 'c', lineTotalCents: 1 },
    ]
    for (let d = 1; d <= 300; d++) {
      const sum = allocateDiscountToLines(lines, d)
        .reduce((s, l) => s + l.allocatedDiscountCents, 0)
      expect(sum).toBe(d)
    }
  })

  test('no line ever receives a negative allocation', () => {
    const lines = [
      { id: 'a', lineTotalCents: 100 },
      { id: 'b', lineTotalCents: 9900 },
    ]
    for (const d of [1, 7, 99, 500, 9999]) {
      for (const l of allocateDiscountToLines(lines, d)) {
        expect(l.allocatedDiscountCents).toBeGreaterThanOrEqual(0)
      }
    }
  })
})
