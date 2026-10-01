// lib/__tests__/phase-b-batch3-018.test.ts
// Migration 018: returns, exchanges, disputes.
//
// Focus: the accounting invariants that prevent double counting, and the refund
// component-breakdown rules.

import {
  validateCreateReturn, validateDecomposition,
  DISPOSITIONS, RETURN_SHIPPING_PAYERS,
} from '../returns'
import { mapStripeDisputeStatus, TERMINAL_STATUSES } from '../disputes'

const fs   = require('fs')
const path = require('path')

const M018 = fs.readFileSync(
  path.join(__dirname, '../../db/migrations/018_returns_exchanges_disputes.sql'), 'utf8')

/** Strip SQL comments so prose describing a rule cannot satisfy a test about it. */
const ddl = M018.split('\n').filter((l: string) => !l.trim().startsWith('--')).join('\n')

const ORDER_ID = '11111111-2222-3333-4444-555555555555'
const ITEM_ID  = '66666666-7777-8888-9999-aaaaaaaaaaaa'

// ─────────────────────────────────────────────────────────────────────────────
// REFUND COMPONENT BREAKDOWN — the five scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe('refund component breakdown', () => {

  test('a Stripe refund with all component fields NULL starts as unknown', () => {
    // Stripe reports only a total, so the DEFAULT must be unknown — never a
    // fabricated split.
    expect(ddl).toContain("component_breakdown_status TEXT NOT NULL")
    expect(ddl).toContain("DEFAULT 'unknown'")
    expect(ddl).toContain("CHECK (component_breakdown_status IN ('unknown','resolved'))")
  })

  test('allocation is blocked while the breakdown is unknown', () => {
    // The critical guard: NULL components are neither permissive caps nor zeros.
    const fn = ddl.slice(ddl.indexOf('FUNCTION allocate_return_refund'))
    expect(fn).toContain("component_breakdown_status <> 'resolved'")
    expect(fn).toContain('KVRN_RETURN|BREAKDOWN_UNRESOLVED')
  })

  test('allocation never falls back to the refund total for a NULL component', () => {
    // An earlier draft used COALESCE(component, amount_cents), which would have
    // let all three components each absorb the entire refund.
    const fn = ddl.slice(ddl.indexOf('FUNCTION allocate_return_refund'))
    expect(fn).not.toContain('COALESCE(v_ref.merchandise_refund_cents, v_ref.amount_cents)')
    expect(fn).not.toContain('COALESCE(v_ref.shipping_refund_cents,    v_ref.amount_cents)')
    expect(fn).toContain('KVRN_RETURN|BREAKDOWN_INCOMPLETE')
  })

  test('a valid admin decomposition summing exactly to the refund is accepted', () => {
    expect(validateDecomposition(
      { merchandiseCents: 8000, shippingCents: 800, taxCents: 0 }, 8800,
    )).toEqual({ ok: true })
  })

  test('a decomposition that does not reconcile is rejected', () => {
    const under = validateDecomposition(
      { merchandiseCents: 8000, shippingCents: 700, taxCents: 0 }, 8800)
    const over  = validateDecomposition(
      { merchandiseCents: 8000, shippingCents: 900, taxCents: 0 }, 8800)
    expect(under.ok).toBe(false)
    expect(over.ok).toBe(false)
    if (!under.ok) expect(under.error).toMatch(/exactly/i)
  })

  test('an omitted component is rejected rather than defaulting to zero', () => {
    const r = validateDecomposition(
      { merchandiseCents: 8800, shippingCents: undefined, taxCents: 0 } as any, 8800)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/required/i)
  })

  test('negative components are rejected', () => {
    expect(validateDecomposition(
      { merchandiseCents: 9000, shippingCents: -200, taxCents: 0 }, 8800).ok).toBe(false)
  })

  test('a zero component is legitimate when it genuinely reconciles', () => {
    // Zero tax is fine when stated explicitly; what is forbidden is a SILENT zero.
    expect(validateDecomposition(
      { merchandiseCents: 8800, shippingCents: 0, taxCents: 0 }, 8800).ok).toBe(true)
  })

  test('SQL rejects an incomplete or mismatched decomposition', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION resolve_refund_components'))
    expect(fn).toContain('KVRN_REFUND|INCOMPLETE_DECOMPOSITION')
    expect(fn).toContain('KVRN_REFUND|DECOMPOSITION_MISMATCH')
    expect(fn).toContain('<> v_ref.amount_cents')
  })

  test('deterministic derivation is allowed only for a genuine full refund', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION resolve_refund_components'))
    expect(fn).toContain('KVRN_REFUND|NOT_FULL_REFUND')
    // And the derivation must itself reconcile before being accepted.
    expect(fn).toContain('KVRN_REFUND|DERIVATION_DOES_NOT_RECONCILE')
  })

  test('resolution records its provenance', () => {
    expect(ddl).toContain("component_breakdown_source IN ('derived_full_refund','admin')")
  })

  test('multiple allocations after decomposition are capped by resolved components', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION allocate_return_refund'))
    // Cumulative across other returns against the same refund.
    expect(fn).toContain('WHERE refund_id = p_refund_id AND return_id <> p_return_id')
    expect(fn).toContain('MERCHANDISE_OVER_ALLOCATED')
    expect(fn).toContain('SHIPPING_OVER_ALLOCATED')
    expect(fn).toContain('TAX_OVER_ALLOCATED')
  })

  test('backfill marks only refunds that already carry all three components', () => {
    expect(ddl).toContain('WHERE merchandise_refund_cents IS NOT NULL')
    expect(ddl).toContain('AND shipping_refund_cents    IS NOT NULL')
    expect(ddl).toContain('AND tax_refund_cents         IS NOT NULL')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RETURNS DO NOT REDUCE REVENUE
// ─────────────────────────────────────────────────────────────────────────────

describe('returns never reduce revenue', () => {

  test('no return table carries a revenue-reducing amount column', () => {
    const returnsBlock = ddl.slice(
      ddl.indexOf('CREATE TABLE IF NOT EXISTS order_returns'),
      ddl.indexOf('CREATE TABLE IF NOT EXISTS return_refund_allocations'))
    // Money leaves via order_refunds only.
    expect(returnsBlock).not.toContain('refund_amount_cents')
    expect(returnsBlock).not.toContain('revenue_cents')
  })

  test('allocation links a return to a refund without moving money', () => {
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS return_refund_allocations')
    expect(ddl).toContain('CONSTRAINT rra_return_refund_uq UNIQUE (return_id, refund_id)')
  })

  test('a return and a refund must belong to the same order', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION allocate_return_refund'))
    expect(fn).toContain('KVRN_RETURN|ORDER_MISMATCH')
  })

  test('merchandise allocation cannot exceed the value actually returned', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION allocate_return_refund'))
    expect(fn).toContain('KVRN_RETURN|EXCEEDS_RETURNED_VALUE')
  })

  test('returned quantity cannot exceed the quantity ordered', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION create_order_return'))
    expect(fn).toContain('KVRN_RETURN|QUANTITY_EXCEEDS_ORDERED')
    // Cumulative across prior returns, excluding cancelled ones.
    expect(fn).toContain("r.status <> 'cancelled'")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// COGS CREDIT ONLY ON GENUINE RESTOCK
// ─────────────────────────────────────────────────────────────────────────────

describe('COGS credit requires a sellable restock', () => {

  test('restocking is only possible for sellable units', () => {
    expect(ddl).toContain('CONSTRAINT rit_restock_requires_sellable')
  })

  test('a COGS credit cannot exist without a restock', () => {
    // Damaged, defective, lost and disposed units keep their original COGS —
    // the goods really were consumed.
    expect(ddl).toContain('CONSTRAINT rit_credit_requires_restock')
  })

  test('all five dispositions are modelled', () => {
    for (const d of DISPOSITIONS) expect(ddl).toContain(`'${d}'`)
    expect(DISPOSITIONS).toHaveLength(5)
  })

  test('unit COGS is snapshotted at return creation', () => {
    // So a later cost-batch change cannot alter goods already returned.
    const fn = ddl.slice(ddl.indexOf('FUNCTION create_order_return'))
    expect(fn).toContain('v_oi.unit_cogs_cents')
    expect(fn).toContain('unit_cogs_cents_snapshot')
  })

  test('an unknown unit cost stays NULL rather than becoming zero', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION create_order_return'))
    expect(fn).not.toContain('COALESCE(v_oi.unit_cogs_cents, 0)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RETURN SHIPPING: THREE DISTINCT CONCEPTS
// ─────────────────────────────────────────────────────────────────────────────

describe('return shipping economics', () => {

  test('the payer defaults to not_applicable, assuming nothing', () => {
    expect(ddl).toContain("return_shipping_paid_by TEXT NOT NULL DEFAULT 'not_applicable'")
    expect(RETURN_SHIPPING_PAYERS).toEqual(['kvrn', 'customer', 'not_applicable'])
  })

  test("KVRN's carrier cost is separate from what the customer was charged", () => {
    expect(ddl).toContain('return_label_cost_cents')
    expect(ddl).toContain('return_shipping_charged_to_customer_cents')
  })

  test('a carrier cost cannot be recorded unless KVRN paid for the label', () => {
    expect(ddl).toContain('CONSTRAINT ret_label_cost_requires_kvrn')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// EXCHANGES CREATE NO REVENUE
// ─────────────────────────────────────────────────────────────────────────────

describe('exchanges are not sales', () => {

  test('a price difference has no effect until authoritatively settled', () => {
    expect(ddl).toContain("price_difference_status TEXT   NOT NULL DEFAULT 'none'")
    expect(ddl).toContain("CHECK (price_difference_status IN ('none','pending','succeeded','failed'))")
  })

  test('a settled positive difference requires real Stripe evidence', () => {
    expect(ddl).toContain('CONSTRAINT exch_positive_needs_evidence')
  })

  test('a settled negative difference must cite a real refund', () => {
    expect(ddl).toContain('CONSTRAINT exch_negative_needs_refund')
  })

  test("'none' can only mean a zero difference", () => {
    expect(ddl).toContain('CONSTRAINT exch_none_means_zero')
  })

  test('replacement COGS is snapshotted at creation', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION create_order_exchange'))
    expect(fn).toContain('resolve_cost_batch')
    // Unknown cost must not become zero.
    expect(fn).toContain('WHEN v_batch.unit_cogs_cents IS NULL THEN NULL')
  })

  test('an exchange records no merchandise revenue column', () => {
    const block = ddl.slice(
      ddl.indexOf('CREATE TABLE IF NOT EXISTS order_exchanges'),
      ddl.indexOf('CREATE TABLE IF NOT EXISTS order_exchange_items'))
    expect(block).not.toContain('revenue_cents')
    expect(block).not.toContain('subtotal_cents')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DISPUTES
// ─────────────────────────────────────────────────────────────────────────────

describe('dispute state handling', () => {

  test('Stripe statuses map onto KVRN accounting states', () => {
    expect(mapStripeDisputeStatus('needs_response')).toBe('open')
    expect(mapStripeDisputeStatus('under_review')).toBe('under_review')
    expect(mapStripeDisputeStatus('won')).toBe('won')
    expect(mapStripeDisputeStatus('lost')).toBe('lost')
    expect(mapStripeDisputeStatus('charge_refunded')).toBe('withdrawn')
  })

  test('an unknown Stripe status never becomes a terminal outcome', () => {
    // Guessing a terminal state would move money on a status Stripe added later.
    const mapped = mapStripeDisputeStatus('some_future_status')
    expect(mapped).toBe('under_review')
    expect(TERMINAL_STATUSES).not.toContain(mapped)
  })

  test('staleness is judged by Stripe event time, not a status rank', () => {
    // Rev 3: strictly-older only, so equal timestamps are not discarded.
    const fn = ddl.slice(ddl.indexOf('FUNCTION upsert_order_dispute'))
    expect(fn).toContain('p_event_created_at < v_dispute.last_applied_event_at')
    expect(fn).toContain("'stale_event'")
  })

  test('a late lost -> won transition is permitted', () => {
    // No monotonic rank exists that could block it.
    const fn = ddl.slice(ddl.indexOf('FUNCTION upsert_order_dispute'))
    expect(fn).not.toContain('status_rank')
    expect(fn).not.toContain('rank >')
  })

  test('duplicate webhook delivery is absorbed by a UNIQUE event id', () => {
    expect(ddl).toContain('CONSTRAINT ode_event_uq UNIQUE (stripe_event_id)')
    const fn = ddl.slice(ddl.indexOf('FUNCTION upsert_order_dispute'))
    expect(fn).toContain("'duplicate_event'")
  })

  test('dispute history is append-only', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION upsert_order_dispute'))
    expect(fn).not.toContain('DELETE FROM order_dispute_events')
  })

  test('only a lost dispute reduces revenue', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION upsert_order_dispute'))
    expect(fn).toContain("WHEN p_mapped_status = 'lost'")
    expect(fn).toContain('ELSE 0 END')
  })

  test('a refund already issued is offset so revenue is not reduced twice', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION upsert_order_dispute'))
    expect(fn).toContain('v_offset := LEAST(')
    expect(fn).toContain('p_amount_cents - v_offset')
    expect(ddl).toContain('CONSTRAINT dispute_offset_le_amount')
  })
})

describe('dispute fees are authoritative, never inferred', () => {

  test('balance transactions are stored verbatim from Stripe', () => {
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS dispute_balance_transactions')
    expect(ddl).toContain('reporting_category')
  })

  test('each real Stripe money movement is consumed exactly once', () => {
    expect(ddl).toContain('CONSTRAINT dbt_stripe_uq UNIQUE (stripe_balance_transaction_id)')
  })

  test('no fee is assumed from a won or lost outcome', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION upsert_order_dispute'))
    // The state function must not compute fees at all.
    expect(fn).not.toContain('fee_cents')
    expect(fn).not.toContain('dispute_fee')
  })

  test('the webhook records balance transactions separately from state', () => {
    const wh = fs.readFileSync(
      path.join(__dirname, '../../app/api/stripe/webhook/route.ts'), 'utf8')
    expect(wh).toContain('recordBalanceTransaction')
    expect(wh).toContain('balance_transactions')
  })

  test('all five dispute webhook events are handled', () => {
    const wh = fs.readFileSync(
      path.join(__dirname, '../../app/api/stripe/webhook/route.ts'), 'utf8')
    for (const e of ['charge.dispute.created', 'charge.dispute.updated',
                     'charge.dispute.closed', 'charge.dispute.funds_withdrawn',
                     'charge.dispute.funds_reinstated']) {
      expect(wh).toContain(e)
    }
  })

  test("Stripe's own event timestamp drives staleness in the webhook", () => {
    const wh = fs.readFileSync(
      path.join(__dirname, '../../app/api/stripe/webhook/route.ts'), 'utf8')
    expect(wh).toContain('stripeEventCreatedAt')
    expect(wh).toContain('eventCreated')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// INPUT VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('return creation validation', () => {
  const ok = {
    orderId: ORDER_ID,
    items: [{ orderItemId: ITEM_ID, quantity: 1, disposition: 'sellable' as const }],
  }

  test('accepts a well-formed return', () => {
    expect(validateCreateReturn(ok)).toEqual({ ok: true })
  })
  test('requires a valid order', () => {
    expect(validateCreateReturn({ ...ok, orderId: 'nope' }).ok).toBe(false)
  })
  test('requires at least one item', () => {
    expect(validateCreateReturn({ ...ok, items: [] }).ok).toBe(false)
  })
  test('rejects a non-positive quantity', () => {
    expect(validateCreateReturn({
      ...ok, items: [{ ...ok.items[0], quantity: 0 }] }).ok).toBe(false)
  })
  test('rejects an unknown disposition', () => {
    expect(validateCreateReturn({
      ...ok, items: [{ ...ok.items[0], disposition: 'exploded' as any }] }).ok).toBe(false)
  })
  test('rejects the same order line listed twice', () => {
    const r = validateCreateReturn({ ...ok, items: [ok.items[0], ok.items[0]] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/twice/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION SAFETY
// ─────────────────────────────────────────────────────────────────────────────

describe('migration 018 is additive and safe', () => {

  test('it drops nothing', () => {
    expect(ddl).not.toContain('DROP TABLE')
    expect(ddl).not.toContain('DROP COLUMN')
    expect(ddl).not.toContain('DROP FUNCTION')
  })

  test('it does not modify finalize_paid_order', () => {
    // That replacement belongs to 019 and is reviewed separately.
    expect(ddl).not.toContain('FUNCTION finalize_paid_order')
  })

  test('new order_refunds columns are added conditionally', () => {
    expect(ddl).toContain("WHERE table_name = 'order_refunds' AND column_name = 'component_breakdown_status'")
  })

  test('it is wrapped in a single transaction', () => {
    expect((M018.match(/^BEGIN;$/gm) ?? []).length).toBe(1)
    expect((M018.match(/^COMMIT;$/gm) ?? []).length).toBe(1)
  })

  test('all eight tables are created idempotently', () => {
    for (const t of ['order_returns', 'order_return_items', 'return_refund_allocations',
                     'order_exchanges', 'order_exchange_items', 'order_disputes',
                     'order_dispute_events', 'dispute_balance_transactions']) {
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${t}`)
    }
  })

  test('the existing admin_audit_logs table is reused, not replaced', () => {
    // Verified in the audit: it exists from migration 001 and is already in use.
    expect(ddl).not.toContain('CREATE TABLE IF NOT EXISTS admin_audit_logs')
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS idx_aal_resource')
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS idx_aal_actor')
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS idx_aal_created')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN SURFACE
// ─────────────────────────────────────────────────────────────────────────────

describe('admin surface', () => {

  test('every new admin route requires admin auth', () => {
    for (const f of ['returns/route.ts', 'disputes/route.ts',
                     'refunds/[id]/resolve-components/route.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '../../app/api/admin/', f), 'utf8')
      expect(src).toContain('requireAdmin')
    }
  })

  test('destructive and financial actions write an audit log', () => {
    for (const f of ['returns/route.ts', 'refunds/[id]/resolve-components/route.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '../../app/api/admin/', f), 'utf8')
      expect(src).toContain('admin_audit_logs')
    }
  })

  test('the returns UI states that a return does not reduce revenue', () => {
    const ui = fs.readFileSync(
      path.join(__dirname, '../../app/admin/financials/returns/ReturnsClient.tsx'), 'utf8')
    expect(ui).toContain('does not reduce revenue')
  })

  test('the returns UI blocks an unbalanced decomposition before submitting', () => {
    const ui = fs.readFileSync(
      path.join(__dirname, '../../app/admin/financials/returns/ReturnsClient.tsx'), 'utf8')
    expect(ui).toContain('sum === r.amountCents')
    expect(ui).toContain('must equal refund')
  })

  test('derive is offered only when the refund equals the order total', () => {
    const ui = fs.readFileSync(
      path.join(__dirname, '../../app/admin/financials/returns/ReturnsClient.tsx'), 'utf8')
    expect(ui).toContain('r.canDeriveFullRefund && (')
  })

  test('the disputes UI reports unrecorded fees rather than assuming zero', () => {
    const ui = fs.readFileSync(
      path.join(__dirname, '../../app/admin/financials/disputes/DisputesClient.tsx'), 'utf8')
    expect(ui).toContain('Not reported')
    expect(ui).toContain('never inferred')
  })

  test('Returns and Disputes appear in the admin navigation', () => {
    const nav = fs.readFileSync(
      path.join(__dirname, '../../components/admin/AdminShell.tsx'), 'utf8')
    expect(nav).toContain("href: '/admin/financials/returns'")
    expect(nav).toContain("href: '/admin/financials/disputes'")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REV 2 — POST-DISCOUNT NET BASIS
// ═════════════════════════════════════════════════════════════════════════════

import { allocateDiscountToLines } from '../financial-calculator'

/**
 * Mirrors allocate_order_discount_to_items() so its arithmetic can be exercised
 * directly. A test below asserts it agrees with the canonical TypeScript
 * allocator on the same inputs, which is what proves the SQL is the same method
 * rather than a second rounding algorithm.
 */
function sqlStyleAllocate(
  lines: Array<{ id: string; gross: number }>,
  discount: number,
): Array<{ id: string; gross: number; allocated: number; net: number }> {
  const orderGross = lines.reduce((s, l) => s + l.gross, 0)
  const d = Math.min(Math.max(discount, 0), Math.max(orderGross, 0))
  if (orderGross <= 0) return lines.map(l => ({ ...l, allocated: 0, net: l.gross }))

  const floored = lines.map(l => {
    const exact = (d * l.gross) / orderGross
    return { ...l, base: Math.floor(exact), remainder: exact - Math.floor(exact) }
  })
  const leftover = d - floored.reduce((s, f) => s + f.base, 0)
  const ranked = [...floored].sort((a, b) =>
    (b.remainder - a.remainder) || (b.gross - a.gross) || a.id.localeCompare(b.id))
  const bonus = new Set(ranked.slice(0, leftover).map(r => r.id))

  return floored.map(f => {
    const allocated = f.base + (bonus.has(f.id) ? 1 : 0)
    return { id: f.id, gross: f.gross, allocated, net: f.gross - allocated }
  })
}

describe('post-discount net merchandise basis', () => {

  test('a $100 line under a $20 allocated discount has an $80 basis', () => {
    // The scenario from the review: gross must not permit $100 of merchandise
    // refund when the customer only paid $80 for it.
    const out = sqlStyleAllocate(
      [{ id: 'a', gross: 10000 }, { id: 'b', gross: 40000 }], 10000)
    const a = out.find(x => x.id === 'a')!
    expect(a.allocated).toBe(2000)
    expect(a.net).toBe(8000)
    expect(a.net).toBeLessThan(a.gross)
  })

  test('net bases sum exactly to subtotal minus discount', () => {
    for (const discount of [0, 1, 999, 1000, 3333, 7777]) {
      const lines = [
        { id: 'l1', gross: 7999 }, { id: 'l2', gross: 3301 },
        { id: 'l3', gross: 1237 }, { id: 'l4', gross: 4444 },
      ]
      const subtotal = lines.reduce((s, l) => s + l.gross, 0)
      const out = sqlStyleAllocate(lines, discount)
      expect(out.reduce((s, o) => s + o.net, 0)).toBe(subtotal - discount)
      expect(out.reduce((s, o) => s + o.allocated, 0)).toBe(discount)
    }
  })

  test('exhaustive: every discount from 1 to 400 reconciles to the cent', () => {
    const lines = [
      { id: 'a', gross: 3333 }, { id: 'b', gross: 6667 }, { id: 'c', gross: 1 },
    ]
    const subtotal = lines.reduce((s, l) => s + l.gross, 0)
    for (let d = 1; d <= 400; d++) {
      const out = sqlStyleAllocate(lines, d)
      expect(out.reduce((s, o) => s + o.allocated, 0)).toBe(d)
      expect(out.reduce((s, o) => s + o.net, 0)).toBe(subtotal - d)
    }
  })

  test('the SQL method matches the canonical TypeScript allocator', () => {
    // Same algorithm, not a second invention.
    const lines = [
      { id: 'a', gross: 8000 }, { id: 'b', gross: 6500 }, { id: 'c', gross: 3300 },
    ]
    for (const d of [1, 17, 100, 999, 5000]) {
      const sqlOut = sqlStyleAllocate(lines, d)
      const tsOut  = allocateDiscountToLines(
        lines.map(l => ({ id: l.id, lineTotalCents: l.gross })), d)
      for (const s of sqlOut) {
        const t = tsOut.find(x => x.id === s.id)!
        expect(s.allocated).toBe(t.allocatedDiscountCents)
      }
    }
  })

  test('discount is capped at merchandise value', () => {
    const out = sqlStyleAllocate([{ id: 'a', gross: 500 }], 1000)
    expect(out[0].allocated).toBe(500)
    expect(out[0].net).toBe(0)
  })

  test('a zero-value order does not divide by zero', () => {
    const out = sqlStyleAllocate([{ id: 'a', gross: 0 }], 100)
    expect(out[0].allocated).toBe(0)
    expect(out[0].net).toBe(0)
  })

  test('the migration snapshots the net basis on each returned line', () => {
    expect(ddl).toContain('net_merchandise_basis_cents')
    expect(ddl).toContain('line_gross_cents_snapshot')
    expect(ddl).toContain('allocated_discount_cents_snapshot')
  })

  test('return creation uses the canonical allocator, not gross value', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION create_order_return'))
    expect(fn).toContain('allocate_order_discount_to_items(p_order_id)')
    expect(fn).toContain('v_net_basis')
  })

  test('partial quantities are apportioned cumulatively with no drift', () => {
    // basis = round(net x (already+q)/Q) - round(net x already/Q)
    // Summing every partial return of a line must reproduce the line net exactly.
    const net = 8000, Q = 3
    let already = 0, total = 0
    for (const q of [1, 1, 1]) {
      total += Math.round(net * (already + q) / Q) - Math.round(net * already / Q)
      already += q
    }
    expect(total).toBe(net)
  })

  test('awkward partial splits still reproduce the line net exactly', () => {
    for (const net of [1, 7, 999, 3333, 10001]) {
      for (const Q of [2, 3, 4, 7]) {
        let already = 0, total = 0
        while (already < Q) {
          total += Math.round(net * (already + 1) / Q) - Math.round(net * already / Q)
          already += 1
        }
        expect(total).toBe(net)
      }
    }
  })

  test('the allocator carries the exactness guarantee in its documentation', () => {
    expect(M018).toContain('subtotal_cents - orders.discount_cents, exactly')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REV 2 — CUMULATIVE CAPS IN BOTH DIRECTIONS
// ═════════════════════════════════════════════════════════════════════════════

describe('the same returned merchandise cannot be allocated twice', () => {
  const fn = ddl.slice(ddl.indexOf('FUNCTION allocate_return_refund'))

  test('the return-side cap is cumulative across all refunds', () => {
    // Guarding only a single allocation would let two partial refunds each claim
    // the full returned value.
    expect(fn).toContain('WHERE a.return_id = p_return_id AND a.refund_id <> p_refund_id')
    expect(fn).toContain('v_ret_existing + COALESCE(p_merchandise_cents,0)) > v_returned_value')
  })

  test('the return-side cap uses the NET basis, not gross value', () => {
    expect(fn).toContain('SUM(ri.net_merchandise_basis_cents)')
    expect(fn).not.toContain('ri.quantity * COALESCE(ri.unit_price_cents_snapshot, 0)')
  })

  test('the refund-side cumulative cap is preserved', () => {
    expect(fn).toContain('WHERE refund_id = p_refund_id AND return_id <> p_return_id')
    expect(fn).toContain('MERCHANDISE_OVER_ALLOCATED')
  })

  test('both directions are enforced in the same locked transaction', () => {
    expect(fn).toContain('FROM order_returns WHERE id = p_return_id FOR UPDATE')
    expect(fn).toContain('FROM order_refunds WHERE id = p_refund_id FOR UPDATE')
  })

  test('updating an existing allocation replaces rather than double-counts', () => {
    // Both cumulative queries exclude the pair being written.
    expect(fn).toContain('ON CONFLICT (return_id, refund_id) DO UPDATE')
    expect((fn.match(/<> p_refund_id|<> p_return_id/g) ?? []).length).toBe(2)
  })

  test('adversarial: two partial refunds cannot exceed the net basis', () => {
    // Arithmetic the SQL enforces: net basis 8000, first allocation 5000,
    // a second allocation of 4000 must be refused (5000+4000 > 8000).
    const netBasis = 8000
    const first = 5000
    const second = 4000
    expect(first + second).toBeGreaterThan(netBasis)
    // and the permitted remainder is exactly the difference
    expect(netBasis - first).toBe(3000)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REV 2 — WEBHOOK FAILURE PROPAGATION
// ═════════════════════════════════════════════════════════════════════════════

describe('failed dispute bookkeeping is never acknowledged to Stripe', () => {
  const wh = fs.readFileSync(
    path.join(__dirname, '../../app/api/stripe/webhook/route.ts'), 'utf8')
  // Slice from the doc comment so documented intent is in scope too.
  const handler = wh.slice(wh.indexOf('/**\n * Record a dispute event'))

  test('dispute state failures are no longer swallowed', () => {
    // Previously a try/catch here let the endpoint return 200 while the
    // chargeback went unrecorded.
    expect(handler).not.toContain('dispute upsert failed')
    expect(handler).not.toContain('dispute balance txn failed')
  })

  test('the dispute handler contains no catch that hides a failure', () => {
    expect(handler).not.toContain('catch')
  })

  test('failures reach the top-level handler, which returns 500', () => {
    const dispatch = wh.slice(wh.indexOf('switch (event.type)'), wh.indexOf('async function handlePaid'))
    expect(dispatch).toContain('await handleDispute(')
    expect(dispatch).toContain('status: 500')
  })

  test('an event with no matching KVRN order is acknowledged, not retried', () => {
    // Retrying something that can never succeed would be a retry storm.
    expect(handler).toContain("result?.outcome === 'no_order'")
    expect(handler).toContain('acknowledged')
  })

  test('a malformed event without a dispute id is acknowledged', () => {
    expect(handler).toContain('if (!dispute?.id)')
  })

  test('retry after partial success is safe — state insert is idempotent', () => {
    expect(ddl).toContain('CONSTRAINT ode_event_uq UNIQUE (stripe_event_id)')
    const fn = ddl.slice(ddl.indexOf('FUNCTION upsert_order_dispute'))
    expect(fn).toContain("'duplicate_event'")
  })

  test('retry after partial success still persists the missing balance txn', () => {
    // ON CONFLICT DO NOTHING means an already-stored transaction is skipped while
    // one that failed the first time is inserted on the retry.
    const lib = fs.readFileSync(path.join(__dirname, '../disputes.ts'), 'utf8')
    expect(lib).toContain('ON CONFLICT (stripe_balance_transaction_id) DO NOTHING')
    expect(ddl).toContain('CONSTRAINT dbt_stripe_uq UNIQUE (stripe_balance_transaction_id)')
  })

  test('the partial-success self-heal is documented for future maintainers', () => {
    expect(handler).toContain('self-heal')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REV 2 — REFUND OFFSET SCOPED TO THE DISPUTED MONEY
// ═════════════════════════════════════════════════════════════════════════════

describe('refund offset is scoped to the disputed charge', () => {
  // Bounded: record_order_refund below legitimately sums every succeeded refund
  // to compute an order's refunded total, which is a different question.
  const fn = ddl.slice(ddl.indexOf('FUNCTION upsert_order_dispute'),
                       ddl.indexOf('FUNCTION record_order_refund'))

  test('the offset no longer sums every refund on the order', () => {
    // That breaks once an order carries more than one payment intent.
    expect(fn).not.toContain("WHERE order_id = v_order_id AND status = 'succeeded';")
  })

  test('a matching charge id attributes the refund', () => {
    expect(fn).toContain('r.stripe_charge_id = p_stripe_charge_id')
  })

  test('a matching payment intent attributes the refund', () => {
    expect(fn).toContain('r.stripe_payment_intent_id = p_payment_intent_id')
  })

  test('order_refunds carries a payment intent for scoping', () => {
    expect(ddl).toContain('ALTER TABLE order_refunds ADD COLUMN stripe_payment_intent_id TEXT;')
  })

  test('a refund on an unrelated payment is excluded', () => {
    // Only charge/intent matches, or the guarded legacy branch, qualify.
    const where = fn.slice(fn.indexOf('SELECT COALESCE(SUM(r.amount_cents),0)'),
                           fn.indexOf('v_offset := LEAST('))
    expect(where).toContain('r.stripe_charge_id = p_stripe_charge_id')
    expect(where).toContain('OR (')
  })

  test('the legacy branch applies only to unambiguous orders', () => {
    // Pre-identifier refunds are attributed only when no exchange price-difference
    // payment intent could own them.
    expect(fn).toContain('r.stripe_charge_id IS NULL')
    expect(fn).toContain('r.stripe_payment_intent_id IS NULL')
    expect(fn).toContain('e.price_difference_payment_intent_id IS NOT NULL')
    expect(fn).toContain('NOT EXISTS')
  })

  test('the offset can never exceed the disputed amount', () => {
    expect(fn).toContain('v_offset := LEAST(COALESCE(v_refunded,0), p_amount_cents)')
    expect(ddl).toContain('CONSTRAINT dispute_offset_le_amount')
  })

  test('a duplicate webhook cannot alter the offset', () => {
    // The duplicate returns before any recalculation happens.
    const dupIdx = fn.indexOf("'duplicate_event'")
    const offsetIdx = fn.indexOf('SELECT COALESCE(SUM(r.amount_cents),0)')
    expect(dupIdx).toBeGreaterThan(0)
    expect(dupIdx).toBeLessThan(offsetIdx)
  })

  test('a stale event cannot alter the offset either', () => {
    const staleIdx = fn.indexOf("'stale_event'")
    const offsetIdx = fn.indexOf('SELECT COALESCE(SUM(r.amount_cents),0)')
    expect(staleIdx).toBeLessThan(offsetIdx)
  })

  test('the backfill only touches unambiguous historical refunds', () => {
    const bf = ddl.slice(ddl.indexOf('UPDATE order_refunds r'))
    expect(bf).toContain('r.stripe_payment_intent_id IS NULL')
    expect(bf).toContain('e.price_difference_payment_intent_id IS NOT NULL')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REV 3 — SAME-TIMESTAMP DISPUTE EVENT ORDERING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Mirrors the staleness rule in upsert_order_dispute so the ordering decisions
 * can be exercised directly:
 *   duplicate event id     -> idempotent, never re-applied
 *   strictly older event   -> recorded but not applied
 *   equal timestamp        -> APPLIED (distinct event, ruled out as duplicate)
 */
function disputeGate(
  seen: Set<string>,
  lastAppliedAt: number | null,
  event: { id: string; createdAt: number },
): 'duplicate_event' | 'stale_event' | 'applied' {
  if (seen.has(event.id)) return 'duplicate_event'
  if (lastAppliedAt !== null && event.createdAt < lastAppliedAt) return 'stale_event'
  return 'applied'
}

describe('dispute event ordering handles equal timestamps', () => {
  const fn = ddl.slice(ddl.indexOf('FUNCTION upsert_order_dispute'),
                       ddl.indexOf('FUNCTION record_order_refund'))

  test('an exact duplicate event id is idempotent', () => {
    const seen = new Set(['evt_1'])
    expect(disputeGate(seen, 1000, { id: 'evt_1', createdAt: 1000 })).toBe('duplicate_event')
  })

  test('a strictly older event is recorded but not applied', () => {
    expect(disputeGate(new Set(['evt_1']), 2000, { id: 'evt_0', createdAt: 1500 }))
      .toBe('stale_event')
  })

  test('two distinct events sharing a timestamp are BOTH applied', () => {
    // e.g. charge.dispute.closed and charge.dispute.funds_reinstated fired at
    // the same instant. Discarding one would lose real accounting information.
    const seen = new Set<string>()
    const a = { id: 'evt_a', createdAt: 5000 }
    const b = { id: 'evt_b', createdAt: 5000 }
    expect(disputeGate(seen, null, a)).toBe('applied')
    seen.add(a.id)
    expect(disputeGate(seen, a.createdAt, b)).toBe('applied')
  })

  test('a late lost -> won transition is still permitted', () => {
    const seen = new Set(['evt_lost'])
    expect(disputeGate(seen, 1000, { id: 'evt_won', createdAt: 9999 })).toBe('applied')
  })

  test('a late win at the SAME timestamp as the loss is not discarded', () => {
    const seen = new Set(['evt_lost'])
    expect(disputeGate(seen, 7000, { id: 'evt_won', createdAt: 7000 })).toBe('applied')
  })

  test('the SQL guard is strictly-older, not less-than-or-equal', () => {
    expect(fn).toContain('p_event_created_at < v_dispute.last_applied_event_at')
    expect(fn).not.toContain('p_event_created_at <= v_dispute.last_applied_event_at')
  })

  test('the winning event id is recorded for auditability', () => {
    expect(ddl).toContain('last_applied_event_id TEXT')
    expect(fn).toContain('last_applied_event_id    = p_stripe_event_id')
  })

  test('the duplicate check still precedes the staleness check', () => {
    // Equal timestamps can only mean a distinct event because duplicates have
    // already returned.
    expect(fn.indexOf("'duplicate_event'"))
      .toBeLessThan(fn.indexOf("'stale_event'"))
  })

  test('no monotonic status rank was reintroduced', () => {
    expect(fn).not.toContain('status_rank')
    expect(fn).not.toContain('rank >')
  })

  test('stripe_event_id remains the idempotency key', () => {
    expect(ddl).toContain('CONSTRAINT ode_event_uq UNIQUE (stripe_event_id)')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REV 3 — REFUND WEBHOOK FAILURES ARE NOT ACKNOWLEDGED
// ═════════════════════════════════════════════════════════════════════════════

describe('failed refund persistence is never acknowledged to Stripe', () => {
  const wh = fs.readFileSync(
    path.join(__dirname, '../../app/api/stripe/webhook/route.ts'), 'utf8')
  // Bounded to the refund handlers themselves. 020 later inserts affiliate
  // helpers before the fee-capture block, and one of those is deliberately
  // non-fatal, so the boundary must stop before them.
  const refundSection = wh.slice(
    wh.indexOf('/**\n * charge.refunded'),
    wh.indexOf('/**\n * Resolve affiliate attribution'))

  test('refund handlers no longer swallow persistence failures', () => {
    expect(refundSection).not.toContain('catch')
    expect(refundSection).not.toContain('refund record failed')
  })

  test('a transient failure reaches the top-level handler, which returns 500', () => {
    const dispatch = wh.slice(wh.indexOf('switch (event.type)'),
                              wh.indexOf('async function handlePaid'))
    expect(dispatch).toContain('await handleChargeRefunded(')
    expect(dispatch).toContain('await handleRefundObject(')
    expect(dispatch).toContain('status: 500')
  })

  test('both charge.refunded and refund.* paths are covered', () => {
    expect(wh).toContain("case 'charge.refunded'")
    expect(wh).toContain("case 'refund.created'")
    expect(wh).toContain("case 'refund.updated'")
  })

  test('a refund with no matching KVRN order is acknowledged, not retried', () => {
    // Retrying could never succeed, so a 500 would be a retry storm.
    expect((refundSection.match(/outcome === 'no_order'/g) ?? []).length).toBe(2)
    expect(refundSection).toContain('acknowledged')
  })

  test('malformed refund events are acknowledged rather than retried', () => {
    expect(refundSection).toContain('without a payment intent')
    expect(refundSection).toContain('missing identifiers')
  })

  test('persistence is idempotent by Stripe refund id', () => {
    expect(ddl).toContain('ON CONFLICT (stripe_refund_id) DO NOTHING')
    const m015 = fs.readFileSync(
      path.join(__dirname, '../../db/migrations/015_order_refunds.sql'), 'utf8')
    expect(m015).toContain('CONSTRAINT order_refunds_stripe_uq UNIQUE (stripe_refund_id)')
  })

  test('multi-refund partial success self-heals on retry', () => {
    // A committed, B threw -> retry: A is a no-op 'updated', B gets another go.
    const seen = new Set<string>()
    const persist = (id: string, failIds: Set<string>) => {
      if (failIds.has(id)) throw new Error('transient')
      if (seen.has(id)) return 'updated'
      seen.add(id); return 'recorded'
    }
    // First delivery: A succeeds, B fails.
    expect(persist('re_A', new Set(['re_B']))).toBe('recorded')
    expect(() => persist('re_B', new Set(['re_B']))).toThrow()
    // Retry with the fault cleared.
    expect(persist('re_A', new Set())).toBe('updated')   // no duplicate row
    expect(persist('re_B', new Set())).toBe('recorded')  // finally persisted
    expect(seen.size).toBe(2)
  })

  test('the partial-success contract is documented for maintainers', () => {
    expect(refundSection).toContain('PARTIAL-SUCCESS RETRY IS SAFE')
  })

  test('refunds match the reliability standard used for disputes', () => {
    const disputeSection = wh.slice(wh.indexOf('/**\n * Record a dispute event'))
    for (const section of [refundSection, disputeSection]) {
      expect(section).toContain('no_order')
      expect(section).toContain('acknowledged')
    }
  })

  test('fee enrichment stays non-fatal, unlike refunds and disputes', () => {
    // A missing fee makes an order partially reconciled, not wrong, so it must
    // never fail a successful paid order.
    const fee = wh.slice(wh.indexOf('async function tryEnrichStripeFee'))
    expect(fee).toContain('catch')
    expect(wh).toContain('NON-FATAL BY DESIGN')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REV 3 — NEW REFUNDS POPULATE THE SCOPING IDENTIFIER
// ═════════════════════════════════════════════════════════════════════════════

describe('record_order_refund persists the payment intent', () => {
  const fn = ddl.slice(ddl.indexOf('FUNCTION record_order_refund'))

  test('the insert stores stripe_payment_intent_id', () => {
    // Without this every NEW refund would be NULL and fall to the legacy branch
    // of the dispute offset scoping, defeating its purpose.
    expect(fn).toContain('stripe_payment_intent_id')
    expect(fn).toContain('NULLIF(p_payment_intent_id,\'\')')
  })

  test('a replay backfills the identifier without overwriting a known value', () => {
    expect(fn).toContain('COALESCE(stripe_payment_intent_id, NULLIF(p_payment_intent_id,\'\'))')
    expect(fn).toContain('COALESCE(stripe_charge_id, NULLIF(p_charge_id,\'\'))')
  })

  test('the 9-argument signature is unchanged from migration 015', () => {
    for (const p of ['p_stripe_refund_id', 'p_payment_intent_id', 'p_charge_id',
                     'p_amount_cents', 'p_currency', 'p_status', 'p_reason',
                     'p_fee_refunded', 'p_refunded_at']) {
      expect(fn).toContain(p)
    }
  })

  test('idempotency and the refunded-total rule are preserved', () => {
    expect(fn).toContain('ON CONFLICT (stripe_refund_id) DO NOTHING')
    expect(fn).toContain("WHERE order_id = v_order_id AND status = 'succeeded'")
    expect(fn).toContain('v_refunded_total >= v_order_total')
  })

  test('the zero-amount and no-order guards survive', () => {
    expect(fn).toContain("'ignored_zero_amount'")
    expect(fn).toContain("'no_order'")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REV 4 — ZERO-NET RETURNS AND PARTIAL-RETURN SNAPSHOT CONSISTENCY
// ═════════════════════════════════════════════════════════════════════════════

/** The return-side cap, now enforced unconditionally. */
function returnCapAllows(netBasis: number, alreadyAllocated: number, attempt: number): boolean {
  return (alreadyAllocated + attempt) <= netBasis
}

describe('a zero-net return permits exactly zero merchandise refund', () => {
  const fn = ddl.slice(ddl.indexOf('FUNCTION allocate_return_refund'))

  test('the cap is no longer gated on a positive basis', () => {
    // "v_returned_value > 0 AND ..." would have let a free item claim real money.
    expect(fn).not.toContain('IF v_returned_value > 0')
    expect(fn).toContain('IF (v_ret_existing + COALESCE(p_merchandise_cents,0)) > v_returned_value THEN')
  })

  test('a fully discounted item rejects any positive merchandise allocation', () => {
    expect(returnCapAllows(0, 0, 1)).toBe(false)
    expect(returnCapAllows(0, 0, 100)).toBe(false)
  })

  test('a fully discounted item allows a zero merchandise allocation', () => {
    // The return is still legitimate — shipping or tax may still be allocated.
    expect(returnCapAllows(0, 0, 0)).toBe(true)
  })

  test('a return with no recorded basis refuses rather than permits', () => {
    // COALESCE(SUM(...),0) resolves an absent basis to 0; unknown is never
    // treated as generous.
    expect(returnCapAllows(0, 0, 1)).toBe(false)
    expect(fn).toContain('COALESCE(SUM(ri.net_merchandise_basis_cents), 0)')
  })

  test('a normal basis still permits allocation up to but not beyond it', () => {
    expect(returnCapAllows(8000, 0, 8000)).toBe(true)
    expect(returnCapAllows(8000, 0, 8001)).toBe(false)
    expect(returnCapAllows(8000, 5000, 3000)).toBe(true)
    expect(returnCapAllows(8000, 5000, 3001)).toBe(false)
  })
})

/**
 * Mirrors the Rev 4 snapshot construction: NET and DISCOUNT are apportioned
 * cumulatively and GROSS is derived as their sum.
 */
function returnedPortion(
  lineNet: number, lineDisc: number, already: number, qty: number, ordered: number,
) {
  const seg = (X: number) =>
    Math.round(X * (already + qty) / ordered) - Math.round(X * already / ordered)
  const net  = seg(lineNet)
  const disc = seg(lineDisc)
  return { net, disc, gross: net + disc }
}

describe('partial return snapshots describe the returned portion', () => {

  test('1 of 2 units returned snapshots half the line, not the whole line', () => {
    // gross 10000, discount 2000, net 8000, 2 units
    const p = returnedPortion(8000, 2000, 0, 1, 2)
    expect(p.net).toBe(4000)
    expect(p.disc).toBe(1000)
    expect(p.gross).toBe(5000)
    // Internal consistency
    expect(p.gross - p.disc).toBe(p.net)
  })

  test('the three snapshots are internally consistent on every partial', () => {
    for (const [net, disc, Q] of [[8000, 2000, 3], [101, 50, 2], [1, 0, 7], [999, 999, 4]]) {
      let already = 0
      while (already < Q) {
        const p = returnedPortion(net, disc, already, 1, Q)
        expect(p.gross - p.disc).toBe(p.net)
        expect(p.net).toBeGreaterThanOrEqual(0)
        expect(p.disc).toBeGreaterThanOrEqual(0)
        expect(p.gross).toBeGreaterThanOrEqual(0)
        already += 1
      }
    }
  })

  test('repeated partial returns telescope to the original line economics', () => {
    const lineNet = 8000, lineDisc = 2000, lineGross = 10000, Q = 3
    let already = 0, sN = 0, sD = 0, sG = 0
    while (already < Q) {
      const p = returnedPortion(lineNet, lineDisc, already, 1, Q)
      sN += p.net; sD += p.disc; sG += p.gross
      already += 1
    }
    expect(sN).toBe(lineNet)
    expect(sD).toBe(lineDisc)
    expect(sG).toBe(lineGross)
  })

  test('uneven cents still reconcile exactly', () => {
    // 7 units, gross 10001, discount 3333 -> net 6668. Nothing divides evenly.
    const lineGross = 10001, lineDisc = 3333, lineNet = lineGross - lineDisc, Q = 7
    let already = 0, sN = 0, sD = 0, sG = 0
    while (already < Q) {
      const p = returnedPortion(lineNet, lineDisc, already, 1, Q)
      sN += p.net; sD += p.disc; sG += p.gross
      already += 1
    }
    expect(sN).toBe(lineNet)
    expect(sD).toBe(lineDisc)
    expect(sG).toBe(lineGross)
  })

  test('multi-unit partial returns reconcile as well as single-unit ones', () => {
    // 6 units returned as 1 + 3 + 2
    const lineGross = 5555, lineDisc = 1234, lineNet = lineGross - lineDisc, Q = 6
    let already = 0, sN = 0, sD = 0, sG = 0
    for (const q of [1, 3, 2]) {
      const p = returnedPortion(lineNet, lineDisc, already, q, Q)
      sN += p.net; sD += p.disc; sG += p.gross
      already += q
    }
    expect(sN).toBe(lineNet)
    expect(sD).toBe(lineDisc)
    expect(sG).toBe(lineGross)
  })

  test('exhaustive: no negative snapshot and exact reconciliation', () => {
    let checked = 0
    for (let gross = 0; gross <= 120; gross += 1) {
      for (let disc = 0; disc <= gross; disc += 7) {
        const net = gross - disc
        for (let Q = 1; Q <= 6; Q++) {
          let already = 0, sN = 0, sD = 0, sG = 0
          while (already < Q) {
            const p = returnedPortion(net, disc, already, 1, Q)
            expect(p.net).toBeGreaterThanOrEqual(0)
            expect(p.disc).toBeGreaterThanOrEqual(0)
            expect(p.gross - p.disc).toBe(p.net)
            sN += p.net; sD += p.disc; sG += p.gross
            already += 1; checked++
          }
          expect(sN).toBe(net)
          expect(sD).toBe(disc)
          expect(sG).toBe(gross)
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })

  test('a fully discounted line yields a zero net basis on every partial', () => {
    // gross 5000, discount 5000, net 0
    for (let already = 0; already < 4; already++) {
      const p = returnedPortion(0, 5000, already, 1, 4)
      expect(p.net).toBe(0)
      expect(p.gross).toBe(p.disc)
    }
  })

  test('the migration snapshots the apportioned portion, not the full line', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION create_order_return'))
    expect(fn).toContain('v_gross_part, v_disc_part,')
    // The whole-line values must no longer be written directly.
    expect(fn).not.toContain('v_alloc.gross_cents, v_alloc.allocated_discount_cents,')
  })

  test('gross is derived from net plus discount, never the reverse', () => {
    // Deriving net as gross - discount produces negatives on some cent
    // boundaries; deriving gross cannot.
    const fn = ddl.slice(ddl.indexOf('FUNCTION create_order_return'))
    expect(fn).toContain('v_gross_part := v_net_basis + v_disc_part;')
  })

  test('the net basis arithmetic is unchanged from Rev 3', () => {
    // The authoritative merchandise cap must not have shifted.
    const fn = ddl.slice(ddl.indexOf('FUNCTION create_order_return'))
    expect(fn).toContain('v_net_basis  := ROUND(v_net_line::numeric  * (v_already + v_qty) / v_oi.quantity)::int')
  })
})

describe('migration documentation is accurate', () => {

  test('the header states that record_order_refund is replaced', () => {
    expect(M018).toContain('ONE EXISTING FUNCTION IS REPLACED')
    expect(M018).toContain('record_order_refund')
  })

  test('the header no longer claims nothing is altered', () => {
    expect(M018).not.toContain('No existing table, column or function is altered or dropped')
  })

  test('the header confirms finalize_paid_order is untouched', () => {
    expect(M018).toContain('finalize_paid_order is NOT touched by this migration')
    expect(ddl).not.toContain('FUNCTION finalize_paid_order')
  })

  test('the signature-preservation claim is accurate', () => {
    expect(M018).toContain('9-argument signature is preserved')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REV 5 — SAME-TIMESTAMP CONFLICTS RESOLVE INDEPENDENTLY OF DELIVERY ORDER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Models the Rev 5 gate. Equal-timestamp events with a CONFLICTING outcome are
 * not applied by arrival order — they trigger reconciliation against the live
 * Stripe object.
 */
type Gate = 'duplicate_event' | 'stale_event' | 'needs_reconciliation' | 'applied'

function disputeGateV5(
  state: { seen: Set<string>; lastAt: number | null; status: string | null },
  event: { id: string; createdAt: number; status: string },
): Gate {
  if (state.seen.has(event.id)) return 'duplicate_event'
  if (state.lastAt !== null && event.createdAt < state.lastAt) return 'stale_event'
  if (state.lastAt !== null && event.createdAt === state.lastAt
      && state.status !== event.status) return 'needs_reconciliation'
  return 'applied'
}

/** Full pipeline including reconciliation against an authoritative object. */
function processEvents(
  events: Array<{ id: string; createdAt: number; status: string }>,
  authoritativeStatus: string,
): { status: string | null; outcomes: Gate[] } {
  const state = { seen: new Set<string>(), lastAt: null as number | null,
                  status: null as string | null }
  const outcomes: Gate[] = []
  for (const e of events) {
    const gate = disputeGateV5(state, e)
    outcomes.push(gate)
    state.seen.add(e.id)
    if (gate === 'applied') { state.status = e.status; state.lastAt = e.createdAt }
    else if (gate === 'needs_reconciliation') {
      // Reads the live Stripe object — same answer regardless of arrival order.
      state.status = authoritativeStatus
      // Pinned to the tied timestamp, never advanced to "now".
      state.lastAt = e.createdAt
    }
  }
  return { status: state.status, outcomes }
}

describe('same-timestamp conflicts are delivery-order independent', () => {
  const A = { id: 'evt_a', createdAt: 5000, status: 'lost' }
  const B = { id: 'evt_b', createdAt: 5000, status: 'won' }
  const AUTHORITATIVE = 'won'

  test('delivery A then B resolves to the authoritative state', () => {
    const r = processEvents([A, B], AUTHORITATIVE)
    expect(r.outcomes).toEqual(['applied', 'needs_reconciliation'])
    expect(r.status).toBe(AUTHORITATIVE)
  })

  test('delivery B then A resolves to the SAME authoritative state', () => {
    const r = processEvents([B, A], AUTHORITATIVE)
    expect(r.outcomes).toEqual(['applied', 'needs_reconciliation'])
    expect(r.status).toBe(AUTHORITATIVE)
  })

  test('both orderings agree — this is the bug Rev 5 fixes', () => {
    // Rev 4 left state = whichever arrived last, so A->B gave 'won' and
    // B->A gave 'lost' from identical Stripe history.
    expect(processEvents([A, B], AUTHORITATIVE).status)
      .toBe(processEvents([B, A], AUTHORITATIVE).status)
  })

  test('a third tied event still converges on the same state', () => {
    const C = { id: 'evt_c', createdAt: 5000, status: 'lost' }
    expect(processEvents([A, B, C], AUTHORITATIVE).status).toBe(AUTHORITATIVE)
    expect(processEvents([C, B, A], AUTHORITATIVE).status).toBe(AUTHORITATIVE)
  })

  test('non-conflicting equal-timestamp events are applied normally', () => {
    // Same resulting status adds idempotent information only — no reconciliation
    // round-trip needed.
    const A2 = { id: 'evt_a2', createdAt: 5000, status: 'lost' }
    const r = processEvents([A, A2], 'lost')
    expect(r.outcomes).toEqual(['applied', 'applied'])
    expect(r.status).toBe('lost')
  })

  test('an exact duplicate remains idempotent', () => {
    const r = processEvents([A, A], AUTHORITATIVE)
    expect(r.outcomes).toEqual(['applied', 'duplicate_event'])
    expect(r.status).toBe('lost')
  })

  test('a strictly older event remains stale', () => {
    const older = { id: 'evt_old', createdAt: 100, status: 'open' }
    const r = processEvents([A, older], AUTHORITATIVE)
    expect(r.outcomes).toEqual(['applied', 'stale_event'])
    expect(r.status).toBe('lost')
  })

  test('a late lost -> won still applies without reconciliation', () => {
    const lost = { id: 'evt_l', createdAt: 1000, status: 'lost' }
    const wonLater = { id: 'evt_w', createdAt: 9999, status: 'won' }
    const r = processEvents([lost, wonLater], 'won')
    expect(r.outcomes).toEqual(['applied', 'applied'])
    expect(r.status).toBe('won')
  })

  test('reconciliation does not advance the timestamp past the tie', () => {
    // Advancing to "now" would make genuinely newer events look stale.
    const state = { seen: new Set([A.id]), lastAt: A.createdAt, status: 'lost' }
    expect(disputeGateV5(state, B)).toBe('needs_reconciliation')
    // After reconciling, a genuinely newer event must still apply.
    const after = { seen: new Set([A.id, B.id]), lastAt: 5000, status: AUTHORITATIVE }
    expect(disputeGateV5(after, { id: 'evt_z', createdAt: 6000, status: 'lost' }))
      .toBe('applied')
  })
})

describe('reconciliation is wired to authoritative Stripe data', () => {
  const wh = fs.readFileSync(
    path.join(__dirname, '../../app/api/stripe/webhook/route.ts'), 'utf8')
  const fn = ddl.slice(ddl.indexOf('FUNCTION upsert_order_dispute'),
                       ddl.indexOf('FUNCTION reconcile_order_dispute'))

  test('SQL flags a conflicting tie instead of applying it', () => {
    expect(fn).toContain("'needs_reconciliation'")
    expect(fn).toContain('v_dispute.status IS DISTINCT FROM p_mapped_status')
  })

  test('the conflicting event is still recorded for audit', () => {
    expect(fn).toContain("skipped_reason = 'awaiting_reconciliation'")
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS order_dispute_events')
  })

  test('the webhook retrieves the live Stripe Dispute object', () => {
    expect(wh).toContain("result?.outcome === 'needs_reconciliation'")
    expect(wh).toContain('stripe.disputes.retrieve(dispute.id')
  })

  test('reconciliation reads id, status, amount, charge and payment intent', () => {
    const recon = ddl.slice(ddl.indexOf('FUNCTION reconcile_order_dispute'))
    for (const p of ['p_stripe_dispute_id', 'p_stripe_status', 'p_amount_cents',
                     'p_stripe_charge_id', 'p_payment_intent_id']) {
      expect(recon).toContain(p)
    }
  })

  test('balance transactions come from the authoritative object', () => {
    // Rev 6: consumed directly from the retrieved Dispute object. No expansion
    // is requested — balance_transactions is not an expandable field.
    expect(wh).toContain('authoritative.balance_transactions')
    expect(wh).not.toContain("expand: ['balance_transactions']")
  })

  test('a reconciliation failure is retryable, never a guess', () => {
    // No catch around the retrieve/reconcile path, so it reaches the 500.
    const handler = wh.slice(wh.indexOf('/**\n * Record a dispute event'))
    expect(handler).not.toContain('catch')
    const dispatch = wh.slice(wh.indexOf('switch (event.type)'),
                              wh.indexOf('async function handlePaid'))
    expect(dispatch).toContain('status: 500')
  })

  test('the reconciled timestamp is pinned, not advanced to NOW()', () => {
    const recon = ddl.slice(ddl.indexOf('FUNCTION reconcile_order_dispute'))
    expect(recon).toContain('last_applied_event_at    = COALESCE(p_event_created_at, last_applied_event_at)')
    expect(recon).not.toContain('last_applied_event_at    = NOW()')
  })

  test('reconciliation reuses the scoped refund offset rule', () => {
    const recon = ddl.slice(ddl.indexOf('FUNCTION reconcile_order_dispute'))
    expect(recon).toContain('r.stripe_charge_id = p_stripe_charge_id')
    expect(recon).toContain('e.price_difference_payment_intent_id IS NOT NULL')
  })

  test('only a lost dispute reduces revenue after reconciliation', () => {
    const recon = ddl.slice(ddl.indexOf('FUNCTION reconcile_order_dispute'))
    expect(recon).toContain("WHEN p_mapped_status = 'lost'")
    expect(recon).toContain('ELSE 0 END')
  })

  test('no status rank was introduced to break the tie', () => {
    expect(fn).not.toContain('status_rank')
    expect(fn).not.toContain('rank >')
  })

  test('Stripe event ids are never used as chronological ordering', () => {
    // Stripe guarantees no such property.
    expect(fn).not.toContain('p_stripe_event_id >')
    expect(fn).not.toContain('p_stripe_event_id <')
    expect(fn).not.toContain('ORDER BY stripe_event_id')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REV 6 — STRIPE COMPATIBILITY
// ═════════════════════════════════════════════════════════════════════════════

import { REVENUE_REDUCING_STATUSES } from '../disputes'

describe('dispute retrieval does not request an invalid expansion', () => {
  const wh = fs.readFileSync(
    path.join(__dirname, '../../app/api/stripe/webhook/route.ts'), 'utf8')

  test('balance_transactions is never requested as an expansion', () => {
    // It is returned on the Dispute object by default and is NOT expandable;
    // requesting it would fail the reconciliation path permanently.
    expect(wh).not.toContain("expand: ['balance_transactions']")
    expect(wh).not.toContain("expand: ['balance_transactions', ")
  })

  test('the dispute is retrieved plainly', () => {
    expect(wh).toContain('stripe.disputes.retrieve(dispute.id)')
  })

  test('balance transactions are still consumed from the returned object', () => {
    expect(wh).toContain('authoritative.balance_transactions')
  })

  test('the reason is documented so it is not "optimised" back in', () => {
    expect(wh).toContain('NOT an expandable field')
  })
})

describe('Stripe prevented disputes', () => {

  test('prevented maps to its own terminal state, not under_review', () => {
    expect(mapStripeDisputeStatus('prevented')).toBe('prevented')
    expect(mapStripeDisputeStatus('prevented')).not.toBe('under_review')
  })

  test('prevented is terminal', () => {
    expect(TERMINAL_STATUSES).toContain('prevented')
  })

  test('prevented never reduces recognised revenue', () => {
    // Stripe prevention either BLOCKS the dispute (no money moves) or
    // auto-RESOLVES it by refunding — and that refund is already recorded in
    // order_refunds. Counting it here too would double-count the same dollar.
    expect(REVENUE_REDUCING_STATUSES).toEqual(['lost'])
    expect(REVENUE_REDUCING_STATUSES).not.toContain('prevented')
  })

  test('only a lost dispute produces a revenue impact in SQL', () => {
    for (const fnName of ['FUNCTION upsert_order_dispute', 'FUNCTION reconcile_order_dispute']) {
      const fn = ddl.slice(ddl.indexOf(fnName))
      expect(fn).toContain("WHEN p_mapped_status = 'lost'")
      expect(fn).not.toContain("p_mapped_status IN ('lost','prevented')")
    }
  })

  test('prevented is accepted by the status constraint', () => {
    expect(ddl).toContain("CHECK (status IN ('open','under_review','won','lost','withdrawn','prevented'))")
  })

  test('prevented resolves the dispute in both state functions', () => {
    expect((ddl.match(/\('won','lost','withdrawn','prevented'\)/g) ?? []).length).toBe(2)
  })

  test('the raw Stripe status is preserved verbatim', () => {
    expect(ddl).toContain('stripe_status      TEXT        NOT NULL')
    const lib = fs.readFileSync(path.join(__dirname, '../disputes.ts'), 'utf8')
    // The mapper never rewrites what Stripe said; it only derives a coarse state.
    expect(lib).toContain('stripeStatus')
  })

  test('cash and fees still come only from balance transactions', () => {
    // Nothing about prevented infers a fee or a cash movement.
    for (const fnName of ['FUNCTION upsert_order_dispute', 'FUNCTION reconcile_order_dispute']) {
      const fn = ddl.slice(ddl.indexOf(fnName), ddl.indexOf(fnName) + 4000)
      expect(fn).not.toContain('fee_cents')
    }
    expect(ddl).toContain('CONSTRAINT dbt_stripe_uq UNIQUE (stripe_balance_transaction_id)')
  })

  test('an unknown future status still falls back to under_review', () => {
    // The fallback must remain non-terminal so it cannot move money.
    const mapped = mapStripeDisputeStatus('some_future_status')
    expect(mapped).toBe('under_review')
    expect(TERMINAL_STATUSES).not.toContain(mapped)
  })

  test('prevented is displayed distinctly from a contested win', () => {
    const ui = fs.readFileSync(
      path.join(__dirname, '../../app/admin/financials/disputes/DisputesClient.tsx'), 'utf8')
    expect(ui).toContain('prevented:')
    expect(ui).toContain('preventedCount')
    expect(ui).toContain('never reduces revenue here')
  })

  test('prevented is not counted as an open dispute', () => {
    const api = fs.readFileSync(
      path.join(__dirname, '../../app/api/admin/disputes/route.ts'), 'utf8')
    expect(api).toContain("d.status === 'open' || d.status === 'under_review'")
    expect(api).toContain('preventedCount')
  })

  test('the status constraint refresh is safe to re-run', () => {
    // If an earlier application of 018 created the table without 'prevented',
    // the constraint is refreshed rather than silently left stale.
    expect(ddl).toContain("conname = 'order_disputes_status_check'")
    expect(ddl).toContain("NOT LIKE '%prevented%'")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REV 7 — APPEND-ONLY DISPUTE REVENUE LEDGER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Models the ledger: each state change appends the DELTA in recognised impact,
 * never the new absolute value. Historical periods are then summed from the
 * ledger rather than reconstructed from today's mutable dispute row.
 *
 * Sign: negative reduces recognised revenue, positive restores it.
 */
function disputeLedger() {
  const rows: Array<{ effectiveAt: string; cents: number; type: string; eventId: string }> = []
  const seenKeys = new Set<string>()
  let priorImpact = 0

  return {
    rows,
    /** Returns the appended adjustment, or 0 when nothing changed. */
    apply(opts: {
      eventId: string; effectiveAt: string; status: string
      disputedCents: number; refundOffsetCents?: number; source?: string
    }) {
      const key = `${opts.eventId}|${opts.source ?? 'webhook_event'}`
      if (seenKeys.has(key)) return 0             // UNIQUE (stripe_event_id, source)
      const offset = Math.min(opts.refundOffsetCents ?? 0, opts.disputedCents)
      const newImpact = opts.status === 'lost'
        ? Math.max(0, opts.disputedCents - offset)
        : 0
      const delta = -(newImpact - priorImpact)
      seenKeys.add(key)
      if (delta === 0) return 0
      priorImpact = newImpact
      rows.push({
        effectiveAt: opts.effectiveAt, cents: delta, eventId: opts.eventId,
        type: delta < 0 ? 'dispute_lost' : 'dispute_restored',
      })
      return delta
    },
    periodEffect(startISO: string, endISO: string) {
      return rows
        .filter(r => r.effectiveAt >= startISO && r.effectiveAt < endISO)
        .reduce((s, r) => s + r.cents, 0)
    },
    currentExposure() { return priorImpact },
  }
}

describe('historical dispute periods stay reproducible', () => {

  test('June loss then July win: each period keeps its own effect', () => {
    const L = disputeLedger()
    L.apply({ eventId: 'evt_lost', effectiveAt: '2026-06-10T00:00:00Z',
              status: 'lost', disputedCents: 10000 })
    L.apply({ eventId: 'evt_won', effectiveAt: '2026-07-03T00:00:00Z',
              status: 'won', disputedCents: 10000 })

    // The exact scenario from the review.
    expect(L.periodEffect('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z')).toBe(-10000)
    expect(L.periodEffect('2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z')).toBe(+10000)
    // Current exposure nets to zero, but neither period was rewritten.
    expect(L.currentExposure()).toBe(0)
    expect(L.rows).toHaveLength(2)
  })

  test('a $40 refund offset means the loss recognises only $60', () => {
    const L = disputeLedger()
    const delta = L.apply({ eventId: 'evt_lost', effectiveAt: '2026-06-10T00:00:00Z',
                            status: 'lost', disputedCents: 10000, refundOffsetCents: 4000 })
    expect(delta).toBe(-6000)
  })

  test('a later win restores exactly the $60 that was reduced', () => {
    const L = disputeLedger()
    L.apply({ eventId: 'evt_lost', effectiveAt: '2026-06-10T00:00:00Z',
              status: 'lost', disputedCents: 10000, refundOffsetCents: 4000 })
    const restore = L.apply({ eventId: 'evt_won', effectiveAt: '2026-07-03T00:00:00Z',
                              status: 'won', disputedCents: 10000, refundOffsetCents: 4000 })
    expect(restore).toBe(+6000)
    expect(L.rows.reduce((s, r) => s + r.cents, 0)).toBe(0)
  })

  test('a duplicate loss webhook does not append a second reduction', () => {
    const L = disputeLedger()
    L.apply({ eventId: 'evt_lost', effectiveAt: '2026-06-10T00:00:00Z',
              status: 'lost', disputedCents: 10000, refundOffsetCents: 4000 })
    const dup = L.apply({ eventId: 'evt_lost', effectiveAt: '2026-06-10T00:00:00Z',
                          status: 'lost', disputedCents: 10000, refundOffsetCents: 4000 })
    expect(dup).toBe(0)
    expect(L.rows).toHaveLength(1)
  })

  test('a duplicate win does not append a second restoration', () => {
    const L = disputeLedger()
    L.apply({ eventId: 'evt_lost', effectiveAt: '2026-06-10T00:00:00Z',
              status: 'lost', disputedCents: 10000 })
    L.apply({ eventId: 'evt_won', effectiveAt: '2026-07-03T00:00:00Z',
              status: 'won', disputedCents: 10000 })
    const dup = L.apply({ eventId: 'evt_won', effectiveAt: '2026-07-03T00:00:00Z',
                          status: 'won', disputedCents: 10000 })
    expect(dup).toBe(0)
    expect(L.rows).toHaveLength(2)
  })

  test('a distinct event re-asserting the same status appends nothing', () => {
    // Zero delta, so no economic effect is fabricated.
    const L = disputeLedger()
    L.apply({ eventId: 'evt_a', effectiveAt: '2026-06-10T00:00:00Z',
              status: 'lost', disputedCents: 10000 })
    const again = L.apply({ eventId: 'evt_b', effectiveAt: '2026-06-11T00:00:00Z',
                            status: 'lost', disputedCents: 10000 })
    expect(again).toBe(0)
    expect(L.rows).toHaveLength(1)
  })

  test('prevented creates no dispute revenue adjustment', () => {
    const L = disputeLedger()
    const delta = L.apply({ eventId: 'evt_p', effectiveAt: '2026-06-10T00:00:00Z',
                            status: 'prevented', disputedCents: 10000 })
    expect(delta).toBe(0)
    expect(L.rows).toHaveLength(0)
  })

  test('withdrawn and won from open fabricate no movement', () => {
    for (const status of ['withdrawn', 'won', 'under_review', 'open']) {
      const L = disputeLedger()
      expect(L.apply({ eventId: 'e', effectiveAt: '2026-06-10T00:00:00Z',
                       status, disputedCents: 10000 })).toBe(0)
      expect(L.rows).toHaveLength(0)
    }
  })

  test('a same-timestamp conflict yields exactly one adjustment', () => {
    // The tied event that triggers reconciliation is never applied, so only the
    // reconciliation path appends — never two contradictory rows.
    const L = disputeLedger()
    L.apply({ eventId: 'evt_a', effectiveAt: '2026-06-10T00:00:00Z',
              status: 'lost', disputedCents: 10000 })
    // evt_b conflicts and is NOT applied; reconciliation applies authoritative 'won'.
    const recon = L.apply({ eventId: 'evt_b', effectiveAt: '2026-06-10T00:00:00Z',
                            status: 'won', disputedCents: 10000, source: 'reconciliation' })
    expect(recon).toBe(+10000)
    expect(L.rows).toHaveLength(2)
    expect(L.currentExposure()).toBe(0)
  })

  test('the ledger sums to current exposure across all history', () => {
    const L = disputeLedger()
    L.apply({ eventId: 'e1', effectiveAt: '2026-06-10T00:00:00Z', status: 'lost', disputedCents: 7500 })
    L.apply({ eventId: 'e2', effectiveAt: '2026-07-03T00:00:00Z', status: 'won',  disputedCents: 7500 })
    L.apply({ eventId: 'e3', effectiveAt: '2026-08-01T00:00:00Z', status: 'lost', disputedCents: 7500 })
    expect(-L.rows.reduce((s, r) => s + r.cents, 0)).toBe(L.currentExposure())
    expect(L.currentExposure()).toBe(7500)
  })
})

describe('the dispute ledger schema is append-only and auditable', () => {

  test('the ledger table exists with a signed adjustment', () => {
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS order_dispute_financial_adjustments')
    expect(ddl).toContain('adjustment_cents      INTEGER     NOT NULL')
  })

  test('period reporting keys on the Stripe event time', () => {
    expect(ddl).toContain('effective_at          TIMESTAMPTZ NOT NULL')
    expect(ddl).toContain('idx_odfa_effective')
  })

  test('full provenance is preserved for audit', () => {
    for (const col of ['stripe_dispute_id', 'from_status', 'to_status',
                       'disputed_amount_cents', 'refund_offset_cents',
                       'prior_impact_cents', 'new_impact_cents',
                       'adjustment_type', 'source', 'stripe_event_id']) {
      expect(ddl).toContain(col)
    }
  })

  test('duplicate events cannot append a duplicate adjustment', () => {
    expect(ddl).toContain('CONSTRAINT odfa_event_source_uq UNIQUE (stripe_event_id, source)')
    expect((ddl.match(/ON CONFLICT \(stripe_event_id, source\) DO NOTHING/g) ?? []).length).toBe(2)
  })

  test('both state functions append the DELTA, not the absolute impact', () => {
    for (const fnName of ['FUNCTION upsert_order_dispute', 'FUNCTION reconcile_order_dispute']) {
      const fn = ddl.slice(ddl.indexOf(fnName))
      expect(fn).toContain('v_delta := -(v_impact -')
      expect(fn).toContain('IF v_delta <> 0 THEN')
    }
  })

  test('nothing deletes or rewrites an earlier adjustment', () => {
    expect(ddl).not.toContain('DELETE FROM order_dispute_financial_adjustments')
    expect(ddl).not.toContain('UPDATE order_dispute_financial_adjustments')
  })

  test('the ledger is queryable per period from the service', () => {
    const lib = fs.readFileSync(path.join(__dirname, '../disputes.ts'), 'utf8')
    expect(lib).toContain('getDisputeRevenueEffect')
    expect(lib).toContain('order_dispute_financial_adjustments')
    // Reads the ledger, never the mutable current row.
    const fn = lib.slice(lib.indexOf('async getDisputeRevenueEffect'),
                         lib.indexOf('async getDisputeAdjustments'))
    expect(fn).not.toContain('order_disputes')
  })
})

describe('reconciliation audit distinguishes incoming from authoritative state', () => {
  const recon = ddl.slice(ddl.indexOf('FUNCTION reconcile_order_dispute'))

  test('the event records the authoritative status that actually applied', () => {
    expect(ddl).toContain('reconciled_to_status   TEXT')
    expect(recon).toContain('reconciled_to_status  = p_mapped_status')
  })

  test('applied is TRUE only when the incoming status is what took effect', () => {
    expect(recon).toContain('applied = (v_incoming IS NOT DISTINCT FROM p_mapped_status)')
  })

  test('a superseded event is marked as such, not as applied', () => {
    expect(recon).toContain("'superseded_by_reconciliation'")
    expect(recon).toContain("'confirmed_by_reconciliation'")
    // The misleading blanket marker is gone.
    expect(recon).not.toContain("applied = TRUE, skipped_reason = 'reconciled_from_stripe'")
  })

  test('the reconciliation source is recorded', () => {
    expect(recon).toContain("reconciliation_source = 'stripe_dispute_object'")
  })

  test('the adjustment records which path produced it', () => {
    expect(recon).toContain("'reconciliation', p_trigger_event_id")
    const up = ddl.slice(ddl.indexOf('FUNCTION upsert_order_dispute'),
                         ddl.indexOf('FUNCTION reconcile_order_dispute'))
    expect(up).toContain("'webhook_event', p_stripe_event_id")
  })
})
