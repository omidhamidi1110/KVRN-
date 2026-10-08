// lib/content-seo-service.ts — Admin read/write of the site-wide SEO defaults
// (site_settings key `seo.global`; the Product workstream reads the same key).
//
// Stored shape: GlobalSeo (lib/content-schemas.ts). `shareImageId` is the Media Library asset;
// `shareImageUrl` is resolved server-side at save time so a raw reader of the setting gets a
// usable URL. Saves use putSetting (optimistic revision + audit row in one statement).

import { getSetting, putSetting, SettingsStaleError } from './site-settings'
import { validateGlobalSeo, GLOBAL_SEO_KEY, type GlobalSeo } from './content-schemas'
import { mergeGlobalSeo } from './content-seo'
import { syncMediaUsages, findUnusableAssets } from './media-usage'
import { invalidateAfterCommit, CMS_TAGS, type InvalidationResult, type InvalidationTarget } from './cache-invalidation'
import { mediaUrlForKey } from './media-storage'
import { ContentError } from './content-service'

type Sql = any

export function createSeoService(sql: Sql, deps: {
  invalidate?: (t: InvalidationTarget, c: { reason: string; actor?: string | null }) => Promise<InvalidationResult>
} = {}) {
  const invalidate = deps.invalidate ?? ((t, c) => invalidateAfterCommit(sql, t, c))

  async function get(): Promise<{ value: GlobalSeo; revision: number; shareImageAlt: string | null }> {
    const { value, revision } = await getSetting<unknown>(sql, GLOBAL_SEO_KEY, null)
    const merged = mergeGlobalSeo(value)
    let alt: string | null = null
    if (merged.shareImageId) {
      const r = await sql`SELECT alt_text FROM media_assets WHERE id = ${merged.shareImageId}` as any[]
      alt = r[0]?.alt_text ?? null
    }
    return { value: merged, revision, shareImageAlt: alt }
  }

  async function put(input: unknown, expectedRevision: number, actor: string): Promise<{ data: { revision: number }; invalidation: InvalidationResult }> {
    const v = validateGlobalSeo(input)
    if (!v.ok) throw new ContentError('invalid', 'Some fields need attention.', v.errors)
    const value: GlobalSeo = { ...v.value }
    delete value.shareImageUrl
    if (value.shareImageId) {
      const bad = await findUnusableAssets(sql, [value.shareImageId])
      if (bad.length) throw new ContentError('unusable_media', 'The share image is missing or archived.', { assetIds: bad })
      const r = await sql`SELECT storage_key FROM media_assets WHERE id = ${value.shareImageId}` as any[]
      value.shareImageUrl = mediaUrlForKey(r[0].storage_key)
    }
    let revision: number
    try { revision = (await putSetting(sql, GLOBAL_SEO_KEY, value, expectedRevision, actor)).revision }
    catch (e) {
      if (e instanceof SettingsStaleError) throw new ContentError('conflict', 'This was changed by someone else. Reload and try again.')
      throw e
    }
    await syncMediaUsages(sql, { ownerType: 'site_settings', ownerId: GLOBAL_SEO_KEY, scope: 'published',
      refs: value.shareImageId ? [{ slot: 'share', assetId: value.shareImageId }] : [] })
    const invalidation = await invalidate({ paths: ['/', '/sitemap.xml'], tags: [CMS_TAGS.seo, CMS_TAGS.sitemap] }, { reason: 'global seo', actor })
    return { data: { revision }, invalidation }
  }

  return { get, put }
}

export type SeoService = ReturnType<typeof createSeoService>
