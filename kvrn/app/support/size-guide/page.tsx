// Server wrapper for /support/size-guide. The coded page (a client component with the
// cm/in toggle) is kept UNCHANGED in LegacySizeGuide.tsx and is what renders with
// KVRN_FLAG_CMS_PUBLIC_CONTENT off, or when no Size Guide content is published.
import type { Metadata } from 'next'
import { cmsContentEnabled, contentPublic } from '@/lib/content-public'
import { pageMetadata } from '@/lib/content-seo'
import { SizeGuidePageView } from '@/components/content/cms-views'
import LegacySizeGuide from './LegacySizeGuide'

export const dynamic = 'force-dynamic'

async function load() {
  const [page, guides] = await Promise.all([contentPublic().getSupportPage('size-guide'), contentPublic().getPublicSizeGuides()])
  return page && guides && guides.length ? { page, guides } : null
}

// The coded page had no metadata of its own (it is a client component), so it inherits the site's.
export async function generateMetadata(): Promise<Metadata> {
  if (!cmsContentEnabled()) return {}
  const d = await load()
  if (!d) return {}
  const seo = d.page.variants.en.data.seo
  const has = seo.title || seo.description || seo.noindex || seo.shareTitle || seo.shareImageId
  return has ? pageMetadata({ title: 'Size Guide — KVRN' }, seo, seo.shareImageId ? d.page.media[seo.shareImageId]?.url ?? null : null) : {}
}

export default async function SizeGuidePage() {
  if (cmsContentEnabled()) {
    const d = await load()
    if (d) return <SizeGuidePageView page={d.page} guides={d.guides} />
  }
  return <LegacySizeGuide />
}
