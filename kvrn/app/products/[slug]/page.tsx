import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getProductBySlug, getAllProductSlugs, products } from '@/data/products'
import { PDPClient } from './PDPClient'

// Next 15: params is a Promise — must be typed and awaited accordingly
interface PageProps {
  params: Promise<{ slug: string }>
}

// ─── Static params for all product slugs ─────────────────────────────────────
export function generateStaticParams() {
  return getAllProductSlugs().map((slug) => ({ slug }))
}

// ─── Dynamic metadata per product ────────────────────────────────────────────
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
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
  const product = getProductBySlug(slug)
  if (!product) notFound()

  const relatedProduct = product.relatedProductSlug
    ? (products.find((p) => p.slug === product.relatedProductSlug) ?? null)
    : null

  return <PDPClient product={product} relatedProduct={relatedProduct} />
}
