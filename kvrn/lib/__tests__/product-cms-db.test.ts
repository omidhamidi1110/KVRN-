// Migration 028 + the product service/read path against REAL PostgreSQL (throwaway database).
// Covers: bootstrap equivalence, create/draft/blockers, atomic publish (incl. the go-live trigger
// reached directly), slug redirects, SKU rules, scheduled publish, content-only rollback, order
// price snapshots, duplicate, unpublish/archive, bulk partial failure, audit rows, stale revisions,
// cache-invalidation failure surfacing, collections and sitemap entries.
import fs from 'fs'
import path from 'path'
import { createFiDb, HAVE_DB, ROOT, type FiDb } from './helpers/fi-pg'
import { createProductService, ProductBlockedError, ProductInputError, type ProductService } from '../product-service'
import { createProductPublic, type ProductPublic } from '../product-public'
import { CmsError } from '../cms-core'
import { emptySnapshot, type ProductSnapshot } from '../product-model'
import { getProductBySlug } from '@/data/products'

const d = HAVE_DB ? describe : describe.skip
const A = 'owner@kvrn.test'
const HEX = 'a'.repeat(64)

function slot(i: number) {
  return { ref: { kind: 'static', src: `/images/products/kvrn-phantom-hoodie/${i}.webp` }, alt: `Test view ${i}`, focal: { mobile: null, desktop: null } }
}

/** A complete, publishable snapshot for product code TEE1. */
function fullSnap(over: Partial<ProductSnapshot> = {}, code = 'TEE1'): any {
  const s = emptySnapshot({ name: 'Test Tee', slug: 'test-tee', productType: 'tee' })
  s.shortDescription = 'A test tee.'
  s.description = 'A tee made for tests.'
  s.constructionDetails = ['Cotton.']
  s.media = { hero: slot(1) as any, gallery: [1, 2, 3, 4, 5].map(slot) as any }
  s.colors = [{ key: 'black', code: 'BLK', name: 'Black', hex: '#111111', media: null }]
  s.commerce = {
    priceCents: 6500, shipping: { weightLb: 1.2, lengthIn: 12, widthIn: 10, heightIn: 1 }, originCountry: null, hsCode: null,
    variants: [
      { id: null, sku: `KVRN-${code}-BLK-S`, colorCode: 'BLK', size: 'S', sizeSort: 2, active: true },
      { id: null, sku: `KVRN-${code}-BLK-M`, colorCode: 'BLK', size: 'M', sizeSort: 3, active: true },
    ],
  }
  s.seo = { ...s.seo, title: 'Test Tee | KVRN', description: 'A test tee.' }
  return { ...s, ...over }
}

d('028 product catalog CMS (real PG)', () => {
  let db: FiDb, svc: ProductService, pub: ProductPublic
  const calls: any[] = []
  let invalidateResult: any = { id: 'x', ok: true, paths: [], tags: [] }

  const q = (t: string, p: unknown[] = []) => db.q(t, p)
  const prod = async (id: string) => (await q(`SELECT * FROM products WHERE id=$1`, [id]))[0]
  const ent = async (id: string) => (await q(`SELECT * FROM content_entities WHERE entity_type='product' AND entity_id=$1`, [id]))[0]
  const audit = async (id: string) => (await q(`SELECT action, actor_email FROM admin_audit_logs WHERE resource='product' AND resource_id=$1 ORDER BY created_at, id`, [id])).map(r => r.action)

  /** Create TEE1-style draft with a full snapshot saved. */
  async function makeDraft(code: string, name: string, slug: string, over: Partial<ProductSnapshot> = {}) {
    const c = await svc.create({ code, name, type: 'tee', slug, actor: A })
    const snap = fullSnap({ name, slug, ...over }, code)
    const saved = await svc.saveDraft(c.id, snap, c.revision, A)
    return { id: c.id, revision: saved.revision, snap, saved }
  }
  async function makeLive(code: string, name: string, slug: string, over: Partial<ProductSnapshot> = {}) {
    const m = await makeDraft(code, name, slug, over)
    const p = await svc.publish(m.id, m.revision, A)
    return { ...m, publish: p }
  }
  const rev = async (id: string) => (await ent(id)).revision as number

  beforeAll(async () => {
    db = await createFiDb('prodcms')
    // Legacy KVRN products (as production has them), then the bootstrap migration step.
    await db.db.query(fs.readFileSync(path.join(ROOT, 'db/seed.sql'), 'utf8'))
    await db.db.query(fs.readFileSync(path.join(ROOT, 'db/migrations/006_product_shipping_data.sql'), 'utf8'))
    await q(`UPDATE product_variants SET stock_on_hand = 5`)
    await q(`SELECT catalog_bootstrap_products()`)
    svc = createProductService(db.sql, { invalidate: async (_s, t, c) => { calls.push({ t, c }); return invalidateResult } })
    pub = createProductPublic(db.sql)
  }, 180000)
  afterAll(async () => { await db?.close() })

  // ── bootstrap ────────────────────────────────────────────────────────────────
  describe('bootstrap of the two live products', () => {
    test('legacy products are published, commerce untouched, and re-running is a no-op', async () => {
      const rows = await q(`SELECT product_code, slug, price_cents, active, catalog_origin, product_type FROM products ORDER BY product_code`)
      expect(rows).toEqual([
        { product_code: 'PKHH', slug: 'project-kvrn-heavyweight-hoodie', price_cents: 8000, active: true, catalog_origin: 'legacy', product_type: 'hoodie' },
        { product_code: 'PKHSP', slug: 'project-kvrn-heavyweight-sweatpants', price_cents: 8000, active: true, catalog_origin: 'legacy', product_type: 'sweatpants' },
      ])
      expect((await q(`SELECT COUNT(*)::int n FROM content_entities WHERE entity_type='product'`))[0].n).toBe(2)
      expect((await q(`SELECT SUM(stock_on_hand)::int s FROM product_variants`))[0].s).toBe(60)
      const again = await q(`SELECT catalog_bootstrap_products() r`)
      expect(again[0].r).toEqual([])
      expect((await q(`SELECT COUNT(*)::int n FROM content_versions WHERE entity_type='product'`))[0].n).toBe(2)
    })

    test.each(['kvrn-phantom-hoodie', 'kvrn-phantom-sweatpants'])('%s: CMS rendering inputs equal the coded data', async (slug) => {
      const coded = getProductBySlug(slug)!
      const hit = await pub.getPublishedProductBySlug(slug)
      expect(hit).not.toBeNull()
      const p = hit!.product
      expect(p.id).toBe(coded.id)                                // existing carts keep merging
      for (const k of ['name', 'slug', 'type', 'price', 'shortDescription', 'description', 'fitNote', 'founderNote', 'constructionDetails', 'features', 'specs', 'seo', 'relatedProductSlug'] as const) {
        expect((p as any)[k]).toEqual((coded as any)[k])
      }
      expect(p.eyebrow).toBe('Project KVRN')
      expect(p.colors.map(c => [c.name, c.value, c.hex])).toEqual(coded.colors.map(c => [c.name, c.value, c.hex]))
      expect(p.colors[0].images.map(i => [i.src, i.alt, i.type])).toEqual(coded.colors[0].images.map(i => [i.src, i.alt, i.type]))
      expect(p.sizes.map(s => s.label)).toEqual(coded.sizes.map(s => s.label))
      expect(hit!.relatedProduct?.slug).toBe(coded.relatedProductSlug)
    })

    test('legacy products pass the full publish blockers (nothing to fix)', async () => {
      for (const code of ['PKHH', 'PKHSP']) {
        const id = (await q(`SELECT id FROM products WHERE product_code=$1`, [code]))[0].id
        const v = await svc.validate(id)
        expect(v.blockers).toEqual([])
      }
    })

    test('the Neon catalog slug keeps working as a page URL and as an inventory alias', async () => {
      expect(await pub.resolveProductRedirect('project-kvrn-heavyweight-hoodie')).toMatchObject({ to: '/products/kvrn-phantom-hoodie' })
      const direct = await pub.resolveInventoryProductId('kvrn-phantom-hoodie')
      const alias = await pub.resolveInventoryProductId('project-kvrn-heavyweight-hoodie')
      expect(direct).toBeTruthy(); expect(alias).toBe(direct)
      expect(await pub.resolveInventoryProductId('nope')).toBeNull()
    })
  })

  // ── create / blockers / draft ───────────────────────────────────────────────
  describe('create, draft and blockers', () => {
    let id = '', revision = 0
    test('create makes an inactive, zero-priced, unsellable draft with an audit row', async () => {
      const c = await svc.create({ code: 'DRF1', name: 'Draft One', type: 'tee', actor: A })
      id = c.id; revision = c.revision
      const p = await prod(id)
      expect(p).toMatchObject({ active: false, price_cents: 0, catalog_origin: 'editor', product_type: 'tee', product_code: 'DRF1' })
      expect(p.slug).toMatch(/^draft-[0-9a-f]{12}$/)
      expect(await audit(id)).toContain('product.create')
      expect(await pub.getPublishedProductBySlug('draft-one')).toBeNull()
    })
    test('product codes are validated and unique (case-insensitive)', async () => {
      await expect(svc.create({ code: 'drf1', name: 'x', type: 'tee', actor: A })).rejects.toMatchObject({ code: 'invalid' })
      await expect(svc.create({ code: 'D001', name: 'x', type: 'tee', actor: A })).rejects.toBeInstanceOf(CmsError)
      await expect(svc.create({ code: 'A', name: 'x', type: 'tee', actor: A })).rejects.toBeInstanceOf(CmsError)
    })
    test('an incomplete product lists the exact blockers', async () => {
      const v = await svc.validate(id)
      const codes = v.blockers.map(b => b.code)
      expect(codes).toEqual(expect.arrayContaining(['HERO_REQUIRED', 'GALLERY_COUNT', 'DESCRIPTION_REQUIRED', 'COLOR_REQUIRED', 'PRICE_REQUIRED', 'SHIPPING_REQUIRED', 'VARIANT_REQUIRED']))
    })
    test('malformed input is rejected before storage; stale revisions are never overwritten', async () => {
      await expect(svc.saveDraft(id, { name: 5 }, revision, A)).rejects.toBeInstanceOf(ProductInputError)
      await expect(svc.saveDraft(id, { productType: 'Not A Slug!' }, revision, A)).rejects.toBeInstanceOf(ProductInputError)
      const ok = await svc.saveDraft(id, fullSnap({ name: 'Draft One', slug: 'draft-one' }, 'DRF1'), revision, A)
      await expect(svc.saveDraft(id, fullSnap({ name: 'Other' }, 'DRF1'), revision, A)).rejects.toMatchObject({ code: 'stale' })
      revision = ok.revision
      expect((await svc.getEditorState(id)).snapshot.name).toBe('Draft One')
      expect(ok.blockers).toEqual([])
    })
    test('saving a draft changes nothing canonical and records draft media usage + throttled audit', async () => {
      const p = await prod(id)
      expect(p).toMatchObject({ active: false, price_cents: 0 })
      expect((await q(`SELECT COUNT(*)::int n FROM product_variants WHERE product_id=$1`, [id]))[0].n).toBe(0)
      await svc.saveDraft(id, fullSnap({ name: 'Draft One', slug: 'draft-one', description: 'Changed.' }, 'DRF1'), revision, A)
      expect((await q(`SELECT COUNT(*)::int n FROM admin_audit_logs WHERE action='product.draft_save' AND resource_id=$1`, [id]))[0].n).toBe(1)
    })
    test('HS code and country of origin formats are enforced by blockers and by the database', async () => {
      const bad = await svc.saveDraft(id, fullSnap({ name: 'Draft One', slug: 'draft-one' }, 'DRF1'), await rev(id), A).catch(e => e)
      expect(bad.blockers).toEqual([])
      await expect(svc.saveDraft(id, { ...fullSnap({}, 'DRF1'), commerce: { ...fullSnap({}, 'DRF1').commerce, hsCode: 'abc' } }, await rev(id), A)).rejects.toBeInstanceOf(ProductInputError)
      expect(await db.err(`UPDATE products SET hs_code = 'abc' WHERE id = $1`, [id])).toMatch(/check|violat/i)
      expect(await db.err(`UPDATE products SET country_of_origin = 'usa' WHERE id = $1`, [id])).toMatch(/check|violat/i)
      expect(await db.err(`UPDATE products SET hs_code = '6110.20', country_of_origin = 'VN' WHERE id = $1`, [id])).toBe('')
    })
  })

  // ── publish ─────────────────────────────────────────────────────────────────
  describe('publish', () => {
    let L: Awaited<ReturnType<typeof makeLive>>
    beforeAll(async () => { calls.length = 0; L = await makeLive('TEE1', 'Test Tee', 'test-tee') })

    test('applies price, shipping and NEW variants (stock 0) atomically and goes live', async () => {
      const p = await prod(L.id)
      expect(p).toMatchObject({ active: true, price_cents: 6500, slug: 'test-tee', name: 'Test Tee' })
      expect(Number(p.shipping_weight_lb)).toBe(1.2)
      const vs = await q(`SELECT sku, size, color_code, stock_on_hand, reserved_quantity, active FROM product_variants WHERE product_id=$1 ORDER BY size_sort`, [L.id])
      expect(vs).toEqual([
        { sku: 'KVRN-TEE1-BLK-S', size: 'S', color_code: 'BLK', stock_on_hand: 0, reserved_quantity: 0, active: true },
        { sku: 'KVRN-TEE1-BLK-M', size: 'M', color_code: 'BLK', stock_on_hand: 0, reserved_quantity: 0, active: true },
      ])
      expect((await ent(L.id)).status).toBe('published')
      expect(await audit(L.id)).toEqual(expect.arrayContaining(['product.create', 'product.publish']))
    })
    test('only the published version resolves publicly, with canonical price', async () => {
      const hit = await pub.getPublishedProductBySlug('test-tee')
      expect(hit!.product.price).toBe(6500)
      expect(hit!.product.sizes.map(s => s.label)).toEqual(['S', 'M'])
      expect(hit!.product.sections).toBeTruthy()
      expect(hit!.availability).toBe('OutOfStock')       // 0 stock: never claim InStock
      expect(await pub.getPublishedProductBySlug('TEST-TEE')).not.toBeNull()
    })
    test('cache invalidation is requested after commit for the product, shop and sitemap', () => {
      const last = calls[calls.length - 1]
      expect(last.t.paths).toEqual(expect.arrayContaining(['/products/test-tee', '/shop', '/sitemap.xml']))
      expect(last.c.reason).toBe('product publish')
    })
    test('editing a draft does not change the live product, price or variants', async () => {
      const r = await rev(L.id)
      const snap = fullSnap({ name: 'Renamed Tee', slug: 'test-tee' })
      snap.commerce.priceCents = 9900
      await svc.saveDraft(L.id, snap, r, A)
      expect((await pub.getPublishedProductBySlug('test-tee'))!.product).toMatchObject({ name: 'Test Tee', price: 6500 })
      expect((await prod(L.id)).price_cents).toBe(6500)
      const st = await svc.getEditorState(L.id)
      expect(st.hasDraft).toBe(true); expect(st.published!.name).toBe('Test Tee')
    })
    test('a cache-invalidation failure is surfaced, never hidden', async () => {
      invalidateResult = { id: 'x', ok: false, error: 'boom', paths: [], tags: [] }
      const m = await svc.publish(L.id, await rev(L.id), A)
      invalidateResult = { id: 'x', ok: true, paths: [], tags: [] }
      expect(m.cacheInvalidation).toMatchObject({ ok: false, error: 'boom' })
      expect((await prod(L.id)).price_cents).toBe(9900)  // the publish itself committed
    })
    test('a historical order keeps the price it was bought at', async () => {
      const v = (await q(`SELECT id, sku FROM product_variants WHERE product_id=$1 AND size='M'`, [L.id]))[0]
      const o = await q(`INSERT INTO orders (order_number, stripe_checkout_session_id, stripe_payment_intent_id, payment_status, currency, subtotal_cents, shipping_cents, discount_cents, tax_cents, total_cents, paid_at)
         VALUES ('KVRN-HIST-1', 'cs_hist_1', 'pi_hist_1', 'paid', 'usd', 9900, 0, 0, 0, 9900, NOW()) RETURNING id`)
      await q(`INSERT INTO order_items (order_id, variant_id, sku, product_name, size, color, quantity, unit_price_cents, line_total_cents) VALUES ($1,$2,$3,'Test Tee','M','Black',1,9900,9900)`, [o[0].id, v.id, v.sku])
      const snap = fullSnap({ name: 'Renamed Tee', slug: 'test-tee' }); snap.commerce.priceCents = 12000
      snap.commerce.variants = (await svc.getEditorState(L.id)).snapshot.commerce.variants
      await svc.saveDraft(L.id, snap, await rev(L.id), A)
      await svc.publish(L.id, await rev(L.id), A)
      expect((await prod(L.id)).price_cents).toBe(12000)
      expect((await q(`SELECT unit_price_cents FROM order_items WHERE order_id=$1`, [o[0].id]))[0].unit_price_cents).toBe(9900)
    })
    test('variants are matched by SKU, removed variants are deactivated (never deleted) and stock is never written', async () => {
      await q(`UPDATE product_variants SET stock_on_hand = 7 WHERE product_id=$1 AND size='S'`, [L.id])
      const st = await svc.getEditorState(L.id)
      const snap: any = JSON.parse(JSON.stringify(st.snapshot))
      snap.commerce.variants = snap.commerce.variants.filter((v: any) => v.size !== 'M')    // drop M, keep S (+ its id)
      snap.commerce.variants.push({ id: null, sku: 'KVRN-TEE1-BLK-L', colorCode: 'BLK', size: 'L', sizeSort: 4, active: true })
      await svc.saveDraft(L.id, snap, st.revision, A)
      await svc.publish(L.id, await rev(L.id), A)
      const vs = await q(`SELECT sku, active, stock_on_hand FROM product_variants WHERE product_id=$1 ORDER BY size_sort`, [L.id])
      expect(vs).toEqual([
        { sku: 'KVRN-TEE1-BLK-S', active: true, stock_on_hand: 7 },
        { sku: 'KVRN-TEE1-BLK-M', active: false, stock_on_hand: 0 },
        { sku: 'KVRN-TEE1-BLK-L', active: true, stock_on_hand: 0 },
      ])
      expect((await pub.getPublishedProductBySlug('test-tee'))!.product.sizes.map(s => s.label)).toEqual(['S', 'L'])
    })
  })

  // ── failure paths keep everything unchanged ────────────────────────────────
  describe('atomic publish failures', () => {
    test('SKU rules: KVRN- prefix, duplicates and SKUs owned by another product are blockers', async () => {
      const m = await makeDraft('SKU1', 'Sku One', 'sku-one')
      const snap: any = fullSnap({ name: 'Sku One', slug: 'sku-one' }, 'SKU1')
      snap.commerce.variants = [
        { id: null, sku: 'ABC-SKU1-BLK-S', colorCode: 'BLK', size: 'S', sizeSort: 1, active: true },
        { id: null, sku: 'KVRN-SKU1-BLK-M', colorCode: 'BLK', size: 'M', sizeSort: 2, active: true },
        { id: null, sku: 'KVRN-SKU1-BLK-M', colorCode: 'BLK', size: 'L', sizeSort: 3, active: true },
        { id: null, sku: 'KVRN-D001-PKHH-BLK-M', colorCode: 'BLK', size: 'XL', sizeSort: 4, active: true },
      ]
      const r = await svc.saveDraft(m.id, snap, m.revision, A)
      const codes = r.blockers.map(b => b.code)
      expect(codes).toEqual(expect.arrayContaining(['SKU_INVALID', 'SKU_DUPLICATE', 'SKU_TAKEN']))
      const before = await prod(m.id)
      await expect(svc.publish(m.id, r.revision, A)).rejects.toBeInstanceOf(ProductBlockedError)
      expect(await prod(m.id)).toEqual(before)                                         // nothing half-applied
      expect((await q(`SELECT COUNT(*)::int n FROM product_variants WHERE product_id=$1`, [m.id]))[0].n).toBe(0)
      expect((await ent(m.id)).status).toBe('draft')
    })
    test('the go-live trigger enforces blockers even when cms_publish is called directly', async () => {
      const m = await makeDraft('DIR1', 'Direct One', 'direct-one')
      const snap: any = fullSnap({ name: 'Direct One', slug: 'direct-one' }, 'DIR1'); snap.commerce.priceCents = null
      await svc.saveDraft(m.id, snap, m.revision, A)
      const e = await db.err(`SELECT cms_publish('product', $1, NULL, 'x@y.z', '/products')`, [m.id])
      expect(e).toContain('CATALOG_BLOCKED')
      expect((await ent(m.id)).status).toBe('draft'); expect((await prod(m.id)).active).toBe(false)
    })
    test('a missing / archived media asset blocks publish; usages follow draft and published scopes', async () => {
      const key = `media/aa/${HEX}/original.webp`
      const a = await q(`INSERT INTO media_assets (storage_key, sha256, mime_type, byte_size, filename) VALUES ($1,$2,'image/webp',10,'a.webp') RETURNING id`, [key, HEX])
      const m = await makeDraft('MED1', 'Media One', 'media-one')
      const snap: any = fullSnap({ name: 'Media One', slug: 'media-one' }, 'MED1')
      snap.media.hero = { ref: { kind: 'media', assetId: a[0].id }, alt: 'x', focal: { mobile: { x: 0.4, y: 0.2 }, desktop: null } }
      const r = await svc.saveDraft(m.id, snap, m.revision, A)
      expect(r.blockers).toEqual([])
      expect((await q(`SELECT slot, scope FROM media_usages WHERE owner_id=$1`, [m.id]))).toEqual([{ slot: 'hero', scope: 'draft' }])
      await q(`UPDATE media_assets SET status='archived' WHERE id=$1`, [a[0].id])
      const bl = await svc.validate(m.id)
      expect(bl.blockers.map(b => b.code)).toContain('MEDIA_ASSET_ARCHIVED')
      await expect(svc.publish(m.id, r.revision, A)).rejects.toBeInstanceOf(ProductBlockedError)
      await q(`UPDATE media_assets SET status='active' WHERE id=$1`, [a[0].id])
      await svc.publish(m.id, await rev(m.id), A)
      expect((await q(`SELECT slot, scope FROM media_usages WHERE owner_id=$1 ORDER BY scope`, [m.id])).map(r2 => r2.scope)).toContain('published')
    })
    test('focal points outside 0..1 and a pair that is not live are blockers', async () => {
      const m = await makeDraft('FOC1', 'Focal One', 'focal-one')
      const snap: any = fullSnap({ name: 'Focal One', slug: 'focal-one' }, 'FOC1')
      snap.media.hero.focal.desktop = { x: 1.5, y: 0.5 }
      snap.completeTheSet = { enabled: true, pairedProductId: m.id }
      const r = await db.sql`SELECT catalog_product_blockers(${m.id}::uuid, ${JSON.stringify(snap)}::jsonb, 'publish') AS r`
      const codes = r[0].r.blockers.map((b: any) => b.code)
      expect(codes).toEqual(expect.arrayContaining(['FOCAL_INVALID', 'PAIR_SELF']))
    })
  })

  // ── slug changes ───────────────────────────────────────────────────────────
  describe('slugs', () => {
    test('a taken slug blocks publish; changing a live slug redirects old to new and both resolve sensibly', async () => {
      const a = await makeLive('SLG1', 'Slug One', 'slug-one')
      const b = await makeDraft('SLG2', 'Slug Two', 'slug-one')
      expect((await svc.validate(b.id)).blockers.map(x => x.code)).toContain('SLUG_TAKEN')
      await expect(svc.publish(b.id, b.revision, A)).rejects.toBeInstanceOf(ProductBlockedError)

      const st = await svc.getEditorState(a.id)
      const next: any = JSON.parse(JSON.stringify(st.snapshot)); next.slug = 'slug-uno'
      await svc.saveDraft(a.id, next, st.revision, A)
      calls.length = 0
      await svc.publish(a.id, await rev(a.id), A)
      expect((await pub.getPublishedProductBySlug('slug-uno'))!.slug).toBe('slug-uno')
      expect(await pub.getPublishedProductBySlug('slug-one')).toBeNull()
      expect(await pub.resolveProductRedirect('slug-one')).toMatchObject({ to: '/products/slug-uno' })
      expect(await pub.resolveInventoryProductId('slug-one')).toBe(a.id)
      expect((await prod(a.id)).slug).toBe('slug-uno')
      expect(calls[calls.length - 1].t.paths).toEqual(expect.arrayContaining(['/products/slug-uno', '/products/slug-one']))
    })
    test('reserved slugs are refused', async () => {
      const m = await makeDraft('RES1', 'Reserved', 'kvrn-heavyweight-hoodie')
      expect((await svc.validate(m.id)).blockers.map(x => x.code)).toContain('SLUG_RESERVED')
    })
  })

  // ── schedule ───────────────────────────────────────────────────────────────
  describe('scheduled publish', () => {
    test('blockers stop a schedule; a valid one goes live through cms_apply_due and is audited', async () => {
      const bad = await svc.create({ code: 'SCH0', name: 'Sched Zero', type: 'tee', actor: A })
      await expect(svc.schedule(bad.id, new Date(Date.now() + 3600_000), null, bad.revision, A)).rejects.toBeInstanceOf(ProductBlockedError)

      const m = await makeDraft('SCH1', 'Sched One', 'sched-one')
      await svc.schedule(m.id, new Date(Date.now() + 3600_000), null, m.revision, A)
      expect((await ent(m.id)).status).toBe('scheduled')
      expect(await pub.getPublishedProductBySlug('sched-one')).toBeNull()                 // not live yet
      await q(`UPDATE content_entities SET publish_at = NOW() - INTERVAL '1 minute' WHERE entity_id=$1`, [m.id])
      const res = await svc.cms.applyDue()
      expect(res.find(r => r.entity_id === m.id)).toMatchObject({ ok: true, action: 'publish' })
      expect((await prod(m.id))).toMatchObject({ active: true, price_cents: 6500 })
      expect(await pub.getPublishedProductBySlug('sched-one')).not.toBeNull()
      expect(await audit(m.id)).toContain('product.scheduled_publish')
    })
    test('a scheduled publish that became invalid fails safely and stays scheduled (overdue)', async () => {
      const m = await makeDraft('SCH2', 'Sched Two', 'sched-two')
      await svc.schedule(m.id, new Date(Date.now() + 3600_000), null, m.revision, A)
      // another product takes the slug before the schedule fires
      await q(`UPDATE content_entities SET slug = 'sched-two', status='published' WHERE entity_id = (SELECT id::text FROM products WHERE product_code='SCH1')`)
      await q(`UPDATE content_entities SET publish_at = NOW() - INTERVAL '1 minute' WHERE entity_id=$1`, [m.id])
      const res = await svc.cms.applyDue()
      expect(res.find(r => r.entity_id === m.id)).toMatchObject({ ok: false })
      expect((await ent(m.id)).status).toBe('scheduled')
      expect((await prod(m.id)).active).toBe(false)
      const list = await svc.list({ q: 'Sched Two' })
      expect(list.items[0]).toMatchObject({ displayStatus: 'scheduled', overdue: true })
    })
  })

  // ── rollback ───────────────────────────────────────────────────────────────
  describe('rollback', () => {
    test('creates a NEW version with the old content and does not touch price, sizes or stock', async () => {
      const m = await makeLive('RBK1', 'Rollback One', 'rollback-one')
      const v1 = (await ent(m.id)).published_version_no
      const snap: any = fullSnap({ name: 'Rollback Two', slug: 'rollback-one' }, 'RBK1'); snap.commerce.priceCents = 7000
      snap.commerce.variants = (await svc.getEditorState(m.id)).snapshot.commerce.variants
      await svc.saveDraft(m.id, snap, await rev(m.id), A)
      await svc.publish(m.id, await rev(m.id), A)
      expect((await prod(m.id)).price_cents).toBe(7000)
      const before = await q(`SELECT COUNT(*)::int n FROM content_versions WHERE entity_id=$1`, [m.id])
      const rb = await svc.rollback(m.id, v1, await rev(m.id), A)
      const after = await q(`SELECT COUNT(*)::int n FROM content_versions WHERE entity_id=$1`, [m.id])
      expect(after[0].n).toBe(before[0].n + 1)
      expect((await pub.getPublishedProductBySlug('rollback-one'))!.product.name).toBe('Rollback One')
      expect((await prod(m.id)).price_cents).toBe(7000)                                  // content-only
      expect((rb.result as any).version_no).toBeGreaterThan(v1)
      expect(await audit(m.id)).toContain('product.rollback')
      const st = await svc.getEditorState(m.id)
      expect(st.snapshot.commerce.priceCents).toBe(7000)                                  // editor hydrates from canonical
    })
  })

  // ── unpublish / archive ────────────────────────────────────────────────────
  describe('unpublish and archive', () => {
    test('unpublish and archive make the product unsellable and invisible; restore never auto-publishes', async () => {
      const m = await makeLive('UNP1', 'Unpub One', 'unpub-one')
      await svc.unpublish(m.id, await rev(m.id), A)
      expect((await prod(m.id)).active).toBe(false)
      expect(await pub.getPublishedProductBySlug('unpub-one')).toBeNull()
      expect(await pub.resolveInventoryProductId('unpub-one')).toBeNull()
      await svc.publish(m.id, await rev(m.id), A).catch(() => {})                         // no draft -> cannot re-publish blindly
      const m2 = await makeLive('UNP2', 'Unpub Two', 'unpub-two')
      await svc.archive(m2.id, await rev(m2.id), A)
      expect((await prod(m2.id)).active).toBe(false)
      expect((await ent(m2.id)).status).toBe('archived')
      await svc.restore(m2.id, await rev(m2.id), A)
      expect((await ent(m2.id)).status).not.toBe('published')
      expect((await prod(m2.id)).active).toBe(false)
      expect(await audit(m2.id)).toEqual(expect.arrayContaining(['cms.archive', 'cms.restore']))
    })
    test('an unpublished legacy product stops being served and sold, with canonical rows intact', async () => {
      const id = (await q(`SELECT id FROM products WHERE product_code='PKHSP'`))[0].id
      await svc.unpublish(id, await rev(id), A)
      expect(await pub.getPublishedProductBySlug('kvrn-phantom-sweatpants')).toBeNull()
      expect((await q(`SELECT COUNT(*)::int n FROM product_variants WHERE product_id=$1`, [id]))[0].n).toBe(6)
      // the hoodie's pair is no longer live, so Complete the Set disappears for it
      const hoodie = await pub.getPublishedProductBySlug('kvrn-phantom-hoodie')
      expect(hoodie!.relatedProduct).toBeNull()
      expect(hoodie!.product.relatedProductSlug).toBeUndefined()
      // restore it for later tests: republish its (unchanged) live version via a draft
      const st = await svc.getEditorState(id)
      await svc.saveDraft(id, st.snapshot, st.revision, A)
      await svc.publish(id, await rev(id), A)
      expect(await pub.getPublishedProductBySlug('kvrn-phantom-sweatpants')).not.toBeNull()
    })
  })

  // ── duplicate ──────────────────────────────────────────────────────────────
  describe('duplicate', () => {
    test('copies content and structure under a new identity: new slug, new SKUs, no stock, no pairing', async () => {
      const m = await makeLive('DUP1', 'Dup One', 'dup-one')
      await q(`UPDATE product_variants SET stock_on_hand = 9 WHERE product_id=$1`, [m.id])
      const dup = await svc.duplicate(m.id, A)
      expect(dup.code).not.toBe('DUP1'); expect(dup.slug).toBe('dup-one-copy')
      const st = await svc.getEditorState(dup.id)
      expect(st.snapshot.name).toBe('Dup One (Copy)')
      expect(st.snapshot.media.gallery).toHaveLength(5)
      const skus = st.snapshot.commerce.variants.map(v => v.sku)
      expect(skus.every(s => s.startsWith(`KVRN-${dup.code}-`))).toBe(true)
      expect(st.snapshot.commerce.variants.every(v => v.id === null)).toBe(true)
      expect((await q(`SELECT COUNT(*)::int n FROM product_variants WHERE product_id=$1`, [dup.id]))[0].n).toBe(0)
      expect((await prod(dup.id))).toMatchObject({ active: false, price_cents: 0 })
      expect(st.status).toBe('draft')
      expect((await q(`SELECT SUM(stock_on_hand)::int s FROM product_variants WHERE product_id=$1`, [m.id]))[0].s).toBe(18)
      expect(await audit(dup.id)).toEqual(expect.arrayContaining(['product.create', 'product.duplicate']))
      // the copy can go live on its own SKUs
      expect((await svc.validate(dup.id)).blockers).toEqual([])
    })
  })

  // ── bulk ───────────────────────────────────────────────────────────────────
  describe('bulk actions', () => {
    test('per-product results: one failure never stops or rolls back the others', async () => {
      const a = await makeLive('BLK1', 'Bulk One', 'bulk-one')
      const b = await makeLive('BLK2', 'Bulk Two', 'bulk-two')
      const r = await svc.bulk({ action: 'archive', actor: A, items: [{ id: a.id, revision: await rev(a.id) }, { id: b.id, revision: 1 }] })
      expect(r).toMatchObject({ requested: 2, succeeded: 1, failed: 1 })
      expect(r.results.find(x => x.id === b.id)).toMatchObject({ ok: false })
      expect((await ent(a.id)).status).toBe('archived'); expect((await ent(b.id)).status).toBe('published')
      expect((await q(`SELECT payload FROM admin_audit_logs WHERE action='product.bulk'`)).length).toBeGreaterThan(0)
    })
    test('publish/unpublish need the typed confirmation; publish is validated product by product', async () => {
      const ok = await makeDraft('BLK3', 'Bulk Three', 'bulk-three')
      const bad = await svc.create({ code: 'BLK4', name: 'Bulk Four', type: 'tee', actor: A })
      await expect(svc.bulk({ action: 'publish', actor: A, confirm: 'yes', items: [{ id: ok.id, revision: ok.revision }] })).rejects.toBeInstanceOf(CmsError)
      const r = await svc.bulk({ action: 'publish', actor: A, confirm: 'publish', items: [{ id: ok.id, revision: ok.revision }, { id: bad.id, revision: bad.revision }] })
      expect(r).toMatchObject({ succeeded: 1, failed: 1 })
      expect(r.results.find(x => x.id === bad.id)!.blockers!.length).toBeGreaterThan(0)
      expect((await ent(ok.id)).status).toBe('published'); expect((await prod(bad.id)).active).toBe(false)
    })
  })

  // ── collections, list, sitemap ─────────────────────────────────────────────
  describe('collections, list and sitemap', () => {
    test('collection assignment writes collection_products, is audited, invalidates collections and feeds the shop', async () => {
      const col = (await q(`INSERT INTO collections (slug, name) VALUES ('summer','Summer') RETURNING id`))[0].id
      const m = await makeLive('COL1', 'Col One', 'col-one')
      calls.length = 0
      const r = await svc.setCollections(m.id, [col], A)
      expect(r.result.collections).toEqual(['summer'])
      expect(calls[0].t.paths).toEqual(expect.arrayContaining(['/collections/summer']))
      expect(await audit(m.id)).toContain('product.collections')
      expect((await pub.listPublishedProducts({ collectionSlug: 'summer' })).map(p => p.slug)).toEqual(['col-one'])
      await expect(svc.setCollections(m.id, ['00000000-0000-4000-8000-000000000000'], A)).rejects.toBeInstanceOf(CmsError)
      await svc.setCollections(m.id, [], A)
      expect(await pub.listPublishedProducts({ collectionSlug: 'summer' })).toEqual([])
    })
    test('admin list statuses, search and validation indicators', async () => {
      const all = await svc.list({})
      const byName = (n: string) => all.items.find(i => i.name === n)!
      expect(byName('Col One').displayStatus).toBe('sold_out')                         // live, 0 available
      expect(byName('Bulk One').displayStatus).toBe('archived')
      expect(byName('Project KVRN Heavyweight Hoodie').displayStatus).toBe('live')
      expect(byName('Sched Zero').blockerCount).toBeGreaterThan(0)
      expect((await svc.list({ q: 'col-one' })).items.map(i => i.name)).toEqual(['Col One'])
      expect((await svc.list({ status: 'archived' })).items.every(i => i.displayStatus === 'archived')).toBe(true)
    })
    test('sitemap entries: only live + listed; flag OFF returns the coded visible products', async () => {
      const prev = process.env.KVRN_FLAG_CMS_PRODUCT_ROUTING
      try {
        process.env.KVRN_FLAG_CMS_PRODUCT_ROUTING = 'on'
        const on = await pub.getPublishedProductSitemapEntries()
        const paths = on.map(e => e.path)
        expect(paths).toEqual(expect.arrayContaining(['/products/kvrn-phantom-hoodie', '/products/col-one']))
        expect(paths).not.toContain('/products/unpub-one'); expect(paths).not.toContain('/products/bulk-one')
        expect(on.every(e => e.lastModified instanceof Date)).toBe(true)
        process.env.KVRN_FLAG_CMS_PRODUCT_ROUTING = 'off'
        const off = await pub.getPublishedProductSitemapEntries()
        expect(off.map(e => e.path).sort()).toEqual(['/products/kvrn-phantom-hoodie', '/products/kvrn-phantom-sweatpants'])
      } finally { if (prev === undefined) delete process.env.KVRN_FLAG_CMS_PRODUCT_ROUTING; else process.env.KVRN_FLAG_CMS_PRODUCT_ROUTING = prev }
    })
    test('Complete the Set resolves the paired live product and never a draft one', async () => {
      const a = await makeLive('PAI1', 'Pair One', 'pair-one')
      const b = await makeLive('PAI2', 'Pair Two', 'pair-two')
      const st = await svc.getEditorState(a.id)
      const next: any = JSON.parse(JSON.stringify(st.snapshot)); next.completeTheSet = { enabled: true, pairedProductId: b.id }
      await svc.saveDraft(a.id, next, st.revision, A); await svc.publish(a.id, await rev(a.id), A)
      expect((await pub.getPublishedProductBySlug('pair-one'))!.relatedProduct?.slug).toBe('pair-two')
      // preview of the draft works and does not require publishing
      const pv = await pub.getProductPreview(a.id)
      expect(pv!.product.name).toBe('Pair One')
      // a not-live pair is a blocker
      const c = await svc.create({ code: 'PAI3', name: 'Pair Three', type: 'tee', actor: A })
      const n2: any = fullSnap({ name: 'Pair One', slug: 'pair-one' }, 'PAI1'); n2.completeTheSet = { enabled: true, pairedProductId: c.id }
      n2.commerce.variants = st.snapshot.commerce.variants
      const r = await svc.saveDraft(a.id, n2, await rev(a.id), A)
      expect(r.blockers.map(x => x.code)).toContain('PAIR_NOT_LIVE')
    })
  })
})
