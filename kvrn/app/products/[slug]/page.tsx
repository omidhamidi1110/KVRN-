import { cache } from 'react'
import { notFound, permanentRedirect } from 'next/navigation'
import type { Metadata } from 'next'
import { getProductBySlug, products } from '@/data/products'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { getPublishedProductBySlug, resolveProductRedirect, getGlobalSeoRaw, type PublishedProduct } from '@/lib/product-public'
import { buildProductMetadata, buildProductJsonLd, jsonLdString, parseGlobalSeo } from '@/lib/product-seo'
import { getSiteOrigin } from '@/lib/site-origin'
import { getPublicBundleForOwner } from '@/lib/bundle-public'
import { PDPClient } from './PDPClient'
import { getRequestLocale } from '@/lib/i18n/server'
import { localizePublishedHits } from '@/lib/product-localize'

/** The published hit with its words in the visitor's language (English / no published translation: unchanged). */
async function localized(hit: PublishedProduct): Promise<PublishedProduct> {
  try {
    const { sql } = await import('@/lib/db')
    const locale = await getRequestLocale(sql)
    if (locale === 'en') return hit
    return (await localizePublishedHits(sql, [hit], locale))[0] ?? hit
  } catch { return hit }          // never let a translation problem take the product page down
}

// Next 15: params is a Promise — must be typed and awaited accordingly
interface PageProps {
  params: Promise<{ slug: string }>
}

// Product pages are rendered per request: with CMS_PRODUCT_ROUTING on, a publish/unpublish must
// be visible immediately after commit (see lib/cache-invalidation.ts for how the site is cached).
export const dynamic = 'force-dynamic'

type Resolved =
  | { kind: 'cms'; hit: PublishedProduct }
  | { kind: 'redirect'; to: string }
  | { kind: 'coded' }
  | { kind: 'none' }

/**
 * Flag ON: published Admin-managed product -> its old-slug redirect -> a coded product that is
 * hidden from listings but still routable (kept so existing links keep working) -> 404.
 * A database error propagates (the page errors) rather than serving the coded catalog in place
 * of a product that may have been unpublished or repriced.
 */
const resolveCms = cache(async (slug: string): Promise<Resolved> => {
  const hit = await getPublishedProductBySlug(slug)
  if (hit) return { kind: 'cms', hit }
  const red = await resolveProductRedirect(slug)
  if (red) return { kind: 'redirect', to: red.to }
  const coded = getProductBySlug(slug)
  if (coded?.hidden) return { kind: 'coded' }
  return { kind: 'none' }
})

// ─── Dynamic metadata per product ────────────────────────────────────────────
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params

  if (isFeatureEnabled('CMS_PRODUCT_ROUTING')) {
    const r = await resolveCms(slug)
    if (r.kind === 'cms') {
      const global = parseGlobalSeo(await getGlobalSeoRaw().catch(() => ({})))
      const s = r.hit.snapshot
      const lh = await localized(r.hit)
      const translated = lh.product !== r.hit.product
      return buildProductMetadata({
        product: lh.product, origin: getSiteOrigin(), canonicalOverride: s.seo.canonicalUrl,
        og: r.hit.ogImage,
        // The Open Graph overrides are English-only fields: with a translation, share text follows the translated SEO text.
        ogTitle: translated ? null : s.seo.ogTitle, ogDescription: translated ? null : s.seo.ogDescription, global,
      })
    }
    if (r.kind !== 'coded') return { title: 'Product Not Found | KVRN' }
  }

  const product = getProductBySlug(slug)
  if (!product) return { title: 'Product Not Found | KVRN' }

  const firstImage = product.colors[0]?.images[0]

  return {
    title:       product.seo.title,
    description: product.seo.description,
    openGraph: {
      title:       product.seo.title,
      description: product.seo.description,
      type:        'website',
      images:      firstImage ? [{ url: firstImage.src, alt: firstImage.alt }] : [],
    },
  }
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default async function ProductPage({ params }: PageProps) {
  const { slug } = await params

  if (isFeatureEnabled('CMS_PRODUCT_ROUTING')) {
    const r = await resolveCms(slug)
    if (r.kind === 'redirect') permanentRedirect(r.to)
    if (r.kind === 'none') notFound()
    if (r.kind === 'cms') {
      const hit = await localized(r.hit)
      const ld = buildProductJsonLd({
        product: hit.product, origin: getSiteOrigin(), imageUrls: hit.imageUrls, availability: hit.availability,
      })
      // Published, enabled bundle ("Complete the Set") for this product, resolved server-side from
      // canonical data. null (none / not resolvable / any error) => the page renders exactly as before.
      const bundle = await getPublicBundleForOwner(hit.productId)
      return (
        <>
          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(ld) }} />
          <PDPClient product={hit.product} relatedProduct={hit.relatedProduct} {...(bundle ? { bundle } : {})} />
        </>
      )
    }
    // kind === 'coded': hidden coded product — rendered exactly as in the coded path below.
  }

  const product = getProductBySlug(slug)
  if (!product) notFound()

  const relatedProduct = product.relatedProductSlug
    ? (products.find((p) => p.slug === product.relatedProductSlug) ?? null)
    : null

  return <PDPClient product={product} relatedProduct={relatedProduct} />
}
