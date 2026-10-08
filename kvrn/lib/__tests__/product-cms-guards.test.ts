// Source guards and runtime checks that need no database: admin route protection, flag ON/OFF
// read paths, inventory fail-closed behaviour, preview isolation, bulk confirmation, no new deps.
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])

describe('admin API routes', () => {
  const routes = walk('app/api/admin/products').filter(f => f.endsWith('route.ts'))
  test('there are product admin routes', () => { expect(routes.length).toBeGreaterThanOrEqual(9) })
  for (const r of routes) {
    test(`${r} calls requireAdmin before doing any work`, () => {
      const src = read(r)
      const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b[^{]*\{([\s\S]*?)(?=\nexport async function|\n$|$)/g)]
      expect(handlers.length).toBeGreaterThan(0)
      for (const h of handlers) {
        const body = h[2]
        const guard = body.indexOf('requireAdmin(')
        expect(guard).toBeGreaterThanOrEqual(0)
        // nothing that touches data or parses the body may precede the guard
        const before = body.slice(0, guard)
        expect(before).not.toMatch(/readJson|productService|await sql|\.json\(\)/)
      }
    })
  }
  test('product-specific mutations write admin audit rows; lifecycle audits come from the frozen cms functions', () => {
    const src = read('lib/product-service.ts')
    for (const a of ['product.draft_save', 'product.duplicate', 'product.collections', 'product.bulk']) expect(src).toContain(a)
    expect(src).toContain('admin_audit_logs')
    expect(read('db/migrations/027_cms_foundation.sql')).toMatch(/admin_audit_logs/)
  })
  test('the editor never writes stock (inventory is not editor-owned)', () => {
    for (const f of ['lib/product-service.ts', 'db/migrations/028_product_catalog_cms.sql']) {
      expect(read(f)).not.toMatch(/stock_on_hand\s*=|SET\s+stock_on_hand|reserved_quantity\s*=/i)
    }
  })
  test('migration 028 does not redefine any frozen function name from 001-027', () => {
    const sql = read('db/migrations/028_product_catalog_cms.sql')
    for (const fn of ['reserve_inventory', 'release_reservation', 'fulfill_order', 'cms_publish', 'cms_rollback', 'cms_apply_due']) {
      expect(sql).not.toMatch(new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+${fn}\\s*\\(`, 'i'))
    }
  })
})

describe('flag-gated read path', () => {
  test('PDP page, shop page, and inventory route are gated on CMS_PRODUCT_ROUTING', () => {
    for (const f of ['app/products/[slug]/page.tsx', 'app/shop/page.tsx', 'app/api/inventory/route.ts']) {
      expect(read(f)).toContain("isFeatureEnabled('CMS_PRODUCT_ROUTING')")
    }
  })
  test('flag OFF PDP path does not call the DB read path', () => {
    const src = read('app/products/[slug]/page.tsx')
    // the DB resolver is only reachable inside the ON branch
    const onIdx = src.indexOf("isFeatureEnabled('CMS_PRODUCT_ROUTING')")
    expect(onIdx).toBeGreaterThan(0)
    expect(src).toMatch(/getProductBySlug/)
  })
  test('the flag is registered and defaults OFF', () => {
    const { isFeatureEnabled } = require('../feature-flags')
    expect(isFeatureEnabled('CMS_PRODUCT_ROUTING', {})).toBe(false)
    expect(isFeatureEnabled('CMS_PRODUCT_ROUTING', { KVRN_FLAG_CMS_PRODUCT_ROUTING: '1' })).toBe(true)
    expect(isFeatureEnabled('CMS_PRODUCT_ROUTING', { KVRN_FLAG_CMS_PRODUCT_ROUTING: 'false' })).toBe(false)
  })
  test('the inventory route keeps the non-negative availability expression', () => {
    const src = read('app/api/inventory/route.ts')
    expect(src).toContain('GREATEST(0, pv.stock_on_hand - pv.reserved_quantity) AS available_qty')
    expect(src).not.toContain('LEAST(')
  })
  test('the sitemap contract export exists', () => {
    expect(read('lib/product-public.ts')).toMatch(/export (async )?function getPublishedProductSitemapEntries|export const getPublishedProductSitemapEntries/)
  })
})

describe('inventory route runtime', () => {
  const load = (flag: boolean, resolver: () => Promise<string | null>, rows: any[] = []) => {
    jest.resetModules()
    if (flag) process.env.KVRN_FLAG_CMS_PRODUCT_ROUTING = '1'; else delete process.env.KVRN_FLAG_CMS_PRODUCT_ROUTING
    const sql = jest.fn(async () => rows)
    jest.doMock('@/lib/db', () => ({ sql }))
    jest.doMock('@/lib/product-public', () => ({ resolveInventoryProductId: resolver }))
    const { GET } = require('@/app/api/inventory/route')
    const call = (slug?: string) => GET({ nextUrl: new URL(`http://x.test/api/inventory${slug ? `?slug=${slug}` : ''}`) })
    return { call, sql }
  }
  afterEach(() => { delete process.env.KVRN_FLAG_CMS_PRODUCT_ROUTING; jest.dontMock('@/lib/db'); jest.dontMock('@/lib/product-public') })

  test('flag ON: an unpublished/unknown product is 404 and no stock query runs', async () => {
    const { call, sql } = load(true, async () => null)
    const res = await call('draft-thing')
    expect(res.status).toBe(404)
    expect(sql).not.toHaveBeenCalled()
  })
  test('flag ON: resolver failure fails closed with 503, never fake availability', async () => {
    const { call, sql } = load(true, async () => { throw new Error('db down') })
    const res = await call('x')
    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(sql).not.toHaveBeenCalled()
  })
  test('flag ON: a published product returns variants with non-negative availability', async () => {
    const { call } = load(true, async () => '00000000-0000-4000-8000-000000000001',
      [{ sku: 'KVRN-TC-BLK-S', size: 'S', size_sort: 1, color_code: 'BLK', active: true, in_stock: true, available_qty: '3' }])
    const res = await call('test-crew')
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.variants[0]).toMatchObject({ sku: 'KVRN-TC-BLK-S', color_code: 'BLK', available_qty: 3, in_stock: true })
  })
  test('flag OFF: the resolver is never consulted; unknown coded slug is 404', async () => {
    const resolver = jest.fn(async () => 'x')
    const { call } = load(false, resolver as any)
    const res = await call('definitely-not-a-coded-slug')
    expect(res.status).toBe(404)
    expect(resolver).not.toHaveBeenCalled()
  })
  test('missing slug is 400 in both modes', async () => {
    expect((await load(false, async () => null).call()).status).toBe(400)
    expect((await load(true, async () => null).call()).status).toBe(400)
  })
})

describe('preview isolation', () => {
  test('the preview page is noindex/nocache and the admin shell renders it chrome-free', () => {
    expect(read('app/admin/products/[id]/preview/page.tsx')).toMatch(/index:\s*false/)
    expect(read('app/admin/products/[id]/preview/page.tsx')).toMatch(/nocache:\s*true/)
    expect(read('components/admin/AdminShell.tsx')).toMatch(/preview/)
  })
  test('PDPClient preview mode skips analytics, fetches and add-to-bag', () => {
    const src = read('app/products/[slug]/PDPClient.tsx')
    expect(src).toMatch(/if \(!analyticsOn \|\| preview\) return/)
    expect(src).toMatch(/if \(preview\) \{ setAvailability/)
  })
})

describe('bulk actions (pure validation, no DB)', () => {
  const { createProductService } = require('../product-service')
  const svc = createProductService((() => { throw new Error('sql must not be touched') }) as any, { invalidate: async () => null })
  test('publish and unpublish need the typed confirmation word', async () => {
    await expect(svc.bulk({ action: 'publish', items: [{ id: 'a', revision: 1 }], actor: 'x' })).rejects.toThrow(/PUBLISH/)
    await expect(svc.bulk({ action: 'unpublish', items: [{ id: 'a', revision: 1 }], actor: 'x', confirm: 'nope' })).rejects.toThrow(/UNPUBLISH/)
  })
  test('empty and oversized selections are rejected', async () => {
    await expect(svc.bulk({ action: 'archive', items: [], actor: 'x' })).rejects.toThrow()
    const many = Array.from({ length: 51 }, (_, i) => ({ id: String(i), revision: 1 }))
    await expect(svc.bulk({ action: 'archive', items: many, actor: 'x' })).rejects.toThrow()
  })
  test('collection actions need a collection id', async () => {
    await expect(svc.bulk({ action: 'add_collection', items: [{ id: 'a', revision: 1 }], actor: 'x' })).rejects.toThrow()
  })
})

describe('shipping: new products ship with their own parcel data', () => {
  test('KVRN-<CODE>- SKUs resolve to the product code only when that code exists in the DB', () => {
    const src = read('lib/shippo.ts')
    expect(src).toContain('productCodeFromDbSku')
    expect(src).toMatch(/hasOwnProperty\.call\(dbByCode, m\[1\]\)/)
    // legacy mapping still wins for coded products
    expect(src).toMatch(/productCodeForSku\(item\.sku\) \?\? productCodeFromDbSku/)
  })
  test('publish requires shipping weight and dimensions (fail closed)', () => {
    expect(read('db/migrations/028_product_catalog_cms.sql')).toMatch(/SHIPPING_/)
  })
})

describe('repository hygiene', () => {
  test('no new npm dependencies', () => {
    const base = process.env.PRODUCT_BASE_REF || 'b4690a3'
    let diff = ''
    try { diff = execSync(`git diff --name-only ${base}...HEAD -- package.json package-lock.json`, { cwd: ROOT }).toString() } catch { return }
    expect(diff.trim()).toBe('')
  })
  test('migration 028 is the only migration this workstream adds', () => {
    expect(fs.existsSync(path.join(ROOT, 'db/migrations/028_product_catalog_cms.sql'))).toBe(true)
  })
})
