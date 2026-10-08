// lib/__tests__/fraud-review-db.test.ts
//
// Stripe Radar fraud review + the server-enforced fulfillment HOLD — real PostgreSQL (local
// TEST_DATABASE_URL only; see helpers/fi-pg.ts). Applies EVERY migration 001..031 to a throwaway DB.
//
// Proves: ordinary order not held; review/elevated held; hold blocks the admin PATCH, mark_order_shipped(),
// a direct SQL UPDATE and a shipment insert; release enables fulfillment; cancel stays allowed; missing data is
// Unknown; duplicate / out-of-order delivery is idempotent; flag OFF creates no hold; a hold changes no payment,
// inventory, financial or reconciliation state; the refund path is unchanged; routes are admin-gated.

import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import { createAdminOrderService } from '../admin-orders'
import { createFraudReviewService, hasActiveFraudHold } from '../fraud-review'
import { HAVE_DB, TEST_DB_URL, createFiDb, type FiDb } from './helpers/fi-pg'

jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => (global as any).__AUTH_OK === false
    ? { identity: null, error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
    : { identity: { email: 'owner@kvrn.test' }, error: null },
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__CX_SQL } }))
jest.mock('@/lib/stripe-client', () => ({ getStripe: () => { const s = (global as any).__STRIPE; if (!s) throw new Error('no stripe'); return s } }))

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL ? 'NOTE: fraud DB tests skipped — TEST_DATABASE_URL is not a local server.' : 'NOTE: fraud DB tests skipped — TEST_DATABASE_URL absent.', () => {
    expect(true).toBe(true)
  })
}

let F: FiDb
let pgFail: string | null = null
const needDb = () => { if (pgFail) throw new Error('local PostgreSQL unavailable: ' + pgFail) }
const q = (t: string, p: unknown[] = []) => F.q(t, p)

const VAR = 'f3100000-0000-0000-0000-00000000b001'
const PRD = 'f3100000-0000-0000-0000-00000000aaaa'
const oid = (n: number) => `f3110000-0000-0000-0000-${String(n).padStart(12, '0')}`
const pi  = (n: number) => `pi_frt${String(n).padStart(6, '0')}`
const ch  = (n: number) => `ch_frt${String(n).padStart(6, '0')}`
const prv = (n: number, k = 1) => `prv_frt${String(n).padStart(6, '0')}${k}`
const onFlag  = () => { process.env.KVRN_FLAG_RADAR_FULFILLMENT_HOLDS = 'on' }
const offFlag = () => { delete process.env.KVRN_FLAG_RADAR_FULFILLMENT_HOLDS }

beforeAll(async () => {
  if (!HAVE_DB) return
  try {
    F = await createFiDb('kvrn_fr')
    ;(global as any).__CX_SQL = F.sql
    await q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active) VALUES ($1,'R','R','FR31','fr31',8000,true)`, [PRD])
    await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand) VALUES ($1,$2,'FR31-M','Black','#000','M',1,500)`, [VAR, PRD])
    await q(`SELECT add_inventory_layer($1,500,5000,'purchase',NULL,NULL,'cost_batch','jest')`, [VAR])
  } catch (e: any) { pgFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { offFlag(); await F?.close() })
beforeEach(() => { (global as any).__AUTH_OK = true; (global as any).__STRIPE = null; offFlag() })

/** A paid order, FIFO-consumed (as finalize_paid_order does), in the given fulfillment state. */
async function mkOrder(n: number, o: { fulfillment?: string; payment?: string; consume?: boolean } = {}) {
  const { fulfillment = 'unfulfilled', payment = 'paid', consume = true } = o
  await q(`INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,
      payment_status,fulfillment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,
      shipping_quoted_cents,shipping_before_discount_cents,stripe_fee_cents,stripe_fee_source,stripe_balance_transaction_id,customer_email,customer_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'usd',8000,598,0,0,8598,now() - interval '3 days',598,598,279,'stripe_api',$8,'buyer@example.com','Buyer')`,
    [oid(n), `FR-${n}`, `cs_fr${n}`, pi(n), ch(n), payment, fulfillment, `txn_fr${n}`])
  if (consume) {
    const item = (await q(`INSERT INTO order_items (order_id,variant_id,sku,product_name,size,color,quantity,unit_price_cents,line_total_cents)
      VALUES ($1,$2,'FR31-M','FR31','M','Black',1,8000,8000) RETURNING id`, [oid(n), VAR]))[0].id
    const r = (await q(`SELECT consume_inventory_fifo($1,1,'sale',NULL,$2,$3) AS r`, [VAR, oid(n), item]))[0].r
    await q(`UPDATE product_variants SET stock_on_hand = stock_on_hand - 1 WHERE id = $1`, [VAR])
    const line = r.total_cost_cents === null ? null : Number(r.total_cost_cents)
    await q(`UPDATE order_items SET unit_cogs_cents=$2, line_cogs_cents=$2 WHERE id=$1`, [item, line])
  }
  return oid(n)
}

const charge = (n: number, over: Record<string, any> = {}) => ({
  id: ch(n), status: 'succeeded', paid: true, payment_intent: pi(n),
  billing_details: { address: { country: 'US' } }, shipping: { address: { country: 'US' } },
  outcome: { risk_level: 'normal', type: 'authorized', reason: null, seller_message: 'Payment complete.', network_status: 'approved_by_network' },
  payment_method_details: { card: { country: 'US', funding: 'credit', checks: { cvc_check: 'pass', address_line1_check: 'pass', address_postal_code_check: 'pass' }, three_d_secure: null } },
  ...over,
})
const review = (n: number, over: Record<string, any> = {}) => ({
  id: prv(n), open: true, reason: 'rule', opened_reason: 'rule', closed_reason: null, payment_intent: pi(n), charge: ch(n),
  ip_address_location: { country: 'US' }, ...over,
})
const evt = (id: string, type: string, object: any, created = Math.floor(Date.now() / 1000)) => ({ id, type, created, data: { object } })

const svc = () => createFraudReviewService(F.sql)
const row = async (n: number) => (await q(`SELECT * FROM order_fraud_reviews WHERE order_id=$1`, [oid(n)]))[0]
const orderRow = async (n: number) => (await q(`SELECT * FROM orders WHERE id=$1`, [oid(n)]))[0]
const events = (n: number) => q(`SELECT event_type, actor, source, stripe_event_id, detail FROM order_fraud_events WHERE order_id=$1 ORDER BY created_at, id`, [oid(n)])
const kinds = async (n: number) => (await events(n)).map((e: any) => e.event_type)
const audits = (action: string, n: number) => q(`SELECT actor_email, payload FROM admin_audit_logs WHERE action=$1 AND resource_id=$2`, [action, oid(n)])
const patch = async (n: number, body: any) => {
  const { PATCH } = require('../../app/api/orders/[id]/route')
  const id = oid(n)
  const res = await PATCH(new NextRequest(`http://localhost/api/orders/${id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() }
}
const fraudRoute = async (kind: 'get' | 'release' | 'refresh' | 'confirm', n: number, body?: any) => {
  const id = oid(n)
  const mod = kind === 'get' ? require('../../app/api/admin/orders/[id]/fraud/route')
    : require(`../../app/api/admin/orders/[id]/fraud/${kind}/route`)
  const fn = kind === 'get' ? mod.GET : mod.POST
  const res = await fn(new NextRequest(`http://localhost/api/admin/orders/${id}/fraud`, {
    method: kind === 'get' ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() }
}

/** An order that is held through a real review.opened event. */
async function mkHeld(n: number, o: { fulfillment?: string } = {}) {
  onFlag()
  await mkOrder(n, o)
  const r = await svc().ingestStripeEvent(evt(`evt_open_${n}`, 'review.opened', review(n)))
  expect(r).toMatchObject({ outcome: 'applied', hold: 'created' })
  return oid(n)
}

describeDB('1. detection: ordinary vs flagged', () => {
  test('an ordinary paid order is NOT held (and its normal outcome is recorded)', async () => {
    needDb(); onFlag()
    await mkOrder(101)
    const r = await svc().ingestStripeEvent(evt('evt_c101', 'charge.succeeded', charge(101)))
    expect(r).toMatchObject({ outcome: 'applied', hold: 'none' })
    const x = await row(101)
    expect(x).toMatchObject({ hold_state: 'none', risk_level: 'normal', outcome_type: 'authorized', charge_id: ch(101) })
    expect(await hasActiveFraudHold(F.sql, oid(101))).toBe(false)
    expect((await patch(101, { fulfillmentStatus: 'processing' })).status).toBe(200)
  })

  test('elevated risk on a paid order is held; payment stays PAID; reason + source recorded', async () => {
    needDb(); onFlag()
    await mkOrder(102)
    const before = await orderRow(102)
    const r = await svc().ingestStripeEvent(evt('evt_c102', 'charge.succeeded', charge(102, { outcome: { risk_level: 'elevated', type: 'authorized' } })))
    expect(r).toMatchObject({ outcome: 'applied', hold: 'created' })
    expect(await row(102)).toMatchObject({ hold_state: 'active', hold_reason: 'radar_elevated_risk', hold_source: 'webhook', hold_trigger_key: `outcome:${ch(102)}` })
    const after = await orderRow(102)
    expect(after.payment_status).toBe('paid')
    for (const k of ['subtotal_cents', 'shipping_cents', 'tax_cents', 'discount_cents', 'total_cents', 'stripe_fee_cents', 'paid_at', 'fulfillment_status', 'currency']) expect(after[k]).toEqual(before[k])
    expect(await kinds(102)).toEqual(['charge_outcome', 'hold_created'])
    expect((await audits('order.fraud_hold_created', 102))[0].actor_email).toBe('system@kvrn.internal')
  })

  test('a Stripe review opening holds; manual_review outcome holds; highest holds', async () => {
    needDb(); onFlag()
    await mkOrder(103); await mkOrder(104); await mkOrder(105)
    expect(await svc().ingestStripeEvent(evt('evt_r103', 'review.opened', review(103)))).toMatchObject({ hold: 'created' })
    expect((await row(103))).toMatchObject({ hold_reason: 'stripe_review_open', stripe_review_state: 'open', stripe_review_id: prv(103) })
    await svc().ingestStripeEvent(evt('evt_c104', 'charge.succeeded', charge(104, { outcome: { risk_level: 'normal', type: 'manual_review', reason: 'rule' } })))
    expect((await row(104)).hold_reason).toBe('radar_manual_review')
    await svc().ingestStripeEvent(evt('evt_c105', 'charge.succeeded', charge(105, { outcome: { risk_level: 'highest', type: 'authorized' } })))
    expect((await row(105)).hold_reason).toBe('radar_highest_risk')
  })

  test('country / AVS / CVC differences alone do NOT hold', async () => {
    needDb(); onFlag()
    await mkOrder(106)
    await svc().ingestStripeEvent(evt('evt_c106', 'charge.succeeded', charge(106, {
      billing_details: { address: { country: 'GB' } }, shipping: { address: { country: 'AU' } },
      payment_method_details: { card: { country: 'DE', checks: { cvc_check: 'fail', address_line1_check: 'fail', address_postal_code_check: 'fail' }, three_d_secure: null } } })))
    expect((await row(106)).hold_state).toBe('none')
    const v = await svc().getView(oid(106))
    expect(v!.checks).toEqual({ cvc: 'fail', addressLine1: 'fail', postalCode: 'fail' })
    expect(v!.countryMismatch.billingVsShipping).toBe(true)
    expect(v!.flagged).toBe(false)
  })

  test('an early fraud warning (actionable) holds an unshipped order; a non-actionable one does not', async () => {
    needDb(); onFlag()
    await mkOrder(107); await mkOrder(108)
    const efw = (n: number, actionable: boolean) => ({ id: `issfr_frt${n}abc`, actionable, charge: ch(n), payment_intent: pi(n), fraud_type: 'misc' })
    expect(await svc().ingestStripeEvent(evt('evt_e107', 'radar.early_fraud_warning.created', efw(107, true)))).toMatchObject({ hold: 'created' })
    expect((await row(107)).hold_reason).toBe('early_fraud_warning')
    expect(await svc().ingestStripeEvent(evt('evt_e108', 'radar.early_fraud_warning.created', efw(108, false)))).toMatchObject({ hold: 'none' })
  })

  test('a shipped / cancelled / refunded order is never held (the signal is still recorded)', async () => {
    needDb(); onFlag()
    await mkOrder(109, { fulfillment: 'shipped', consume: false }); await mkOrder(110, { fulfillment: 'cancelled', consume: false }); await mkOrder(111, { payment: 'refunded', consume: false })
    for (const n of [109, 110, 111]) {
      const r = await svc().ingestStripeEvent(evt(`evt_r${n}`, 'review.opened', review(n)))
      expect(r).toMatchObject({ outcome: 'applied', hold: 'not_applicable' })
      expect((await row(n)).hold_state).toBe('none')
      expect(await kinds(n)).toEqual(['review_opened', 'hold_not_applied'])
    }
  })
})

describeDB('2. missing Radar data is Unknown, never zero or safe', () => {
  test('no outcome: risk is NULL, not held, view says unknown; no record at all is also Unknown', async () => {
    needDb(); onFlag()
    await mkOrder(120); await mkOrder(121)
    await svc().ingestStripeEvent(evt('evt_c120', 'charge.succeeded', charge(120, { outcome: null, payment_method_details: { type: 'link' } })))
    const x = await row(120)
    expect(x.risk_level).toBeNull(); expect(x.risk_score).toBeNull(); expect(x.hold_state).toBe('none')
    const v = await svc().getView(oid(120))
    expect(v).toMatchObject({ hasRecord: true, riskLevel: null, riskScore: null, flagged: false })
    expect(v!.checks).toEqual({ cvc: null, addressLine1: null, postalCode: null })
    const none = await svc().getView(oid(121))
    expect(none).toMatchObject({ hasRecord: false, riskLevel: null, riskScore: null })
    expect(await svc().getView('f3110000-0000-0000-0000-00000000dead')).toBeNull()
  })
  test('the database refuses a made-up level or an out-of-range score', async () => {
    needDb()
    expect(await F.err(`UPDATE order_fraud_reviews SET risk_level='safe' WHERE order_id=$1`, [oid(120)])).toMatch(/risk_chk/)
    expect(await F.err(`UPDATE order_fraud_reviews SET risk_score=101 WHERE order_id=$1`, [oid(120)])).toMatch(/score_chk/)
  })
  test('a score only appears when Stripe sent one', async () => {
    needDb(); onFlag()
    await mkOrder(122)
    await svc().ingestStripeEvent(evt('evt_c122', 'charge.succeeded', charge(122, { outcome: { risk_level: 'normal', risk_score: 7, type: 'authorized' } })))
    expect((await row(122)).risk_score).toBe(7)
  })
})

describeDB('3. the hold is enforced by the SERVER (database), not by the UI', () => {
  test('admin PATCH processing and shipped are refused with 409 FRAUD_HOLD_ACTIVE; nothing changes', async () => {
    needDb()
    await mkHeld(130)
    const p = await patch(130, { fulfillmentStatus: 'processing' })
    expect([p.status, p.body.code]).toEqual([409, 'FRAUD_HOLD_ACTIVE'])
    expect(p.body.error).toMatch(/fraud review hold/i)
    expect((await orderRow(130)).fulfillment_status).toBe('unfulfilled')
    // an already-processing order that becomes held cannot ship
    await mkHeld(131, { fulfillment: 'processing' })
    const s = await patch(131, { fulfillmentStatus: 'shipped', carrier: 'USPS', trackingNumber: '9400' })
    expect([s.status, s.body.code]).toEqual([409, 'FRAUD_HOLD_ACTIVE'])
    expect((await q(`SELECT COUNT(*)::int c FROM shipments WHERE order_id=$1`, [oid(131)]))[0].c).toBe(0)
    expect((await orderRow(131)).fulfillment_status).toBe('processing')
  })

  test('the service refuses early; with the early check bypassed the DATABASE still refuses', async () => {
    needDb()
    expect(await createAdminOrderService(F.sql).transitionToProcessing(oid(130))).toBe('fraud_hold')
    expect(await createAdminOrderService(F.sql).markOrderShipped(oid(131), 'USPS', 'T1')).toEqual({ outcome: 'fraud_hold' })
    // raw SQL, no application code in between
    expect(await F.err(`SELECT mark_order_shipped($1,'USPS','T1')`, [oid(131)])).toMatch(/KVRN_FRAUD_HOLD\|FRAUD_HOLD_ACTIVE/)
    expect(await F.err(`UPDATE orders SET fulfillment_status='processing' WHERE id=$1`, [oid(130)])).toMatch(/FRAUD_HOLD_ACTIVE/)
    expect(await F.err(`UPDATE orders SET fulfillment_status='shipped' WHERE id=$1`, [oid(131)])).toMatch(/FRAUD_HOLD_ACTIVE/)
    expect(await F.err(`UPDATE orders SET fulfillment_status='delivered' WHERE id=$1`, [oid(131)])).toMatch(/FRAUD_HOLD_ACTIVE/)
    expect(await F.err(`INSERT INTO shipments (order_id,carrier,tracking_number) VALUES ($1,'usps','x')`, [oid(131)])).toMatch(/FRAUD_HOLD_ACTIVE/)
    // the same refusal when mark_order_shipped is called inside a transaction and everything rolls back
    expect((await orderRow(131)).fulfillment_status).toBe('processing')
    expect((await q(`SELECT COUNT(*)::int c FROM shipments WHERE order_id=$1`, [oid(131)]))[0].c).toBe(0)
    expect((await q(`SELECT COUNT(*)::int c FROM transactional_emails WHERE order_id=$1`, [oid(131)]))[0].c).toBe(0)
  })

  test('unrelated updates to a held order still work; an unheld order is unaffected', async () => {
    needDb()
    expect(await F.err(`UPDATE orders SET customer_name='Renamed' WHERE id=$1`, [oid(130)])).toBe('')
    expect(await F.err(`UPDATE orders SET fulfillment_status='processing' WHERE id=$1`, [oid(101)])).toBe('')     // 101: ordinary, already processing (no-op)
    await mkOrder(132)
    expect((await patch(132, { fulfillmentStatus: 'processing' })).status).toBe(200)
    expect((await patch(132, { fulfillmentStatus: 'shipped', carrier: 'USPS', trackingNumber: 'T132' })).status).toBe(200)
  })

  test('recording a shipment label cost on a held order is refused (shipment-cost route)', async () => {
    needDb()
    // an anomalous shipment created BEFORE the hold, then a hold forced by an owner-level SQL write
    await mkOrder(133, { fulfillment: 'processing', consume: false })
    await q(`INSERT INTO shipments (id,order_id,carrier,tracking_number) VALUES ('f3120000-0000-0000-0000-000000000133',$1,'usps','t')`, [oid(133)])
    await q(`INSERT INTO order_fraud_reviews (order_id,hold_state,hold_reason,hold_created_at) VALUES ($1,'active','stripe_review_open',now())`, [oid(133)])
    const { PATCH } = require('../../app/api/admin/shipments/[id]/cost/route')
    const id = 'f3120000-0000-0000-0000-000000000133'
    const res = await PATCH(new NextRequest(`http://localhost/x`, { method: 'PATCH', body: JSON.stringify({ labelCostCents: 450 }), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id }) })
    expect([res.status, (await res.json()).code]).toEqual([409, 'FRAUD_HOLD_ACTIVE'])
    expect((await q(`SELECT label_cost_cents FROM shipments WHERE id=$1`, [id]))[0].label_cost_cents).toBeNull()
  })
})

describeDB('4. release', () => {
  test('release requires explicit confirmation; then fulfillment works; audited with actor and note', async () => {
    needDb()
    await mkHeld(140)
    expect((await fraudRoute('release', 140, {})).status).toBe(400)
    expect((await fraudRoute('release', 140, { confirm: 'yes' })).status).toBe(400)
    expect((await fraudRoute('release', 140, { confirm: true, note: 'x'.repeat(501) })).status).toBe(400)
    expect((await fraudRoute('release', 140, { confirm: true, extra: 1 })).status).toBe(400)
    expect((await row(140)).hold_state).toBe('active')
    const r = await fraudRoute('release', 140, { confirm: true, note: '  Called the customer  ' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ success: true, outcome: 'released', stripeChanged: false })
    expect(r.body.data.hold).toMatchObject({ state: 'released', releasedBy: 'owner@kvrn.test', releaseNote: 'Called the customer' })
    expect((await patch(140, { fulfillmentStatus: 'processing' })).status).toBe(200)
    expect((await patch(140, { fulfillmentStatus: 'shipped', carrier: 'USPS', trackingNumber: 'T140' })).status).toBe(200)
    const a = await audits('order.fraud_hold_release', 140)
    expect(a).toHaveLength(1)
    expect(a[0].actor_email).toBe('owner@kvrn.test')
    expect(JSON.stringify(a[0].payload)).not.toContain('Called the customer')           // note text is not copied into the audit payload
    expect(a[0].payload).toMatchObject({ reason: 'stripe_review_open', has_note: true, stripe_changed: false })
    expect(await kinds(140)).toEqual(['review_opened', 'hold_created', 'hold_released'])
  })

  test('releasing twice is harmless; releasing an order that was never held is a 409', async () => {
    needDb()
    expect((await fraudRoute('release', 140, { confirm: true })).body.outcome).toBe('already_released')
    expect((await audits('order.fraud_hold_release', 140))).toHaveLength(1)
    await mkOrder(141)
    const r = await fraudRoute('release', 141, { confirm: true })
    expect([r.status, r.body.code]).toEqual([409, 'NOT_HELD'])
  })

  test('release works with the flag OFF (a kill switch can never trap an order)', async () => {
    needDb()
    await mkHeld(142); offFlag()
    expect((await fraudRoute('release', 142, { confirm: true })).status).toBe(200)
    expect((await patch(142, { fulfillmentStatus: 'processing' })).status).toBe(200)
  })

  test('after release the SAME Stripe signal cannot re-hold: replay, refresh and the unchanged outcome', async () => {
    needDb(); onFlag()
    await mkOrder(143)
    // held by an elevated OUTCOME, released, then the identical outcome arrives again
    await svc().ingestStripeEvent(evt('evt_c143', 'charge.succeeded', charge(143, { outcome: { risk_level: 'elevated', type: 'authorized' } })))
    expect((await row(143)).hold_state).toBe('active')
    await svc().releaseHold(oid(143), 'owner@kvrn.test', null)
    expect(await svc().ingestStripeEvent(evt('evt_c143', 'charge.succeeded', charge(143, { outcome: { risk_level: 'elevated', type: 'authorized' } })))).toMatchObject({ outcome: 'duplicate' })
    expect(await svc().ingestStripeEvent(evt('evt_c143b', 'charge.succeeded', charge(143, { outcome: { risk_level: 'elevated', type: 'authorized' } })))).toMatchObject({ hold: 'previously_released' })
    expect((await row(143)).hold_state).toBe('released')
    // a refresh from Stripe that still shows elevated + a CLOSED approved review does not re-hold either
    ;(global as any).__STRIPE = { paymentIntents: { retrieve: jest.fn(async () => ({ id: pi(143), latest_charge: charge(143, { outcome: { risk_level: 'elevated', type: 'manual_review' } }), review: review(143, { open: false, closed_reason: 'approved', reason: 'approved' }) })) } }
    const r = await fraudRoute('refresh', 143)
    expect(r.status).toBe(200)
    expect((await row(143)).hold_state).toBe('released')
  })

  test('a NEW review (different id) after a release holds again; so does a new early fraud warning', async () => {
    needDb(); onFlag()
    await mkOrder(144)
    await svc().ingestStripeEvent(evt('evt_r144a', 'review.opened', review(144)))
    await svc().releaseHold(oid(144), 'owner@kvrn.test', null)
    expect(await svc().ingestStripeEvent(evt('evt_r144b', 'review.opened', review(144, { id: prv(144, 2) })))).toMatchObject({ hold: 'created' })
    expect(await row(144)).toMatchObject({ hold_state: 'active', hold_trigger_key: `review:${prv(144, 2)}`, released_by: null })
    await svc().releaseHold(oid(144), 'owner@kvrn.test', null)
    expect(await svc().ingestStripeEvent(evt('evt_e144', 'radar.early_fraud_warning.created', { id: 'issfr_frt144abc', actionable: true, charge: ch(144), payment_intent: pi(144), fraud_type: 'misc' }))).toMatchObject({ hold: 'created' })
  })
})

describeDB('5. cancellation and the existing refund path stay available while held', () => {
  test('a held order that is then refunded in full can be cancelled & restocked (cancel is not blocked)', async () => {
    needDb(); onFlag()
    await mkHeld(150, { fulfillment: 'processing' })
    const stock0 = Number((await q(`SELECT stock_on_hand s FROM product_variants WHERE id=$1`, [VAR]))[0].s)
    // the EXISTING refund path (webhook -> record_order_refund), unchanged
    await q(`SELECT record_order_refund($1,$2,$3,$4,'usd','succeeded','fraudulent',0,now())`, ['re_fr150', pi(150), ch(150), 8598])
    const rid = (await q(`SELECT id FROM order_refunds WHERE stripe_refund_id='re_fr150'`))[0].id
    await q(`SELECT resolve_refund_components($1,NULL,NULL,NULL,'jest')`, [rid])
    expect((await orderRow(150)).payment_status).toBe('refunded')
    expect((await row(150)).hold_state).toBe('active')                       // refund did not touch the hold
    const c = await patch(150, { fulfillmentStatus: 'cancelled', reason: 'Confirmed fraud, refunded in Stripe', confirm: true })
    expect([c.status, c.body.outcome]).toEqual([200, 'cancelled'])
    expect((await orderRow(150)).fulfillment_status).toBe('cancelled')
    expect(Number((await q(`SELECT stock_on_hand s FROM product_variants WHERE id=$1`, [VAR]))[0].s)).toBe(stock0 + 1)
    // direct cancel via the 025 function also works under a hold
    await mkHeld(151)
    expect(await F.err(`UPDATE orders SET fulfillment_status='cancelled' WHERE id=$1`, [oid(151)])).toBe('')
  })

  test('confirmed fraud: audited, keeps the order unshippable, does NOT refund/cancel/restock anything itself', async () => {
    needDb(); onFlag()
    await mkOrder(152)
    const stock0 = Number((await q(`SELECT stock_on_hand s FROM product_variants WHERE id=$1`, [VAR]))[0].s)
    const refunds0 = Number((await q(`SELECT COUNT(*) c FROM order_refunds`))[0].c)
    expect((await fraudRoute('confirm', 152, {})).status).toBe(400)
    const r = await fraudRoute('confirm', 152, { confirm: true, note: 'Issuer confirmed' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ outcome: 'confirmed', hold: 'created', stripeChanged: false })
    expect((await row(152))).toMatchObject({ hold_state: 'active', hold_reason: 'confirmed_fraud', hold_source: 'admin', fraud_confirmed_by: 'owner@kvrn.test' })
    expect((await patch(152, { fulfillmentStatus: 'processing' })).status).toBe(409)
    expect((await fraudRoute('confirm', 152, { confirm: true })).body.outcome).toBe('already_confirmed')
    expect(await audits('order.fraud_confirmed', 152)).toHaveLength(1)
    expect(await kinds(152)).toEqual(['hold_created', 'confirmed_fraud'])
    expect((await orderRow(152)).payment_status).toBe('paid')
    expect(Number((await q(`SELECT stock_on_hand s FROM product_variants WHERE id=$1`, [VAR]))[0].s)).toBe(stock0)
    expect(Number((await q(`SELECT COUNT(*) c FROM order_refunds`))[0].c)).toBe(refunds0)
  })
})

describeDB('6. feature flag OFF: no holds, previous behavior preserved', () => {
  test('signals are recorded for visibility but nothing is held; fulfillment works; the view says so loudly', async () => {
    needDb(); offFlag()
    await mkOrder(160)
    const r = await svc().ingestStripeEvent(evt('evt_r160', 'review.opened', review(160)))
    expect(r).toMatchObject({ outcome: 'applied', hold: 'disabled' })
    expect(await row(160)).toMatchObject({ hold_state: 'none', stripe_review_state: 'open' })
    expect(await kinds(160)).toEqual(['review_opened', 'hold_not_applied'])
    expect((await events(160))[1].detail).toMatchObject({ why: 'holds_disabled' })
    const v = await fraudRoute('get', 160)
    expect(v.body.data).toMatchObject({ flagged: true, flaggedButHoldsOff: true, holdsEnabled: false })
    expect(v.body.data.hold.state).toBe('none')
    expect((await patch(160, { fulfillmentStatus: 'processing' })).status).toBe(200)
    expect((await patch(160, { fulfillmentStatus: 'shipped', carrier: 'USPS', trackingNumber: 'T160' })).status).toBe(200)
  })
  test('turning the flag ON later does not retro-hold by itself, but a Refresh does (flag ON)', async () => {
    needDb(); offFlag()
    await mkOrder(161)
    await svc().ingestStripeEvent(evt('evt_c161', 'charge.succeeded', charge(161, { outcome: { risk_level: 'elevated', type: 'authorized' } })))
    expect((await row(161)).hold_state).toBe('none')
    onFlag()
    ;(global as any).__STRIPE = { paymentIntents: { retrieve: jest.fn(async () => ({ id: pi(161), latest_charge: charge(161, { outcome: { risk_level: 'elevated', type: 'authorized' } }), review: null })) } }
    const r = await fraudRoute('refresh', 161)
    expect([r.status, r.body.hold]).toEqual([200, 'created'])
  })
  test('flag helper reads the environment at call time', async () => {
    needDb()
    await mkOrder(162)
    const s = createFraudReviewService(F.sql)
    onFlag(); expect(s.holdsEnabled()).toBe(true)
    offFlag(); expect(s.holdsEnabled()).toBe(false)
    process.env.KVRN_FLAG_RADAR_FULFILLMENT_HOLDS = 'maybe'; expect(s.holdsEnabled()).toBe(false)
  })
})

describeDB('7. idempotency, ordering and parked signals', () => {
  test('a duplicate delivery of the same event changes nothing and adds no second event row', async () => {
    needDb(); onFlag()
    await mkOrder(170)
    const e = evt('evt_dup170', 'review.opened', review(170))
    expect(await svc().ingestStripeEvent(e)).toMatchObject({ outcome: 'applied', hold: 'created' })
    const before = { r: await row(170), ev: await events(170) }
    for (let i = 0; i < 3; i++) expect(await svc().ingestStripeEvent(e)).toMatchObject({ outcome: 'duplicate' })
    const after = { r: await row(170), ev: await events(170) }
    expect(after.ev).toEqual(before.ev)
    expect(after.r.hold_state).toBe('active'); expect(after.r.hold_created_at).toEqual(before.r.hold_created_at)
    expect((await audits('order.fraud_hold_created', 170))).toHaveLength(1)
  })
  test('concurrent deliveries of the same event produce one hold', async () => {
    needDb(); onFlag()
    await mkOrder(171)
    const e = evt('evt_cc171', 'review.opened', review(171))
    const res = await Promise.all([svc().ingestStripeEvent(e), svc().ingestStripeEvent(e)].map(p => p.catch((x: any) => ({ outcome: 'error', x }))))
    expect(res.filter((r: any) => r.outcome === 'applied')).toHaveLength(1)
    expect(await kinds(171)).toEqual(['review_opened', 'hold_created'])
  })
  test('out-of-order: a late review.opened cannot reopen a review already closed', async () => {
    needDb(); onFlag()
    await mkOrder(172)
    const t = Math.floor(Date.now() / 1000)
    await svc().ingestStripeEvent(evt('evt_close172', 'review.closed', review(172, { open: false, reason: 'approved', closed_reason: 'approved' }), t))
    const r = await svc().ingestStripeEvent(evt('evt_open172', 'review.opened', review(172), t - 60))
    expect(r).toMatchObject({ outcome: 'applied', hold: 'none' })
    expect(await row(172)).toMatchObject({ stripe_review_state: 'closed', stripe_review_closed_reason: 'approved', hold_state: 'none' })
  })
  test('closing a review does NOT release the hold automatically (explicit owner decision only)', async () => {
    needDb(); onFlag()
    await mkHeld(173)
    await svc().ingestStripeEvent(evt('evt_close173', 'review.closed', review(173, { open: false, reason: 'approved', closed_reason: 'approved' })))
    expect(await row(173)).toMatchObject({ stripe_review_state: 'closed', hold_state: 'active' })
  })
  test('a review for an order that does not exist yet is parked, then replayed once (and still idempotent)', async () => {
    needDb(); onFlag()
    const e = evt('evt_early180', 'review.opened', review(180))
    expect(await svc().ingestStripeEvent(e)).toEqual({ outcome: 'parked' })
    expect(await svc().ingestStripeEvent(e)).toEqual({ outcome: 'parked' })               // duplicate park is a no-op
    expect(Number((await q(`SELECT COUNT(*) c FROM order_fraud_events WHERE stripe_event_id='evt_early180' AND order_id IS NULL`))[0].c)).toBe(1)
    await mkOrder(180)
    await q(`SELECT fraud_review_apply_pending($1,true)`, [oid(180)])
    expect(await row(180)).toMatchObject({ hold_state: 'active', hold_reason: 'stripe_review_open' })
    await q(`SELECT fraud_review_apply_pending($1,true)`, [oid(180)])
    expect(await kinds(180)).toEqual(['review_opened', 'hold_created'])
    expect(await svc().ingestStripeEvent(e)).toMatchObject({ outcome: 'duplicate' })      // the live event arriving after the replay
  })
  test('charge.succeeded for an unknown order is ignored (not parked); malformed events are ignored', async () => {
    needDb(); onFlag()
    expect(await svc().ingestStripeEvent(evt('evt_x1', 'charge.succeeded', charge(9999)))).toEqual({ outcome: 'ignored', reason: 'no_order' })
    expect(await svc().ingestStripeEvent(evt('evt_x2', 'review.opened', { id: 'prv_zzzzzzzz' }))).toEqual({ outcome: 'ignored', reason: 'unusable_object' })
    expect(await svc().ingestStripeEvent(evt('evt_x3', 'payment_intent.succeeded', {}))).toEqual({ outcome: 'ignored', reason: 'unsupported_event' })
  })
  test('a FAILED / blocked charge never creates a record, a hold or a paid state', async () => {
    needDb(); onFlag()
    await mkOrder(181, { payment: 'pending', consume: false })
    const r = await svc().ingestStripeEvent(evt('evt_f181', 'charge.succeeded', charge(181, { status: 'failed', paid: false, outcome: { type: 'blocked', risk_level: 'highest', reason: 'highest_risk_level' } })))
    expect(r).toEqual({ outcome: 'ignored', reason: 'unusable_object' })
    expect(await row(181)).toBeUndefined()
    expect((await orderRow(181)).payment_status).toBe('pending')
    // a review on a still-pending payment does not mark it paid either
    await svc().ingestStripeEvent(evt('evt_r181', 'review.opened', review(181)))
    expect((await orderRow(181)).payment_status).toBe('pending')
  })
})

describeDB('8. Refresh from Stripe (GET only; safe when Stripe is unavailable)', () => {
  test('success applies the outcome + review; only retrieve() is ever called', async () => {
    needDb(); onFlag()
    await mkOrder(190)
    const retrieve = jest.fn(async () => ({ id: pi(190), latest_charge: charge(190, { outcome: { risk_level: 'elevated', risk_score: 71, type: 'manual_review' } }), review: review(190) }))
    const approve = jest.fn()
    ;(global as any).__STRIPE = { paymentIntents: { retrieve }, reviews: { approve, retrieve: jest.fn() } }
    const r = await fraudRoute('refresh', 190)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ success: true, stripeChanged: false })
    expect(retrieve).toHaveBeenCalledWith(pi(190), { expand: ['latest_charge', 'review'] })
    expect(approve).not.toHaveBeenCalled()
    expect(r.body.data).toMatchObject({ riskLevel: 'elevated', riskScore: 71, hold: { state: 'active' }, stripeReview: { state: 'open' } })
    expect(r.body.data.lastSyncedAt).toBeTruthy()
    expect((await audits('order.fraud_refresh', 190))).toHaveLength(1)
  })
  test('a second refresh with the same data changes nothing material and adds no hold', async () => {
    needDb()
    const before = (await events(190)).length
    ;(global as any).__STRIPE = { paymentIntents: { retrieve: async () => ({ id: pi(190), latest_charge: charge(190, { outcome: { risk_level: 'elevated', risk_score: 71, type: 'manual_review' } }), review: review(190) }) } }
    expect((await fraudRoute('refresh', 190)).status).toBe(200)
    expect((await events(190)).length).toBe(before)
  })
  test('Stripe unavailable: 502, the failure is recorded, the order stays Unknown + retryable, nothing else changes', async () => {
    needDb(); onFlag()
    await mkOrder(191)
    ;(global as any).__STRIPE = { paymentIntents: { retrieve: async () => { throw new Error('network down') } } }
    const r = await fraudRoute('refresh', 191)
    expect([r.status, r.body.code]).toEqual([502, 'STRIPE_UNAVAILABLE'])
    expect(JSON.stringify(r.body)).not.toMatch(/network down|stack/)
    expect(await row(191)).toMatchObject({ sync_error: 'STRIPE_UNAVAILABLE', risk_level: null, hold_state: 'none', last_synced_at: null })
    const v = (await fraudRoute('get', 191)).body.data
    expect(v).toMatchObject({ hasRecord: true, riskLevel: null, syncError: 'STRIPE_UNAVAILABLE' })
    expect(await kinds(191)).toEqual(['sync_failed'])
    // retry heals it
    ;(global as any).__STRIPE = { paymentIntents: { retrieve: async () => ({ id: pi(191), latest_charge: charge(191), review: null }) } }
    expect((await fraudRoute('refresh', 191)).status).toBe(200)
    expect(await row(191)).toMatchObject({ sync_error: null, risk_level: 'normal' })
  })
  test('Stripe not configured / order without a payment intent / unknown order', async () => {
    needDb()
    ;(global as any).__STRIPE = null
    const r = await fraudRoute('refresh', 191)
    expect([r.status, r.body.code]).toEqual([503, 'STRIPE_NOT_CONFIGURED'])
    await q(`INSERT INTO orders (id,order_number,stripe_checkout_session_id,payment_status,fulfillment_status,currency,subtotal_cents,shipping_cents,total_cents)
             VALUES ($1,'FR-NOPI','cs_frnopi','paid','unfulfilled','usd',100,0,100)`, [oid(192)])
    ;(global as any).__STRIPE = { paymentIntents: { retrieve: jest.fn() } }
    const n = await fraudRoute('refresh', 192)
    expect([n.status, n.body.code]).toEqual([409, 'NO_PAYMENT_INTENT'])
    expect((await fraudRoute('refresh', 9998)).status).toBe(404)
  })
  test('a payment with no successful charge yet is reported, not guessed', async () => {
    needDb()
    ;(global as any).__STRIPE = { paymentIntents: { retrieve: async () => ({ id: pi(191), latest_charge: null, review: null }) } }
    const r = await fraudRoute('refresh', 191)
    expect([r.status, r.body.code]).toEqual([409, 'NO_CHARGE_DATA'])
  })
  test('order-creation ingestion never throws and records Unknown when Stripe fails; replay of a read order does not call Stripe again', async () => {
    needDb(); onFlag()
    await mkOrder(193); await mkOrder(194)
    const down = { paymentIntents: { retrieve: jest.fn(async () => { throw new Error('boom') }) } }
    await expect(svc().ingestForNewOrder({ orderId: oid(193), paymentIntentId: pi(193), getStripe: () => down as any })).resolves.toBeUndefined()
    expect(await row(193)).toMatchObject({ sync_error: 'STRIPE_UNAVAILABLE', hold_state: 'none' })
    await expect(svc().ingestForNewOrder({ orderId: oid(193), paymentIntentId: null, getStripe: () => { throw new Error('x') } })).resolves.toBeUndefined()
    const ok = { paymentIntents: { retrieve: jest.fn(async () => ({ id: pi(194), latest_charge: charge(194, { outcome: { risk_level: 'elevated', type: 'authorized' } }), review: null })) } }
    await svc().ingestForNewOrder({ orderId: oid(194), paymentIntentId: pi(194), getStripe: () => ok as any })
    expect((await row(194)).hold_state).toBe('active')
    await svc().ingestForNewOrder({ orderId: oid(194), paymentIntentId: pi(194), getStripe: () => ok as any })
    expect(ok.paymentIntents.retrieve).toHaveBeenCalledTimes(1)
  })
})

describeDB('9. a hold changes NO payment, inventory, financial or reconciliation state', () => {
  const snapshot = async (n: number) => ({
    order: (({ updated_at, fulfillment_status, ...rest }) => rest)(await orderRow(n)),
    items: await q(`SELECT * FROM order_items WHERE order_id=$1 ORDER BY id`, [oid(n)]),
    stock: await q(`SELECT stock_on_hand FROM product_variants WHERE id=$1`, [VAR]),
    layers: await q(`SELECT id, units_remaining, unit_landed_cost_cents FROM inventory_cost_layers WHERE variant_id=$1 ORDER BY id`, [VAR]),
    movements: (await q(`SELECT COUNT(*)::int c FROM inventory_movements WHERE variant_id=$1`, [VAR]))[0].c,
    refunds: await q(`SELECT * FROM order_refunds WHERE order_id=$1`, [oid(n)]),
    scan: (await q(`SELECT md5(COALESCE(string_agg(t::text,'|' ORDER BY t::text),'')) h FROM financial_integrity_scan() t`))[0].h,
    states: await q(`SELECT * FROM financial_integrity_entity_states()`),
  })
  test('hold create -> blocked fulfillment attempts -> release: every financial / inventory / order-money input is identical', async () => {
    needDb(); onFlag()
    await mkOrder(200, { fulfillment: 'processing' })
    const s0 = await snapshot(200)
    await svc().ingestStripeEvent(evt('evt_r200', 'review.opened', review(200)))
    expect((await row(200)).hold_state).toBe('active')
    await patch(200, { fulfillmentStatus: 'shipped', carrier: 'USPS', trackingNumber: 'T' })
    await F.err(`SELECT mark_order_shipped($1,'USPS','T')`, [oid(200)])
    const s1 = await snapshot(200)
    expect(s1).toEqual(s0)
    await svc().releaseHold(oid(200), 'owner@kvrn.test', null)
    expect(await snapshot(200)).toEqual(s0)
  })
  test('the reconciliation scan of a held order equals that of an identical un-held order', async () => {
    needDb(); onFlag()
    await mkOrder(201, { fulfillment: 'processing' }); await mkOrder(202, { fulfillment: 'processing' })
    await svc().ingestStripeEvent(evt('evt_r201', 'review.opened', review(201)))
    const codes = async (n: number) => (await q(`SELECT issue_code, state FROM financial_integrity_scan() WHERE order_id=$1 ORDER BY issue_code`, [oid(n)])).map((r: any) => `${r.issue_code}:${r.state}`)
    expect(await codes(201)).toEqual(await codes(202))
  })
  test('a held order that is fully refunded & cancelled reconciles exactly like an un-held one', async () => {
    needDb(); onFlag()
    await mkOrder(203, { fulfillment: 'processing' }); await mkOrder(204, { fulfillment: 'processing' })
    await svc().ingestStripeEvent(evt('evt_r203', 'review.opened', review(203)))
    for (const n of [203, 204]) {
      await q(`SELECT record_order_refund($1,$2,$3,8598,'usd','succeeded','fraudulent',0,now())`, [`re_fr${n}`, pi(n), ch(n)])
      const rid = (await q(`SELECT id FROM order_refunds WHERE stripe_refund_id=$1`, [`re_fr${n}`]))[0].id
      await q(`SELECT resolve_refund_components($1,NULL,NULL,NULL,'jest')`, [rid])
      expect((await patch(n, { fulfillmentStatus: 'cancelled', reason: 'Fraud, refunded', confirm: true })).status).toBe(200)
    }
    const codes = async (n: number) => (await q(`SELECT issue_code, state FROM financial_integrity_scan() WHERE order_id=$1 ORDER BY issue_code`, [oid(n)])).map((r: any) => `${r.issue_code}:${r.state}`)
    expect(await codes(203)).toEqual(await codes(204))
    const cc = (n: number) => q(`SELECT restocked_units, cogs_credit_cents FROM order_cancellations WHERE order_id=$1`, [oid(n)])
    expect(await cc(203)).toEqual(await cc(204))
  })
})

describeDB('10. data safety, history, migration', () => {
  test('the events table is append-only', async () => {
    needDb()
    expect(await F.err(`UPDATE order_fraud_events SET actor='x'`)).toMatch(/append-only/)
    expect(await F.err(`DELETE FROM order_fraud_events`)).toMatch(/append-only/)
  })
  test('nothing sensitive is stored: the whole fraud dataset has no card number, IP, e-mail or address', async () => {
    needDb()
    const dump = JSON.stringify([await q(`SELECT * FROM order_fraud_reviews`), await q(`SELECT * FROM order_fraud_events`)])
    for (const s of ['buyer@example.com', 'Buyer', '4242', 'ip_address', 'fingerprint', '"line1"', '203.0.113']) expect(dump).not.toContain(s)
  })
  test('the view never contains raw reason codes as text for the owner, and carries test-mode Stripe links', async () => {
    needDb()
    delete process.env.STRIPE_MODE
    const v = (await fraudRoute('get', 190)).body.data
    expect(v.hold.reasonLabel).toMatch(/review/i)
    expect(v.links.payment).toBe(`https://dashboard.stripe.com/test/payments/${pi(190)}`)
    expect(v.links.review).toBe(`https://dashboard.stripe.com/test/radar/reviews/${prv(190)}`)
    process.env.STRIPE_MODE = 'live'
    expect((await fraudRoute('get', 190)).body.data.links.payment).toBe(`https://dashboard.stripe.com/payments/${pi(190)}`)
    process.env.STRIPE_MODE = 'bogus'
    expect((await fraudRoute('get', 190)).body.data.links.payment).toBeNull()
    delete process.env.STRIPE_MODE
  })
  test('hold_state CHECKs: an active hold needs a reason; a released one needs who/when', async () => {
    needDb()
    expect(await F.err(`UPDATE order_fraud_reviews SET hold_state='active', hold_reason=NULL WHERE order_id=$1`, [oid(101)])).toMatch(/active_chk|violates/)
    expect(await F.err(`UPDATE order_fraud_reviews SET hold_state='released' WHERE order_id=$1`, [oid(101)])).toMatch(/released_chk|violates/)
    expect(await F.err(`UPDATE order_fraud_reviews SET hold_state='paused' WHERE order_id=$1`, [oid(101)])).toMatch(/hold_chk|violates/)
  })
  test('re-applying migration 031 is a no-op: no error, no resurrected tags, no changed data', async () => {
    needDb()
    await q(`DELETE FROM order_tags WHERE name='UGC'`)
    const before = JSON.stringify([await q(`SELECT * FROM order_tags ORDER BY name`), await q(`SELECT COUNT(*) FROM order_fraud_reviews`)])
    const sqlText = fs.readFileSync(path.resolve(__dirname, '../../db/migrations/031_order_tags_fraud_review.sql'), 'utf8')
    await F.db.query(sqlText)
    await F.db.query(sqlText)
    expect(JSON.stringify([await q(`SELECT * FROM order_tags ORDER BY name`), await q(`SELECT COUNT(*) FROM order_fraud_reviews`)])).toBe(before)
    expect((await q(`SELECT name FROM order_tags WHERE name='UGC'`))).toHaveLength(0)
    expect((await q(`SELECT COUNT(*)::int c FROM pg_trigger WHERE tgname IN ('orders_fraud_hold_guard','shipments_fraud_hold_guard')`))[0].c).toBe(2)
    // the guard still works after the re-apply
    await mkHeld(210)
    expect(await F.err(`UPDATE orders SET fulfillment_status='processing' WHERE id=$1`, [oid(210)])).toMatch(/FRAUD_HOLD_ACTIVE/)
  })
  test('the summaries for the Orders list are one query and flag held orders', async () => {
    needDb()
    const m = await svc().summariesForOrders([oid(210), oid(101), oid(9998)])
    expect(m.get(oid(210))).toMatchObject({ hold: 'active', flagged: true })
    expect(m.get(oid(101))).toMatchObject({ hold: 'none' })
    expect(m.has(oid(9998))).toBe(false)
    expect((await svc().summariesForOrders([])).size).toBe(0)
  })
})

describeDB('11. routes: every fraud route is admin-gated and validates input', () => {
  test.each(['get', 'release', 'refresh', 'confirm'] as const)('%s: unauthenticated -> 401 and no database change', async kind => {
    needDb()
    ;(global as any).__AUTH_OK = false
    const before = JSON.stringify([await q(`SELECT COUNT(*) FROM order_fraud_events`), await q(`SELECT COUNT(*) FROM admin_audit_logs`)])
    const r = await fraudRoute(kind, 210, kind === 'get' || kind === 'refresh' ? undefined : { confirm: true })
    expect(r.status).toBe(401)
    expect(JSON.stringify([await q(`SELECT COUNT(*) FROM order_fraud_events`), await q(`SELECT COUNT(*) FROM admin_audit_logs`)])).toBe(before)
    expect((await row(210)).hold_state).toBe('active')
  })
  test('an invalid order id is a 400; an unknown order is a 404 on GET; bad JSON is a 400', async () => {
    needDb()
    const { GET } = require('../../app/api/admin/orders/[id]/fraud/route')
    const bad = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: 'nope' }) })
    expect(bad.status).toBe(400)
    expect((await fraudRoute('get', 9997)).status).toBe(404)
    const { POST } = require('../../app/api/admin/orders/[id]/fraud/release/route')
    const res = await POST(new NextRequest('http://localhost/x', { method: 'POST', body: '{nope', headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id: oid(210) }) })
    expect(res.status).toBe(400)
  })
})
