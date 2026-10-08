// lib/product-public.ts — the storefront READ PATH for Admin-managed products.
//
// Only content_entities.status='published' AND the published version are ever returned, and only
// when the canonical products row is active (fail closed). Drafts, archived and unpublished
// products resolve to nothing. Price, sizes and availability come from the canonical tables.
//
// `createProductPublic(sql)` is the testable core; the default exports are bound to the app's
// Neon client and are what pages/routes import.
import { toMediaAssetDTO } from './media-storage'
import { isFeatureEnabled } from './feature-flags'
import { loadProductDefaults, FALLBACK_PRODUCT_DEFAULTS } from './product-defaults'
import type { ProductDefaults } from './product-defaults'
import { buildPublicProduct, resolveOgImage, type CanonicalVariant } from './product-public-shape'
import { snapshotAssetIds, isUuid, type ProductSnapshot } from './product-model'
import type { AssetMap } from './product-images'
import type { Availability } from './product-seo'
import type { Product } from '@/types'
import { products as CODED, getVisibleProducts } from '@/data/products'
import { getSetting } from './site-settings'

type Sql = any

/** Coded product ids, kept for legacy-bootstrapped products so existing carts still merge. */
const LEGACY_ID_BY_SLUG: Record<string, string> = Object.fromEntries(CODED.map(p => [p.slug, p.id]))

export interface PublishedProduct {
  product: Product
  productId: string
  slug: string
  snapshot: ProductSnapshot
  publishedAt: string | null
  ogImage: { url: string; alt: string } | null
  imageUrls: string[]
  availability: Availability
  relatedProduct: Product | null
}

interface Row {
  entity_id: string; slug: string; published_at: string | null; snapshot: ProductSnapshot
  price_cents: number; product_code: string | null; catalog_origin: string | null
}

export function createProductPublic(sql: Sql) {
  async function loadAssets(snaps: ProductSnapshot[]): Promise<AssetMap> {
    const ids = [...new Set(snaps.flatMap(s => snapshotAssetIds(s)))]
    if (!ids.length) return {}
    const rows = await sql`SELECT * FROM media_assets WHERE id = ANY(${ids}::uuid[]) AND status = 'active'` as any[]
    const map: AssetMap = {}
    for (const r of rows) { const d = toMediaAssetDTO(r); map[d.id.toLowerCase()] = d }
    return map
  }

  async function loadVariants(productIds: string[]): Promise<Record<string, CanonicalVariant[]>> {
    if (!productIds.length) return {}
    const rows = await sql`
      SELECT product_id::text AS product_id, sku, size, size_sort, color_code, active
        FROM product_variants WHERE product_id = ANY(${productIds}::uuid[]) ORDER BY size_sort, sku` as any[]
    const out: Record<string, CanonicalVariant[]> = {}
    for (const r of rows) (out[r.product_id] ??= []).push({ sku: r.sku, size: r.size, sizeSort: r.size_sort ?? 0, colorCode: r.color_code ?? '', active: !!r.active })
    return out
  }

  async function loadAvailability(productIds: string[]): Promise<Record<string, Availability>> {
    if (!productIds.length) return {}
    const rows = await sql`
      SELECT product_id::text AS product_id, COUNT(*)::int AS n,
             COALESCE(SUM(GREATEST(0, stock_on_hand - reserved_quantity)), 0)::int AS avail
        FROM product_variants WHERE product_id = ANY(${productIds}::uuid[]) AND active = TRUE GROUP BY product_id` as any[]
    const out: Record<string, Availability> = {}
    for (const r of rows) out[r.product_id] = r.n > 0 ? (r.avail > 0 ? 'InStock' : 'OutOfStock') : null
    return out
  }

  async function defaults(): Promise<ProductDefaults> {
    try { return (await loadProductDefaults(sql)).value } catch { return FALLBACK_PRODUCT_DEFAULTS }
  }

  async function shape(rows: Row[], opts: { withRelated: boolean }): Promise<PublishedProduct[]> {
    if (!rows.length) return []
    const snaps = rows.map(r => r.snapshot)
    const [assets, variants, avail, defs] = await Promise.all([
      loadAssets(snaps), loadVariants(rows.map(r => r.entity_id)), loadAvailability(rows.map(r => r.entity_id)), defaults(),
    ])
    const out: PublishedProduct[] = []
    for (const r of rows) {
      const s = r.snapshot
      let relatedSlug: string | null = null
      if (opts.withRelated && s.completeTheSet?.enabled && s.completeTheSet.pairedProductId) {
        relatedSlug = await slugForPublishedId(s.completeTheSet.pairedProductId)
      }
      const id = r.catalog_origin === 'legacy' ? (LEGACY_ID_BY_SLUG[r.slug] ?? r.entity_id) : r.entity_id
      const product = buildPublicProduct({
        id, snapshot: s, priceCents: r.price_cents, productCode: r.product_code,
        variants: variants[r.entity_id] ?? [], assets, defaults: defs, relatedProductSlug: relatedSlug,
      })
      if (!product) continue
      product.slug = r.slug
      const urls: string[] = []
      for (const im of product.colors[0]?.images ?? []) urls.push(im.src)
      out.push({
        product, productId: r.entity_id, slug: r.slug, snapshot: s, publishedAt: r.published_at ? String(r.published_at) : null,
        ogImage: resolveOgImage(s, assets), imageUrls: urls, availability: avail[r.entity_id] ?? null, relatedProduct: null,
      })
    }
    return out
  }

  async function slugForPublishedId(id: string): Promise<string | null> {
    if (!isUuid(id)) return null
    const rows = await sql`
      SELECT e.slug FROM content_entities e JOIN products p ON p.id::text = e.entity_id
       WHERE e.entity_type = 'product' AND e.entity_id = ${id.toLowerCase()} AND e.status = 'published' AND p.active = TRUE` as any[]
    return rows[0]?.slug ?? null
  }

  async function getPublishedProductBySlug(slug: string): Promise<PublishedProduct | null> {
    if (typeof slug !== 'string' || !slug || slug.length > 120) return null
    const rows = await sql`
      SELECT e.entity_id, e.slug, e.published_at, v.snapshot, p.price_cents, p.product_code, p.catalog_origin
        FROM content_entities e
        JOIN content_versions v ON v.entity_type = e.entity_type AND v.entity_id = e.entity_id AND v.version_no = e.published_version_no
        JOIN products p ON p.id::text = e.entity_id
       WHERE e.entity_type = 'product' AND e.status = 'published' AND p.active = TRUE AND lower(e.slug) = lower(${slug})` as Row[]
    const [hit] = await shape(rows, { withRelated: true })
    if (!hit) return null
    const relSlug = hit.product.relatedProductSlug
    if (relSlug) {
      const rel = await getRelated(relSlug)
      hit.relatedProduct = rel
      if (!rel) delete hit.product.relatedProductSlug
    }
    return hit
  }

  async function getRelated(slug: string): Promise<Product | null> {
    const rows = await sql`
      SELECT e.entity_id, e.slug, e.published_at, v.snapshot, p.price_cents, p.product_code, p.catalog_origin
        FROM content_entities e
        JOIN content_versions v ON v.entity_type = e.entity_type AND v.entity_id = e.entity_id AND v.version_no = e.published_version_no
        JOIN products p ON p.id::text = e.entity_id
       WHERE e.entity_type = 'product' AND e.status = 'published' AND p.active = TRUE AND lower(e.slug) = lower(${slug})` as Row[]
    const [hit] = await shape(rows, { withRelated: false })
    return hit?.product ?? null
  }

  /** Published, listed products for the shop / collections, in shop order. */
  async function listPublishedProducts(opts: { collectionSlug?: string | null; type?: string | null; includeUnlisted?: boolean } = {}): Promise<PublishedProduct[]> {
    const rows = opts.collectionSlug
      ? await sql`
          SELECT e.entity_id, e.slug, e.published_at, v.snapshot, p.price_cents, p.product_code, p.catalog_origin
            FROM collections c
            JOIN collection_products cp ON cp.collection_id = c.id
            JOIN products p ON p.id = cp.product_id AND p.active = TRUE
            JOIN content_entities e ON e.entity_type = 'product' AND e.entity_id = p.id::text AND e.status = 'published'
            JOIN content_versions v ON v.entity_type = e.entity_type AND v.entity_id = e.entity_id AND v.version_no = e.published_version_no
           WHERE c.slug = ${opts.collectionSlug} AND c.is_active = TRUE AND c.archived_at IS NULL
           ORDER BY cp.position, e.published_at` as Row[]
      : await sql`
          SELECT e.entity_id, e.slug, e.published_at, v.snapshot, p.price_cents, p.product_code, p.catalog_origin
            FROM content_entities e
            JOIN content_versions v ON v.entity_type = e.entity_type AND v.entity_id = e.entity_id AND v.version_no = e.published_version_no
            JOIN products p ON p.id::text = e.entity_id
           WHERE e.entity_type = 'product' AND e.status = 'published' AND p.active = TRUE
           ORDER BY COALESCE((v.snapshot #>> '{shop,sortPosition}')::int, 0), e.published_at` as Row[]
    let shaped = await shape(rows, { withRelated: false })
    if (!opts.includeUnlisted) shaped = shaped.filter(p => p.snapshot.shop?.listed !== false)
    if (opts.type) shaped = shaped.filter(p => p.snapshot.productType === opts.type)
    return shaped
  }

  /** Old public path -> current path (follows a short chain; same-origin paths only). */
  async function resolveProductRedirect(slug: string): Promise<{ to: string; status: number } | null> {
    if (typeof slug !== 'string' || !slug || slug.length > 120) return null
    let path = `/products/${slug.toLowerCase()}`
    let status = 301
    for (let hop = 0; hop < 4; hop++) {
      const rows = await sql`SELECT to_path, status_code FROM content_redirects WHERE lower(from_path) = ${path}` as any[]
      if (!rows[0]) break
      path = String(rows[0].to_path); status = rows[0].status_code
    }
    if (path === `/products/${slug.toLowerCase()}`) return null
    const m = /^\/products\/([a-z0-9-]+)$/.exec(path)
    if (!m) return null
    // Only redirect to something that actually resolves publicly (never to a 404).
    const target = await slugForPublishedSlug(m[1])
    return target ? { to: `/products/${target}`, status } : null
  }

  async function slugForPublishedSlug(slug: string): Promise<string | null> {
    const rows = await sql`
      SELECT e.slug FROM content_entities e JOIN products p ON p.id::text = e.entity_id
       WHERE e.entity_type = 'product' AND e.status = 'published' AND p.active = TRUE AND lower(e.slug) = lower(${slug})` as any[]
    return rows[0]?.slug ?? null
  }

  /** Inventory/availability: slug (public, redirected or alias) -> canonical product id, or null. */
  async function resolveInventoryProductId(slug: string): Promise<string | null> {
    if (typeof slug !== 'string' || !slug || slug.length > 120) return null
    const rows = await sql`
      SELECT e.entity_id FROM content_entities e JOIN products p ON p.id::text = e.entity_id
       WHERE e.entity_type = 'product' AND e.status = 'published' AND p.active = TRUE AND lower(e.slug) = lower(${slug})` as any[]
    if (rows[0]) return rows[0].entity_id
    const red = await resolveProductRedirect(slug)
    if (!red) return null
    const again = await sql`
      SELECT e.entity_id FROM content_entities e JOIN products p ON p.id::text = e.entity_id
       WHERE e.entity_type = 'product' AND e.status = 'published' AND p.active = TRUE
         AND e.slug = ${red.to.replace('/products/', '')}` as any[]
    return again[0]?.entity_id ?? null
  }

  async function getPublishedProductSitemapEntries(): Promise<Array<{ path: string; lastModified?: Date }>> {
    if (!isFeatureEnabled('CMS_PRODUCT_ROUTING')) {
      return getVisibleProducts().map(p => ({ path: `/products/${p.slug}` }))
    }
    try {
      const rows = await sql`
        SELECT e.slug, e.published_at, v.snapshot #>> '{shop,listed}' AS listed
          FROM content_entities e
          JOIN content_versions v ON v.entity_type = e.entity_type AND v.entity_id = e.entity_id AND v.version_no = e.published_version_no
          JOIN products p ON p.id::text = e.entity_id
         WHERE e.entity_type = 'product' AND e.status = 'published' AND p.active = TRUE
         ORDER BY e.slug` as any[]
      return rows.filter(r => r.listed !== 'false').map(r => ({
        path: `/products/${r.slug}`, ...(r.published_at ? { lastModified: new Date(r.published_at) } : {}),
      }))
    } catch (e) {
      console.error('product sitemap entries failed:', (e as Error).message)
      return []
    }
  }

  /**
   * Draft (or, with none, the published) version for the private admin preview. Price/sizes come
   * from the snapshot's intent while the product has never been published (canonical price is 0).
   */
  async function getProductPreview(productId: string): Promise<{ product: Product; relatedProduct: Product | null; hasDraft: boolean; versionNo: number | null } | null> {
    if (!isUuid(productId)) return null
    const rows = await sql`
      SELECT e.entity_id, e.slug, e.published_at, e.status, e.draft_version_no, e.published_version_no,
             COALESCE(d.snapshot, pv.snapshot) AS snapshot, (d.snapshot IS NOT NULL) AS has_draft,
             p.price_cents, p.product_code, p.catalog_origin
        FROM content_entities e
        JOIN products p ON p.id::text = e.entity_id
        LEFT JOIN content_versions d ON d.entity_type = e.entity_type AND d.entity_id = e.entity_id AND d.version_no = e.draft_version_no
        LEFT JOIN content_versions pv ON pv.entity_type = e.entity_type AND pv.entity_id = e.entity_id AND pv.version_no = e.published_version_no
       WHERE e.entity_type = 'product' AND e.entity_id = ${productId.toLowerCase()}` as any[]
    const r = rows[0]
    if (!r || !r.snapshot) return null
    const s: ProductSnapshot = r.snapshot
    const assets = await loadAssets([s])
    const defs = await defaults()
    const canonical = await loadVariants([r.entity_id])
    const intentVariants: CanonicalVariant[] = (s.commerce?.variants ?? []).map(v => ({ sku: v.sku, size: v.size, sizeSort: v.sizeSort, colorCode: v.colorCode, active: v.active }))
    const variants = r.price_cents > 0 && (canonical[r.entity_id] ?? []).length ? canonical[r.entity_id] : intentVariants
    const price = r.price_cents > 0 ? r.price_cents : (s.commerce?.priceCents ?? 0)
    let relatedSlug: string | null = null
    if (s.completeTheSet?.enabled && s.completeTheSet.pairedProductId) relatedSlug = await slugForPublishedId(s.completeTheSet.pairedProductId)
    const product = buildPublicProduct({
      id: r.entity_id, snapshot: s, priceCents: price, productCode: r.product_code, variants, assets, defaults: defs, relatedProductSlug: relatedSlug,
    })
    if (!product) return null
    const related = relatedSlug ? await getRelated(relatedSlug) : null
    if (!related) delete product.relatedProductSlug
    return { product, relatedProduct: related, hasDraft: !!r.has_draft, versionNo: r.draft_version_no ?? r.published_version_no ?? null }
  }

  return {
    getPublishedProductBySlug, listPublishedProducts, resolveProductRedirect, resolveInventoryProductId,
    getPublishedProductSitemapEntries, getProductPreview, getGlobalSeo: async () => {
      try { return (await getSetting<unknown>(sql, 'seo.global', {})).value } catch { return {} }
    },
  }
}

export type ProductPublic = ReturnType<typeof createProductPublic>

// ── App-bound convenience exports (lazy: importing this file never touches the database) ────────
let bound: ProductPublic | null = null
async function app(): Promise<ProductPublic> {
  if (!bound) { const { sql } = await import('./db'); bound = createProductPublic(sql) }
  return bound
}
export const getPublishedProductBySlug = async (slug: string) => (await app()).getPublishedProductBySlug(slug)
export const listPublishedProducts = async (opts?: Parameters<ProductPublic['listPublishedProducts']>[0]) => (await app()).listPublishedProducts(opts)
export const resolveProductRedirect = async (slug: string) => (await app()).resolveProductRedirect(slug)
export const resolveInventoryProductId = async (slug: string) => (await app()).resolveInventoryProductId(slug)
export const getProductPreview = async (id: string) => (await app()).getProductPreview(id)
export const getGlobalSeoRaw = async () => (await app()).getGlobalSeo()

/** Contract with the `content` workstream (sitemap). Flag-aware; never throws. */
export async function getPublishedProductSitemapEntries(): Promise<Array<{ path: string; lastModified?: Date }>> {
  try { return await (await app()).getPublishedProductSitemapEntries() }
  catch (e) { console.error('product sitemap entries failed:', (e as Error).message); return [] }
}
