// lib/__tests__/ga4-money-path.test.ts
//
// GA4 on the MONEY PATH, through the real handlers:
//   * lib/checkout-session-handler.ts  (GA client/session ids -> Stripe session metadata)
//   * app/api/stripe/webhook/route.ts  (server-side GA purchase, via the real finalize_paid_order)
//
// GA's Measurement Protocol is the ONLY thing stubbed beyond the usual boundaries (global fetch).
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
const uid = () => `f6000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`
const newSid = () => crypto.randomUUID()

beforeAll(async () => {
  if (!HAVE_DB) return
  F = await createFiDb('kvrn_ga4mp')
  await connectPg(`kvrn_ga4mp_${process.pid}`)
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

async function checkout(fx: { sku: string }, analyticsSessionId?: unknown, extra: Record<string, unknown> = {}) {
  const body: any = {
    items: [{ sku: fx.sku, quantity: 1 }], email: 'buyer@example.com',
    shippingAddress: { firstName: 'A', lastName: 'Buyer', line1: '1 Test St', city: 'Austin',
                       state: 'TX', postalCode: '78701', country: 'US' },
    shippingMethod: 'standard',
  }
  if (analyticsSessionId !== undefined) body.analyticsSessionId = analyticsSessionId
  Object.assign(body, extra)
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
const paid = (eventId: string, fx: { checkoutSessionId: string; reservationId: string }, meta: Record<string, string> = {}) => ({
  id: eventId, type: 'checkout.session.completed',
  data: { object: {
    id: fx.checkoutSessionId, object: 'checkout.session', payment_status: 'paid',
    payment_intent: `pi_${fx.checkoutSessionId}`, currency: 'usd',
    amount_total: 10800, amount_subtotal: 10800, client_reference_id: null,
    customer_details: { email: 'buyer@example.com', name: 'A Buyer' },
    collected_information: { shipping_details: { name: 'A Buyer',
      address: { line1: '1 Test St', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } } },
    metadata: { reservation_id: fx.reservationId, ...meta },
    total_details: { amount_discount: 0, amount_shipping: 800, amount_tax: 0 },
  } },
})
const deliver = (evt: any) => { verifyImpl = () => evt; return webhookPOST(webhookReq(evt)) }

const events = (name: string, where = '', p: unknown[] = []) =>
  F.q(`SELECT * FROM analytics_events WHERE event_name=$1 ${where}`, [name, ...p])


const orderOf = (cs: string) => F.q(`SELECT id, order_number, payment_status, total_cents FROM orders WHERE stripe_checkout_session_id=$1`, [cs])
const CID = '1234567890.1696300000'
const GSID = '1696300000'
const GA_ENV = { NEXT_PUBLIC_GA_MEASUREMENT_ID: 'G-TEST123456', GA4_MEASUREMENT_PROTOCOL_SECRET: 'sEcReT_abcdef123456' }
const setGaEnv = (on: boolean) => {
  for (const [k, v] of Object.entries(GA_ENV)) { if (on) process.env[k] = v; else delete process.env[k] }
}
let gaFetch: jest.Mock
const gaCalls = () => gaFetch.mock.calls.filter(c => String(c[0]).includes('google-analytics.com/mp/collect'))
const gaBody = (i = 0) => JSON.parse(gaCalls()[i][1].body)

const realFetch = global.fetch
beforeEach(() => {
  setGaEnv(true)
  gaFetch = jest.fn(async () => ({ status: 204 }))
  ;(global as any).fetch = gaFetch
})
afterEach(() => { (global as any).fetch = realFetch; setGaEnv(false) })
const quiet = () => jest.spyOn(console, 'error').mockImplementation(() => {})

/** Checkout with GA ids -> the metadata Stripe was given -> a paid event carrying exactly that metadata. */
async function checkoutThenPaidEvent(opts: { ga?: boolean; funnelSid?: string } = {}) {
  const fx = await fixture()
  const extra = opts.ga === false ? {} : { gaClientId: CID, gaSessionId: GSID }
  const res = await checkout(fx, opts.funnelSid, extra)
  expect(res.status).toBe(200)
  const meta = stripeCreate.mock.calls[0][0].metadata
  return { fx, meta, evt: paid(`evt_${fx.checkoutSessionId}`, fx, { ...meta }) }
}

// ═════════════════════════════════════════════════════════════════════════════
describeDB('checkout hands the GA ids to the webhook through Stripe metadata (shape-checked)', () => {
  test('valid ids ride in the Stripe session metadata next to the existing keys', async () => {
    const fx = await fixture()
    await checkout(fx, undefined, { gaClientId: CID, gaSessionId: GSID })
    const meta = stripeCreate.mock.calls[0][0].metadata
    expect(meta).toMatchObject({ reservation_id: fx.reservationId, shipping_method: 'standard', ga_client_id: CID, ga_session_id: GSID })
  })
  test('no ids (visitor not running GA): the Stripe metadata is exactly what it was before this batch', async () => {
    const fx = await fixture()
    await checkout(fx)
    expect(stripeCreate.mock.calls[0][0].metadata).toEqual({ reservation_id: fx.reservationId, shipping_method: 'standard' })
  })
  test.each([['<script>'], [123], [{ a: 1 }], ['1.2.3'], ['x'.repeat(300)], [''], [null], ['1234567890123.1']])(
    'a malformed gaClientId (%p) is dropped: checkout still succeeds and no GA key reaches Stripe', async bad => {
      const fx = await fixture()
      const res = await checkout(fx, undefined, { gaClientId: bad, gaSessionId: GSID })
      expect(res.status).toBe(200)
      const meta = stripeCreate.mock.calls[0][0].metadata
      expect(meta).not.toHaveProperty('ga_client_id'); expect(meta).not.toHaveProperty('ga_session_id')
    })
  test('a session id without a client id is dropped; a malformed session id is dropped alone', async () => {
    const fx = await fixture()
    await checkout(fx, undefined, { gaSessionId: GSID })
    expect(stripeCreate.mock.calls[0][0].metadata).not.toHaveProperty('ga_session_id')
    const fx2 = await fixture()
    await checkout(fx2, undefined, { gaClientId: CID, gaSessionId: 'nope' })
    const m = stripeCreate.mock.calls[0][0].metadata
    expect(m.ga_client_id).toBe(CID); expect(m).not.toHaveProperty('ga_session_id')
  })
  test('the browser cannot inject extra metadata keys or money through the GA fields', async () => {
    const fx = await fixture()
    await checkout(fx, undefined, { gaClientId: CID, gaMetadata: { evil: '1' }, ga_client_id: 'x', value: 1, total: 1 })
    const meta = stripeCreate.mock.calls[0][0].metadata
    expect(Object.keys(meta).sort()).toEqual(['ga_client_id', 'reservation_id', 'shipping_method'])
    expect(meta.ga_client_id).toBe(CID)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describeDB('server-side GA purchase from the real webhook', () => {
  test('a paid order sends exactly one purchase: canonical order number, totals and items from the database', async () => {
    const { fx, evt } = await checkoutThenPaidEvent()
    const res = await deliver(evt)
    expect(res.status).toBe(200)
    const [order] = await orderOf(fx.checkoutSessionId)
    expect(order.payment_status).toBe('paid')
    expect(gaCalls()).toHaveLength(1)
    const [url, init] = gaCalls()[0]
    expect(new URL(url).searchParams.get('measurement_id')).toBe('G-TEST123456')
    expect(init.method).toBe('POST')
    const b = gaBody()
    expect(b.client_id).toBe(CID)
    const p = b.events[0].params
    expect(b.events[0].name).toBe('purchase')
    expect(p.transaction_id).toBe(order.order_number)                          // canonical KVRN order number
    expect(p.session_id).toBe(GSID)
    expect(p.currency).toBe('USD')
    expect(p.value).toBe((Number(order.total_cents) - 800 - 0) / 100)          // 10800 - shipping 800 - tax 0 = $100.00
    expect(p.shipping).toBe(8); expect(p.tax).toBe(0)
    expect(p.items).toEqual([{ item_id: `fm-${fx.sku.split('-').pop()}`, item_name: 'FM Tee', item_variant: fx.sku, item_brand: 'KVRN', price: 100, quantity: 1 }])
  })

  test('values are the finalized ORDER\'s, not anything the browser or the Stripe payload could have claimed', async () => {
    const { fx, evt } = await checkoutThenPaidEvent()
    ;(evt.data.object as any).amount_subtotal = 1                              // a lying field on the event
    await deliver(evt)
    const [order] = await orderOf(fx.checkoutSessionId)
    expect(gaBody().events[0].params.value).toBe((Number(order.total_cents) - 800) / 100)
  })

  test('NO PII in what was sent to Google: no customer name, email, phone, address, or payment ids', async () => {
    const { evt } = await checkoutThenPaidEvent()
    await deliver(evt)
    const sent = JSON.stringify(gaCalls()[0][1].body) + String(gaCalls()[0][0]).replace(/api_secret=[^&]*/, '')
    for (const bad of ['buyer@example.com', 'A Buyer', 'Buyer', '1 Test St', 'Austin', '78701', 'pi_', 'cs_fm_', 'user_id', 'user_properties']) {
      expect(sent).not.toContain(bad)
    }
  })

  test('the Stripe secret-bearing request URL is the only place the API secret appears', async () => {
    const { evt } = await checkoutThenPaidEvent()
    await deliver(evt)
    expect(String(gaCalls()[0][0])).toContain('api_secret=sEcReT_abcdef123456')
    expect(gaCalls()[0][1].body).not.toContain('sEcReT')
  })

  // ── Audit Revision 1 / correction 3: the GA purchase HEALS on Stripe retry/replay ──────────────
  // It is attempted for 'order_created', 'already_processed' and 'already_had_order' (the same
  // outcomes as the first-party purchase_completed healing). Every attempt carries the SAME canonical
  // transaction_id, so Google collapses a repeat of a purchase it already holds.
  test('an exact replay of the same Stripe event re-attempts the purchase with the IDENTICAL canonical transaction_id and body', async () => {
    const { fx, evt } = await checkoutThenPaidEvent()
    expect((await deliver(evt)).status).toBe(200)
    expect((await deliver(evt)).status).toBe(200)
    expect((await deliver(evt)).status).toBe(200)
    const [order] = await orderOf(fx.checkoutSessionId)
    expect(await orderOf(fx.checkoutSessionId)).toHaveLength(1)
    expect(gaCalls()).toHaveLength(3)
    for (let i = 0; i < 3; i++) {
      expect(gaBody(i).events[0].params.transaction_id).toBe(order.order_number)
      expect(gaBody(i)).toEqual(gaBody(0))                                   // byte-for-byte the same purchase
    }
  })
  test('the same payment under NEW Stripe event ids (already_had_order) re-attempts with the same transaction_id; one order only', async () => {
    const { fx, meta } = await checkoutThenPaidEvent()
    await deliver(paid(`evt_a_${fx.checkoutSessionId}`, fx, { ...meta }))
    await deliver(paid(`evt_b_${fx.checkoutSessionId}`, fx, { ...meta }))
    await deliver(paid(`evt_c_${fx.checkoutSessionId}`, fx, { ...meta }))
    const orders = await orderOf(fx.checkoutSessionId)
    expect(orders).toHaveLength(1)
    expect(gaCalls()).toHaveLength(3)
    expect(new Set(gaCalls().map((_, i) => gaBody(i).events[0].params.transaction_id))).toEqual(new Set([orders[0].order_number]))
  })

  test('(a)+(b) the first GA send FAILS but the paid order succeeds; the replay retries GA with the exact same canonical transaction_id', async () => {
    const { fx, evt } = await checkoutThenPaidEvent()
    gaFetch.mockImplementationOnce(async () => { throw new TypeError('fetch failed') })
    const err = quiet()
    expect((await deliver(evt)).status).toBe(200)                            // order finalised, GA miss is non-fatal
    err.mockRestore()
    const [order] = await orderOf(fx.checkoutSessionId)
    expect(order.payment_status).toBe('paid')
    expect(gaCalls()).toHaveLength(1)                                        // attempted (and failed)
    expect((await deliver(evt)).status).toBe(200)                            // Stripe retries the same event
    expect(gaCalls()).toHaveLength(2)                                        // GA healed on the replay
    expect(gaBody(1).events[0].params.transaction_id).toBe(order.order_number)
    expect(gaBody(1)).toEqual(gaBody(0))
    expect(await orderOf(fx.checkoutSessionId)).toHaveLength(1)              // and nothing else changed
  })
  test('(a)+(b) a first send that TIMES OUT (hung) heals on a later retry under a new event id', async () => {
    const { fx, meta, evt } = await checkoutThenPaidEvent()
    gaFetch.mockImplementationOnce(() => new Promise(() => {}))              // first attempt hangs -> bounded timeout
    const err = quiet()
    expect((await deliver(evt)).status).toBe(200)
    err.mockRestore()
    expect(gaCalls()).toHaveLength(1)
    expect((await deliver(paid(`evt_retry_${fx.checkoutSessionId}`, fx, { ...meta }))).status).toBe(200)
    expect(gaCalls()).toHaveLength(2)
    const [order] = await orderOf(fx.checkoutSessionId)
    expect(gaBody(1).events[0].params.transaction_id).toBe(order.order_number)
    expect(order.payment_status).toBe('paid')
  }, 20_000)
  test('(c) a successful first send plus a replay still uses the same transaction_id (Google dedupes; KVRN invents nothing)', async () => {
    const { fx, evt } = await checkoutThenPaidEvent()
    await deliver(evt); await deliver(evt)
    const [order] = await orderOf(fx.checkoutSessionId)
    expect(gaCalls()).toHaveLength(2)
    expect(gaBody(0).events[0].params.transaction_id).toBe(order.order_number)
    expect(gaBody(1).events[0].params.transaction_id).toBe(order.order_number)
    expect(gaBody(0).events[0].params.transaction_id).toMatch(/^KVRN-\d{6}$/)
    expect(gaBody(0).events[0].params.value).toBe(gaBody(1).events[0].params.value)
  })
  test('(d) concurrent webhook deliveries cannot change order/payment correctness; every GA attempt carries the same canonical id', async () => {
    const { fx, evt } = await checkoutThenPaidEvent({ funnelSid: newSid() })
    verifyImpl = () => evt
    const res = await Promise.all([webhookPOST(webhookReq(evt)), webhookPOST(webhookReq(evt)), webhookPOST(webhookReq(evt))].map(p => p.catch(() => null)))
    for (const r of res) if (r) expect(r.status).toBe(200)
    const orders = await orderOf(fx.checkoutSessionId)
    expect(orders).toHaveLength(1)
    expect(orders[0].payment_status).toBe('paid')
    expect(Number((await F.q(`SELECT stock_on_hand FROM product_variants WHERE id=$1`, [fx.variantId]))[0].stock_on_hand)).toBe(9)   // deducted ONCE
    expect(await F.q(`SELECT 1 FROM analytics_events WHERE event_name='purchase_completed' AND order_id=$1`, [orders[0].id])).toHaveLength(1)
    expect(gaCalls().length).toBeGreaterThanOrEqual(1)
    expect(gaCalls().length).toBeLessThanOrEqual(3)
    for (let i = 0; i < gaCalls().length; i++) expect(gaBody(i).events[0].params.transaction_id).toBe(orders[0].order_number)
  })
  test('(d) concurrent deliveries while the GA endpoint is failing: still exactly one paid order, no error to Stripe', async () => {
    const { fx, evt } = await checkoutThenPaidEvent()
    gaFetch.mockImplementation(async () => { throw new TypeError('fetch failed') })
    verifyImpl = () => evt
    const err = quiet()
    const res = await Promise.all([webhookPOST(webhookReq(evt)), webhookPOST(webhookReq(evt))].map(p => p.catch(() => null)))
    err.mockRestore()
    for (const r of res) if (r) expect(r.status).toBe(200)
    expect(await orderOf(fx.checkoutSessionId)).toHaveLength(1)
    expect((await orderOf(fx.checkoutSessionId))[0].payment_status).toBe('paid')
  })

  test('never for an unfinalized payment: a paid session with no reservation creates no order and sends NO GA request', async () => {
    const ghost = { checkoutSessionId: `cs_ghost_${++seq}`, reservationId: uid() }
    const err = quiet()
    expect((await deliver(paid(`evt_ghost_${seq}`, ghost, { ga_client_id: CID, ga_session_id: GSID }))).status).toBeLessThan(500)
    err.mockRestore()
    expect(await orderOf(ghost.checkoutSessionId)).toHaveLength(0)
    expect(gaCalls()).toHaveLength(0)
  })
  test('GA is attempted exactly when a paid order exists for the session — never for a reservation that did not finalize', async () => {
    const fx = await fixture()
    await F.q(`UPDATE reservations SET status='failed' WHERE id=$1`, [fx.reservationId])
    const err = quiet()
    await deliver(paid(`evt_failedres_${fx.checkoutSessionId}`, fx, { ga_client_id: CID, ga_session_id: GSID }))
    err.mockRestore()
    const orders = await orderOf(fx.checkoutSessionId)
    if (orders.length === 0) expect(gaCalls()).toHaveLength(0)
    else { expect(orders[0].payment_status).toBe('paid'); expect(gaCalls().length).toBe(1) }
  })
  test('a replay after the order is no longer "paid" (e.g. refunded) sends nothing: only paid orders are ever reported', async () => {
    const { fx, evt } = await checkoutThenPaidEvent()
    gaFetch.mockImplementationOnce(async () => { throw new TypeError('fetch failed') })
    const err = quiet(); await deliver(evt); err.mockRestore()
    expect(gaCalls()).toHaveLength(1)
    await F.q(`UPDATE orders SET payment_status='refunded' WHERE stripe_checkout_session_id=$1`, [fx.checkoutSessionId])
    const err2 = quiet(); await deliver(evt); err2.mockRestore()
    expect(gaCalls()).toHaveLength(1)                                        // no new attempt for a non-paid order
  })
  test('a replay without GA ids in the event metadata sends nothing', async () => {
    const { fx } = await checkoutThenPaidEvent({ ga: false })
    await deliver(paid(`evt_noga_${fx.checkoutSessionId}`, fx, {}))
    await deliver(paid(`evt_noga2_${fx.checkoutSessionId}`, fx, {}))
    expect(gaCalls()).toHaveLength(0)
  })

  test('no GA ids in the metadata (visitor declined / DNT / GPC / GA blocked): nothing is sent, the order is normal', async () => {
    const { fx, evt } = await checkoutThenPaidEvent({ ga: false })
    expect((await deliver(evt)).status).toBe(200)
    expect(gaCalls()).toHaveLength(0)
    expect((await orderOf(fx.checkoutSessionId))[0].payment_status).toBe('paid')
  })
  test('a forged or malformed GA id in the event metadata is never sent to Google', async () => {
    const fx = await fixture(); await checkout(fx)
    expect((await deliver(paid(`evt_${fx.checkoutSessionId}`, fx, { ga_client_id: 'a b&evil=1' }))).status).toBe(200)
    expect(gaCalls()).toHaveLength(0)
  })

  test('GA secret missing: skipped cleanly (200, order paid, no request, no secret in logs)', async () => {
    const { fx, evt } = await checkoutThenPaidEvent()
    delete process.env.GA4_MEASUREMENT_PROTOCOL_SECRET
    const err = quiet(); const out = jest.spyOn(console, 'log').mockImplementation(() => {})
    const res = await deliver(evt)
    const text = [...err.mock.calls, ...out.mock.calls].map(c => c.join(' ')).join('\n'); err.mockRestore(); out.mockRestore()
    expect(res.status).toBe(200)
    expect(gaCalls()).toHaveLength(0)
    expect(text).toMatch(/GA4 server configuration missing/)
    expect(text).not.toContain('sEcReT')
    expect((await orderOf(fx.checkoutSessionId))[0].payment_status).toBe('paid')
  })
  test('GA configuration malformed: skipped cleanly', async () => {
    const { evt } = await checkoutThenPaidEvent()
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = 'not-a-ga-id'
    const err = quiet()
    const res = await deliver(evt)
    err.mockRestore()
    expect(res.status).toBe(200); expect(gaCalls()).toHaveLength(0)
  })
  test('a GA network failure never fails or rolls back the paid order, and the first-party purchase still records', async () => {
    const sid = newSid()
    const { fx, evt } = await checkoutThenPaidEvent({ funnelSid: sid })
    gaFetch.mockImplementation(async () => { throw new TypeError('fetch failed') })
    const err = quiet()
    const res = await deliver(evt)
    err.mockRestore()
    expect(res.status).toBe(200)
    const [order] = await orderOf(fx.checkoutSessionId)
    expect(order.payment_status).toBe('paid')
    expect(Number((await F.q(`SELECT stock_on_hand FROM product_variants WHERE id=$1`, [fx.variantId]))[0].stock_on_hand)).toBe(9)
    expect(await F.q(`SELECT 1 FROM analytics_events WHERE event_name='purchase_completed' AND order_id=$1`, [order.id])).toHaveLength(1)
  })
  test('GA answering 500 / garbage never fails the webhook', async () => {
    for (const reply of [{ status: 500 }, { status: 400 }, undefined, null, 'garbage', {}]) {
      const { fx, evt } = await checkoutThenPaidEvent()
      gaFetch.mockImplementation(async () => reply as any)
      const err = quiet()
      const res = await deliver(evt)
      err.mockRestore()
      expect(res.status).toBe(200)
      expect((await orderOf(fx.checkoutSessionId))[0].payment_status).toBe('paid')
    }
  })
  test('a HUNG GA request cannot stall the webhook beyond the bound: 200, order PAID, stock committed, first-party purchase recorded', async () => {
    const { GA_SERVER_TIMEOUT_MS: BOUND } = require('../ga4-server')
    const sid = newSid()
    const { fx, evt } = await checkoutThenPaidEvent({ funnelSid: sid })
    let aborted = false
    gaFetch.mockImplementation((_u: string, init: any) => { init.signal.addEventListener('abort', () => { aborted = true }); return new Promise(() => {}) })
    const err = quiet()
    const t0 = Date.now()
    const res = await deliver(evt)
    const dt = Date.now() - t0
    const logged = err.mock.calls.map(c => c.join(' ')).join('\n'); err.mockRestore()
    expect(res.status).toBe(200)
    expect(dt).toBeGreaterThanOrEqual(BOUND - 100)                           // it did wait for the bound...
    expect(dt).toBeLessThan(BOUND + 2000)                                    // ...and not longer (the GA and funnel writes run concurrently)
    expect(aborted).toBe(true)
    expect(logged).toMatch(/\[ga4\] purchase skipped \(non-fatal\): timed out/)
    const [order] = await orderOf(fx.checkoutSessionId)
    expect(order.payment_status).toBe('paid')
    expect(Number((await F.q(`SELECT stock_on_hand FROM product_variants WHERE id=$1`, [fx.variantId]))[0].stock_on_hand)).toBe(9)
    expect(await F.q(`SELECT 1 FROM analytics_events WHERE event_name='purchase_completed' AND order_id=$1`, [order.id])).toHaveLength(1)
  }, 20_000)
  test('a hung GA request plus a hung first-party write is still bounded by ONE bound (they run concurrently)', async () => {
    const { GA_SERVER_TIMEOUT_MS: BOUND } = require('../ga4-server')
    const { evt } = await checkoutThenPaidEvent({ funnelSid: newSid() })
    gaFetch.mockImplementation(() => new Promise(() => {}))
    ;(global as any).__FA_HANG = /INSERT INTO analytics_events\s*\(id, session_id, event_name, reservation_id, order_id/
    const err = quiet()
    const t0 = Date.now()
    const res = await deliver(evt)
    const dt = Date.now() - t0
    err.mockRestore()
    expect(res.status).toBe(200)
    expect(dt).toBeLessThan(BOUND + 2000)
  }, 20_000)

  test('the order is created before GA is ever called (analytics runs after the money is safe)', async () => {
    const { fx, evt } = await checkoutThenPaidEvent()
    let orderExistedAtCall: boolean | null = null
    gaFetch.mockImplementation(async () => {
      orderExistedAtCall = (await F.q(`SELECT 1 FROM orders WHERE stripe_checkout_session_id=$1 AND payment_status='paid'`, [fx.checkoutSessionId])).length === 1
      return { status: 204 }
    })
    await deliver(evt)
    expect(orderExistedAtCall).toBe(true)
  })

  test('begin_checkout\'s server-side twin: ENABLE_CHECKOUT is untouched (a disabled checkout creates no session and carries no GA ids)', async () => {
    const { createCheckoutPostHandler } = await import('../checkout-session-handler')
    const closed = createCheckoutPostHandler({
      isCheckoutEnabled: () => false, getSiteOrigin: () => 'https://kvrn.shop',
      getStripe: () => ({ checkout: { sessions: { create: stripeCreate } } }) as any,
      reserveInventory, saveReservationCheckoutDetails, failReservation, attachStripeSession, releaseExpiredReservations: jest.fn(),
    } as any)
    const fx = await fixture()
    const req: any = new Request('https://kvrn.shop/api/checkout/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ sku: fx.sku, quantity: 1 }], gaClientId: CID }),
    })
    req.nextUrl = new URL('https://kvrn.shop/api/checkout/session'); req.cookies = { get: () => undefined }
    const res = await closed(req)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(stripeCreate).not.toHaveBeenCalled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Audit Revision 1 / correction 4, through the REAL finalize_paid_order: order_items.unit_price_cents
// is the pre-discount snapshot, so the GA item revenue must be reconciled with `value`.
describeDB('GA purchase revenue is internally consistent under discounts (real finalized orders)', () => {
  async function discounted(opts: { merch?: number; shipFinal?: number; shipDiscount?: number }) {
    const { fx, evt } = await checkoutThenPaidEvent()
    const merch = opts.merch ?? 0, shipFinal = opts.shipFinal ?? 800, shipDiscount = opts.shipDiscount ?? 0
    await F.q(`UPDATE reservations SET discount_cents=$2, shipping_final_cents=$3, shipping_cents=$3,
                                       shipping_before_discount_cents=800, shipping_discount_cents=$4
               WHERE id=$1`, [fx.reservationId, merch, shipFinal, shipDiscount])
    ;(evt.data.object as any).amount_total = 10000 - merch + shipFinal
    return { fx, evt }
  }
  const sumItems = (p: any) => p.items.reduce((a: number, i: any) => a + i.price * i.quantity, 0)

  test('no discount: item revenue == value == the order\'s net merchandise', async () => {
    const { fx, evt } = await discounted({})
    await deliver(evt)
    const p = gaBody().events[0].params
    expect(p.value).toBe(100); expect(sumItems(p)).toBeCloseTo(p.value, 6)
    expect((await F.q(`SELECT unit_price_cents FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.stripe_checkout_session_id=$1`, [fx.checkoutSessionId]))[0].unit_price_cents).toBe(10000)
  })
  test('a fixed merchandise discount: the stored unit price stays PRE-discount (accounting untouched) while GA sees the net price', async () => {
    const { fx, evt } = await discounted({ merch: 1500 })
    await deliver(evt)
    const [order] = await F.q(`SELECT id, subtotal_cents, discount_cents, total_cents FROM orders WHERE stripe_checkout_session_id=$1`, [fx.checkoutSessionId])
    expect(Number(order.subtotal_cents)).toBe(10000); expect(Number(order.discount_cents)).toBe(1500); expect(Number(order.total_cents)).toBe(9300)
    const [line] = await F.q(`SELECT unit_price_cents, line_total_cents FROM order_items WHERE order_id=$1`, [order.id])
    expect(Number(line.unit_price_cents)).toBe(10000); expect(Number(line.line_total_cents)).toBe(10000)   // proof: pre-discount, unchanged
    const p = gaBody().events[0].params
    expect(p.value).toBe(85)
    expect(p.items[0].price).toBe(85)
    expect(sumItems(p)).toBeCloseTo(p.value, 6)
    expect(JSON.stringify(gaBody())).not.toMatch(/discount|coupon/i)
  })
  test('a shipping-only discount does not reduce item revenue', async () => {
    const { evt } = await discounted({ shipFinal: 300, shipDiscount: 500 })
    await deliver(evt)
    const p = gaBody().events[0].params
    expect(p.value).toBe(100); expect(p.shipping).toBe(3)
    expect(p.items[0].price).toBe(100)
    expect(sumItems(p)).toBeCloseTo(p.value, 6)
  })
  test('the replay of a discounted order re-sends the identical reconciled payload', async () => {
    const { evt } = await discounted({ merch: 1500 })
    await deliver(evt); await deliver(evt)
    expect(gaCalls()).toHaveLength(2)
    expect(gaBody(1)).toEqual(gaBody(0))
  })
})
