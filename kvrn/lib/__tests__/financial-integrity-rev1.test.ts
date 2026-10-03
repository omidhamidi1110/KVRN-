// lib/__tests__/financial-integrity-rev1.test.ts
//
// REVISION 1 regression suite for the independent audit of the first candidate.
// Every block states a way the books could still LOOK exact while a fact is unknown,
// estimated or contradictory, and asserts the system refuses to hide it.
//
//   BLOCKER 1  unknown refund fee is not zero
//   BLOCKER 2  shipping estimates / partial multi-shipment costs are not exact
//   BLOCKER 3  attribution with no commission row is not a $0 commission
//   BLOCKER 4  "exact" profit is gated by the RELEVANT reconciliation state
//   BLOCKER 5  paid payout lines cannot be re-parented in or out of a paid payout
//   BLOCKER 6  booked expense / ad-spend money is voided, never hard-deleted
//   BLOCKER 7  refunded sales tax does not reduce operating revenue
//   +          exchange replacement shipping cost is DB-level write-once
//
// Real-PostgreSQL blocks run only with a LOCAL TEST_DATABASE_URL (see helpers/fi-pg.ts).

import {
  computeOrderEconomics, type OrderFinancialInputs,
} from '../financial-calculator'
import { createFinancialService } from '../financials'
import { createFinancialIntegrityService } from '../financial-integrity'
import {
  HAVE_DB, TEST_DB_URL, createFiDb, seedCatalog, mkOrder, addShipment, addRefund,
  oid, num, dayRange, dayExpr, ymd, V, type FiDb,
} from './helpers/fi-pg'

const describeDB = HAVE_DB ? describe : describe.skip

if (!HAVE_DB) {
  test(TEST_DB_URL
    ? 'NOTE: REV1 DB tests skipped — TEST_DATABASE_URL is not a local server.'
    : 'NOTE: REV1 real-PostgreSQL tests skipped — TEST_DATABASE_URL absent.', () => {
    expect(true).toBe(true)
  })
}

const base = (over: Partial<OrderFinancialInputs> = {}): OrderFinancialInputs => ({
  subtotalCents: 1000, merchandiseDiscountCents: 0, shippingRevenueCents: 500,
  shippingQuotedCents: 500, shippingPromoDiscountCents: 0, shippingAutoFreeDiscountCents: 0,
  taxCents: 0, cogsCents: 300, shippingCostCents: 450, stripeFeeCents: 100,
  refundCents: 0, refundedFeeCents: 0, ...over,
})

// ─────────────────────────────────────────────────────────────────────────────
// BLOCKER 1 — calculator level (pure)
// ─────────────────────────────────────────────────────────────────────────────
describe('BLOCKER 1 (pure): an unknown refund fee is UNKNOWN, never "keep the whole fee"', () => {
  test('refund fee unknown -> net Stripe fee and contribution are null, and it is named as missing', () => {
    const e = computeOrderEconomics(base({ refundCents: 500, refundedFeeCents: null }))
    expect(e.netStripeFeeCents).toBeNull()
    expect(e.contributionProfitCents).toBeNull()
    expect(e.reconciliation.missing.map(m => m.field)).toContain('refund_fee')
  })
  test('refund fee known -> exact', () => {
    const e = computeOrderEconomics(base({ refundCents: 500, refundedFeeCents: 30 }))
    expect(e.netStripeFeeCents).toBe(70)
    expect(e.contributionProfitCents).toBe(1500 - 500 - (300 + 450 + 70))
  })
  test('Stripe fee itself unknown stays unknown regardless of refund fee', () => {
    expect(computeOrderEconomics(base({ stripeFeeCents: null, refundedFeeCents: 0 })).netStripeFeeCents).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BLOCKER 7 — calculator level (pure)
// ─────────────────────────────────────────────────────────────────────────────
describe('BLOCKER 7 (pure): refunded sales tax reverses the liability, not revenue', () => {
  const taxed = (over: Partial<OrderFinancialInputs> = {}) =>
    base({ taxCents: 100, refundedFeeCents: 0, ...over })

  test('tax=0 behaves exactly as before (total refund reduces revenue)', () => {
    const e = computeOrderEconomics(base({ refundCents: 500 }))
    expect(e.netRevenueCents).toBe(1000)
  })
  test('resolved decomposition: only merchandise + shipping reduce revenue', () => {
    // customer paid 1500 + 100 tax and got ALL of it back (1600), of which 100 is tax
    const e = computeOrderEconomics(taxed({ refundCents: 1600, refundRevenueCents: 1500 }))
    expect(e.netRevenueCents).toBe(0)                 // not -100
    expect(e.refundCents).toBe(1600)                  // total cash refunded stays available
    expect(e.taxCollectedCents).toBe(100)
  })
  test('partial tax refund: a $100 merchandise refund with $10 of its tax', () => {
    const e = computeOrderEconomics(taxed({ refundCents: 110, refundRevenueCents: 100 }))
    expect(e.netRevenueCents).toBe(1500 - 100)
  })
  test('tax > 0 and decomposition UNRESOLVED -> profit is incomplete, the split is never guessed', () => {
    const e = computeOrderEconomics(taxed({ refundCents: 110, refundRevenueCents: null }))
    expect(e.contributionProfitCents).toBeNull()
    expect(e.reconciliation.missing.map(m => m.field)).toContain('refund_revenue_split')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REAL POSTGRESQL
// ─────────────────────────────────────────────────────────────────────────────
let F: FiDb
let pgFail: string | null = null
const needDb = () => { if (pgFail) throw new Error('local PostgreSQL unavailable: ' + pgFail) }
let svc: ReturnType<typeof createFinancialService>
let integ: ReturnType<typeof createFinancialIntegrityService>
const q = (t: string, p: unknown[] = []) => F.q(t, p)

beforeAll(async () => {
  if (!HAVE_DB) return
  try {
    F = await createFiDb('kvrn_fi_rev1')
    await seedCatalog(F.q)
    svc = createFinancialService(F.sql)
    integ = createFinancialIntegrityService(F.sql)
  } catch (e: any) { pgFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { await F?.close() })

/** economics of one order through the PRODUCTION select */
const econ = async (n: number) => (await svc.getOrderEconomics(oid(n)))!.economics
const finding = async (code: string, n: number) =>
  (await q(`SELECT * FROM financial_integrity_scan() WHERE issue_code=$1 AND (order_id=$2 OR entity_id=$2::text)`, [code, oid(n)]))[0]

// ── BLOCKER 1 ────────────────────────────────────────────────────────────────
describeDB('BLOCKER 1 (SQL): refund-fee aggregation', () => {
  test('no refunds: refunded fee is KNOWN zero, so the fee and profit stay exact', async () => {
    needDb()
    await mkOrder(F.q, 101)
    const e = await econ(101)
    expect(e.netStripeFeeCents).toBe(100)
    expect(e.contributionProfitCents).toBe(1500 - (300 + 450 + 100))
  })
  test('a succeeded refund with fee_refunded NULL -> net fee / profit NULL (not "keep the whole fee")', async () => {
    needDb()
    await mkOrder(F.q, 102)
    await addRefund(F.q, 102, 're_102', 500, { fee: null })
    const e = await econ(102)
    expect(e.netStripeFeeCents).toBeNull()
    expect(e.contributionProfitCents).toBeNull()
  })
  test('two refunds, one known and one NULL -> NULL, never the partial sum', async () => {
    needDb()
    await mkOrder(F.q, 103)
    await addRefund(F.q, 103, 're_103a', 200, { fee: 10 })
    await addRefund(F.q, 103, 're_103b', 300, { fee: null })
    const e = await econ(103)
    expect(e.netStripeFeeCents).toBeNull()
    expect(e.contributionProfitCents).toBeNull()
  })
  test('all refund fees known -> exact sum', async () => {
    needDb()
    await mkOrder(F.q, 104)
    await addRefund(F.q, 104, 're_104a', 200, { fee: 10 })
    await addRefund(F.q, 104, 're_104b', 300, { fee: 20 })
    const e = await econ(104)
    expect(e.netStripeFeeCents).toBe(100 - 30)
    expect(e.contributionProfitCents).toBe((1500 - 500) - (300 + 450 + 70))
  })
  test('REFUND_FEE_RETURN_UNKNOWN is INCOMPLETE (was an advisory)', async () => {
    needDb()
    const r = (await q(`SELECT state FROM financial_integrity_scan() WHERE issue_code='REFUND_FEE_RETURN_UNKNOWN' LIMIT 1`))[0]
    expect(r?.state).toBe('incomplete')
  })
  test('a known fee return larger than the original Stripe fee is an EXCEPTION', async () => {
    needDb()
    await mkOrder(F.q, 105, { fee: 100 })
    await addRefund(F.q, 105, 're_105', 500, { fee: 150 })
    const f = await q(`SELECT state FROM financial_integrity_scan() WHERE issue_code='REFUND_FEE_EXCEEDS_ORDER_FEE' AND order_id=$1`, [oid(105)])
    expect(f.length).toBe(1)
    expect(f[0].state).toBe('exception')
  })
})

// ── BLOCKER 2 ────────────────────────────────────────────────────────────────
describeDB('BLOCKER 2 (SQL): shipping cost is exact only when every relevant shipment cost is an actual', () => {
  beforeAll(async () => {
    if (!HAVE_DB || pgFail) return
    // shipments carries UNIQUE(order_id) today (migration 005). Multi-shipment SEMANTICS must
    // still be right if that is ever relaxed, so the multi-row cases relax it in this
    // THROWAWAY database only.
    await q(`ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_v51_order_uq`)
  })
  test('one real label, known actual cost -> exact', async () => {
    needDb()
    await mkOrder(F.q, 111)
    const e = await econ(111)
    expect(e.shippingCostCents).toBe(450)
    expect(e.contributionProfitCents).not.toBeNull()
  })
  test('manual (invoice-entered) cost is an actual -> exact', async () => {
    needDb()
    await mkOrder(F.q, 112, { labelSource: 'manual' })
    expect((await econ(112)).shippingCostCents).toBe(450)
  })
  test('quote-only shipment (shippo_quote) is an ESTIMATE -> shipping cost and profit are NULL', async () => {
    needDb()
    await mkOrder(F.q, 113, { labelSource: 'shippo_quote' })
    const e = await econ(113)
    expect(e.shippingCostCents).toBeNull()
    expect(e.contributionProfitCents).toBeNull()
    expect((await finding('ORDER_SHIPPING_COST_ESTIMATE_ONLY', 113))?.state).toBe('incomplete')
  })
  test('two shipments, one actual + one NULL -> NULL, not the partial sum', async () => {
    needDb()
    await mkOrder(F.q, 114)
    await addShipment(F.q, 114, null, null, 'trk114b')
    const e = await econ(114)
    expect(e.shippingCostCents).toBeNull()
    expect(e.contributionProfitCents).toBeNull()
  })
  test('two actual shipments -> exact sum', async () => {
    needDb()
    await mkOrder(F.q, 115)
    await addShipment(F.q, 115, 200, 'shippo_label', 'trk115b')
    const e = await econ(115)
    expect(e.shippingCostCents).toBe(650)
    expect(e.contributionProfitCents).toBe(1500 - (300 + 650 + 100))
  })
  test('first shipment clean, LATER shipment NULL -> the scan still reports it', async () => {
    needDb()
    await mkOrder(F.q, 116)
    await addShipment(F.q, 116, null, null, 'trk116b')
    expect((await finding('ORDER_SHIPPING_COST_MISSING', 116))?.state).toBe('incomplete')
  })
  test('first shipment clean, LATER shipment quote-only -> the scan still reports it', async () => {
    needDb()
    await mkOrder(F.q, 117)
    await addShipment(F.q, 117, 200, 'shippo_quote', 'trk117b')
    expect((await finding('ORDER_SHIPPING_COST_ESTIMATE_ONLY', 117))?.state).toBe('incomplete')
  })
  test('cancelled order with NO shipment: no label was ever bought, shipping expense is a known 0', async () => {
    needDb()
    await mkOrder(F.q, 118, { label: null, fulfillment: 'cancelled' })
    const e = await econ(118)
    expect(e.shippingCostCents).toBe(0)
    expect(await finding('ORDER_SHIPPING_COST_MISSING', 118)).toBeUndefined()
  })
  test('paid but UNSHIPPED (no shipment yet) is still unknown — a future expense is not invented as 0', async () => {
    needDb()
    await mkOrder(F.q, 119, { label: null, fulfillment: 'unfulfilled' })
    expect((await econ(119)).shippingCostCents).toBeNull()
    expect((await finding('ORDER_SHIPPING_COST_MISSING', 119))?.state).toBe('incomplete')
  })
  test('customer shipping revenue stays separate from merchant shipping cost', async () => {
    needDb()
    const e = await econ(111)
    expect(e.shippingRevenueCents).toBe(500)
    expect(e.shippingMarginCents).toBe(50)
  })
})

// ── BLOCKER 3 ────────────────────────────────────────────────────────────────
describeDB('BLOCKER 3 (SQL): affiliate commission is 0 only when there is no obligation', () => {
  let aid: string
  const attribute = async (n: number) => {
    await q(`UPDATE orders SET discount_code='F21A' WHERE id=$1`, [oid(n)])
    return (await q(`SELECT resolve_order_affiliate_attribution($1,NULL,'s') AS r`, [oid(n)]))[0].r
  }
  beforeAll(async () => {
    if (!HAVE_DB || pgFail) return
    aid = (await q(`SELECT create_affiliate('F21A','F21 Affiliate',NULL::text,'percentage',1000,NULL::integer,'proportional',30,0,NULL::uuid,NULL::text,'admin') AS r`))[0].r.affiliate_id
    await q(`UPDATE affiliates SET created_at = NOW()-INTERVAL '365 days' WHERE id=$1`, [aid])
    await q(`UPDATE affiliate_terms_events SET effective_at = NOW()-INTERVAL '365 days' WHERE affiliate_id=$1`, [aid])
    await q(`UPDATE affiliate_status_events SET effective_at = NOW()-INTERVAL '365 days' WHERE affiliate_id=$1`, [aid])
  })
  test('no attribution at all -> 0, exact', async () => {
    needDb()
    await mkOrder(F.q, 121)
    expect((await econ(121)).affiliateCommissionCents).toBe(0)
  })
  test('valid attribution + commission -> the exact ledger amount', async () => {
    needDb()
    await mkOrder(F.q, 122)
    await attribute(122)
    expect((await econ(122)).affiliateCommissionCents).toBe(100)
  })
  test('attribution but its commission row is MISSING -> NULL / incomplete (not a $0 expense)', async () => {
    needDb()
    await mkOrder(F.q, 123)
    await attribute(123)
    await q(`ALTER TABLE affiliate_commissions DISABLE TRIGGER USER`)
    await q(`DELETE FROM affiliate_commission_adjustments WHERE commission_id IN (SELECT id FROM affiliate_commissions WHERE order_id=$1)`, [oid(123)])
    await q(`DELETE FROM affiliate_commissions WHERE order_id=$1`, [oid(123)])
    await q(`ALTER TABLE affiliate_commissions ENABLE TRIGGER USER`)
    const e = await econ(123)
    expect(e.affiliateCommissionCents).toBeNull()
    expect(e.contributionProfitCents).toBeNull()
    expect((await finding('AFFILIATE_ATTRIBUTION_WITHOUT_COMMISSION', 123))?.state).toBe('incomplete')
  })
  test('unresolved commission source (refund with unknown decomposition) -> NULL / incomplete', async () => {
    needDb()
    await mkOrder(F.q, 124)
    await attribute(124)
    await addRefund(F.q, 124, 're_124', 300, { resolved: false, fee: 0 })
    const e = await econ(124)
    expect(e.affiliateCommissionCents).toBeNull()
    expect(e.contributionProfitCents).toBeNull()
  })
  test('commission flagged incomplete -> NULL / incomplete', async () => {
    needDb()
    await mkOrder(F.q, 125)
    await attribute(125)
    await q(`UPDATE affiliate_commissions SET incomplete=true, incomplete_reason='test' WHERE order_id=$1`, [oid(125)])
    expect((await econ(125)).affiliateCommissionCents).toBeNull()
  })
  test('a legitimate $0 commission (rounds to zero) stays a KNOWN 0 and the order stays exact', async () => {
    needDb()
    const a2 = (await q(`SELECT create_affiliate('F21Z','F21 Zero',NULL::text,'percentage',1,NULL::integer,'proportional',30,0,NULL::uuid,NULL::text,'admin') AS r`))[0].r.affiliate_id
    await q(`UPDATE affiliates SET created_at = NOW()-INTERVAL '365 days' WHERE id=$1`, [a2])
    await q(`UPDATE affiliate_terms_events SET effective_at = NOW()-INTERVAL '365 days' WHERE affiliate_id=$1`, [a2])
    await q(`UPDATE affiliate_status_events SET effective_at = NOW()-INTERVAL '365 days' WHERE affiliate_id=$1`, [a2])
    await mkOrder(F.q, 126)
    await q(`UPDATE orders SET discount_code='F21Z' WHERE id=$1`, [oid(126)])
    await q(`SELECT resolve_order_affiliate_attribution($1,NULL,'s')`, [oid(126)])
    const c = (await q(`SELECT commission_cents FROM affiliate_commissions WHERE order_id=$1`, [oid(126)]))[0]
    expect(c?.commission_cents).toBe(0)
    const e = await econ(126)
    expect(e.affiliateCommissionCents).toBe(0)
    expect(e.contributionProfitCents).not.toBeNull()
  })
})

// ── BLOCKER 5 ────────────────────────────────────────────────────────────────
describeDB('BLOCKER 5 (SQL): paid payout lines cannot be re-parented', () => {
  let aid: string, cPaid: string, cDraft: string, pPaid: string, pDraft1: string, pDraft2: string
  beforeAll(async () => {
    if (!HAVE_DB || pgFail) return
    aid = (await q(`SELECT create_affiliate('F21P','F21 Payee',NULL::text,'percentage',1000,NULL::integer,'proportional',30,0,NULL::uuid,NULL::text,'admin') AS r`))[0].r.affiliate_id
    await q(`UPDATE affiliates SET created_at = NOW()-INTERVAL '365 days' WHERE id=$1`, [aid])
    await q(`UPDATE affiliate_terms_events SET effective_at = NOW()-INTERVAL '365 days' WHERE affiliate_id=$1`, [aid])
    await q(`UPDATE affiliate_status_events SET effective_at = NOW()-INTERVAL '365 days' WHERE affiliate_id=$1`, [aid])
    for (const n of [131, 132]) {
      await mkOrder(F.q, n, { daysAgo: 90 })
      await q(`UPDATE orders SET discount_code='F21P' WHERE id=$1`, [oid(n)])
      await q(`SELECT resolve_order_affiliate_attribution($1,NULL,'s')`, [oid(n)])
    }
    cPaid  = (await q(`SELECT id FROM affiliate_commissions WHERE order_id=$1`, [oid(131)]))[0].id
    cDraft = (await q(`SELECT id FROM affiliate_commissions WHERE order_id=$1`, [oid(132)]))[0].id
    await q(`SELECT refresh_affiliate_commission_state($1)`, [cPaid])
    await q(`SELECT refresh_affiliate_commission_state($1)`, [cDraft])
    pPaid = (await q(`SELECT create_affiliate_payout($1,ARRAY[$2]::uuid[],'admin') AS r`, [aid, cPaid]))[0].r.payout_id
    await q(`SELECT mark_affiliate_payout_paid($1,NOW(),'ach','ref-rev1','admin')`, [pPaid])
    pDraft1 = (await q(`SELECT create_affiliate_payout($1,ARRAY[$2]::uuid[],'admin') AS r`, [aid, cDraft]))[0].r.payout_id
    pDraft2 = (await q(`INSERT INTO affiliate_payouts (affiliate_id,payout_number,amount_cents,status) VALUES ($1,'PAY-REV1-D2',0,'draft') RETURNING id`, [aid]))[0].id
  })
  test('update the amount of a paid line -> blocked', async () => {
    needDb()
    expect(await F.err(`UPDATE affiliate_payout_lines SET amount_cents=5 WHERE payout_id=$1`, [pPaid])).toContain('PAID_PAYOUT_IMMUTABLE')
  })
  test('delete a paid line -> blocked', async () => {
    needDb()
    expect(await F.err(`DELETE FROM affiliate_payout_lines WHERE payout_id=$1`, [pPaid])).toContain('PAID_PAYOUT_IMMUTABLE')
  })
  test('insert a line directly into a paid payout -> blocked', async () => {
    needDb()
    expect(await F.err(`INSERT INTO affiliate_payout_lines (payout_id,commission_id,amount_cents) VALUES ($1,$2,1)`, [pPaid, cDraft])).toContain('PAID_PAYOUT_IMMUTABLE')
  })
  test('move a line FROM a paid payout -> blocked', async () => {
    needDb()
    expect(await F.err(`UPDATE affiliate_payout_lines SET payout_id=$1 WHERE payout_id=$2`, [pDraft2, pPaid])).toContain('PAID_PAYOUT_IMMUTABLE')
  })
  test('move a line FROM a draft payout INTO a paid payout -> blocked (the reparenting bypass)', async () => {
    needDb()
    expect(await F.err(`UPDATE affiliate_payout_lines SET payout_id=$1 WHERE payout_id=$2`, [pPaid, pDraft1])).toContain('PAID_PAYOUT_IMMUTABLE')
    // and the paid payout is exactly as it was paid
    const lines = await q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::int AS s FROM affiliate_payout_lines WHERE payout_id=$1`, [pPaid])
    const paid = (await q(`SELECT amount_cents FROM affiliate_payouts WHERE id=$1`, [pPaid]))[0]
    expect(lines[0].n).toBe(1)
    expect(lines[0].s).toBe(paid.amount_cents)
  })
  test('move a line draft -> draft stays allowed', async () => {
    needDb()
    expect(await F.err(`UPDATE affiliate_payout_lines SET payout_id=$1 WHERE payout_id=$2`, [pDraft2, pDraft1])).toBe('')
    expect(await F.err(`UPDATE affiliate_payout_lines SET payout_id=$1 WHERE payout_id=$2`, [pDraft1, pDraft2])).toBe('')
  })
})

// ── BLOCKER 6 ────────────────────────────────────────────────────────────────
describeDB('BLOCKER 6 (SQL): expense and ad-spend money is voided, never physically deleted', () => {
  const win = { start: '2026-03-01T00:00:00Z', end: '2026-04-01T00:00:00Z' }
  let exId: string, adId: string
  test('a booked expense and ad row affect reporting', async () => {
    needDb()
    const before = await svc.getRecognizedOperatingExpensesCents(win)
    exId = (await q(`INSERT INTO expense_transactions (provider,category,name,amount_cents,paid_at,invoice_id)
                     VALUES ('Neon','infrastructure','Neon Mar',2000,'2026-03-10','INV-REV1') RETURNING id`))[0].id
    adId = (await q(`INSERT INTO ad_spend (platform,campaign_name,spend_cents,period_start,period_end)
                     VALUES ('meta','Mar',3100,'2026-03-01','2026-03-31') RETURNING id`))[0].id
    const after = await svc.getRecognizedOperatingExpensesCents(win)
    expect(after.operating - before.operating).toBe(2000)
    expect(await svc.getAdvertisingSpendCents(win)).toBe(3100)
  })
  test('a direct hard DELETE of a booked monetary row is prevented at DB level', async () => {
    needDb()
    expect(await F.err(`DELETE FROM expense_transactions WHERE id=$1`, [exId])).toContain('HARD_DELETE_BLOCKED')
    expect(await F.err(`DELETE FROM ad_spend WHERE id=$1`, [adId])).toContain('HARD_DELETE_BLOCKED')
    expect(await F.err(`TRUNCATE expense_transactions`)).toContain('HARD_DELETE_BLOCKED')
  })
  test('voiding removes the row from CURRENT reporting but keeps the historical row', async () => {
    needDb()
    const r = (await q(`SELECT void_expense_transaction($1,'admin@kvrn.test','entered twice') AS r`, [exId]))[0].r
    expect(r.outcome).toBe('voided')
    const a = (await q(`SELECT void_ad_spend($1,'admin@kvrn.test','wrong campaign') AS r`, [adId]))[0].r
    expect(a.outcome).toBe('voided')
    expect((await svc.getRecognizedOperatingExpensesCents(win)).operating).toBe(0)
    expect(await svc.getAdvertisingSpendCents(win)).toBe(0)
    const row = (await q(`SELECT amount_cents, voided_at, voided_by, void_reason FROM expense_transactions WHERE id=$1`, [exId]))[0]
    expect(row.amount_cents).toBe(2000)                       // the fact is retained
    expect(row.voided_by).toBe('admin@kvrn.test')             // actor
    expect(row.void_reason).toBe('entered twice')             // reason
    expect(row.voided_at).toBeTruthy()                        // time
  })
  test('retry is idempotent and does not overwrite who/why/when', async () => {
    needDb()
    const first = (await q(`SELECT voided_at, voided_by, void_reason FROM expense_transactions WHERE id=$1`, [exId]))[0]
    const r = (await q(`SELECT void_expense_transaction($1,'someone.else@kvrn.test','different reason') AS r`, [exId]))[0].r
    expect(r.outcome).toBe('already_voided')
    const again = (await q(`SELECT voided_at, voided_by, void_reason FROM expense_transactions WHERE id=$1`, [exId]))[0]
    expect(again).toEqual(first)
  })
  test('a voided row cannot be silently rewritten into a different fact or un-voided', async () => {
    needDb()
    expect(await F.err(`UPDATE expense_transactions SET amount_cents=1 WHERE id=$1`, [exId])).toContain('IMMUTABLE')
    expect(await F.err(`UPDATE expense_transactions SET voided_at=NULL, voided_by=NULL, void_reason=NULL WHERE id=$1`, [exId])).toContain('IMMUTABLE')
    expect(await F.err(`UPDATE ad_spend SET spend_cents=1 WHERE id=$1`, [adId])).toContain('IMMUTABLE')
    expect(await F.err(`UPDATE ad_spend SET voided_at=NULL, voided_by=NULL, void_reason=NULL WHERE id=$1`, [adId])).toContain('IMMUTABLE')
  })
  test('actor and reason are mandatory', async () => {
    needDb()
    const id = (await q(`INSERT INTO expense_transactions (provider,category,name,amount_cents,paid_at) VALUES ('X','software','x',1,'2026-03-11') RETURNING id`))[0].id
    expect(await F.err(`SELECT void_expense_transaction($1,'','why')`, [id])).toContain('ACTOR_REQUIRED')
    expect(await F.err(`SELECT void_expense_transaction($1,'a@b.c','  ')`, [id])).toContain('REASON_REQUIRED')
    expect(await F.err(`SELECT void_expense_transaction($1,'a@b.c','why')`, ['00000000-0000-0000-0000-000000000000'])).toContain('NOT_FOUND')
  })
  test('a voided duplicate no longer double-counts current P&L and is not a live duplicate finding', async () => {
    needDb()
    const mk = async (inv: string, created: string) => (await q(
      `INSERT INTO expense_transactions (provider,category,name,amount_cents,paid_at,invoice_id,created_at)
       VALUES ('Vercel','infrastructure','Vercel Mar',4000,'2026-03-12',$1,$2) RETURNING id`, [inv, created]))[0].id
    const a = await mk('INV-DUP', '2026-03-12T00:00:00Z')
    const b = await mk('INV-DUP', '2026-03-12T00:00:01Z')
    const live = async () => (await q(`SELECT 1 FROM financial_integrity_scan() WHERE issue_code='EXPENSE_DUPLICATE_INVOICE' AND entity_id=$1`, [b])).length
    const op = async () => (await svc.getRecognizedOperatingExpensesCents(win)).operating
    const before = await op()
    expect(await live()).toBe(1)
    await q(`SELECT void_expense_transaction($1,'admin','duplicate entry')`, [b])
    expect(await live()).toBe(0)
    expect((await op()) - before).toBe(-4000)                // the duplicate stops counting
    expect((await q(`SELECT voided_at FROM expense_transactions WHERE id=$1`, [a]))[0].voided_at).toBeNull()   // the original stays live
  })
  test('duplicate ad-spend rows: voiding the extra clears the finding and the double count', async () => {
    needDb()
    const ids: string[] = []
    for (let i = 0; i < 2; i++) ids.push((await q(
      `INSERT INTO ad_spend (platform,campaign_name,spend_cents,period_start,period_end,created_at)
       VALUES ('tiktok','Dup',500,'2026-03-01','2026-03-31',now()+($1||' seconds')::interval) RETURNING id`, [String(i)]))[0].id)
    const live = async () => (await q(`SELECT 1 FROM financial_integrity_scan() WHERE issue_code='AD_SPEND_DUPLICATE'`)).length
    const spend = () => svc.getAdvertisingSpendCents(win)
    const before = await spend()
    expect(await live()).toBeGreaterThanOrEqual(1)
    await q(`SELECT void_ad_spend($1,'admin','duplicate')`, [ids[1]])
    expect((await spend()) - before).toBe(-500)
    expect(await live()).toBe(0)
  })
  test('the DELETE of an expense DEFINITION still works (non-economic): live AND voided rows keep their money', async () => {
    needDb()
    const mkDef = async (n: string) => (await q(
      `INSERT INTO expense_definitions (provider,category,name,expected_amount_cents,cadence)
       VALUES ('Def','software',$1,100,'monthly') RETURNING id`, [n]))[0].id
    const mkTx = async (d: string, inv: string) => (await q(
      `INSERT INTO expense_transactions (expense_definition_id,provider,category,name,amount_cents,paid_at,invoice_id)
       VALUES ($1,'Def','software','Def',100,'2026-03-13',$2) RETURNING id`, [d, inv]))[0].id
    const d1 = await mkDef('live-def'), t1 = await mkTx(d1, 'INV-DEF-LIVE')
    const d2 = await mkDef('void-def'), t2 = await mkTx(d2, 'INV-DEF-VOID')
    await q(`SELECT void_expense_transaction($1,'admin','test void before def delete')`, [t2])
    expect(await F.err(`DELETE FROM expense_definitions WHERE id=$1`, [d1])).toBe('')
    expect(await F.err(`DELETE FROM expense_definitions WHERE id=$1`, [d2])).toBe('')
    for (const t of [t1, t2]) {
      const r = (await q(`SELECT expense_definition_id AS d, amount_cents AS a FROM expense_transactions WHERE id=$1`, [t]))[0]
      expect(r.d).toBeNull()
      expect(r.a).toBe(100)
    }
    // ...but re-pointing a voided row at a different definition is still a refused rewrite
    const d3 = await mkDef('other-def')
    expect(await F.err(`UPDATE expense_transactions SET expense_definition_id=$1 WHERE id=$2`, [d3, t2])).toContain('VOIDED_ROW_IMMUTABLE')
  })
})

// ── REFUND-FEE WRITER (the only way an UNKNOWN fee return becomes known) ──────
describeDB('BLOCKER 1 (SQL): record_refund_fee_returned is write-once, bounded and audited', () => {
  const rid = async (id: string) => (await q(`SELECT id FROM order_refunds WHERE stripe_refund_id=$1`, [id]))[0].id
  test('records once, resolves the INCOMPLETE order, and audits who recorded it', async () => {
    needDb()
    await mkOrder(F.q, 201, { fee: 100 })
    await addRefund(F.q, 201, 're_201', 500, { fee: null })
    expect((await econ(201)).contributionProfitCents).toBeNull()
    const r = (await q(`SELECT record_refund_fee_returned($1,40,'ops@kvrn') AS r`, [await rid('re_201')]))[0].r
    expect(r.outcome).toBe('recorded')
    expect((await econ(201)).netStripeFeeCents).toBe(60)
    expect((await econ(201)).contributionProfitCents).toBe(1500 - 500 - (300 + 450 + 60))
    expect((await q(`SELECT 1 FROM admin_audit_logs WHERE action='record_refund_fee_returned' AND actor_email='ops@kvrn' AND resource_id=$1`, [await rid('re_201')])).length).toBe(1)
  })
  test('same value is idempotent; a different value is refused', async () => {
    needDb()
    const id = await rid('re_201')
    expect((await q(`SELECT record_refund_fee_returned($1,40,'ops@kvrn') AS r`, [id]))[0].r.outcome).toBe('already_recorded')
    expect(await F.err(`SELECT record_refund_fee_returned($1,41,'ops@kvrn')`, [id])).toContain('FEE_ALREADY_RECORDED')
  })
  test('a cumulative return above the order fee is refused and negative / unattributed input is refused', async () => {
    needDb()
    await mkOrder(F.q, 202, { fee: 100 })
    await addRefund(F.q, 202, 're_202a', 200, { fee: 70 })
    await addRefund(F.q, 202, 're_202b', 300, { fee: null })
    const id = await rid('re_202b')
    expect(await F.err(`SELECT record_refund_fee_returned($1,31,'ops@kvrn')`, [id])).toContain('FEE_EXCEEDS_ORDER_FEE')
    expect(await F.err(`SELECT record_refund_fee_returned($1,-1,'ops@kvrn')`, [id])).toContain('INVALID_FEE')
    expect(await F.err(`SELECT record_refund_fee_returned($1,10,'  ')`, [id])).toContain('ACTOR_REQUIRED')
    expect((await q(`SELECT fee_refunded_cents AS f FROM order_refunds WHERE id=$1`, [id]))[0].f).toBeNull()
  })
})

// ── BLOCKER 7 (SQL): sales tax on a refund ───────────────────────────────────
describeDB('BLOCKER 7 (SQL): refunded sales tax reverses the liability, not operating revenue', () => {
  test('non-zero tax, resolved split: only merchandise + shipping reduce revenue; cash refunded stays visible', async () => {
    needDb()
    await mkOrder(F.q, 211, { tax: 100, fee: 100 })
    // customer got back $10 merchandise + the $1 tax charged on it
    await addRefund(F.q, 211, 're_211', 1100, { fee: 0, merch: 1000, ship: 0, taxPart: 100 })
    const e = await econ(211)
    expect(e.taxCollectedCents).toBe(100)
    expect(e.refundCents).toBe(1100)                 // total cash refunded
    expect(e.netRevenueCents).toBe(1500 - 1000)      // NOT 1500 - 1100
    expect(e.contributionProfitCents).toBe(500 - (300 + 450 + 100))
  })
  test('non-zero tax, UNRESOLVED split -> profit NULL / incomplete, never guessed', async () => {
    needDb()
    await mkOrder(F.q, 212, { tax: 100, fee: 100 })
    await addRefund(F.q, 212, 're_212', 1100, { fee: 0, resolved: false })
    const e = await econ(212)
    expect(e.contributionProfitCents).toBeNull()
    expect(e.reconciliation.missing.map(m => m.field)).toContain('refund_revenue_split')
  })
  test('zero tax with an unresolved split keeps the old behaviour (total refund reduces revenue)', async () => {
    needDb()
    await mkOrder(F.q, 213, { tax: 0, fee: 100 })
    await addRefund(F.q, 213, 're_213', 500, { fee: 0, resolved: false })
    const e = await econ(213)
    expect(e.netRevenueCents).toBe(1000)
    expect(e.contributionProfitCents).toBe(1000 - (300 + 450 + 100))
  })
})

// ── EXCHANGE WRITE-ONCE ─────────────────────────────────────────────────────
describeDB('EXCHANGE (SQL): replacement shipping cost cannot be overwritten or cleared once known', () => {
  const EX = 'f2130000-0000-0000-0000-0000000000a1'
  beforeAll(async () => {
    if (!HAVE_DB || pgFail) return
    await mkOrder(F.q, 141)
    await q(`INSERT INTO order_exchanges (id,order_id,exchange_number,status,shipped_at)
             VALUES ($1,$2,'EX-REV1-1','shipped',now())`, [EX, oid(141)])
  })
  test('the official first write is allowed', async () => {
    needDb()
    const r = (await q(`SELECT record_exchange_replacement_shipping_cost($1,650,'f21') AS r`, [EX]))[0].r
    expect(r.outcome).toBe('recorded')
  })
  test('a direct UPDATE cannot overwrite the known amount', async () => {
    needDb()
    expect(await F.err(`UPDATE order_exchanges SET replacement_shipping_cost_cents=1 WHERE id=$1`, [EX])).toContain('SHIPPING_COST_IMMUTABLE')
  })
  test('a direct UPDATE cannot clear the known amount back to unknown', async () => {
    needDb()
    expect(await F.err(`UPDATE order_exchanges SET replacement_shipping_cost_cents=NULL WHERE id=$1`, [EX])).toContain('SHIPPING_COST_IMMUTABLE')
  })
  test('the amount is untouched and unrelated updates to the exchange still work', async () => {
    needDb()
    expect((await q(`SELECT replacement_shipping_cost_cents AS c FROM order_exchanges WHERE id=$1`, [EX]))[0].c).toBe(650)
    expect(await F.err(`UPDATE order_exchanges SET status='completed' WHERE id=$1`, [EX])).toBe('')
    expect(await F.err(`UPDATE order_exchanges SET replacement_shipping_cost_cents=650 WHERE id=$1`, [EX])).toBe('')   // same value: no change
  })
  test('the official function stays idempotent and refuses a different value', async () => {
    needDb()
    expect((await q(`SELECT record_exchange_replacement_shipping_cost($1,650,'f21') AS r`, [EX]))[0].r.outcome).toBe('already_recorded')
    expect(await F.err(`SELECT record_exchange_replacement_shipping_cost($1,651,'f21')`, [EX])).toContain('COST_ALREADY_RECORDED')
  })
})

// ── BLOCKER 4 (SQL) — profit is gated by the RELEVANT reconciliation state ───
describeDB('BLOCKER 4 (SQL): "exact" profit is gated by the integrity state relevant to the period', () => {
  const report = (d: number) => svc.getPeriodReport(dayRange(d))

  test('clean period -> RECONCILED and an exact numeric profit', async () => {
    needDb()
    await mkOrder(F.q, 151, { daysAgo: 30 })
    const r = await report(30)
    expect(r.integrity.state).toBe('RECONCILED')
    expect(r.period.profitCompleteness).toBe('complete')
    expect(r.period.canonicalOperatingProfitCents).toBe(1500 - (300 + 450 + 100))
  })
  test('missing required cost -> INCOMPLETE and exact profit unavailable (known-so-far kept, labelled)', async () => {
    needDb()
    await mkOrder(F.q, 152, { daysAgo: 31, fee: null })
    const r = await report(31)
    expect(r.integrity.state).toBe('INCOMPLETE')
    expect(r.period.profitCompleteness).toBe('incomplete')
    expect(r.period.canonicalOperatingProfitCents).toBeNull()
    expect(typeof r.period.nonAuthoritativeOperatingProfitCents).toBe('number')
  })
  test('order total contradiction -> EXCEPTION and exact profit unavailable', async () => {
    needDb()
    await mkOrder(F.q, 153, { daysAgo: 32 })
    await q(`UPDATE orders SET total_cents = total_cents + 77 WHERE id=$1`, [oid(153)])
    expect((await finding('ORDER_TOTAL_MISMATCH', 153))?.state).toBe('exception')
    const r = await report(32)
    expect(r.integrity.state).toBe('EXCEPTION')
    expect(r.period.profitCompleteness).toBe('exception')
    expect(r.period.canonicalOperatingProfitCents).toBeNull()
    expect(r.period.canonicalOrderContributionCents).toBeNull()
    expect(r.integrity.byCode.some(c => c.issueCode === 'ORDER_TOTAL_MISMATCH')).toBe(true)
  })
  test('FIFO contradiction -> EXCEPTION and exact profit unavailable', async () => {
    needDb()
    await mkOrder(F.q, 154, { daysAgo: 33 })
    // the snapshot says 999 but the FIFO ledger consumed 300
    await q(`ALTER TABLE order_items DISABLE TRIGGER USER`)
    await q(`UPDATE order_items SET unit_cogs_cents=999, line_cogs_cents=999 WHERE order_id=$1`, [oid(154)])
    await q(`ALTER TABLE order_items ENABLE TRIGGER USER`)
    expect((await finding('ORDER_FIFO_COST_MISMATCH', 154))?.state).toBe('exception')
    const r = await report(33)
    expect(r.integrity.state).toBe('EXCEPTION')
    expect(r.period.canonicalOperatingProfitCents).toBeNull()
  })
  test('refund component contradiction -> EXCEPTION', async () => {
    needDb()
    await mkOrder(F.q, 155, { daysAgo: 34 })
    await addRefund(F.q, 155, 're_155', 500, { fee: 0, merch: 100, ship: 0, taxPart: 0 })   // parts sum to 100, refund is 500
    const r = await report(34)
    expect(r.integrity.state).toBe('EXCEPTION')
    expect(r.period.canonicalOperatingProfitCents).toBeNull()
  })
  test('duplicate expense invoice IN the period -> EXCEPTION and exact OPERATING profit unavailable', async () => {
    needDb()
    await mkOrder(F.q, 156, { daysAgo: 35 })
    const d = ymd(35)
    await q(`INSERT INTO expense_transactions (provider,category,name,amount_cents,paid_at,invoice_id,created_at)
             VALUES ('Acme','software','A',700,$1,'INV-P4',now()), ('Acme','software','A',700,$1,'INV-P4',now()+interval '1 second')`, [d])
    const r = await report(35)
    expect(r.integrity.state).toBe('EXCEPTION')
    expect(r.period.canonicalOperatingProfitCents).toBeNull()
    expect(r.integrity.byCode.some(c => c.issueCode === 'EXPENSE_DUPLICATE_INVOICE')).toBe(true)
  })
  test('duplicate ad spend IN the period -> EXCEPTION and exact OPERATING profit unavailable', async () => {
    needDb()
    await mkOrder(F.q, 157, { daysAgo: 36 })
    const d = ymd(36)
    await q(`INSERT INTO ad_spend (platform,campaign_name,spend_cents,period_start,period_end,created_at)
             VALUES ('google','P4',900,$1,$1,now()), ('google','P4',900,$1,$1,now()+interval '1 second')`, [d])
    const r = await report(36)
    expect(r.integrity.state).toBe('EXCEPTION')
    expect(r.period.canonicalOperatingProfitCents).toBeNull()
    expect(r.integrity.byCode.some(c => c.issueCode === 'AD_SPEND_DUPLICATE')).toBe(true)
  })
  test('the SAME duplicates OUTSIDE the selected period do not poison a clean period', async () => {
    needDb()
    await mkOrder(F.q, 158, { daysAgo: 37 })
    // duplicates dated far away from day 37 (day 35 / 36 above already hold exactly these)
    const r = await report(37)
    expect(r.integrity.state).toBe('RECONCILED')
    expect(r.period.canonicalOperatingProfitCents).toBe(1500 - (300 + 450 + 100))
    // …while the global reconciliation view still shows them
    expect((await integ.getSummary()).overall).toBe('EXCEPTION')
  })
  test('an order exception in ANOTHER period does not poison this one', async () => {
    needDb()
    expect((await report(30)).integrity.state).toBe('RECONCILED')      // day 30 clean while days 32/33/34 are broken
  })
  test('correcting the underlying data moves the relevant result back to RECONCILED', async () => {
    needDb()
    await q(`UPDATE orders SET total_cents = total_cents - 77 WHERE id=$1`, [oid(153)])
    const r = await report(32)
    expect(r.integrity.state).toBe('RECONCILED')
    expect(r.period.profitCompleteness).toBe('complete')
    expect(r.period.canonicalOperatingProfitCents).toBe(1500 - (300 + 450 + 100))
  })
  test('voiding the duplicate expense (the correction path) restores exactness for its period', async () => {
    needDb()
    const dup = (await q(`SELECT id FROM expense_transactions WHERE invoice_id='INV-P4' ORDER BY created_at DESC LIMIT 1`))[0].id
    await q(`SELECT void_expense_transaction($1,'admin','duplicate invoice entry')`, [dup])
    const r = await report(35)
    expect(r.integrity.state).toBe('RECONCILED')
    expect(r.period.canonicalOperatingProfitCents).toBe(1500 - (300 + 450 + 100) - 700)
  })
  test('the per-order rows in a period carry their own integrity state', async () => {
    needDb()
    const r = await report(34)
    expect(r.orders.find(o => o.orderId === oid(155))?.integrityState).toBe('EXCEPTION')
    expect((await report(30)).orders[0].integrityState).toBe('RECONCILED')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES AND LANGUAGE (no database)
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs'
import path from 'path'
import { profitPresentation, knownSoFarLabel, RECONCILIATION_HREF } from '../financial-presentation'

describe('B4 language: what the Admin may call "exact"', () => {
  const pp = (state: any, c: number | null = 1234) => profitPresentation({ canonicalOperatingProfitCents: c, integrityState: state, exceptionCount: 2, incompleteCount: 3 })
  test('RECONCILED -> exact figure, labelled exact', () => {
    const r = pp('RECONCILED')
    expect(r.kind).toBe('exact'); expect(r.cents).toBe(1234); expect(r.label).toContain('(exact)'); expect(r.href).toBeNull()
  })
  test('INCOMPLETE -> Unknown, no figure, never labelled exact, links to Reconciliation', () => {
    const r = pp('INCOMPLETE')
    expect(r.word).toBe('Unknown'); expect(r.cents).toBeNull(); expect(r.label).not.toContain('exact'); expect(r.href).toBe(RECONCILIATION_HREF)
  })
  test('EXCEPTION -> Invalid even when a numeric value exists, links to Reconciliation', () => {
    const r = pp('EXCEPTION')
    expect(r.word).toBe('Invalid'); expect(r.cents).toBeNull(); expect(r.sub).toContain('EXCEPTION'); expect(r.href).toBe(RECONCILIATION_HREF)
  })
  test('a calculator null can never be shown as exact, whatever the state says', () => {
    expect(pp('RECONCILED', null).kind).toBe('unknown')
  })
  test('known-so-far figures are labelled non-authoritative unless reconciled', () => {
    expect(knownSoFarLabel('Contribution profit', 'RECONCILED')).toBe('Contribution profit')
    expect(knownSoFarLabel('Contribution profit', 'INCOMPLETE')).toMatch(/known so far, not exact/)
    expect(knownSoFarLabel('Contribution profit', 'EXCEPTION')).toMatch(/known so far, not exact/)
  })
})

describe('REV1 routes', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8')
  test.each([
    'app/api/admin/refunds/[id]/fee-returned/route.ts',
    'app/api/admin/expenses/transactions/[id]/route.ts',
    'app/api/admin/ad-spend/[id]/route.ts',
  ])('%s is admin-gated before any data access', (p) => {
    const src = read(p)
    expect(src).toMatch(/requireAdmin\(req\)/)
    expect(src.indexOf('requireAdmin(req)')).toBeLessThan(src.search(/\(sql\)|sql`/))
  })
  test.each([
    'app/api/admin/expenses/transactions/[id]/route.ts',
    'app/api/admin/ad-spend/[id]/route.ts',
  ])('%s no longer issues a physical DELETE: it voids', (p) => {
    const src = read(p).replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/DELETE\s+FROM/i)
    expect(src).toMatch(/void(Transaction|AdSpend)\(/)
  })
  test('the summary route exposes the reason (state, counts, codes, scope) behind the gate', () => {
    const src = read('app/api/admin/financials/summary/route.ts')
    for (const k of ['state', 'exceptionCount', 'incompleteCount', 'byCode', 'scope', 'integrityState']) expect(src).toContain(k)
  })
  test('the Financials page uses the shared presentation rule and never prints "Every cost known"', () => {
    const src = read('app/admin/financials/FinancialsClient.tsx')
    expect(src).toContain('profitPresentation')
    expect(src).not.toContain('Every cost known')
    expect(src).toContain('RECONCILIATION_HREF')
  })
})
