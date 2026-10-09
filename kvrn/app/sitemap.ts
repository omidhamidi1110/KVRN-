import type { MetadataRoute } from 'next'
import { getPublishedProductSitemapEntries } from '@/lib/product-public'
import { cmsContentEnabled, contentPublic } from '@/lib/content-public'

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://kvrn.shop'

// Rendered per request: published content changes (and the CMS flag) take effect without a rebuild.
export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Product URLs come from the product workstream's published-products loader (which itself
  // returns the coded catalog while its own flag is off).
  let productEntries: Array<{ path: string; lastModified?: Date }> = []
  try { productEntries = await getPublishedProductSitemapEntries() } catch { productEntries = [] }
  const productPages: MetadataRoute.Sitemap = productEntries.map(({ path, lastModified }) => ({
    url: `${BASE}${path}`,
    ...(lastModified ? { lastModified } : {}),
    changeFrequency:'weekly',
    priority:        0.9,
  }))

  const coded: MetadataRoute.Sitemap = [
    { url: BASE,                                    changeFrequency:'weekly',  priority: 1.0 },
    { url: `${BASE}/shop`,                          changeFrequency:'weekly',  priority: 0.9 },
    ...productPages,
    { url: `${BASE}/about`,                         changeFrequency:'monthly', priority: 0.7 },
    { url: `${BASE}/contact`,                       changeFrequency:'monthly', priority: 0.5 },
    { url: `${BASE}/support/faq`,                   changeFrequency:'monthly', priority: 0.6 },
    { url: `${BASE}/support/shipping-returns`,      changeFrequency:'monthly', priority: 0.6 },
    { url: `${BASE}/support/size-guide`,            changeFrequency:'monthly', priority: 0.6 },
    // Order tracking is a private utility form, not a search landing page.
    { url: `${BASE}/privacy`,                       changeFrequency:'yearly',  priority: 0.2 },
    { url: `${BASE}/terms`,                         changeFrequency:'yearly',  priority: 0.2 },
  ]
  if (!cmsContentEnabled()) return coded

  // Flag on: add published Admin content (custom policies, pages, collections, ...) and drop the coded
  // entry of anything Admin has marked noindex. Drafts / unpublished / archived are never listed.
  const plan = await contentPublic().getSitemapPlan()
  const excluded = new Set(plan.excluded.map(p => `${BASE}${p}`))
  const byUrl = new Map<string, MetadataRoute.Sitemap[number]>()
  for (const e of coded) if (!excluded.has(e.url)) byUrl.set(e.url, e)
  for (const e of plan.entries) {
    if (e.path === '/support/track' || e.path === '/privacy-choices' || e.path === '/email-preferences') continue
    // Dedicated SMS policy URLs must not be offered to crawlers while gated (404).
    if ((e.path === '/messaging-terms' || e.path === '/messaging-privacy') && process.env.KVRN_SMS_POLICY_PUBLIC_ENABLED !== 'true') continue
    const url = `${BASE}${e.path}`
    const prev = byUrl.get(url)
    byUrl.set(url, { url, ...(e.lastModified || prev?.lastModified ? { lastModified: e.lastModified ?? prev?.lastModified } : {}),
                     changeFrequency: e.changeFrequency ?? prev?.changeFrequency, priority: e.priority ?? prev?.priority })
  }
  return [...byUrl.values()]
}
