// lib/__tests__/phase-b-financials.test.ts
// Phase B: validation, discount stacking, COGS snapshot semantics, idempotency.

import { validateCostBatchInput } from '../product-costs'
import {
  validateExpenseDefinition, validateExpenseTransaction,
  validateUsageSnapshot, validateAdSpendInput, monthlyEquivalentCents,
} from '../expenses'
import { applyDiscountPriority } from '../discounts'
import { qualifiesForFreeShipping } from '../free-shipping'
import { resolveRangePreset, parseCustomRange } from '../financials'
import { normalizeRefundStatus } from '../refunds'

// ─────────────────────────────────────────────────────────────────────────────
// COST BATCH VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCT_ID = '11111111-2222-3333-4444-555555555555'
const VARIANT_ID = '66666666-7777-8888-9999-aaaaaaaaaaaa'

function costBatch(o: Record<string, unknown> = {}) {
  return {
    productId: PRODUCT_ID,
    manufacturingCents: 2500, freightCents: 300, dutiesCents: 150,
    tariffsCents: 0, importTaxCents: 50, packagingCents: 120, otherLandedCents: 0,
    effectiveFrom: '2025-01-01',
    ...o,
  }
}

describe('cost batch validation', () => {
  test('accepts a well-formed batch', () => {
    expect(validateCostBatchInput(costBatch())).toEqual({ ok: true })
  })

  test('rejects a missing or malformed product id', () => {
    expect(validateCostBatchInput(costBatch({ productId: 'not-a-uuid' })).ok).toBe(false)
    expect(validateCostBatchInput(costBatch({ productId: undefined })).ok).toBe(false)
  })

  test('rejects targeting a variant and a colour simultaneously', () => {
    // Ambiguous precedence — the database enforces this too.
    const r = validateCostBatchInput(costBatch({ variantId: VARIANT_ID, colorName: 'Black' }))
    expect(r.ok).toBe(false)
  })

  test('accepts a variant-only or colour-only scope', () => {
    expect(validateCostBatchInput(costBatch({ variantId: VARIANT_ID })).ok).toBe(true)
    expect(validateCostBatchInput(costBatch({ colorName: 'Black' })).ok).toBe(true)
  })

  test('rejects negative or fractional cent components', () => {
    expect(validateCostBatchInput(costBatch({ manufacturingCents: -1 })).ok).toBe(false)
    expect(validateCostBatchInput(costBatch({ freightCents: 10.5 })).ok).toBe(false)
  })

  test('rejects an all-zero cost batch', () => {
    const r = validateCostBatchInput(costBatch({
      manufacturingCents: 0, freightCents: 0, dutiesCents: 0,
      tariffsCents: 0, importTaxCents: 0, packagingCents: 0, otherLandedCents: 0,
    }))
    expect(r.ok).toBe(false)
  })

  test('rejects a malformed effective date', () => {
    expect(validateCostBatchInput(costBatch({ effectiveFrom: '01/01/2025' })).ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// EXPENSE AND AD SPEND VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('expense definition validation (EXPECTED)', () => {
  const ok = {
    provider: 'Neon', category: 'infrastructure' as const, name: 'Postgres plan',
    cadence: 'monthly' as const, expectedAmountCents: 1900,
  }

  test('accepts a valid recurring obligation', () => {
    expect(validateExpenseDefinition(ok)).toEqual({ ok: true })
  })
  test('requires a provider', () => {
    expect(validateExpenseDefinition({ ...ok, provider: '' }).ok).toBe(false)
  })
  test('rejects an unknown category', () => {
    expect(validateExpenseDefinition({ ...ok, category: 'bogus' as any }).ok).toBe(false)
  })
  test('accepts the development category', () => {
    expect(validateExpenseDefinition({
      ...ok, provider: 'GitHub', category: 'development', name: 'Codespaces',
    }).ok).toBe(true)
  })
  test('rejects an unknown cadence', () => {
    expect(validateExpenseDefinition({ ...ok, cadence: 'weekly' as any }).ok).toBe(false)
  })
  test('a fixed-cadence obligation must state an expected amount', () => {
    expect(validateExpenseDefinition({ ...ok, expectedAmountCents: null }).ok).toBe(false)
  })
  test('a usage_based obligation may omit the expected amount', () => {
    expect(validateExpenseDefinition({
      ...ok, cadence: 'usage_based', expectedAmountCents: null,
    }).ok).toBe(true)
  })
})

describe('expense transaction validation (ACTUAL)', () => {
  const ok = {
    provider: 'Twilio', category: 'communications' as const,
    name: 'August invoice', amountCents: 315, paidAt: '2025-09-01',
  }

  test('accepts a valid invoice', () => {
    expect(validateExpenseTransaction(ok)).toEqual({ ok: true })
  })
  test('accepts a genuine zero-value invoice', () => {
    expect(validateExpenseTransaction({ ...ok, amountCents: 0 }).ok).toBe(true)
  })
  test('rejects a negative amount', () => {
    expect(validateExpenseTransaction({ ...ok, amountCents: -1 }).ok).toBe(false)
  })
  test('rejects an inverted service period', () => {
    expect(validateExpenseTransaction({
      ...ok, periodStart: '2025-09-30', periodEnd: '2025-09-01',
    }).ok).toBe(false)
  })
  test('rejects an unknown source', () => {
    expect(validateExpenseTransaction({ ...ok, source: 'guessed' as any }).ok).toBe(false)
  })
})

describe('usage snapshot validation (ESTIMATE)', () => {
  const ok = {
    provider: 'Neon', metricName: 'compute', metricUnit: 'CU-hours',
    usageValue: 42, includedAllowance: 100,
  }

  test('accepts a valid reading', () => {
    expect(validateUsageSnapshot(ok)).toEqual({ ok: true })
  })
  test('requires a metric unit so the reading is unambiguous', () => {
    expect(validateUsageSnapshot({ ...ok, metricUnit: '' }).ok).toBe(false)
  })
  test('rejects an unknown threshold status', () => {
    expect(validateUsageSnapshot({ ...ok, thresholdStatus: 'panic' as any }).ok).toBe(false)
  })
  test('rejects an unknown source', () => {
    expect(validateUsageSnapshot({ ...ok, source: 'vibes' as any }).ok).toBe(false)
  })
})

describe('monthly equivalent is display arithmetic, not a billed row', () => {
  test('an annual $40 renewal shows as $3.33 per month', () => {
    expect(monthlyEquivalentCents('annual', 4000)).toBe(333)
  })
  test('a monthly obligation is its own monthly equivalent', () => {
    expect(monthlyEquivalentCents('monthly', 1900)).toBe(1900)
  })
  test('one-time and usage-based have no monthly rate', () => {
    expect(monthlyEquivalentCents('one_time', 2000)).toBeNull()
    expect(monthlyEquivalentCents('usage_based', null)).toBeNull()
  })
  test('twelve monthly equivalents do not reconstruct the annual charge exactly', () => {
    // Proof this is presentation only: 12 x 333 = 3996, not 4000. The single
    // $40 transaction remains the only fact; no monthly rows are fabricated.
    const monthly = monthlyEquivalentCents('annual', 4000)!
    expect(monthly * 12).not.toBe(4000)
  })
})

describe('ad spend validation', () => {
  const ok = {
    platform: 'meta' as const, spendCents: 25000,
    periodStart: '2025-01-01', periodEnd: '2025-01-31',
  }

  test('accepts a valid entry', () => {
    expect(validateAdSpendInput(ok)).toEqual({ ok: true })
  })
  test('rejects an unknown platform', () => {
    expect(validateAdSpendInput({ ...ok, platform: 'myspace' as any }).ok).toBe(false)
  })

  test('accepts creative production platforms', () => {
    // Photography and video are advertising investment, not the generic
    // 'content' operating-expense bucket.
    for (const platform of ['photographer', 'videographer', 'creative_production'] as const) {
      expect(validateAdSpendInput({ ...ok, platform }).ok).toBe(true)
    }
  })

  test('email is NOT an advertising platform', () => {
    // Resend fees are a 'communications' operating expense unless a send is
    // deliberately classified as a campaign.
    expect(validateAdSpendInput({ ...ok, platform: 'email' as any }).ok).toBe(false)
  })

  test('provider_source must be manual, api or imported', () => {
    for (const providerSource of ['manual', 'api', 'imported'] as const) {
      expect(validateAdSpendInput({ ...ok, providerSource }).ok).toBe(true)
    }
    expect(validateAdSpendInput({ ...ok, providerSource: 'scraped' as any }).ok).toBe(false)
  })
  test('rejects an inverted period', () => {
    expect(validateAdSpendInput({ ...ok, periodEnd: '2024-12-01' }).ok).toBe(false)
  })
  test('rejects a negative provider-reported figure', () => {
    expect(validateAdSpendInput({ ...ok, providerReportedOrders: -3 }).ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DISCOUNT STACKING — the Phase B business rule must not regress
// ─────────────────────────────────────────────────────────────────────────────

function merchDiscount(over: Record<string, unknown> = {}) {
  return {
    id: 'd1', code: 'KVRN10', name: 'KVRN10', type: 'fixed_amount' as const,
    amountCents: 1000, percentageBps: null, active: true, singleUse: false,
    maxRedemptions: null, redemptionCount: 0, minimumSubtotalCents: null,
    allowedCountryCodes: null, excludedCountryCodes: null, subscriberId: null,
    systemManaged: false, startsAt: null, expiresAt: null, priority: 10,
    stripeCouponId: 'coupon_x',
    ...over,
  } as any
}

describe('automatic free shipping stacks with one merchandise promo', () => {

  test('$150+ US order qualifies for automatic free shipping', () => {
    expect(qualifiesForFreeShipping('US', 16000)).toBe(true)
    expect(qualifiesForFreeShipping('US', 14999)).toBe(false)
  })

  test('KVRN10 still applies on a free-shipping-qualifying order', () => {
    // Automatic free shipping is a store benefit, not a promo-code slot.
    const r = applyDiscountPriority({
      discount: merchDiscount(), subtotalCents: 16000, country: 'US', shippingCents: 800,
    })
    expect(r.blockedReason).toBeNull()
    expect(r.applied).not.toBeNull()
    expect(r.applied!.amountCents).toBe(1000)
  })

  test('an SMS merchandise code also stacks with automatic free shipping', () => {
    const r = applyDiscountPriority({
      discount: merchDiscount({ id: 'd2', code: 'KVRN-SMS-ABC', systemManaged: true, singleUse: true }),
      subtotalCents: 16000, country: 'US', shippingCents: 800,
    })
    expect(r.blockedReason).toBeNull()
    expect(r.applied!.amountCents).toBe(1000)
  })

  test('a manual SHIPPING promo is redundant when automatic free shipping applies', () => {
    const r = applyDiscountPriority({
      discount: merchDiscount({ id: 'd3', code: 'FREESHIP', type: 'shipping', amountCents: null }),
      subtotalCents: 16000, country: 'US', shippingCents: 800,
    })
    expect(r.applied).toBeNull()
    expect(r.blockedReason).toMatch(/already qualifies for free shipping/i)
  })

  test('a manual shipping promo DOES apply below the free-shipping threshold', () => {
    const r = applyDiscountPriority({
      discount: merchDiscount({ id: 'd4', code: 'SHIP5', type: 'shipping', amountCents: 500 }),
      subtotalCents: 5000, country: 'US', shippingCents: 800,
    })
    expect(r.blockedReason).toBeNull()
    expect(r.applied!.type).toBe('shipping')
    expect(r.applied!.shippingAdjustmentCents).toBe(500)
    // A shipping code must never create a merchandise discount.
    expect(r.applied!.amountCents).toBe(0)
  })

  test('a merchandise discount never touches the shipping amount', () => {
    const r = applyDiscountPriority({
      discount: merchDiscount(), subtotalCents: 8000, country: 'US', shippingCents: 800,
    })
    expect(r.applied!.shippingAdjustmentCents).toBe(0)
  })

  test('a fixed discount is capped at the merchandise subtotal', () => {
    const r = applyDiscountPriority({
      discount: merchDiscount({ amountCents: 20000 }),
      subtotalCents: 5000, country: 'US', shippingCents: 800,
    })
    expect(r.applied!.amountCents).toBe(5000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// COGS SNAPSHOT SEMANTICS (SQL contract)
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs')
const path = require('path')
const M013 = fs.readFileSync(path.join(__dirname, '../../db/migrations/013_product_cogs.sql'), 'utf8')
const M017 = fs.readFileSync(path.join(__dirname, '../../db/migrations/017_finalize_cogs_snapshot.sql'), 'utf8')

describe('COGS snapshot: historical orders are immutable', () => {

  test('order_items carries its own snapshot columns rather than joining live costs', () => {
    // If profit were derived from product_cost_batches at read time, editing a cost
    // would silently rewrite history. The snapshot columns prevent that.
    expect(M013).toContain('ALTER TABLE order_items ADD COLUMN unit_cogs_cents')
    expect(M013).toContain('ALTER TABLE order_items ADD COLUMN line_cogs_cents')
    expect(M013).toContain('ALTER TABLE order_items ADD COLUMN cost_batch_id')
  })

  test('finalize_paid_order writes the snapshot at sale time', () => {
    expect(M017).toContain('resolve_cost_batch(v_item.variant_id, v_sale_date)')
    expect(M017).toContain('unit_cogs_cents, line_cogs_cents')
  })

  test('line COGS is NULL when no cost batch exists — never zero', () => {
    expect(M017).toContain('CASE WHEN v_batch.unit_cogs_cents IS NULL THEN NULL')
  })

  test('cost resolution precedence is variant, then colour, then product', () => {
    const fn = M017.slice(M017.indexOf('FUNCTION resolve_cost_batch'),
                          M017.indexOf('FUNCTION finalize_paid_order'))
    expect(fn.indexOf('Tier 1: variant-specific'))
      .toBeLessThan(fn.indexOf('Tier 2: colour group'))
    expect(fn.indexOf('Tier 2: colour group'))
      .toBeLessThan(fn.indexOf('Tier 3: product default'))
  })

  test('cost batches are append-only — no effective_to column exists', () => {
    // Overlapping validity windows are structurally impossible.
    // Strip SQL comments so prose mentioning the term does not mask a real column.
    const ddl = M013.split('\n').filter((l: string) => !l.trim().startsWith('--')).join('\n')
    expect(ddl).toContain('effective_from           DATE        NOT NULL')
    expect(ddl).not.toContain('effective_to')
  })
})

describe('finalize_paid_order preserves its existing contract', () => {

  test('the 11-argument signature is unchanged', () => {
    const sig = M017.slice(M017.indexOf('FUNCTION finalize_paid_order'),
                           M017.indexOf('RETURNS JSONB', M017.indexOf('FUNCTION finalize_paid_order')))
    for (const p of [
      'p_stripe_session_id', 'p_reservation_id_hint', 'p_stripe_payment_intent',
      'p_stripe_event_id', 'p_event_type', 'p_expected_currency', 'p_amount_total',
      'p_customer_email', 'p_customer_name', 'p_customer_phone', 'p_shipping_address',
    ]) expect(sig).toContain(p)
  })

  test('webhook idempotency, amount invariant and inventory guard are retained', () => {
    expect(M017).toContain('KVRN_RESERVATION|AMOUNT_MISMATCH')
    expect(M017).toContain('KVRN_RESERVATION|DEDUCT_INVARIANT')
    expect(M017).toContain('KVRN_DISCOUNT|NO_CLAIM_FOR_LIMITED_CODE')
    expect(M017).toContain("ON CONFLICT (stripe_event_id) DO NOTHING")
    expect(M017).toContain("ON CONFLICT (discount_id, order_id) DO NOTHING")
  })

  test('the amount invariant still subtracts the discount exactly once', () => {
    expect(M017).toContain('GREATEST(0, v_merch_total - v_discount_cents) + v_ship_final')
  })

  test('save_reservation_checkout_details is dropped before recreation', () => {
    // Adding DEFAULT params via CREATE OR REPLACE would overload, not replace,
    // making the existing 13-argument call ambiguous.
    expect(M017).toContain('DROP FUNCTION IF EXISTS save_reservation_checkout_details(')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REFUND IDEMPOTENCY (SQL contract)
// ─────────────────────────────────────────────────────────────────────────────

const M015 = fs.readFileSync(path.join(__dirname, '../../db/migrations/015_order_refunds.sql'), 'utf8')

describe('refund accounting', () => {

  test('the Stripe refund id is unique, making replays harmless', () => {
    expect(M015).toContain('CONSTRAINT order_refunds_stripe_uq UNIQUE (stripe_refund_id)')
  })

  test('a duplicate webhook updates rather than inserting a second row', () => {
    expect(M015).toContain("ON CONFLICT (stripe_refund_id) DO NOTHING")
    expect(M015).toContain("v_outcome := 'updated'")
  })

  test('only succeeded refunds reduce recognised revenue', () => {
    expect(M015).toContain("WHERE order_id = v_order_id AND status = 'succeeded'")
  })

  test('a partial refund does not mark the order fully refunded', () => {
    expect(M015).toContain('WHEN v_refunded_total >= v_order_total')
  })

  test('no inventory is restocked automatically on refund', () => {
    // KVRN has no returns-received workflow; assuming a physical return would corrupt stock.
    expect(M015).not.toContain('inventory_movements')
    expect(M015).not.toContain('stock_on_hand')
  })

  test('a returned processing fee is unknown unless Stripe reports one', () => {
    expect(M015).toContain('fee_refunded_cents       INTEGER')
  })

  test('normalizeRefundStatus maps Stripe values onto the allowed set', () => {
    expect(normalizeRefundStatus('succeeded')).toBe('succeeded')
    expect(normalizeRefundStatus('failed')).toBe('failed')
    expect(normalizeRefundStatus('cancelled')).toBe('canceled')
    expect(normalizeRefundStatus('canceled')).toBe('canceled')
    expect(normalizeRefundStatus(undefined)).toBe('pending')
    expect(normalizeRefundStatus('something_new')).toBe('pending')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE FEE ENRICHMENT IDEMPOTENCY
// ─────────────────────────────────────────────────────────────────────────────

const FEES = fs.readFileSync(path.join(__dirname, '../stripe-fees.ts'), 'utf8')

describe('Stripe fee reconciliation', () => {

  test('the fee is read from the balance transaction, never estimated', () => {
    expect(FEES).toContain("expand: ['latest_charge.balance_transaction']")
    expect(FEES).not.toContain('0.029')
    expect(FEES).not.toContain('2.9')
  })

  test('the write is guarded so a retry cannot apply a fee twice', () => {
    expect(FEES).toContain('AND stripe_fee_cents IS NULL')
  })

  test('an unsettled charge is reported as retryable, not as a zero fee', () => {
    expect(FEES).toContain("outcome: 'not_settled'")
  })

  test('attempts are capped so a broken order is not retried forever', () => {
    expect(FEES).toContain('stripe_fee_attempts <')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REPORTING PERIODS
// ─────────────────────────────────────────────────────────────────────────────

describe('reporting date ranges', () => {

  test('presets produce half-open UTC ranges', () => {
    const now = new Date('2025-06-15T13:45:00Z')
    const r = resolveRangePreset('today', now)
    expect(r.start).toBe('2025-06-15T00:00:00.000Z')
    expect(r.end).toBe('2025-06-16T00:00:00.000Z')
  })

  test('7d covers seven calendar days including today', () => {
    const r = resolveRangePreset('7d', new Date('2025-06-15T13:45:00Z'))
    expect(r.start).toBe('2025-06-09T00:00:00.000Z')
    expect(r.end).toBe('2025-06-16T00:00:00.000Z')
  })

  test('month to date starts on the first of the month', () => {
    const r = resolveRangePreset('mtd', new Date('2025-06-15T13:45:00Z'))
    expect(r.start).toBe('2025-06-01T00:00:00.000Z')
  })

  test('a custom range includes the whole end day', () => {
    const r = parseCustomRange('2025-06-01', '2025-06-30')!
    expect(r.start).toBe('2025-06-01T00:00:00.000Z')
    expect(r.end).toBe('2025-07-01T00:00:00.000Z')
  })

  test('invalid, inverted and excessive ranges are rejected', () => {
    expect(parseCustomRange('nonsense', '2025-06-30')).toBeNull()
    expect(parseCustomRange('2025-06-30', '2025-06-01')).toBeNull()
    expect(parseCustomRange('2000-01-01', '2025-06-01')).toBeNull()
    expect(parseCustomRange(null, undefined)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNTING SEPARATION (schema contract)
// ─────────────────────────────────────────────────────────────────────────────

const M014 = fs.readFileSync(path.join(__dirname, '../../db/migrations/014_order_financials.sql'), 'utf8')

describe('customer charges and KVRN costs stay separate', () => {

  test('actual label cost lives on shipments, not on orders', () => {
    expect(M014).toContain('ALTER TABLE shipments ADD COLUMN label_cost_cents')
    expect(M014).not.toContain('ALTER TABLE orders ADD COLUMN actual_shipping_cost_cents')
  })

  test('the carrier quote is captured before free shipping zeroes it', () => {
    expect(M014).toContain('ALTER TABLE orders ADD COLUMN shipping_quoted_cents')
    expect(M014).toContain('shipping_auto_free_discount_cents')
  })

  test('the checkout handler snapshots the quote before applying free shipping', () => {
    const handler = fs.readFileSync(
      path.join(__dirname, '../checkout-session-handler.ts'), 'utf8')
    const quoteIdx = handler.indexOf('const quotedShippingCents = shippingCents')
    const freeIdx  = handler.indexOf('applyFreeShippingToSingleRate(')
    expect(quoteIdx).toBeGreaterThan(0)
    expect(quoteIdx).toBeLessThan(freeIdx)
  })

  test('Stripe fee and label cost are nullable so unknown is representable', () => {
    expect(M014).toContain('stripe_fee_cents IS NULL OR stripe_fee_cents >= 0')
    expect(M014).toContain('label_cost_cents IS NULL OR label_cost_cents >= 0')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PACKAGING IN THE SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

describe('packaging is part of the landed COGS schema', () => {

  test('product_cost_batches has a packaging component', () => {
    expect(M013).toContain('packaging_cents          INTEGER     NOT NULL DEFAULT 0')
  })

  test('the generated unit COGS includes packaging', () => {
    const gen = M013.slice(M013.indexOf('GENERATED ALWAYS AS'),
                           M013.indexOf(') STORED'))
    for (const c of ['manufacturing_cents', 'freight_cents', 'duties_cents',
                     'tariffs_cents', 'import_tax_cents', 'packaging_cents',
                     'other_landed_cents']) {
      expect(gen).toContain(c)
    }
  })

  test('order_items snapshots the packaging component', () => {
    expect(M013).toContain('ALTER TABLE order_items ADD COLUMN unit_packaging_cents')
  })

  test('finalize_paid_order writes the packaging snapshot at sale time', () => {
    expect(M017).toContain('unit_packaging_cents')
    expect(M017).toContain('v_batch.packaging_cents')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THREE-LAYER OPERATING COST MODEL (schema contract)
// ─────────────────────────────────────────────────────────────────────────────

const M016 = fs.readFileSync(
  path.join(__dirname, '../../db/migrations/016_expenses_ad_spend.sql'), 'utf8')

describe('the three operating cost layers are distinct tables', () => {

  test('expense_definitions, expense_transactions and provider_usage_snapshots all exist', () => {
    expect(M016).toContain('CREATE TABLE IF NOT EXISTS expense_definitions')
    expect(M016).toContain('CREATE TABLE IF NOT EXISTS expense_transactions')
    expect(M016).toContain('CREATE TABLE IF NOT EXISTS provider_usage_snapshots')
  })

  test('the old combined operating_expenses table is gone', () => {
    expect(M016).not.toContain('CREATE TABLE IF NOT EXISTS operating_expenses')
  })

  test('a transaction can reference the obligation it settles', () => {
    expect(M016).toContain('expense_definition_id UUID        REFERENCES expense_definitions(id)')
  })

  test('usage snapshots record a unit so readings are unambiguous', () => {
    expect(M016).toContain('metric_unit               TEXT        NOT NULL')
  })

  test('usage snapshot money columns are named as forecasts, not bills', () => {
    expect(M016).toContain('estimated_accrued_cents')
    expect(M016).toContain('projected_month_end_cents')
    // The forecast table has no "amount_cents" that could be mistaken for a bill.
    const usageBlock = M016.slice(M016.indexOf('CREATE TABLE IF NOT EXISTS provider_usage_snapshots'),
                                  M016.indexOf('-- ── D. ad_spend'))
    expect(usageBlock).not.toContain('amount_cents')
  })

  test('development is a first-class category, separate from infrastructure', () => {
    expect(M016).toContain("'development'")
    expect(M016).toContain("'infrastructure'")
  })

  test('a usage_based definition may omit an expected amount', () => {
    expect(M016).toContain("cadence = 'usage_based' OR expected_amount_cents IS NOT NULL")
  })
})

describe('realised expense reporting reads transactions only', () => {
  const FIN = fs.readFileSync(path.join(__dirname, '../financials.ts'), 'utf8')

  test('actual operating expenses are sourced from expense_transactions', () => {
    // The query moved into the shared fetchExpenseRows helper so the period path
    // and the per-bucket chart path read identical rows. The invariant is
    // unchanged: only real transactions, never definitions or usage forecasts.
    const fetchFn = FIN.slice(FIN.indexOf('async function fetchExpenseRows'),
                              FIN.indexOf('async function fetchAdSpendRows'))
    expect(fetchFn).toContain('FROM expense_transactions')
    expect(fetchFn).not.toContain('expense_definitions')
    expect(fetchFn).not.toContain('provider_usage_snapshots')
  })

  test('only settled transactions count toward realised expense', () => {
    // Enforced twice: the fetch filters unpaid rows, and the recognition
    // primitive skips any row without a paid date.
    const fetchFn = FIN.slice(FIN.indexOf('async function fetchExpenseRows'),
                              FIN.indexOf('async function fetchAdSpendRows'))
    expect(fetchFn).toContain('paid_at IS NOT NULL')

    const calc = fs.readFileSync(path.join(__dirname, '../financial-calculator.ts'), 'utf8')
    const prim = calc.slice(calc.indexOf('export function recognizeExpenseRowsExact'))
    expect(prim).toContain('if (!r.paidAt) continue')
  })

  test('development expense is split out from operating expense', () => {
    // The split now lives in the canonical primitive, shared by the period
    // totals and the chart buckets, so both classify identically.
    const calc = fs.readFileSync(path.join(__dirname, '../financial-calculator.ts'), 'utf8')
    const prim = calc.slice(calc.indexOf('export function recognizeExpenseRowsExact'))
    expect(prim).toContain("r.category === 'development'")
  })

  test('forecasts are read from usage snapshots and kept apart', () => {
    const fn = FIN.slice(FIN.indexOf('async getForecastOperatingExpensesCents'),
                         FIN.indexOf('/** Full period report'))
    expect(fn).toContain('FROM provider_usage_snapshots')
    expect(fn).toContain('estimatedAccrued')
    expect(fn).toContain('projectedMonthEnd')
  })

  test('the period report feeds actuals and forecasts into separate fields', () => {
    expect(FIN).toContain('recognizedOperatingExpensesCents:   recognized.operating')
    expect(FIN).toContain('recognizedDevelopmentExpensesCents: recognized.development')
    expect(FIN).toContain('estimatedAccruedOperatingExpensesCents: forecast.estimatedAccrued')
    expect(FIN).toContain('projectedOperatingExpensesCents:        forecast.projectedMonthEnd')
  })
})

describe('ad spend schema', () => {

  test('creative production platforms are permitted', () => {
    expect(M016).toContain("'photographer'")
    expect(M016).toContain("'videographer'")
    expect(M016).toContain("'creative_production'")
  })

  test('email is not an ad platform', () => {
    const adBlock = M016.slice(M016.indexOf('CREATE TABLE IF NOT EXISTS ad_spend'))
    expect(adBlock).not.toContain("'email'")
  })

  test('provider_source records the provenance of reported metrics', () => {
    expect(M016).toContain("provider_source TEXT")
    expect(M016).toContain("provider_source IN ('manual','api','imported')")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT PROFITABILITY USES THE AUTHORITATIVE ALLOCATOR
// ─────────────────────────────────────────────────────────────────────────────

describe('product profitability allocation', () => {
  const FIN2 = fs.readFileSync(path.join(__dirname, '../financials.ts'), 'utf8')

  test('getProductProfitability calls the shared allocator', () => {
    const fn = FIN2.slice(FIN2.indexOf('async getProductProfitability'))
    expect(fn).toContain('allocateDiscountToLines(')
  })

  test('there is no second allocation formula in SQL', () => {
    // A per-line ROUND() cannot guarantee the parts sum back to the order discount.
    expect(FIN2).not.toContain('ROUND(o.discount_cents::numeric')
    expect(FIN2).not.toContain('discount_cents::numeric * oi.line_total_cents')
  })

  test('lines are grouped per order before allocation', () => {
    // Allocation is only cent-exact within the order that owns the discount.
    const fn = FIN2.slice(FIN2.indexOf('async getProductProfitability'))
    expect(fn).toContain('byOrder')
    expect(fn).toContain('order.discountCents')
  })

  test('SKU COGS stays null when any line lacks a snapshot', () => {
    const fn = FIN2.slice(FIN2.indexOf('async getProductProfitability'))
    expect(fn).toContain('p.itemsMissingCogs > 0 ? null : p.cogsCents')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// INFRASTRUCTURE: NO DATA LOSS, AGGREGATION MATCHES THE OVERVIEW
// ─────────────────────────────────────────────────────────────────────────────

describe('infrastructure preserves all definitions and metrics', () => {
  const EXP = fs.readFileSync(path.join(__dirname, '../expenses.ts'), 'utf8')
  const FIN3 = fs.readFileSync(path.join(__dirname, '../financials.ts'), 'utf8')

  test('a provider returns arrays of definitions and usage metrics', () => {
    const fn = EXP.slice(EXP.indexOf('async getInfrastructureCosts'))
    expect(fn).toContain('definitions: providerDefs')
    expect(fn).toContain('usageMetrics: providerUsage')
  })

  test('all definitions for a provider are kept, not just the first', () => {
    const fn = EXP.slice(EXP.indexOf('async getInfrastructureCosts'))
    expect(fn).toContain('.filter(d => d.provider === provider)')
    // The old single-pick behaviour must be gone.
    expect(fn).not.toContain('.find(d => d.provider === provider)')
  })

  test('all usage metrics for a provider are kept, not just the first', () => {
    const fn = EXP.slice(EXP.indexOf('async getInfrastructureCosts'))
    expect(fn).toContain('.filter(u => u.provider === provider)')
    expect(fn).not.toContain('.find(u => u.provider === provider)')
  })

  test('DISTINCT ON (provider) alone is never used — it would drop metrics', () => {
    expect(EXP).not.toMatch(/DISTINCT ON \(provider\)\s/)
  })

  test('infrastructure and overview key forecasts identically', () => {
    // Both must take the latest snapshot per (provider, metric_name), or the two
    // surfaces would report different estimated/projected totals.
    const infraFn = EXP.slice(EXP.indexOf('async getInfrastructureCosts'))
    const overviewFn = FIN3.slice(FIN3.indexOf('async getForecastOperatingExpensesCents'),
                                  FIN3.indexOf('/** Full period report'))
    expect(infraFn).toContain('DISTINCT ON (provider, metric_name)')
    expect(overviewFn).toContain('DISTINCT ON (provider, metric_name)')
  })

  test('provider forecast totals sum across every metric', () => {
    const fn = EXP.slice(EXP.indexOf('async getInfrastructureCosts'))
    expect(fn).toContain('sumMetric(m => m.estimatedAccruedCents)')
    expect(fn).toContain('sumMetric(m => m.projectedMonthEndCents)')
  })

  test('expected monthly equivalent aggregates across all obligations', () => {
    const fn = EXP.slice(EXP.indexOf('async getInfrastructureCosts'))
    expect(fn).toContain('expectedMonthlyEquivalentCents')
    expect(fn).toContain('monthlyEquivalents.reduce')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ACTUAL PAID vs RECOGNIZED EXPENSE
// ─────────────────────────────────────────────────────────────────────────────

describe('actual paid and recognized expense are distinct measures', () => {
  const CALC = fs.readFileSync(path.join(__dirname, '../financial-calculator.ts'), 'utf8')
  const FIN4 = fs.readFileSync(path.join(__dirname, '../financials.ts'), 'utf8')
  const EXP2 = fs.readFileSync(path.join(__dirname, '../expenses.ts'), 'utf8')

  test('the P&L input is named as recognized, not as billed or paid', () => {
    expect(CALC).toContain('recognizedOperatingExpensesCents')
    expect(CALC).toContain('recognizedDevelopmentExpensesCents')
    // The prorated figure must never be labelled "actual billed".
    expect(CALC).not.toContain('actualOperatingExpensesCents')
  })

  test('the recognition basis is documented in the calculator', () => {
    expect(CALC).toContain('RECOGNIZED != PAID')
  })

  test('the recognition rule is documented at the query', () => {
    const fn = FIN4.slice(FIN4.indexOf('RECOGNITION BASIS'),
                          FIN4.indexOf('async getRecognizedOperatingExpensesCents'))
    expect(fn).toContain('apportioned')
    expect(fn).toContain('ACTUAL PAID')
  })

  test('infrastructure reports cash out under actualPaidCents', () => {
    const fn = EXP2.slice(EXP2.indexOf('async getInfrastructureCosts'))
    expect(fn).toContain('actualPaidCents')
    // Not renamed to something that implies period recognition.
    expect(fn).not.toContain('recognizedOperatingExpensesCents')
  })

  test('the annual-renewal divergence is explained rather than hidden', () => {
    expect(FIN4).toContain('$40 annual renewal')
    expect(EXP2).toContain('ACTUAL PAID')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PACKAGING DOUBLE-COUNTING SAFEGUARD
// ─────────────────────────────────────────────────────────────────────────────

describe('packaging cannot be silently double-counted', () => {
  const UI = fs.readFileSync(
    path.join(__dirname, '../../app/admin/financials/expenses/ExpensesClient.tsx'), 'utf8')

  test('packaging remains part of landed COGS', () => {
    // The safeguard must not have been implemented by removing it from COGS.
    expect(M013).toContain('packaging_cents')
    expect(M017).toContain('v_batch.packaging_cents')
  })

  test('the expense category is relabelled as non-unit overhead', () => {
    expect(UI).toContain('packaging overhead (non-unit)')
  })

  test('a warning explains the COGS overlap when the category is selected', () => {
    expect(UI).toContain('PACKAGING_WARNING')
    expect(UI).toContain('already sit in product landed COGS')
    expect(UI).toContain('double-count')
  })

  test('the warning appears on both the obligation and the invoice form', () => {
    const occurrences = (UI.match(/\{PACKAGING_WARNING\}/g) ?? []).length
    expect(occurrences).toBe(2)
  })

  test('COGS packaging is never auto-copied into expenses', () => {
    // Strip comments so prose explaining the boundary does not mask a real query.
    const EXP3 = fs.readFileSync(path.join(__dirname, '../expenses.ts'), 'utf8')
      .split('\n').filter((l: string) => !l.trim().startsWith('//')).join('\n')
    // The expense service must never read the COGS tables — a packaging cost
    // recorded on a cost batch must not also appear as an operating expense.
    expect(EXP3).not.toContain('product_cost_batches')
    expect(EXP3).not.toContain('order_items')
  })
})
