// lib/bundle-public.ts — the storefront READ PATH for a product's published bundle.
//
// Reads ONLY the published projection (`bundles` / `bundle_components`, written at publish time)
// and the canonical product/variant rows. Name, URL, price, image, eligible variants and live
// availability are resolved here, on the server, from canonical sources — the Admin never types them
// and the page never invents them. Fail closed: if any part cannot be resolved (a component is
// unpublished, repriced so the rule is no longer a valid discount, or its page cannot be built),
// the bundle is NOT shown rather than shown wrong.
import { isFeatureEnabled } from './feature-flags'
import { loadBundleFacts, type BundleFacts } from './bundle-checkout'
import { priceBundle } from './bundle-pricing'
import type { PublicBundle, PublicBundleColor, PublicBundleComponent } from './bundle-types'
import type { Product } from '@/types'

type Sql = any

export interface BundlePublicDeps {
  /** Resolves a published product's storefront shape by public slug (lib/product-public). */
  getPublishedProductBySlug: (slug: string) => Promise<{ product: Product } | null>
  isEnabled?: () => boolean
}

const firstImage = (p: Product, colorValue?: string) => {
  const c = p.colors.find(x => x.value === colorValue) ?? p.colors[0]
  const im = c?.hero ?? c?.images.find(i => i.type === 'front') ?? c?.images[0] ?? p.heroImage
  return im?.src ? { src: im.src, alt: im.alt || p.name } : null
}

/** Pure: assemble the public bundle from facts + resolved product pages. Null = do not show. */
export function assemblePublicBundle(
  facts: BundleFacts,
  slugs: Record<string, string>,
  products: Record<string, Product>,
): PublicBundle | null {
  if (!facts.bundle.enabled || facts.components.length === 0) return null
  const comps: PublicBundleComponent[] = []
  for (const c of facts.components) {
    if (!c.active || !c.live || c.currency !== 'usd' || c.priceCents < 1) return null
    const slug = slugs[c.productId]
    const prod = products[c.productId]
    if (!slug || !prod) return null
    const variants = facts.variants
      .filter(v => v.productId === c.productId && v.active && (!c.allowedVariantIds || c.allowedVariantIds.includes(v.id)))
      .sort((a, b) => a.sizeSort - b.sizeSort || a.sku.localeCompare(b.sku))
    if (variants.length === 0) return null
    const codes = new Set(variants.map(v => v.colorCode))
    let colors: PublicBundleColor[] = prod.colors
      .filter(col => codes.has(col.code ?? ''))
      .map(col => ({ code: col.code ?? '', name: col.name, hex: col.hex, image: firstImage(prod, col.value) }))
    if (colors.length === 0) {
      // Variants whose colour code is not in the product's colour list: offer them under one neutral choice.
      colors = [...codes].map(code => ({
        code, name: variants.find(v => v.colorCode === code)?.color ?? 'Default', hex: '#111111', image: firstImage(prod),
      }))
    }
    comps.push({
      productId: c.productId, isOwner: c.isOwner, name: prod.name, slug, href: `/products/${slug}`,
      priceCents: c.priceCents, viewSeparately: !c.isOwner && c.viewSeparately,
      image: firstImage(prod), colors,
      variants: variants.map(v => ({ sku: v.sku, size: v.size, sizeSort: v.sizeSort, colorCode: v.colorCode, colorName: v.color, available: v.available })),
      available: variants.some(v => v.available > 0),
    })
  }
  // The rule must still be a valid discount at today's canonical prices.
  const check = priceBundle({
    mode: facts.bundle.mode, value: facts.bundle.value,
    components: comps.map((c, i) => ({ key: c.productId, unitPriceCents: c.priceCents, sortKey: String(i).padStart(3, '0') })),
  })
  if (!check.ok) return null
  const p = facts.bundle.presentation ?? {}
  const t = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  return {
    bundleId: facts.bundle.id, ownerProductId: facts.bundle.ownerProductId, revision: facts.bundle.revision,
    mode: facts.bundle.mode, value: facts.bundle.value, includeOwner: facts.bundle.includeOwner,
    presentation: {
      eyebrow: t(p.eyebrow), headline: t(p.headline), supportingCopy: t(p.supportingCopy), ctaLabel: t(p.ctaLabel),
      sectionVisible: p.sectionVisible !== false,
    },
    components: comps,
  }
}

export function createBundlePublic(sql: Sql, deps: BundlePublicDeps) {
  const enabled = deps.isEnabled ?? (() => isFeatureEnabled('CMS_PRODUCT_ROUTING'))

  /** The published, enabled, fully resolvable bundle for a product page; null otherwise (never throws). */
  async function getForOwner(ownerProductId: string): Promise<PublicBundle | null> {
    if (!enabled()) return null
    try {
      const hdr = await sql`
        SELECT b.id::text AS id FROM bundles b
          JOIN content_entities e ON e.entity_type = 'product' AND e.entity_id = b.owner_product_id::text AND e.status = 'published'
         WHERE b.owner_product_id = ${ownerProductId}::uuid AND b.enabled` as any[]
      if (!hdr[0]) return null
      const facts = await loadBundleFacts(sql, hdr[0].id)
      if (!facts) return null
      const ids = facts.components.map(c => c.productId)
      const slugRows = await sql`
        SELECT e.entity_id AS id, e.slug FROM content_entities e
         WHERE e.entity_type = 'product' AND e.status = 'published' AND e.entity_id = ANY(${ids}::text[])` as any[]
      const slugs: Record<string, string> = {}
      for (const r of slugRows) if (r.slug) slugs[r.id] = r.slug
      const products: Record<string, Product> = {}
      for (const id of ids) {
        if (!slugs[id]) return null
        const hit = await deps.getPublishedProductBySlug(slugs[id])
        if (hit) products[id] = hit.product
      }
      return assemblePublicBundle(facts, slugs, products)
    } catch (e: any) {
      console.error('[bundle] public load failed:', String(e?.message ?? '').slice(0, 120))
      return null
    }
  }
  return { getForOwner }
}

// ── App-bound convenience export (lazy: importing this file never touches the database) ───────
export async function getPublicBundleForOwner(ownerProductId: string): Promise<PublicBundle | null> {
  if (!isFeatureEnabled('CMS_PRODUCT_ROUTING')) return null
  const [{ sql }, { getPublishedProductBySlug }] = await Promise.all([import('./db'), import('./product-public')])
  return createBundlePublic(sql, { getPublishedProductBySlug }).getForOwner(ownerProductId)
}
