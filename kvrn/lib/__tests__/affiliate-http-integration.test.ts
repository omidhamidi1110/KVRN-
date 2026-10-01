// lib/__tests__/affiliate-http-integration.test.ts
//
// REAL ROUTE HANDLERS. REAL SQL. REAL POSTGRESQL.
//
// This executes the production route handlers against a throwaway database that
// has migrations 001..020 applied. Nothing here re-implements application logic.
//
// Substituted, and only these:
//   * the database TRANSPORT (Neon's HTTP driver cannot reach local Postgres)
//   * Stripe's network calls
//
// Everything else — routing, cookie handling, redirect normalisation, the
// checkout handler, attribution SQL, constraints, triggers and PL/pgSQL — is the
// code that ships.

import { pgSqlWithFaults, connectPg, disconnectPg, raw,
         failNextMatching, clearFailures } from './helpers/pg-transport'

jest.mock('../db', () => ({
  sql: require('./helpers/pg-transport').pgSqlWithFaults,
}))

// Shippo is an external rate API, mocked at its network boundary like Stripe.
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

const stripeCreate = jest.fn()
const stripeRetrieve = jest.fn()
jest.mock('../stripe-client', () => ({
  getStripe: () => ({
    checkout: { sessions: { create: stripeCreate, retrieve: stripeRetrieve } },
  }),
  isValidStripeTestSecretKey: () => true,
  isValidWebhookSecret: () => true,
}))

const DB = 'httptest'
const MAX_WINDOW_DAYS = 365

// Real route handlers.
let referralGET: any
let backfillPOST: any

beforeAll(async () => {
  await connectPg(DB)
  // Self-resetting: the suite must be repeatable without an external DB reset,
  // otherwise it passes alone and collides when run again (standalone or as
  // part of the full suite). orderId values come from a deterministic
  // per-process counter (uid() below), so admin_audit_logs MUST be included
  // here — it has no FK back to any of the other truncated tables, so a prior
  // run's rows survive CASCADE and collide with this run's identically
  // numbered orderId, inflating exact-audit-count assertions.
  await raw(`TRUNCATE affiliate_payout_lines, affiliate_payouts,
    affiliate_commission_adjustments, affiliate_commissions,
    dispute_merchandise_resolutions, order_affiliate_attributions,
    affiliate_clicks, affiliate_links, affiliate_terms_events,
    affiliate_status_events, affiliates, analytics_sessions,
    order_dispute_financial_adjustments, order_disputes, order_refunds,
    orders, reservations, discounts, admin_audit_logs RESTART IDENTITY CASCADE`)
  referralGET = (await import('../../app/r/[slug]/route')).GET
  backfillPOST = (await import('../../app/api/admin/affiliates/backfill/route')).POST
})
afterAll(async () => { await disconnectPg() })
beforeEach(() => { clearFailures(); stripeCreate.mockReset(); stripeRetrieve.mockReset() })

// ── fixture helpers (setup only; never substitutes application logic) ────────
let seq = 0
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

async function makeAffiliate(code: string, bps: number, windowDays = 30, createdDaysAgo = 400) {
  const rows = await raw(
    `SELECT create_affiliate($1,$2,NULL,'percentage',$3,NULL,'proportional',$4,0,NULL,NULL,'test') AS r`,
    [code, code, bps, windowDays])
  const id = (rows[0] as any).r.affiliate_id
  // Backdate creation so historical lookups have room; temporal causality (#5)
  // correctly refuses attribution for orders predating an affiliate.
  await raw(`UPDATE affiliates SET created_at = NOW() - ($1 || ' days')::interval WHERE id=$2`,
            [String(createdDaysAgo), id])
  await raw(`UPDATE affiliate_terms_events SET effective_at = NOW() - ($1 || ' days')::interval WHERE affiliate_id=$2`,
            [String(createdDaysAgo), id])
  await raw(`UPDATE affiliate_status_events SET effective_at = NOW() - ($1 || ' days')::interval WHERE affiliate_id=$2`,
            [String(createdDaysAgo), id])
  return id as string
}

async function makeLink(affiliateId: string, slug: string, dest = '/shop', createdDaysAgo = 400) {
  const rows = await raw(`SELECT create_affiliate_link($1,$2,$3,'test') AS r`,
                         [affiliateId, slug, dest])
  const id = (rows[0] as any).r.link_id
  await raw(`UPDATE affiliate_links SET created_at = NOW() - ($1 || ' days')::interval WHERE id=$2`,
            [String(createdDaysAgo), id])
  return id as string
}

function referralRequest(slug: string, opts: { cookie?: string; referer?: string } = {}) {
  const headers = new Headers()
  if (opts.cookie) headers.set('cookie', `kvrn_sid=${opts.cookie}`)
  if (opts.referer) headers.set('referer', opts.referer)
  const req: any = new Request(`https://kvrn.shop/r/${slug}`, { headers })
  req.nextUrl = new URL(`https://kvrn.shop/r/${slug}`)
  req.cookies = {
    get: (n: string) => (opts.cookie && n === 'kvrn_sid' ? { value: opts.cookie } : undefined),
  }
  return req
}

async function callReferral(slug: string, opts: { cookie?: string; referer?: string } = {}) {
  return referralGET(referralRequest(slug, opts), { params: Promise.resolve({ slug }) })
}

function cookieFrom(res: any): string | null {
  const raw = res.headers.get('set-cookie')
  if (!raw) return null
  const m = /kvrn_sid=([^;]+)/.exec(raw)
  return m ? m[1] : null
}

// ═════════════════════════════════════════════════════════════════════════════
// HTTP A — /r/[slug]
// ═════════════════════════════════════════════════════════════════════════════

describe('HTTP A — real referral route', () => {

  test('redirects, sets an opaque session cookie, and records the click', async () => {
    const aff = await makeAffiliate('HTTPA', 1000)
    await makeLink(aff, 'http-a', '/shop/drop')

    const res = await callReferral('http-a')

    expect(res.status).toBe(302)
    const loc = res.headers.get('location')
    expect(loc).toBe('https://kvrn.shop/shop/drop')       // safe, same-origin
    expect(new URL(loc!).origin).toBe('https://kvrn.shop')

    const setCookie = res.headers.get('set-cookie')!
    expect(setCookie).toContain('kvrn_sid=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toMatch(/SameSite=lax/i)
    expect(setCookie).toContain('Path=/')

    const sid = cookieFrom(res)!
    expect(sid).toMatch(/^[A-Za-z0-9_-]{32,128}$/)

    // Lifetime must outlive the longest supported attribution window.
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)![1])
    expect(maxAge).toBeGreaterThan(MAX_WINDOW_DAYS * 24 * 60 * 60)

    // DB rows use EXACTLY the cookie value.
    const sessions = await raw(`SELECT session_id FROM analytics_sessions WHERE session_id=$1`, [sid])
    expect(sessions).toHaveLength(1)
    const clicks = await raw(
      `SELECT session_id, affiliate_id FROM affiliate_clicks WHERE session_id=$1`, [sid])
    expect(clicks).toHaveLength(1)
    expect((clicks[0] as any).affiliate_id).toBe(aff)
  })

  test('an existing cookie is reused rather than fragmenting identity', async () => {
    const aff = await makeAffiliate('HTTPA2', 1000)
    await makeLink(aff, 'http-a2')
    const first = await callReferral('http-a2')
    const sid = cookieFrom(first)!

    const second = await callReferral('http-a2', { cookie: sid })
    // No new cookie is issued for a session that already exists.
    expect(second.headers.get('set-cookie')).toBeNull()

    const clicks = await raw(`SELECT id FROM affiliate_clicks WHERE session_id=$1`, [sid])
    expect(clicks).toHaveLength(2)                 // a new click appended
    const sessions = await raw(`SELECT id FROM analytics_sessions WHERE session_id=$1`, [sid])
    expect(sessions).toHaveLength(1)               // one identity
  })

  test('an unknown slug still lands the visitor somewhere safe', async () => {
    const res = await callReferral('no-such-slug')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://kvrn.shop/')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// HTTP G — redirect safety and referrer privacy, through the real route
// ═════════════════════════════════════════════════════════════════════════════

describe('HTTP G — redirect and referrer privacy', () => {

  test('a tampered destination cannot become an open redirect', async () => {
    const aff = await makeAffiliate('HTTPG', 1000)
    const vectors = [
      'https://evil.test/x', '//evil.test', '/\\evil.test', 'javascript:alert(1)',
      'data:text/html,x', 'mailto:a@b.c', '///evil.test', 'evil.test',
    ]
    for (let i = 0; i < vectors.length; i++) {
      const slug = `httpg-${i}`
      await makeLink(aff, slug, '/ok')
      // Corrupt the stored destination directly, simulating tampering.
      await raw(`UPDATE affiliate_links SET destination_path=$1 WHERE slug=$2`, [vectors[i], slug])
      const res = await callReferral(slug)
      const loc = new URL(res.headers.get('location')!)
      expect(loc.origin).toBe('https://kvrn.shop')
      expect(loc.pathname).toBe('/')
    }
  })

  test('sensitive referrer data is never stored raw', async () => {
    const aff = await makeAffiliate('HTTPG2', 1000)
    await makeLink(aff, 'http-g2')
    const referrers = [
      'https://mail.example.com/inbox?email=someone@example.com&token=SECRET123#frag',
      'https://user:hunter2@example.com/p?q=1',
      'https://kvrn.shop/checkout?order=KVRN-000123&sid=abcdef',
      'not a url',
      'javascript:alert(1)',
      'https://example.com/' + 'a'.repeat(3000),
    ]
    for (const r of referrers) {
      const res = await callReferral('http-g2', { referer: r })
      expect(res.status).toBe(302)
    }
    const stored = await raw(
      `SELECT referrer FROM affiliate_clicks WHERE affiliate_id=$1
       UNION ALL SELECT referrer FROM analytics_sessions WHERE landing_page='/r/http-g2'`, [aff])
    for (const row of stored as any[]) {
      const v: string | null = row.referrer
      if (v === null) continue
      expect(v).not.toMatch(/someone@example\.com|SECRET123|hunter2|KVRN-000123|sid=|\?|#/)
      expect(v.length).toBeLessThan(200)
      // Only an origin survives.
      expect(v).toMatch(/^https?:\/\/[^/?#]+$/)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// HTTP D / E / F — attribution precedence through real click ingestion
// ═════════════════════════════════════════════════════════════════════════════

/** Creates a paid order and resolves attribution through the real SQL path. */
async function paidOrderAndAttribute(
  sessionId: string | null, discountCode: string | null, discountId: string | null,
) {
  const orderId = uid()
  const n = `HT-${++seq}`
  await raw(
    `INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,
       payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,
       paid_at,discount_code,discount_id)
     VALUES ($1,$2,$3,$4,'paid','usd',10000,0,0,0,10000,NOW(),$5,$6)`,
    [orderId, n, `cs_${n}`, `pi_${n}`, discountCode, discountId])
  const rows = await raw(
    `SELECT resolve_order_affiliate_attribution($1,$2,'test') AS r`, [orderId, sessionId])
  return { orderId, result: (rows[0] as any).r }
}

describe('HTTP D — the most recent qualifying click wins', () => {
  test('affiliate B, clicked later, takes the attribution', async () => {
    const a = await makeAffiliate('HTTPD_A', 1000)
    const b = await makeAffiliate('HTTPD_B', 2000)
    await makeLink(a, 'http-d-a'); await makeLink(b, 'http-d-b')

    const first = await callReferral('http-d-a')
    const sid = cookieFrom(first)!
    await new Promise(r => setTimeout(r, 20))
    await callReferral('http-d-b', { cookie: sid })

    const { result } = await paidOrderAndAttribute(sid, null, null)
    expect(result.outcome).toBe('attributed')
    expect(result.affiliate_id).toBe(b)
    expect(result.method).toBe('link')
  })
})

describe('HTTP E — an authoritative code beats a link', () => {
  test('the discount owner wins over the clicked affiliate', async () => {
    const a = await makeAffiliate('HTTPE_A', 1000)
    const b = await makeAffiliate('HTTPE_B', 1500)
    await makeLink(a, 'http-e-a')

    const discountId = uid()
    await raw(`INSERT INTO discounts (id,code,name,type,percentage_bps,active,system_managed)
               VALUES ($1,'HTTPE20','E','percentage',2000,true,true)`, [discountId])
    // Historical ownership: B owns the discount from before the order.
    await raw(`SELECT update_affiliate_terms($1,'percentage',1500,NULL,'proportional',30,0,$2,
                 NOW() - INTERVAL '300 days','own','test')`, [b, discountId])

    const res = await callReferral('http-e-a')
    const sid = cookieFrom(res)!
    const { result } = await paidOrderAndAttribute(sid, 'HTTPE20', discountId)
    expect(result.outcome).toBe('attributed')
    expect(result.affiliate_id).toBe(b)
    expect(result.method).toBe('code')
  })
})

describe('HTTP F — pause semantics', () => {
  test('a pre-pause click still converts; a post-pause click does not', async () => {
    const aff = await makeAffiliate('HTTPF', 1000)
    await makeLink(aff, 'http-f')

    const res = await callReferral('http-f')
    const sid = cookieFrom(res)!
    // Age the click so it precedes the pause.
    await raw(`UPDATE affiliate_clicks SET occurred_at = NOW() - INTERVAL '5 days'
               WHERE session_id=$1`, [sid])
    await raw(`SELECT set_affiliate_status($1,'paused', NOW() - INTERVAL '2 days','p','test')`, [aff])

    const pre = await paidOrderAndAttribute(sid, null, null)
    expect(pre.result.outcome).toBe('attributed')

    // A NEW click, made while paused, must not qualify.
    const res2 = await callReferral('http-f')
    const sid2 = cookieFrom(res2)
    const post = await paidOrderAndAttribute(sid2, null, null)
    expect(post.result.outcome).toBe('no_attribution')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// #8 — DURABLE SESSION RECOVERY through the real backfill route
// ═════════════════════════════════════════════════════════════════════════════

jest.mock('../admin-auth', () => ({
  requireAdmin: async () => ({ identity: { email: 'admin@kvrn.test' }, error: null }),
}))

function adminRequest(body: unknown) {
  const req: any = new Request('https://kvrn.shop/api/admin/affiliates/backfill', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  req.nextUrl = new URL('https://kvrn.shop/api/admin/affiliates/backfill')
  return req
}

describe('#8 — backfill session recovery, real route', () => {

  test('8.6 local snapshot recovers a link referral with only orderId', async () => {
    const aff = await makeAffiliate('BF_LOCAL', 1000)
    await makeLink(aff, 'bf-local')
    const res = await callReferral('bf-local')
    const sid = cookieFrom(res)!

    const orderId = uid()
    await raw(
      `INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,
         payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,
         paid_at,attribution)
       VALUES ($1,$2,$3,$4,'paid','usd',10000,0,0,0,10000,NOW(),$5::jsonb)`,
      [orderId, `BFL-${seq}`, `cs_bfl_${seq}`, `pi_bfl_${seq}`,
       JSON.stringify({ kvrn_sid: sid })])

    const r = await backfillPOST(adminRequest({ orderId }))
    const body = await r.json()
    expect(body.result.outcome).toBe('backfilled')
    expect(stripeRetrieve).not.toHaveBeenCalled()      // local data sufficed

    const att = await raw(
      `SELECT attribution_method, affiliate_id, click_id FROM order_affiliate_attributions
       WHERE order_id=$1`, [orderId])
    expect(att).toHaveLength(1)
    expect((att[0] as any).attribution_method).toBe('link')
    expect((att[0] as any).affiliate_id).toBe(aff)
    expect((att[0] as any).click_id).not.toBeNull()

    // Idempotent.
    const again = await backfillPOST(adminRequest({ orderId }))
    expect((await again.json()).result.outcome).toBe('already_attributed')
  })

  test('8.7 Stripe fallback recovers when the local snapshot is missing', async () => {
    const aff = await makeAffiliate('BF_STRIPE', 1000)
    await makeLink(aff, 'bf-stripe')
    const res = await callReferral('bf-stripe')
    const sid = cookieFrom(res)!

    const orderId = uid()
    const csid = `cs_stripe_${seq}`
    await raw(
      `INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,
         payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at)
       VALUES ($1,$2,$3,$4,'paid','usd',10000,0,0,0,10000,NOW())`,
      [orderId, `BFS-${seq}`, csid, `pi_bfs_${seq}`])

    stripeRetrieve.mockResolvedValue({ id: csid, client_reference_id: sid })

    const r = await backfillPOST(adminRequest({ orderId }))
    const body = await r.json()
    expect(stripeRetrieve).toHaveBeenCalledWith(csid)
    expect(body.result.outcome).toBe('backfilled')

    const att = await raw(
      `SELECT affiliate_id FROM order_affiliate_attributions WHERE order_id=$1`, [orderId])
    expect((att[0] as any).affiliate_id).toBe(aff)
  })

  test('8.8 a Stripe outage is retryable, never no_attribution', async () => {
    const orderId = uid()
    await raw(
      `INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,
         payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at)
       VALUES ($1,$2,$3,$4,'paid','usd',10000,0,0,0,10000,NOW())`,
      [orderId, `BFO-${seq}`, `cs_out_${seq}`, `pi_out_${seq}`])

    stripeRetrieve.mockRejectedValue(new Error('ETIMEDOUT'))

    const r = await backfillPOST(adminRequest({ orderId }))
    const body = await r.json()
    expect(r.status).toBe(503)
    expect(body.result.outcome).toBe('retryable_session_recovery_failed')
    expect(body.result.outcome).not.toBe('no_attribution')

    // The unknown state is audited as retryable, not as an absence.
    const audit = await raw(
      `SELECT payload->>'outcome' AS o FROM admin_audit_logs
       WHERE action='backfill_attempt' AND resource_id=$1`, [orderId])
    expect((audit[0] as any).o).toBe('retryable_session_recovery_failed')

    const att = await raw(
      `SELECT 1 FROM order_affiliate_attributions WHERE order_id=$1`, [orderId])
    expect(att).toHaveLength(0)
  })

  test('8.9 a malformed client_reference_id fails closed and is audited exactly once', async () => {
    const orderId = uid()
    await raw(
      `INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,
         payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at)
       VALUES ($1,$2,$3,$4,'paid','usd',10000,0,0,0,10000,NOW())`,
      [orderId, `BFM-${seq}`, `cs_mal_${seq}`, `pi_mal_${seq}`])

    stripeRetrieve.mockResolvedValue({ client_reference_id: 'not a valid session!!' })

    const r = await backfillPOST(adminRequest({ orderId }))
    expect(r.status).toBe(422)
    expect((await r.json()).result.outcome).toBe('malformed_recovered_session')
    expect(await raw(`SELECT 1 FROM order_affiliate_attributions WHERE order_id=$1`, [orderId]))
      .toHaveLength(0)

    // Final5: this outcome reaches no canonical SQL function (there is nothing
    // to attribute), so without an explicit insert it used to leave NO trace
    // at all — unlike every other backfill outcome, which is always audited.
    const audit = await raw(
      `SELECT payload->>'outcome' AS o FROM admin_audit_logs
       WHERE action='backfill_attempt' AND resource_id=$1`, [orderId])
    expect(audit).toHaveLength(1)
    expect((audit[0] as any).o).toBe('malformed_recovered_session')
  })

  test('8.10 a forged session id in the request body is refused', async () => {
    const orderId = uid()
    await raw(
      `INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,
         payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at)
       VALUES ($1,$2,$3,$4,'paid','usd',10000,0,0,0,10000,NOW())`,
      [orderId, `BFF-${seq}`, `cs_forge_${seq}`, `pi_forge_${seq}`])

    const r = await backfillPOST(adminRequest({
      orderId, sessionId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }))
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(/recovered server-side/i)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// HTTP B — the REAL checkout handler
// ═════════════════════════════════════════════════════════════════════════════
//
// createCheckoutPostHandler is exactly what app/api/checkout/session/route.ts
// exports as POST. The dependencies injected below are the same functions that
// route injects; only Stripe is mocked, and the reservation deps are stubbed so
// the test does not depend on unrelated inventory fixtures.

describe('HTTP B — real checkout handler', () => {
  let checkoutPOST: any
  const reserveInventory = jest.fn()
  const saveReservationCheckoutDetails = jest.fn()
  const attachStripeSession = jest.fn()
  const failReservation = jest.fn()

  beforeAll(async () => {
    const { createCheckoutPostHandler } = await import('../checkout-session-handler')
    checkoutPOST = createCheckoutPostHandler({
      isCheckoutEnabled: () => true,
      getSiteOrigin: () => 'https://kvrn.shop',
      getStripe: () => ({ checkout: { sessions: { create: stripeCreate } } }) as any,
      reserveInventory,
      saveReservationCheckoutDetails,
      failReservation,
      attachStripeSession,
      releaseExpiredReservations: jest.fn(),
    } as any)
  })

  let variantId: string
  let reservationId: string

  beforeEach(async () => {
    process.env.ENABLE_STRIPE_TEST_CHECKOUT = 'true'
    // Real handler requires a token to be present before consulting the rate API.
    process.env.SHIPPO_API_TOKEN = 'shippo_test_token'
    reservationId = uid()
    variantId = uid()
    reserveInventory.mockResolvedValue({
      ok: true, reservationId,
      items: [{ sku: 'KVRN-HT-M', variantId, quantity: 1, unitPriceCents: 10000,
                name: 'HT Tee', size: 'M', colorName: 'Black' }],
      subtotalCents: 10000, expiresAt: new Date(Date.now() + 9e5).toISOString(),
    })
    saveReservationCheckoutDetails.mockResolvedValue({ ok: true })
    // A REAL reservations row, so persist_checkout_affiliate_session writes to
    // real state and the snapshot assertion tests actual persistence.
    await raw(`INSERT INTO reservations (id, expires_at) VALUES ($1, NOW() + INTERVAL '15 minutes')
               ON CONFLICT (id) DO NOTHING`, [reservationId])
    attachStripeSession.mockResolvedValue({ ok: true })
    stripeCreate.mockResolvedValue({ id: 'cs_test_http_b', url: 'https://stripe.test/pay' })
  })

  function checkoutRequest(cookie: string | null, extraBody: Record<string, unknown> = {}) {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (cookie) headers.set('cookie', `kvrn_sid=${cookie}`)
    const req: any = new Request('https://kvrn.shop/api/checkout/session', {
      method: 'POST', headers,
      body: JSON.stringify({
        items: [{ sku: 'KVRN-HT-M', quantity: 1 }],
        email: 'buyer@example.com',
        shippingAddress: { firstName: 'A', lastName: 'Buyer', line1: '1 Test St',
                           city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
        shippingMethod: 'standard',
        ...extraBody,
      }),
    })
    req.nextUrl = new URL('https://kvrn.shop/api/checkout/session')
    req.cookies = { get: (n: string) => (cookie && n === 'kvrn_sid' ? { value: cookie } : undefined) }
    return req
  }

  test('B1 the exact cookie reaches Stripe as client_reference_id', async () => {
    const aff = await makeAffiliate('HTTPB', 1000)
    await makeLink(aff, 'http-b')
    const sid = cookieFrom(await callReferral('http-b'))!

    const res = await checkoutPOST(checkoutRequest(sid))
    expect(res.status).toBe(200)

    expect(stripeCreate).toHaveBeenCalledTimes(1)
    const args = stripeCreate.mock.calls[0][0]
    expect(args.client_reference_id).toBe(sid)

    // The authoritative local snapshot holds the same value.
    const rows = await raw(
      `SELECT attribution->>'kvrn_sid' AS sid FROM reservations WHERE id=$1`, [reservationId])
    expect((rows[0] as any)?.sid).toBe(sid)
  })

  test('B2 a forged body client_reference_id cannot override the cookie', async () => {
    const aff = await makeAffiliate('HTTPB2', 1000)
    await makeLink(aff, 'http-b2')
    const sid = cookieFrom(await callReferral('http-b2'))!

    const res = await checkoutPOST(checkoutRequest(sid, {
      client_reference_id: 'FORGED_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      sessionId: 'FORGED2_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      kvrn_sid: 'FORGED3_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }))
    expect(res.status).toBe(200)
    expect(stripeCreate.mock.calls[0][0].client_reference_id).toBe(sid)
  })

  test('B3 fail-closed: persistence failure means Stripe is NEVER called', async () => {
    const aff = await makeAffiliate('HTTPB3', 1000)
    await makeLink(aff, 'http-b3')
    const sid = cookieFrom(await callReferral('http-b3'))!

    // Force the authoritative persistence write to fail at the transport layer.
    failNextMatching(/persist_checkout_affiliate_session/)

    const res = await checkoutPOST(checkoutRequest(sid))
    expect(res.status).toBe(503)
    // Proven by call count, not by source ordering.
    expect(stripeCreate).toHaveBeenCalledTimes(0)
  })

  test('B4 no cookie: checkout proceeds and no affiliate state is fabricated', async () => {
    const res = await checkoutPOST(checkoutRequest(null))
    expect(res.status).toBe(200)
    expect(stripeCreate).toHaveBeenCalledTimes(1)
    expect(stripeCreate.mock.calls[0][0].client_reference_id).toBeNull()
    const rows = await raw(
      `SELECT attribution->>'kvrn_sid' AS sid FROM reservations WHERE id=$1`, [reservationId])
    expect((rows[0] as any)?.sid ?? null).toBeNull()
  })

  test('B5 a stale cookie with no click evidence does not block checkout', async () => {
    const stale = 'Zm9yZ2VkX3Nlc3Npb25faWRfd2l0aF9ub19ldmlkZW5jZV94eHg'
    failNextMatching(/persist_checkout_affiliate_session/)
    const res = await checkoutPOST(checkoutRequest(stale))
    // Not a referral, so a failed best-effort write must not become a liability.
    expect(res.status).toBe(200)
    expect(stripeCreate).toHaveBeenCalledTimes(1)
  })

  test('B6 unknown evidence state fails closed rather than assuming no referral', async () => {
    const aff = await makeAffiliate('HTTPB6', 1000)
    await makeLink(aff, 'http-b6')
    const sid = cookieFrom(await callReferral('http-b6'))!

    // Both the evidence lookup AND the persist fail: the state is unknowable.
    failNextMatching(/FROM affiliate_clicks|persist_checkout_affiliate_session/, false)
    const res = await checkoutPOST(checkoutRequest(sid))
    clearFailures()
    expect(res.status).toBe(503)
    expect(stripeCreate).toHaveBeenCalledTimes(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// HTTP C — the REAL paid-order attribution path
// ═════════════════════════════════════════════════════════════════════════════
//
// The webhook's affiliate boundary is tryResolveAffiliateAttribution(orderId,
// session.client_reference_id), invoked after finalize_paid_order creates the
// order. This drives that exact boundary: the real finalize function, then the
// real attribution SQL, using the client_reference_id HTTP B actually produced.

describe('HTTP C — paid order attribution end to end', () => {

  test('C1 a link referral becomes a commission with click-time window snapshot', async () => {
    // A: real referral route produces the click and cookie.
    const aff = await makeAffiliate('HTTPC', 1000, 30)
    const linkId = await makeLink(aff, 'http-c')
    const res = await callReferral('http-c')
    const sid = cookieFrom(res)!
    const clickRows = await raw(
      `SELECT id FROM affiliate_clicks WHERE session_id=$1`, [sid])
    const clickId = (clickRows[0] as any).id

    // The window is later SHRUNK, after the click. Qualification must still use
    // the click-time window, and the snapshot must record that value.
    await raw(`UPDATE affiliate_clicks SET occurred_at = NOW() - INTERVAL '20 days'
               WHERE session_id=$1`, [sid])
    await raw(`SELECT update_affiliate_terms($1,'percentage',1000,NULL,'proportional',7,0,NULL,
                 NOW() - INTERVAL '5 days','shrink','test')`, [aff])

    // C: paid order, then the webhook's attribution boundary with the exact
    // client_reference_id Stripe would carry from HTTP B.
    const orderId = uid()
    const n = `HTTPC-${++seq}`
    await raw(
      `INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,
         payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at)
       VALUES ($1,$2,$3,$4,'paid','usd',10000,0,0,0,10000,NOW())`,
      [orderId, n, `cs_${n}`, `pi_${n}`])

    const out = await raw(
      `SELECT resolve_order_affiliate_attribution($1,$2,'system@kvrn.internal') AS r`,
      [orderId, sid])
    const result = (out[0] as any).r
    expect(result.outcome).toBe('attributed')
    expect(result.method).toBe('link')
    expect(result.affiliate_id).toBe(aff)

    const att = await raw(
      `SELECT attribution_method, click_id, link_id, affiliate_id,
              attribution_window_days_snapshot AS w, commission_rate_bps_snapshot AS bps,
              commission_base_cents AS base
       FROM order_affiliate_attributions WHERE order_id=$1`, [orderId])
    const a = att[0] as any
    expect(a.attribution_method).toBe('link')
    expect(a.click_id).toBe(clickId)                 // the click from HTTP A
    expect(a.link_id).toBe(linkId)
    expect(a.affiliate_id).toBe(aff)
    expect(Number(a.w)).toBe(30)                     // CLICK-TIME window, not 7
    expect(Number(a.bps)).toBe(1000)                 // finalization-time terms
    expect(Number(a.base)).toBe(10000)

    const comm = await raw(
      `SELECT affiliate_id, commission_cents FROM affiliate_commissions WHERE order_id=$1`,
      [orderId])
    expect(comm).toHaveLength(1)
    expect((comm[0] as any).affiliate_id).toBe(aff)
    expect(Number((comm[0] as any).commission_cents)).toBe(1000)

    // The accrual is in the append-only ledger.
    const led = await raw(
      `SELECT COALESCE(SUM(adjustment_cents),0) AS net FROM affiliate_commission_adjustments
       WHERE order_id=$1`, [orderId])
    expect(Number((led[0] as any).net)).toBe(1000)
  })

  test('C2 a stale click is not revived by a later, wider window', async () => {
    const aff = await makeAffiliate('HTTPC2', 1000, 7)
    await makeLink(aff, 'http-c2')
    const sid = cookieFrom(await callReferral('http-c2'))!
    await raw(`UPDATE affiliate_clicks SET occurred_at = NOW() - INTERVAL '20 days'
               WHERE session_id=$1`, [sid])
    await raw(`SELECT update_affiliate_terms($1,'percentage',1000,NULL,'proportional',30,0,NULL,
                 NOW() - INTERVAL '5 days','widen','test')`, [aff])

    const { result } = await paidOrderAndAttribute(sid, null, null)
    expect(result.outcome).toBe('no_attribution')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// HTTP A (cont.) — Secure attribute, verified against the REAL response
// ═════════════════════════════════════════════════════════════════════════════
//
// sessionCookieOptions sets `secure` from NODE_ENV. Rather than assume, both
// modes are executed against the actual /r route and the real Set-Cookie header
// is inspected.

describe('HTTP A — Secure cookie behaviour by environment', () => {

  test('the production-mode option object marks the cookie Secure', () => {
    jest.resetModules()
    const prev = process.env.NODE_ENV
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true })
    // Re-import so the module-level option object is evaluated in production mode.
    const { sessionCookieOptions } = require('../affiliate-session')
    expect(sessionCookieOptions.secure).toBe(true)
    expect(sessionCookieOptions.httpOnly).toBe(true)
    expect(sessionCookieOptions.sameSite).toBe('lax')
    expect(sessionCookieOptions.path).toBe('/')
    Object.defineProperty(process.env, 'NODE_ENV', { value: prev, configurable: true })
    jest.resetModules()
  })

  test('the real route omits Secure outside production, by design', async () => {
    // Local/dev is served over http, where a Secure cookie would never be sent
    // back and referral identity would be lost on every visit.
    const aff = await makeAffiliate('SECURE1', 1000)
    await makeLink(aff, 'secure-1')
    const res = await callReferral('secure-1')
    const setCookie = res.headers.get('set-cookie')!
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).not.toContain('Secure')   // NODE_ENV is 'test' here
  })

  test('the real route emits Secure when running in production mode', async () => {
    jest.resetModules()
    const prev = process.env.NODE_ENV
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true })
    const prodGET = require('../../app/r/[slug]/route').GET

    const aff = await makeAffiliate('SECURE2', 1000)
    await makeLink(aff, 'secure-2')
    const res = await prodGET(referralRequest('secure-2'),
                              { params: Promise.resolve({ slug: 'secure-2' }) })
    const setCookie = res.headers.get('set-cookie')!
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toMatch(/SameSite=lax/i)
    expect(setCookie).toContain('Path=/')

    Object.defineProperty(process.env, 'NODE_ENV', { value: prev, configurable: true })
    jest.resetModules()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// FINAL3-A — BLOCKER 1: dispute-centric reconciliation through real boundaries
// ═════════════════════════════════════════════════════════════════════════════

let reconciliationPOST: any
let payoutsPOST: any
let recoveriesPOST: any
let recoveriesGET: any

beforeAll(async () => {
  reconciliationPOST = (await import('../../app/api/admin/affiliates/reconciliation/route')).POST
  payoutsPOST        = (await import('../../app/api/admin/affiliates/payouts/route')).POST
  const rec          = await import('../../app/api/admin/affiliates/recoveries/route')
  recoveriesPOST     = rec.POST
  recoveriesGET      = rec.GET
})

function adminPost(url: string, body: unknown) {
  const req: any = new Request(`https://kvrn.shop${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  req.nextUrl = new URL(`https://kvrn.shop${url}`)
  return req
}

/** Order + paid commission, via the real attribution SQL. */
async function commissionFor(affiliateId: string, code: string, subtotal = 10000) {
  const orderId = uid(); const n = `F3A-${++seq}`
  await raw(
    `INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,
       payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,
       paid_at,discount_code)
     VALUES ($1,$2,$3,$4,'paid','usd',$5,0,0,0,$5,NOW() - INTERVAL '2 days',$6)`,
    [orderId, n, `cs_${n}`, `pi_${n}`, subtotal, code])
  await raw(`SELECT resolve_order_affiliate_attribution($1,NULL,'test')`, [orderId])
  const c = await raw(`SELECT id FROM affiliate_commissions WHERE order_id=$1`, [orderId])
  return { orderId, pi: `pi_${n}`, charge: `ch_${n}`,
           commissionId: (c[0] as any)?.id as string, n }
}

describe('Blocker 1 — unresolved sources are dispute-centric and per-source', () => {
  const svc = () => require('../affiliates').createAffiliatesService(pgSqlWithFaults)

  test('A zero-delta lost partial dispute is listed and actionable', async () => {
    const aff = await makeAffiliate('B1ZERO', 1000)
    // subtotal 10000 + shipping 5000 so a shipping-only refund offsets the dispute
    const orderId = uid(); const n = `B1Z-${++seq}`
    await raw(
      `INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,
         payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,
         paid_at,discount_code)
       VALUES ($1,$2,$3,$4,'paid','usd',10000,5000,0,0,15000,NOW() - INTERVAL '2 days','B1ZERO')`,
      [orderId, n, `cs_${n}`, `pi_${n}`])
    await raw(`SELECT resolve_order_affiliate_attribution($1,NULL,'test')`, [orderId])

    // Shipping-only refund: merchandise component is zero.
    await raw(
      `INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,
         stripe_payment_intent_id,amount_cents,merchandise_refund_cents,shipping_refund_cents,
         tax_refund_cents,component_breakdown_status,status,refunded_at)
       VALUES ($1,$2,$3,$4,$5,5000,0,5000,0,'resolved','succeeded',NOW() - INTERVAL '1 day')`,
      [uid(), orderId, `re_${n}`, `ch_${n}`, `pi_${n}`])
    await raw(`SELECT apply_affiliate_refund_reversal(
      (SELECT id FROM order_refunds WHERE order_id=$1),'test')`, [orderId])

    await raw(`SELECT upsert_order_dispute($1,$2,$3,5000,'usd','lost','lost',$4,
      'charge.dispute.closed',NOW(),NULL,'{}'::jsonb)`,
      [`dz_${n}`, `ch_${n}`, `pi_${n}`, `ev_${n}`])

    // 018 booked nothing, so there is no adjustment row to key on.
    const dfa = await raw(
      `SELECT id FROM order_dispute_financial_adjustments WHERE order_id=$1`, [orderId])
    expect(dfa).toHaveLength(0)

    const disputeRows = await raw(
      `SELECT id FROM order_disputes WHERE stripe_dispute_id=$1`, [`dz_${n}`])
    await raw(`SELECT sync_affiliate_dispute_state($1,NULL,'test')`, [(disputeRows[0] as any).id])

    const listed = await svc().listIncomplete()
    const row = listed.find((x: any) => x.orderNumber === n)
    expect(row).toBeDefined()
    expect(row.sourceKind).toBe('dispute')
    expect(row.disputeId).toBe((disputeRows[0] as any).id)
    expect(row.canResolveHere).toBe(true)
    expect(row.rowKey).toBe(`${row.commissionId}:dispute:${row.disputeId}`)
    // The removed identifier must not reappear.
    expect(row).not.toHaveProperty('disputeAdjustmentId')

    // B: resolve through the REAL reconciliation route, using disputeId only.
    const res = await reconciliationPOST(adminPost(
      '/api/admin/affiliates/reconciliation',
      { disputeId: row.disputeId, merchandiseCents: 4000, shippingCents: 1000, taxCents: 0 }))
    expect(res.status).toBe(200)
    expect((await res.json()).result.outcome).toBe('resolved')

    const claim = await raw(
      `SELECT affiliate_source_claim($1,'dispute:'||$2) AS c`,
      [row.commissionId, row.disputeId])
    expect(Number((claim[0] as any).c)).toBe(4000)

    const after = await raw(
      `SELECT incomplete FROM affiliate_commissions WHERE id=$1`, [row.commissionId])
    expect((after[0] as any).incomplete).toBe(false)
  })

  test('C two unresolved disputes stay independently addressable', async () => {
    const aff = await makeAffiliate('B1TWO', 1000)
    const { orderId, pi, charge, commissionId, n } = await commissionFor(aff, 'B1TWO')

    for (const [sd, amt] of [[`d1_${n}`, 3000], [`d2_${n}`, 2000]] as const) {
      await raw(`SELECT upsert_order_dispute($1,$2,$3,$4,'usd','lost','lost',$5,
        'charge.dispute.closed',NOW(),NULL,'{}'::jsonb)`,
        [sd, charge, pi, amt, `ev_${sd}`])
      const d = await raw(`SELECT id FROM order_disputes WHERE stripe_dispute_id=$1`, [sd])
      await raw(`SELECT sync_affiliate_dispute_state($1,NULL,'test')`, [(d[0] as any).id])
    }

    let rows = (await svc().listIncomplete()).filter((x: any) => x.commissionId === commissionId)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r: any) => r.rowKey)).size).toBe(2)   // distinct keys
    expect(new Set(rows.map((r: any) => r.disputeId)).size).toBe(2)

    // Resolve the first only.
    const first = rows.find((r: any) => r.disputedAmountCents === 3000)
    const r1 = await reconciliationPOST(adminPost('/api/admin/affiliates/reconciliation',
      { disputeId: first.disputeId, merchandiseCents: 2000, shippingCents: 1000, taxCents: 0 }))
    expect(r1.status).toBe(200)

    rows = (await svc().listIncomplete()).filter((x: any) => x.commissionId === commissionId)
    expect(rows).toHaveLength(1)                                  // the other remains
    expect(rows[0].disputedAmountCents).toBe(2000)
    expect((await raw(`SELECT incomplete FROM affiliate_commissions WHERE id=$1`,
      [commissionId]))[0]).toMatchObject({ incomplete: true })

    // Resolve the second.
    const r2 = await reconciliationPOST(adminPost('/api/admin/affiliates/reconciliation',
      { disputeId: rows[0].disputeId, merchandiseCents: 1500, shippingCents: 500, taxCents: 0 }))
    expect(r2.status).toBe(200)
    expect((await raw(`SELECT incomplete FROM affiliate_commissions WHERE id=$1`,
      [commissionId]))[0]).toMatchObject({ incomplete: false })
  })

  test('D a refund blocker is never presented as a dispute decomposition', async () => {
    const aff = await makeAffiliate('B1MIX', 1000)
    const { orderId, pi, charge, commissionId, n } = await commissionFor(aff, 'B1MIX')

    // Unresolved refund.
    await raw(
      `INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,
         stripe_payment_intent_id,amount_cents,status,refunded_at)
       VALUES ($1,$2,$3,$4,$5,2000,'succeeded',NOW())`,
      [uid(), orderId, `re_${n}`, charge, pi])
    await raw(`SELECT apply_affiliate_refund_reversal(
      (SELECT id FROM order_refunds WHERE order_id=$1),'test')`, [orderId])
    // Plus an unresolved partial dispute.
    await raw(`SELECT upsert_order_dispute($1,$2,$3,3000,'usd','lost','lost',$4,
      'charge.dispute.closed',NOW(),NULL,'{}'::jsonb)`,
      [`dm_${n}`, charge, pi, `ev_${n}`])
    const d = await raw(`SELECT id FROM order_disputes WHERE stripe_dispute_id=$1`, [`dm_${n}`])
    await raw(`SELECT sync_affiliate_dispute_state($1,NULL,'test')`, [(d[0] as any).id])

    const rows = (await svc().listIncomplete()).filter((x: any) => x.commissionId === commissionId)
    expect(rows).toHaveLength(2)
    const refundRow  = rows.find((r: any) => r.sourceKind === 'refund')
    const disputeRow = rows.find((r: any) => r.sourceKind === 'dispute')
    expect(refundRow.refundId).toBeTruthy()
    expect(refundRow.disputeId).toBeNull()
    expect(refundRow.canResolveHere).toBe(false)      // belongs to Returns
    expect(disputeRow.disputeId).toBeTruthy()
    expect(disputeRow.canResolveHere).toBe(true)

    // Resolving the dispute leaves the refund blocker in place.
    await reconciliationPOST(adminPost('/api/admin/affiliates/reconciliation',
      { disputeId: disputeRow.disputeId, merchandiseCents: 2000, shippingCents: 1000, taxCents: 0 }))
    const after = (await svc().listIncomplete()).filter((x: any) => x.commissionId === commissionId)
    expect(after).toHaveLength(1)
    expect(after[0].sourceKind).toBe('refund')
  })

  test('E the reconciliation route rejects the removed identifier', async () => {
    const res = await reconciliationPOST(adminPost('/api/admin/affiliates/reconciliation',
      { disputeAdjustmentId: uid(), merchandiseCents: 1, shippingCents: 0, taxCents: 0 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/valid dispute is required/i)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// FINAL3-A — BLOCKER 5: payout + recovery lifecycle through real API/service
// ═════════════════════════════════════════════════════════════════════════════

describe('Blocker 5 — payout and recovery operate through the application', () => {
  const svc = () => require('../affiliates').createAffiliatesService(pgSqlWithFaults)

  const auditCount = async (action: string, resourceId: string) => {
    const r = await raw(
      `SELECT COUNT(*)::int AS n FROM admin_audit_logs WHERE action=$1 AND resource_id=$2`,
      [action, resourceId])
    return Number((r[0] as any).n)
  }

  test('A-F full lifecycle: draft, paid, reversal, recovery, restore, second payout',
    async () => {
    const aff = await makeAffiliate('B5LIFE', 1000)
    const { orderId, pi, charge, commissionId, n } = await commissionFor(aff, 'B5LIFE')
    await raw(`SELECT refresh_affiliate_commission_state($1)`, [commissionId])

    // ── A. CREATE DRAFT through the real service ────────────────────────────
    const draft1 = await svc().createPayout(aff, [commissionId], 'admin@kvrn.test')
    expect(draft1.outcome).toBe('created')
    expect(Number(draft1.amount_cents)).toBe(1000)
    expect(await auditCount('create', draft1.payout_id)).toBe(1)   // exactly once
    // The draft RESERVES payable, so nothing further is payable.
    expect(Number((await raw(`SELECT affiliate_commission_payable($1) AS p`,
      [commissionId]))[0].p)).toBe(0)

    // ── B. MARK PAID through the real API ───────────────────────────────────
    const paidRes = await payoutsPOST(adminPost('/api/admin/affiliates/payouts',
      { kind: 'mark_paid', payoutId: draft1.payout_id, paidAt: '2026-09-01',
        method: 'ach', reference: 'PAY-1' }))
    expect(paidRes.status).toBe(200)
    expect((await paidRes.json()).result.outcome).toBe('paid')
    expect(await auditCount('mark_paid', draft1.payout_id)).toBe(1)
    const p1 = await raw(`SELECT status, paid_at, reference FROM affiliate_payouts WHERE id=$1`,
      [draft1.payout_id])
    expect((p1[0] as any).status).toBe('paid')
    expect((p1[0] as any).reference).toBe('PAY-1')
    // Retry is safe.
    const again = await payoutsPOST(adminPost('/api/admin/affiliates/payouts',
      { kind: 'mark_paid', payoutId: draft1.payout_id }))
    expect((await again.json()).result.outcome).toBe('already_paid')
    expect(await auditCount('mark_paid', draft1.payout_id)).toBe(1)   // still once

    // ── C. VOID a paid payout must fail cleanly ─────────────────────────────
    const badVoid = await payoutsPOST(adminPost('/api/admin/affiliates/payouts',
      { kind: 'void', payoutId: draft1.payout_id, reason: 'nope' }))
    expect(badVoid.status).toBe(409)
    expect((await badVoid.json()).error).toMatch(/already been paid/i)

    // ── D. Reversal after payment creates an overpayment ────────────────────
    await raw(
      `INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,
         stripe_payment_intent_id,amount_cents,merchandise_refund_cents,shipping_refund_cents,
         tax_refund_cents,component_breakdown_status,status,refunded_at)
       VALUES ($1,$2,$3,$4,$5,4000,4000,0,0,'resolved','succeeded',NOW())`,
      [uid(), orderId, `re5_${n}`, charge, pi])
    await raw(`SELECT apply_affiliate_refund_reversal(
      (SELECT id FROM order_refunds WHERE order_id=$1),'test')`, [orderId])

    let state = await svc().getRecoveryState(commissionId)
    expect(state.outstandingCents).toBe(400)     // paid 1000, ledger now 600
    expect(state.collectedCents).toBe(0)
    expect(state.payableCents).toBe(0)

    // A pending marker is NOT cash.
    const rec = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries',
      { action: 'record', commissionId, amountCents: 400, notes: 'owed',
        idempotencyKey: 'A-F-marker' }))
    expect(rec.status).toBe(201)
    state = await svc().getRecoveryState(commissionId)
    expect(state.recordedOwedCents).toBe(400)
    expect(state.collectedCents).toBe(0)
    expect(state.outstandingCents).toBe(400)     // unchanged by a marker

    // ── E. PARTIAL collection through the real API ──────────────────────────
    const c1 = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries',
      { action: 'collect', commissionId, amountCents: 150,
        effectiveAt: '2026-09-02', method: 'ach', reference: 'REC-1',
        idempotencyKey: 'A-F-c1' }))
    expect(c1.status).toBe(200)
    expect((await svc().getRecoveryState(commissionId)).outstandingCents).toBe(250)

    const c2 = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries',
      { action: 'collect', commissionId, amountCents: 250, effectiveAt: '2026-09-03',
        idempotencyKey: 'A-F-c2' }))
    expect(c2.status).toBe(200)
    state = await svc().getRecoveryState(commissionId)
    expect(state.outstandingCents).toBe(0)
    expect(state.collectedCents).toBe(400)

    // Over-collection refused.
    const over = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries',
      { action: 'collect', commissionId, amountCents: 1, idempotencyKey: 'A-F-c3' }))
    expect(over.status).toBe(409)
    expect((await over.json()).error).toMatch(/exceeds the outstanding/i)

    // Collecting cash must NOT move the economics a second time.
    const ledger = await raw(
      `SELECT COALESCE(SUM(adjustment_cents),0)::int AS net FROM affiliate_commission_adjustments
       WHERE commission_id=$1`, [commissionId])
    expect(Number((ledger[0] as any).net)).toBe(600)

    // ── F. Restoration is proven exactly, with numbers, in the Blocker 3
    // lifecycle test below. A refund reversal is deliberately NOT used there,
    // because a dispute win does not undo a refund.
    expect((await svc().getRecoveryState(commissionId)).collectedCents).toBe(400)
  })

  test('C void releases the payable reservation and is idempotent', async () => {
    const aff = await makeAffiliate('B5VOID', 1000)
    const { commissionId } = await commissionFor(aff, 'B5VOID')
    await raw(`SELECT refresh_affiliate_commission_state($1)`, [commissionId])

    const draft = await svc().createPayout(aff, [commissionId], 'admin@kvrn.test')
    expect(Number(draft.amount_cents)).toBe(1000)
    expect(Number((await raw(`SELECT affiliate_commission_payable($1) AS p`,
      [commissionId]))[0].p)).toBe(0)              // reserved

    const v1 = await payoutsPOST(adminPost('/api/admin/affiliates/payouts',
      { kind: 'void', payoutId: draft.payout_id, reason: 'created in error' }))
    expect(v1.status).toBe(200)
    expect((await v1.json()).result.outcome).toBe('voided')
    expect(Number((await raw(`SELECT affiliate_commission_payable($1) AS p`,
      [commissionId]))[0].p)).toBe(1000)           // released immediately
    expect(await auditCount('void', draft.payout_id)).toBe(1)

    const v2 = await payoutsPOST(adminPost('/api/admin/affiliates/payouts',
      { kind: 'void', payoutId: draft.payout_id, reason: 'again' }))
    expect((await v2.json()).result.outcome).toBe('already_void')
    expect(await auditCount('void', draft.payout_id)).toBe(1)   // no second audit

    // Payable again, so a fresh draft can be created.
    const draft2 = await svc().createPayout(aff, [commissionId], 'admin@kvrn.test')
    expect(Number(draft2.amount_cents)).toBe(1000)
  })

  test('the recoveries GET surfaces owed and collected separately', async () => {
    const res = await recoveriesGET(adminPost('/api/admin/affiliates/recoveries', {}))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.recoveries)).toBe(true)
    for (const r of body.recoveries) {
      expect(r).toHaveProperty('outstandingCents')
      expect(r).toHaveProperty('collectedCents')
      expect(r).toHaveProperty('recordedOwedCents')
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// FINAL5 — recovery idempotency compares the full payload, through the real API
// ═════════════════════════════════════════════════════════════════════════════
//
// Proves the ROUTE WIRING, not just the SQL function: body.notes and
// body.effectiveAt must actually reach record_affiliate_payout_recovery /
// collect_affiliate_recovery as p_notes and p_request_date, all the way
// through app/api/admin/affiliates/recoveries/route.ts and lib/affiliates.ts.
// The SQL function itself is exhaustively proven by db/fixtures/final5.sql.

describe('Final5 — recovery idempotency is full-payload through the real API', () => {
  test('collect: an identical retry is a no-op; a changed field is refused', async () => {
    const aff = await makeAffiliate('F5COLLECT', 1000)
    const { orderId, pi, charge, commissionId, n } = await commissionFor(aff, 'F5COLLECT')
    await raw(`SELECT refresh_affiliate_commission_state($1)`, [commissionId])
    await recoveryDraftPaid(aff, commissionId)
    await raw(
      `INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,
         stripe_payment_intent_id,amount_cents,merchandise_refund_cents,shipping_refund_cents,
         tax_refund_cents,component_breakdown_status,status,refunded_at)
       VALUES ($1,$2,$3,$4,$5,4000,4000,0,0,'resolved','succeeded',NOW())`,
      [uid(), orderId, `f5re_${n}`, charge, pi])
    await raw(`SELECT apply_affiliate_refund_reversal(
      (SELECT id FROM order_refunds WHERE order_id=$1),'test')`, [orderId])
    // paid 1000, ledger now 600 -> outstanding 400.

    const body = { action: 'collect', commissionId, amountCents: 150,
      effectiveAt: '2026-09-10', method: 'ach', reference: 'F5-REF-1',
      notes: 'first attempt', idempotencyKey: 'F5-COL-HTTP-1' }

    const first = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries', body))
    expect(first.status).toBe(200)
    expect((await first.json()).result.outcome).toBe('collected')

    // Identical retry: the full request repeated verbatim.
    const retry = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries', body))
    expect(retry.status).toBe(200)
    expect((await retry.json()).result.outcome).toBe('already_collected')

    // Same key, changed notes only: refused, nothing mutated.
    const changedNotes = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries',
      { ...body, notes: 'a completely different note' }))
    expect(changedNotes.status).toBe(409)
    expect((await changedNotes.json()).error).toMatch(/already used/i)

    // Same key, changed date only: refused.
    const changedDate = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries',
      { ...body, effectiveAt: '2026-09-11' }))
    expect(changedDate.status).toBe(409)

    // Exactly one row exists for this key — every conflict above mutated nothing.
    const rows = await raw(
      `SELECT COUNT(*)::int AS n FROM affiliate_commission_adjustments
       WHERE commission_id=$1 AND recovery_idempotency_key=$2`,
      [commissionId, 'F5-COL-HTTP-1'])
    expect(Number((rows[0] as any).n)).toBe(1)
  })

  test('a record-marker key can never be reused for a collect, even at the same amount', async () => {
    const aff = await makeAffiliate('F5CROSS', 1000)
    const { orderId, pi, charge, commissionId, n } = await commissionFor(aff, 'F5CROSS')
    await raw(`SELECT refresh_affiliate_commission_state($1)`, [commissionId])
    await recoveryDraftPaid(aff, commissionId)
    await raw(
      `INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,
         stripe_payment_intent_id,amount_cents,merchandise_refund_cents,shipping_refund_cents,
         tax_refund_cents,component_breakdown_status,status,refunded_at)
       VALUES ($1,$2,$3,$4,$5,4000,4000,0,0,'resolved','succeeded',NOW())`,
      [uid(), orderId, `f5rex_${n}`, charge, pi])
    await raw(`SELECT apply_affiliate_refund_reversal(
      (SELECT id FROM order_refunds WHERE order_id=$1),'test')`, [orderId])

    const marker = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries',
      { action: 'record', commissionId, amountCents: 200, notes: 'owed',
        idempotencyKey: 'F5-CROSS-1' }))
    expect(marker.status).toBe(201)

    // The SAME key, same amount, now used for a CASH COLLECTION: refused.
    const crossed = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries',
      { action: 'collect', commissionId, amountCents: 200,
        idempotencyKey: 'F5-CROSS-1' }))
    expect(crossed.status).toBe(409)

    const rows = await raw(
      `SELECT recovery_status FROM affiliate_commission_adjustments
       WHERE commission_id=$1 AND recovery_idempotency_key=$2`,
      [commissionId, 'F5-CROSS-1'])
    expect(rows).toHaveLength(1)                       // still just the marker
    expect((rows[0] as any).recovery_status).toBe('pending')
  })
})

/** Draft-then-pay a commission's full payout, through the real service. */
async function recoveryDraftPaid(affiliateId: string, commissionId: string) {
  const svc = require('../affiliates').createAffiliatesService(pgSqlWithFaults)
  const draft = await svc.createPayout(affiliateId, [commissionId], 'admin@kvrn.test')
  await svc.markPayoutPaid(draft.payout_id, null, 'ach', 'F5-INIT', 'admin@kvrn.test')
  return draft
}

// ═════════════════════════════════════════════════════════════════════════════
// FINAL3-B — BLOCKER 2: durable referral ingestion, real /r route
// ═════════════════════════════════════════════════════════════════════════════

describe('Blocker 2 — a valid referral is never silently lost', () => {

  test('A success: durable session + click, cookie matches exactly', async () => {
    const aff = await makeAffiliate('B2OK', 1000)
    await makeLink(aff, 'b2-ok', '/shop')
    const res = await callReferral('b2-ok')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://kvrn.shop/shop')
    const sid = cookieFrom(res)!
    expect(await raw(`SELECT session_id FROM analytics_sessions WHERE session_id=$1`, [sid]))
      .toHaveLength(1)
    const clicks = await raw(
      `SELECT affiliate_id FROM affiliate_clicks WHERE session_id=$1`, [sid])
    expect(clicks).toHaveLength(1)
    expect((clicks[0] as any).affiliate_id).toBe(aff)
  })

  test('B forced persistence failure returns retryable, not false success', async () => {
    const aff = await makeAffiliate('B2FAIL', 1000)
    await makeLink(aff, 'b2-fail')

    failNextMatching(/INSERT INTO affiliate_clicks/, false)
    const res = await callReferral('b2-fail')
    clearFailures()

    // No false-success redirect, and no cookie implying capture succeeded.
    expect(res.status).toBe(503)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('location')).toBeNull()

    // Nothing half-written.
    expect(await raw(
      `SELECT c.id FROM affiliate_clicks c JOIN affiliate_links l ON l.id=c.link_id
       WHERE l.slug='b2-fail'`)).toHaveLength(0)
  })

  test('C retry after the failure succeeds and is durable', async () => {
    const aff = await makeAffiliate('B2RETRY', 1000)
    await makeLink(aff, 'b2-retry')

    failNextMatching(/INSERT INTO affiliate_clicks/, true)   // fail once
    expect((await callReferral('b2-retry')).status).toBe(503)

    const good = await callReferral('b2-retry')
    expect(good.status).toBe(302)
    const sid = cookieFrom(good)!
    // Exactly one click, from the successful retry. No conflicting identities.
    expect(await raw(`SELECT id FROM affiliate_clicks WHERE session_id=$1`, [sid]))
      .toHaveLength(1)
    expect(await raw(`SELECT id FROM analytics_sessions WHERE session_id=$1`, [sid]))
      .toHaveLength(1)
  })

  test('D an existing cookie is reused and the new click is durable', async () => {
    const aff = await makeAffiliate('B2REUSE', 1000)
    await makeLink(aff, 'b2-reuse')
    const sid = cookieFrom(await callReferral('b2-reuse'))!

    const second = await callReferral('b2-reuse', { cookie: sid })
    expect(second.status).toBe(302)
    expect(second.headers.get('set-cookie')).toBeNull()   // reused, not reissued
    expect(await raw(`SELECT id FROM affiliate_clicks WHERE session_id=$1`, [sid]))
      .toHaveLength(2)
    expect(await raw(`SELECT id FROM analytics_sessions WHERE session_id=$1`, [sid]))
      .toHaveLength(1)
  })

  test('E unknown and inactive slugs fall back safely, fabricating nothing', async () => {
    const unknown = await callReferral('b2-nonexistent')
    expect(unknown.status).toBe(302)
    expect(unknown.headers.get('location')).toBe('https://kvrn.shop/')
    expect(unknown.headers.get('set-cookie')).toBeNull()

    const aff = await makeAffiliate('B2INACT', 1000)
    await makeLink(aff, 'b2-inactive')
    await raw(`UPDATE affiliate_links SET active=false WHERE slug='b2-inactive'`)
    const inactive = await callReferral('b2-inactive')
    expect(inactive.status).toBe(302)
    expect(inactive.headers.get('location')).toBe('https://kvrn.shop/')
    expect(await raw(
      `SELECT c.id FROM affiliate_clicks c JOIN affiliate_links l ON l.id=c.link_id
       WHERE l.slug='b2-inactive'`)).toHaveLength(0)
  })

  test('F a failed capture leaves no ghost cookie to masquerade as a referral',
    async () => {
    const aff = await makeAffiliate('B2GHOST', 1000)
    await makeLink(aff, 'b2-ghost')
    failNextMatching(/INSERT INTO affiliate_clicks/, false)
    const res = await callReferral('b2-ghost')
    clearFailures()
    expect(res.status).toBe(503)
    expect(cookieFrom(res)).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// FINAL3-B — BLOCKER 3: fail-closed checkout releases reservation + claim
// ═════════════════════════════════════════════════════════════════════════════

describe('Blocker 3 — fail-closed checkout does not strand state', () => {
  let checkoutPOST: any
  const reserveInventory = jest.fn()
  const saveReservationCheckoutDetails = jest.fn()
  const attachStripeSession = jest.fn()
  const failReservation = jest.fn()
  const releaseDiscountClaim = jest.fn()

  beforeAll(async () => {
    jest.resetModules()
    // Only the discount claim-release boundary is observed, so cleanup can be
    // asserted by call rather than inferred.
    jest.doMock('../discounts', () => ({
      ...jest.requireActual('../discounts'),
      releaseDiscountClaim,
    }))
    const { createCheckoutPostHandler } = await import('../checkout-session-handler')
    checkoutPOST = createCheckoutPostHandler({
      isCheckoutEnabled: () => true,
      getSiteOrigin: () => 'https://kvrn.shop',
      getStripe: () => ({ checkout: { sessions: { create: stripeCreate } } }) as any,
      reserveInventory,
      saveReservationCheckoutDetails,
      failReservation,
      attachStripeSession,
      releaseExpiredReservations: jest.fn(),
    } as any)
  })
  afterAll(() => { jest.dontMock('../discounts'); jest.resetModules() })

  let reservationId: string

  beforeEach(async () => {
    process.env.ENABLE_STRIPE_TEST_CHECKOUT = 'true'
    process.env.SHIPPO_API_TOKEN = 'shippo_test_token'
    failReservation.mockReset().mockResolvedValue('released')
    releaseDiscountClaim.mockReset().mockResolvedValue(undefined)
    reservationId = uid()
    reserveInventory.mockResolvedValue({
      ok: true, reservationId,
      items: [{ sku: 'KVRN-B3-M', variantId: uid(), quantity: 1, unitPriceCents: 10000,
                name: 'B3 Tee', size: 'M', colorName: 'Black' }],
      subtotalCents: 10000, expiresAt: new Date(Date.now() + 9e5).toISOString(),
    })
    saveReservationCheckoutDetails.mockResolvedValue({ ok: true })
    attachStripeSession.mockResolvedValue({ ok: true })
    stripeCreate.mockReset().mockResolvedValue({ id: 'cs_b3', url: 'https://stripe.test/pay' })
    await raw(`INSERT INTO reservations (id, expires_at) VALUES ($1, NOW() + INTERVAL '15 minutes')
               ON CONFLICT (id) DO NOTHING`, [reservationId])
  })

  function checkoutRequest(cookie: string | null) {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (cookie) headers.set('cookie', `kvrn_sid=${cookie}`)
    const req: any = new Request('https://kvrn.shop/api/checkout/session', {
      method: 'POST', headers,
      body: JSON.stringify({
        items: [{ sku: 'KVRN-B3-M', quantity: 1 }],
        email: 'b3@example.com',
        shippingAddress: { firstName: 'B', lastName: 'Three', line1: '1 Test St',
                           city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
        shippingMethod: 'standard',
      }),
    })
    req.nextUrl = new URL('https://kvrn.shop/api/checkout/session')
    req.cookies = { get: (n: string) => (cookie && n === 'kvrn_sid' ? { value: cookie } : undefined) }
    return req
  }

  async function realReferralCookie(code: string, slug: string) {
    const aff = await makeAffiliate(code, 1000)
    await makeLink(aff, slug)
    return cookieFrom(await callReferral(slug))!
  }

  test('A forced persist failure: Stripe not called, reservation and claim released',
    async () => {
    const sid = await realReferralCookie('B3A', 'b3-a')
    failNextMatching(/persist_checkout_affiliate_session/)

    const res = await checkoutPOST(checkoutRequest(sid))
    expect(res.status).toBe(503)
    expect(stripeCreate).toHaveBeenCalledTimes(0)
    // Canonical helpers, not bespoke route logic.
    expect(releaseDiscountClaim).toHaveBeenCalledWith(reservationId)
    expect(failReservation).toHaveBeenCalledWith(
      reservationId, 'affiliate_session_persist_failed')
  })

  test('B an immediate retry succeeds exactly once', async () => {
    const sid = await realReferralCookie('B3B', 'b3-b')
    failNextMatching(/persist_checkout_affiliate_session/)   // one-shot
    const bad = await checkoutPOST(checkoutRequest(sid))
    expect(bad.status).toBe(503)
    expect(stripeCreate).toHaveBeenCalledTimes(0)

    // Persistence is now healthy again.
    clearFailures()

    // Healthy retry: a NEW reservation, as the previous one was released.
    reservationId = uid()
    reserveInventory.mockResolvedValue({
      ok: true, reservationId,
      items: [{ sku: 'KVRN-B3-M', variantId: uid(), quantity: 1, unitPriceCents: 10000,
                name: 'B3 Tee', size: 'M', colorName: 'Black' }],
      subtotalCents: 10000, expiresAt: new Date(Date.now() + 9e5).toISOString(),
    })
    await raw(`INSERT INTO reservations (id, expires_at) VALUES ($1, NOW() + INTERVAL '15 minutes')
               ON CONFLICT (id) DO NOTHING`, [reservationId])

    const good = await checkoutPOST(checkoutRequest(sid))
    expect(good.status).toBe(200)
    expect(stripeCreate).toHaveBeenCalledTimes(1)
    expect(stripeCreate.mock.calls[0][0].client_reference_id).toBe(sid)
    // The referral identity was durably recorded on the new reservation.
    const snap = await raw(
      `SELECT attribution->>'kvrn_sid' AS sid FROM reservations WHERE id=$1`, [reservationId])
    expect((snap[0] as any)?.sid).toBe(sid)
  })

  test('C cleanup runs even when no discount claim exists', async () => {
    const sid = await realReferralCookie('B3C', 'b3-c')
    failNextMatching(/persist_checkout_affiliate_session/)

    const res = await checkoutPOST(checkoutRequest(sid))
    expect(res.status).toBe(503)
    expect(failReservation).toHaveBeenCalledWith(
      reservationId, 'affiliate_session_persist_failed')
    expect(stripeCreate).toHaveBeenCalledTimes(0)
  })

  test('D a failing cleanup helper does not prevent the other, nor call Stripe',
    async () => {
    const sid = await realReferralCookie('B3D', 'b3-d')
    releaseDiscountClaim.mockRejectedValue(new Error('claim release exploded'))
    failNextMatching(/persist_checkout_affiliate_session/)

    const res = await checkoutPOST(checkoutRequest(sid))
    expect(res.status).toBe(503)
    // The discount release threw, yet the reservation was still released.
    expect(releaseDiscountClaim).toHaveBeenCalledTimes(1)
    expect(failReservation).toHaveBeenCalledWith(
      reservationId, 'affiliate_session_persist_failed')
    expect(stripeCreate).toHaveBeenCalledTimes(0)
  })

  test('E checkout with no referral is completely unaffected', async () => {
    const res = await checkoutPOST(checkoutRequest(null))
    expect(res.status).toBe(200)
    expect(stripeCreate).toHaveBeenCalledTimes(1)
    expect(failReservation).not.toHaveBeenCalled()
    expect(releaseDiscountClaim).not.toHaveBeenCalled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// FINAL4 — recovery idempotency, marker bounds, restore lifecycle, reporting
// ═════════════════════════════════════════════════════════════════════════════

const svcF4 = () => require('../affiliates').createAffiliatesService(pgSqlWithFaults)

/** Paid commission of `commissionCents`, already paid out in full. */
async function paidCommission(code: string, subtotal = 10000) {
  const aff = await makeAffiliate(code, 1000)
  const orderId = uid(); const n = `F4-${++seq}`
  await raw(
    `INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,
       payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,
       total_cents,paid_at,discount_code)
     VALUES ($1,$2,$3,$4,'paid','usd',$5,0,0,0,$5,NOW()-INTERVAL '2 days',$6)`,
    [orderId, n, `cs_${n}`, `pi_${n}`, subtotal, code])
  await raw(`SELECT resolve_order_affiliate_attribution($1,NULL,'test')`, [orderId])
  const cid = ((await raw(`SELECT id FROM affiliate_commissions WHERE order_id=$1`,
    [orderId]))[0] as any).id
  await raw(`SELECT refresh_affiliate_commission_state($1)`, [cid])
  const payout = await svcF4().createPayout(aff, [cid], 'admin@kvrn.test')
  await raw(`SELECT mark_affiliate_payout_paid($1,NOW(),'ach','p1','admin')`,
    [payout.payout_id])
  return { aff, orderId, cid, n, payoutId: payout.payout_id,
           pi: `pi_${n}`, charge: `ch_${n}` }
}

describe('Blocker 1 — recovery collection is idempotent', () => {

  test('1..7 the full mandated sequence', async () => {
    const c = await paidCommission('F4IDEM')
    // Reversal of 4000 merchandise creates a 400 overpayment.
    await raw(
      `INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,
         stripe_payment_intent_id,amount_cents,merchandise_refund_cents,shipping_refund_cents,
         tax_refund_cents,component_breakdown_status,status,refunded_at)
       VALUES ($1,$2,$3,$4,$5,4000,4000,0,0,'resolved','succeeded',NOW())`,
      [uid(), c.orderId, `re_${c.n}`, c.charge, c.pi])
    await raw(`SELECT apply_affiliate_refund_reversal(
      (SELECT id FROM order_refunds WHERE order_id=$1),'test')`, [c.orderId])
    expect((await svcF4().getRecoveryState(c.cid)).outstandingCents).toBe(400)

    const post = (body: any) => recoveriesPOST(adminPost(
      '/api/admin/affiliates/recoveries', body))

    // 1. collect 150 with K1
    const r1 = await post({ action: 'collect', commissionId: c.cid,
                            amountCents: 150, idempotencyKey: 'K1' })
    expect(r1.status).toBe(200)
    expect((await r1.json()).result.outcome).toBe('collected')
    expect((await svcF4().getRecoveryState(c.cid)).collectedCents).toBe(150)

    // 2. exact retry of K1 -> no-op
    const r2 = await post({ action: 'collect', commissionId: c.cid,
                            amountCents: 150, idempotencyKey: 'K1' })
    expect(r2.status).toBe(200)
    expect((await r2.json()).result.outcome).toBe('already_collected')
    const afterRetry = await svcF4().getRecoveryState(c.cid)
    expect(afterRetry.collectedCents).toBe(150)      // NOT 300
    expect(afterRetry.outstandingCents).toBe(250)
    // No second audit for the same operation.
    const audits = await raw(
      `SELECT COUNT(*)::int AS n FROM admin_audit_logs
       WHERE action='collect_recovery' AND resource_id=$1`, [c.cid])
    expect(Number((audits[0] as any).n)).toBe(1)

    // 3. same K1 with a different amount -> 409, nothing mutated
    const r3 = await post({ action: 'collect', commissionId: c.cid,
                            amountCents: 151, idempotencyKey: 'K1' })
    expect(r3.status).toBe(409)
    expect((await svcF4().getRecoveryState(c.cid)).collectedCents).toBe(150)

    // 4. a NEW key is a genuinely separate collection
    const r4 = await post({ action: 'collect', commissionId: c.cid,
                            amountCents: 250, idempotencyKey: 'K2' })
    expect(r4.status).toBe(200)

    // 5. outstanding is now zero
    const done = await svcF4().getRecoveryState(c.cid)
    expect(done.outstandingCents).toBe(0)
    expect(done.collectedCents).toBe(400)

    // 6. a further collection, even with a new key, exceeds outstanding
    const r6 = await post({ action: 'collect', commissionId: c.cid,
                            amountCents: 1, idempotencyKey: 'K3' })
    expect(r6.status).toBe(409)
    expect((await r6.json()).error).toMatch(/exceeds the outstanding/i)

    // 7. recovery cash NEVER moved commission economics
    const ledger = await raw(
      `SELECT COALESCE(SUM(adjustment_cents),0)::int AS net
       FROM affiliate_commission_adjustments WHERE commission_id=$1`, [c.cid])
    expect(Number((ledger[0] as any).net)).toBe(600)
  })

  test('a missing idempotency key is refused', async () => {
    const c = await paidCommission('F4NOKEY')
    const res = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries',
      { action: 'collect', commissionId: c.cid, amountCents: 1 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/idempotency key is required/i)
  })
})

describe('Blocker 2 — the recovery marker is bounded and idempotent', () => {

  test('A the marker cannot exceed derived outstanding', async () => {
    const c = await paidCommission('F4MARK')
    await raw(
      `INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,
         stripe_payment_intent_id,amount_cents,merchandise_refund_cents,shipping_refund_cents,
         tax_refund_cents,component_breakdown_status,status,refunded_at)
       VALUES ($1,$2,$3,$4,$5,4000,4000,0,0,'resolved','succeeded',NOW())`,
      [uid(), c.orderId, `re_${c.n}`, c.charge, c.pi])
    await raw(`SELECT apply_affiliate_refund_reversal(
      (SELECT id FROM order_refunds WHERE order_id=$1),'test')`, [c.orderId])

    const over = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries',
      { action: 'record', commissionId: c.cid, amountCents: 10000,
        idempotencyKey: 'M-over' }))
    expect(over.status).toBe(409)     // outstanding is only 400

    const ok = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries',
      { action: 'record', commissionId: c.cid, amountCents: 400,
        idempotencyKey: 'M1' }))
    expect(ok.status).toBe(201)
    const st = await svcF4().getRecoveryState(c.cid)
    expect(st.recordedOwedCents).toBe(400)
    expect(st.collectedCents).toBe(0)        // a marker is NOT cash
    expect(st.outstandingCents).toBe(400)    // and does not reduce outstanding
  })

  test('B marker retry is idempotent; a conflicting key fails closed', async () => {
    const c = await paidCommission('F4MARK2')
    await raw(
      `INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,
         stripe_payment_intent_id,amount_cents,merchandise_refund_cents,shipping_refund_cents,
         tax_refund_cents,component_breakdown_status,status,refunded_at)
       VALUES ($1,$2,$3,$4,$5,4000,4000,0,0,'resolved','succeeded',NOW())`,
      [uid(), c.orderId, `re_${c.n}`, c.charge, c.pi])
    await raw(`SELECT apply_affiliate_refund_reversal(
      (SELECT id FROM order_refunds WHERE order_id=$1),'test')`, [c.orderId])

    const post = (b: any) => recoveriesPOST(adminPost('/api/admin/affiliates/recoveries', b))
    expect((await post({ action: 'record', commissionId: c.cid, amountCents: 200,
                         idempotencyKey: 'MK' })).status).toBe(201)
    const retry = await post({ action: 'record', commissionId: c.cid, amountCents: 200,
                               idempotencyKey: 'MK' })
    expect((await retry.json()).result.outcome).toBe('already_recorded')
    expect((await svcF4().getRecoveryState(c.cid)).recordedOwedCents).toBe(200)

    const conflict = await post({ action: 'record', commissionId: c.cid, amountCents: 300,
                                  idempotencyKey: 'MK' })
    expect(conflict.status).toBe(409)
    expect((await svcF4().getRecoveryState(c.cid)).recordedOwedCents).toBe(200)
  })

  test('C the merchandise snapshot uses CURRENT state, not effective_at ordering',
    async () => {
    const c = await paidCommission('F4SNAP')
    // A dispute lost, claiming 4000 merchandise, EFFECTIVE IN THE FUTURE relative
    // to a later-known backdated event. Ordering by effective_at would pick the
    // wrong row; the derived position must not care.
    await raw(`SELECT upsert_order_dispute($1,$2,$3,10000,'usd','lost','lost',$4,
      'charge.dispute.closed',NOW(),NULL,'{}'::jsonb)`,
      [`ds_${c.n}`, c.charge, c.pi, `ev_${c.n}`])
    const d = (await raw(`SELECT id FROM order_disputes WHERE stripe_dispute_id=$1`,
      [`ds_${c.n}`]))[0] as any
    await raw(`SELECT sync_affiliate_dispute_state($1,NULL,'test')`, [d.id])

    // A BACKDATED refund: economically earlier, processed later.
    await raw(
      `INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,
         stripe_payment_intent_id,amount_cents,merchandise_refund_cents,shipping_refund_cents,
         tax_refund_cents,component_breakdown_status,status,refunded_at)
       VALUES ($1,$2,$3,$4,$5,1000,1000,0,0,'resolved','succeeded',NOW()-INTERVAL '30 days')`,
      [uid(), c.orderId, `reb_${c.n}`, c.charge, c.pi])
    await raw(`SELECT apply_affiliate_refund_reversal(
      (SELECT id FROM order_refunds WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1),'test')`,
      [c.orderId])

    const derived = Number((await raw(
      `SELECT affiliate_outstanding_merchandise($1) AS m`, [c.cid]))[0].m)

    const outstanding = (await svcF4().getRecoveryState(c.cid)).outstandingCents
    if (outstanding > 0) {
      const res = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries',
        { action: 'record', commissionId: c.cid, amountCents: outstanding,
          idempotencyKey: 'SNAP1' }))
      expect(res.status).toBe(201)
      const body = await res.json()
      // The snapshot equals the CURRENT derived position.
      expect(Number(body.result.merchandise_snapshot)).toBe(derived)
      const row = await raw(
        `SELECT cumulative_merchandise_reversed_after AS m
         FROM affiliate_commission_adjustments
         WHERE commission_id=$1 AND recovery_idempotency_key='SNAP1'`, [c.cid])
      expect(Number((row[0] as any).m)).toBe(derived)
    }
  })
})

describe('Blocker 3 — restore then second payout, the real lifecycle', () => {

  test('accrual 1000 -> paid -> dispute lost -400 -> collect 400 -> won +400 '
     + '-> payable 400 -> second payout 400', async () => {
    const c = await paidCommission('F4LIFE')

    // accrual and first payout
    expect(Number((await raw(
      `SELECT COALESCE(SUM(adjustment_cents),0)::int AS n
       FROM affiliate_commission_adjustments WHERE commission_id=$1`, [c.cid]))[0].n)).toBe(1000)
    expect(Number((await raw(
      `SELECT amount_cents FROM affiliate_payouts WHERE id=$1`, [c.payoutId]))[0].amount_cents))
      .toBe(1000)

    // ── LOST dispute with an authoritative merchandise claim of 4000 ────────
    await raw(`SELECT upsert_order_dispute($1,$2,$3,6000,'usd','lost','lost',$4,
      'charge.dispute.closed',NOW(),NULL,'{}'::jsonb)`,
      [`dl_${c.n}`, c.charge, c.pi, `evl_${c.n}`])
    const d = (await raw(`SELECT id FROM order_disputes WHERE stripe_dispute_id=$1`,
      [`dl_${c.n}`]))[0] as any
    const resolved = await reconciliationPOST(adminPost(
      '/api/admin/affiliates/reconciliation',
      { disputeId: d.id, merchandiseCents: 4000, shippingCents: 2000, taxCents: 0 }))
    expect(resolved.status).toBe(200)

    // reversal -400, ledger 600, overpayment 400
    expect(Number((await raw(
      `SELECT COALESCE(SUM(adjustment_cents),0)::int AS n
       FROM affiliate_commission_adjustments WHERE commission_id=$1`, [c.cid]))[0].n)).toBe(600)
    expect((await svcF4().getRecoveryState(c.cid)).outstandingCents).toBe(400)

    // ── collect 400 through the real recovery API ───────────────────────────
    const col = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries',
      { action: 'collect', commissionId: c.cid, amountCents: 400,
        idempotencyKey: 'LIFE-K1' }))
    expect(col.status).toBe(200)
    expect((await svcF4().getRecoveryState(c.cid)).outstandingCents).toBe(0)

    // Retrying the SAME collection must not double the cash.
    const dup = await recoveriesPOST(adminPost('/api/admin/affiliates/recoveries',
      { action: 'collect', commissionId: c.cid, amountCents: 400,
        idempotencyKey: 'LIFE-K1' }))
    expect((await dup.json()).result.outcome).toBe('already_collected')
    expect((await svcF4().getRecoveryState(c.cid)).collectedCents).toBe(400)

    // ── the dispute is WON through the canonical dispute-state path ─────────
    await raw(`SELECT upsert_order_dispute($1,$2,$3,6000,'usd','won','won',$4,
      'charge.dispute.closed',NOW()+INTERVAL '1 hour',NULL,'{}'::jsonb)`,
      [`dl_${c.n}`, c.charge, c.pi, `evw_${c.n}`])
    await raw(`SELECT sync_affiliate_dispute_state($1,NULL,'test')`, [d.id])

    // restoration +400, ledger back to 1000
    expect(Number((await raw(
      `SELECT COALESCE(SUM(adjustment_cents),0)::int AS n
       FROM affiliate_commission_adjustments WHERE commission_id=$1`, [c.cid]))[0].n)).toBe(1000)

    // payable is EXACTLY 400: 1000 earned - 1000 paid + 400 recovered
    expect(Number((await raw(`SELECT affiliate_commission_payable($1) AS p`,
      [c.cid]))[0].p)).toBe(400)

    // ── second payout through the real service ─────────────────────────────
    const second = await svcF4().createPayout(c.aff, [c.cid], 'admin@kvrn.test')
    expect(second.outcome).toBe('created')
    expect(Number(second.amount_cents)).toBe(400)

    const paid2 = await payoutsPOST(adminPost('/api/admin/affiliates/payouts',
      { kind: 'mark_paid', payoutId: second.payout_id, paidAt: '2026-09-10' }))
    expect(paid2.status).toBe(200)

    // The FIRST payout history is intact and still paid.
    const payouts = await raw(
      `SELECT id, amount_cents, status FROM affiliate_payouts
       WHERE affiliate_id=$1 ORDER BY created_at`, [c.aff])
    expect(payouts).toHaveLength(2)
    expect((payouts[0] as any).status).toBe('paid')
    expect(Number((payouts[0] as any).amount_cents)).toBe(1000)
    expect(Number((payouts[1] as any).amount_cents)).toBe(400)

    // Nothing left over, and no excess payable.
    expect(Number((await raw(`SELECT affiliate_commission_payable($1) AS p`,
      [c.cid]))[0].p)).toBe(0)
    expect(Number((await raw(`SELECT affiliate_commission_overpaid($1) AS o`,
      [c.cid]))[0].o)).toBe(0)
  })
})

describe('Blocker 4 — period components reconcile to net', () => {

  const effect = async () => {
    const r = await raw(
      `SELECT accrued_cents, reversed_cents, restored_cents, net_commission_cents
       FROM affiliate_commission_effect(NOW() - INTERVAL '3650 days', NOW() + INTERVAL '3650 days')`)
    const x = r[0] as any
    return { accrued: Number(x.accrued_cents), reversed: Number(x.reversed_cents),
             restored: Number(x.restored_cents), net: Number(x.net_commission_cents) }
  }

  test('A +1000, -450, then a +50 same-status correction reconciles', async () => {
    await raw(`TRUNCATE affiliate_commission_adjustments, affiliate_commissions,
      order_affiliate_attributions, dispute_merchandise_resolutions,
      order_dispute_financial_adjustments, order_disputes, order_refunds,
      affiliate_payout_lines, affiliate_payouts CASCADE`)

    const aff = await makeAffiliate('F4RPT', 1000)
    const orderId = uid(); const n = `RPT-${++seq}`
    await raw(
      `INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,
         payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,
         total_cents,paid_at,discount_code)
       VALUES ($1,$2,$3,$4,'paid','usd',10000,0,0,0,10000,NOW()-INTERVAL '2 days','F4RPT')`,
      [orderId, n, `cs_${n}`, `pi_${n}`])
    await raw(`SELECT resolve_order_affiliate_attribution($1,NULL,'test')`, [orderId])

    // Lost partial dispute, decomposed to 4500 merchandise -> -450.
    await raw(`SELECT upsert_order_dispute($1,$2,$3,6000,'usd','lost','lost',$4,
      'charge.dispute.closed',NOW(),NULL,'{}'::jsonb)`,
      [`dr_${n}`, `ch_${n}`, `pi_${n}`, `evr_${n}`])
    const d = (await raw(`SELECT id FROM order_disputes WHERE stripe_dispute_id=$1`,
      [`dr_${n}`]))[0] as any
    await reconciliationPOST(adminPost('/api/admin/affiliates/reconciliation',
      { disputeId: d.id, merchandiseCents: 4500, shippingCents: 1500, taxCents: 0 }))

    let e = await effect()
    expect(e.accrued).toBe(1000)
    expect(e.reversed).toBe(-450)
    expect(e.net).toBe(550)
    expect(e.accrued + e.reversed + e.restored).toBe(e.net)

    // CORRECTION to 4000 merchandise while the dispute REMAINS lost: +50, and
    // its reason stays 'dispute_reversal'.
    const corr = await reconciliationPOST(adminPost('/api/admin/affiliates/reconciliation',
      { disputeId: d.id, merchandiseCents: 4000, shippingCents: 2000, taxCents: 0,
        notes: 'verified correction' }))
    expect(corr.status).toBe(200)

    e = await effect()
    expect(e.accrued).toBe(1000)
    expect(e.reversed).toBe(-450)
    expect(e.restored).toBe(50)          // counted, though not a dispute win
    expect(e.net).toBe(600)
    expect(e.accrued + e.reversed + e.restored).toBe(e.net)   // THE INVARIANT
  })

  test('B a dispute win restoration is still counted', async () => {
    const before = await effect()
    const cid = ((await raw(`SELECT id FROM affiliate_commissions LIMIT 1`))[0] as any).id
    const d = (await raw(`SELECT id, stripe_dispute_id, stripe_charge_id,
      stripe_payment_intent_id, amount_cents FROM order_disputes LIMIT 1`))[0] as any
    await raw(`SELECT upsert_order_dispute($1,$2,$3,$4,'usd','won','won',$5,
      'charge.dispute.closed',NOW()+INTERVAL '2 hours',NULL,'{}'::jsonb)`,
      [d.stripe_dispute_id, d.stripe_charge_id, d.stripe_payment_intent_id,
       d.amount_cents, `evwin_${++seq}`])
    await raw(`SELECT sync_affiliate_dispute_state($1,NULL,'test')`, [d.id])

    const e = await effect()
    expect(e.restored).toBeGreaterThan(before.restored)
    expect(e.net).toBe(1000)
    expect(e.accrued + e.reversed + e.restored).toBe(e.net)
  })

  test('C/D refund reversals stay negative and zero-cent rows do not distort',
    async () => {
    const e = await effect()
    // Every zero-cent claim-state row contributes 0 to all three buckets.
    const zeros = await raw(
      `SELECT COUNT(*)::int AS n FROM affiliate_commission_adjustments
       WHERE adjustment_cents = 0`)
    expect(Number((zeros[0] as any).n)).toBeGreaterThanOrEqual(0)
    expect(e.accrued + e.reversed + e.restored).toBe(e.net)
    expect(e.reversed).toBeLessThanOrEqual(0)
  })
})

describe('Blocker 5 — ambiguous ownership is never reported as success', () => {

  test('the real backfill route returns an explicit non-success', async () => {
    const discountId = uid()
    await raw(`INSERT INTO discounts (id,code,name,type,percentage_bps,active,system_managed)
               VALUES ($1,$2,'Amb','percentage',1000,true,true)`,
              [discountId, `AMB${++seq}`])
    // Two affiliates owning the same discount at the same past instant.
    const a = await makeAffiliate(`AMBA${seq}`, 1000)
    const b = await makeAffiliate(`AMBB${seq}`, 2000)
    for (const id of [a, b]) {
      await raw(`INSERT INTO affiliate_terms_events (affiliate_id,commission_type,
        commission_rate_bps,fixed_reversal_policy,attribution_window_days,
        commission_hold_days,discount_id,effective_at)
        VALUES ($1,'percentage',1000,'proportional',30,0,$2,NOW()-INTERVAL '300 days')`,
        [id, discountId])
    }

    const orderId = uid(); const n = `AMB-${++seq}`
    await raw(
      `INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,
         payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,
         total_cents,paid_at,discount_code,discount_id)
       VALUES ($1,$2,$3,$4,'paid','usd',10000,0,0,0,10000,NOW()-INTERVAL '10 days',$5,$6)`,
      [orderId, n, `cs_${n}`, `pi_${n}`, `AMB${seq - 3}`, discountId])

    const res = await backfillPOST(adminPost('/api/admin/affiliates/backfill',
      { orderId }))
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.result.outcome).toBe('ambiguous_historical_ownership')
    expect(body.message).not.toMatch(/backfilled and reconciled/i)
    expect(body.message).toMatch(/ambiguous/i)
    // Nothing created.
    expect(await raw(`SELECT 1 FROM order_affiliate_attributions WHERE order_id=$1`,
      [orderId])).toHaveLength(0)
    expect(await raw(`SELECT 1 FROM affiliate_commissions WHERE order_id=$1`,
      [orderId])).toHaveLength(0)
  })
})
