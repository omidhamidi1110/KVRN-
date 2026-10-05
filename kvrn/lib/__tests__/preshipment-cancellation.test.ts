// lib/__tests__/preshipment-cancellation.test.ts
//
// MIGRATION 025 — first-class pre-shipment cancellation of a fully refunded order.
//
// The case that motivated it (live order KVRN-001000): $80 merchandise + $5.98 shipping = $85.98,
// Stripe fee $2.79, landed FIFO COGS $50, NEVER shipped, fully refunded, fee not returned.
// Correct final economics: net revenue $0, product COGS net $0 (the $50 sale COGS stays as a fact
// and a separate $50 cancellation credit offsets it), shipping expense $0 with NO shipment row,
// Stripe fee $2.79, order profit -$2.79, inventory +1 unit, NO fake return, NO fake shipment.
//
//   PART A  pure calculator semantics (no database)
//   PART B  source guards (migration, routes, UI)
//   PART C  real PostgreSQL (local TEST_DATABASE_URL only; see helpers/fi-pg.ts)

import fs from 'fs'
import path from 'path'
import { Client } from 'pg'
import { NextRequest } from 'next/server'
import {
  computeOrderEconomics, computePeriodEconomics, knownSoFarContribution,
  type OrderFinancialInputs,
} from '../financial-calculator'
import { createFinancialService } from '../financials'
import { buildTaxExportRows, taxRowsToCsv } from '../tax-export'
import { CANCEL_ERRORS, validateCancelReason, CancelOrderError, createAdminOrderService } from '../admin-orders'
import {
  HAVE_DB, TEST_DB_URL, createFiDb, pgConfig, dayExpr, dayRange, oid, num, type FiDb,
} from './helpers/fi-pg'

jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => ({ identity: { email: 'cancel@test.local' }, error: null }),
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__CX_SQL } }))

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL
    ? 'NOTE: 025 DB tests skipped — TEST_DATABASE_URL is not a local server.'
    : 'NOTE: 025 real-PostgreSQL tests skipped — TEST_DATABASE_URL absent.', () => {
    expect(true).toBe(true)
  })
}

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// ─────────────────────────────────────────────────────────────────────────────
// PART A — calculator (pure)
// ─────────────────────────────────────────────────────────────────────────────
const live = (over: Partial<OrderFinancialInputs> = {}): OrderFinancialInputs => ({
  subtotalCents: 8000, merchandiseDiscountCents: 0, shippingRevenueCents: 598,
  shippingQuotedCents: 598, shippingPromoDiscountCents: 0, shippingAutoFreeDiscountCents: 0,
  taxCents: 0, cogsCents: 5000, shippingCostCents: 0, stripeFeeCents: 279,
  refundCents: 8598, refundRevenueCents: 8598, refundedFeeCents: 0,
  ...over,
})

describe('A. calculator: the cancellation credit is its own term', () => {
  test('the live order: net revenue 0, net product cost 0, shipping 0, fee 2.79, profit -2.79', () => {
    const e = computeOrderEconomics(live({ cancellationCogsCreditCents: 5000 }))
    expect(e.grossMerchandiseCents).toBe(8000)
    expect(e.shippingRevenueCents).toBe(598)
    expect(e.refundCents).toBe(8598)
    expect(e.netRevenueCents).toBe(0)
    expect(e.cogsCents).toBe(5000)                       // the historical fact is untouched
    expect(e.cancellationCogsCreditCents).toBe(5000)     // the offset is separate
    expect(e.netProductCostCents).toBe(0)
    expect(e.shippingCostCents).toBe(0)
    expect(e.netStripeFeeCents).toBe(279)
    expect(e.contributionProfitCents).toBe(-279)
    expect(e.reconciliation.state).toBe('complete')
    expect(knownSoFarContribution(e)).toBe(-279)
  })

  test('without the credit the sale COGS still weighs on profit (the live bug)', () => {
    expect(computeOrderEconomics(live()).contributionProfitCents).toBe(-5279)
  })

  test('an UNKNOWN credit makes profit UNKNOWN, never zero and never the full COGS', () => {
    const e = computeOrderEconomics(live({ cancellationCogsCreditCents: null }))
    expect(e.contributionProfitCents).toBeNull()
    expect(e.netProductCostCents).toBeNull()
    expect(e.reconciliation.missing.map(m => m.field)).toContain('cancellation_cogs_credit')
    // the floor reading adds no credit rather than inventing one
    expect(knownSoFarContribution(e)).toBe(-5279)
  })

  test('back-compat: omitting the credit changes nothing', () => {
    const e = computeOrderEconomics(live())
    expect(e.cancellationCogsCreditCents).toBe(0)
  })

  test('a return credit and a cancellation credit are each subtracted exactly once', () => {
    const e = computeOrderEconomics(live({
      cogsCents: 10000, returnCogsCreditCents: 3000, cancellationCogsCreditCents: 2000,
    }))
    expect(e.netProductCostCents).toBe(10000 - 3000 - 2000)
    const p = computePeriodEconomics({
      orders: [e, computeOrderEconomics(live({ cancellationCogsCreditCents: 5000 }))],
      recognizedOperatingExpensesCents: 0, recognizedDevelopmentExpensesCents: 0, advertisingSpendCents: 0,
      writeOffCostCents: 0, writeOffCostUnknown: false,
      estimatedAccruedOperatingExpensesCents: 0, projectedOperatingExpensesCents: 0,
    } as any)
    expect(p.cogsCents).toBe(15000)
    expect(p.returnCogsCreditCents).toBe(3000)
    expect(p.cancellationCogsCreditCents).toBe(7000)
  })
})

describe('A. validators', () => {
  test('reason is trimmed, 3..500 chars, no control characters', () => {
    expect(validateCancelReason('  customer asked  ')).toEqual({ ok: true, reason: 'customer asked' })
    for (const bad of [undefined, null, 5, '', '  ', 'ab', 'x'.repeat(501), 'bad\u0000reason', 'new\nline'] as any[]) {
      expect(validateCancelReason(bad).ok).toBe(false)
    }
    expect(validateCancelReason('x'.repeat(500)).ok).toBe(true)
  })
  test('every database refusal code has a status and message; eligibility refusals are 409', () => {
    for (const [code, v] of Object.entries(CANCEL_ERRORS)) {
      expect(v.message.length).toBeGreaterThan(5)
      expect([400, 404, 409]).toContain(v.status)
      if (!/REQUIRED|INVALID|TOO_SHORT|NOT_FOUND/.test(code)) expect(v.status).toBe(409)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PART B — source guards
// ─────────────────────────────────────────────────────────────────────────────
describe('B. migration 025 source', () => {
  const m = read('db/migrations/025_preshipment_refund_cancellation.sql')

  test('exists as 025 and is the newest migration', () => {
    const all = fs.readdirSync(path.join(ROOT, 'db/migrations')).filter(f => /^\d+_/.test(f)).sort()
    expect(all[all.length - 1]).toBe('025_preshipment_refund_cancellation.sql')
  })
  test('never rewrites history: no UPDATE/DELETE of order_items, consumptions, shipments or returns', () => {
    const code = m.replace(/--.*$/gm, '')
    expect(code).not.toMatch(/UPDATE\s+order_items/i)
    expect(code).not.toMatch(/UPDATE\s+inventory_layer_consumptions/i)
    expect(code).not.toMatch(/DELETE\s+FROM/i)
    expect(code).not.toMatch(/INSERT\s+INTO\s+shipments/i)
    expect(code).not.toMatch(/INSERT\s+INTO\s+order_returns/i)
    expect(code).not.toMatch(/INSERT\s+INTO\s+order_return_items/i)
  })
  test('locks the order row first, then variants in id order', () => {
    const fn = m.slice(m.indexOf('CREATE OR REPLACE FUNCTION cancel_fully_refunded_unshipped_order'))
    expect(fn.indexOf('FROM orders WHERE id = p_order_id FOR UPDATE')).toBeGreaterThan(0)
    expect(fn.indexOf('FROM orders WHERE id = p_order_id FOR UPDATE'))
      .toBeLessThan(fn.indexOf('FROM product_variants'))
    expect(fn).toMatch(/ORDER BY id FOR UPDATE/)
  })
  test('append-only triggers and one-per-order / restore-once uniqueness exist', () => {
    expect(m).toMatch(/oc_append_only BEFORE UPDATE OR DELETE ON order_cancellations/)
    expect(m).toMatch(/oci_append_only BEFORE UPDATE OR DELETE ON order_cancellation_items/)
    expect(m).toMatch(/oc_one_per_order UNIQUE \(order_id\)/)
    expect(m).toMatch(/oci_one_restore_per_consumption/)
  })
  test('does not touch earlier migrations (023/024 are frozen, production-applied)', () => {
    expect(m).not.toMatch(/CREATE OR REPLACE FUNCTION batch_receipt_status/)
  })
})

describe('B. routes and UI', () => {
  test('the order PATCH cancel branch is admin-gated, confirmed, and uses the DB function', () => {
    const r = read('app/api/orders/[id]/route.ts')
    expect(r.indexOf('requireAdmin(req)')).toBeLessThan(r.indexOf("requestedStatus === 'cancelled'"))
    expect(r).toMatch(/body\.confirm !== true/)
    expect(r).toMatch(/cancelUnshippedOrder\(id, actor, v\.reason\)/)
    expect(r).not.toMatch(/UPDATE orders SET fulfillment_status\s*=\s*'cancelled'/)
    const svc = read('lib/admin-orders.ts')
    expect(svc).toMatch(/cancel_fully_refunded_unshipped_order\(/)
  })
  test('Admin Orders offers the action only for refunded unfulfilled/processing orders, with a confirmation', () => {
    const u = read('app/admin/orders/AdminOrdersClient.tsx')
    expect(u).toMatch(/Cancel unshipped order &amp; restore inventory|Cancel unshipped order & restore inventory/)
    expect(u).toMatch(/detail\.paymentStatus === 'refunded'/)
    expect(u).toMatch(/window\.confirm\(/)
    expect(u).toMatch(/!detail\.shipment/)
    expect(u).toMatch(/fulfillmentStatus:'cancelled', reason, confirm:true/)
    // a refunded order can no longer be pushed to "shipped" from this screen
    expect(u).toMatch(/detail\.paymentStatus !== 'refunded' && detail\.fulfillmentStatus === 'processing'/)
  })
  test('Returns page records the fee fact: Unknown is not $0, explicit $0 allowed, 409 surfaced', () => {
    const u = read('app/admin/financials/returns/ReturnsClient.tsx')
    expect(u).toMatch(/fee-returned/)
    expect(u).toMatch(/feeRefundedCents: cents/)
    expect(u).toMatch(/Unknown/)
    expect(u).toMatch(/Stripe returned \$0/)
    expect(u).toMatch(/json\.error \?\? 'Could not record the refund fee\.'/)
    expect(u).toMatch(/permanent/)
    const api = read('app/api/admin/returns/route.ts')
    expect(api).toMatch(/listRefundsAwaitingFeeReturn/)
    // the existing endpoint is untouched in shape
    expect(read('app/api/admin/refunds/[id]/fee-returned/route.ts')).toMatch(/record_refund_fee_returned/)
  })
  test('the Financials page and tax export carry the credit as its own line', () => {
    expect(read('app/admin/financials/FinancialsClient.tsx')).toMatch(/Cancelled-order COGS credit/)
    expect(read('lib/tax-export.ts')).toMatch(/Less: cancelled-order COGS credit/)
    expect(read('lib/financials.ts')).toMatch(/FROM order_cancellations k WHERE k\.order_id = o\.id/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PART C — real PostgreSQL
// ─────────────────────────────────────────────────────────────────────────────
let F: FiDb
let dbName = ''
let pgFail: string | null = null
const needDb = () => { if (pgFail) throw new Error('local PostgreSQL unavailable: ' + pgFail) }
const q = (t: string, p: unknown[] = []) => F.q(t, p)

const P2   = 'f2500000-0000-0000-0000-00000000aaaa'
const VA   = 'f2500000-0000-0000-0000-00000000b001'   // 2 units @ $50.00 (the live case)
const VMIX = 'f2500000-0000-0000-0000-00000000b002'   // 1 @ $30.00 then 2 @ $40.01 (mixed-cost FIFO)
const VUNK = 'f2500000-0000-0000-0000-00000000b003'   // 3 units, cost UNKNOWN
const VBIG = 'f2500000-0000-0000-0000-00000000b004'   // 500 units @ $50.00 (scanner tamper tests)
const VBAT = 'f2500000-0000-0000-0000-00000000b005'   // layer linked to a cost batch

beforeAll(async () => {
  if (!HAVE_DB) return
  try {
    F = await createFiDb('kvrn_cx')
    dbName = `kvrn_cx_${process.pid}`
    ;(global as any).__CX_SQL = F.sql
    await q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
             VALUES ($1,'C','C','C25','c25',8000,true)`, [P2])
    const mkVariant = async (id: string, sku: string, layers: Array<[number, number | null]>) => {
      const total = layers.reduce((a, l) => a + l[0], 0)
      await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand)
               VALUES ($1,$2,$3,'Black','#000','M',1,$4)`, [id, P2, sku, total])
      for (const [qty, cost] of layers) {
        await q(`SELECT add_inventory_layer($1,$2,$3,'purchase',NULL,NULL,$4,'jest')`,
          [id, qty, cost, cost === null ? 'unknown' : 'cost_batch'])
      }
    }
    await mkVariant(VA, 'C25-A', [[2, 5000]])
    await mkVariant(VMIX, 'C25-MIX', [[1, 3000], [2, 4001]])
    await mkVariant(VUNK, 'C25-UNK', [[3, null]])
    await mkVariant(VBIG, 'C25-BIG', [[500, 5000]])
    await mkVariant(VBAT, 'C25-BAT', [])
  } catch (e: any) { pgFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { await F?.close() })

interface Sale { n: number; variant: string; qty?: number; fee?: number | null; ship?: number
                 price?: number; daysAgo?: number; fulfillment?: string }
/** A paid order with FIFO sale consumption, COGS snapshot and stock decrement (as finalize_paid_order does). */
async function mkSale(s: Sale) {
  const { n, variant, qty = 1, fee = 279, ship = 598, price = 8000, daysAgo = 5, fulfillment = 'processing' } = s
  const sub = price * qty, total = sub + ship
  await q(`INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,
      payment_status,fulfillment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,
      shipping_quoted_cents,shipping_before_discount_cents,stripe_fee_cents,stripe_fee_source,stripe_balance_transaction_id)
    VALUES ($1,$2,$3,$4,$5,'paid',$9,'usd',$6,$7,0,0,$8,${dayExpr(daysAgo)},$7,$7,$10,$11,$12)`,
    [oid(n), num(n), 'cs_' + num(n), 'pi_' + num(n), 'ch_' + num(n), sub, ship, total, fulfillment,
     fee, fee === null ? null : 'stripe_api', fee === null ? null : 'txn_' + num(n)])
  const item = (await q(`INSERT INTO order_items (order_id,variant_id,sku,product_name,size,color,quantity,unit_price_cents,line_total_cents)
    VALUES ($1,$2,'C25','C25','M','Black',$3,$4,$5) RETURNING id`, [oid(n), variant, qty, price, sub]))[0].id
  const r = (await q(`SELECT consume_inventory_fifo($1,$2,'sale',NULL,$3,$4) AS r`, [variant, qty, oid(n), item]))[0].r
  await q(`UPDATE product_variants SET stock_on_hand = stock_on_hand - $2 WHERE id = $1`, [variant, qty])
  const line = r.total_cost_cents === null || r.total_cost_cents === undefined ? null : Number(r.total_cost_cents)
  await q(`UPDATE order_items SET unit_cogs_cents=$2, line_cogs_cents=$3 WHERE id=$1`,
    [item, line === null ? null : Math.round(line / qty), line])
  return { orderId: oid(n), itemId: item as string, total, fifo: r }
}

// A refund equal to the order total is a full refund and derives; anything else is a partial one.
const total8598 = (_n: number, cents: number) => (cents % 8000 === 598 ? cents : -1)

/** The REAL refund path: record_order_refund (sets payment_status) then derive the component split. */
async function fullRefund(n: number, cents: number, fee: number | null = null) {
  await q(`SELECT record_order_refund($1,$2,$3,$4,'usd','succeeded',NULL,$5,now())`,
    ['re_' + num(n), 'pi_' + num(n), 'ch_' + num(n), cents, fee])
  const id = (await q(`SELECT id FROM order_refunds WHERE stripe_refund_id=$1`, ['re_' + num(n)]))[0].id as string
  // A full refund derives; a partial one needs the admin split (all merchandise here).
  await q(`SELECT resolve_refund_components($1,$2,$3,$4,'jest')`,
    cents === total8598(n, cents) ? [id, null, null, null] : [id, cents, 0, 0])
  return id
}

const cancel = (n: number, reason = 'Customer cancelled before shipment', actor = 'admin@kvrn.shop') =>
  q(`SELECT cancel_fully_refunded_unshipped_order($1,$2,$3) AS r`, [oid(n), actor, reason]).then(r => r[0].r)
const cancelErr = (n: number | string, reason: any = 'Customer cancelled before shipment', actor: any = 'admin@kvrn.shop') =>
  F.err(`SELECT cancel_fully_refunded_unshipped_order($1,$2,$3)`,
        [typeof n === 'number' ? oid(n) : n, actor, reason])

const snap = async (variant: string, n?: number) => ({
  stock: Number((await q(`SELECT stock_on_hand AS s FROM product_variants WHERE id=$1`, [variant]))[0].s),
  layers: Number((await q(`SELECT COUNT(*) AS c FROM inventory_cost_layers WHERE variant_id=$1`, [variant]))[0].c),
  layerUnits: Number((await q(`SELECT COALESCE(SUM(units_remaining),0) AS c FROM inventory_cost_layers WHERE variant_id=$1`, [variant]))[0].c),
  movements: Number((await q(`SELECT COUNT(*) AS c FROM inventory_movements WHERE variant_id=$1 AND movement_type='CANCEL_RESTOCK'`, [variant]))[0].c),
  cancellations: Number((await q(`SELECT COUNT(*) AS c FROM order_cancellations`))[0].c),
  items: Number((await q(`SELECT COUNT(*) AS c FROM order_cancellation_items`))[0].c),
  audits: Number((await q(`SELECT COUNT(*) AS c FROM admin_audit_logs WHERE action='cancel_unshipped_order'`))[0].c),
  fulfillment: n === undefined ? null : (await q(`SELECT fulfillment_status AS f FROM orders WHERE id=$1`, [oid(n)]))[0].f,
})
const findings = (n: number) =>
  q(`SELECT issue_code, state FROM financial_integrity_scan() WHERE order_id=$1 ORDER BY issue_code`, [oid(n)])
const codes = async (n: number) => (await findings(n)).map((f: any) => f.issue_code)
const kc = (e: string) => (e.match(/KVRN_CANCEL\|([A-Z_]+)/) ?? [])[1]

// ── C1: the 19-step scenario ────────────────────────────────────────────────
describeDB('C1. the live case end to end', () => {
  const N = 3001
  const consumptionsOf = async () =>
    JSON.stringify(await q(`SELECT * FROM inventory_layer_consumptions WHERE order_id=$1 ORDER BY id`, [oid(N)]))
  const itemsOf = async () =>
    JSON.stringify(await q(`SELECT * FROM order_items WHERE order_id=$1 ORDER BY id`, [oid(N)]))
  let refundId = '', origConsumptions = '', origItems = ''

  test('1-5. inventory 2 @ $50; paid order sells 1; stock 1; COGS $50; full $85.98 refund resolved', async () => {
    needDb()
    expect((await snap(VA)).stock).toBe(2)
    const s = await mkSale({ n: N, variant: VA, daysAgo: 40 })
    expect(s.total).toBe(8598)
    expect((await snap(VA)).stock).toBe(1)
    const it = (await q(`SELECT unit_cogs_cents u, line_cogs_cents l FROM order_items WHERE order_id=$1`, [oid(N)]))[0]
    expect([it.u, it.l]).toEqual([5000, 5000])
    expect((await q(`SELECT quantity, unit_cost_cents, total_cost_cents FROM inventory_layer_consumptions WHERE order_id=$1`, [oid(N)]))
      .map((r: any) => [r.quantity, r.unit_cost_cents, r.total_cost_cents])).toEqual([[1, 5000, 5000]])
    refundId = await fullRefund(N, 8598)
    const o = (await q(`SELECT payment_status p, fulfillment_status f FROM orders WHERE id=$1`, [oid(N)]))[0]
    expect([o.p, o.f]).toEqual(['refunded', 'processing'])
    origConsumptions = await consumptionsOf(); origItems = await itemsOf()
  })

  test('before: the order is stuck, and the page can say exactly why', async () => {
    needDb()
    const c = await codes(N)
    expect(c).toEqual(expect.arrayContaining([
      'ORDER_SHIPPING_COST_MISSING', 'REFUND_FEE_RETURN_UNKNOWN', 'ORDER_REFUNDED_UNSHIPPED_NOT_CANCELLED']))
    const v = await createFinancialService(F.sql).getOrderFinancialView(oid(N))
    expect(v!.integrity.state).toBe('INCOMPLETE')
    expect(v!.canonical.kind).toBe('unknown')
    // The fee worklist lists it although the refund split is already resolved.
    const w = await (await import('../returns')).createReturnsService(F.sql).listRefundsAwaitingFeeReturn()
    expect(w.map(x => x.id)).toContain(refundId)
    expect((await q(`SELECT component_breakdown_status s FROM order_refunds WHERE id=$1`, [refundId]))[0].s).toBe('resolved')
  })

  test('6. the returned fee is recorded explicitly as 0 (write-once)', async () => {
    needDb()
    const r = (await q(`SELECT record_refund_fee_returned($1,0,'admin@kvrn.shop') AS r`, [refundId]))[0].r
    expect(r.outcome).toBe('recorded')
    expect((await q(`SELECT fee_refunded_cents f FROM order_refunds WHERE id=$1`, [refundId]))[0].f).toBe(0)
  })

  test('7-18. cancel: cancelled, stock 2, $50 layer restored, history unchanged, credit $50, net COGS 0, shipping 0 with no shipment, fee 2.79, profit -2.79, no return, scan clean', async () => {
    needDb()
    const r = await cancel(N)
    expect(r.outcome).toBe('cancelled')
    expect(r.restocked_units).toBe(1)
    expect(r.cogs_credit_cents).toBe(5000)
    expect(r.unknown_cost_units).toBe(0)

    // 8, 9
    expect((await q(`SELECT fulfillment_status f FROM orders WHERE id=$1`, [oid(N)]))[0].f).toBe('cancelled')
    expect((await snap(VA)).stock).toBe(2)
    expect((await snap(VA)).layerUnits).toBe(2)                // SUM(layers) still reconciles to stock

    // 10: a NEW cancellation-restock layer carrying exactly $50 of basis
    const lay = await q(`SELECT source, units_received, units_remaining, unit_landed_cost_cents, cost_basis_source, cancellation_id
                         FROM inventory_cost_layers WHERE source='cancellation_restock' AND variant_id=$1`, [VA])
    expect(lay).toHaveLength(1)
    expect([lay[0].units_received, lay[0].units_remaining, lay[0].unit_landed_cost_cents]).toEqual([1, 1, 5000])
    expect(lay[0].cost_basis_source).toBe('cancellation_snapshot')
    expect(lay[0].cancellation_id).toBe(r.cancellation_id)

    // 11: original sale facts byte-for-byte unchanged
    expect(await consumptionsOf()).toBe(origConsumptions)
    expect(await itemsOf()).toBe(origItems)

    // 12: cancellation credit
    const c = (await q(`SELECT cogs_credit_cents, restocked_units, unknown_cost_units, prior_fulfillment_status,
                               order_total_cents, refunded_cents FROM order_cancellations WHERE order_id=$1`, [oid(N)]))[0]
    expect(c.cogs_credit_cents).toBe(5000)
    expect([c.restocked_units, c.unknown_cost_units, c.prior_fulfillment_status, c.order_total_cents, c.refunded_cents])
      .toEqual([1, 0, 'processing', 8598, 8598])

    // movement: explicit, order-linked, NO return_id
    const mv = await q(`SELECT movement_type, quantity_delta, order_id, return_id, reason FROM inventory_movements
                        WHERE variant_id=$1 AND movement_type='CANCEL_RESTOCK'`, [VA])
    expect(mv).toHaveLength(1)
    expect([mv[0].quantity_delta, mv[0].order_id, mv[0].return_id, mv[0].reason])
      .toEqual([1, oid(N), null, 'preshipment_cancellation'])

    // 13-16: canonical economics
    const v = (await createFinancialService(F.sql).getOrderFinancialView(oid(N)))!
    const e = v.economics
    expect(e.grossMerchandiseCents).toBe(8000)
    expect(e.shippingRevenueCents).toBe(598)
    expect(e.refundCents).toBe(8598)
    expect(e.netRevenueCents).toBe(0)
    expect(e.cogsCents).toBe(5000)                       // historical, still a fact
    expect(e.cancellationCogsCreditCents).toBe(5000)
    expect(e.netProductCostCents).toBe(0)
    expect(e.shippingCostCents).toBe(0)                  // 14: exact $0 ...
    expect((await q(`SELECT COUNT(*)::int c FROM shipments WHERE order_id=$1`, [oid(N)]))[0].c).toBe(0)   // ... with NO shipment row
    expect(e.stripeFeeCents).toBe(279)
    expect(e.netStripeFeeCents).toBe(279)                // 15
    expect(e.contributionProfitCents).toBe(-279)         // 16
    expect(v.integrity.state).toBe('RECONCILED')
    expect(v.canonical).toMatchObject({ kind: 'exact', contributionProfitCents: -279 })

    // 17: no fake return, 18: no cancellation-related (or any) finding for the order or the variant
    expect((await q(`SELECT COUNT(*)::int c FROM order_returns WHERE order_id=$1`, [oid(N)]))[0].c).toBe(0)
    expect((await q(`SELECT COUNT(*)::int c FROM order_return_items`))[0].c).toBe(0)
    expect(await findings(N)).toEqual([])
    expect(await q(`SELECT issue_code FROM financial_integrity_scan() WHERE entity_id=$1`, [VA])).toEqual([])
    expect(await q(`SELECT * FROM reconcile_inventory_layers() WHERE variant_id=$1`, [VA])).toEqual([])

    // audit row: ids/counts/amounts, no PII
    const a = (await q(`SELECT actor_email, resource, resource_id, payload FROM admin_audit_logs WHERE action='cancel_unshipped_order'`))
    expect(a).toHaveLength(1)
    expect(a[0].resource).toBe('order_cancellation')
    expect(a[0].resource_id).toBe(r.cancellation_id)
    expect(a[0].payload).toMatchObject({ order_id: oid(N), restocked_units: 1, cogs_credit_cents: 5000, refunded_cents: 8598 })
    expect(JSON.stringify(a[0].payload)).not.toMatch(/@/)          // no e-mail / customer data
  })

  test('period report and tax export recognise the credit exactly once, cent-exact', async () => {
    needDb()
    const rep = await createFinancialService(F.sql).getPeriodReport(dayRange(40))
    const p = rep.period
    expect(p.orderCount).toBe(1)
    expect([p.grossMerchandiseCents, p.shippingRevenueCents, p.refundCents, p.netRevenueCents])
      .toEqual([8000, 598, 8598, 0])
    expect([p.cogsCents, p.cancellationCogsCreditCents, p.returnCogsCreditCents]).toEqual([5000, 5000, 0])
    expect(p.shippingCostCents).toBe(0)
    expect(p.stripeFeeCents).toBe(279)
    expect(p.contributionProfitCents).toBe(-279)
    expect(rep.integrity.state).toBe('RECONCILED')
    const rows = buildTaxExportRows({
      year: 2026, generatedAt: '2026-10-04T00:00:00.000Z', now: new Date('2026-10-04T00:00:00Z'),
      period: p, orders: rep.orders as any, integrity: rep.integrity,
      writeOffUnknown: false, cashRefundsPaidCents: 8598, cashExpensePaymentsCents: 0, fixedDefinitionsWithoutPaidBill: 0,
    })
    const line = rows.find(r => r.line === 'Less: cancelled-order COGS credit')!
    expect(line).toMatchObject({ amountCents: 5000, status: 'COMPLETE' })
    expect(rows.find(r => r.line === 'Product COGS recognized')).toMatchObject({ amountCents: 5000 })
    expect(taxRowsToCsv(rows)).toContain('Less: cancelled-order COGS credit')
  })

  test('19. retrying changes nothing: same stock, layers, movements, credits and audit rows', async () => {
    needDb()
    const before = await snap(VA, N)
    const r1 = await cancel(N)
    const r2 = await cancel(N)
    expect(r1.outcome).toBe('already_cancelled')
    expect(r2.outcome).toBe('already_cancelled')
    expect(r1.cancellation_id).toBe(r2.cancellation_id)
    expect(await snap(VA, N)).toEqual(before)
    expect(before).toMatchObject({ stock: 2, layers: 2, movements: 1, cancellations: 1, items: 1, audits: 1, fulfillment: 'cancelled' })
    // a conflicting repeat is refused loudly and also changes nothing
    expect(kc(await cancelErr(N, 'A different reason entirely'))).toBe('ALREADY_CANCELLED_DIFFERENT_REASON')
    expect(await snap(VA, N)).toEqual(before)
    // the fee fact stays write-once
    expect(await F.err(`SELECT record_refund_fee_returned($1,5,'x')`, [refundId])).toMatch(/FEE_ALREADY_RECORDED/)
  })

  test('the cancellation record is append-only', async () => {
    needDb()
    for (const stmt of [
      `UPDATE order_cancellations SET reason='edited reason'`,
      `DELETE FROM order_cancellations`,
      `TRUNCATE order_cancellations`,
      `UPDATE order_cancellation_items SET quantity = quantity`,
      `DELETE FROM order_cancellation_items`,
      `TRUNCATE order_cancellation_items`,
      // (TRUNCATE of the parent is refused by its FK first; the items table has no referrer, so its trigger answers)
  ]) expect(await F.err(stmt)).toMatch(/KVRN_CANCEL\|APPEND_ONLY|cannot truncate a table referenced/)
    // and a sale COGS snapshot can still never be rewritten
    expect(await F.err(`UPDATE order_items SET unit_cogs_cents=0, line_cogs_cents=0 WHERE order_id=$1`, [oid(N)]))
      .toMatch(/SNAPSHOT_IMMUTABLE/)
  })
})

// ── C2: refusals ────────────────────────────────────────────────────────────
describeDB('C2. ineligible orders are refused loudly and nothing changes', () => {
  const expectRefusal = async (n: number, variant: string, code: string,
                               reason = 'Customer cancelled before shipment') => {
    const before = await snap(variant, n)
    expect(kc(await cancelErr(n, reason))).toBe(code)
    expect(await snap(variant, n)).toEqual(before)
  }

  test('paid but NOT refunded', async () => {
    needDb()
    await mkSale({ n: 3101, variant: VBIG })
    await expectRefusal(3101, VBIG, 'NOT_REFUNDED')
  })
  test('a PARTIAL refund cannot cancel or restock (status stays paid)', async () => {
    needDb()
    await mkSale({ n: 3102, variant: VBIG })
    await fullRefund(3102, 4000)
    expect((await q(`SELECT payment_status p FROM orders WHERE id=$1`, [oid(3102)]))[0].p).toBe('paid')
    await expectRefusal(3102, VBIG, 'NOT_REFUNDED')
  })
  test('a PARTIAL refund cannot cancel even if payment_status is wrongly "refunded"', async () => {
    needDb()
    await mkSale({ n: 3103, variant: VBIG })
    await fullRefund(3103, 4000)
    await q(`UPDATE orders SET payment_status='refunded' WHERE id=$1`, [oid(3103)])
    await expectRefusal(3103, VBIG, 'PARTIAL_REFUND')
  })
  test('refunds that EXCEED the total are refused', async () => {
    needDb()
    await mkSale({ n: 3104, variant: VBIG })
    await fullRefund(3104, 8598)
    await q(`INSERT INTO order_refunds (order_id,stripe_refund_id,amount_cents,status,component_breakdown_status,fee_refunded_cents)
             VALUES ($1,'re_extra_3104',100,'succeeded','unknown',0)`, [oid(3104)])
    await expectRefusal(3104, VBIG, 'REFUND_EXCEEDS_TOTAL')
  })
  test.each([['shipped', 3105], ['delivered', 3106]])('a %s order cannot cancel or restock', async (status, n) => {
    needDb()
    await mkSale({ n, variant: VBIG, fulfillment: status })
    await fullRefund(n, 8598)
    await q(`INSERT INTO shipments (order_id,tracking_number,carrier,label_cost_cents,cost_source)
             VALUES ($1,'trk','usps',450,'shippo_label')`, [oid(n)])
    await expectRefusal(n, VBIG, 'ALREADY_SHIPPED')
  })
  test('an order with a purchased label / shipment row cannot use this path even when still "processing"', async () => {
    needDb()
    await mkSale({ n: 3107, variant: VBIG })
    await fullRefund(3107, 8598)
    await q(`INSERT INTO shipments (order_id,tracking_number,carrier,label_cost_cents,cost_source)
             VALUES ($1,'trk3107','usps',450,'shippo_label')`, [oid(3107)])
    await expectRefusal(3107, VBIG, 'SHIPMENT_EXISTS')
  })
  test('a quote-only shipment row also blocks it (any shipment is evidence of fulfilment)', async () => {
    needDb()
    await mkSale({ n: 3108, variant: VBIG })
    await fullRefund(3108, 8598)
    await q(`INSERT INTO shipments (order_id,tracking_number,carrier,label_cost_cents,cost_source)
             VALUES ($1,'trk3108','usps',450,'shippo_quote')`, [oid(3108)])
    await expectRefusal(3108, VBIG, 'SHIPMENT_EXISTS')
  })
  test('already "cancelled" by hand with no cancellation record is refused (not silently restocked)', async () => {
    needDb()
    await mkSale({ n: 3109, variant: VBIG })
    await fullRefund(3109, 8598)
    await q(`UPDATE orders SET fulfillment_status='cancelled' WHERE id=$1`, [oid(3109)])
    await expectRefusal(3109, VBIG, 'INVALID_FULFILLMENT_STATUS')
  })
  test('an order with a return, an exchange or a dispute is a different case', async () => {
    needDb()
    await mkSale({ n: 3110, variant: VBIG }); await fullRefund(3110, 8598)
    await q(`INSERT INTO order_returns (order_id, return_number) VALUES ($1,'RET-3110')`, [oid(3110)])
    await expectRefusal(3110, VBIG, 'HAS_RETURN')
    await mkSale({ n: 3111, variant: VBIG }); await fullRefund(3111, 8598)
    await q(`INSERT INTO order_exchanges (order_id, exchange_number) VALUES ($1,'EXC-3111')`, [oid(3111)])
    await expectRefusal(3111, VBIG, 'HAS_EXCHANGE')
  })
  test('unknown order and missing order id', async () => {
    needDb()
    expect(kc(await cancelErr('f2110000-0000-0000-0000-00000000dead'))).toBe('ORDER_NOT_FOUND')
    expect(kc(await F.err(`SELECT cancel_fully_refunded_unshipped_order(NULL,'a@b.c','valid reason')`))).toBe('ORDER_REQUIRED')
  })
  test('malformed actor / reason are refused before any lock or write', async () => {
    needDb()
    await mkSale({ n: 3112, variant: VBIG }); await fullRefund(3112, 8598)
    const before = await snap(VBIG, 3112)
    const cases: Array<[any, any, string]> = [
      ['reason ok', null, 'ACTOR_REQUIRED'], ['reason ok', '   ', 'ACTOR_REQUIRED'],
      ['reason ok', 'a'.repeat(255), 'ACTOR_INVALID'], ['reason ok', 'bad\tactor', 'ACTOR_INVALID'],
      [null, 'a@b.c', 'REASON_REQUIRED'], ['   ', 'a@b.c', 'REASON_REQUIRED'], ['ab', 'a@b.c', 'REASON_TOO_SHORT'],
      ['x'.repeat(501), 'a@b.c', 'REASON_INVALID'], ['line\nbreak', 'a@b.c', 'REASON_INVALID'],
    ]
    for (const [reason, actor, code] of cases) expect(kc(await cancelErr(3112, reason, actor))).toBe(code)
    expect(await snap(VBIG, 3112)).toEqual(before)
    expect(before.fulfillment).toBe('processing')
  })
  test('refusals never leave a partial write (no cancellation rows from the refused orders)', async () => {
    needDb()
    expect(Number((await q(`SELECT COUNT(*) c FROM order_cancellations WHERE order_id = ANY($1)`,
      [[3101, 3102, 3103, 3104, 3105, 3106, 3107, 3108, 3109, 3110, 3111, 3112].map(oid)]))[0].c)).toBe(0)
  })
})

// ── C3: concurrency ─────────────────────────────────────────────────────────
describeDB('C3. concurrent / repeated calls cannot double-restock', () => {
  const connect = async () => {
    const { isLocal: _l, ...cfg } = pgConfig(dbName)
    const c = new Client(cfg); await c.connect(); return c
  }

  test('two real connections race: one cancels, one is a no-op; stock +1 once', async () => {
    needDb()
    await mkSale({ n: 3201, variant: VBIG }); await fullRefund(3201, 8598, 0)
    const before = await snap(VBIG, 3201)
    const [a, b] = [await connect(), await connect()]
    try {
      const run = (c: Client) => c.query(`SELECT cancel_fully_refunded_unshipped_order($1,'racer@kvrn.shop','racing cancel') AS r`, [oid(3201)])
      const res = await Promise.all([run(a), run(b)])
      const outcomes = res.map(r => r.rows[0].r.outcome).sort()
      expect(outcomes).toEqual(['already_cancelled', 'cancelled'])
    } finally { await a.end(); await b.end() }
    const after = await snap(VBIG, 3201)
    expect(after.stock).toBe(before.stock + 1)
    expect(after.layers).toBe(before.layers + 1)
    expect(after.movements).toBe(before.movements + 1)
    expect(after.cancellations).toBe(before.cancellations + 1)
    expect(after.audits).toBe(before.audits + 1)
    expect(await codes(3201)).toEqual([])
  })

  test('six simultaneous callers on a mixed-cost order still restock exactly once', async () => {
    needDb()
    await mkSale({ n: 3202, variant: VBIG, qty: 3 }); await fullRefund(3202, 8000 * 3 + 598)
    const before = await snap(VBIG, 3202)
    const cs = await Promise.all([1, 2, 3, 4, 5, 6].map(connect))
    try {
      const res = await Promise.all(cs.map(c =>
        c.query(`SELECT cancel_fully_refunded_unshipped_order($1,'racer@kvrn.shop','six way race') AS r`, [oid(3202)])))
      expect(res.filter(r => r.rows[0].r.outcome === 'cancelled')).toHaveLength(1)
      expect(res.filter(r => r.rows[0].r.outcome === 'already_cancelled')).toHaveLength(5)
    } finally { await Promise.all(cs.map(c => c.end())) }
    const after = await snap(VBIG, 3202)
    expect(after.stock).toBe(before.stock + 3)
    expect(after.cancellations).toBe(before.cancellations + 1)
    expect(after.audits).toBe(before.audits + 1)
  })

  test('a refund racing a cancel cannot slip past the lock', async () => {
    needDb()
    // The cancel must hold the order row; a shipment insert from another session waits or fails the UNIQUE/state guard.
    await mkSale({ n: 3203, variant: VBIG }); await fullRefund(3203, 8598)
    const [a, b] = [await connect(), await connect()]
    try {
      const ship = b.query(`SELECT mark_order_shipped($1,'USPS','TRK3203') AS r`, [oid(3203)])
      const can = a.query(`SELECT cancel_fully_refunded_unshipped_order($1,'racer@kvrn.shop','cancel vs ship') AS r`, [oid(3203)])
      const [s, c] = await Promise.allSettled([ship, can])
      // Exactly one world exists afterwards: either it shipped (cancel refused) or it was cancelled (ship invalid).
      const o = (await q(`SELECT fulfillment_status f FROM orders WHERE id=$1`, [oid(3203)]))[0].f
      const nShip = Number((await q(`SELECT COUNT(*) c FROM shipments WHERE order_id=$1`, [oid(3203)]))[0].c)
      const nCan = Number((await q(`SELECT COUNT(*) c FROM order_cancellations WHERE order_id=$1`, [oid(3203)]))[0].c)
      const coherent = (o === 'shipped' && nShip === 1 && nCan === 0) || (o === 'cancelled' && nShip === 0 && nCan === 1)
      expect({ o, nShip, nCan, coherent }).toMatchObject({ coherent: true })
      void s; void c
    } finally { await a.end(); await b.end() }
  })
})

// ── C4: cost fidelity ───────────────────────────────────────────────────────
describeDB('C4. restored cost mirrors the original FIFO cost exactly', () => {
  test('a mixed-cost sale (1 @ 30.00 + 2 @ 40.01) restores cent-exact as two layers', async () => {
    needDb()
    const s = await mkSale({ n: 3301, variant: VMIX, qty: 3 })
    expect(s.fifo.total_cost_cents).toBe(3000 + 2 * 4001)
    await fullRefund(3301, 8000 * 3 + 598, 0)
    const before = await snap(VMIX)
    const r = await cancel(3301)
    expect(r.restocked_units).toBe(3)
    expect(r.cogs_credit_cents).toBe(11002)
    const lay = await q(`SELECT units_received u, unit_landed_cost_cents c FROM inventory_cost_layers
                         WHERE source='cancellation_restock' AND variant_id=$1 ORDER BY unit_landed_cost_cents`, [VMIX])
    expect(lay.map((l: any) => [l.u, l.c])).toEqual([[1, 3000], [2, 4001]])
    const after = await snap(VMIX)
    expect(after.stock).toBe(before.stock + 3)
    expect(after.layerUnits).toBe(after.stock)
    // one audited movement per variant, covering all three units
    expect((await q(`SELECT quantity_delta d FROM inventory_movements WHERE variant_id=$1 AND movement_type='CANCEL_RESTOCK'`, [VMIX]))
      .map((m: any) => m.d)).toEqual([3])
    expect(await codes(3301)).toEqual([])
    const e = (await createFinancialService(F.sql).getOrderFinancialView(oid(3301)))!.economics
    expect(e.cogsCents).toBe(11002)
    expect(e.netProductCostCents).toBe(0)
  })

  test('UNKNOWN original cost stays unknown: NULL layer, NULL credit, INCOMPLETE, never $0', async () => {
    needDb()
    const s = await mkSale({ n: 3302, variant: VUNK })
    expect(s.fifo.total_cost_cents).toBeNull()
    expect((await q(`SELECT line_cogs_cents l FROM order_items WHERE order_id=$1`, [oid(3302)]))[0].l).toBeNull()
    await fullRefund(3302, 8598, 0)
    const r = await cancel(3302)
    expect(r.cogs_credit_cents).toBeNull()
    expect(r.unknown_cost_units).toBe(1)
    const lay = (await q(`SELECT unit_landed_cost_cents c, cost_basis_source b, units_received u FROM inventory_cost_layers
                          WHERE source='cancellation_restock' AND variant_id=$1`, [VUNK]))[0]
    expect(lay.c).toBeNull(); expect(lay.b).toBe('unknown')
    expect((await q(`SELECT cogs_credit_cents c FROM order_cancellation_items WHERE cancellation_id=$1`, [r.cancellation_id]))[0].c).toBeNull()
    const c = await findings(3302)
    expect(c.map((f: any) => f.issue_code)).toEqual(expect.arrayContaining(['CANCELLATION_RESTOCK_COST_UNKNOWN', 'ORDER_COGS_UNKNOWN']))
    expect(c.filter((f: any) => f.issue_code.startsWith('CANCELLATION_')).every((f: any) => f.state === 'incomplete')).toBe(true)
    const v = (await createFinancialService(F.sql).getOrderFinancialView(oid(3302)))!
    expect(v.economics.cancellationCogsCreditCents).toBeNull()
    expect(v.economics.contributionProfitCents).toBeNull()
    expect(v.integrity.state).toBe('INCOMPLETE')
    expect(v.canonical.kind).toBe('unknown')
    expect((await snap(VUNK)).layerUnits).toBe((await snap(VUNK)).stock)
  })

  test('a cost-batch-linked layer: the restock copies provenance but is NOT a new batch receipt', async () => {
    needDb()
    const b = (await q(`INSERT INTO product_cost_batches (product_id, variant_id, batch_label, manufacturing_cents, units_received, effective_from)
                        VALUES ($1,$2,'CX-BATCH',5000,5,'2026-01-01') RETURNING id`, [P2, VBAT]))[0].id
    await q(`SELECT add_inventory_layer($1,5,5000,'purchase',$2,NULL,'cost_batch','jest')`, [VBAT, b])
    await q(`UPDATE product_variants SET stock_on_hand = 5 WHERE id=$1`, [VBAT])
    await mkSale({ n: 3303, variant: VBAT }); await fullRefund(3303, 8598, 0)
    const status = async () => JSON.stringify(await q(`SELECT * FROM batch_receipt_status() WHERE cost_batch_id=$1`, [b]))
    const before = await status()
    await cancel(3303)
    const lay = (await q(`SELECT cost_batch_id FROM inventory_cost_layers WHERE source='cancellation_restock' AND variant_id=$1`, [VBAT]))[0]
    expect(lay.cost_batch_id).toBe(b)                    // provenance copied
    expect(await status()).toBe(before)                  // received units / capitalised value unchanged
    expect((await q(`SELECT COUNT(*)::int c FROM inventory_batch_receipts WHERE cost_batch_id=$1`, [b]))[0].c).toBe(0)
    expect(await q(`SELECT issue_code FROM financial_integrity_scan() WHERE issue_code='BATCH_CAPITALIZATION_MISMATCH'`)).toEqual([])
    expect(await codes(3303)).toEqual([])
  })

  test('a later sale consumes the restored layer in FIFO order at its original cost', async () => {
    needDb()
    // VA now holds: older layer (1 left) + restored $50 layer. Sell 2 -> both at exactly $50.
    const s = await mkSale({ n: 3304, variant: VA, qty: 2, daysAgo: 41 })
    expect(s.fifo.total_cost_cents).toBe(10000)
    expect((await snap(VA)).layerUnits).toBe((await snap(VA)).stock)
  })
})

// ── C5: the scanner sees every way a cancellation can go wrong ──────────────
describeDB('C5. integrity scanner', () => {
  const replica = async (fn: () => Promise<void>) => {
    await q(`SET session_replication_role = replica`)
    try { await fn() } finally { await q(`SET session_replication_role = DEFAULT`) }
  }
  const mkCancelled = async (n: number, qty = 1) => {
    await mkSale({ n, variant: VBIG, qty }); await fullRefund(n, 8000 * qty + 598, 0)
    const r = await cancel(n); expect(await codes(n)).toEqual([]); return r
  }

  test('a clean cancellation raises nothing; a fully refunded unshipped order left open raises the stuck finding', async () => {
    needDb()
    await mkCancelled(3401)
    await mkSale({ n: 3402, variant: VBIG }); await fullRefund(3402, 8598, 0)
    const f = await findings(3402)
    expect(f.find((x: any) => x.issue_code === 'ORDER_REFUNDED_UNSHIPPED_NOT_CANCELLED')).toMatchObject({ state: 'incomplete' })
    // a partially refunded order is NOT flagged as stuck
    await mkSale({ n: 3403, variant: VBIG }); await fullRefund(3403, 4000, 0)
    expect(await codes(3403)).not.toContain('ORDER_REFUNDED_UNSHIPPED_NOT_CANCELLED')
    // nor is a shipped one
    await mkSale({ n: 3404, variant: VBIG, fulfillment: 'shipped' }); await fullRefund(3404, 8598, 0)
    expect(await codes(3404)).not.toContain('ORDER_REFUNDED_UNSHIPPED_NOT_CANCELLED')
  })

  test('cancellation on an order that is not fully refunded -> EXCEPTION', async () => {
    needDb()
    await mkCancelled(3405)
    await q(`UPDATE orders SET payment_status='paid' WHERE id=$1`, [oid(3405)])
    expect((await findings(3405)).find((x: any) => x.issue_code === 'CANCELLATION_ORDER_NOT_FULLY_REFUNDED')).toMatchObject({ state: 'exception' })
    await q(`UPDATE orders SET payment_status='refunded' WHERE id=$1`, [oid(3405)])
    expect(await codes(3405)).toEqual([])
  })

  test('cancellation on a shipped / delivered order, or one with a shipment -> EXCEPTION', async () => {
    needDb()
    await mkCancelled(3406)
    await q(`UPDATE orders SET fulfillment_status='shipped' WHERE id=$1`, [oid(3406)])
    expect((await findings(3406)).find((x: any) => x.issue_code === 'CANCELLATION_ORDER_SHIPPED')).toMatchObject({ state: 'exception' })
    await q(`UPDATE orders SET fulfillment_status='delivered' WHERE id=$1`, [oid(3406)])
    expect(await codes(3406)).toContain('CANCELLATION_ORDER_SHIPPED')
    await q(`UPDATE orders SET fulfillment_status='cancelled' WHERE id=$1`, [oid(3406)])
    await q(`INSERT INTO shipments (order_id,tracking_number,carrier,label_cost_cents,cost_source) VALUES ($1,'t','usps',1,'manual')`, [oid(3406)])
    expect(await codes(3406)).toContain('CANCELLATION_ORDER_SHIPPED')
    await q(`DELETE FROM shipments WHERE order_id=$1`, [oid(3406)])
    await q(`UPDATE orders SET fulfillment_status='processing' WHERE id=$1`, [oid(3406)])
    expect(await codes(3406)).toContain('CANCELLATION_FULFILLMENT_MISMATCH')
    await q(`UPDATE orders SET fulfillment_status='cancelled' WHERE id=$1`, [oid(3406)])
    expect(await codes(3406)).toEqual([])
  })

  test('restored quantity != sold quantity -> EXCEPTION', async () => {
    needDb()
    await mkCancelled(3407)
    await q(`UPDATE order_items SET quantity = 2, line_total_cents = 16000 WHERE order_id=$1`, [oid(3407)])
    expect(await codes(3407)).toContain('CANCELLATION_QUANTITY_MISMATCH')
    await q(`UPDATE order_items SET quantity = 1, line_total_cents = 8000 WHERE order_id=$1`, [oid(3407)])
    expect(await codes(3407)).toEqual([])
  })

  test('cancellation layer missing -> EXCEPTION', async () => {
    needDb()
    await mkCancelled(3408)
    await replica(async () => { await q(`UPDATE order_cancellation_items SET layer_id=NULL WHERE cancellation_id=(SELECT id FROM order_cancellations WHERE order_id=$1)`, [oid(3408)]) })
    const f = (await findings(3408)).find((x: any) => x.issue_code === 'CANCELLATION_LAYER_MISSING')
    expect(f).toMatchObject({ state: 'exception' })
  })

  test('cancellation movement missing or duplicated -> EXCEPTION', async () => {
    needDb()
    await mkCancelled(3409)
    await q(`INSERT INTO inventory_movements (variant_id,quantity_delta,movement_type,reason,actor_email,order_id)
             VALUES ($1,1,'CANCEL_RESTOCK','duplicate attempt','jest',$2)`, [VBIG, oid(3409)])
    const c = await codes(3409)
    expect(c).toEqual(expect.arrayContaining(['CANCELLATION_DUPLICATE', 'CANCELLATION_MOVEMENT_MISSING']))
    await q(`DELETE FROM inventory_movements WHERE reason='duplicate attempt'`)
    expect(await codes(3409)).toEqual([])
    await replica(async () => { await q(`DELETE FROM inventory_movements WHERE movement_type='CANCEL_RESTOCK' AND order_id=$1`, [oid(3409)]) })
    expect(await codes(3409)).toContain('CANCELLATION_MOVEMENT_MISSING')
  })

  test('COGS credit != restored layer value, or restored cost != original cost -> EXCEPTION', async () => {
    needDb()
    await mkCancelled(3410)
    await replica(async () => {
      await q(`UPDATE inventory_cost_layers SET unit_landed_cost_cents=4900
               WHERE source='cancellation_restock' AND cancellation_id=(SELECT id FROM order_cancellations WHERE order_id=$1)`, [oid(3410)])
    })
    expect(await codes(3410)).toContain('CANCELLATION_COGS_CREDIT_MISMATCH')
    await mkCancelled(3411)
    await replica(async () => {
      await q(`UPDATE inventory_layer_consumptions SET unit_cost_cents=4000, total_cost_cents=4000 WHERE order_id=$1`, [oid(3411)])
    })
    expect(await codes(3411)).toContain('CANCELLATION_COGS_CREDIT_MISMATCH')
  })

  test('a consumption restored twice -> duplicate EXCEPTION (the unique index is the backstop, scan is the witness)', async () => {
    needDb()
    await mkCancelled(3412)
    await q(`DROP INDEX oci_one_restore_per_consumption`)
    try {
      await replica(async () => {
        await q(`INSERT INTO order_cancellation_items (cancellation_id,order_item_id,variant_id,source_consumption_id,quantity,unit_cost_cents,cogs_credit_cents)
                 SELECT cancellation_id,order_item_id,variant_id,source_consumption_id,quantity,unit_cost_cents,cogs_credit_cents
                 FROM order_cancellation_items WHERE cancellation_id=(SELECT id FROM order_cancellations WHERE order_id=$1)`, [oid(3412)])
      })
      expect(await codes(3412)).toContain('CANCELLATION_DUPLICATE')
    } finally {
      await replica(async () => {
        await q(`DELETE FROM order_cancellation_items WHERE layer_id IS NULL AND cancellation_id=(SELECT id FROM order_cancellations WHERE order_id=$1)`, [oid(3412)])
      })
      await q(`CREATE UNIQUE INDEX oci_one_restore_per_consumption ON order_cancellation_items(source_consumption_id) WHERE source_consumption_id IS NOT NULL`)
    }
  })

  test('constraints: a second cancellation row for one order, or a restore twice, is impossible', async () => {
    needDb()
    const first = (await q(`SELECT * FROM order_cancellations LIMIT 1`))[0]
    expect(await F.err(`INSERT INTO order_cancellations (order_id,reason,cancelled_by,prior_fulfillment_status,order_total_cents,refunded_cents,restocked_units,unknown_cost_units,cogs_credit_cents)
                        VALUES ($1,'dup attempt','x','processing',100,100,1,0,0)`, [first.order_id])).toMatch(/oc_one_per_order/)
    expect(await F.err(`INSERT INTO order_cancellations (order_id,reason,cancelled_by,prior_fulfillment_status,order_total_cents,refunded_cents,restocked_units,unknown_cost_units,cogs_credit_cents)
                        VALUES ($1,'bad credit','x','processing',100,100,1,1,50)`, [oid(3101)])).toMatch(/oc_unknown_iff_null_credit/)
  })

  test('the layer source / basis checks admit the new values and still reject garbage', async () => {
    needDb()
    expect(await F.err(`SELECT add_inventory_layer($1,1,5,'bogus_source')`, [VBIG])).toMatch(/icl_source_chk|violates check/)
    expect(await F.err(`SELECT add_inventory_layer($1,1,5,'purchase',NULL,NULL,'bogus_basis')`, [VBIG])).toMatch(/icl_cost_basis_source_chk|violates check/)
    // 'cancellation_restock' without a cancellation id is refused (only the function may make one)
    expect(await F.err(`SELECT add_inventory_layer($1,1,5,'cancellation_restock')`, [VBIG])).toMatch(/icl_cancellation_source_chk/)
  })

  test('the scan stays deterministic and the order state is the worst finding', async () => {
    needDb()
    const h = async () => (await q(`SELECT md5(string_agg(t::text,'|' ORDER BY t::text)) h FROM financial_integrity_scan() t`))[0].h
    expect(await h()).toBe(await h())
  })
})

// ── C6: the real route handlers ─────────────────────────────────────────────
describeDB('C6. routes', () => {
  const patch = async (id: string, body: any) => {
    const { PATCH } = require('../../app/api/orders/[id]/route')
    const res = await PATCH(new NextRequest(`http://localhost/api/orders/${id}`,
      { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id }) })
    return { status: res.status, body: await res.json() }
  }
  const fee = async (id: string, body: any) => {
    const { POST } = require('../../app/api/admin/refunds/[id]/fee-returned/route')
    const res = await POST(new NextRequest(`http://localhost/api/admin/refunds/${id}/fee-returned`,
      { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id }) })
    return { status: res.status, body: await res.json() }
  }

  test('PATCH cancel: validation, confirmation, success, idempotent repeat, refusal codes', async () => {
    needDb()
    await mkSale({ n: 3501, variant: VBIG }); await fullRefund(3501, 8598, 0)
    const id = oid(3501)
    expect((await patch('nope', { fulfillmentStatus: 'cancelled', reason: 'valid reason', confirm: true })).status).toBe(400)
    expect((await patch(id, { fulfillmentStatus: 'cancelled', reason: 'valid reason' })).status).toBe(400)               // no confirm
    expect((await patch(id, { fulfillmentStatus: 'cancelled', reason: 'valid reason', confirm: 'yes' })).status).toBe(400)
    expect((await patch(id, { fulfillmentStatus: 'cancelled', reason: 'no', confirm: true })).status).toBe(400)         // short
    expect((await patch(id, { fulfillmentStatus: 'cancelled', reason: 'valid reason', confirm: true, extra: 1 })).status).toBe(400)
    expect((await snap(VBIG, 3501)).fulfillment).toBe('processing')
    const ok = await patch(id, { fulfillmentStatus: 'cancelled', reason: '  valid reason  ', confirm: true })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ success: true, outcome: 'cancelled' })
    expect(ok.body.data.fulfillmentStatus).toBe('cancelled')
    expect(ok.body.data.cancellation).toMatchObject({ restockedUnits: 1, cogsCreditCents: 5000, reason: 'valid reason', cancelledBy: 'cancel@test.local' })
    const again = await patch(id, { fulfillmentStatus: 'cancelled', reason: 'valid reason', confirm: true })
    expect(again.status).toBe(200)
    expect(again.body.outcome).toBe('already_cancelled')
    const other = await patch(id, { fulfillmentStatus: 'cancelled', reason: 'something else', confirm: true })
    expect([other.status, other.body.code]).toEqual([409, 'ALREADY_CANCELLED_DIFFERENT_REASON'])
    // refusals map to 409 with a stable code and no internals
    await mkSale({ n: 3502, variant: VBIG })
    const r = await patch(oid(3502), { fulfillmentStatus: 'cancelled', reason: 'valid reason', confirm: true })
    expect([r.status, r.body.code]).toEqual([409, 'NOT_REFUNDED'])
    expect(JSON.stringify(r.body)).not.toMatch(/KVRN_CANCEL|SELECT|plpgsql/)
    expect((await patch('f2110000-0000-0000-0000-00000000dead', { fulfillmentStatus: 'cancelled', reason: 'valid reason', confirm: true })).status).toBe(404)
    // unrelated transitions are untouched
    expect((await patch(oid(3502), { fulfillmentStatus: 'bogus' })).status).toBe(400)
    expect((await patch(oid(3502), { fulfillmentStatus: 'processing' })).status).toBe(200)
  })

  test('the service surfaces CancelOrderError for refusals and re-throws unknown errors', async () => {
    needDb()
    await mkSale({ n: 3503, variant: VBIG })
    await expect(createAdminOrderService(F.sql).cancelUnshippedOrder(oid(3503), 'a@b.c', 'valid reason'))
      .rejects.toBeInstanceOf(CancelOrderError)
  })

  test('fee-returned endpoint (unchanged) over a refund whose split is already resolved', async () => {
    needDb()
    await mkSale({ n: 3504, variant: VBIG }); const rid = await fullRefund(3504, 8598)
    expect((await fee(rid, { feeRefundedCents: -1 })).status).toBe(400)
    expect((await fee(rid, { feeRefundedCents: 1.5 })).status).toBe(400)
    expect((await fee(rid, { feeRefundedCents: 300 })).status).toBe(409)                      // > the order's $2.79 fee
    const a = await fee(rid, { feeRefundedCents: 0 })
    expect([a.status, a.body.result.outcome]).toEqual([200, 'recorded'])
    const b = await fee(rid, { feeRefundedCents: 0 })
    expect([b.status, b.body.result.outcome]).toEqual([200, 'already_recorded'])               // same value: harmless
    const c = await fee(rid, { feeRefundedCents: 100 })
    expect(c.status).toBe(409)                                                                  // conflicting: surfaced
    expect(c.body.error).toMatch(/already recorded/)
    expect((await q(`SELECT fee_refunded_cents f FROM order_refunds WHERE id=$1`, [rid]))[0].f).toBe(0)
  })

  test('GET /api/admin/returns lists unknown-fee refunds (even with a resolved split) and drops them once recorded', async () => {
    needDb()
    await mkSale({ n: 3505, variant: VBIG }); const rid = await fullRefund(3505, 8598)
    const { GET } = require('../../app/api/admin/returns/route')
    const list = async () => (await (await GET(new NextRequest('http://localhost/api/admin/returns'))).json())
    const j1 = await list()
    expect(j1.awaitingFee.map((x: any) => x.id)).toContain(rid)
    expect(j1.awaitingBreakdown.map((x: any) => x.id)).not.toContain(rid)       // split resolved, fee still unknown
    expect(j1.awaitingFee.find((x: any) => x.id === rid)).toMatchObject({ orderNumber: num(3505), amountCents: 8598, orderStripeFeeCents: 279 })
    await fee(rid, { feeRefundedCents: 0 })
    const j2 = await list()
    expect(j2.awaitingFee.map((x: any) => x.id)).not.toContain(rid)
  })

  test('the order detail endpoint carries the cancellation (or null)', async () => {
    needDb()
    const { GET } = require('../../app/api/orders/[id]/route')
    const get = async (n: number) => (await (await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: oid(n) }) })).json()).data
    expect((await get(3501)).cancellation).toMatchObject({ restockedUnits: 1 })
    expect((await get(3502)).cancellation).toBeNull()
  })
})

// ── C7: whole-database invariants after everything above ────────────────────
describeDB('C7. global invariants', () => {
  test('SUM(layer units) = stock_on_hand for every variant, and no cancellation finding is an exception', async () => {
    needDb()
    expect(await q(`SELECT * FROM reconcile_inventory_layers()`)).toEqual([])
    const bad = await q(`SELECT issue_code, order_id FROM financial_integrity_scan()
                         WHERE issue_code LIKE 'CANCELLATION\\_%' AND state='exception'
                           AND order_id NOT IN (SELECT order_id FROM order_cancellations WHERE order_id = ANY($1))`,
      [[3405, 3406, 3407, 3408, 3409, 3410, 3411, 3412].map(oid)])
    expect(bad).toEqual([])
  })
  test('no order in this database was given a fabricated return or shipment by a cancellation', async () => {
    needDb()
    const cancelled = (await q(`SELECT order_id FROM order_cancellations`)).map((r: any) => r.order_id)
    expect(cancelled.length).toBeGreaterThan(5)
    expect(Number((await q(`SELECT COUNT(*) c FROM order_returns WHERE order_id = ANY($1) AND return_number NOT LIKE 'RET-%'`, [cancelled]))[0].c)).toBe(0)
    expect(Number((await q(`SELECT COUNT(*) c FROM order_return_items`))[0].c)).toBe(0)
    expect(Number((await q(`SELECT COUNT(*) c FROM shipments s JOIN order_cancellations k ON k.order_id=s.order_id
                            WHERE s.tracking_number IS NULL OR s.tracking_number='cancel'`))[0].c)).toBe(0)
  })
})
