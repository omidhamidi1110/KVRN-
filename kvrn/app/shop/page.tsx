import type { Metadata } from 'next'
import { getVisibleProducts } from '@/data/products'
import { ShopClient } from '@/components/shop/ShopClient'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { listPublishedProducts } from '@/lib/product-public'
import { getRequestLocale } from '@/lib/i18n/server'
import { localizePublishedHits } from '@/lib/product-localize'

interface PageProps {
  searchParams: Promise<{ type?: string }>
}

// Rendered per request so Admin publish/unpublish is visible immediately when the catalog is CMS-driven.
export const dynamic = 'force-dynamic'

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const { type } = await searchParams
  if (type === 'hoodies')    return { title: 'Hoodies — KVRN', description: 'Shop KVRN heavyweight hoodies. 400 GSM brushed fleece and 500 GSM French terry.' }
  if (type === 'sweatpants') return { title: 'Sweatpants — KVRN', description: 'Shop KVRN heavyweight sweatpants. Wide-leg and relaxed fits.' }
  return { title: 'Shop — KVRN', description: 'Shop the full KVRN collection. Heavyweight hoodies and sweatpants.' }
}

export default async function ShopPage({ searchParams }: PageProps) {
  const { type } = await searchParams
  const isHoodies    = type === 'hoodies'
  const isSweatpants = type === 'sweatpants'
  const visible      = getVisibleProducts()
  const displayed    = isHoodies
    ? visible.filter(p => p.type === 'hoodie')
    : isSweatpants
    ? visible.filter(p => p.type === 'sweatpants')
    : visible

  if (isFeatureEnabled('CMS_PRODUCT_ROUTING')) {
    let hits = await listPublishedProducts()
    try {   // product words in the visitor's language; a translation problem leaves English
      const { sql } = await import('@/lib/db')
      const locale = await getRequestLocale(sql)
      if (locale !== 'en') hits = await localizePublishedHits(sql, hits, locale)
    } catch { /* English */ }
    const live = hits.map(p => p.product)
    const listing = isHoodies ? live.filter(p => p.type === 'hoodie')
      : isSweatpants ? live.filter(p => p.type === 'sweatpants') : live
    // Hero links show canonical prices and only point at live products; the grid lists the same set.
    return <ShopClient products={displayed} type={type ?? null} listing={listing} />
  }

  return <ShopClient products={displayed} type={type ?? null} />
}
