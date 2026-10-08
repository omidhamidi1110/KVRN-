// lib/content-seo.ts — site-wide metadata + per-page overrides. PURE (no DB).
//
// Precedence (spec): a page/policy/collection/product override > global SEO defaults >
// the previously hardcoded values. `siteMetadata(DEFAULT_GLOBAL_SEO)` reproduces the exact
// object that app/layout.tsx used to hardcode, so the flag-OFF output is unchanged.

import type { Metadata } from 'next'
import { DEFAULT_GLOBAL_SEO } from './content-defaults'
import type { GlobalSeo, SeoFields } from './content-schemas'

const BASE = () => process.env.NEXT_PUBLIC_SITE_URL ?? 'https://kvrn.shop'

/** Merge a (possibly partial/old/hand-edited) stored setting over the coded defaults. */
export function mergeGlobalSeo(stored: unknown, locale = 'en'): GlobalSeo {
  const d = DEFAULT_GLOBAL_SEO
  const s = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Partial<GlobalSeo> : {}
  const str = (v: unknown, dflt: string) => (typeof v === 'string' && v.trim() ? v : dflt)
  const org: Partial<GlobalSeo['organization']> = s.organization && typeof s.organization === 'object' ? s.organization : {}
  const merged: GlobalSeo = {
    siteName: str(s.siteName, d.siteName),
    titleDefault: str(s.titleDefault, d.titleDefault),
    titleTemplate: typeof s.titleTemplate === 'string' && s.titleTemplate.includes('%s') ? s.titleTemplate : d.titleTemplate,
    description: str(s.description, d.description),
    keywords: Array.isArray(s.keywords) && s.keywords.every(k => typeof k === 'string') && s.keywords.length ? s.keywords : d.keywords,
    ogTitle: str(s.ogTitle, d.ogTitle),
    ogDescription: str(s.ogDescription, d.ogDescription),
    twitterTitle: str(s.twitterTitle, d.twitterTitle),
    twitterDescription: str(s.twitterDescription, d.twitterDescription),
    shareImageId: typeof s.shareImageId === 'string' ? s.shareImageId : undefined,
    shareImageUrl: typeof s.shareImageUrl === 'string' && s.shareImageUrl.startsWith('/media/') ? s.shareImageUrl : undefined,
    organization: {
      type: org.type === 'Organization' || org.type === 'Store' ? org.type : 'ClothingStore',
      name: str(org.name, d.organization.name),
      url: typeof org.url === 'string' && org.url.startsWith('https://') ? org.url : d.organization.url,
      description: str(org.description, d.organization.description),
      email: str(org.email, d.organization.email),
      sameAs: Array.isArray(org.sameAs) && org.sameAs.every(u => typeof u === 'string' && u.startsWith('https://')) && org.sameAs.length ? org.sameAs : d.organization.sameAs,
      contactType: str(org.contactType, d.organization.contactType),
      availableLanguage: str(org.availableLanguage, d.organization.availableLanguage),
    },
    translations: s.translations && typeof s.translations === 'object' ? s.translations : {},
  }
  const t = merged.translations[locale]
  if (locale !== 'en' && t) {
    for (const k of ['titleDefault', 'description', 'ogTitle', 'ogDescription', 'twitterTitle', 'twitterDescription'] as const) {
      if (typeof t[k] === 'string' && t[k]) (merged as any)[k] = t[k]
    }
  }
  return merged
}

/** The root layout metadata. With DEFAULT_GLOBAL_SEO this equals the old hardcoded object. */
export function siteMetadata(g: GlobalSeo = DEFAULT_GLOBAL_SEO): Metadata {
  const img = g.shareImageUrl ? [{ url: g.shareImageUrl }] : undefined
  return {
    title: { default: g.titleDefault, template: g.titleTemplate },
    description: g.description,
    keywords: g.keywords,
    authors: [{ name: g.siteName }],
    creator: g.siteName,
    metadataBase: new URL(BASE()),
    openGraph: {
      type: 'website', locale: 'en_US', url: g.organization.url, siteName: g.siteName,
      title: g.ogTitle, description: g.ogDescription,
      ...(img ? { images: img } : {}),
    },
    twitter: {
      card: 'summary_large_image', title: g.twitterTitle, description: g.twitterDescription,
      ...(img ? { images: img.map(i => i.url) } : {}),
    },
    robots: { index: true, follow: true, googleBot: { index: true, follow: true } },
    icons: { icon: '/favicon.ico', apple: '/apple-touch-icon.png' },
    manifest: '/site.webmanifest',
  }
}

/** Organization JSON-LD (the schema the layout used to hardcode). */
export function orgSchema(g: GlobalSeo = DEFAULT_GLOBAL_SEO) {
  return {
    '@context': 'https://schema.org',
    '@type': g.organization.type,
    name: g.organization.name,
    url: g.organization.url,
    description: g.organization.description,
    email: g.organization.email,
    sameAs: g.organization.sameAs,
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: g.organization.contactType,
      email: g.organization.email,
      availableLanguage: g.organization.availableLanguage,
    },
  }
}

/** JSON for a <script type="application/ld+json"> body: '<' is escaped so content can never close the tag. */
export const jsonLd = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c')

export interface CodedMeta { title: string; description?: string; robots?: Metadata['robots'] }

/**
 * Per-page metadata. `coded` is what the page used before the CMS, so a page with no
 * overrides renders the same title/description/robots. Overrides win; a share image falls
 * back to the global default.
 */
export function pageMetadata(coded: CodedMeta, seo: SeoFields | undefined, shareImageUrl?: string | null, global?: GlobalSeo | null): Metadata {
  const title = seo?.title || coded.title
  const description = seo?.description || coded.description
  const md: Metadata = { title }
  if (description) md.description = description
  md.robots = seo?.noindex ? { index: false, follow: false } : coded.robots
  if (md.robots === undefined) delete md.robots
  const img = shareImageUrl || null
  if (seo?.shareTitle || img) {
    md.openGraph = {
      type: 'website', siteName: global?.siteName ?? 'KVRN',
      title: seo?.shareTitle || title,
      ...(description ? { description } : {}),
      ...(img ? { images: [{ url: img }] } : {}),
    }
    md.twitter = { card: 'summary_large_image', title: seo?.shareTitle || title, ...(img ? { images: [img] } : {}) }
  }
  return md
}
