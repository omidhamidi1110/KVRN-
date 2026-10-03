// lib/__tests__/launch-blockers-rev1-webhook.test.ts
//
// The REAL Stripe webhook route, with finalizePaidOrder substituted, proving how a
// paid-but-unfinalizable payment is surfaced: loudly logged, acknowledged (the durable
// payment_exceptions row — not a Stripe retry — is the record), and never emailed.

import { NextRequest } from 'next/server'

const finalizePaidOrder = jest.fn()
jest.mock('@/lib/reservations', () => ({
  finalizePaidOrder: (...a: unknown[]) => finalizePaidOrder(...a),
  releaseReservationForEvent: jest.fn(), markAwaitingPayment: jest.fn(),
}))
jest.mock('@/lib/db', () => ({ sql: jest.fn(async () => []) }))
const processEmails = jest.fn(async (..._a: unknown[]) => ({}))
jest.mock('@/lib/transactional-email', () => ({ processPendingTransactionalEmails: (...a: unknown[]) => processEmails(...a) }))
jest.mock('@/lib/resend-adapter', () => ({ getEmailProvider: () => ({}) }))
jest.mock('@/lib/discounts', () => ({ releaseDiscountClaim: jest.fn() }))
jest.mock('@/lib/stripe-fees', () => ({ reconcileStripeFeeForOrder: jest.fn(async () => ({ outcome: 'noop' })) }))
jest.mock('@/lib/stripe-client', () => ({
  getStripe: () => ({}),
  verifyWebhookSignature: async (raw: string) => JSON.parse(raw),
}))

const event = (id: string) => ({
  id, type: 'checkout.session.completed', created: 1,
  data: { object: { id: 'cs_live_x', payment_status: 'paid', amount_total: 8700, currency: 'usd',
                    payment_intent: 'pi_1', metadata: { reservation_id: 'r1' },
                    customer_details: { email: 'secret.customer@example.com', name: 'Secret Name' } } },
})
const post = async (ev: unknown) => {
  const { POST } = await import('../../app/api/stripe/webhook/route')
  const req: any = new Request('https://kvrn.shop/api/stripe/webhook', {
    method: 'POST', headers: { 'stripe-signature': 't=1,v1=x' }, body: JSON.stringify(ev) })
  req.nextUrl = new URL('https://kvrn.shop/api/stripe/webhook')
  return POST(req as NextRequest)
}

let errSpy: jest.SpyInstance
beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_' + 'k'.repeat(32)
  finalizePaidOrder.mockReset(); processEmails.mockClear()
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => errSpy.mockRestore())

describe('webhook surfaces a payment exception', () => {
  test('insufficient_stock: 200 + PAYMENT_EXCEPTION log with ids only, no email attempt', async () => {
    finalizePaidOrder.mockResolvedValue({ outcome: 'payment_exception', reason: 'insufficient_stock',
      paymentExceptionId: 'ex-1', alreadyProcessed: false })
    const res = await post(event('evt_a'))
    expect(res.status).toBe(200)
    expect(processEmails).not.toHaveBeenCalled()
    const line = errSpy.mock.calls.find(c => c[0] === '[WEBHOOK][PAYMENT_EXCEPTION]')
    expect(line).toBeTruthy()
    expect(JSON.parse(line![1])).toMatchObject({ exceptionId: 'ex-1', reason: 'insufficient_stock',
      sessionId: 'cs_live_x', eventId: 'evt_a', amountTotal: 8700 })
    expect(String(line![1])).not.toMatch(/secret\.customer|Secret Name/)        // no PII in logs
  })
  test('legacy no_reservation outcome is logged as an exception too', async () => {
    finalizePaidOrder.mockResolvedValue({ outcome: 'no_reservation', paymentExceptionId: 'ex-2', alreadyProcessed: false })
    expect((await post(event('evt_b'))).status).toBe(200)
    expect(errSpy.mock.calls.some(c => c[0] === '[WEBHOOK][PAYMENT_EXCEPTION]')).toBe(true)
  })
  test('a replay of an existing exception is acknowledged and flagged duplicate', async () => {
    finalizePaidOrder.mockResolvedValue({ outcome: 'payment_exception', paymentExceptionId: 'ex-1', alreadyProcessed: true })
    expect((await post(event('evt_c'))).status).toBe(200)
    const line = errSpy.mock.calls.find(c => c[0] === '[WEBHOOK][PAYMENT_EXCEPTION]')
    expect(JSON.parse(line![1]).duplicate).toBe(true)
  })
  test('a normal order still emails once and logs no exception', async () => {
    finalizePaidOrder.mockResolvedValue({ outcome: 'order_created', orderId: 'o1', orderNumber: 'KVRN-1', alreadyProcessed: false })
    expect((await post(event('evt_d'))).status).toBe(200)
    expect(processEmails).toHaveBeenCalledTimes(1)
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('PAYMENT_EXCEPTION'))).toBe(false)
  })
  test('a recovered late payment emails once and is logged for the operator', async () => {
    finalizePaidOrder.mockResolvedValue({ outcome: 'order_created', orderId: 'o2', orderNumber: 'KVRN-2', alreadyProcessed: false, recovered: true })
    expect((await post(event('evt_e'))).status).toBe(200)
    expect(processEmails).toHaveBeenCalledTimes(1)
    expect(errSpy.mock.calls.some(c => c[0] === '[WEBHOOK][LATE_PAYMENT_RECOVERED]')).toBe(true)
  })
  test('a replayed completed order does not email again', async () => {
    finalizePaidOrder.mockResolvedValue({ outcome: 'already_processed', orderId: 'o1', alreadyProcessed: true })
    expect((await post(event('evt_f'))).status).toBe(200)
    expect(processEmails).not.toHaveBeenCalled()
  })
})
