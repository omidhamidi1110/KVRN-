// lib/__tests__/funnel-analytics-money-path.test.ts
//
// Funnel analytics on the MONEY PATH, through the real handlers:
//   * lib/checkout-session-handler.ts  (checkout_started)
//   * app/api/stripe/webhook/route.ts  (purchase_completed, via the real finalize_paid_order)
//
// SUBSTITUTED, and only these external boundaries: Stripe client + signature check, Shippo
// rates, the reservation/Stripe-attach deps the handler takes by injection, and the DB
// TRANSPORT (Neon's HTTP driver cannot reach a local PostgreSQL). Every SQL statement, the
// paid-order finalization and the analytics SQL are real.
//
// Requires TEST_DATABASE_URL (local PostgreSQL); skips visibly otherwise.

import { HAVE_DB, createFiDb, type FiDb } from './helpers/fi-pg'
import { pgSqlWithFaults, connectPg, disconnectPg, failNextMatching, clearFailures } from './helpers/pg-transport'

// The real transport, plus one extra fault this file needs: a statement that NEVER settles
// (a hung analytics query). Armed per test via global.__FA_HANG (a RegExp).
jest.mock('../db', () => {
  const real = require('./helpers/pg-transport').pgSqlWithFaults
  const wrapped: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const hang = (global as any).__FA_HANG as RegExp | null | undefined
    if (hang && hang.test(strings.join('?'))) return new Promise(() => {})
    return real(strings, ...values)
  }
  wrapped.unsafe = real.unsafe
  return { sql: wrapped }
})

const stripeCreate = jest.fn()
let verifyImpl: (raw: string, sig: string, secret: string) => any
jest.mock('../stripe-client', () => ({
  getStripe: () => ({ checkout: { sessions: { create: stripeCreate, retrieve: jest.fn() } } }),
  verifyWebhookSignature: (r: string, s: string, sec: string) => verifyImpl(r, s, sec),
  isValidStripeTestSecretKey: () => true,
  isValidWebhookSecret: () => true,
}))
jest.mock('../shippo', () => ({
  ...jest.requireActual('../shippo'),
  getShippoRates: jest.fn(async () => ({
    ok: true,
    standard: { amountCents: 800, provider: 'USPS', servicelevelName: 'Ground', estimatedDays: 4, objectId: 'rate_std' },
    express:  { amountCents: 2200, provider: 'UPS', servicelevelName: '2nd Day', estimatedDays: 2, objectId: 'rate_exp' },
  })),
}))
jest.mock('../admin-auth', () => ({
  requireAdmin: async () => ({ identity: { email: 'admin@kvrn.test' }, error: null }),
}))

const describeDB = HAVE_DB ? describe : describe.skip

const reserveInventory = jest.fn()
const saveReservationCheckoutDetails = jest.fn()
const attachStripeSession = jest.fn()
const failReservation = jest.fn()

let F: FiDb
let webhookPOST: any
let checkoutPOST: any
let seq = 0
const uid = () => `f3000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`
const newSid = () => crypto.randomUUID()

beforeAll(async () => {
  if (!HAVE_DB) return
  F = await createFiDb('kvrn_funnelmp')
  await connectPg(`kvrn_funnelmp_${process.pid}`)
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
  process.env.ENABLE_STRIPE_TEST_CHECKOUT = 'true'
  process.env.SHIPPO_API_TOKEN = 'shippo_test_token'
  webhookPOST = (await import('../../app/api/stripe/webhook/route')).POST
  const { createCheckoutPostHandler } = await import('../checkout-session-handler')
  checkoutPOST = createCheckoutPostHandler({
    isCheckoutEnabled: () => true,
    getSiteOrigin: () => 'https://kvrn.shop',
    getStripe: () => ({ checkout: { sessions: { create: stripeCreate } } }) as any,
    reserveInventory, saveReservationCheckoutDetails, failReservation,
    attachStripeSession, releaseExpiredReservations: jest.fn(),
  } as any)
}, 180_000)
afterAll(async () => { await disconnectPg(); await F?.close() })
beforeEach(() => { clearFailures(); (global as any).__FA_HANG = null })
afterEach(() => { (global as any).__FA_HANG = null })

/** A reservation with real stock behind it, ready for the real checkout handler. */
async function fixture() {
  const productId = uid(); const variantId = uid(); const reservationId = uid()
  const sku = `KVRN-FM-${seq}`
  await F.q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
             VALUES ($1,'FM','FM','FM Tee',$2,10000,true)`, [productId, `fm-${seq}`])
  await F.q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand,reserved_quantity,active)
             VALUES ($1,$2,$3,'Black','BLK','M',2,10,1,true)`, [variantId, productId, sku])
  await F.q(`INSERT INTO reservations (id, expires_at, status) VALUES ($1, NOW() + INTERVAL '15 minutes','open')`, [reservationId])
  await F.q(`INSERT INTO reservation_items (reservation_id, variant_id, sku, product_name, size, color, quantity, unit_price_cents)
             VALUES ($1,$2,$3,'FM Tee','M','Black',1,10000)`, [reservationId, variantId, sku])
  await F.q(`UPDATE reservations
             SET shipping_quoted_cents = 800, shipping_final_cents = 800, shipping_cents = 800,
                 shipping_before_discount_cents = 800, shipping_discount_cents = 0,
                 shipping_auto_free_discount_cents = 0, discount_cents = 0,
                 shipping_method = 'standard', customer_email = 'buyer@example.com'
             WHERE id = $1`, [reservationId])
  reserveInventory.mockReset().mockResolvedValue({
    ok: true, reservationId,
    items: [{ sku, variantId, quantity: 1, unitPriceCents: 10000, name: 'FM Tee', size: 'M', colorName: 'Black' }],
    subtotalCents: 10000, expiresAt: new Date(Date.now() + 9e5).toISOString(),
  })
  saveReservationCheckoutDetails.mockReset().mockResolvedValue({ ok: true })
  attachStripeSession.mockReset().mockResolvedValue({ ok: true })
  failReservation.mockReset().mockResolvedValue(undefined)
  const checkoutSessionId = `cs_fm_${seq}`
  stripeCreate.mockReset().mockResolvedValue({ id: checkoutSessionId, url: 'https://stripe.test/pay' })
  return { productId, variantId, reservationId, sku, checkoutSessionId }
}

async function checkout(fx: { sku: string }, analyticsSessionId?: unknown) {
  const body: any = {
    items: [{ sku: fx.sku, quantity: 1 }], email: 'buyer@example.com',
    shippingAddress: { firstName: 'A', lastName: 'Buyer', line1: '1 Test St', city: 'Austin',
                       state: 'TX', postalCode: '78701', country: 'US' },
    shippingMethod: 'standard',
  }
  if (analyticsSessionId !== undefined) body.analyticsSessionId = analyticsSessionId
  const req: any = new Request('https://kvrn.shop/api/checkout/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  req.nextUrl = new URL('https://kvrn.shop/api/checkout/session')
  req.cookies = { get: () => undefined }
  return checkoutPOST(req)
}

function webhookReq(evt: unknown) {
  const req: any = new Request('https://kvrn.shop/api/stripe/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=test' },
    body: JSON.stringify(evt),
  })
  req.nextUrl = new URL('https://kvrn.shop/api/stripe/webhook')
  return req
}
const paid = (eventId: string, fx: { checkoutSessionId: string; reservationId: string }) => ({
  id: eventId, type: 'checkout.session.completed',
  data: { object: {
    id: fx.checkoutSessionId, object: 'checkout.session', payment_status: 'paid',
    payment_intent: `pi_${fx.checkoutSessionId}`, currency: 'usd',
    amount_total: 10800, amount_subtotal: 10800, client_reference_id: null,
    customer_details: { email: 'buyer@example.com', name: 'A Buyer' },
    collected_information: { shipping_details: { name: 'A Buyer',
      address: { line1: '1 Test St', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } } },
    metadata: { reservation_id: fx.reservationId },
    total_details: { amount_discount: 0, amount_shipping: 800, amount_tax: 0 },
  } },
})
const deliver = (evt: any) => { verifyImpl = () => evt; return webhookPOST(webhookReq(evt)) }

const events = (name: string, where = '', p: unknown[] = []) =>
  F.q(`SELECT * FROM analytics_events WHERE event_name=$1 ${where}`, [name, ...p])

// ═════════════════════════════════════════════════════════════════════════════
describeDB('checkout_started — recorded by the real checkout handler', () => {
  test('a successful checkout with a consented session id records exactly one checkout_started', async () => {
    const fx = await fixture(); const sid = newSid()
    const res = await checkout(fx, sid)
    expect(res.status).toBe(200)
    expect((await res.json()).url).toBe('https://stripe.test/pay')
    const rows = await events('checkout_started', 'AND session_id=$2', [sid])
    expect(rows).toHaveLength(1)
    expect(rows[0].reservation_id).toBe(fx.reservationId)
    expect(Number(rows[0].value_cents)).toBe(10000)                          // reservation subtotal, integer cents
    expect(rows[0].meta).toEqual({ items: [{ v: fx.variantId, q: 1 }] })     // ids and quantities only
    expect(await F.q(`SELECT 1 FROM analytics_sessions WHERE session_id=$1`, [sid])).toHaveLength(1)
  })

  test('nothing PII-shaped from the checkout body reaches the analytics tables', async () => {
    const fx = await fixture(); const sid = newSid()
    await checkout(fx, sid)
    const dump = JSON.stringify([
      await F.q(`SELECT * FROM analytics_events WHERE session_id=$1`, [sid]),
      await F.q(`SELECT * FROM analytics_sessions WHERE session_id=$1`, [sid]),
    ])
    for (const pii of ['buyer@example.com', 'A Buyer', 'Buyer', '1 Test St', 'Austin', '78701']) {
      expect(dump).not.toContain(pii)
    }
  })

  test('without an analytics session id (no consent) checkout works and records nothing', async () => {
    const fx = await fixture()
    const before = (await F.q(`SELECT COUNT(*)::int n FROM analytics_events`))[0].n
    const res = await checkout(fx)
    expect(res.status).toBe(200)
    expect((await F.q(`SELECT COUNT(*)::int n FROM analytics_events`))[0].n).toBe(before)
  })

  test.each([['not-a-uuid'], [123], [{ a: 1 }], ['x'.repeat(500)], [null]])(
    'a malformed analyticsSessionId (%p) is ignored: checkout still succeeds, nothing recorded', async bad => {
      const fx = await fixture()
      const before = (await F.q(`SELECT COUNT(*)::int n FROM analytics_events WHERE event_name='checkout_started'`))[0].n
      const res = await checkout(fx, bad)
      expect(res.status).toBe(200)
      expect((await F.q(`SELECT COUNT(*)::int n FROM analytics_events WHERE event_name='checkout_started'`))[0].n).toBe(before)
    })

  test('a failed Stripe session creation is NOT a checkout start', async () => {
    const fx = await fixture(); const sid = newSid()
    stripeCreate.mockReset().mockRejectedValue(new Error('stripe down'))
    const res = await checkout(fx, sid)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await events('checkout_started', 'AND session_id=$2', [sid])).toHaveLength(0)
  })

  test('a failed attach of the Stripe session to the reservation is NOT a checkout start', async () => {
    const fx = await fixture(); const sid = newSid()
    attachStripeSession.mockReset().mockRejectedValue(new Error('db down'))
    const res = await checkout(fx, sid)
    expect(res.status).toBe(500)
    expect(await events('checkout_started', 'AND session_id=$2', [sid])).toHaveLength(0)
  })

  test('an analytics insert failure never fails the checkout', async () => {
    const fx = await fixture(); const sid = newSid()
    failNextMatching(/INSERT INTO analytics_events/, false)
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await checkout(fx, sid)
    spy.mockRestore()
    expect(res.status).toBe(200)
    expect((await res.json()).url).toBe('https://stripe.test/pay')
    expect(await events('checkout_started', 'AND session_id=$2', [sid])).toHaveLength(0)
  })

  test('a session-upsert failure never fails the checkout either', async () => {
    const fx = await fixture(); const sid = newSid()
    failNextMatching(/INSERT INTO analytics_sessions/, false)
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await checkout(fx, sid)
    spy.mockRestore()
    expect(res.status).toBe(200)
  })

  test('re-running checkout creation for the same reservation does not add a second start', async () => {
    const fx = await fixture(); const sid = newSid()
    await checkout(fx, sid)
    await checkout(fx, sid)
    expect(await events('checkout_started', 'AND reservation_id=$2', [fx.reservationId])).toHaveLength(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describeDB('purchase_completed — recorded by the real webhook, idempotent, never blocks the order', () => {
  const orderOf = (cs: string) => F.q(`SELECT id, payment_status, total_cents FROM orders WHERE stripe_checkout_session_id=$1`, [cs])

  test('a paid order records exactly one purchase: orders.total_cents verbatim, the checkout session, the order id', async () => {
    const fx = await fixture(); const sid = newSid()
    await checkout(fx, sid)
    const res = await deliver(paid(`evt_${fx.checkoutSessionId}`, fx))
    expect(res.status).toBe(200)
    const [order] = await orderOf(fx.checkoutSessionId)
    expect(order.payment_status).toBe('paid')
    const rows = await events('purchase_completed', 'AND order_id=$2', [order.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].session_id).toBe(sid)
    expect(Number(rows[0].value_cents)).toBe(Number(order.total_cents))
    expect(Number(rows[0].value_cents)).toBe(10800)                          // includes shipping: canonical order total
    expect(rows[0].reservation_id).toBe(fx.reservationId)
    expect(JSON.stringify(rows[0])).not.toMatch(/buyer@example|A Buyer|Test St|Austin/)
  })

  test('an exact replay of the same Stripe event does not duplicate the purchase', async () => {
    const fx = await fixture(); const sid = newSid()
    await checkout(fx, sid)
    const evt = paid(`evt_${fx.checkoutSessionId}`, fx)
    expect((await deliver(evt)).status).toBe(200)
    expect((await deliver(evt)).status).toBe(200)
    expect((await deliver(evt)).status).toBe(200)
    expect(await orderOf(fx.checkoutSessionId)).toHaveLength(1)
    expect(await events('purchase_completed', 'AND reservation_id=$2', [fx.reservationId])).toHaveLength(1)
  })

  test('the same payment under a NEW Stripe event id does not duplicate the purchase', async () => {
    const fx = await fixture(); const sid = newSid()
    await checkout(fx, sid)
    await deliver(paid(`evt_a_${fx.checkoutSessionId}`, fx))
    await deliver(paid(`evt_b_${fx.checkoutSessionId}`, fx))
    expect(await orderOf(fx.checkoutSessionId)).toHaveLength(1)
    expect(await events('purchase_completed', 'AND reservation_id=$2', [fx.reservationId])).toHaveLength(1)
  })

  test('concurrent deliveries still yield one purchase row', async () => {
    const fx = await fixture(); const sid = newSid()
    await checkout(fx, sid)
    const evt = paid(`evt_${fx.checkoutSessionId}`, fx)
    verifyImpl = () => evt
    await Promise.all([webhookPOST(webhookReq(evt)), webhookPOST(webhookReq(evt))].map(p => p.catch(() => null)))
    expect(await orderOf(fx.checkoutSessionId)).toHaveLength(1)
    expect(await events('purchase_completed', 'AND reservation_id=$2', [fx.reservationId])).toHaveLength(1)
  })

  test('if the analytics insert fails, the PAID ORDER is still committed and the webhook still answers 200', async () => {
    const fx = await fixture(); const sid = newSid()
    await checkout(fx, sid)
    failNextMatching(/INSERT INTO analytics_events\s*\(id, session_id, event_name, reservation_id, order_id/, true)
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await deliver(paid(`evt_${fx.checkoutSessionId}`, fx))
    spy.mockRestore()
    expect(res.status).toBe(200)
    const [order] = await orderOf(fx.checkoutSessionId)
    expect(order.payment_status).toBe('paid')
    expect(Number(order.total_cents)).toBe(10800)
    const stock = await F.q(`SELECT stock_on_hand, reserved_quantity FROM product_variants WHERE id=$1`, [fx.variantId])
    expect(Number(stock[0].stock_on_hand)).toBe(9)                           // inventory was committed as normal
    expect(await events('purchase_completed', 'AND order_id=$2', [order.id])).toHaveLength(0)
  })

  test('Stripe\'s retry heals a purchase that failed to record the first time (still exactly one)', async () => {
    const fx = await fixture(); const sid = newSid()
    await checkout(fx, sid)
    const evt = paid(`evt_${fx.checkoutSessionId}`, fx)
    failNextMatching(/INSERT INTO analytics_events\s*\(id, session_id, event_name, reservation_id, order_id/, true)
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    await deliver(evt)
    spy.mockRestore()
    const [order] = await orderOf(fx.checkoutSessionId)
    expect(await events('purchase_completed', 'AND order_id=$2', [order.id])).toHaveLength(0)
    expect((await deliver(evt)).status).toBe(200)                            // the retry
    expect(await events('purchase_completed', 'AND order_id=$2', [order.id])).toHaveLength(1)
    expect(await orderOf(fx.checkoutSessionId)).toHaveLength(1)
  })

  test('an order whose visitor never consented records no purchase (and is still a normal paid order)', async () => {
    const fx = await fixture()
    await checkout(fx)                                                       // no analytics session id
    const res = await deliver(paid(`evt_${fx.checkoutSessionId}`, fx))
    expect(res.status).toBe(200)
    const [order] = await orderOf(fx.checkoutSessionId)
    expect(order.payment_status).toBe('paid')
    expect(await events('purchase_completed', 'AND order_id=$2', [order.id])).toHaveLength(0)
  })

  test('the purchase cannot be attached to a session that never reached checkout for this reservation', async () => {
    // fixture() re-arms the shared deps mocks, so each checkout runs right after its own fixture.
    const a = await fixture(); const sidA = newSid()
    await checkout(a, sidA)                                                  // only A started checkout (consented)
    const b = await fixture()
    await checkout(b)                                                        // B did not consent
    await deliver(paid(`evt_${b.checkoutSessionId}`, b))
    const [orderB] = await orderOf(b.checkoutSessionId)
    expect(await events('purchase_completed', 'AND order_id=$2', [orderB.id])).toHaveLength(0)
  })

  test('the admin report counts the purchase once and reports the canonical value', async () => {
    const { createFunnelService } = await import('../funnel-analytics')
    const svc = createFunnelService(F.sql)
    const rep: any = await svc.getFunnelReport({
      start: new Date(Date.now() - 86_400_000).toISOString(), end: new Date(Date.now() + 86_400_000).toISOString(),
    })
    const paidRows = await F.q(`SELECT COUNT(*)::int n, COALESCE(SUM(value_cents),0)::int v FROM analytics_events WHERE event_name='purchase_completed'`)
    expect(rep.events.purchases).toBe(paidRows[0].n)
    expect(rep.events.purchaseValueCents).toBe(paidRows[0].v)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// Hard bound: a HUNG analytics query cannot stall checkout or the webhook.
describeDB('a hung analytics query cannot stall the money path', () => {
  const orderOf = (cs: string) => F.q(`SELECT id, payment_status, total_cents FROM orders WHERE stripe_checkout_session_id=$1`, [cs])
  const { MONEY_PATH_ANALYTICS_TIMEOUT_MS: BOUND } = require('../funnel-analytics')
  const SLACK = 2000   // real handler work on a local DB is a few ms; this is generous

  test('checkout: the response arrives within the bound (+ slack), is a normal 200, and nothing is recorded', async () => {
    const fx = await fixture(); const sid = newSid()
    ;(global as any).__FA_HANG = /INSERT INTO analytics_sessions/
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    const t0 = Date.now()
    const res = await checkout(fx, sid)
    const dt = Date.now() - t0
    ;(global as any).__FA_HANG = null
    const logged = err.mock.calls.map(c => c.join(' ')).join('\n'); err.mockRestore()
    expect(res.status).toBe(200)
    expect((await res.json()).url).toBe('https://stripe.test/pay')
    expect(dt).toBeGreaterThanOrEqual(BOUND - 100)          // it really waited for the bound...
    expect(dt).toBeLessThan(BOUND + SLACK)                  // ...and not a millisecond longer than the bound
    expect(logged).toMatch(/checkout_started skipped \(non-fatal\): timed out/)
    expect(logged).not.toContain(sid)
    expect(await events('checkout_started', 'AND session_id=$2', [sid])).toHaveLength(0)
  }, 20_000)

  test('webhook: a hung purchase write still yields a 200 within the bound, with the order PAID and stock committed', async () => {
    const fx = await fixture(); const sid = newSid()
    await checkout(fx, sid)
    ;(global as any).__FA_HANG = /INSERT INTO analytics_events\s*\(id, session_id, event_name, reservation_id, order_id/
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    const evt = paid(`evt_${fx.checkoutSessionId}`, fx)
    const t0 = Date.now()
    const res = await deliver(evt)
    const dt = Date.now() - t0
    ;(global as any).__FA_HANG = null
    const logged = err.mock.calls.map(c => c.join(' ')).join('\n'); err.mockRestore()
    expect(res.status).toBe(200)
    expect(dt).toBeLessThan(BOUND + SLACK)
    expect(logged).toMatch(/purchase_completed skipped \(non-fatal\): timed out/)
    const [order] = await orderOf(fx.checkoutSessionId)
    expect(order.payment_status).toBe('paid')
    expect(Number(order.total_cents)).toBe(10800)
    expect(Number((await F.q(`SELECT stock_on_hand FROM product_variants WHERE id=$1`, [fx.variantId]))[0].stock_on_hand)).toBe(9)
    expect(await events('purchase_completed', 'AND order_id=$2', [order.id])).toHaveLength(0)
    // Stripe's retry (analytics healthy again) heals it: still exactly one purchase, one order.
    expect((await deliver(evt)).status).toBe(200)
    expect(await events('purchase_completed', 'AND order_id=$2', [order.id])).toHaveLength(1)
    expect(await orderOf(fx.checkoutSessionId)).toHaveLength(1)
  }, 20_000)

  test('a healthy write is NOT cut short: ordinary analytics is still captured inside the bound', async () => {
    const fx = await fixture(); const sid = newSid()
    const t0 = Date.now()
    await checkout(fx, sid)
    expect(Date.now() - t0).toBeLessThan(BOUND)
    expect(await events('checkout_started', 'AND session_id=$2', [sid])).toHaveLength(1)
  })
})
