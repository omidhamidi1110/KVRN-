// lib/__tests__/fraud-review-webhook.test.ts
//
// The REAL Stripe webhook route + real PostgreSQL (local TEST_DATABASE_URL only), with the Stripe SDK, order
// finalization, e-mail and analytics replaced. Proves how Radar signals flow through the webhook:
// flag ON/OFF, duplicate delivery, a review that arrives before its order, ingestion failure never failing or
// changing a paid order, no Stripe call with the flag OFF, and a failed charge never becoming paid.

import { NextRequest } from 'next/server'
import { HAVE_DB, TEST_DB_URL, createFiDb, type FiDb } from './helpers/fi-pg'

const finalizePaidOrder = jest.fn()
jest.mock('@/lib/reservations', () => ({
  finalizePaidOrder: (...a: unknown[]) => finalizePaidOrder(...a),
  releaseReservationForEvent: jest.fn(), markAwaitingPayment: jest.fn(),
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__CX_SQL } }))
jest.mock('@/lib/transactional-email', () => ({ processPendingTransactionalEmails: jest.fn(async () => ({})) }))
jest.mock('@/lib/resend-adapter', () => ({ getEmailProvider: () => ({}) }))
jest.mock('@/lib/discounts', () => ({ releaseDiscountClaim: jest.fn() }))
jest.mock('@/lib/stripe-fees', () => ({ reconcileStripeFeeForOrder: jest.fn(async () => ({ outcome: 'noop' })) }))
jest.mock('@/lib/funnel-analytics', () => ({ tryRecordPurchase: jest.fn(async () => {}) }))
jest.mock('@/lib/ga4-server', () => ({ tryRecordGaPurchase: jest.fn(async () => {}) }))
jest.mock('@/lib/owner-notifications', () => ({
  notifyDispute: jest.fn(), notifyPaymentIssue: jest.fn(), notifyRefund: jest.fn(), notifySaleAndInventory: jest.fn(async () => {}),
  readRefundStatusForNotify: jest.fn(), recordProviderFailure: jest.fn(async () => {}),
}))
jest.mock('@/lib/stripe-client', () => ({
  getStripe: () => { const s = (global as any).__STRIPE; if (!s) throw new Error('no stripe'); return s },
  verifyWebhookSignature: async (raw: string) => JSON.parse(raw),
}))

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL ? 'NOTE: fraud webhook tests skipped — TEST_DATABASE_URL is not a local server.' : 'NOTE: fraud webhook tests skipped — TEST_DATABASE_URL absent.', () => {
    expect(true).toBe(true)
  })
}

let F: FiDb
let pgFail: string | null = null
const needDb = () => { if (pgFail) throw new Error('local PostgreSQL unavailable: ' + pgFail) }
const q = (t: string, p: unknown[] = []) => F.q(t, p)

const VAR = 'f3200000-0000-0000-0000-00000000b001'
const PRD = 'f3200000-0000-0000-0000-00000000aaaa'
const oid = (n: number) => `f3210000-0000-0000-0000-${String(n).padStart(12, '0')}`
const pi  = (n: number) => `pi_fwh${String(n).padStart(6, '0')}`
const ch  = (n: number) => `ch_fwh${String(n).padStart(6, '0')}`
const onFlag  = () => { process.env.KVRN_FLAG_RADAR_FULFILLMENT_HOLDS = 'on' }
const offFlag = () => { delete process.env.KVRN_FLAG_RADAR_FULFILLMENT_HOLDS }

let errSpy: jest.SpyInstance
let logSpy: jest.SpyInstance
beforeAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_' + 'k'.repeat(32)
  if (!HAVE_DB) return
  try {
    F = await createFiDb('kvrn_frw')
    ;(global as any).__CX_SQL = F.sql
    await q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active) VALUES ($1,'W','W','FRW','frw',8000,true)`, [PRD])
    await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand) VALUES ($1,$2,'FRW-M','Black','#000','M',1,500)`, [VAR, PRD])
  } catch (e: any) { pgFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { offFlag(); await F?.close() })
beforeEach(() => {
  ;(global as any).__STRIPE = null; ;(global as any).__CX_SQL = F?.sql; offFlag()
  finalizePaidOrder.mockReset()
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { errSpy.mockRestore(); logSpy.mockRestore() })

async function mkOrder(n: number, payment = 'paid') {
  await q(`INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,
      payment_status,fulfillment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,
      shipping_quoted_cents,shipping_before_discount_cents,customer_email,customer_name)
    VALUES ($1,$2,$3,$4,$5,$6,'unfulfilled','usd',8000,598,0,0,8598,${payment === 'paid' ? 'now()' : 'NULL'},598,598,'buyer@example.com','Buyer')`,
    [oid(n), `FW-${n}`, `cs_fw${n}`, pi(n), ch(n), payment])
  return oid(n)
}

const charge = (n: number, over: Record<string, any> = {}) => ({
  id: ch(n), status: 'succeeded', paid: true, payment_intent: pi(n),
  billing_details: { address: { country: 'US' } },
  outcome: { risk_level: 'normal', type: 'authorized', network_status: 'approved_by_network' },
  payment_method_details: { card: { country: 'US', funding: 'credit', checks: { cvc_check: 'pass' }, three_d_secure: null } },
  ...over,
})
const review = (n: number, over: Record<string, any> = {}) => ({
  id: `prv_fwh${String(n).padStart(6, "0")}1`, open: true, reason: 'rule', opened_reason: 'rule', closed_reason: null, payment_intent: pi(n), charge: ch(n), ...over,
})
const evt = (id: string, type: string, object: any, created = Math.floor(Date.now() / 1000)) => ({ id, type, created, data: { object } })
const sessionEvt = (id: string, n: number) => evt(id, 'checkout.session.completed', {
  id: `cs_fw${n}`, payment_status: 'paid', amount_total: 8598, currency: 'usd', payment_intent: pi(n), metadata: { reservation_id: `r${n}` },
})

const post = async (ev: unknown) => {
  const { POST } = await import('../../app/api/stripe/webhook/route')
  const req: any = new Request('https://kvrn.shop/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=x' }, body: JSON.stringify(ev) })
  req.nextUrl = new URL('https://kvrn.shop/api/stripe/webhook')
  return POST(req as NextRequest)
}
const frow = async (n: number) => (await q(`SELECT * FROM order_fraud_reviews WHERE order_id=$1`, [oid(n)]))[0]
const orderRow = async (n: number) => (await q(`SELECT payment_status, fulfillment_status, total_cents FROM orders WHERE id=$1`, [oid(n)]))[0]
const evCount = async (n: number) => Number((await q(`SELECT count(*)::int AS c FROM order_fraud_events WHERE order_id=$1`, [oid(n)]))[0].c)
const stripeMock = (n: number, opts: { risk?: string; review?: any } = {}) => {
  const retrieve = jest.fn(async () => ({ id: pi(n), review: opts.review ?? null,
    latest_charge: charge(n, { outcome: { risk_level: opts.risk ?? 'normal', type: 'authorized' } }) }))
  const s = { paymentIntents: { retrieve }, charges: { retrieve: jest.fn() }, reviews: { retrieve: jest.fn() } }
  ;(global as any).__STRIPE = s
  return s
}

describeDB('fraud signals through the real webhook', () => {
  test('flag ON: review.opened holds the order; payment stays PAID; duplicate delivery is a no-op', async () => {
    needDb(); onFlag()
    await mkOrder(1)
    const before = await orderRow(1)
    const e = evt('evt_fw_open_1', 'review.opened', review(1))
    expect((await post(e)).status).toBe(200)
    expect((await frow(1)).hold_state).toBe('active')
    const n1 = await evCount(1)
    expect((await post(e)).status).toBe(200)                  // redelivery
    expect(await evCount(1)).toBe(n1)
    expect((await frow(1)).hold_state).toBe('active')
    expect(await orderRow(1)).toEqual({ ...before, fulfillment_status: 'unfulfilled' })
    expect((await orderRow(1)).payment_status).toBe('paid')
  })

  test('flag OFF: the review is recorded for visibility but creates NO hold, and the webhook still returns 200', async () => {
    needDb(); offFlag()
    await mkOrder(2)
    expect((await post(evt('evt_fw_open_2', 'review.opened', review(2)))).status).toBe(200)
    const r = await frow(2)
    expect(r?.hold_state ?? 'none').toBe('none')
    expect((await orderRow(2)).payment_status).toBe('paid')
  })

  test('a review that arrives BEFORE its order is parked, then applied (held) when the order is created', async () => {
    needDb(); onFlag()
    const s = stripeMock(3)                                    // the order-creation read finds no charge risk
    expect((await post(evt('evt_fw_open_3', 'review.opened', review(3)))).status).toBe(200)
    expect(await frow(3)).toBeUndefined()
    const parked = await q(`SELECT event_type FROM order_fraud_events WHERE stripe_event_id='evt_fw_open_3'`)
    expect(parked.map((p: any) => p.event_type)).toContain('unmatched_signal')
    finalizePaidOrder.mockImplementation(async () => { await mkOrder(3); return { outcome: 'order_created', orderId: oid(3), orderNumber: 'FW-3', alreadyProcessed: false } })
    expect((await post(sessionEvt('evt_fw_sess_3', 3))).status).toBe(200)
    expect((await frow(3)).hold_state).toBe('active')
    expect((await orderRow(3)).payment_status).toBe('paid')
    expect(s.paymentIntents.retrieve).toHaveBeenCalledTimes(1)  // exactly one GET; never a write
  })

  test('flag ON, order creation: charge outcome is read once; replaying the webhook does not call Stripe again', async () => {
    needDb(); onFlag()
    const s = stripeMock(4, { risk: 'elevated' })
    finalizePaidOrder.mockImplementation(async () => { await mkOrder(4); return { outcome: 'order_created', orderId: oid(4), orderNumber: 'FW-4', alreadyProcessed: false } })
    expect((await post(sessionEvt('evt_fw_sess_4', 4))).status).toBe(200)
    expect(await frow(4)).toMatchObject({ risk_level: 'elevated' })
    expect(s.paymentIntents.retrieve).toHaveBeenCalledTimes(1)
    finalizePaidOrder.mockResolvedValue({ outcome: 'already_processed', orderId: oid(4), alreadyProcessed: true })
    expect((await post(sessionEvt('evt_fw_sess_4b', 4))).status).toBe(200)
    expect(s.paymentIntents.retrieve).toHaveBeenCalledTimes(1)
  })

  test('flag OFF, order creation: NO Stripe call and NO fraud rows (previous behavior preserved)', async () => {
    needDb(); offFlag()
    const s = stripeMock(5)
    finalizePaidOrder.mockImplementation(async () => { await mkOrder(5); return { outcome: 'order_created', orderId: oid(5), orderNumber: 'FW-5', alreadyProcessed: false } })
    expect((await post(sessionEvt('evt_fw_sess_5', 5))).status).toBe(200)
    expect(s.paymentIntents.retrieve).not.toHaveBeenCalled()
    expect(await frow(5)).toBeUndefined()
    expect((await orderRow(5)).payment_status).toBe('paid')
  })

  test('ingestion failure at order creation (Stripe down) never fails or changes the paid order; risk stays Unknown + retryable', async () => {
    needDb(); onFlag()
    ;(global as any).__STRIPE = { paymentIntents: { retrieve: jest.fn(async () => { throw new Error('stripe down') }) } }
    finalizePaidOrder.mockImplementation(async () => { await mkOrder(6); return { outcome: 'order_created', orderId: oid(6), orderNumber: 'FW-6', alreadyProcessed: false } })
    const res = await post(sessionEvt('evt_fw_sess_6', 6))
    expect(res.status).toBe(200)
    expect(await orderRow(6)).toMatchObject({ payment_status: 'paid', fulfillment_status: 'unfulfilled', total_cents: 8598 })
    const r = await frow(6)
    expect(r.risk_level).toBeNull()                            // Unknown, not "normal"
    expect(r.hold_state).toBe('none')
    expect(r.sync_error).toBeTruthy()
  })

  test('failure policy for signal events: flag OFF acknowledges (200); flag ON asks Stripe to retry (500)', async () => {
    needDb()
    const real = F.sql
    const broken: any = (s: TemplateStringsArray, ...v: unknown[]) =>
      /fraud/.test(s.join('')) ? Promise.reject(new Error('db boom')) : (real as any)(s, ...v)
    ;(global as any).__CX_SQL = broken
    await mkOrder(7)
    offFlag()
    expect((await post(evt('evt_fw_f_off', 'review.opened', review(7)))).status).toBe(200)
    onFlag()
    expect((await post(evt('evt_fw_f_on', 'review.opened', review(7)))).status).toBe(500)
    ;(global as any).__CX_SQL = real
    expect((await orderRow(7)).payment_status).toBe('paid')
    // the retry then succeeds
    expect((await post(evt('evt_fw_f_on', 'review.opened', review(7)))).status).toBe(200)
    expect((await frow(7)).hold_state).toBe('active')
  })

  test('a failed charge never becomes paid and never creates a hold', async () => {
    needDb(); onFlag()
    await mkOrder(8, 'pending')
    const failed = charge(8, { status: 'failed', paid: false, outcome: { risk_level: 'highest', type: 'issuer_declined' } })
    expect((await post(evt('evt_fw_fail_8', 'charge.succeeded', failed))).status).toBe(200)
    expect((await orderRow(8)).payment_status).toBe('pending')
    expect((await frow(8))?.hold_state ?? 'none').toBe('none')
  })

  test('review.closed does not auto-release an active hold', async () => {
    needDb(); onFlag()
    await mkOrder(9)
    const t = Math.floor(Date.now() / 1000)
    await post(evt('evt_fw_o9', 'review.opened', review(9), t))
    await post(evt('evt_fw_c9', 'review.closed', review(9, { open: false, closed_reason: 'approved' }), t + 5))
    const r = await frow(9)
    expect(r.hold_state).toBe('active')
    expect(r.stripe_review_state).toBe('closed')
  })

  test('unrelated events and unknown objects are acknowledged', async () => {
    needDb(); onFlag()
    expect((await post(evt('evt_fw_x1', 'review.opened', { id: 'prv_x' }))).status).toBe(200)
    expect((await post(evt('evt_fw_x2', 'charge.succeeded', charge(999)))).status).toBe(200)   // no such order
  })
})
