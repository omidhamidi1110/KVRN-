// The REAL checkout handler (lib/checkout-session-handler.ts) with the language / currency cookies.
// Proves: the Stripe-hosted page follows the chosen language (when Stripe supports it), nothing is
// sent when no language was chosen, and the CHARGE is identical USD whatever the currency cookie
// or the MULTI_CURRENCY_CHECKOUT flag say. Substituted: the Stripe client and Shippo rates and the
// reservation deps (injected); the database is a real local PostgreSQL via the test harness.
import { HAVE_DB, createFiDb, type FiDb } from './helpers/fi-pg'

jest.mock('../db', () => ({ get sql() { return (global as any).__I18NH_SQL } }))
jest.mock('../shippo', () => ({
  ...jest.requireActual('../shippo'),
  getShippoRates: jest.fn(async () => ({
    ok: true,
    standard: { amountCents: 800, provider: 'USPS', servicelevelName: 'Ground', estimatedDays: 4, objectId: 'rate_std' },
    express:  { amountCents: 2200, provider: 'UPS', servicelevelName: '2nd Day', estimatedDays: 2, objectId: 'rate_exp' },
  })),
}))

const d = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) test('NOTE: i18n checkout handler tests skipped — TEST_DATABASE_URL absent or not local.', () => expect(true).toBe(true))

const reserveInventory = jest.fn(); const saveDetails = jest.fn(); const attach = jest.fn(); const failReservation = jest.fn()
const stripeCreate = jest.fn()
let F: FiDb
let seq = 0
const uid = (p: string) => `${p}-0000-4000-9000-${String(++seq).padStart(12, '0')}`

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
  const productId = uid('f5000000'); const variantId = uid('f5000001'); const reservationId = uid('f5000002')
  const sku = `KVRN-I18-${n}`
  await F.q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active) VALUES ($1,'IH',$2,'I18 Tee',$3,10000,true)`, [productId, `IH${n}`, `ih-${n}`])
  await F.q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand,reserved_quantity,active)
             VALUES ($1,$2,$3,'Black','BLK','M',2,10,1,true)`, [variantId, productId, sku])
  await F.q(`INSERT INTO reservations (id, expires_at, status) VALUES ($1, NOW() + INTERVAL '15 minutes','open')`, [reservationId])
  await F.q(`INSERT INTO reservation_items (reservation_id, variant_id, sku, product_name, size, color, quantity, unit_price_cents)
             VALUES ($1,$2,$3,'I18 Tee','M','Black',1,10000)`, [reservationId, variantId, sku])
  reserveInventory.mockReset().mockResolvedValue({
    ok: true, reservationId,
    items: [{ sku, variantId, quantity: 1, unitPriceCents: 10000, productName: 'I18 Tee', size: 'M', color: 'Black' }],
    subtotalCents: 10000, expiresAt: new Date(Date.now() + 9e5).toISOString(),
  })
  saveDetails.mockReset().mockResolvedValue(true); attach.mockReset().mockResolvedValue(undefined); failReservation.mockReset()
  const sessionId = `cs_i18_${n}`
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
  return { status: res.status as number, body: await res.json() }
}
const sent = () => stripeCreate.mock.calls[0][0] as Record<string, any>
const withoutLocale = (o: Record<string, any>) => { const { locale: _l, ...rest } = o; return rest }
/** Strip the per-fixture ids so two checkouts of identical carts can be compared. */
const norm = (o: Record<string, any>) => JSON.parse(JSON.stringify(withoutLocale(o)).replace(/KVRN-I18-\d+/g, 'SKU').replace(/f5[0-9a-f]{6}-0000-4000-9000-\d{12}/g, 'ID').replace(/cs_i18_\d+/g, 'SID'))

d('checkout handler: language reaches Stripe, currency never changes the charge', () => {
  beforeAll(async () => {
    F = await createFiDb('kvrn_i18nhandler'); (global as any).__I18NH_SQL = F.sql
    process.env.ENABLE_STRIPE_TEST_CHECKOUT = 'true'; process.env.SHIPPO_API_TOKEN = 'shippo_test_token'
  }, 180_000)
  afterAll(async () => { await F?.close() })
  afterEach(() => { delete process.env.KVRN_FLAG_MULTI_CURRENCY_CHECKOUT; jest.restoreAllMocks() })

  test('no language cookie: the locale parameter is not sent at all (Stripe behaves exactly as before)', async () => {
    const fx = await fixture()
    const r = await post(await build(), fx.sku)
    expect(r).toEqual({ status: 200, body: { url: 'https://stripe.test/pay', sessionId: fx.sessionId } })
    expect(Object.keys(sent())).not.toContain('locale')
    expect(sent().currency).toBe('usd')
    expect(sent().mode).toBe('payment')
  })

  test.each([
    ['en', 'en'], ['es', 'es'], ['fr', 'fr'], ['de', 'de'], ['pt', 'pt'], ['zh', 'zh'], ['ja', 'ja'], ['ko', 'ko'],
    ['ar', 'auto'], ['hi', 'auto'],
  ])('kvrn_locale=%s sends Stripe locale %s', async (cookie, expected) => {
    const fx = await fixture()
    const r = await post(await build(), fx.sku, { kvrn_locale: cookie })
    expect(r.status).toBe(200)
    expect(sent().locale).toBe(expected)
  })

  test.each([['xx'], ['EN'], [''], ['../../etc'], ['ar;evil']])('an invalid kvrn_locale (%j) is ignored', async (bad) => {
    const fx = await fixture()
    expect((await post(await build(), fx.sku, { kvrn_locale: bad })).status).toBe(200)
    expect(Object.keys(sent())).not.toContain('locale')
  })

  test('a foreign-currency cookie does not change a single amount or currency sent to Stripe (flag OFF and ON)', async () => {
    const fxA = await fixture()
    await post(await build(), fxA.sku)
    const baseline = norm(sent())

    for (const flag of [undefined, 'on']) {
      if (flag) process.env.KVRN_FLAG_MULTI_CURRENCY_CHECKOUT = flag
      for (const cur of ['EUR', 'JPY', 'GBP', 'AED']) {
        const fx = await fixture()
        const r = await post(await build(), fx.sku, { kvrn_currency: cur, kvrn_locale: 'de' })
        expect(r.status).toBe(200)
        const args = sent()
        expect(args.currency).toBe('usd')
        expect(args.locale).toBe('de')
        for (const li of args.line_items ?? []) expect(li.price_data.currency).toBe('usd')
        const actual = norm(args)

        // Checkout expiry depends on the clock, not the currency.
        // Still require a valid integer expiration timestamp.
        expect(Number.isInteger(actual.expires_at)).toBe(true)

        // Compare every other Stripe field exactly, including money.
        expect({ ...actual, expires_at: baseline.expires_at }).toEqual(baseline)
        expect(JSON.stringify(args)).not.toMatch(/"currency":"(eur|jpy|gbp|aed)"/i)
      }
    }
  })

  test('the abandoned-checkout record gets the language the shopper chose, else Accept-Language; always usd', async () => {
    const hook = jest.fn(async () => {})
    let fx = await fixture()
    await post(await build(hook), fx.sku, { kvrn_locale: 'es', kvrn_currency: 'EUR' })
    expect(hook).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'es', currency: 'usd', stripeSessionId: fx.sessionId }))
    fx = await fixture()
    await post(await build(hook), fx.sku)
    expect(hook).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'fr-CA,fr;q=0.9', currency: 'usd' }))
  })

  test('fail closed: if the policy ever resolved to a non-USD charge, no reservation and no Stripe session are created', async () => {
    const policy = require('../i18n/currency-policy')
    jest.spyOn(policy, 'resolvePayableCurrency').mockReturnValue({ requested: 'EUR', chargedIn: 'EUR', payable: true, reason: null })
    const fx = await fixture()
    const r = await post(await build(), fx.sku, { kvrn_currency: 'EUR' })
    expect(r.status).toBe(500)
    expect(r.body.error).toMatch(/could not be started/i)
    expect(stripeCreate).not.toHaveBeenCalled()
    expect(reserveInventory).not.toHaveBeenCalled()
  })
})
