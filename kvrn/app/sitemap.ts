import type { MetadataRoute } from 'next'
import { getAllProductSlugs } from '@/data/products'

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://kvrn.com'

export default function sitemap(): MetadataRoute.Sitemap {
  const productPages: MetadataRoute.Sitemap = getAllProductSlugs().map(slug => ({
    url: `${BASE}/products/${slug}`,
    lastModified:   new Date(),
    changeFrequency:'weekly',
    priority:        0.9,
  }))

  return [
    { url: BASE,                                    lastModified: new Date(), changeFrequency:'weekly',  priority: 1.0 },
    { url: `${BASE}/shop`,                          lastModified: new Date(), changeFrequency:'weekly',  priority: 0.9 },
    { url: `${BASE}/shop?type=hoodies`,             lastModified: new Date(), changeFrequency:'weekly',  priority: 0.8 },
    { url: `${BASE}/shop?type=sweatpants`,          lastModified: new Date(), changeFrequency:'weekly',  priority: 0.8 },
    ...productPages,
    { url: `${BASE}/about`,                         lastModified: new Date(), changeFrequency:'monthly', priority: 0.7 },
    { url: `${BASE}/waitlist`,                      lastModified: new Date(), changeFrequency:'monthly', priority: 0.6 },
    { url: `${BASE}/contact`,                       lastModified: new Date(), changeFrequency:'monthly', priority: 0.5 },
    { url: `${BASE}/support/faq`,                   lastModified: new Date(), changeFrequency:'monthly', priority: 0.6 },
    { url: `${BASE}/support/shipping-returns`,      lastModified: new Date(), changeFrequency:'monthly', priority: 0.6 },
    { url: `${BASE}/support/size-guide`,            lastModified: new Date(), changeFrequency:'monthly', priority: 0.6 },
    { url: `${BASE}/support/track`,                 lastModified: new Date(), changeFrequency:'monthly', priority: 0.4 },
    { url: `${BASE}/privacy`,                       lastModified: new Date(), changeFrequency:'yearly',  priority: 0.2 },
    { url: `${BASE}/terms`,                         lastModified: new Date(), changeFrequency:'yearly',  priority: 0.2 },
  ]
}
