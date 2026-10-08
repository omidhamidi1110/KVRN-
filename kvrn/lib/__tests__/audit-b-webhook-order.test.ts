// lib/__tests__/audit-b-webhook-order.test.ts
//
// Audit stage 1, area b: the Radar read at order creation makes up to two Stripe GETs. It must never sit in
// front of the once-only post-order steps (affiliate attribution, owner sale notification) that only run on the
// `order_created` outcome: if Stripe is slow and the request is cut off, Stripe's retry sees `already_processed`
// and those steps would be lost for good, whereas the Radar read heals on that retry.

import { NextRequest } from 'next/server'
import { HAVE_DB, TEST_DB_URL, createFiDb, type FiDb } from './helpers/fi-pg'

const seq: string[] = []
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
  notifyDispute: jest.fn(), notifyPaymentIssue: jest.fn(), notifyRefund: jest.fn(),
  notifySaleAndInventory: jest.fn(async () => { seq.push('notify') }),
  readRefundStatusForNotify: jest.fn(), recordProviderFailure: jest.fn(async () => {}),
}))
jest.mock('@/lib/stripe-client', () => ({
  getStripe: () => { const s = (global as any).__STRIPE; if (!s) throw new Error('no stripe'); return s },
  verifyWebhookSignature: async (raw: string) => JSON.parse(raw),
}))

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) test(TEST_DB_URL ? 'NOTE: skipped — not local.' : 'NOTE: skipped — TEST_DATABASE_URL absent.', () => expect(true).toBe(true))

let F: FiDb
const q = (t: string, p: unknown[] = []) => F.q(t, p)
const oid = (n: number) => `f3400000-0000-0000-0000-${String(n).padStart(12, '0')}`
const pi = (n: number) => `pi_awo${String(n).padStart(6, '0')}`

beforeAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_' + 'k'.repeat(32)
  if (!HAVE_DB) return
  F = await createFiDb('kvrn_awo')
  ;(global as any).__CX_SQL = F.sql
}, 180_000)
afterAll(async () => { delete process.env.KVRN_FLAG_RADAR_FULFILLMENT_HOLDS; await F?.close() })

test('the Radar Stripe read runs after attribution and the sale notification, never before', async () => {
  if (!HAVE_DB) return
  process.env.KVRN_FLAG_RADAR_FULFILLMENT_HOLDS = 'on'
  const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await q(`INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,fulfillment_status,currency,
        subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,shipping_quoted_cents,shipping_before_discount_cents,customer_email,customer_name)
      VALUES ($1,'AWO-1','cs_awo1',$2,'paid','unfulfilled','usd',8000,598,0,0,8598,now(),598,598,'b@example.com','B')`, [oid(1), pi(1)])
    ;(global as any).__STRIPE = { paymentIntents: { retrieve: jest.fn(async () => {
      seq.push('stripe_read')
      return { id: pi(1), review: null, latest_charge: { id: 'ch_awo000001', status: 'succeeded', payment_intent: pi(1), outcome: { risk_level: 'normal', type: 'authorized' } } }
    }) } }
    finalizePaidOrder.mockResolvedValue({ outcome: 'order_created', orderId: oid(1), orderNumber: 'AWO-1', alreadyProcessed: false })
    const { POST } = await import('../../app/api/stripe/webhook/route')
    const ev = { id: 'evt_awo_1', type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), data: { object: {
      id: 'cs_awo1', payment_status: 'paid', amount_total: 8598, currency: 'usd', payment_intent: pi(1), metadata: { reservation_id: 'r1' } } } }
    const req: any = new Request('https://kvrn.shop/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=x' }, body: JSON.stringify(ev) })
    req.nextUrl = new URL('https://kvrn.shop/api/stripe/webhook')
    expect((await POST(req as NextRequest)).status).toBe(200)
    expect(seq).toContain('stripe_read')
    expect(seq.indexOf('notify')).toBeGreaterThanOrEqual(0)
    expect(seq.indexOf('notify')).toBeLessThan(seq.indexOf('stripe_read'))
  } finally { errSpy.mockRestore(); logSpy.mockRestore() }
})
