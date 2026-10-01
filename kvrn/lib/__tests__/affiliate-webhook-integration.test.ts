// lib/__tests__/affiliate-webhook-integration.test.ts
//
// BLOCKER 4 — the REAL Stripe webhook boundary.
//
// Executes app/api/stripe/webhook/route.ts POST end to end. The paid order is
// CREATED BY finalize_paid_order through the production control flow; nothing is
// pre-inserted.
//
// SUBSTITUTED, and only these external boundaries:
//   * Stripe signature verification (verifyWebhookSignature) and network calls
//   * Shippo rate API
//   * outbound email
//   * the DB TRANSPORT (Neon's HTTP driver cannot reach local PostgreSQL)
//
// NOT substituted: route event dispatch, handlePaid, finalize_paid_order,
// tryResolveAffiliateAttribution, or any affiliate SQL.

import { pgSqlWithFaults, connectPg, disconnectPg, raw,
         failNextMatching, clearFailures } from './helpers/pg-transport'

jest.mock('../db', () => ({ sql: require('./helpers/pg-transport').pgSqlWithFaults }))

const stripeCreate = jest.fn()
const stripeRetrieve = jest.fn()
let verifyImpl: (raw: string, sig: string, secret: string) => any
jest.mock('../stripe-client', () => ({
  getStripe: () => ({
    checkout: { sessions: { create: stripeCreate, retrieve: stripeRetrieve } },
  }),
  // Signature verification is pure external crypto; the parsed event is real.
  verifyWebhookSignature: (r: string, s: string, sec: string) => verifyImpl(r, s, sec),
  isValidStripeTestSecretKey: () => true,
  isValidWebhookSecret: () => true,
}))
jest.mock('../shippo', () => ({
  ...jest.requireActual('../shippo'),
  getShippoRates: jest.fn(async () => ({
    ok: true,
    standard: { amountCents: 800, provider: 'USPS', servicelevelName: 'Ground',
                estimatedDays: 4, objectId: 'rate_std' },
    express:  { amountCents: 2200, provider: 'UPS', servicelevelName: '2nd Day',
                estimatedDays: 2, objectId: 'rate_exp' },
  })),
}))
jest.mock('../admin-auth', () => ({
  requireAdmin: async () => ({ identity: { email: 'admin@kvrn.test' }, error: null }),
}))

const DB = 'webhooktest'
let referralGET: any
let webhookPOST: any
let backfillPOST: any
let checkoutPOST: any

const reserveInventory = jest.fn()
const saveReservationCheckoutDetails = jest.fn()
const attachStripeSession = jest.fn()
const failReservation = jest.fn()

let seq = 0
const uid = () => `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`

beforeAll(async () => {
  await connectPg(DB)
  // admin_audit_logs has no FK back to these tables, so CASCADE never reaches
  // it; it must be listed explicitly or a prior run's rows (same deterministic
  // orderId from uid()'s per-process counter) survive and collide with this
  // run's audit-log assertions. See the analogous fix in
  // affiliate-http-integration.test.ts.
  await raw(`TRUNCATE affiliate_payout_lines, affiliate_payouts,
    affiliate_commission_adjustments, affiliate_commissions,
    dispute_merchandise_resolutions, order_affiliate_attributions,
    affiliate_clicks, affiliate_links, affiliate_terms_events,
    affiliate_status_events, affiliates, analytics_sessions,
    order_dispute_financial_adjustments, order_disputes, order_refunds,
    order_items, orders, reservations, discounts, products, product_variants,
    webhook_events, admin_audit_logs RESTART IDENTITY CASCADE`)
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
  process.env.ENABLE_STRIPE_TEST_CHECKOUT = 'true'
  process.env.SHIPPO_API_TOKEN = 'shippo_test_token'

  referralGET  = (await import('../../app/r/[slug]/route')).GET
  webhookPOST  = (await import('../../app/api/stripe/webhook/route')).POST
  backfillPOST = (await import('../../app/api/admin/affiliates/backfill/route')).POST

  const { createCheckoutPostHandler } = await import('../checkout-session-handler')
  checkoutPOST = createCheckoutPostHandler({
    isCheckoutEnabled: () => true,
    getSiteOrigin: () => 'https://kvrn.shop',
    getStripe: () => ({ checkout: { sessions: { create: stripeCreate } } }) as any,
    reserveInventory, saveReservationCheckoutDetails, failReservation,
    attachStripeSession, releaseExpiredReservations: jest.fn(),
  } as any)
})
afterAll(async () => { await disconnectPg() })
beforeEach(() => { clearFailures(); stripeRetrieve.mockReset() })

// ── fixtures ────────────────────────────────────────────────────────────────
async function makeAffiliate(code: string, bps = 1000, windowDays = 30) {
  const rows = await raw(
    `SELECT create_affiliate($1,$2,NULL,'percentage',$3,NULL,'proportional',$4,0,NULL,NULL,'test') AS r`,
    [code, code, bps, windowDays])
  const id = (rows[0] as any).r.affiliate_id
  for (const t of ['affiliates|created_at|id', 'affiliate_terms_events|effective_at|affiliate_id',
                   'affiliate_status_events|effective_at|affiliate_id']) {
    const [tbl, col, key] = t.split('|')
    await raw(`UPDATE ${tbl} SET ${col} = NOW() - INTERVAL '400 days' WHERE ${key}=$1`, [id])
  }
  return id as string
}
async function makeLink(affiliateId: string, slug: string, dest = '/shop') {
  const rows = await raw(`SELECT create_affiliate_link($1,$2,$3,'test') AS r`,
                         [affiliateId, slug, dest])
  const id = (rows[0] as any).r.link_id
  await raw(`UPDATE affiliate_links SET created_at = NOW() - INTERVAL '400 days' WHERE id=$1`, [id])
  return id as string
}

async function callReferral(slug: string, cookie?: string) {
  const headers = new Headers()
  if (cookie) headers.set('cookie', `kvrn_sid=${cookie}`)
  const req: any = new Request(`https://kvrn.shop/r/${slug}`, { headers })
  req.nextUrl = new URL(`https://kvrn.shop/r/${slug}`)
  req.cookies = { get: (n: string) => (cookie && n === 'kvrn_sid' ? { value: cookie } : undefined) }
  return referralGET(req, { params: Promise.resolve({ slug }) })
}
const cookieFrom = (res: any) => {
  const m = /kvrn_sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
  return m ? m[1] : null
}

function webhookRequest(event: unknown) {
  const body = JSON.stringify(event)
  const req: any = new Request('https://kvrn.shop/api/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=test' },
    body,
  })
  req.nextUrl = new URL('https://kvrn.shop/api/stripe/webhook')
  return req
}

function adminPost(url: string, body: unknown) {
  const req: any = new Request(`https://kvrn.shop${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  req.nextUrl = new URL(`https://kvrn.shop${url}`)
  return req
}

/** A realistic paid checkout.session.completed for a reservation. */
function paidEvent(opts: {
  eventId: string; sessionId: string; pi: string; sid: string | null
  reservationId: string; amountTotal: number
}) {
  return {
    id: opts.eventId,
    type: 'checkout.session.completed',
    data: { object: {
      id: opts.sessionId,
      object: 'checkout.session',
      payment_status: 'paid',
      payment_intent: opts.pi,
      currency: 'usd',
      amount_total: opts.amountTotal,
      amount_subtotal: opts.amountTotal,
      client_reference_id: opts.sid,
      customer_details: { email: 'buyer@example.com', name: 'A Buyer' },
      collected_information: { shipping_details: {
        name: 'A Buyer',
        address: { line1: '1 Test St', line2: null, city: 'Austin',
                   state: 'TX', postal_code: '78701', country: 'US' },
      } },
      metadata: { reservation_id: opts.reservationId },
      total_details: { amount_discount: 0, amount_shipping: 800, amount_tax: 0 },
    } },
  }
}

/** Full A → B: real referral route, then the real checkout handler. */
async function runReferralAndCheckout(code: string, slug: string) {
  const aff = await makeAffiliate(code)
  const linkId = await makeLink(aff, slug)
  const refRes = await callReferral(slug)
  expect(refRes.status).toBe(302)
  const sid = cookieFrom(refRes)!

  const clicks = await raw(
    `SELECT id FROM affiliate_clicks WHERE session_id=$1`, [sid])
  expect(clicks).toHaveLength(1)
  const clickId = (clicks[0] as any).id

  // Real product/variant so finalize_paid_order has stock to deduct.
  const productId = uid(); const variantId = uid()
  const sku = `KVRN-WH-${seq}`
  await raw(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
             VALUES ($1,'WH','WH','WH Tee',$2,10000,true)`, [productId, `wh-${seq}`])
  await raw(`INSERT INTO product_variants
             (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand,
              reserved_quantity,active)
             VALUES ($1,$2,$3,'Black','BLK','M',2,10,1,true)`, [variantId, productId, sku])

  const reservationId = uid()
  // 'open' is the reservation state finalize_paid_order expects to complete.
  await raw(`INSERT INTO reservations (id, expires_at, status)
             VALUES ($1, NOW() + INTERVAL '15 minutes','open')`, [reservationId])
  await raw(`INSERT INTO reservation_items
             (reservation_id, variant_id, sku, product_name, size, color, quantity,
              unit_price_cents)
             VALUES ($1,$2,$3,'WH Tee','M','Black',1,10000)`,
            [reservationId, variantId, sku])
  // saveReservationCheckoutDetails is mocked at the deps boundary, so the
  // shipping snapshot it would normally persist is written here. This keeps
  // finalize_paid_order's real AMOUNT_MISMATCH guard genuinely exercised rather
  // than sidestepped: the expected total must match what Stripe reports.
  await raw(`UPDATE reservations
             SET shipping_quoted_cents = 800, shipping_final_cents = 800,
                 shipping_cents = 800, shipping_before_discount_cents = 800,
                 shipping_discount_cents = 0, shipping_auto_free_discount_cents = 0,
                 discount_cents = 0, shipping_method = 'standard',
                 customer_email = 'buyer@example.com'
             WHERE id = $1`, [reservationId])

  reserveInventory.mockResolvedValue({
    ok: true, reservationId,
    items: [{ sku, variantId, quantity: 1, unitPriceCents: 10000,
              name: 'WH Tee', size: 'M', colorName: 'Black' }],
    subtotalCents: 10000, expiresAt: new Date(Date.now() + 9e5).toISOString(),
  })
  saveReservationCheckoutDetails.mockResolvedValue({ ok: true })
  attachStripeSession.mockResolvedValue({ ok: true })
  const checkoutSessionId = `cs_wh_${seq}`
  stripeCreate.mockReset().mockResolvedValue({
    id: checkoutSessionId, url: 'https://stripe.test/pay' })

  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('cookie', `kvrn_sid=${sid}`)
  const req: any = new Request('https://kvrn.shop/api/checkout/session', {
    method: 'POST', headers,
    body: JSON.stringify({
      items: [{ sku, quantity: 1 }], email: 'buyer@example.com',
      shippingAddress: { firstName: 'A', lastName: 'Buyer', line1: '1 Test St',
                         city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
      shippingMethod: 'standard',
    }),
  })
  req.nextUrl = new URL('https://kvrn.shop/api/checkout/session')
  req.cookies = { get: (n: string) => (n === 'kvrn_sid' ? { value: sid } : undefined) }

  const coRes = await checkoutPOST(req)
  expect(coRes.status).toBe(200)
  // B: the exact cookie reached Stripe.
  expect(stripeCreate.mock.calls[0][0].client_reference_id).toBe(sid)

  return { aff, linkId, sid, clickId, variantId, reservationId, checkoutSessionId, sku }
}

// ═════════════════════════════════════════════════════════════════════════════
// BLOCKER 4 — REAL webhook POST creates the order and the commission
// ═════════════════════════════════════════════════════════════════════════════

describe('Blocker 4 — real Stripe webhook POST', () => {

  test('A→B→C: the webhook finalizes the order and attributes the affiliate',
    async () => {
    const ctx = await runReferralAndCheckout('WH1', 'wh-1')

    const evt = paidEvent({
      eventId: `evt_${ctx.checkoutSessionId}`, sessionId: ctx.checkoutSessionId,
      pi: `pi_${ctx.checkoutSessionId}`, sid: ctx.sid,
      reservationId: ctx.reservationId, amountTotal: 10800,
    })
    verifyImpl = () => evt          // only the signature boundary is replaced

    // No order exists yet: finalize_paid_order must create it.
    expect(await raw(
      `SELECT id FROM orders WHERE stripe_checkout_session_id=$1`,
      [ctx.checkoutSessionId])).toHaveLength(0)

    const res = await webhookPOST(webhookRequest(evt))
    expect(res.status).toBe(200)

    // ── the order was CREATED by the production path ───────────────────────
    const orders = await raw(
      `SELECT id, order_number, subtotal_cents, shipping_cents, total_cents,
              payment_status, attribution->>'kvrn_sid' AS sid
       FROM orders WHERE stripe_checkout_session_id=$1`, [ctx.checkoutSessionId])
    expect(orders).toHaveLength(1)
    const order = orders[0] as any
    expect(order.payment_status).toBe('paid')
    expect(Number(order.subtotal_cents)).toBe(10000)
    expect(Number(order.total_cents)).toBe(10800)

    // ── affiliate attribution ──────────────────────────────────────────────
    const att = await raw(
      `SELECT attribution_method, click_id, link_id, affiliate_id,
              attribution_window_days_snapshot AS w, commission_rate_bps_snapshot AS bps,
              commission_base_cents AS base
       FROM order_affiliate_attributions WHERE order_id=$1`, [order.id])
    expect(att).toHaveLength(1)
    const a = att[0] as any
    expect(a.attribution_method).toBe('link')
    expect(a.click_id).toBe(ctx.clickId)        // the click from the REAL /r route
    expect(a.link_id).toBe(ctx.linkId)
    expect(a.affiliate_id).toBe(ctx.aff)
    expect(Number(a.w)).toBe(30)                // click-time window
    expect(Number(a.bps)).toBe(1000)            // finalization-time terms
    expect(Number(a.base)).toBe(10000)          // merchandise only, no shipping

    const comm = await raw(
      `SELECT id, commission_cents FROM affiliate_commissions WHERE order_id=$1`, [order.id])
    expect(comm).toHaveLength(1)
    expect(Number((comm[0] as any).commission_cents)).toBe(1000)

    const accruals = await raw(
      `SELECT adjustment_cents FROM affiliate_commission_adjustments
       WHERE order_id=$1 AND reason='initial_accrual'`, [order.id])
    expect(accruals).toHaveLength(1)            // exactly once
    expect(Number((accruals[0] as any).adjustment_cents)).toBe(1000)
  })

  test('B duplicate delivery is idempotent across order, stock and commission',
    async () => {
    const ctx = await runReferralAndCheckout('WH2', 'wh-2')
    const evt = paidEvent({
      eventId: `evt_${ctx.checkoutSessionId}`, sessionId: ctx.checkoutSessionId,
      pi: `pi_${ctx.checkoutSessionId}`, sid: ctx.sid,
      reservationId: ctx.reservationId, amountTotal: 10800,
    })
    verifyImpl = () => evt

    const first = await webhookPOST(webhookRequest(evt))
    expect(first.status).toBe(200)
    const stockAfterFirst = await raw(
      `SELECT stock_on_hand FROM product_variants WHERE id=$1`, [ctx.variantId])

    const second = await webhookPOST(webhookRequest(evt))
    expect(second.status).toBe(200)

    expect(await raw(`SELECT id FROM orders WHERE stripe_checkout_session_id=$1`,
      [ctx.checkoutSessionId])).toHaveLength(1)
    const order = (await raw(`SELECT id FROM orders WHERE stripe_checkout_session_id=$1`,
      [ctx.checkoutSessionId]))[0] as any
    expect(await raw(`SELECT id FROM order_affiliate_attributions WHERE order_id=$1`,
      [order.id])).toHaveLength(1)
    expect(await raw(`SELECT id FROM affiliate_commissions WHERE order_id=$1`,
      [order.id])).toHaveLength(1)
    expect(await raw(
      `SELECT id FROM affiliate_commission_adjustments
       WHERE order_id=$1 AND reason='initial_accrual'`, [order.id])).toHaveLength(1)

    // Stock deducted exactly once.
    const stockAfterSecond = await raw(
      `SELECT stock_on_hand FROM product_variants WHERE id=$1`, [ctx.variantId])
    expect(Number((stockAfterSecond[0] as any).stock_on_hand))
      .toBe(Number((stockAfterFirst[0] as any).stock_on_hand))
  })

  test('C payment-time attribution failure is non-fatal and recoverable by backfill',
    async () => {
    const ctx = await runReferralAndCheckout('WH3', 'wh-3')
    const evt = paidEvent({
      eventId: `evt_${ctx.checkoutSessionId}`, sessionId: ctx.checkoutSessionId,
      pi: `pi_${ctx.checkoutSessionId}`, sid: ctx.sid,
      reservationId: ctx.reservationId, amountTotal: 10800,
    })
    verifyImpl = () => evt

    // Force ONLY affiliate resolution to fail, after the order is finalized.
    failNextMatching(/resolve_order_affiliate_attribution/, false)
    const res = await webhookPOST(webhookRequest(evt))
    clearFailures()
    expect(res.status).toBe(200)                 // non-fatal: the order stands

    const order = (await raw(
      `SELECT id FROM orders WHERE stripe_checkout_session_id=$1`,
      [ctx.checkoutSessionId]))[0] as any
    expect(order).toBeDefined()
    expect(await raw(`SELECT id FROM order_affiliate_attributions WHERE order_id=$1`,
      [order.id])).toHaveLength(0)               // obligation not yet recorded

    // Admin recovers with ONLY the orderId.
    const bf = await backfillPOST(adminPost('/api/admin/affiliates/backfill',
      { orderId: order.id }))
    const body = await bf.json()
    expect(body.result.outcome).toBe('backfilled')
    expect(stripeRetrieve).not.toHaveBeenCalled()   // local snapshot sufficed

    const att = await raw(
      `SELECT affiliate_id, click_id FROM order_affiliate_attributions WHERE order_id=$1`,
      [order.id])
    expect(att).toHaveLength(1)
    expect((att[0] as any).affiliate_id).toBe(ctx.aff)
    expect((att[0] as any).click_id).toBe(ctx.clickId)

    // Idempotent.
    const again = await backfillPOST(adminPost('/api/admin/affiliates/backfill',
      { orderId: order.id }))
    expect((await again.json()).result.outcome).toBe('already_attributed')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// LOCAL BACKFILL HARDENING — corrupt local evidence must not become a negative
// ═════════════════════════════════════════════════════════════════════════════

describe('local backfill hardening', () => {

  /** A finalized paid order whose local sid we then corrupt. */
  async function finalizedOrder(code: string, slug: string) {
    const ctx = await runReferralAndCheckout(code, slug)
    const evt = paidEvent({
      eventId: `evt_${ctx.checkoutSessionId}`, sessionId: ctx.checkoutSessionId,
      pi: `pi_${ctx.checkoutSessionId}`, sid: ctx.sid,
      reservationId: ctx.reservationId, amountTotal: 10800,
    })
    verifyImpl = () => evt
    failNextMatching(/resolve_order_affiliate_attribution/, false)
    await webhookPOST(webhookRequest(evt))
    clearFailures()
    const order = (await raw(
      `SELECT id FROM orders WHERE stripe_checkout_session_id=$1`,
      [ctx.checkoutSessionId]))[0] as any
    return { ...ctx, orderId: order.id }
  }

  test('A a valid, evidenced local sid does not reach Stripe', async () => {
    const o = await finalizedOrder('LB1', 'lb-1')
    const res = await backfillPOST(adminPost('/api/admin/affiliates/backfill',
      { orderId: o.orderId }))
    expect((await res.json()).result.outcome).toBe('backfilled')
    expect(stripeRetrieve).not.toHaveBeenCalled()
  })

  test('B a MALFORMED local sid falls through to Stripe and succeeds', async () => {
    const o = await finalizedOrder('LB2', 'lb-2')
    // Corrupt, but non-empty — the exact case that previously suppressed fallback.
    await raw(`UPDATE orders SET attribution = jsonb_set(attribution,'{kvrn_sid}','"!!bad!!"')
               WHERE id=$1`, [o.orderId])
    stripeRetrieve.mockResolvedValue({ client_reference_id: o.sid })

    const res = await backfillPOST(adminPost('/api/admin/affiliates/backfill',
      { orderId: o.orderId }))
    const body = await res.json()
    expect(stripeRetrieve).toHaveBeenCalledWith(o.checkoutSessionId)
    expect(body.result.outcome).toBe('backfilled')
    const att = await raw(
      `SELECT affiliate_id FROM order_affiliate_attributions WHERE order_id=$1`, [o.orderId])
    expect((att[0] as any).affiliate_id).toBe(o.aff)
  })

  test('C a well-formed local sid with NO click evidence falls through too', async () => {
    const o = await finalizedOrder('LB3', 'lb-3')
    const orphan = 'A'.repeat(43)                     // valid shape, no click
    await raw(`UPDATE orders SET attribution = jsonb_set(attribution,'{kvrn_sid}',$2::jsonb)
               WHERE id=$1`, [o.orderId, JSON.stringify(orphan)])
    stripeRetrieve.mockResolvedValue({ client_reference_id: o.sid })

    const res = await backfillPOST(adminPost('/api/admin/affiliates/backfill',
      { orderId: o.orderId }))
    expect(stripeRetrieve).toHaveBeenCalled()
    expect((await res.json()).result.outcome).toBe('backfilled')
  })

  test('D malformed local sid + Stripe outage is RETRYABLE, not no_attribution',
    async () => {
    const o = await finalizedOrder('LB4', 'lb-4')
    await raw(`UPDATE orders SET attribution = jsonb_set(attribution,'{kvrn_sid}','"x"')
               WHERE id=$1`, [o.orderId])
    stripeRetrieve.mockRejectedValue(new Error('ETIMEDOUT'))

    const res = await backfillPOST(adminPost('/api/admin/affiliates/backfill',
      { orderId: o.orderId }))
    const body = await res.json()
    expect(res.status).toBe(503)
    expect(body.result.outcome).toBe('retryable_session_recovery_failed')
    expect(body.result.outcome).not.toBe('no_attribution')
    const audit = await raw(
      `SELECT payload->>'outcome' AS o FROM admin_audit_logs
       WHERE action='backfill_attempt' AND resource_id=$1`, [o.orderId])
    expect((audit[0] as any).o).toBe('retryable_session_recovery_failed')
    expect(await raw(`SELECT 1 FROM order_affiliate_attributions WHERE order_id=$1`,
      [o.orderId])).toHaveLength(0)
  })

  test('E malformed local sid + malformed Stripe sid fails closed', async () => {
    const o = await finalizedOrder('LB5', 'lb-5')
    await raw(`UPDATE orders SET attribution = jsonb_set(attribution,'{kvrn_sid}','"x"')
               WHERE id=$1`, [o.orderId])
    stripeRetrieve.mockResolvedValue({ client_reference_id: 'not valid!!' })

    const res = await backfillPOST(adminPost('/api/admin/affiliates/backfill',
      { orderId: o.orderId }))
    expect(res.status).toBe(422)
    expect((await res.json()).result.outcome).toBe('malformed_recovered_session')
  })

  test('F a valid Stripe sid with no click evidence reports the gap, not a link',
    async () => {
    const o = await finalizedOrder('LB6', 'lb-6')
    await raw(`UPDATE orders SET attribution = jsonb_set(attribution,'{kvrn_sid}','"x"')
               WHERE id=$1`, [o.orderId])
    stripeRetrieve.mockResolvedValue({ client_reference_id: 'B'.repeat(43) })

    const res = await backfillPOST(adminPost('/api/admin/affiliates/backfill',
      { orderId: o.orderId }))
    expect(res.status).toBe(422)
    expect((await res.json()).result.outcome).toBe('no_link_evidence')
    expect(await raw(`SELECT 1 FROM order_affiliate_attributions WHERE order_id=$1`,
      [o.orderId])).toHaveLength(0)
  })

  test('G a forged sid in the admin body is refused outright', async () => {
    const o = await finalizedOrder('LB7', 'lb-7')
    const res = await backfillPOST(adminPost('/api/admin/affiliates/backfill',
      { orderId: o.orderId, sessionId: 'C'.repeat(43) }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/recovered server-side/i)
  })
})
