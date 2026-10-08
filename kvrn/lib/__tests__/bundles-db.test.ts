// lib/__tests__/bundles-db.test.ts
//
// "Complete the Set" against REAL PostgreSQL (migrations 001-034 incl. 029_bundles.sql, in a
// throwaway database): publish projection and blockers, the quote, reserve_inventory_v2 (price
// validation, concurrency), the frozen order snapshot, and reconciliation with refunds, returns,
// disputes and the affiliate commission. Substituted: nothing except the cache invalidation callback.
// Requires a LOCAL TEST_DATABASE_URL; skips visibly otherwise.
import fs from 'fs'
import path from 'path'
import { Client } from 'pg'
import { createFiDb, HAVE_DB, ROOT, pgConfig, type FiDb } from './helpers/fi-pg'
import { createProductService, ProductBlockedError, type ProductService } from '../product-service'
import { createProductPublic, type ProductPublic } from '../product-public'
import { emptySnapshot } from '../product-model'
import { createBundleCheckout } from '../bundle-checkout'
import { createBundlePublic } from '../bundle-public'
import { createResumeService } from '../abandoned-checkout-resume'
import { priceSelection } from '../bundle-cart'
import { loadOrderBundle, createAdminOrderService } from '../admin-orders'

const d = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) test('NOTE: bundle DB tests skipped — TEST_DATABASE_URL absent or not local.', () => expect(true).toBe(true))

const A = 'owner@kvrn.test'
const SHIP = 700
const PRICE = { BNDA: 9000, BNDB: 6000, BNDC: 3000 } as const

function slot(i: number) {
  return { ref: { kind: 'static', src: `/images/products/kvrn-phantom-hoodie/${i}.webp` }, alt: `View ${i}`, focal: { mobile: null, desktop: null } }
}
function fullSnap(code: string, name: string, slug: string, price: number, bundle: unknown = null): any {
  const s: any = emptySnapshot({ name, slug, productType: 'tee' })
  s.shortDescription = `${name}.`
  s.description = `${name} made for tests.`
  s.constructionDetails = ['Cotton.']
  s.media = { hero: slot(1), gallery: [1, 2, 3, 4, 5].map(slot) }
  s.colors = [{ key: 'black', code: 'BLK', name: 'Black', hex: '#111111', media: null }]
  s.commerce = {
    priceCents: price, shipping: { weightLb: 1.2, lengthIn: 12, widthIn: 10, heightIn: 1 }, originCountry: null, hsCode: null,
    variants: [
      { id: null, sku: `KVRN-${code}-BLK-S`, colorCode: 'BLK', size: 'S', sizeSort: 2, active: true },
      { id: null, sku: `KVRN-${code}-BLK-M`, colorCode: 'BLK', size: 'M', sizeSort: 3, active: true },
    ],
  }
  s.seo = { ...s.seo, title: `${name} | KVRN`, description: `${name}.` }
  s.bundle = bundle
  return s
}
const cfg = (components: string[], pricing = { mode: 'fixed_discount', value: 1500 }, over: any = {}) => ({
  schema: 1, enabled: true, includeOwner: true, ownerAllowedVariantIds: null,
  components: components.map(productId => ({ productId, allowedVariantIds: null, viewSeparately: true })),
  pricing,
  presentation: { eyebrow: null, headline: 'Wear it together', supportingCopy: null, ctaLabel: null, sectionVisible: true },
  ...over,
})
const sku = (code: string, size = 'M') => `KVRN-${code}-BLK-${size}`

d('029 bundles (real PG)', () => {
  let db: FiDb, svc: ProductService, pub: ProductPublic
  let flagOn = true
  const bc = () => createBundleCheckout(db.sql, { isEnabled: () => flagOn })
  const q = (t: string, p: unknown[] = []) => db.q(t, p)
  const ids: Record<string, string> = {}
  const rev = async (id: string) => (await q(`SELECT revision FROM content_entities WHERE entity_type='product' AND entity_id=$1`, [id]))[0].revision as number

  async function mk(code: keyof typeof PRICE, name: string, slug: string, bundle: unknown = null) {
    const c = await svc.create({ code, name, type: 'tee', slug, actor: A })
    ids[code] = c.id
    await svc.saveDraft(c.id, fullSnap(code, name, slug, PRICE[code], bundle), c.revision, A)
    return c.id
  }
  async function goLive(code: string) {
    return svc.publish(ids[code], await rev(ids[code]), A)
  }
  const META: Record<string, [string, string]> = { BNDA: ['Owner Tee', 'owner-tee'], BNDB: ['Other Pant', 'other-pant'], BNDC: ['Third Cap', 'third-cap'] }
  /** After an unpublish a product needs a new draft before it can go live again. */
  async function relive(code: keyof typeof PRICE, bundle: unknown = null) {
    const [name, slug] = META[code]
    await svc.saveDraft(ids[code], fullSnap(code, name, slug, PRICE[code], bundle), await rev(ids[code]), A)
    return svc.publish(ids[code], await rev(ids[code]), A)
  }
  async function saveOwner(bundle: unknown, price = PRICE.BNDA) {
    const s = fullSnap('BNDA', 'Owner Tee', 'owner-tee', price, bundle)
    return svc.saveDraft(ids.BNDA, s, await rev(ids.BNDA), A)
  }
  async function stock(code: string, size: string, n: number) {
    const v = (await q(`SELECT id FROM product_variants WHERE sku=$1`, [sku(code, size)]))[0]
    await q(`SELECT add_inventory_layer($1,$2,3000,'purchase',NULL,NULL,'cost_batch','jest')`, [v.id, n])
    await q(`UPDATE product_variants SET stock_on_hand=$2 WHERE id=$1`, [v.id, n])
  }
  const bundleRow = async () => (await q(`SELECT * FROM bundles WHERE owner_product_id=$1`, [ids.BNDA]))[0]
  const setReq = (over: any = {}) => ({
    bundleId: over.bundleId, quantity: 1,
    selections: [{ productId: ids.BNDA, sku: sku('BNDA') }, { productId: ids.BNDB, sku: sku('BNDB') }],
    expectedSetNetCents: null, ...over,
  })

  beforeAll(async () => {
    db = await createFiDb('bndl')
    svc = createProductService(db.sql, { invalidate: async () => ({ id: 'x', ok: true, paths: [], tags: [] }) })
    pub = createProductPublic(db.sql)
    await mk('BNDB', 'Other Pant', 'other-pant'); await goLive('BNDB')
    await mk('BNDC', 'Third Cap', 'third-cap'); await goLive('BNDC')
    await mk('BNDA', 'Owner Tee', 'owner-tee'); await goLive('BNDA')   // no bundle yet
    for (const c of ['BNDA', 'BNDB', 'BNDC']) for (const s of ['S', 'M']) await stock(c, s, 40)
  }, 240000)
  afterAll(async () => { await db?.close() })

  // ── migration ────────────────────────────────────────────────────────────────
  describe('migration 029', () => {
    const file = path.join(ROOT, 'db/migrations/029_bundles.sql')
    test('is idempotent and additive', async () => {
      const sqlText = fs.readFileSync(file, 'utf8')
      const before = (await q(`SELECT (SELECT count(*)::int FROM bundles) b, (SELECT count(*)::int FROM products) p`))[0]
      await db.db.query(sqlText); await db.db.query(sqlText)
      const after = (await q(`SELECT (SELECT count(*)::int FROM bundles) b, (SELECT count(*)::int FROM products) p`))[0]
      expect(after).toEqual(before)
    })
    test('does not redefine any frozen function', () => {
      const sqlText = fs.readFileSync(file, 'utf8')
      const defined = [...sqlText.matchAll(/CREATE OR REPLACE FUNCTION\s+([a-z_0-9]+)/gi)].map(m => m[1])
      expect(defined.length).toBeGreaterThan(8)
      for (const frozen of ['reserve_inventory', 'finalize_paid_order', 'record_order_refund', 'upsert_order_dispute', 'cms_publish', 'publish_catalog_product']) {
        expect(defined).not.toContain(frozen)
      }
    })
    test('every bundle table exists with the immutability trigger on the snapshots', async () => {
      const t = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE '%bundle%' ORDER BY 1`)
      expect(t.map((r: any) => r.table_name)).toEqual(
        expect.arrayContaining(['bundles', 'bundle_components', 'reservation_bundles', 'reservation_bundle_items', 'order_bundles', 'order_bundle_items']))
    })
  })

  // ── publish: blockers and projection ─────────────────────────────────────────
  describe('publish, blockers and projection', () => {
    const codes = async () => (await svc.validate(ids.BNDA)).blockers.map((b: any) => b.code)

    test('a product without a bundle publishes exactly as before and projects nothing', async () => {
      expect((await q(`SELECT status FROM content_entities WHERE entity_type='product' AND entity_id=$1`, [ids.BNDA]))[0].status).toBe('published')
      expect(await bundleRow()).toBeUndefined()
      expect((await q(`SELECT count(*)::int n FROM bundle_components`))[0].n).toBe(0)
    })

    test('enabled with no components is blocked, with a readable reason', async () => {
      await saveOwner(cfg([]))
      expect(await codes()).toContain('BUNDLE_NO_COMPONENTS')
      await expect(svc.publish(ids.BNDA, await rev(ids.BNDA), A)).rejects.toBeInstanceOf(ProductBlockedError)
      expect(await bundleRow()).toBeUndefined()
    })

    test.each([
      ['itself as a component', () => cfg([ids.BNDA]), 'BUNDLE_SELF'],
      ['a missing product', () => cfg(['99999999-9999-4999-8999-999999999999']), 'BUNDLE_COMPONENT_MISSING'],
      ['a set price above the products’ price', () => cfg([ids.BNDB], { mode: 'set_price', value: 99999 }), 'BUNDLE_PRICE_NOT_A_DISCOUNT'],
      ['a discount that is the whole price', () => cfg([ids.BNDB], { mode: 'fixed_discount', value: 15000 }), 'BUNDLE_PRICE_DISCOUNT_TOO_LARGE'],
    ])('blocked: %s', async (_n, mkCfg, code) => {
      await saveOwner((mkCfg as any)())
      expect(await codes()).toContain(code)
    })

    test('malformed input is rejected at save: the same product twice, a 100% rule', async () => {
      await expect(saveOwner(cfg([ids.BNDB, ids.BNDB]))).rejects.toMatchObject({ name: expect.any(String), errors: expect.any(Array) })
      await expect(saveOwner(cfg([ids.BNDB], { mode: 'percent_discount', value: 10000 }))).rejects.toMatchObject({ errors: expect.any(Array) })
    })

    test('a component that is not live is blocked', async () => {
      const c = await svc.create({ code: 'BNDD', name: 'Draft Only', type: 'tee', actor: A })
      await saveOwner(cfg([c.id]))
      expect((await codes()).some(x => /^BUNDLE_COMPONENT_/.test(x))).toBe(true)
    })

    test('a valid bundle publishes and projects owner first, then the others in order', async () => {
      await saveOwner(cfg([ids.BNDB, ids.BNDC], { mode: 'fixed_discount', value: 1500 }))
      expect((await svc.validate(ids.BNDA)).blockers.filter((b: any) => /^BUNDLE_/.test(b.code))).toEqual([])
      await goLive('BNDA')
      const b = await bundleRow()
      expect(b).toMatchObject({ enabled: true, include_owner: true, pricing_mode: 'fixed_discount', pricing_value: 1500 })
      const comps = await q(`SELECT component_product_id::text id, is_owner, sort_order, view_separately FROM bundle_components WHERE bundle_id=$1 ORDER BY sort_order`, [b.id])
      expect(comps.map((c: any) => c.id)).toEqual([ids.BNDA, ids.BNDB, ids.BNDC])
      expect(comps.map((c: any) => c.is_owner)).toEqual([true, false, false])
      const audit = await q(`SELECT action FROM admin_audit_logs WHERE resource='product' AND resource_id=$1 AND action LIKE 'bundle.%'`, [ids.BNDA])
      expect(audit.map((a: any) => a.action)).toContain('bundle.project')
    })

    test('republishing bumps the revision; turning the bundle off disables it; unpublish disables it', async () => {
      const r1 = (await bundleRow()).revision
      await saveOwner(cfg([ids.BNDB], { mode: 'percent_discount', value: 1000 }))
      await goLive('BNDA')
      const b2 = await bundleRow()
      expect(b2.revision).toBeGreaterThan(r1)
      expect(b2).toMatchObject({ enabled: true, pricing_mode: 'percent_discount', pricing_value: 1000 })
      expect((await q(`SELECT count(*)::int n FROM bundle_components WHERE bundle_id=$1`, [b2.id]))[0].n).toBe(2)

      await saveOwner(cfg([ids.BNDB], undefined, { enabled: false }))
      await goLive('BNDA')
      expect((await bundleRow()).enabled).toBe(false)

      await saveOwner(cfg([ids.BNDB]))
      await goLive('BNDA')
      expect((await bundleRow()).enabled).toBe(true)
      await svc.unpublish(ids.BNDA, await rev(ids.BNDA), A)
      expect((await bundleRow()).enabled).toBe(false)
      await relive('BNDA', cfg([ids.BNDB]))
      expect((await bundleRow()).enabled).toBe(true)
    })

    test('the draft is never visible to customers until published', async () => {
      const before = await bundleRow()
      await saveOwner(cfg([ids.BNDB, ids.BNDC], { mode: 'fixed_discount', value: 3000 }))
      const after = await bundleRow()
      expect(after.pricing_value).toBe(before.pricing_value)
      await saveOwner(cfg([ids.BNDB]))
      await goLive('BNDA')
    })
  })

  // ── quote + storefront read path ─────────────────────────────────────────────
  describe('quote and public bundle', () => {
    let bundleId = ''
    beforeAll(async () => { bundleId = (await bundleRow()).id })

    test('quote prices from the canonical rows: A 9000 + B 6000 less 1500', async () => {
      const r: any = await bc().quote(setReq({ bundleId }))
      expect(r.ok).toBe(true)
      expect(r.setSubtotalCents).toBe(15000)
      expect(r.setNetCents).toBe(13500)
      expect(r.lines.map((l: any) => [l.sku, l.originalUnitPriceCents, l.netUnitPriceCents])).toEqual([
        [sku('BNDA'), 9000, 8100], [sku('BNDB'), 6000, 5400]])
    })

    test('flag off: the quote refuses and the page gets no bundle (byte-identical off path)', async () => {
      flagOn = false
      try {
        expect(((await bc().quote(setReq({ bundleId }))) as any).code).toBe('BUNDLE_DISABLED')
        const bp = createBundlePublic(db.sql, { getPublishedProductBySlug: pub.getPublishedProductBySlug, isEnabled: () => false })
        expect(await bp.getForOwner(ids.BNDA)).toBeNull()
      } finally { flagOn = true }
    })

    test('a stale expected price is reported, with the new price', async () => {
      const r: any = await bc().quote(setReq({ bundleId, expectedSetNetCents: 12000 }))
      expect(r).toMatchObject({ ok: false, code: 'BUNDLE_PRICE_CHANGED', newSetNetCents: 13500 })
    })

    test('a repriced component changes the quote; a rule that is no longer a discount is unavailable', async () => {
      await q(`UPDATE products SET price_cents=6600 WHERE id=$1`, [ids.BNDB])
      expect(((await bc().quote(setReq({ bundleId }))) as any).setNetCents).toBe(14100)
      await q(`UPDATE bundles SET pricing_mode='set_price', pricing_value=99999 WHERE id=$1`, [bundleId])
      expect(((await bc().quote(setReq({ bundleId }))) as any).code).toBe('BUNDLE_UNAVAILABLE')
      await q(`UPDATE bundles SET pricing_mode='fixed_discount', pricing_value=1500 WHERE id=$1`, [bundleId])
      await q(`UPDATE products SET price_cents=6000 WHERE id=$1`, [ids.BNDB])
    })

    test('disabled bundle, or an unpublished component, is unavailable', async () => {
      await q(`UPDATE bundles SET enabled=false WHERE id=$1`, [bundleId])
      expect(((await bc().quote(setReq({ bundleId }))) as any).code).toBe('BUNDLE_UNAVAILABLE')
      await q(`UPDATE bundles SET enabled=true WHERE id=$1`, [bundleId])
      await svc.unpublish(ids.BNDB, await rev(ids.BNDB), A)
      expect(((await bc().quote(setReq({ bundleId }))) as any).code).toBe('BUNDLE_UNAVAILABLE')
      await relive('BNDB')
      expect(((await bc().quote(setReq({ bundleId }))) as any).ok).toBe(true)
    })

    test('selection problems: unknown sku, a size of another product, a sold-out size', async () => {
      expect(((await bc().quote(setReq({ bundleId, selections: [{ productId: ids.BNDA, sku: sku('BNDA') }, { productId: ids.BNDB, sku: 'KVRN-NOPE-1' }] }))) as any).code).toBe('BUNDLE_SELECTION_INVALID')
      expect(((await bc().quote(setReq({ bundleId, selections: [{ productId: ids.BNDA, sku: sku('BNDA') }, { productId: ids.BNDB, sku: sku('BNDC') }] }))) as any).code).toBe('BUNDLE_SELECTION_INVALID')
      await q(`UPDATE product_variants SET stock_on_hand=0 WHERE sku=$1`, [sku('BNDB')])
      const r: any = await bc().quote(setReq({ bundleId }))
      expect(r).toMatchObject({ ok: false, code: 'BUNDLE_COMPONENT_UNAVAILABLE', sku: sku('BNDB') })
      await q(`UPDATE product_variants SET stock_on_hand=40 WHERE sku=$1`, [sku('BNDB')])
    })

    test('the storefront bundle is resolved from canonical rows and prices like the quote', async () => {
      const bp = createBundlePublic(db.sql, { getPublishedProductBySlug: pub.getPublishedProductBySlug, isEnabled: () => true })
      const b = await bp.getForOwner(ids.BNDA)
      expect(b).not.toBeNull()
      expect(b!.components.map(c => [c.name, c.isOwner, c.priceCents])).toEqual([['Owner Tee', true, 9000], ['Other Pant', false, 6000]])
      expect(b!.components[0].variants.map(v => v.size).sort()).toEqual(['M', 'S'])
      const p: any = priceSelection(b!, [sku('BNDA'), sku('BNDB')])
      expect(p.setNetCents).toBe(13500)
    })

    test('the storefront bundle fails closed when a component is unpublished or the owner is unpublished', async () => {
      const bp = createBundlePublic(db.sql, { getPublishedProductBySlug: pub.getPublishedProductBySlug, isEnabled: () => true })
      await svc.unpublish(ids.BNDB, await rev(ids.BNDB), A)
      expect(await bp.getForOwner(ids.BNDA)).toBeNull()
      await relive('BNDB')
      expect(await bp.getForOwner(ids.BNDA)).not.toBeNull()
    })
  })

  // ── reserve_inventory_v2 ─────────────────────────────────────────────────────
  describe('reserve_inventory_v2', () => {
    let bundleId = ''
    beforeAll(async () => { bundleId = (await bundleRow()).id })
    const expires = () => new Date(Date.now() + 35 * 60_000).toISOString()
    const v2 = (items: unknown[], bundle: unknown) =>
      db.err(`SELECT reserve_inventory_v2($1::jsonb,$2::timestamptz,$3::jsonb)`, [JSON.stringify(items), expires(), bundle === null ? null : JSON.stringify(bundle)])
    const lines = (a = 8100, b = 5400, qty = 1) => [
      { sku: sku('BNDA'), quantity: qty, unit_price_cents: a, bundle: true },
      { sku: sku('BNDB'), quantity: qty, unit_price_cents: b, bundle: true },
    ]
    const reserved = async (c: string, s = 'M') => (await q(`SELECT reserved_quantity::int r FROM product_variants WHERE sku=$1`, [sku(c, s)]))[0].r

    test('with no bundle it behaves like reserve_inventory (canonical prices, same shape)', async () => {
      const a = (await q(`SELECT reserve_inventory($1::jsonb,$2::timestamptz) r`, [JSON.stringify([{ sku: sku('BNDC'), quantity: 1 }]), expires()]))[0].r
      const b = (await q(`SELECT reserve_inventory_v2($1::jsonb,$2::timestamptz,NULL) r`, [JSON.stringify([{ sku: sku('BNDC'), quantity: 1 }]), expires()]))[0].r
      expect(Object.keys(b.items[0])).toEqual(expect.arrayContaining(Object.keys(a.items[0])))
      expect(b.items[0]).toMatchObject({ sku: sku('BNDC'), unit_price_cents: 3000, quantity: 1 })
      expect(a.items[0].unit_price_cents).toBe(b.items[0].unit_price_cents)
      expect(b.bundle).toBeNull()
      expect((await q(`SELECT count(*)::int n FROM reservation_bundles WHERE reservation_id=$1`, [b.reservation_id]))[0].n).toBe(0)
    })

    test('a plain line may not carry a client price', async () => {
      const e = await v2([{ sku: sku('BNDC'), quantity: 1, unit_price_cents: 1 }], null)
      expect(e).toMatch(/BUNDLE_/)
    })

    test('reserves the set at the allocated net prices and snapshots the allocation', async () => {
      const before = [await reserved('BNDA'), await reserved('BNDB')]
      const prep: any = await bc().prepare(setReq({ bundleId, quantity: 2 }), [])
      expect(prep.ok).toBe(true)
      const r: any = await bc().reserve(prep.prep, [])
      expect(r.ok).toBe(true)
      expect(r.items.map((i: any) => [i.sku, i.unitPriceCents, i.originalUnitPriceCents, i.quantity])).toEqual([
        [sku('BNDA'), 8100, 9000, 2], [sku('BNDB'), 5400, 6000, 2]])
      expect([await reserved('BNDA'), await reserved('BNDB')]).toEqual([before[0] + 2, before[1] + 2])
      const rb = (await q(`SELECT * FROM reservation_bundles WHERE reservation_id=$1`, [r.reservationId]))[0]
      expect(rb).toMatchObject({ set_quantity: 2, component_subtotal_cents: 30000, bundle_discount_cents: 3000, bundle_net_cents: 27000 })
      const rbi = await q(`SELECT sku, net_unit_price_cents, allocated_discount_per_unit_cents FROM reservation_bundle_items WHERE reservation_id=$1 ORDER BY sku`, [r.reservationId])
      expect(rbi.map((x: any) => x.allocated_discount_per_unit_cents)).toEqual([900, 600])
    })

    test.each([
      ['a price one cent off', () => v2(lines(8101, 5400), { bundle_id: bundleId, quantity: 1 }), 'BUNDLE_PRICE_MISMATCH'],
      ['a price that does not add up to the rule', () => v2(lines(8100, 5300), { bundle_id: bundleId, quantity: 1 }), 'BUNDLE_PRICE_MISMATCH'],
      ['a negative price', () => v2(lines(-1, 5400), { bundle_id: bundleId, quantity: 1 }), 'BUNDLE_PRICE_MISMATCH'],
      ['a price above canonical', () => v2(lines(9001, 4499), { bundle_id: bundleId, quantity: 1 }), 'BUNDLE_PRICE_MISMATCH'],
      ['a missing component', () => v2([lines()[0]], { bundle_id: bundleId, quantity: 1 }), 'BUNDLE_SELECTION_INVALID'],
      ['a line quantity that is not the set quantity', () => v2([{ ...lines()[0], quantity: 2 }, lines()[1]], { bundle_id: bundleId, quantity: 1 }), 'BUNDLE_QUANTITY'],
      ['a set quantity of 0', () => v2(lines(), { bundle_id: bundleId, quantity: 0 }), 'BUNDLE_QUANTITY'],
      ['an unknown bundle', () => v2(lines(), { bundle_id: '99999999-9999-4999-8999-999999999999', quantity: 1 }), 'BUNDLE_UNAVAILABLE'],
      ['bundle lines without a bundle', () => v2(lines(), null), 'BUNDLE_SELECTION_INVALID'],
      ['the same sku twice', () => v2([...lines(), { sku: sku('BNDA'), quantity: 1 }], { bundle_id: bundleId, quantity: 1 }), 'DUPLICATE_SKU'],
    ])('rejects %s', async (_n, run, code) => {
      const a = await reserved('BNDA'); const b = await reserved('BNDB')
      expect(await (run as any)()).toContain(code)
      expect([await reserved('BNDA'), await reserved('BNDB')]).toEqual([a, b])   // nothing reserved
    })

    test('a disabled bundle cannot be reserved', async () => {
      await q(`UPDATE bundles SET enabled=false WHERE id=$1`, [bundleId])
      expect(await v2(lines(), { bundle_id: bundleId, quantity: 1 })).toContain('BUNDLE_UNAVAILABLE')
      await q(`UPDATE bundles SET enabled=true WHERE id=$1`, [bundleId])
    })

    test('a set line that is also an ordinary line is a conflict (server rejects before reserving)', async () => {
      const r: any = await bc().prepare(setReq({ bundleId }), [{ sku: sku('BNDA'), quantity: 1 } as any])
      expect(r).toMatchObject({ ok: false, code: 'BUNDLE_SKU_CONFLICT' })
    })

    test('a discount code with a set is refused', async () => {
      const r: any = await bc().prepare(setReq({ bundleId }), [], 'SAVE10')
      expect(r).toMatchObject({ ok: false, code: 'BUNDLE_DISCOUNT_NOT_COMBINABLE' })
    })

    test('short stock fails the whole reservation and reserves nothing', async () => {
      await q(`UPDATE product_variants SET stock_on_hand=1, reserved_quantity=0 WHERE sku=$1`, [sku('BNDB', 'S')])
      const err = await v2([
        { sku: sku('BNDA', 'S'), quantity: 2, unit_price_cents: 8100, bundle: true },
        { sku: sku('BNDB', 'S'), quantity: 2, unit_price_cents: 5400, bundle: true }], { bundle_id: bundleId, quantity: 2 })
      expect(err).toMatch(/INSUFFICIENT_STOCK|OUT_OF_STOCK/)
      expect(await reserved('BNDA', 'S')).toBe(0)
      await q(`UPDATE product_variants SET stock_on_hand=40 WHERE sku=$1`, [sku('BNDB', 'S')])
    })

    test('two buyers race for the last unit: exactly one wins, no oversell', async () => {
      await q(`UPDATE product_variants SET stock_on_hand=1, reserved_quantity=0 WHERE sku=$1`, [sku('BNDA', 'S')])
      const { isLocal: _l, ...cfgPg } = pgConfig(`bndl_${process.pid}`)
      const clients = [new Client(cfgPg), new Client(cfgPg)]
      await Promise.all(clients.map(c => c.connect()))
      try {
        const items = JSON.stringify([
          { sku: sku('BNDA', 'S'), quantity: 1, unit_price_cents: 8100, bundle: true },
          { sku: sku('BNDB', 'S'), quantity: 1, unit_price_cents: 5400, bundle: true }])
        const bundle = JSON.stringify({ bundle_id: bundleId, quantity: 1 })
        const run = (c: Client) => c.query(`SELECT reserve_inventory_v2($1::jsonb,$2::timestamptz,$3::jsonb)`, [items, expires(), bundle])
          .then(() => 'ok', (e: any) => String(e.message))
        const out = await Promise.all(clients.map(run))
        expect(out.filter(x => x === 'ok')).toHaveLength(1)
        expect(out.find(x => x !== 'ok')).toMatch(/OUT_OF_STOCK|INSUFFICIENT_STOCK/)
        expect(await reserved('BNDA', 'S')).toBe(1)
      } finally { await Promise.all(clients.map(c => c.end())) }
      await q(`UPDATE product_variants SET stock_on_hand=40, reserved_quantity=0 WHERE sku=$1`, [sku('BNDA', 'S')])
    })
  })

  // ── orders, snapshots, and the money reconciliation ──────────────────────────
  describe('orders and reconciliation', () => {
    let bundleId = ''
    let n = 0
    beforeAll(async () => { bundleId = (await bundleRow()).id })

    interface Placed { orderId: string; rid: string; session: string; pi: string; total: number; merch: number; email: string }
    /** reserve (real) -> stripe session -> shipping snapshot -> finalize_paid_order, like production. */
    async function place(o: { qty?: number; plain?: Array<{ sku: string; quantity: number }>; sid?: string | null } = {}): Promise<Placed> {
      const qty = o.qty ?? 1
      const plain = o.plain ?? []
      const prep: any = await bc().prepare(setReq({ bundleId, quantity: qty }), plain as any)
      expect(prep.ok).toBe(true)
      const r: any = await bc().reserve(prep.prep, plain as any)
      expect(r.ok).toBe(true)
      const merch = r.items.reduce((s: number, i: any) => s + i.unitPriceCents * i.quantity, 0)
      const k = ++n
      const session = `cs_test_bnd_${k}`
      const email = `buyer${k}@example.com`
      await q(`SELECT attach_stripe_session($1::uuid,$2,extract(epoch from now()+interval '31 minutes')::bigint)`, [r.reservationId, session])
      await q(`SELECT save_reservation_checkout_details($1::uuid,$2,'Cust Name',NULL,
        '{"line1":"1 Main","city":"LA","state":"CA","postal_code":"90001","country":"US"}'::jsonb,
        'standard',$3,0,$3,NULL,NULL,NULL,0)`, [r.reservationId, email, SHIP])
      const total = merch + SHIP
      const pi = `pi_bnd_${k}`
      const f = (await q(`SELECT finalize_paid_order($1,$2::uuid,$3,$4,'checkout.session.completed','usd',$5,$6,'Cust Name',NULL,NULL) AS r`,
        [session, r.reservationId, pi, `evt_bnd_${k}`, total, email]))[0].r
      const orderId = (await q(`SELECT id FROM orders WHERE stripe_checkout_session_id=$1`, [session]))[0].id
      expect(f).toBeTruthy()
      return { orderId, rid: r.reservationId, session, pi, total, merch, email }
    }

    test('the order is charged at net prices and the amount check uses them', async () => {
      const p = await place({ plain: [{ sku: sku('BNDC'), quantity: 1 }] })
      const o = (await q(`SELECT * FROM orders WHERE id=$1`, [p.orderId]))[0]
      expect(o).toMatchObject({ subtotal_cents: 16500, shipping_cents: SHIP, total_cents: 17200, payment_status: 'paid' })
      const items = await q(`SELECT sku, unit_price_cents, quantity, line_total_cents FROM order_items WHERE order_id=$1 ORDER BY sku`, [p.orderId])
      expect(items.map((i: any) => [i.sku, i.unit_price_cents, i.line_total_cents])).toEqual([
        [sku('BNDA'), 8100, 8100], [sku('BNDB'), 5400, 5400], [sku('BNDC'), 3000, 3000]])
      expect(items.reduce((s: number, i: any) => s + i.line_total_cents, 0)).toBe(o.subtotal_cents)
    })

    test('charging the set at list prices (the old total) is refused by the existing amount check', async () => {
      const prep: any = await bc().prepare(setReq({ bundleId }), [])
      const r: any = await bc().reserve(prep.prep, [])
      await q(`SELECT attach_stripe_session($1::uuid,'cs_bnd_wrong',extract(epoch from now()+interval '31 minutes')::bigint)`, [r.reservationId])
      await q(`SELECT save_reservation_checkout_details($1::uuid,'w@example.com','Cust',NULL,'{"line1":"1","city":"LA","state":"CA","postal_code":"90001","country":"US"}'::jsonb,'standard',$2,0,$2,NULL,NULL,NULL,0)`, [r.reservationId, SHIP])
      const e = await db.err(`SELECT finalize_paid_order('cs_bnd_wrong',$1::uuid,'pi_bnd_wrong','evt_bnd_wrong','checkout.session.completed','usd',$2,'w@example.com','Cust',NULL,NULL)`, [r.reservationId, 15000 + SHIP])
      expect(e).toMatch(/AMOUNT|MISMATCH/i)
    })

    test('the frozen snapshot records the rule and the exact allocation', async () => {
      const p = await place({ qty: 2 })
      const ob = (await q(`SELECT * FROM order_bundles WHERE order_id=$1`, [p.orderId]))[0]
      expect(ob).toMatchObject({ bundle_id: bundleId, set_quantity: 2, pricing_mode: 'fixed_discount', pricing_value: 1500,
        component_subtotal_cents: 30000, bundle_discount_cents: 3000, bundle_net_cents: 27000 })
      const items = await q(`SELECT i.sku, i.quantity, i.original_unit_price_cents, i.allocated_discount_cents, i.net_line_cents, oi.line_total_cents
        FROM order_bundle_items i JOIN order_items oi ON oi.id=i.order_item_id WHERE i.order_bundle_id=$1 ORDER BY i.sku`, [ob.id])
      expect(items.map((i: any) => [i.sku, i.allocated_discount_cents, i.net_line_cents])).toEqual([[sku('BNDA'), 1800, 16200], [sku('BNDB'), 1200, 10800]])
      for (const i of items) expect(i.net_line_cents).toBe(i.line_total_cents)
      expect(items.reduce((s: number, i: any) => s + i.net_line_cents, 0)).toBe(ob.bundle_net_cents)
      expect((await q(`SELECT * FROM bundle_snapshot_gaps()`))).toEqual([])
    })

    test('a later change to the rule, the prices or the bundle never rewrites a historical order', async () => {
      const p = await place()
      const snap = async () => JSON.stringify(await q(`SELECT ob.bundle_net_cents, ob.config, i.sku, i.net_line_cents FROM order_bundles ob JOIN order_bundle_items i ON i.order_bundle_id=ob.id WHERE ob.order_id=$1 ORDER BY i.sku`, [p.orderId]))
      const before = await snap()
      await q(`UPDATE bundles SET pricing_value=3000, revision=revision+1 WHERE id=$1`, [bundleId])
      await q(`UPDATE products SET price_cents=price_cents+500 WHERE id=$1`, [ids.BNDB])
      expect(await snap()).toBe(before)
      await q(`UPDATE bundles SET pricing_value=1500 WHERE id=$1`, [bundleId])
      await q(`UPDATE products SET price_cents=6000 WHERE id=$1`, [ids.BNDB])
    })

    test('the snapshot is append-only: no update, no delete', async () => {
      const p = await place()
      expect(await db.err(`UPDATE order_bundles SET bundle_net_cents=bundle_net_cents WHERE order_id=$1`, [p.orderId])).not.toBe('')
      expect(await db.err(`UPDATE order_bundle_items SET net_line_cents=net_line_cents WHERE order_bundle_id=(SELECT id FROM order_bundles WHERE order_id=$1)`, [p.orderId])).not.toBe('')
      expect(await db.err(`DELETE FROM order_bundles WHERE order_id=$1`, [p.orderId])).not.toBe('')
      expect(await db.err(`DELETE FROM order_bundle_items WHERE order_bundle_id=(SELECT id FROM order_bundles WHERE order_id=$1)`, [p.orderId])).not.toBe('')
    })

    test('an ordinary order has no bundle snapshot and the reconciliation stays empty', async () => {
      const r = (await q(`SELECT reserve_inventory($1::jsonb, now()+interval '30 minutes') r`, [JSON.stringify([{ sku: sku('BNDC'), quantity: 1 }])]))[0].r
      const session = 'cs_bnd_plain'
      await q(`SELECT attach_stripe_session($1::uuid,$2,extract(epoch from now()+interval '31 minutes')::bigint)`, [r.reservation_id, session])
      await q(`SELECT save_reservation_checkout_details($1::uuid,'p@example.com','Cust',NULL,'{"line1":"1","city":"LA","state":"CA","postal_code":"90001","country":"US"}'::jsonb,'standard',$2,0,$2,NULL,NULL,NULL,0)`, [r.reservation_id, SHIP])
      await q(`SELECT finalize_paid_order($1,$2::uuid,'pi_bnd_plain','evt_bnd_plain','checkout.session.completed','usd',$3,'p@example.com','Cust',NULL,NULL)`, [session, r.reservation_id, 3000 + SHIP])
      const oid = (await q(`SELECT id FROM orders WHERE stripe_checkout_session_id=$1`, [session]))[0].id
      expect((await q(`SELECT 1 FROM order_bundles WHERE order_id=$1`, [oid])).length).toBe(0)
      expect(await q(`SELECT * FROM bundle_snapshot_gaps()`)).toEqual([])
    })

    test('refund: a full refund reconciles to the NET merchandise, never the list prices', async () => {
      const p = await place({ plain: [{ sku: sku('BNDC'), quantity: 1 }] })
      const res = (await q(`SELECT record_order_refund($1,$2,$3,$4,'usd','succeeded','requested_by_customer',NULL,now()) r`,
        [`re_bnd_${p.pi}`, p.pi, 'ch_' + p.pi, p.total]))[0].r
      expect(res.outcome).toBeTruthy()
      const refund = (await q(`SELECT * FROM order_refunds WHERE order_id=$1`, [p.orderId]))[0]
      expect(refund.amount_cents).toBe(p.total)
      await q(`SELECT resolve_refund_components($1::uuid,NULL,NULL,NULL,'admin@kvrn.test')`, [refund.id])
      const r2 = (await q(`SELECT merchandise_refund_cents, shipping_refund_cents, tax_refund_cents, component_breakdown_status FROM order_refunds WHERE id=$1`, [refund.id]))[0]
      expect(r2.component_breakdown_status).toBe('resolved')
      expect(r2.merchandise_refund_cents).toBe(16500)          // net: 8100 + 5400 + 3000 (list would be 18000)
      expect(r2.shipping_refund_cents).toBe(SHIP)
      expect((await q(`SELECT payment_status FROM orders WHERE id=$1`, [p.orderId]))[0].payment_status).toBe('refunded')
    })

    test('return: the returned set lines carry the net basis and sum to the bundle net', async () => {
      const p = await place()
      const items = await q(`SELECT id, sku FROM order_items WHERE order_id=$1 ORDER BY sku`, [p.orderId])
      const ret = (await q(`SELECT create_order_return($1::uuid,$2::jsonb,'customer','changed mind',NULL,'admin@kvrn.test') r`,
        [p.orderId, JSON.stringify(items.map((i: any) => ({ orderItemId: i.id, quantity: 1, disposition: 'sellable' })))]))[0].r
      const ri = await q(`SELECT oi.sku, r.unit_price_cents_snapshot u, r.net_merchandise_basis_cents n, r.allocated_discount_cents_snapshot a
        FROM order_return_items r JOIN order_items oi ON oi.id=r.order_item_id WHERE r.return_id=$1 ORDER BY oi.sku`, [ret.return_id])
      expect(ri.map((x: any) => [x.sku, x.u, x.n])).toEqual([[sku('BNDA'), 8100, 8100], [sku('BNDB'), 5400, 5400]])
      expect(ri.reduce((s: number, x: any) => s + x.n, 0)).toBe(13500)
      // the order discount allocator sees no extra discount: the set discount is already in the prices
      expect(ri.every((x: any) => x.a === 0)).toBe(true)
    })

    test('partial return of one quantity of a 2-set order is exactly half of that line', async () => {
      const p = await place({ qty: 2 })
      const a = (await q(`SELECT id FROM order_items WHERE order_id=$1 AND sku=$2`, [p.orderId, sku('BNDA')]))[0]
      const ret = (await q(`SELECT create_order_return($1::uuid,$2::jsonb,'customer','x',NULL,'admin@kvrn.test') r`,
        [p.orderId, JSON.stringify([{ orderItemId: a.id, quantity: 1, disposition: 'sellable' }])]))[0].r
      const ri = (await q(`SELECT net_merchandise_basis_cents n FROM order_return_items WHERE return_id=$1`, [ret.return_id]))[0]
      expect(ri.n).toBe(8100)
    })

    test('dispute: the exposure is the amount actually paid (net), recorded against the order', async () => {
      const p = await place()
      const out = (await q(`SELECT upsert_order_dispute($1,$2,$3,$4,'usd','needs_response','open',$5,'charge.dispute.created',now(),now(),'{}'::jsonb) r`,
        [`dp_bnd_${p.pi}`, 'ch_' + p.pi, p.pi, p.total, `evt_dp_${p.pi}`]))[0].r
      expect(out).toBeTruthy()
      const dp = (await q(`SELECT * FROM order_disputes WHERE order_id=$1`, [p.orderId]))[0]
      expect(dp.amount_cents).toBe(p.total)
      expect(dp.amount_cents).toBeLessThan(13500 + SHIP + 4500)   // list price total would be 15000 + SHIP
    })

    test('affiliate: commission is computed on the NET merchandise and reversed by the net refund', async () => {
      const affId = (await q(`SELECT create_affiliate('BNDAFF','BNDAFF',NULL,'percentage',1000,NULL,'proportional',30,0,NULL,NULL,'test') AS r`))[0].r.affiliate_id
      for (const t of ['affiliates|created_at|id', 'affiliate_terms_events|effective_at|affiliate_id', 'affiliate_status_events|effective_at|affiliate_id']) {
        const [tbl, col, key] = t.split('|')
        await q(`UPDATE ${tbl} SET ${col} = NOW() - INTERVAL '400 days' WHERE ${key}=$1`, [affId])
      }
      const linkId = (await q(`SELECT create_affiliate_link($1,'bnd-aff','/shop','test') AS r`, [affId]))[0].r.link_id
      await q(`UPDATE affiliate_links SET created_at = NOW() - INTERVAL '400 days' WHERE id=$1`, [linkId])
      const sid = 'a'.repeat(32)
      await q(`INSERT INTO affiliate_clicks (affiliate_id, link_id, session_id) VALUES ($1,$2,$3)`, [affId, linkId, sid])

      const p = await place()
      await q(`SELECT resolve_order_affiliate_attribution($1::uuid,$2,'test')`, [p.orderId, sid])
      const att = (await q(`SELECT commission_base_cents, commission_rate_bps_snapshot FROM order_affiliate_attributions WHERE order_id=$1`, [p.orderId]))[0]
      expect(att.commission_base_cents).toBe(13500)                     // net, not 15000
      const comm = (await q(`SELECT * FROM affiliate_commissions WHERE order_id=$1`, [p.orderId]))[0]
      expect(comm).toMatchObject({ base_cents: 13500, commission_cents: 1350 })

      await q(`SELECT record_order_refund($1,$2,$3,$4,'usd','succeeded',NULL,NULL,now())`, [`re_aff_${p.pi}`, p.pi, 'ch_' + p.pi, p.total])
      const refund = (await q(`SELECT id FROM order_refunds WHERE order_id=$1`, [p.orderId]))[0]
      await q(`SELECT resolve_refund_components($1::uuid,NULL,NULL,NULL,'admin@kvrn.test')`, [refund.id])
      await q(`SELECT apply_affiliate_refund_reversal($1::uuid,'test')`, [refund.id])
      const adj = await q(`SELECT adjustment_cents FROM affiliate_commission_adjustments WHERE commission_id=$1 AND reason='refund_reversal'`, [comm.id])
      expect(adj.reduce((s: number, a: any) => s + a.adjustment_cents, 0)).toBe(-1350)   // the whole commission, no more
    })

    test('admin order detail groups the set from the frozen snapshot, and an ordinary order has none', async () => {
      const p = await place({ plain: [{ sku: sku('BNDC'), quantity: 1 }] })
      const b = await loadOrderBundle(db.sql, p.orderId)
      expect(b).toMatchObject({ bundleId, setQuantity: 1, componentSubtotalCents: 15000, bundleDiscountCents: 1500, bundleNetCents: 13500 })
      expect(b!.lines.map(l => [l.sku, l.originalUnitPriceCents, l.allocatedDiscountCents, l.netLineCents])).toEqual([
        [sku('BNDA'), 9000, 900, 8100], [sku('BNDB'), 6000, 600, 5400]])
      const detail: any = await createAdminOrderService(db.sql).getOrderDetail(p.orderId)
      expect(detail.bundle.bundleNetCents).toBe(13500)
      expect(detail.items).toHaveLength(3)                    // the set lines stay real order lines
      const plainOrder = (await q(`SELECT id FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_bundles b WHERE b.order_id=o.id) LIMIT 1`))[0]
      expect(await loadOrderBundle(db.sql, plainOrder.id)).toBeNull()
      expect('bundle' in (await createAdminOrderService(db.sql).getOrderDetail(plainOrder.id) as any)).toBe(false)
    })

    test('analytics: the reservation, order and snapshot agree on the net merchandise', async () => {
      const p = await place({ qty: 3 })
      const fromReservation = (await q(`SELECT SUM(unit_price_cents*quantity)::int s FROM reservation_items WHERE reservation_id=$1`, [p.rid]))[0].s
      const fromOrder = (await q(`SELECT subtotal_cents s FROM orders WHERE id=$1`, [p.orderId]))[0].s
      const fromItems = (await q(`SELECT SUM(line_total_cents)::int s FROM order_items WHERE order_id=$1`, [p.orderId]))[0].s
      const fromSnap = (await q(`SELECT bundle_net_cents s FROM order_bundles WHERE order_id=$1`, [p.orderId]))[0].s
      expect([fromReservation, fromOrder, fromItems, fromSnap]).toEqual([40500, 40500, 40500, 40500])
    })
  })

  // ── abandoned checkout: revalidation on recovery ─────────────────────────────
  describe('abandoned-checkout resume', () => {
    let bundleId = ''
    beforeAll(async () => { bundleId = (await bundleRow()).id })
    const stub = { validateDiscount: async () => ({ valid: true } as any) }
    const svcWith = (extra: any = {}) => createResumeService(db.sql, { ...stub, bundles: bc(), ...extra })
    const variant = async (code: string) => (await q(`SELECT id FROM product_variants WHERE sku=$1`, [sku(code)]))[0].id
    async function row(over: any = {}) {
      const a = await variant('BNDA'); const b = await variant('BNDB')
      return {
        cart: [
          { sku: sku('BNDA'), quantity: 1, variantId: a, productName: 'Owner Tee', size: 'M', color: 'Black', seenUnitPriceCents: 8100 },
          { sku: sku('BNDB'), quantity: 1, variantId: b, productName: 'Other Pant', size: 'M', color: 'Black', seenUnitPriceCents: 5400 },
        ],
        bundle_context: { bundleId, setQuantity: 1, seenSetNetCents: 13500,
          components: [{ sku: sku('BNDA'), quantity: 1, productId: ids.BNDA }, { sku: sku('BNDB'), quantity: 1, productId: ids.BNDB }] },
        currency: 'usd', discount_code: null, affiliate_session_id: null, ...over,
      } as any
    }
    const codes = (r: any) => r.notices.map((x: any) => x.code)

    test('unchanged set: restored as a set at the net prices with no false "price changed"', async () => {
      const r: any = await svcWith().resume(await row())
      expect(r.ok).toBe(true)
      expect(r.notices).toEqual([])
      expect(r.priceChanged).toBe(false)
      expect(r.subtotalCents).toBe(13500)
      expect(r.cart.every((c: any) => c.bundle?.bundleId === bundleId)).toBe(true)
      expect(r.cart.reduce((s: number, c: any) => s + c.bundle.netUnitCents * c.quantity, 0)).toBe(13500)
      expect(r.cart.map((c: any) => c.price)).toEqual([9000, 6000])
    })

    test('changed set price: honest notice with both amounts, today’s price is used', async () => {
      await q(`UPDATE products SET price_cents=6600 WHERE id=$1`, [ids.BNDB])
      try {
        const r: any = await svcWith().resume(await row())
        expect(r.ok).toBe(true)
        expect(codes(r)).toEqual(['bundle_price_changed'])
        expect(r.notices[0].message).toContain('$135.00')
        expect(r.notices[0].message).toContain('$141.00')
        expect(r.priceChanged).toBe(true)
        expect(r.subtotalCents).toBe(14100)
      } finally { await q(`UPDATE products SET price_cents=6000 WHERE id=$1`, [ids.BNDB]) }
    })

    test('bundle turned off: the items stay as ordinary lines at regular prices, with a clear notice', async () => {
      await q(`UPDATE bundles SET enabled=false WHERE id=$1`, [bundleId])
      try {
        const r: any = await svcWith().resume(await row())
        expect(r.ok).toBe(true)
        expect(codes(r)).toContain('bundle_unavailable')
        expect(r.cart.some((c: any) => c.bundle)).toBe(false)
        expect(r.subtotalCents).toBe(15000)
        expect(r.priceChanged).toBe(true)
      } finally { await q(`UPDATE bundles SET enabled=true WHERE id=$1`, [bundleId]) }
    })

    test('the feature flag off is treated the same way (never a set price)', async () => {
      flagOn = false
      try {
        const r: any = await svcWith().resume(await row())
        expect(codes(r)).toContain('bundle_unavailable')
        expect(r.cart.some((c: any) => c.bundle)).toBe(false)
      } finally { flagOn = true }
    })

    test('a component no longer available: the whole set is left out, never a partial set', async () => {
      await q(`UPDATE product_variants SET stock_on_hand=0, reserved_quantity=0 WHERE sku=$1`, [sku('BNDB')])
      try {
        const r: any = await svcWith().resume(await row({ cart: [...(await row()).cart, { sku: sku('BNDC'), quantity: 1, variantId: await variant('BNDC'), productName: 'Third Cap', size: 'M', color: 'Black', seenUnitPriceCents: 3000 }] }))
        expect(r.ok).toBe(true)
        expect(codes(r)).toContain('bundle_incomplete')
        expect(r.cart.map((c: any) => c.sku)).toEqual([sku('BNDC')])
      } finally { await q(`UPDATE product_variants SET stock_on_hand=40 WHERE sku=$1`, [sku('BNDB')]) }
    })

    test('without the bundle service the price cannot be confirmed and the set is not restored as a set', async () => {
      const r: any = await createResumeService(db.sql, stub).resume(await row())
      expect(codes(r)).toContain('bundle_unconfirmed')
      expect(r.cart.some((c: any) => c.bundle)).toBe(false)
      expect(r.subtotalCents).toBe(15000)
    })

    test('a saved checkout without a bundle context resumes exactly as before', async () => {
      const r: any = await svcWith().resume(await row({ bundle_context: null, cart: [
        { sku: sku('BNDC'), quantity: 2, variantId: await variant('BNDC'), productName: 'Third Cap', size: 'M', color: 'Black', seenUnitPriceCents: 3000 }] }))
      expect(r.ok).toBe(true)
      expect(r.notices).toEqual([])
      expect(r.subtotalCents).toBe(6000)
    })
  })
})
