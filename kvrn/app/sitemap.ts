import type { MetadataRoute } from 'next'
import { getAllProductSlugs } from '@/data/products'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://kvrn.com'

export default function sitemap(): MetadataRoute.Sitemap {
  const productSlugs = getAllProductSlugs()

  const productPages: MetadataRoute.Sitemap = productSlugs.map((slug) => ({
    url:            `${BASE_URL}/products/${slug}`,
    lastModified:   new Date(),
    changeFrequency:'weekly',
    priority:        0.9,
  }))

  return [
    {
      url:            BASE_URL,
      lastModified:   new Date(),
      changeFrequency:'weekly',
      priority:        1.0,
    },
    {
      url:            `${BASE_URL}/shop`,
      lastModified:   new Date(),
      changeFrequency:'weekly',
      priority:        0.9,
    },
    ...productPages,
    {
      url:            `${BASE_URL}/about`,
      lastModified:   new Date(),
      changeFrequency:'monthly',
      priority:        0.7,
    },
    {
      url:            `${BASE_URL}/waitlist`,
      lastModified:   new Date(),
      changeFrequency:'monthly',
      priority:        0.6,
    },
    {
      url:            `${BASE_URL}/contact`,
      lastModified:   new Date(),
      changeFrequency:'monthly',
      priority:        0.5,
    },
    {
      url:            `${BASE_URL}/support/faq`,
      lastModified:   new Date(),
      changeFrequency:'monthly',
      priority:        0.6,
    },
    {
      url:            `${BASE_URL}/support/shipping-returns`,
      lastModified:   new Date(),
      changeFrequency:'monthly',
      priority:        0.5,
    },
    {
      url:            `${BASE_URL}/privacy`,
      lastModified:   new Date(),
      changeFrequency:'yearly',
      priority:        0.2,
    },
    {
      url:            `${BASE_URL}/support/track`,
      lastModified:   new Date(),
      changeFrequency:'monthly' as const,
      priority:        0.4,
    },
    {
      url:            `${BASE_URL}/support/size-guide`,
      lastModified:   new Date(),
      changeFrequency:'monthly' as const,
      priority:        0.6,
    },
    {
      url:            `${BASE_URL}/terms`,
      lastModified:   new Date(),
      changeFrequency:'yearly',
      priority:        0.2,
    },
  ]
}
