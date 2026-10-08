// lib/product-public-shape.ts — snapshot + canonical rows -> the storefront `Product` (pure).
//
// This is the ONLY translation from CMS data to the PDP/Shop prop shape, so preview, the live
// page and the equivalence test all use it. Rules:
//   * price comes from CANONICAL products.price_cents (never from the snapshot's intent);
//   * sizes come from ACTIVE canonical variants (a deactivated size is not offered);
//   * the five shared gallery images drive Stage 2 and Stage 3; the hero is separate;
//   * focal points are carried per image (mobile/desktop) — null means "template default".
import type { ColorOption, Product, ProductImage, SizeOption } from '@/types'
import type { ProductSnapshot } from './product-model'
import { imageTypeAt, isUuid } from './product-model'
import { slotToImage, resolveRefUrl, type AssetMap } from './product-images'
import type { ProductDefaults } from './product-defaults'
import { FALLBACK_PRODUCT_DEFAULTS } from './product-defaults'

export interface CanonicalVariant { sku: string; size: string; sizeSort: number; colorCode: string; active: boolean }

export interface BuildInput {
  /** Identity exposed to the cart. Legacy products keep their coded id so existing carts still merge. */
  id: string
  snapshot: ProductSnapshot
  /** products.price_cents — canonical. */
  priceCents: number
  productCode?: string | null
  variants: ReadonlyArray<CanonicalVariant>
  assets: AssetMap
  defaults?: ProductDefaults
  /** Public slug of the paired (published) product when Complete the Set is enabled. */
  relatedProductSlug?: string | null
  /** Resolved body of a library size guide (mode 'library'), if any. */
  sizeGuideBody?: string | null
}

const SIZE_FALLBACK_ALT = (name: string, i: number) => `${name} — view ${i + 1}`

export function sizeValue(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'size'
}

export function buildSizes(variants: ReadonlyArray<CanonicalVariant>): SizeOption[] {
  const seen = new Map<string, { label: string; sort: number }>()
  for (const v of variants) {
    if (!v.active) continue
    const k = v.size.toLowerCase()
    const cur = seen.get(k)
    if (!cur || v.sizeSort < cur.sort) seen.set(k, { label: v.size, sort: v.sizeSort })
  }
  return [...seen.values()].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label))
    .map(s => ({ label: s.label, value: sizeValue(s.label), inStock: true }))
}

function galleryImages(slots: ProductSnapshot['media']['gallery'], assets: AssetMap, name: string, colorName: string): ProductImage[] {
  const out: ProductImage[] = []
  slots.forEach((s, i) => {
    const img = slotToImage(s, i, assets, `${name} — ${colorName} — view ${i + 1}`)
    if (img) out.push(img)
  })
  return out
}

/** Returns null when the snapshot cannot render (no colours or no resolvable gallery). */
export function buildPublicProduct(i: BuildInput): Product | null {
  const s = i.snapshot
  if (!s.colors.length) return null
  const defaults = i.defaults ?? FALLBACK_PRODUCT_DEFAULTS

  const shared = galleryImages(s.media.gallery, i.assets, s.name, s.colors[0].name)
  const heroSlot = s.media.hero
  const heroImage = slotToImage(heroSlot, 0, i.assets, `${s.name} — hero`) ?? undefined

  const colors: ColorOption[] = s.colors.map(c => {
    const own = c.media && c.media.gallery.length
      ? galleryImages(c.media.gallery, i.assets, s.name, c.name) : []
    const images = own.length ? own : shared.map((im, idx) => ({
      ...im, alt: s.media.gallery[idx]?.alt || SIZE_FALLBACK_ALT(`${s.name} — ${c.name}`, idx), type: imageTypeAt(idx),
    }))
    const hero = c.media ? slotToImage(c.media.hero, 0, i.assets, `${s.name} — ${c.name}`) ?? undefined : undefined
    return { name: c.name, value: c.key, hex: c.hex, code: c.code, images, ...(hero ? { hero } : {}) }
  })
  if (!colors.some(c => c.images.length)) return null

  const sr = s.shippingReturns.mode === 'override' && s.shippingReturns.lines.length
    ? { lines: s.shippingReturns.lines, linkLabel: defaults.shippingReturns.linkLabel, href: defaults.shippingReturns.href }
    : defaults.shippingReturns
  const guideBody = s.sizeGuide.mode === 'override' ? s.sizeGuide.body : s.sizeGuide.mode === 'library' ? (i.sizeGuideBody ?? null) : null

  const product: Product = {
    id: i.id,
    name: s.name,
    slug: s.slug,
    type: s.productType,
    price: i.priceCents,
    shortDescription: s.shortDescription,
    constructionDetails: s.constructionDetails,
    description: s.description,
    colors,
    sizes: buildSizes(i.variants),
    features: s.features.map(f => ({ title: f.title, description: f.description })),
    specs: s.specs.map(f => ({ label: f.label, value: f.value })),
    fitNote: s.fitNote ?? '',
    ...(s.founderNote ? { founderNote: s.founderNote } : {}),
    ...(s.shop.listed ? {} : { hidden: true }),
    ...(i.relatedProductSlug ? { relatedProductSlug: i.relatedProductSlug } : {}),
    ...(s.eyebrow ? { eyebrow: s.eyebrow } : {}),
    ...(heroImage ? { heroImage } : {}),
    ...(i.productCode ? { productCode: i.productCode } : {}),
    sections: { ...s.sections },
    shippingReturns: sr,
    sizeGuide: guideBody ? { title: 'Size guide', body: guideBody } : null,
    seo: {
      title: s.seo.title || `${s.name} | KVRN`,
      description: s.seo.description || s.shortDescription,
    },
  }
  return product
}

/** OG image URL (absolute-or-root-relative) for a snapshot, if any resolves. */
export function resolveOgImage(s: ProductSnapshot, assets: AssetMap): { url: string; alt: string } | null {
  const ref = s.seo.ogImage ?? s.media.hero?.ref ?? s.media.gallery[0]?.ref ?? null
  const r = resolveRefUrl(ref, assets)
  if (!r) return null
  const alt = s.seo.ogImage ? s.name : (s.media.hero?.alt || s.media.gallery[0]?.alt || s.name)
  return { url: r.src, alt }
}

export { isUuid }
