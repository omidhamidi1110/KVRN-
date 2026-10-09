// lib/product-seo.ts — product metadata, canonical URL and JSON-LD (pure; used by the CMS path only).
//
// The coded (flag-OFF) path keeps its existing metadata exactly. These helpers are used only when
// products are served from the Admin-managed catalog.
//   * per-product SEO fields beat global defaults; global defaults beat hard-coded ones;
//   * canonical URL is the product's own public URL unless an override is set;
//   * JSON-LD price is the canonical price; availability is OMITTED when it cannot be determined
//     (fail closed — never claim InStock without evidence), and offers are omitted with no price.
import type { Metadata } from 'next'
import type { Product } from '@/types'

export interface GlobalSeo { siteName?: string; defaultDescription?: string; defaultOgImage?: string }

/** Defensive read of the `content` workstream's `seo.global` value. Unknown shape -> {}. */
export function parseGlobalSeo(raw: unknown): GlobalSeo {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const o = raw as Record<string, unknown>
  const s = (v: unknown, max: number) => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined
  return {
    siteName: s(o.siteName, 80),
    defaultDescription: s(o.defaultDescription ?? o.description, 500),
    defaultOgImage: typeof o.defaultOgImage === 'string' && /^(\/|https:\/\/)/.test(o.defaultOgImage) ? o.defaultOgImage : undefined,
  }
}

export function productPath(slug: string): string { return `/products/${slug}` }

export function absoluteUrl(origin: string | null, path: string): string {
  return origin ? `${origin}${path}` : path
}

export interface MetaInput {
  product: Product
  origin: string | null
  canonicalOverride?: string | null
  og?: { url: string; alt: string } | null
  ogTitle?: string | null
  ogDescription?: string | null
  global?: GlobalSeo
}

export function buildProductMetadata(i: MetaInput): Metadata {
  const title = i.product.seo.title
  const description = i.product.seo.description || i.global?.defaultDescription || i.product.shortDescription
  const canonical = i.canonicalOverride || absoluteUrl(i.origin, productPath(i.product.slug))
  const ogImg = i.og ?? (i.global?.defaultOgImage ? { url: i.global.defaultOgImage, alt: i.product.name } : null)
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title: i.ogTitle || title,
      description: i.ogDescription || description,
      type: 'website',
      url: canonical,
      images: ogImg ? [{ url: ogImg.url, alt: ogImg.alt }] : [],
    },
    // Without this the card falls back to the site-wide twitter title/description, which describe the brand, not the product.
    twitter: {
      card: 'summary_large_image',
      title: i.ogTitle || title,
      description: i.ogDescription || description,
      images: ogImg ? [{ url: ogImg.url, alt: ogImg.alt }] : [],
    },
  }
}

export type Availability = 'InStock' | 'OutOfStock' | null

export interface JsonLdInput {
  product: Product
  origin: string | null
  imageUrls: string[]
  availability: Availability
  /** False for the legacy coded catalog: its static price is not authoritative checkout price. */
  emitOffer?: boolean
}

export function buildProductJsonLd(i: JsonLdInput): Record<string, unknown> {
  const p = i.product
  const url = absoluteUrl(i.origin, productPath(p.slug))
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: p.seo.description || p.shortDescription,
    url,
  }
  const imgs = i.imageUrls.filter(Boolean).map(u => absoluteUrl(i.origin, u))
  if (imgs.length) ld.image = imgs
  if (p.productCode) ld.sku = p.productCode
  ld.brand = { '@type': 'Brand', name: 'KVRN' }
  if (i.emitOffer !== false && typeof p.price === 'number' && p.price > 0) {
    const offer: Record<string, unknown> = {
      '@type': 'Offer', url, priceCurrency: 'USD', price: (p.price / 100).toFixed(2),
    }
    if (i.availability) offer.availability = `https://schema.org/${i.availability}`
    ld.offers = offer
  }
  return ld
}

/** Safe to embed in a <script type="application/ld+json">: escapes `<` so content cannot close the tag. */
export function jsonLdString(ld: unknown): string {
  return JSON.stringify(ld)
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029')
}
