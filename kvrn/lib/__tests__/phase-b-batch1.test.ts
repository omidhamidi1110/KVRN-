// lib/__tests__/phase-b-batch1.test.ts
// Batch 1: navigation active state, derived metrics, Tax Scenario isolation,
// and a re-audit of the financial invariants the batch touched.

import {
  computeOrderEconomics,
  computePeriodEconomics,
  computeTaxScenario,
  normalizeTaxRatePct,
  type OrderFinancialInputs,
} from '../financial-calculator'
import { PROVIDER_PORTALS, portalForProvider } from '../provider-portals'

const fs   = require('fs')
const path = require('path')

function order(overrides: Partial<OrderFinancialInputs> = {}): OrderFinancialInputs {
  return {
    subtotalCents: 8000, merchandiseDiscountCents: 0,
    shippingRevenueCents: 800, shippingQuotedCents: 800,
    shippingPromoDiscountCents: 0, shippingAutoFreeDiscountCents: 0,
    taxCents: 0, cogsCents: 3000, shippingCostCents: 800,
    stripeFeeCents: 285, refundCents: 0, refundedFeeCents: null,
    ...overrides,
  }
}

function period(over: Partial<Parameters<typeof computePeriodEconomics>[0]> = {}) {
  return computePeriodEconomics({
    orders: [computeOrderEconomics(order())],
    recognizedOperatingExpensesCents: 0,
    recognizedDevelopmentExpensesCents: 0,
    advertisingSpendCents: 0,
    estimatedAccruedOperatingExpensesCents: 0,
    projectedOperatingExpensesCents: 0,
    ...over,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. NAVIGATION ACTIVE STATE
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors resolveActiveHref in components/admin/AdminShell.tsx. A source test
// below asserts the component still uses this most-specific-match strategy.
function resolveActiveHref(pathname: string, hrefs: string[]): string | null {
  let best: string | null = null
  for (const href of hrefs) {
    const matches = href === '/admin'
      ? pathname === '/admin'
      : pathname === href || pathname.startsWith(`${href}/`)
    if (!matches) continue
    if (best === null || href.length > best.length) best = href
  }
  return best
}

const NAV_HREFS = [
  '/admin', '/admin/orders', '/admin/inventory', '/admin/discounts',
  '/admin/financials', '/admin/financials/shipping', '/admin/financials/costs',
  '/admin/financials/advertising', '/admin/financials/infrastructure',
  '/admin/financials/expenses', '/admin/sms',
]

describe('admin navigation active state', () => {

  test.each([
    ['/admin',                          '/admin'],
    ['/admin/financials',               '/admin/financials'],
    ['/admin/financials/costs',         '/admin/financials/costs'],
    ['/admin/financials/shipping',      '/admin/financials/shipping'],
    ['/admin/financials/expenses',      '/admin/financials/expenses'],
    ['/admin/financials/infrastructure','/admin/financials/infrastructure'],
    ['/admin/financials/advertising',   '/admin/financials/advertising'],
    ['/admin/orders',                   '/admin/orders'],
    ['/admin/sms',                      '/admin/sms'],
  ])('%s highlights exactly %s', (pathname, expected) => {
    expect(resolveActiveHref(pathname, NAV_HREFS)).toBe(expected)
  })

  test('a financials subsection does NOT also highlight Overview', () => {
    // This was the reported bug: /admin/financials is a prefix of every
    // subsection, so a plain startsWith test lit up two items at once.
    for (const sub of ['costs', 'shipping', 'expenses', 'infrastructure', 'advertising']) {
      const active = resolveActiveHref(`/admin/financials/${sub}`, NAV_HREFS)
      expect(active).toBe(`/admin/financials/${sub}`)
      expect(active).not.toBe('/admin/financials')
    }
  })

  test('exactly one nav item is ever active', () => {
    for (const pathname of [...NAV_HREFS, '/admin/orders/abc-123', '/admin/financials/costs']) {
      const active = resolveActiveHref(pathname, NAV_HREFS)
      expect(NAV_HREFS.filter(h => h === active)).toHaveLength(1)
    }
  })

  test('an order detail page keeps Orders highlighted', () => {
    // Guards against "fixing" the bug by switching to exact-match-only.
    expect(resolveActiveHref('/admin/orders/9f2c-abcd-1234', NAV_HREFS)).toBe('/admin/orders')
  })

  test('/admin does not highlight while on a deeper admin route', () => {
    expect(resolveActiveHref('/admin/inventory', NAV_HREFS)).toBe('/admin/inventory')
  })

  test('an unknown route highlights nothing rather than defaulting to Overview', () => {
    expect(resolveActiveHref('/admin/nonexistent', NAV_HREFS)).toBeNull()
  })

  test('AdminShell uses most-specific-match and no longer calls isActive', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../components/admin/AdminShell.tsx'), 'utf8')
    expect(src).toContain('function resolveActiveHref')
    expect(src).toContain('href.length > best.length')
    expect(src).not.toContain('isActive(')
    // Both desktop and mobile compare against the single resolved href.
    expect((src.match(/item\.href === activeHref/g) ?? []).length).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. TAX SCENARIO — PLANNING ONLY, FULLY ISOLATED
// ─────────────────────────────────────────────────────────────────────────────

describe('tax scenario calculator', () => {

  test('estimated tax = pre-tax profit x rate', () => {
    const r = computeTaxScenario({ preTaxProfitCents: 1_000_000, hypotheticalRatePct: 25 })
    expect(r.estimatedTaxCents).toBe(250_000)
    expect(r.afterTaxProfitCents).toBe(750_000)
  })

  test('a custom non-preset rate is accepted', () => {
    const r = computeTaxScenario({ preTaxProfitCents: 100_000, hypotheticalRatePct: 17.5 })
    expect(r.estimatedTaxCents).toBe(17_500)
  })

  test('a loss produces zero estimated tax, never a negative refund', () => {
    const r = computeTaxScenario({ preTaxProfitCents: -50_000, hypotheticalRatePct: 30 })
    expect(r.isLoss).toBe(true)
    expect(r.estimatedTaxCents).toBe(0)
    expect(r.afterTaxProfitCents).toBe(-50_000)
  })

  test('rates are clamped to 0-100 and junk input becomes 0', () => {
    expect(normalizeTaxRatePct(150)).toBe(100)
    expect(normalizeTaxRatePct(-20)).toBe(0)
    expect(normalizeTaxRatePct('abc')).toBe(0)
    expect(normalizeTaxRatePct(undefined)).toBe(0)
    expect(normalizeTaxRatePct(22.5)).toBe(22.5)
  })

  test('the result is always flagged hypothetical', () => {
    expect(computeTaxScenario({ preTaxProfitCents: 1, hypotheticalRatePct: 1 }).isHypothetical)
      .toBe(true)
  })

  test('it follows the selected period profit', () => {
    // Different period profit -> different scenario, same rate.
    const small = computeTaxScenario({ preTaxProfitCents: 100_000, hypotheticalRatePct: 25 })
    const large = computeTaxScenario({ preTaxProfitCents: 900_000, hypotheticalRatePct: 25 })
    expect(small.estimatedTaxCents).toBe(25_000)
    expect(large.estimatedTaxCents).toBe(225_000)
  })

  test('it is a pure function — no DB, no writes, no side effects', () => {
    const src = fs.readFileSync(path.join(__dirname, '../financial-calculator.ts'), 'utf8')
    const fn = src.slice(src.indexOf('export function computeTaxScenario'))
    expect(fn).not.toContain('sql')
    expect(fn).not.toContain('INSERT')
    expect(fn).not.toContain('fetch(')
    // Calling it repeatedly yields identical output.
    const a = computeTaxScenario({ preTaxProfitCents: 500_000, hypotheticalRatePct: 30 })
    const b = computeTaxScenario({ preTaxProfitCents: 500_000, hypotheticalRatePct: 30 })
    expect(a).toEqual(b)
  })

  test('the scenario never alters official period profit', () => {
    const p = period({ recognizedOperatingExpensesCents: 1000 })
    const before = p.realizedOperatingProfitAfterAdsCents
    computeTaxScenario({ preTaxProfitCents: before, hypotheticalRatePct: 37 })
    expect(p.realizedOperatingProfitAfterAdsCents).toBe(before)
  })

  test('no income-tax field leaks into PeriodEconomics', () => {
    // Official profit must stay pre-income-tax / tax-neutral.
    const p = period()
    expect(Object.keys(p).some(k => /incomeTax|afterTax|estimatedTax/i.test(k))).toBe(false)
  })

  test('the calculator never writes an expense for hypothetical tax', () => {
    // Strip comments: prose explaining the boundary must not mask real code.
    const src = fs.readFileSync(path.join(__dirname, '../financial-calculator.ts'), 'utf8')
      .split('\n').filter((l: string) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect(src).not.toContain('expense_transactions')
    expect(src).not.toContain('INSERT')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. DERIVED METRICS
// ─────────────────────────────────────────────────────────────────────────────

describe('derived operating metrics', () => {

  test('average order value uses gross customer revenue excluding tax', () => {
    const p = computePeriodEconomics({
      orders: [
        computeOrderEconomics(order({ taxCents: 640 })),
        computeOrderEconomics(order({ taxCents: 640 })),
      ],
      recognizedOperatingExpensesCents: 0, recognizedDevelopmentExpensesCents: 0,
      advertisingSpendCents: 0,
      estimatedAccruedOperatingExpensesCents: 0, projectedOperatingExpensesCents: 0,
    })
    // 8000 merchandise + 800 shipping = 8800 per order; tax excluded entirely.
    expect(p.averageOrderValueCents).toBe(8800)
    expect(p.taxCollectedCents).toBe(1280)
  })

  test('profit per order equals contribution divided by order count', () => {
    const p = period({ orders: [computeOrderEconomics(order()), computeOrderEconomics(order())] } as any)
    expect(p.profitPerOrderCents).toBe(Math.round(p.contributionProfitCents / 2))
  })

  test('total operating cost matches the profit chain exactly', () => {
    const p = period({
      recognizedOperatingExpensesCents: 5000,
      recognizedDevelopmentExpensesCents: 2000,
      advertisingSpendCents: 10000,
    })
    // netRevenue - totalOperatingCost must equal profit after ads and development.
    expect(p.netRevenueCents - p.totalOperatingCostCents)
      .toBe(p.realizedProfitAfterDevelopmentCents)
  })

  test('percentages share net revenue as one denominator', () => {
    const p = period()
    expect(p.cogsPctOfRevenue).toBeCloseTo((p.cogsCents / p.netRevenueCents) * 100, 2)
    expect(p.stripeFeePctOfRevenue).toBeCloseTo((p.stripeFeeCents / p.netRevenueCents) * 100, 2)
  })

  test('refund rate is measured against gross customer revenue', () => {
    const p = period({ orders: [computeOrderEconomics(order({ refundCents: 880 }))] } as any)
    expect(p.refundRatePct).toBeCloseTo((880 / 8800) * 100, 2)
  })

  test('metrics are null, not zero, when there is no data', () => {
    const empty = period({ orders: [] } as any)
    expect(empty.averageOrderValueCents).toBeNull()
    expect(empty.profitPerOrderCents).toBeNull()
    expect(empty.cogsPctOfRevenue).toBeNull()
    expect(empty.refundRatePct).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. AUDIT RE-VERIFICATION — invariants Batch 1 must not have broken
// ─────────────────────────────────────────────────────────────────────────────

describe('financial audit invariants still hold', () => {

  test('sales tax is excluded from revenue and profit', () => {
    const withTax    = computeOrderEconomics(order({ taxCents: 999 }))
    const withoutTax = computeOrderEconomics(order({ taxCents: 0 }))
    expect(withTax.grossCustomerRevenueCents).toBe(withoutTax.grossCustomerRevenueCents)
    expect(withTax.contributionProfitCents).toBe(withoutTax.contributionProfitCents)
    expect(withTax.taxCollectedCents).toBe(999)   // reported separately
  })

  test('the Stripe fee is subtracted exactly once', () => {
    const e = computeOrderEconomics(order({ stripeFeeCents: 285 }))
    expect(e.contributionProfitCents).toBe(8800 - 3000 - 800 - 285)
  })

  test('customer-paid shipping is not profit when it equals the label cost', () => {
    const a = computeOrderEconomics(order({ shippingRevenueCents: 800, shippingCostCents: 800 }))
    const b = computeOrderEconomics(order({ shippingRevenueCents: 0,   shippingCostCents: 0 }))
    expect(a.contributionProfitCents).toBe(b.contributionProfitCents)
  })

  test('customer pays $10, label costs $8 -> +$2 margin, counted once', () => {
    const e = computeOrderEconomics(order({ shippingRevenueCents: 1000, shippingCostCents: 800 }))
    expect(e.shippingMarginCents).toBe(200)
    expect(e.contributionProfitCents).toBe(8000 + 1000 - 3000 - 800 - 285)
  })

  test('automatic free shipping shows the absorbed carrier cost', () => {
    const e = computeOrderEconomics(order({
      subtotalCents: 16000, shippingRevenueCents: 0,
      shippingAutoFreeDiscountCents: 800, shippingCostCents: 800,
    }))
    expect(e.isAutoFreeShipping).toBe(true)
    expect(e.freeShippingCostCents).toBe(800)
    expect(e.shippingSubsidyCents).toBe(800)
  })

  test('the shipping subsidy is not deducted a second time', () => {
    const e = computeOrderEconomics(order({ shippingRevenueCents: 0, shippingCostCents: 800 }))
    // Subsidy is already implicit in (revenue - cost); deducting it again would
    // understate profit by another 800.
    expect(e.contributionProfitCents).toBe(8000 - 3000 - 800 - 285)
  })

  test('refunds reduce net revenue without erasing the sale', () => {
    const e = computeOrderEconomics(order({ refundCents: 2000 }))
    expect(e.grossMerchandiseCents).toBe(8000)
    expect(e.netRevenueCents).toBe(6800)
  })

  test('an unknown cost still blocks a confident profit number', () => {
    expect(computeOrderEconomics(order({ cogsCents: null })).contributionProfitCents).toBeNull()
    expect(computeOrderEconomics(order({ stripeFeeCents: null })).contributionProfitCents).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. MANUAL WORKFLOWS AND PORTALS
// ─────────────────────────────────────────────────────────────────────────────

describe('manual cost-entry workflows are reachable from the UI', () => {

  test('the shipping page can record an actual label cost', () => {
    const ui = fs.readFileSync(
      path.join(__dirname, '../../app/admin/financials/shipping/ShippingClient.tsx'), 'utf8')
    expect(ui).toContain('saveLabelCost')
    expect(ui).toContain('/api/admin/shipments/')
    expect(ui).toContain('labelCostCents')
    // Entered manually, so provenance must say so.
    expect(ui).toContain("costSource: 'manual'")
  })

  test('the shipping API surfaces the uncosted worklist', () => {
    const api = fs.readFileSync(
      path.join(__dirname, '../../app/api/admin/financials/shipping/route.ts'), 'utf8')
    expect(api).toContain('label_cost_cents IS NULL')
    expect(api).toContain('pendingCost')
  })

  test('the infrastructure page can record a usage reading', () => {
    const ui = fs.readFileSync(
      path.join(__dirname, '../../app/admin/financials/infrastructure/InfrastructureClient.tsx'), 'utf8')
    expect(ui).toContain('saveUsage')
    expect(ui).toContain('/api/admin/provider-usage')
    // Manual readings stay forecasts, never billed cost.
    expect(ui).toContain("source: 'manual'")
  })

  test('portal links are official https URLs opened safely', () => {
    expect(PROVIDER_PORTALS.length).toBeGreaterThanOrEqual(8)
    for (const p2 of PROVIDER_PORTALS) {
      expect(p2.url.startsWith('https://')).toBe(true)
    }
    const ui = fs.readFileSync(
      path.join(__dirname, '../../app/admin/financials/infrastructure/InfrastructureClient.tsx'), 'utf8')
    expect(ui).toContain('rel="noopener noreferrer"')
    expect(ui).toContain('target="_blank"')
  })

  test('portals carry no credentials or tokens', () => {
    // Strip comments so the file's own "no tokens" note does not trip the check.
    const src = fs.readFileSync(path.join(__dirname, '../provider-portals.ts'), 'utf8')
      .split('\n').filter((l: string) => !l.trim().startsWith('//')).join('\n')
    for (const bad of ['api_key', 'apikey', 'token', 'secret', 'password', 'bearer']) {
      expect(src.toLowerCase()).not.toContain(bad)
    }
  })

  test('every required provider has a portal link', () => {
    for (const provider of ['Stripe','Shippo','Twilio','Resend','Neon','Cloudflare','GitHub','Namecheap']) {
      expect(portalForProvider(provider)).not.toBeNull()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. PRODUCT COST UI STAYS SIMPLE, STAYS COLOUR-CAPABLE
// ─────────────────────────────────────────────────────────────────────────────

describe('product cost entry remains product-level', () => {
  const ui = fs.readFileSync(
    path.join(__dirname, '../../app/admin/financials/costs/CostsClient.tsx'), 'utf8')

  test('no per-size or per-SKU cost entry is exposed', () => {
    // A hoodie run costs the same across sizes; forcing S/M/L/XL batches would
    // be needless admin work.
    const form = ui.slice(ui.indexOf('Product *'), ui.indexOf('Landed unit cost'))
    expect(form).not.toContain('Size *')
    expect(form).not.toContain('variantId')
  })

  test('colour is offered but optional', () => {
    expect(ui).toContain('Colour (optional — blank = all colours)')
  })

  test('the schema still supports future variant and colour costing', () => {
    const m013 = fs.readFileSync(
      path.join(__dirname, '../../db/migrations/013_product_cogs.sql'), 'utf8')
    expect(m013).toContain('variant_id')
    expect(m013).toContain('color_name')
    const lib = fs.readFileSync(path.join(__dirname, '../product-costs.ts'), 'utf8')
    expect(lib).toContain('variantId')
  })
})
