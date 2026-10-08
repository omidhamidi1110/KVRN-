// lib/content-collections.ts — Admin collection management on the foundation tables
// (`collections` + `collection_products`). A basic editor: no draft/version history — a
// collection is live while it is active and not archived (the spec allows this for collections).
//
//   * canonical products are only REFERENCED (collection_products); nothing is copied
//   * saves are atomic SQL functions (030) with optimistic `version` checks, slug-change
//     redirects (old → new) and audit rows in the same transaction
//   * the storefront cache is invalidated AFTER commit for old AND new paths
//   * translations use content_translations (entity_type 'collection')

import { toCmsError, CmsError } from './cms-core'
import { checkSlug } from './content-urls'
import { validateSeo, type SeoFields } from './content-schemas'
import { syncMediaUsages, findUnusableAssets } from './media-usage'
import { invalidateAfterCommit, collectionInvalidation, type InvalidationResult, type InvalidationTarget } from './cache-invalidation'
import { upsertTranslation, summarizeCompleteness, SOURCE_LOCALE, type TranslationRow } from './translations'
import { getEnabledLocales, isValidLocale } from './content-locales'
import { ContentError } from './content-service'
import { mediaUrlForKey } from './media-storage'

type Sql = any
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// eslint-disable-next-line no-control-regex
const BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export interface CollectionInput {
  slug: string; name: string; description: string; heroMediaId: string | null
  isActive: boolean; sortOrder: number; seo: SeoFields
}

export function validateCollectionInput(input: unknown): { ok: true; value: CollectionInput } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const o = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const sl = checkSlug(o.slug); if (!sl.ok) errors.push(`slug: ${sl.error}`)
  const name = typeof o.name === 'string' ? o.name.replace(BAD, '').replace(/\s+/g, ' ').trim() : ''
  if (!name) errors.push('name: is required'); else if (name.length > 100) errors.push('name: is too long (max 100)')
  const description = typeof o.description === 'string' ? o.description.replace(BAD, '').trim() : ''
  if (description.length > 2000) errors.push('description: is too long (max 2000)')
  let hero: string | null = null
  if (o.heroMediaId !== undefined && o.heroMediaId !== null && o.heroMediaId !== '') {
    if (typeof o.heroMediaId !== 'string' || !UUID_RE.test(o.heroMediaId)) errors.push('heroMediaId: choose an image from the library')
    else hero = o.heroMediaId.toLowerCase()
  }
  const seoErrors = { errors: [] as string[], err(p: string, m: string) { this.errors.push(`${p}: ${m}`) } }
  const seo = validateSeo(seoErrors as any, 'seo', o.seo)
  errors.push(...seoErrors.errors)
  const sort = Number.isInteger(o.sortOrder) ? Math.min(Math.max(o.sortOrder as number, 0), 9999) : 0
  if (errors.length) return { ok: false, errors }
  return { ok: true, value: { slug: sl.value!, name, description, heroMediaId: hero, isActive: o.isActive !== false, sortOrder: sort, seo } }
}

/** Translatable collection fields (source language text). */
export function collectionTranslatableFields(c: { name: string; description?: string | null; seo?: SeoFields | null }): Record<string, string> {
  const out: Record<string, string> = {}
  if (c.name?.trim()) out.name = c.name
  if (c.description?.trim()) out.description = c.description
  if (c.seo?.title?.trim()) out.seoTitle = c.seo.title
  if (c.seo?.description?.trim()) out.seoDescription = c.seo.description
  return out
}

export interface CollectionOutcome<T> { data: T; invalidation: InvalidationResult | null }

export function createCollectionsService(sql: Sql, deps: {
  invalidate?: (t: InvalidationTarget, c: { reason: string; actor?: string | null }) => Promise<InvalidationResult>
} = {}) {
  const invalidate = deps.invalidate ?? ((t, c) => invalidateAfterCommit(sql, t, c))

  async function syncMedia(id: string, c: { heroMediaId: string | null; seo: SeoFields; live: boolean }) {
    const refs: Array<{ slot: string; assetId: string }> = []
    if (c.live) {
      if (c.heroMediaId) refs.push({ slot: 'hero', assetId: c.heroMediaId })
      if (c.seo?.shareImageId) refs.push({ slot: 'seo.share', assetId: c.seo.shareImageId })
    }
    await syncMediaUsages(sql, { ownerType: 'collection', ownerId: id, scope: 'published', refs })
  }

  async function run<T>(q: Promise<any[]>): Promise<T> {
    try { return (await q)[0]?.r as T } catch (e) { throw e instanceof CmsError ? e : toCmsError(e) }
  }

  async function audit(actor: string, action: string, id: string, payload: Record<string, unknown>) {
    await sql`INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
              VALUES (${actor}, ${action}, 'collection', ${id}, ${JSON.stringify(payload)}::jsonb)`
  }

  async function list(o: { q?: string; archived?: boolean } = {}) {
    const q = (o.q ?? '').trim().toLowerCase()
    const rows = await sql`
      SELECT c.id, c.slug, c.name, c.is_active, c.sort_order, c.archived_at, c.updated_at,
             content_collection_version(c.updated_at)::text AS version,
             (SELECT COUNT(*)::int FROM collection_products cp WHERE cp.collection_id = c.id) AS product_count
        FROM collections c
       WHERE (${o.archived === true} AND c.archived_at IS NOT NULL) OR (${o.archived !== true} AND c.archived_at IS NULL)
       ORDER BY c.sort_order, c.name` as any[]
    return rows
      .filter(r => !q || `${r.name} ${r.slug}`.toLowerCase().includes(q))
      .map(r => ({ id: r.id as string, slug: r.slug as string, name: r.name as string, isActive: r.is_active as boolean,
                   sortOrder: r.sort_order as number, archived: !!r.archived_at, productCount: r.product_count as number,
                   version: Number(r.version), updatedAt: new Date(r.updated_at).toISOString() }))
  }

  async function get(id: string) {
    if (!UUID_RE.test(id)) throw new ContentError('not_found', 'Collection not found.')
    const c = (await sql`
      SELECT c.*, content_collection_version(c.updated_at)::text AS version, m.storage_key AS hero_key, m.alt_text AS hero_alt, m.filename AS hero_filename
        FROM collections c LEFT JOIN media_assets m ON m.id = c.hero_media_id WHERE c.id = ${id}` as any[])[0]
    if (!c) throw new ContentError('not_found', 'Collection not found.')
    const products = await sql`
      SELECT p.id, p.name, p.slug, p.active, p.product_code, cp.position
        FROM collection_products cp JOIN products p ON p.id = cp.product_id
       WHERE cp.collection_id = ${id} ORDER BY cp.position, p.name` as any[]
    return {
      id: c.id as string, slug: c.slug as string, name: c.name as string, description: (c.description ?? '') as string,
      heroMediaId: (c.hero_media_id ?? null) as string | null,
      heroUrl: c.hero_key ? mediaUrlForKey(c.hero_key) : null, heroAlt: (c.hero_alt ?? null) as string | null,
      isActive: c.is_active as boolean, sortOrder: c.sort_order as number, seo: (c.seo ?? {}) as SeoFields,
      archived: !!c.archived_at, version: Number(c.version),
      products: products.map(p => ({ id: p.id as string, name: p.name as string, slug: p.slug as string, active: p.active as boolean, productCode: p.product_code as string })),
    }
  }

  async function searchProducts(q: string) {
    const like = `%${q.trim().replace(/[%_\\]/g, m => '\\' + m)}%`
    return await sql`SELECT id, name, slug, active, product_code AS "productCode" FROM products
                      WHERE (${q.trim()} = '' OR name ILIKE ${like} OR slug ILIKE ${like})
                      ORDER BY name LIMIT 50` as Array<{ id: string; name: string; slug: string; active: boolean; productCode: string }>
  }

  async function assertMedia(c: CollectionInput) {
    const ids = [c.heroMediaId, c.seo.shareImageId].filter((x): x is string => !!x)
    const bad = await findUnusableAssets(sql, ids)
    if (bad.length) throw new ContentError('unusable_media', 'An image used here is missing or archived.', { assetIds: bad })
  }

  async function create(input: unknown, actor: string): Promise<CollectionOutcome<{ id: string; slug: string; version: number }>> {
    const v = validateCollectionInput(input)
    if (!v.ok) throw new ContentError('invalid', 'Some fields need attention.', v.errors)
    await assertMedia(v.value)
    const r: any = await run(sql`SELECT content_collection_save(NULL, NULL, ${v.value.slug}, ${v.value.name}, ${v.value.description || null},
        ${v.value.heroMediaId}::uuid, ${v.value.isActive}, ${v.value.sortOrder}, ${JSON.stringify(v.value.seo)}::jsonb, ${actor}) AS r`)
    await syncMedia(r.id, { ...v.value, live: v.value.isActive })
    const inv = await invalidate(collectionInvalidation(r.slug), { reason: `collection create: ${r.slug}`, actor })
    return { data: { id: r.id, slug: r.slug, version: Number(r.version) }, invalidation: inv }
  }

  async function update(id: string, input: unknown, expectedVersion: number, actor: string): Promise<CollectionOutcome<{ id: string; slug: string; previousSlug: string | null; redirectCreated: boolean; version: number }>> {
    if (!UUID_RE.test(id)) throw new ContentError('not_found', 'Collection not found.')
    const v = validateCollectionInput(input)
    if (!v.ok) throw new ContentError('invalid', 'Some fields need attention.', v.errors)
    await assertMedia(v.value)
    const r: any = await run(sql`SELECT content_collection_save(${id}::uuid, ${expectedVersion}::bigint, ${v.value.slug}, ${v.value.name}, ${v.value.description || null},
        ${v.value.heroMediaId}::uuid, ${v.value.isActive}, ${v.value.sortOrder}, ${JSON.stringify(v.value.seo)}::jsonb, ${actor}) AS r`)
    await syncMedia(id, { ...v.value, live: v.value.isActive })
    const inv = await invalidate(collectionInvalidation(r.slug, r.previous_slug && r.previous_slug !== r.slug ? r.previous_slug : null),
      { reason: `collection update: ${r.slug}`, actor })
    return { data: { id, slug: r.slug, previousSlug: r.previous_slug ?? null, redirectCreated: !!r.redirect_created, version: Number(r.version) }, invalidation: inv }
  }

  /** Replace the ordered product list. Order = array order. */
  async function setProducts(id: string, productIds: string[], expectedVersion: number, actor: string): Promise<CollectionOutcome<{ version: number; count: number }>> {
    if (!UUID_RE.test(id)) throw new ContentError('not_found', 'Collection not found.')
    if (!Array.isArray(productIds) || productIds.length > 200 || productIds.some(p => typeof p !== 'string' || !UUID_RE.test(p))) {
      throw new ContentError('invalid', 'Choose products from the catalog.')
    }
    const cur = (await sql`SELECT slug FROM collections WHERE id = ${id}` as any[])[0]
    const r: any = await run(sql`SELECT content_collection_set_products(${id}::uuid, ${expectedVersion}::bigint, ${productIds}::uuid[], ${actor}) AS r`)
    const inv = await invalidate(collectionInvalidation(cur?.slug ?? ''), { reason: `collection products: ${cur?.slug}`, actor })
    return { data: { version: Number(r.version), count: r.count }, invalidation: inv }
  }

  async function setArchived(id: string, archive: boolean, expectedVersion: number, actor: string): Promise<CollectionOutcome<{ version: number }>> {
    if (!UUID_RE.test(id)) throw new ContentError('not_found', 'Collection not found.')
    const r: any = await run(sql`SELECT content_collection_archive(${id}::uuid, ${expectedVersion}::bigint, ${archive}, ${actor}) AS r`)
    await syncMediaUsages(sql, { ownerType: 'collection', ownerId: id, scope: 'published', refs: [] })
    const inv = await invalidate(collectionInvalidation(r.slug), { reason: `collection ${archive ? 'archive' : 'restore'}: ${r.slug}`, actor })
    if (!archive) {
      const c = await get(id)
      await syncMedia(id, { heroMediaId: c.heroMediaId, seo: c.seo, live: c.isActive })
    }
    return { data: { version: Number(r.version) }, invalidation: inv }
  }

  // ── translations ────────────────────────────────────────────────────────────

  async function translationOverview(id: string) {
    const c = await get(id)
    const source = collectionTranslatableFields({ name: c.name, description: c.description, seo: c.seo })
    const locales = (await getEnabledLocales(sql)).filter(l => l !== SOURCE_LOCALE)
    const rows = await sql`SELECT locale, field, value, status, source_hash, machine_generated, updated_at FROM content_translations
                            WHERE entity_type = 'collection' AND entity_id = ${id}` as TranslationRow[]
    const byLocale: Record<string, TranslationRow[]> = {}
    for (const r of rows) (byLocale[r.locale] ??= []).push(r)
    return { id, legal: false, locales, source, rows: rows.map(r => ({ ...r, updated_at: new Date(r.updated_at).toISOString() })),
             completeness: summarizeCompleteness(source, byLocale as any, [SOURCE_LOCALE, ...locales]) }
  }

  async function saveTranslation(id: string, t: { locale: string; field: string; value: string; status?: 'draft' | 'needs_review' | 'published'; machineGenerated?: boolean }, actor: string) {
    const c = await get(id)
    const source = collectionTranslatableFields({ name: c.name, description: c.description, seo: c.seo })
    if (!isValidLocale(t.locale) || t.locale === SOURCE_LOCALE || !(await getEnabledLocales(sql)).includes(t.locale)) throw new ContentError('invalid', 'Choose an enabled translation language.')
    if (!(t.field in source)) throw new ContentError('invalid', 'That field cannot be translated.')
    const value = String(t.value ?? '').trim()
    if (!value) throw new ContentError('invalid', 'Enter a translation, or clear the field.')
    if (value.length > 4000) throw new ContentError('invalid', 'That translation is too long.')
    const status = t.machineGenerated ? (t.status === 'needs_review' ? 'needs_review' : 'draft') : (t.status ?? 'draft')
    await upsertTranslation(sql, { entityType: 'collection', entityId: id, locale: t.locale, field: t.field, value, sourceText: source[t.field], status, machineGenerated: !!t.machineGenerated, actor })
    await audit(actor, 'collection.translation', id, { locale: t.locale, field: t.field, status })
    const inv = status === 'published' ? await invalidate(collectionInvalidation(c.slug), { reason: `collection translation: ${c.slug}`, actor }) : null
    return { data: { status }, invalidation: inv }
  }

  async function clearTranslation(id: string, locale: string, field: string, actor: string) {
    const c = await get(id)
    const rows = await sql`DELETE FROM content_translations WHERE entity_type = 'collection' AND entity_id = ${id} AND locale = ${locale} AND field = ${field} RETURNING status` as any[]
    if (rows.length) await audit(actor, 'collection.translation.clear', id, { locale, field })
    const inv = rows[0]?.status === 'published' ? await invalidate(collectionInvalidation(c.slug), { reason: `collection translation: ${c.slug}`, actor }) : null
    return { data: { cleared: rows.length > 0 }, invalidation: inv }
  }

  return { list, get, searchProducts, create, update, setProducts, setArchived, translationOverview, saveTranslation, clearTranslation }
}

export type CollectionsService = ReturnType<typeof createCollectionsService>
