// lib/content-public.ts — storefront READ path for Admin-managed content.
//
// Every loader returns ONLY published content (drafts, unpublished and archived items are
// never returned), and returns null when there is nothing to show so the caller falls back to
// the coded page. Loaders never throw into a page: a database error is logged (message only)
// and treated as "no CMS content" — a legal page must never 500 because the CMS is unreachable.
//
// With the CMS_PUBLIC_CONTENT flag OFF callers do not call these at all (see
// `cmsContentEnabled`). Nothing is cached here: CMS-backed pages are `force-dynamic`.

import { createCms } from './cms-core'
import { sql } from './db'
import { isFeatureEnabled } from './feature-flags'
import { getEnabledLocales } from './content-locales'
import { buildVariants, type Variant } from './content-localize'
import { SOURCE_LOCALE, type TranslationRow } from './translations'
import {
  KINDS, policyPath, isAnnouncementActive,
  type ContentKind, type PolicySnapshot, type FaqSnapshot, type SizeGuideSnapshot, type SupportPageSnapshot,
  type PageSnapshot, type AboutSnapshot, type ContactSnapshot, type GlobalSeo, type ContentBlockSnapshot,
} from './content-schemas'
import { GLOBAL_SEO_KEY } from './content-schemas'
import { mergeGlobalSeo } from './content-seo'
import { collectMediaIds, collectBlockRefs, type RichText } from './content-richtext'
import { mediaUrlForKey } from './media-storage'
import { checkUrl } from './content-urls'
import type { ShellData, TrMap } from './content-shell'
import { EMPTY_TR } from './content-shell'
import type { RenderMedia } from '../components/content/render-richtext'

type Sql = any

export const cmsContentEnabled = () => isFeatureEnabled('CMS_PUBLIC_CONTENT')

export interface View<T> {
  id: string
  slug: string | null
  path: string | null
  publishedAt: string | null
  /** locale → variant. Always contains 'en'. A locale missing here means "not translated: use English". */
  variants: Record<string, Variant<T>>
  media: Record<string, RenderMedia>
  /** locale → blockId → content (English entry is the fallback). */
  blocks: Record<string, Record<string, RichText>>
}

function logSafe(where: string, e: unknown) {
  // message only: no SQL, no params, no stack
  console.error(`[content-public] ${where}: ${String((e as any)?.message ?? e).slice(0, 160)}`)
}

export function createContentPublic(sql: Sql) {
  const cms = createCms(sql)

  async function safe<T>(where: string, fn: () => Promise<T | null>): Promise<T | null> {
    try { return await fn() } catch (e) { logSafe(where, e); return null }
  }

  async function translationRows(type: string, id: string): Promise<TranslationRow[]> {
    return await sql`SELECT entity_type, entity_id, locale, field, value, status, source_hash, machine_generated, updated_at
                       FROM content_translations WHERE entity_type = ${type} AND entity_id = ${id} AND status = 'published'` as TranslationRow[]
  }

  async function resolveMedia(ids: string[]): Promise<Record<string, RenderMedia>> {
    const uniq = [...new Set(ids)]
    if (!uniq.length) return {}
    const rows = await sql`SELECT id, storage_key, alt_text, width, height FROM media_assets WHERE id = ANY(${uniq}::uuid[])` as any[]
    const out: Record<string, RenderMedia> = {}
    for (const r of rows) out[r.id] = { url: mediaUrlForKey(r.storage_key), alt: r.alt_text ?? '', width: r.width, height: r.height }
    return out
  }

  /** Published reusable blocks (localized per locale). Archived/unpublished ids are simply absent. */
  async function resolveBlocks(ids: string[], locales: string[], enabled: string[]): Promise<View<unknown>['blocks']> {
    const uniq = [...new Set(ids)]
    const out: View<unknown>['blocks'] = {}
    if (!uniq.length) return out
    const rows = await sql`
      SELECT e.entity_id, v.snapshot FROM content_entities e
        JOIN content_versions v ON v.entity_type = e.entity_type AND v.entity_id = e.entity_id AND v.version_no = e.published_version_no
       WHERE e.entity_type = 'content_block' AND e.status = 'published' AND e.entity_id = ANY(${uniq}::text[])` as any[]
    for (const r of rows) {
      const tr = await translationRows('content_block', r.entity_id)
      const variants = buildVariants<ContentBlockSnapshot>('blocks', r.snapshot, tr, enabled)
      for (const l of new Set([SOURCE_LOCALE, ...locales])) {
        const v = variants[l] ?? variants[SOURCE_LOCALE]
        ;(out[l] ??= {})[r.entity_id] = v.data.content
      }
    }
    return out
  }

  async function assemble<T>(kind: ContentKind, row: { entity_id: string; slug: string | null; published_at: any; snapshot: T },
                             collect: (s: T) => { media: string[]; blocks: string[] }, path: string | null): Promise<View<T>> {
    const enabled = await getEnabledLocales(sql)
    const tr = await translationRows(KINDS[kind].type, row.entity_id)
    const variants = buildVariants<T>(kind, row.snapshot, tr, enabled)
    const media: string[] = [], blocks: string[] = []
    for (const v of Object.values(variants)) { const c = collect(v.data); media.push(...c.media); blocks.push(...c.blocks) }
    return {
      id: row.entity_id, slug: row.slug, path, publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      variants, media: await resolveMedia(media), blocks: await resolveBlocks(blocks, Object.keys(variants), enabled),
    }
  }

  const richIds = (doc?: RichText) => ({ media: collectMediaIds(doc), blocks: collectBlockRefs(doc) })

  async function publishedById(kind: ContentKind, id: string) {
    const rows = await sql`
      SELECT e.entity_id, e.slug, e.published_at, v.snapshot
        FROM content_entities e
        JOIN content_versions v ON v.entity_type = e.entity_type AND v.entity_id = e.entity_id AND v.version_no = e.published_version_no
       WHERE e.entity_type = ${KINDS[kind].type} AND e.entity_id = ${id} AND e.status = 'published'` as any[]
    return rows[0] ?? null
  }

  // ── policies ────────────────────────────────────────────────────────────────

  const policyIds = (s: PolicySnapshot) => {
    const r = richIds(s.body); return { media: [...r.media, ...(s.seo.shareImageId ? [s.seo.shareImageId] : [])], blocks: r.blocks }
  }

  const getPolicyById = (entityId: string) => safe('policy', async () => {
    const row = await publishedById('policies', entityId)
    return row ? assemble<PolicySnapshot>('policies', row, policyIds, policyPath(entityId, row.slug)) : null
  })

  const getPolicyBySlug = (slug: string) => safe('policy', async () => {
    const row = await cms.getPublishedBySlug('policy', slug)
    return row ? assemble<PolicySnapshot>('policies', row, policyIds, policyPath(row.entity_id, row.slug)) : null
  })

  // ── FAQ / size guide / pages / slots ───────────────────────────────────────

  const getFaq = () => safe('faq', async () => {
    const row = await publishedById('faq', 'main')
    return row ? assemble<FaqSnapshot>('faq', row, s => {
      const ids = { media: s.seo.shareImageId ? [s.seo.shareImageId] : [] as string[], blocks: [] as string[] }
      for (const c of s.categories) for (const i of c.items) { const r = richIds(i.answer); ids.media.push(...r.media); ids.blocks.push(...r.blocks) }
      const f = richIds(s.footerBody); ids.media.push(...f.media)
      return ids
    }, '/support/faq') : null
  })

  const getSupportPage = (id: 'size-guide') => safe('support-page', async () => {
    const row = await publishedById('support-pages', id)
    return row ? assemble<SupportPageSnapshot>('support-pages', row, s => ({ ...richIds(s.tip), media: s.seo.shareImageId ? [s.seo.shareImageId] : [] }), '/support/size-guide') : null
  })

  /** Published guides marked for the public Size Guide page, in the configured order. */
  const getPublicSizeGuides = () => safe('size-guides', async () => {
    const rows = await sql`
      SELECT e.entity_id, e.slug, e.published_at, v.snapshot
        FROM content_entities e
        JOIN content_versions v ON v.entity_type = e.entity_type AND v.entity_id = e.entity_id AND v.version_no = e.published_version_no
       WHERE e.entity_type = 'size_guide' AND e.status = 'published'
         AND COALESCE((v.snapshot->>'showOnGuidePage')::boolean, true)
       ORDER BY COALESCE((v.snapshot->>'order')::int, 0), e.entity_id` as any[]
    if (!rows.length) return null
    return await Promise.all(rows.map(r => assemble<SizeGuideSnapshot>('size-guides', r,
      s => ({ media: s.imageAssetId ? [s.imageAssetId] : [], blocks: [] }), null)))
  })

  /** The guide a product shows (contract for the Product Editor / PDP). Published only. */
  const getSizeGuideForProduct = (productId: string) => safe('product-size-guide', async () => {
    const link = (await sql`SELECT size_guide_id FROM product_size_guides WHERE product_id = ${productId}` as any[])[0]
    if (!link) return null
    const row = await publishedById('size-guides', link.size_guide_id)
    return row ? assemble<SizeGuideSnapshot>('size-guides', row, s => ({ media: s.imageAssetId ? [s.imageAssetId] : [], blocks: [] }), null) : null
  })

  const getPageBySlug = (slug: string) => safe('page', async () => {
    const row = await cms.getPublishedBySlug('page', slug)
    return row ? assemble<PageSnapshot>('pages', row, s => {
      const r = richIds(s.body); return { media: [...r.media, ...(s.seo.shareImageId ? [s.seo.shareImageId] : [])], blocks: r.blocks }
    }, `/pages/${row.slug}`) : null
  })

  const getAbout = () => safe('about', async () => {
    const row = await publishedById('about', 'main')
    return row ? assemble<AboutSnapshot>('about', row, s => ({ media: [...(s.imageAssetId ? [s.imageAssetId] : []), ...(s.seo.shareImageId ? [s.seo.shareImageId] : [])], blocks: [] }), '/about') : null
  })

  const getContact = () => safe('contact', async () => {
    const row = await publishedById('contact', 'main')
    return row ? assemble<ContactSnapshot>('contact', row, s => ({ media: s.seo.shareImageId ? [s.seo.shareImageId] : [], blocks: [] }), '/contact') : null
  })

  // ── global shell ────────────────────────────────────────────────────────────

  async function shellEntity<T>(kind: ContentKind): Promise<{ snapshot: T; id: string; tr: TrMap } | null> {
    const row = await publishedById(kind, 'main')
    if (!row) return null
    const rows = await translationRows(KINDS[kind].type, 'main')
    const tr: TrMap = {}
    for (const r of rows) (tr[r.locale] ??= {})[r.field] = r.value
    return { snapshot: row.snapshot as T, id: row.entity_id, tr }
  }

  /**
   * Navigation / footer / announcement for the root layout. Each part is independent: a
   * missing or failing part is null and the component keeps its coded content.
   */
  const getShell = async (): Promise<ShellData> => {
    const part = async <T,>(kind: ContentKind) => { try { return await shellEntity<T>(kind) } catch (e) { logSafe(`shell ${kind}`, e); return null } }
    const [nav, foot, ann] = await Promise.all([part<any>('navigation'), part<any>('footer'), part<any>('announcement')])
    return {
      navigation: nav?.snapshot ?? null,
      footer: foot?.snapshot ?? null,
      announcement: ann ? { ...ann.snapshot, id: ann.id } : null,
      tr: { navigation: nav?.tr ?? {}, footer: foot?.tr ?? {}, announcement: ann?.tr ?? {} },
    }
  }

  // Convenience wrappers matching the brief's loader names (locale resolved server-side).
  const getNavigation = async (locale = 'en') => { const s = await getShell(); return { data: s.navigation, tr: s.tr.navigation, locale } }
  const getFooter = async (locale = 'en') => { const s = await getShell(); return { data: s.footer, tr: s.tr.footer, locale } }
  const getAnnouncement = async (locale = 'en', now = new Date()) => {
    const s = await getShell()
    const a = s.announcement
    return { data: a && isAnnouncementActive(a, now) ? a : null, tr: s.tr.announcement, locale }
  }

  // ── global SEO ──────────────────────────────────────────────────────────────

  const getGlobalSeo = async (locale = 'en'): Promise<GlobalSeo> => {
    try {
      const rows = await sql`SELECT value FROM site_settings WHERE key = ${GLOBAL_SEO_KEY}` as any[]
      return mergeGlobalSeo(rows[0]?.value, locale)
    } catch (e) { logSafe('seo', e); return mergeGlobalSeo(undefined, locale) }
  }

  // ── redirects + sitemap ────────────────────────────────────────────────────

  const findRedirect = (fromPath: string) => safe('redirect', async () => {
    const rows = await sql`SELECT to_path, status_code FROM content_redirects WHERE from_path = ${fromPath}` as any[]
    if (!rows[0]) return null
    const checked = checkUrl(rows[0].to_path, { allowExternal: false, allowMailto: false })
    const status = Number(rows[0].status_code)
    if (!checked.ok || checked.kind !== 'internal' || !checked.value || ![301, 302, 307, 308].includes(status)) {
      console.error('[content-public] blocked unsafe redirect row')
      return null
    }
    return { to: checked.value, status }
  })

  type SitemapEntry = { path: string; lastModified?: Date; changeFrequency?: 'weekly' | 'monthly' | 'yearly'; priority?: number }

  /**
   * Published, indexable content URLs for the sitemap (drafts/unpublished/archived/noindex never
   * appear), plus the paths Admin has deliberately set to noindex so the caller can drop their
   * coded sitemap entries too.
   */
  async function getSitemapPlan(): Promise<{ entries: SitemapEntry[]; excluded: string[] }> {
    try {
      const out: SitemapEntry[] = []
      const excluded: string[] = []
      const pathOf = (r: any): string | null =>
        r.entity_type === 'policy' ? policyPath(r.entity_id, r.slug)
        : r.entity_type === 'page' ? `/pages/${r.slug}`
        : r.entity_type === 'faq' ? '/support/faq'
        : r.entity_type === 'about' ? '/about'
        : r.entity_type === 'contact' ? '/contact'
        : r.entity_type === 'support_page' && r.entity_id === 'size-guide' ? '/support/size-guide' : null
      const rows = await sql`
        SELECT e.entity_type, e.entity_id, e.slug, e.published_at, v.snapshot
          FROM content_entities e
          JOIN content_versions v ON v.entity_type = e.entity_type AND v.entity_id = e.entity_id AND v.version_no = e.published_version_no
         WHERE e.status = 'published' AND e.entity_type IN ('policy', 'page', 'faq', 'about', 'contact', 'support_page')` as any[]
      for (const r of rows) {
        if (r.snapshot?.seo?.noindex) { const px = pathOf(r); if (px) excluded.push(px); continue }
        const lm = r.published_at ? new Date(r.published_at) : undefined
        if (r.entity_type === 'policy') {
          out.push({ path: policyPath(r.entity_id, r.slug), lastModified: lm, changeFrequency: 'yearly', priority: 0.2 })
        } else if (r.entity_type === 'page') out.push({ path: `/pages/${r.slug}`, lastModified: lm, changeFrequency: 'monthly', priority: 0.5 })
        else if (r.entity_type === 'faq') out.push({ path: '/support/faq', lastModified: lm, changeFrequency: 'monthly', priority: 0.6 })
        else if (r.entity_type === 'about') out.push({ path: '/about', lastModified: lm, changeFrequency: 'monthly', priority: 0.7 })
        else if (r.entity_type === 'contact') out.push({ path: '/contact', lastModified: lm, changeFrequency: 'monthly', priority: 0.5 })
        else if (r.entity_type === 'support_page' && r.entity_id === 'size-guide') out.push({ path: '/support/size-guide', lastModified: lm, changeFrequency: 'monthly', priority: 0.6 })
      }
      const cols = await sql`SELECT slug, updated_at FROM collections WHERE is_active AND archived_at IS NULL AND NOT COALESCE((seo->>'noindex')::boolean, false)` as any[]
      for (const c of cols) out.push({ path: `/collections/${c.slug}`, lastModified: new Date(c.updated_at), changeFrequency: 'weekly', priority: 0.8 })
      return { entries: out, excluded }
    } catch (e) { logSafe('sitemap', e); return { entries: [], excluded: [] } }
  }

  const getSitemapEntries = async (): Promise<SitemapEntry[]> => (await getSitemapPlan()).entries

  // ── collections ─────────────────────────────────────────────────────────────

  /** Published (active, not archived) collection with its ordered, active products. */
  const getCollection = (slug: string) => safe('collection', async () => {
    const c = (await sql`
      SELECT c.id, c.slug, c.name, c.description, c.seo, c.hero_media_id, c.updated_at
        FROM collections c WHERE lower(c.slug) = lower(${slug}) AND c.is_active AND c.archived_at IS NULL` as any[])[0]
    if (!c) return null
    const enabled = await getEnabledLocales(sql)
    const tr = await translationRows('collection', c.id)
    const names: Record<string, { name: string; description: string; seoTitle: string; seoDescription: string }> = {
      [SOURCE_LOCALE]: { name: c.name, description: c.description ?? '', seoTitle: c.seo?.title ?? '', seoDescription: c.seo?.description ?? '' },
    }
    for (const l of new Set(tr.map(r => r.locale))) {
      if (!enabled.includes(l)) continue
      const f = (field: string, dflt: string) => tr.find(r => r.locale === l && r.field === field)?.value || dflt
      names[l] = { name: f('name', c.name), description: f('description', c.description ?? ''), seoTitle: f('seoTitle', c.seo?.title ?? ''), seoDescription: f('seoDescription', c.seo?.description ?? '') }
    }
    const products = await sql`
      SELECT p.id, p.name, p.slug, p.product_code, p.price_cents, p.currency
        FROM collection_products cp JOIN products p ON p.id = cp.product_id
       WHERE cp.collection_id = ${c.id} AND p.active ORDER BY cp.position, p.name` as any[]
    const media = await resolveMedia([c.hero_media_id, c.seo?.shareImageId].filter(Boolean))
    return {
      id: c.id as string, slug: c.slug as string, seo: (c.seo ?? {}) as { title?: string; description?: string; shareTitle?: string; shareImageId?: string; noindex?: boolean },
      updatedAt: new Date(c.updated_at).toISOString(),
      hero: c.hero_media_id ? media[c.hero_media_id] ?? null : null,
      shareImageUrl: c.seo?.shareImageId ? media[c.seo.shareImageId]?.url ?? null : null,
      text: names,
      products: products.map(p => ({ id: p.id as string, name: p.name as string, slug: p.slug as string, productCode: p.product_code as string, priceCents: p.price_cents as number, currency: p.currency as string })),
    }
  })

  /**
   * Is a collection live, deliberately hidden (inactive/archived) or absent? null on a database
   * error so callers keep the coded page rather than hiding content because of an outage.
   */
  const getCollectionState = async (slug: string): Promise<'live' | 'hidden' | 'absent' | null> => {
    try {
      const r = (await sql`SELECT is_active, archived_at FROM collections WHERE lower(slug) = lower(${slug})` as any[])[0]
      if (!r) return 'absent'
      return r.is_active && !r.archived_at ? 'live' : 'hidden'
    } catch (e) { logSafe('collection state', e); return null }
  }

  /** Ordered DB product slugs of a collection (contract for the shop/Product workstream). */
  const getCollectionProductSlugs = async (slug: string): Promise<string[] | null> => {
    const c = await getCollection(slug)
    return c ? c.products.map(p => p.slug) : null
  }

  return {
    getPolicyById, getPolicyBySlug, getFaq, getSupportPage, getPublicSizeGuides, getSizeGuideForProduct, getPageBySlug,
    getAbout, getContact, getShell, getNavigation, getFooter, getAnnouncement, getGlobalSeo, findRedirect, getSitemapEntries, getSitemapPlan,
    getCollection, getCollectionProductSlugs, getCollectionState,
  }
}

export type ContentPublic = ReturnType<typeof createContentPublic>

let _default: ContentPublic | null = null
/** The loader bound to the production Neon connection (created on first use). */
export function contentPublic(): ContentPublic {
  if (!_default) _default = createContentPublic(sql)
  return _default
}

export { EMPTY_TR }
