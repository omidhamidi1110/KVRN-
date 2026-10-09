import { getProductsByType } from '@/data/products'
import { ShopClient } from '@/components/shop/ShopClient'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { cmsContentEnabled, contentPublic } from '@/lib/content-public'
import { pageMetadata } from '@/lib/content-seo'

const LEGACY_METADATA = {
  title: 'Project KVRN — Available Now',
  description: 'Shop the Project KVRN collection. 500 GSM French terry, enzyme washed, pre-shrunk.',
  alternates: { canonical: '/collections/project-kvrn' },
}

function LegacyProjectKVRNPage() {
  // Project KVRN products use the phantom slugs
  const allHoodies    = getProductsByType('hoodie')
  const allSweatpants = getProductsByType('sweatpants')

  // Filter to only the Project KVRN (phantom slug) products
  const products = [
    ...allHoodies.filter(p => p.slug.includes('phantom')),
    ...allSweatpants.filter(p => p.slug.includes('phantom')),
  ].map(p => ({
    ...p,
    // Display names with "Heavyweight" prefix as requested
    // Rename: 'Project KVRN Heavyweight Hoodie' / 'Project KVRN Heavyweight Sweatpants'
    name: p.name.includes('Hoodie') ? 'Project KVRN Heavyweight Hoodie' : 'Project KVRN Heavyweight Sweatpants',
  }))

  return (
    <ShopClient
      products={products}
      type={null}
      headingOverride="Project KVRN"
    />
  )
}

// Flag off (default): the coded collection above, unchanged. Flag on: the Admin collection
// 'project-kvrn' controls whether the page is live, the product order, its heading and SEO.
// No Admin collection (or a database error) -> the coded page.
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  if (!cmsContentEnabled()) return LEGACY_METADATA
  const c = await contentPublic().getCollection('project-kvrn')
  if (!c) return LEGACY_METADATA
  const t = c.text.en
  return pageMetadata({ title: LEGACY_METADATA.title, description: LEGACY_METADATA.description, canonical: '/collections/project-kvrn' },
    { ...c.seo, title: c.seo.title || undefined, description: t.seoDescription || t.description || undefined } as any,
    c.shareImageUrl ?? c.hero?.url ?? null)
}

export default async function ProjectKVRNPage() {
  if (cmsContentEnabled()) {
    const state = await contentPublic().getCollectionState('project-kvrn')
    if (state === 'hidden') notFound()                       // deliberately deactivated in Admin
    if (state === 'live') {
      const c = await contentPublic().getCollection('project-kvrn')
      if (c) {
        const CODE_TO_SLUG: Record<string, string> = { PKHH: 'kvrn-phantom-hoodie', PKHSP: 'kvrn-phantom-sweatpants' }
        const coded = [...getProductsByType('hoodie'), ...getProductsByType('sweatpants')]
        const ordered = c.products
          .map(p => coded.find(x => x.slug === (CODE_TO_SLUG[p.productCode] ?? p.slug)))
          .filter((p): p is NonNullable<typeof p> => !!p)
          .map(p => ({ ...p, name: p.name.includes('Hoodie') ? 'Project KVRN Heavyweight Hoodie' : 'Project KVRN Heavyweight Sweatpants' }))
        if (ordered.length) return <ShopClient products={ordered} type={null} headingOverride={c.text.en.name} />
      }
    }
  }
  return <LegacyProjectKVRNPage />
}
