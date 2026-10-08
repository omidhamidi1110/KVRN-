// The REAL checkout handler (lib/checkout-session-handler.ts) with a set in the request, against
// REAL PostgreSQL (migrations 001-034 incl. 029). Real: the reservation service (reserve_inventory /
// reserve_inventory_v2, attach, save details), the bundle checkout, the amount math.
// Substituted: the Stripe client (captured), Shippo rates, and '../db' (pointed at the throwaway DB).
// Requires a LOCAL TEST_DATABASE_URL; skips visibly otherwise.
import { HAVE_DB, createFiDb, type FiDb } from './helpers/fi-pg'
import { createReservationService } from '../reservations'
import { createBundleCheckout } from '../bundle-checkout'

jest.mock('../db', () => ({ get sql() { return (global as any).__H_SQL } }))
const rate = (method: 'standard' | 'express', cents: number, minDays: number, maxDays: number) => ({
  method, cents, label: method, estimate: `${minDays}-${maxDays} days`, minDays, maxDays,
  stripeLabel: method === 'standard' ? 'Standard (USPS Ground)' : 'Express (UPS 2nd Day)', provider: 'USPS', serviceToken: `tok_${method}`,
})
const shippoMock = jest.fn(async (..._a: any[]) => ({ standard: rate('standard', 800, 3, 5), express: rate('express', 2200, 1, 2) }))
jest.mock('../shippo', () => ({ ...jest.requireActual('../shippo'), getShippoRates: (...a: any[]) => shippoMock(...a) }))

const d = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) test('NOTE: bundle checkout handler tests skipped — TEST_DATABASE_URL absent or not local.', () => expect(true).toBe(true))

let F: FiDb
let flagOn = true
let n = 0
const stripeCreate = jest.fn()
const recorded: any[] = []
const ids = { A: '', B: '', C: '' }
let bundleId = ''
const sku = (c: string) => `KVRN-H${c}-M`

async function product(code: 'A' | 'B' | 'C', price: number) {
  const pid = `f5000000-0000-4000-9000-00000000000${code === 'A' ? 1 : code === 'B' ? 2 : 3}`
  const vid = `f5000001-0000-4000-9000-00000000000${code === 'A' ? 1 : code === 'B' ? 2 : 3}`
  await F.q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active) VALUES ($1,'H',$2,$3,$4,$5,true)`,
    [pid, `H${code}`, `Handler ${code}`, `handler-${code.toLowerCase()}`, price])
  await F.q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand,active) VALUES ($1,$2,$3,'Black','BLK','M',2,0,true)`, [vid, pid, sku(code)])
  await F.q(`SELECT add_inventory_layer($1,50,2000,'purchase',NULL,NULL,'cost_batch','jest')`, [vid])
  await F.q(`UPDATE product_variants SET stock_on_hand=50 WHERE id=$1`, [vid])
  await F.q(`INSERT INTO content_entities (entity_type, entity_id, status, slug, published_version_no, revision) VALUES ('product',$1,'published',$2,1,1)`, [pid, `handler-${code.toLowerCase()}`])
  return pid
}

async function build(opts: { withBundles?: boolean } = {}) {
  const { createCheckoutPostHandler } = await import('../checkout-session-handler')
  const svc = createReservationService(F.sql)
  const bc = createBundleCheckout(F.sql, { isEnabled: () => flagOn })
  return createCheckoutPostHandler({
    isCheckoutEnabled: () => true, getSiteOrigin: () => 'https://kvrn.shop',
    getStripe: () => ({ checkout: { sessions: { create: stripeCreate } } }) as any,
    reserveInventory: (items: any, prep?: any) => (prep ? bc.reserve(prep, items) : svc.reserveInventory(items)),
    saveReservationCheckoutDetails: svc.saveReservationCheckoutDetails,
    failReservation: svc.failReservation, attachStripeSession: svc.attachStripeSession,
    releaseExpiredReservations: svc.releaseExpiredReservations,
    recordCheckoutStarted: async (i: any) => { recorded.push(i) },
    ...(opts.withBundles === false ? {} : { bundles: { prepare: (r: any, p: any, c: any) => bc.prepare(r, p, c)} }),
  } as any)
}

async function post(handler: any, body: Record<string, unknown>) {
  const req: any = new Request('https://kvrn.shop/api/checkout/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'buyer@example.com',
      shippingAddress: { firstName: 'A', lastName: 'Buyer', line1: '1 Test St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
      shippingMethod: 'standard', ...body,
    }),
  })
  req.nextUrl = new URL('https://kvrn.shop/api/checkout/session')
  req.cookies = { get: () => undefined }
  const res = await handler(req)
  return { status: res.status, body: await res.json() }
}
const bundleBody = (over: Record<string, unknown> = {}) => ({
  bundleId, quantity: 1, expectedSetNetCents: 13500,
  selections: [{ productId: ids.A, sku: sku('A') }, { productId: ids.B, sku: sku('B') }], ...over,
})
const reservations = async () => (await F.q(`SELECT count(*)::int n FROM reservations`))[0].n as number
const lastSessionArgs = () => stripeCreate.mock.calls[stripeCreate.mock.calls.length - 1][0]

d('checkout handler with a set (real PG)', () => {
  beforeAll(async () => {
    F = await createFiDb('kvrn_bndhandler'); (global as any).__H_SQL = F.sql
    process.env.ENABLE_STRIPE_TEST_CHECKOUT = 'true'; process.env.SHIPPO_API_TOKEN = 'shippo_test_token'
    ids.A = await product('A', 9000); ids.B = await product('B', 6000); ids.C = await product('C', 3000)
    bundleId = (await F.q(`INSERT INTO bundles (owner_product_id, enabled, include_owner, pricing_mode, pricing_value, presentation, revision, published_at)
      VALUES ($1,true,true,'fixed_discount',1500,'{"headline":"Wear it together"}',1,now()) RETURNING id`, [ids.A]))[0].id
    await F.q(`INSERT INTO bundle_components (bundle_id, component_product_id, is_owner, view_separately, sort_order) VALUES ($1,$2,true,false,0),($1,$3,false,true,1)`, [bundleId, ids.A, ids.B])
  }, 180_000)
  afterAll(async () => { await F?.close() })
  beforeEach(() => {
    flagOn = true; recorded.length = 0; shippoMock.mockClear()
    stripeCreate.mockReset().mockImplementation(async () => ({ id: `cs_bh_${++n}`, url: 'https://stripe.test/pay', expires_at: Math.floor(Date.now() / 1000) + 1800 }))
  })

  test('an ordinary cart is unchanged: canonical prices, no set metadata, no snapshot', async () => {
    const r = await post(await build(), { items: [{ sku: sku('C'), quantity: 2 }] })
    expect(r.status).toBe(200)
    const a = lastSessionArgs()
    expect(a.line_items.map((l: any) => [l.price_data.unit_amount, l.quantity])).toEqual([[3000, 2]])
    expect(JSON.stringify(a)).not.toMatch(/bundle|Part of a set/i)
    expect(recorded[0].bundleContext).toBeUndefined()
    const rid = a.metadata.reservation_id
    expect((await F.q(`SELECT 1 FROM reservation_bundles WHERE reservation_id=$1`, [rid])).length).toBe(0)
  })

  test('a handler without the bundle dependency treats a ordinary cart identically', async () => {
    const r = await post(await build({ withBundles: false }), { items: [{ sku: sku('C'), quantity: 1 }] })
    expect(r.status).toBe(200)
    expect(lastSessionArgs().line_items[0].price_data.unit_amount).toBe(3000)
  })

  test('a set with an ordinary item: Stripe is charged the allocated net prices and the totals agree', async () => {
    const r = await post(await build(), { items: [{ sku: sku('C'), quantity: 1 }], bundle: bundleBody() })
    expect(r.status).toBe(200)
    const a = lastSessionArgs()
    const lines = a.line_items.map((l: any) => ({ sku: l.price_data.product_data.metadata.sku, amount: l.price_data.unit_amount, qty: l.quantity, set: !!l.price_data.product_data.metadata.bundle_id, desc: l.price_data.product_data.description }))
    expect(lines.sort((x: any, y: any) => x.sku.localeCompare(y.sku))).toEqual([
      { sku: sku('A'), amount: 8100, qty: 1, set: true, desc: 'Part of a set' },
      { sku: sku('B'), amount: 5400, qty: 1, set: true, desc: 'Part of a set' },
      { sku: sku('C'), amount: 3000, qty: 1, set: false, desc: undefined },
    ])
    expect(a.metadata.kvrn_bundle_id).toBe(bundleId)
    const stripeMerch = a.line_items.reduce((s: number, l: any) => s + l.price_data.unit_amount * l.quantity, 0)
    const rid = a.metadata.reservation_id
    const resMerch = (await F.q(`SELECT SUM(unit_price_cents*quantity)::int s FROM reservation_items WHERE reservation_id=$1`, [rid]))[0].s
    expect(stripeMerch).toBe(16500)
    expect(resMerch).toBe(16500)
    expect((await F.q(`SELECT bundle_net_cents, bundle_discount_cents FROM reservation_bundles WHERE reservation_id=$1`, [rid]))[0]).toEqual({ bundle_net_cents: 13500, bundle_discount_cents: 1500 })
  })

  test('shipping is rated on the real component SKUs of the set', async () => {
    await post(await build(), { bundle: bundleBody() })
    const items = shippoMock.mock.calls[0][1] as Array<{ sku: string; quantity: number }>
    expect(items.map(i => i.sku).sort()).toEqual([sku('A'), sku('B')])
  })

  test('a set alone (no ordinary items) is a valid cart', async () => {
    const r = await post(await build(), { items: [], bundle: bundleBody() })
    expect(r.status).toBe(200)
    expect(lastSessionArgs().line_items).toHaveLength(2)
  })

  test('an empty cart with no set is still refused', async () => {
    const r = await post(await build(), { items: [] })
    expect(r.status).toBe(400)
  })

  test('the abandoned-checkout hook receives the set context with the price the customer saw', async () => {
    await post(await build(), { bundle: bundleBody() })
    expect(recorded).toHaveLength(1)
    expect(recorded[0].bundleContext).toMatchObject({ bundleId, setQuantity: 1, seenSetNetCents: 13500 })
    expect(recorded[0].bundleContext.components.map((c: any) => c.sku).sort()).toEqual([sku('A'), sku('B')])
    expect(recorded[0].items.map((i: any) => i.unitPriceCents).sort((x: number, y: number) => x - y)).toEqual([5400, 8100])
  })

  test('client-supplied prices are ignored: the charge comes from the published rule', async () => {
    const r = await post(await build(), {
      items: [{ sku: sku('C'), quantity: 1, unitPriceCents: 1, priceCents: 1 }],
      bundle: bundleBody({ unitPriceCents: 1, selections: [{ productId: ids.A, sku: sku('A'), priceCents: 1 }, { productId: ids.B, sku: sku('B'), netUnitCents: 1 }] }),
    })
    expect(r.status).toBe(200)
    expect(lastSessionArgs().line_items.map((l: any) => l.price_data.unit_amount).sort((x: number, y: number) => x - y)).toEqual([3000, 5400, 8100])
  })

  test('a discount code is not combinable with a set: refused before anything is reserved', async () => {
    const before = await reservations()
    const r = await post(await build(), { bundle: bundleBody(), discountCode: 'SAVE10' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('BUNDLE_DISCOUNT_NOT_COMBINABLE')
    expect(await reservations()).toBe(before)
    expect(stripeCreate).not.toHaveBeenCalled()
  })

  test('a stale price is reported with the new price, nothing reserved, nothing charged', async () => {
    const before = await reservations()
    const r = await post(await build(), { bundle: bundleBody({ expectedSetNetCents: 12000 }) })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'BUNDLE_PRICE_CHANGED', newSetNetCents: 13500 })
    expect(await reservations()).toBe(before)
    expect(stripeCreate).not.toHaveBeenCalled()
  })

  test('the same SKU inside the set and on its own is a conflict', async () => {
    const r = await post(await build(), { items: [{ sku: sku('A'), quantity: 1 }], bundle: bundleBody() })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('BUNDLE_SKU_CONFLICT')
  })

  test('bundle turned off or flag off: refused, and ordinary carts keep working', async () => {
    await F.q(`UPDATE bundles SET enabled=false WHERE id=$1`, [bundleId])
    let r = await post(await build(), { bundle: bundleBody() })
    expect(r.status).toBe(409); expect(r.body.code).toBe('BUNDLE_UNAVAILABLE')
    await F.q(`UPDATE bundles SET enabled=true WHERE id=$1`, [bundleId])
    flagOn = false
    r = await post(await build(), { bundle: bundleBody() })
    expect(r.body.code).toBe('BUNDLE_DISABLED')
    expect(stripeCreate).not.toHaveBeenCalled()
    r = await post(await build(), { items: [{ sku: sku('C'), quantity: 1 }] })
    expect(r.status).toBe(200)
  })

  test('a component sold out is reported by name; a malformed set is refused', async () => {
    await F.q(`UPDATE product_variants SET stock_on_hand=0, reserved_quantity=0 WHERE sku=$1`, [sku('B')])
    let r = await post(await build(), { bundle: bundleBody() })
    expect(r.status).toBe(409); expect(r.body.code).toBe('BUNDLE_COMPONENT_UNAVAILABLE'); expect(r.body.sku).toBe(sku('B'))
    await F.q(`UPDATE product_variants SET stock_on_hand=50 WHERE sku=$1`, [sku('B')])
    r = await post(await build(), { bundle: { bundleId: 'nope' } })
    expect(r.status).toBe(400); expect(r.body.code).toBe('BUNDLE_INVALID_REQUEST')
  })

  test('a handler built without the bundle dependency refuses a set', async () => {
    const r = await post(await build({ withBundles: false }), { bundle: bundleBody() })
    expect(r.status).toBe(400); expect(r.body.code).toBe('BUNDLE_DISABLED')
  })

  test('the paid order matches what Stripe was asked to charge (net) and carries the snapshot', async () => {
    const r = await post(await build(), { items: [{ sku: sku('C'), quantity: 1 }], bundle: bundleBody() })
    const a = lastSessionArgs()
    const rid = a.metadata.reservation_id
    const total = a.line_items.reduce((s: number, l: any) => s + l.price_data.unit_amount * l.quantity, 0) + a.shipping_options[0].shipping_rate_data.fixed_amount.amount
    expect(r.status).toBe(200)
    await F.q(`SELECT finalize_paid_order($1,$2::uuid,'pi_bh_1','evt_bh_1','checkout.session.completed','usd',$3,'buyer@example.com','A Buyer',NULL,NULL)`, [r.body.sessionId, rid, total])
    const o = (await F.q(`SELECT id, subtotal_cents, total_cents FROM orders WHERE stripe_checkout_session_id=$1`, [r.body.sessionId]))[0]
    expect(o.subtotal_cents).toBe(16500)
    expect((await F.q(`SELECT bundle_net_cents FROM order_bundles WHERE order_id=$1`, [o.id]))[0].bundle_net_cents).toBe(13500)
    expect(await F.q(`SELECT * FROM bundle_snapshot_gaps()`)).toEqual([])
  })

  describe('POST /api/bundles/quote (public, read-only)', () => {
    const call = async (body: unknown, raw?: string) => {
      const { POST } = await import('../../app/api/bundles/quote/route')
      const req: any = new Request('https://kvrn.shop/api/bundles/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) })
      const res = await POST(req)
      return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() }
    }
    afterEach(() => { delete process.env.KVRN_FLAG_CMS_PRODUCT_ROUTING })

    test('flag off: 404 and no data', async () => {
      const r = await call(bundleBody())
      expect(r.status).toBe(404)
      expect(r.body).toMatchObject({ ok: false, code: 'BUNDLE_DISABLED' })
      expect(r.cache).toBe('no-store')
    })
    test('flag on: returns the server quote and reserves nothing', async () => {
      process.env.KVRN_FLAG_CMS_PRODUCT_ROUTING = 'true'
      const before = await reservations()
      const r = await call(bundleBody())
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ ok: true, setNetCents: 13500, setDiscountCents: 1500 })
      expect(r.cache).toBe('no-store')
      expect(await reservations()).toBe(before)
    })
    test('flag on: a stale price, malformed JSON and an invalid request are answered safely', async () => {
      process.env.KVRN_FLAG_CMS_PRODUCT_ROUTING = 'true'
      expect((await call(bundleBody({ expectedSetNetCents: 1 }))).body).toMatchObject({ code: 'BUNDLE_PRICE_CHANGED', newSetNetCents: 13500 })
      expect((await call(null, '{not json')).status).toBe(400)
      expect((await call({ bundleId: 'x' })).body.code).toBe('BUNDLE_INVALID_REQUEST')
    })
  })
})
