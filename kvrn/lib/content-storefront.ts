// lib/content-storefront.ts — small server helpers shared by the flag-gated storefront pages.

import type { Metadata } from 'next'
import { contentPublic, type View } from './content-public'
import { pageMetadata } from './content-seo'
import type { PolicySnapshot, PageSnapshot } from './content-schemas'

/** Metadata for a CMS policy page: coded defaults < global SEO < the policy's own SEO fields. */
export function policyMetadata(view: View<PolicySnapshot>, legacy: Metadata, extra: { noindex?: boolean } = {}): Metadata {
  const s = view.variants.en.data
  const img = s.seo.shareImageId ? view.media[s.seo.shareImageId]?.url ?? null : null
  const robots = extra.noindex ? { index: false, follow: false } : (legacy.robots ?? undefined)
  const result = pageMetadata(
    { title: `${s.title} — KVRN`, description: typeof legacy.description === 'string' ? legacy.description : undefined, robots: robots as Metadata['robots'] },
    extra.noindex ? { ...s.seo, noindex: true } : s.seo, img)
  // pageMetadata focuses on title/OG/robots; preserve the real canonical URL here.
  return { ...result, alternates: { ...legacy.alternates, canonical: view.path ?? legacy.alternates?.canonical } }
}

export function genericPageMetadata(view: View<PageSnapshot>): Metadata {
  const s = view.variants.en.data
  const img = s.seo.shareImageId ? view.media[s.seo.shareImageId]?.url ?? null : null
  const result = pageMetadata({ title: `${s.title} — KVRN`, description: s.subtitle }, s.seo, img)
  return { ...result, ...(view.path ? { alternates: { canonical: view.path } } : {}) }
}

export { contentPublic }
