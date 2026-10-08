// The REAL checkout handler (lib/checkout-session-handler.ts) with the abandoned-checkout hook.
// Proves the hook can never change the checkout response: absent, failing, hanging, flag ON, flag OFF.
// Substituted: Stripe client, Shippo rates and the reservation deps (taken by injection). The database
// is a real local PostgreSQL via the test harness; '../db' is pointed at it.
import { HAVE_DB, createFiDb, type FiDb } from './helpers/fi-pg'
import { createAbandonedCheckoutService } from '../abandoned-checkout'
import { signToken } from '../abandoned-checkout-token'

jest.mock('../db', () => ({ get sql() { return (global as any).__H_SQL } }))
jest.mock('../shippo', () => ({
  ...jest.requireActual('../shippo'),
  getShippoRates: jest.fn(async () => ({
    ok: true,
    standard: { amountCents: 800, provider: 'USPS', servicelevelName: 'Ground', estimatedDays: 4, objectId: 'rate_std' },
    express:  { amountCents: 2200, provider: 'UPS', servicelevelName: '2nd Day', estimatedDays: 2, objectId: 'rate_exp' },
  })),
}))

const d = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) test('NOTE: abandoned-checkout handler tests skipped — TEST_DATABASE_URL absent or not local.', () => expect(true).toBe(true))

const SECRET = 'h4ndler-'.repeat(6)
const FLAG = 'KVRN_FLAG_ABANDONED_CHECKOUT_EMAILS'
const reserveInventory = jest.fn(); const saveDetails = jest.fn(); const attach = jest.fn(); const failReservation = jest.fn()
const stripeCreate = jest.fn()

let F: FiDb
let seq = 0
const uid = (p: string) => `${p}-0000-4000-9000-${String(++seq).padStart(12, '0')}`
const svcWith = (env: Record<string, string | undefined>) =>
  createAbandonedCheckoutService(F.sql, { env, getOrigin: () => 'https://kvrn.test', getProvider: () => ({ send: jest.fn() }) as any })

async function build(hook?: (i: any) => Promise<void>) {
  const { createCheckoutPostHandler } = await import('../checkout-session-handler')
  return createCheckoutPostHandler({
    isCheckoutEnabled: () => true, getSiteOrigin: () => 'https://kvrn.shop',
    getStripe: () => ({ checkout: { sessions: { create: stripeCreate } } }) as any,
    reserveInventory, saveReservationCheckoutDetails: saveDetails, failReservation, attachStripeSession: attach,
    releaseExpiredReservations: jest.fn(), ...(hook ? { recordCheckoutStarted: hook } : {}),
  } as any)
}

async function fixture() {
  const n = ++seq
  const productId = uid('f4000000'); const variantId = uid('f4000001'); const reservationId = uid('f4000002')
  const sku = `KVRN-HD-${n}`
  await F.q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active) VALUES ($1,'HD',$2,'HD Tee',$3,10000,true)`, [productId, `HD${n}`, `hd-${n}`])
  await F.q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand,reserved_quantity,active)
             VALUES ($1,$2,$3,'Black','BLK','M',2,10,1,true)`, [variantId, productId, sku])
  await F.q(`INSERT INTO reservations (id, expires_at, status) VALUES ($1, NOW() + INTERVAL '15 minutes','open')`, [reservationId])
  await F.q(`INSERT INTO reservation_items (reservation_id, variant_id, sku, product_name, size, color, quantity, unit_price_cents)
             VALUES ($1,$2,$3,'HD Tee','M','Black',1,10000)`, [reservationId, variantId, sku])
  reserveInventory.mockReset().mockResolvedValue({
    ok: true, reservationId,
    items: [{ sku, variantId, quantity: 1, unitPriceCents: 10000, productName: 'HD Tee', size: 'M', color: 'Black' }],
    subtotalCents: 10000, expiresAt: new Date(Date.now() + 9e5).toISOString(),
  })
  saveDetails.mockReset().mockResolvedValue(true); attach.mockReset().mockResolvedValue(undefined); failReservation.mockReset()
  const sessionId = `cs_hd_${n}`
  stripeCreate.mockReset().mockResolvedValue({ id: sessionId, url: 'https://stripe.test/pay', expires_at: Math.floor(Date.now() / 1000) + 1800 })
  return { sku, reservationId, sessionId }
}

async function post(handler: any, sku: string, cookies: Record<string, string> = {}) {
  const req: any = new Request('https://kvrn.shop/api/checkout/session', {
    method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'fr-CA,fr;q=0.9' },
    body: JSON.stringify({
      items: [{ sku, quantity: 1 }], email: 'Buyer@Example.com',
      shippingAddress: { firstName: 'A', lastName: 'Buyer', line1: '1 Test St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
      shippingMethod: 'standard',
    }),
  })
  req.nextUrl = new URL('https://kvrn.shop/api/checkout/session')
  req.cookies = { get: (k: string) => (k in cookies ? { value: cookies[k] } : undefined) }
  const res = await handler(req)
  return { status: res.status, body: await res.json() }
}
const rowFor = async (sid: string) => (await F.q(`SELECT * FROM abandoned_checkouts WHERE stripe_checkout_session_id=$1`, [sid]))[0]

d('checkout handler + abandoned-checkout hook', () => {
  beforeAll(async () => {
    F = await createFiDb('kvrn_abhandler');(global as any).__H_SQL = F.sql
    process.env.ENABLE_STRIPE_TEST_CHECKOUT = 'true'; process.env.SHIPPO_API_TOKEN = 'shippo_test_token'
  }, 180_000)
  afterAll(async () => { await F?.close() })

  test('baseline (hook absent): the response is the Stripe URL and no abandoned row exists', async () => {
    const fx = await fixture()
    const r = await post(await build(), fx.sku)
    expect(r.status).toBe(200); expect(r.body).toEqual({ url: 'https://stripe.test/pay', sessionId: fx.sessionId })
    expect(await rowFor(fx.sessionId)).toBeUndefined()
  })

  test.each([['ON', { [FLAG]: 'on', ABANDONED_LINK_SECRET: SECRET }], ['OFF', {}]])(
    'flag %s: identical response; the row is recorded (recording is allowed OFF), normalised, with no price drift', async (_n, env) => {
      const fx = await fixture()
      const svc = svcWith(env as any)
      const r = await post(await build(i => svc.tryRecordCheckout(i)), fx.sku)
      expect(r).toEqual({ status: 200, body: { url: 'https://stripe.test/pay', sessionId: fx.sessionId } })
      const row = await rowFor(fx.sessionId)
      expect(row).toMatchObject({ email: 'buyer@example.com', state: 'active', currency: 'usd', reservation_id: fx.reservationId, locale: 'fr-CA' })
      expect(row.cart[0]).toMatchObject({ sku: fx.sku, quantity: 1, seenUnitPriceCents: 10000 })
      expect(row.recovery_send_key).toBeNull()                       // nothing queued by the checkout itself
      // the commerce rows the checkout depends on are untouched by the hook
      expect((await F.q(`SELECT status FROM reservations WHERE id=$1`, [fx.reservationId]))[0].status).toBe('open')
    })

  test('the hook runs only after the Stripe session exists and is attached', async () => {
    const fx = await fixture(); const order: string[] = []
    attach.mockImplementation(async () => { order.push('attach') })
    const r = await post(await build(async () => { order.push('hook') }), fx.sku)
    expect(r.status).toBe(200); expect(order).toEqual(['attach', 'hook'])
  })

  test('a failed Stripe session never reaches the hook', async () => {
    const fx = await fixture(); const hook = jest.fn()
    stripeCreate.mockReset().mockRejectedValue(new Error('stripe down'))
    const r = await post(await build(hook), fx.sku)
    expect(r.status).toBeGreaterThanOrEqual(400); expect(hook).not.toHaveBeenCalled()
  })

  test('a throwing hook leaves the response identical', async () => {
    const fx = await fixture(); const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    const r = await post(await build(async () => { throw new Error('boom') }), fx.sku)
    expect(r).toEqual({ status: 200, body: { url: 'https://stripe.test/pay', sessionId: fx.sessionId } })
    err.mockRestore()
  })

  test('a hung hook is abandoned after ~2s and the response is still identical', async () => {
    const fx = await fixture(); const t0 = Date.now()
    const r = await post(await build(() => new Promise<void>(() => {})), fx.sku)
    const ms = Date.now() - t0
    expect(r).toEqual({ status: 200, body: { url: 'https://stripe.test/pay', sessionId: fx.sessionId } })
    expect(ms).toBeGreaterThanOrEqual(1900); expect(ms).toBeLessThan(6000)
  }, 15_000)

  test('a broken abandoned table (service error) is swallowed by tryRecordCheckout', async () => {
    const fx = await fixture(); const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    const broken = createAbandonedCheckoutService((() => Promise.reject(new Error('relation missing'))) as any, { env: {} })
    const r = await post(await build(i => broken.tryRecordCheckout(i)), fx.sku)
    expect(r.status).toBe(200); expect(r.body.sessionId).toBe(fx.sessionId)
    err.mockRestore()
  })

  test('the recovery cookie is read server-side and links the NEW session to the sent reminder', async () => {
    const svc = svcWith({ [FLAG]: 'on', ABANDONED_LINK_SECRET: SECRET })
    const src = await fixture(); await post(await build(i => svc.tryRecordCheckout(i)), src.sku)
    const srcRow = await rowFor(src.sessionId)
    await F.q(`UPDATE abandoned_checkouts SET state='recovery_sent', recovery_sent_at=now() WHERE id=$1`, [srcRow.id])
    const cookie = signToken(SECRET, { purpose: 'recover', id: srcRow.id, expiresAtSec: Math.floor(Date.now() / 1000) + 3600 })

    const fx = await fixture()
    await post(await build(i => svc.tryRecordCheckout(i)), fx.sku, { kvrn_recover: cookie })
    expect((await rowFor(fx.sessionId)).recovery_source_id).toBe(srcRow.id)

    const fx2 = await fixture()                                    // forged cookie links nothing, checkout still fine
    const r = await post(await build(i => svc.tryRecordCheckout(i)), fx2.sku, { kvrn_recover: cookie.slice(0, -3) + 'xyz' })
    expect(r.status).toBe(200); expect((await rowFor(fx2.sessionId)).recovery_source_id).toBeNull()
  })
})
