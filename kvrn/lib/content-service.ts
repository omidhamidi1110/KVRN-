// lib/content-service.ts — Admin-side operations for the site-content CMS.
//
// One factory, `createContentService(sql)`, so route handlers use the Neon `sql` and tests use
// the pg-backed `sql`. Every lifecycle change goes through the atomic SQL functions from
// migrations 027/030 (draft, publish, rollback, unpublish, archive, restore, policy go-live),
// then:
//   1. media + reusable-block usage tables are re-synced (truthful "where used"),
//   2. the storefront cache is invalidated AFTER the committed change (old AND new paths),
//      and the invalidation result is returned to the caller so Admin can show a failure.
// Content publishing never touches orders, payments, inventory or any financial table.

import { createCms, CmsError, toCmsError, type Cms } from './cms-core'
import {
  KINDS, validateSnapshot, snapshotTitle, mediaRefs, blockRefs, translatableFields, policyPath, LEGACY_POLICY_PATHS,
  isContentKind, type ContentKind, type KindDef, type AnySnapshot, type PolicySnapshot,
} from './content-schemas'
import { syncMediaUsages, findUnusableAssets } from './media-usage'
import {
  invalidateAfterCommit, globalShellInvalidation, CMS_TAGS, type InvalidationResult, type InvalidationTarget,
} from './cache-invalidation'
import { upsertTranslation, summarizeCompleteness, SOURCE_LOCALE, type TranslationRow } from './translations'
import { getEnabledLocales, isValidLocale } from './content-locales'
import { validateRichText } from './content-richtext'
import { DEFAULT_NAVIGATION, DEFAULT_FOOTER, DEFAULT_ANNOUNCEMENT, DEFAULT_ABOUT, DEFAULT_CONTACT, DEFAULT_SIZE_GUIDE_PAGE } from './content-defaults'

type Sql = any

/** Reusable-block usages are tracked in content_block_usages (030). */
export const BLOCKS_TAG = 'cms:blocks'
/** Support pages that live in content_entities (type support_page). */
export const SUPPORT_PAGE_IDS = ['size-guide'] as const

/** Coded public slugs for the two Drop 001 products (lib/catalog.ts) — cache paths cover both. */
export const CODE_TO_PUBLIC_SLUG: Record<string, string> = {
  PKHH: 'kvrn-phantom-hoodie',
  PKHSP: 'kvrn-phantom-sweatpants',
}

export class ContentError extends Error {
  constructor(public readonly code: 'invalid' | 'in_use' | 'forbidden' | 'not_found' | 'unusable_media' | 'missing_block' | 'conflict',
              message: string, public readonly details?: unknown) {
    super(message); this.name = 'ContentError'
  }
  get status(): number {
    switch (this.code) {
      case 'not_found': return 404
      case 'in_use': case 'conflict': return 409
      case 'forbidden': return 403
      default: return 400
    }
  }
}

/** Uniform error → HTTP mapping for routes. Never leaks internals. */
export function toHttpError(e: unknown): { status: number; body: { error: string; code: string; details?: unknown } } {
  if (e instanceof ContentError) return { status: e.status, body: { error: e.message, code: e.code, details: e.details } }
  if (e instanceof CmsError) return { status: e.status, body: { error: e.message, code: e.code } }
  const c = toCmsError(e)
  if (c.code !== 'unknown') return { status: c.status, body: { error: c.message, code: c.code } }
  return { status: 500, body: { error: 'Something went wrong. Nothing was changed.', code: 'unknown' } }
}

export interface Outcome<T = Record<string, unknown>> {
  data: T
  /** null when there was nothing to invalidate; ok:false means the public site may be stale. */
  invalidation: InvalidationResult | null
}

export interface EntityRow {
  id: string
  status: 'draft' | 'published' | 'scheduled' | 'unpublished' | 'archived'
  slug: string | null
  title: string
  revision: number
  hasDraft: boolean
  isLive: boolean
  updatedAt: string
  publishedAt: string | null
  updatedBy: string | null
  snapshot: any
  extra?: Record<string, unknown>
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const newId = () => (globalThis.crypto as any).randomUUID() as string

export const DEFAULTS_BY_KIND: Partial<Record<ContentKind, (id: string) => unknown>> = {
  about: () => DEFAULT_ABOUT, contact: () => DEFAULT_CONTACT, announcement: () => DEFAULT_ANNOUNCEMENT,
  navigation: () => DEFAULT_NAVIGATION, footer: () => DEFAULT_FOOTER,
  'support-pages': () => DEFAULT_SIZE_GUIDE_PAGE,
}

export function resolveEntityId(def: KindDef, id: string | undefined): string {
  if (def.singleton) return def.singleton
  if (def.kind === 'support-pages') {
    if (!id || !(SUPPORT_PAGE_IDS as readonly string[]).includes(id)) throw new ContentError('invalid', 'Unknown support page.')
    return id
  }
  if (!id || !ID_RE.test(id)) throw new ContentError('invalid', 'Invalid id.')
  return id
}

/** Which kinds may never be archived (required storefront content). */
function archiveForbidden(kind: ContentKind, id: string): string | null {
  const def = KINDS[kind]
  if (def.singleton || kind === 'support-pages') return 'This content is always part of the storefront and cannot be archived.'
  if (kind === 'policies' && LEGACY_POLICY_PATHS[id]) return 'This legal page is required by the storefront and cannot be archived. Unpublish is not available either — edit it instead.'
  return null
}

export function createContentService(sql: Sql, deps: {
  invalidate?: (target: InvalidationTarget, ctx: { reason: string; actor?: string | null }) => Promise<InvalidationResult>
} = {}) {
  const cms0: Cms = createCms(sql)
  // An unpublished / archived entity has neither a draft nor a live pointer; the editor still
  // needs its content, so fall back to the most recent version's snapshot.
  const cms: Cms = {
    ...cms0,
    async get(type: string, id: string) {
      const row = await cms0.get(type, id)
      if (row && !row.draft_snapshot && !row.published_snapshot) {
        const v = await sql`SELECT snapshot FROM content_versions WHERE entity_type = ${type} AND entity_id = ${id}
                             ORDER BY version_no DESC LIMIT 1` as any[]
        if (v[0]) row.draft_snapshot = v[0].snapshot
      }
      return row
    },
  }
  const invalidate = deps.invalidate ?? ((t, c) => invalidateAfterCommit(sql, t, c))

  async function audit(actor: string, action: string, resource: string, resourceId: string, payload: Record<string, unknown> = {}) {
    await sql`INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
              VALUES (${actor}, ${action}, ${resource}, ${resourceId}, ${JSON.stringify(payload)}::jsonb)`
  }

  // ── invalidation targets ────────────────────────────────────────────────────

  async function productPathsForGuide(guideId: string): Promise<string[]> {
    const rows = await sql`SELECT p.slug, p.product_code FROM product_size_guides g JOIN products p ON p.id = g.product_id
                            WHERE g.size_guide_id = ${guideId}` as any[]
    const out: string[] = []
    for (const r of rows) { out.push(`/products/${r.slug}`); if (CODE_TO_PUBLIC_SLUG[r.product_code]) out.push(`/products/${CODE_TO_PUBLIC_SLUG[r.product_code]}`) }
    return out
  }

  async function ownerPathsForBlock(blockId: string): Promise<{ paths: string[]; tags: string[] }> {
    const rows = await sql`
      SELECT u.owner_type, u.owner_id, e.slug FROM content_block_usages u
        LEFT JOIN content_entities e ON e.entity_type = u.owner_type AND e.entity_id = u.owner_id
       WHERE u.block_id = ${blockId}` as any[]
    const paths: string[] = []; const tags = new Set<string>([BLOCKS_TAG])
    for (const r of rows) {
      if (r.owner_type === 'page' && r.slug) { paths.push(`/pages/${r.slug}`); tags.add(CMS_TAGS.pages) }
      else if (r.owner_type === 'policy' && r.slug) { paths.push(policyPath(r.owner_id, r.slug)); tags.add(CMS_TAGS.policies) }
      else if (r.owner_type === 'faq') { paths.push('/support/faq'); tags.add(CMS_TAGS.faq) }
      else if (r.owner_type === 'product') { paths.push(`/products/${r.owner_id}`); tags.add(CMS_TAGS.products) }
    }
    return { paths, tags: [...tags] }
  }

  async function targetFor(kind: ContentKind, id: string, o: { slug?: string | null; previousSlug?: string | null } = {}): Promise<InvalidationTarget> {
    switch (kind) {
      case 'policies': {
        const paths = ['/sitemap.xml']
        for (const s of [o.slug, o.previousSlug]) if (s) paths.push(policyPath(id, s))
        if (id === 'terms') paths.push('/legal/terms')
        if (id === 'privacy') paths.push('/legal/privacy')
        return { paths, tags: [CMS_TAGS.policies, CMS_TAGS.sitemap, ...[o.slug, o.previousSlug].filter((s): s is string => !!s).map(CMS_TAGS.policy)] }
      }
      case 'pages': {
        const slugs = [o.slug, o.previousSlug].filter((s): s is string => !!s)
        return { paths: [...slugs.map(s => `/pages/${s}`), '/sitemap.xml'], tags: [CMS_TAGS.pages, CMS_TAGS.sitemap, ...slugs.map(CMS_TAGS.page)] }
      }
      case 'size-guides':
        return { paths: ['/support/size-guide', ...await productPathsForGuide(id)], tags: [CMS_TAGS.sizeGuides, CMS_TAGS.products] }
      case 'support-pages':
        return { paths: id === 'size-guide' ? ['/support/size-guide'] : [], tags: [CMS_TAGS.sizeGuides] }
      case 'blocks': return await ownerPathsForBlock(id)
      case 'faq': return { paths: ['/support/faq', '/sitemap.xml'], tags: [CMS_TAGS.faq] }
      case 'about': return { paths: ['/about'], tags: [CMS_TAGS.pages] }
      case 'contact': return { paths: ['/contact'], tags: [CMS_TAGS.pages] }
      case 'announcement': return globalShellInvalidation('announcement')
      case 'navigation': return globalShellInvalidation('nav')
      case 'footer': return globalShellInvalidation('footer')
    }
  }

  async function invalidateFor(kind: ContentKind, id: string, actor: string, reason: string, o: { slug?: string | null; previousSlug?: string | null } = {}) {
    return await invalidate(await targetFor(kind, id, o), { reason: `${reason}: ${KINDS[kind].type}/${id}`, actor })
  }

  // ── usages ──────────────────────────────────────────────────────────────────

  async function syncBlockUsages(owner: { type: string; id: string }, scope: 'draft' | 'published', ids: string[]) {
    const uniq = [...new Set(ids)]
    await sql`DELETE FROM content_block_usages WHERE owner_type = ${owner.type} AND owner_id = ${owner.id} AND scope = ${scope}
                AND block_id <> ALL(${uniq}::text[])`
    if (uniq.length) {
      await sql`INSERT INTO content_block_usages (block_id, owner_type, owner_id, scope)
                SELECT x, ${owner.type}, ${owner.id}, ${scope} FROM UNNEST(${uniq}::text[]) AS x
                ON CONFLICT DO NOTHING`
    }
  }

  async function syncAllUsages(kind: ContentKind, id: string, snap: any | null, scope: 'draft' | 'published') {
    const type = KINDS[kind].type
    await syncMediaUsages(sql, { ownerType: type, ownerId: id, scope, refs: snap ? mediaRefs(kind, snap) : [] })
    await syncBlockUsages({ type, id }, scope, snap ? blockRefs(kind, snap) : [])
  }

  // ── validation helpers ──────────────────────────────────────────────────────

  function parse(kind: ContentKind, id: string, input: unknown): AnySnapshot {
    const v = validateSnapshot(kind, input, { entityId: id })
    if (!v.ok) throw new ContentError('invalid', 'Some fields need attention.', v.errors)
    return v.value
  }

  /** Publish gate: images must be usable; referenced reusable blocks must be live. */
  async function assertPublishable(kind: ContentKind, snap: any) {
    const assetIds = mediaRefs(kind, snap).map(r => r.assetId)
    const unusable = await findUnusableAssets(sql, assetIds)
    if (unusable.length) throw new ContentError('unusable_media', 'An image used here is missing or archived. Replace it before publishing.', { assetIds: unusable })
    const refs = blockRefs(kind, snap)
    if (refs.length) {
      const live = await sql`SELECT entity_id FROM content_entities WHERE entity_type = 'content_block' AND status = 'published' AND entity_id = ANY(${refs}::text[])` as any[]
      const ok = new Set(live.map(r => r.entity_id))
      const missing = refs.filter(r => !ok.has(r))
      if (missing.length) throw new ContentError('missing_block', 'A reusable block used here is not published.', { blockIds: missing })
    }
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  async function list(kind: ContentKind, o: { q?: string; status?: string; limit?: number } = {}): Promise<EntityRow[]> {
    const def = KINDS[kind]
    const limit = Math.min(Math.max(o.limit ?? 200, 1), 500)
    const rows = await sql`
      SELECT e.entity_id, e.status, e.slug, e.revision, e.updated_at, e.published_at, e.updated_by,
             e.draft_version_no, e.published_version_no, COALESCE(d.snapshot, p.snapshot,
               (SELECT lv.snapshot FROM content_versions lv WHERE lv.entity_type = e.entity_type AND lv.entity_id = e.entity_id
                 ORDER BY lv.version_no DESC LIMIT 1)) AS snapshot
        FROM content_entities e
        LEFT JOIN content_versions d ON d.entity_type = e.entity_type AND d.entity_id = e.entity_id AND d.version_no = e.draft_version_no
        LEFT JOIN content_versions p ON p.entity_type = e.entity_type AND p.entity_id = e.entity_id AND p.version_no = e.published_version_no
       WHERE e.entity_type = ${def.type}
         AND (${o.status ?? null}::text IS NULL OR e.status = ${o.status ?? null})
       ORDER BY e.updated_at DESC LIMIT ${limit}` as any[]
    const q = (o.q ?? '').trim().toLowerCase()
    let out: EntityRow[] = rows.map(r => ({
      id: r.entity_id, status: r.status, slug: r.slug, revision: r.revision,
      title: snapshotTitle(kind, r.snapshot), hasDraft: r.draft_version_no !== null, isLive: r.published_version_no !== null,
      updatedAt: new Date(r.updated_at).toISOString(), publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
      updatedBy: r.updated_by ?? null, snapshot: r.snapshot,
    }))
    if (q) out = out.filter(r => `${r.title} ${r.slug ?? ''} ${JSON.stringify(r.snapshot ?? {}).slice(0, 4000)}`.toLowerCase().includes(q))
    if (kind === 'size-guides') {
      const counts = await sql`SELECT size_guide_id, COUNT(*)::int AS n FROM product_size_guides GROUP BY 1` as any[]
      const m = new Map(counts.map(c => [c.size_guide_id, c.n]))
      out = out.map(r => ({ ...r, extra: { productCount: m.get(r.id) ?? 0 } }))
    }
    if (kind === 'blocks') {
      const counts = await sql`SELECT block_id, COUNT(DISTINCT (owner_type, owner_id))::int AS n FROM content_block_usages GROUP BY 1` as any[]
      const m = new Map(counts.map(c => [c.block_id, c.n]))
      out = out.map(r => ({ ...r, extra: { usageCount: m.get(r.id) ?? 0 } }))
    }
    return out
  }

  /** The editor payload: the working snapshot (draft, else live), head state and live snapshot. */
  async function get(kind: ContentKind, rawId?: string) {
    const def = KINDS[kind]
    const id = resolveEntityId(def, rawId)
    const row = await cms.get(def.type, id)
    if (!row) {
      const dflt = DEFAULTS_BY_KIND[kind]?.(id)
      if (dflt) return { id, kind, exists: false, revision: 0, status: 'draft' as const, slug: null, hasDraft: false, isLive: false, snapshot: dflt, published: null, publishedVersion: null, draftVersion: null }
      throw new ContentError('not_found', 'Not found.')
    }
    return {
      id, kind, exists: true, revision: row.revision as number, status: row.status as string, slug: row.slug as string | null,
      hasDraft: row.draft_version_no !== null, isLive: row.published_version_no !== null,
      snapshot: row.draft_snapshot ?? row.published_snapshot, published: row.published_snapshot ?? null,
      publishedVersion: row.published_version_no as number | null, draftVersion: row.draft_version_no as number | null,
      publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by as string | null,
      path: kind === 'policies' && row.slug ? policyPath(id, row.slug) : kind === 'pages' && row.slug ? `/pages/${row.slug}` : null,
    }
  }

  const history = (kind: ContentKind, rawId?: string, limit = 50) => cms.history(KINDS[kind].type, resolveEntityId(KINDS[kind], rawId), limit)
  async function getVersion(kind: ContentKind, rawId: string | undefined, versionNo: number) {
    const v = await cms.getVersion(KINDS[kind].type, resolveEntityId(KINDS[kind], rawId), versionNo)
    if (!v) throw new ContentError('not_found', 'Version not found.')
    return v
  }

  // ── writes ──────────────────────────────────────────────────────────────────

  async function create(kind: ContentKind, input: unknown, actor: string, rawId?: string): Promise<Outcome<{ id: string; revision: number }>> {
    const def = KINDS[kind]
    const id = def.singleton ?? (kind === 'support-pages' ? resolveEntityId(def, rawId) : (rawId ? resolveEntityId(def, rawId) : newId()))
    const snap = parse(kind, id, input)
    const r = await cms.saveDraft(def.type, id, snap as any, 0, actor, 'Created')
    await syncAllUsages(kind, id, snap, 'draft')
    return { data: { id, revision: r.revision }, invalidation: null }
  }

  async function saveDraft(kind: ContentKind, rawId: string | undefined, input: unknown, expectedRevision: number, actor: string, note?: string | null): Promise<Outcome<{ id: string; revision: number; versionNo: number }>> {
    const def = KINDS[kind]
    const id = resolveEntityId(def, rawId)
    const snap = parse(kind, id, input)
    const r = await cms.saveDraft(def.type, id, snap as any, expectedRevision, actor, note ?? null)
    await syncAllUsages(kind, id, snap, 'draft')
    return { data: { id, revision: r.revision, versionNo: r.version_no }, invalidation: null }
  }

  async function publish(kind: ContentKind, rawId: string | undefined, expectedRevision: number, actor: string): Promise<Outcome<{ id: string; revision: number; slug: string | null; previousSlug: string | null; redirectCreated: boolean; path: string | null }>> {
    const def = KINDS[kind]
    const id = resolveEntityId(def, rawId)
    const row = await cms.get(def.type, id)
    if (!row) throw new ContentError('not_found', 'Not found.')
    if (row.draft_version_no === null) throw new CmsError('no_draft', 'There is no draft to publish.')
    const snap = parse(kind, id, row.draft_snapshot)               // re-validate server-side, always
    await assertPublishable(kind, snap)
    let r: any
    try {
      if (kind === 'policies') {
        const rows = await sql`SELECT content_policy_go_live(${id}, ${expectedRevision}, ${actor}) AS r` as any[]
        r = rows[0].r
      } else {
        r = await cms.publish(def.type, id, expectedRevision, actor, kind === 'pages' ? '/pages' : null)
      }
    } catch (e) { throw e instanceof CmsError ? e : toCmsError(e) }
    await syncAllUsages(kind, id, snap, 'published')
    await syncAllUsages(kind, id, null, 'draft')
    const inv = await invalidateFor(kind, id, actor, 'publish', { slug: r.slug, previousSlug: r.previous_slug })
    return { data: { id, revision: r.revision ?? expectedRevision + 1, slug: r.slug ?? null, previousSlug: r.previous_slug ?? null, redirectCreated: !!r.redirect_created, path: r.path ?? null }, invalidation: inv }
  }

  async function rollback(kind: ContentKind, rawId: string | undefined, toVersionNo: number, expectedRevision: number, actor: string): Promise<Outcome<{ id: string; revision: number; slug: string | null }>> {
    const def = KINDS[kind]
    const id = resolveEntityId(def, rawId)
    const target = await cms.getVersion(def.type, id, toVersionNo)
    if (!target) throw new ContentError('not_found', 'Version not found.')
    const snap = parse(kind, id, target.snapshot)                  // an old snapshot must still be valid today
    await assertPublishable(kind, snap)
    let r: any
    try {
      if (kind === 'policies') {
        const rows = await sql`SELECT content_policy_go_live(${id}, ${expectedRevision}, ${actor}, ${toVersionNo}) AS r` as any[]
        r = rows[0].r
      } else {
        r = await cms.rollback(def.type, id, toVersionNo, expectedRevision, actor, kind === 'pages' ? '/pages' : null)
      }
    } catch (e) { throw e instanceof CmsError ? e : toCmsError(e) }
    await syncAllUsages(kind, id, snap, 'published')
    const inv = await invalidateFor(kind, id, actor, 'rollback', { slug: r.slug, previousSlug: r.previous_slug })
    return { data: { id, revision: r.revision ?? expectedRevision + 1, slug: r.slug ?? null }, invalidation: inv }
  }

  async function currentSlug(kind: ContentKind, id: string): Promise<string | null> {
    const row = await cms.get(KINDS[kind].type, id)
    return row?.slug ?? null
  }

  async function blockLiveUsage(blockId: string) {
    return await sql`SELECT owner_type, owner_id, scope FROM content_block_usages WHERE block_id = ${blockId} AND scope = 'published' ORDER BY owner_type, owner_id` as any[]
  }

  async function unpublish(kind: ContentKind, rawId: string | undefined, expectedRevision: number, actor: string): Promise<Outcome<{ id: string; revision: number }>> {
    const def = KINDS[kind]
    const id = resolveEntityId(def, rawId)
    const forbid = archiveForbidden(kind, id)
    if (forbid) throw new ContentError('forbidden', forbid.replace('cannot be archived', 'cannot be unpublished'))
    if (kind === 'blocks') {
      const used = await blockLiveUsage(id)
      if (used.length) throw new ContentError('in_use', 'This block is used on live content. Remove it there first.', { usages: used })
    }
    const slug = await currentSlug(kind, id)
    const r = await cms.unpublish(def.type, id, expectedRevision, actor)
    await syncAllUsages(kind, id, null, 'published')
    const inv = await invalidateFor(kind, id, actor, 'unpublish', { slug })
    return { data: { id, revision: r.revision }, invalidation: inv }
  }

  async function archive(kind: ContentKind, rawId: string | undefined, expectedRevision: number, actor: string, o: { force?: boolean } = {}): Promise<Outcome<{ id: string; revision: number }>> {
    const def = KINDS[kind]
    const id = resolveEntityId(def, rawId)
    const forbid = archiveForbidden(kind, id)
    if (forbid) throw new ContentError('forbidden', forbid)
    if (kind === 'blocks') {
      const used = await blockLiveUsage(id)
      if (used.length) throw new ContentError('in_use', 'This block is used on live content. Remove it there first.', { usages: used })
    }
    if (kind === 'size-guides' && !o.force) {
      const n = (await sql`SELECT COUNT(*)::int AS n FROM product_size_guides WHERE size_guide_id = ${id}` as any[])[0].n
      if (n > 0) throw new ContentError('in_use', `${n} product${n === 1 ? ' uses' : 's use'} this size guide. Archiving removes it from those products.`, { productCount: n })
    }
    const slug = await currentSlug(kind, id)
    const paths = kind === 'size-guides' ? await productPathsForGuide(id) : []     // capture BEFORE unlinking
    const r = await cms.archive(def.type, id, expectedRevision, actor)
    if (kind === 'size-guides') await sql`DELETE FROM product_size_guides WHERE size_guide_id = ${id}`
    await syncAllUsages(kind, id, null, 'published')
    await syncAllUsages(kind, id, null, 'draft')
    const target = await targetFor(kind, id, { slug })
    const inv = await invalidate({ paths: [...(target.paths ?? []), ...paths], tags: target.tags }, { reason: `archive: ${def.type}/${id}`, actor })
    return { data: { id, revision: r.revision }, invalidation: inv }
  }

  async function restore(kind: ContentKind, rawId: string | undefined, expectedRevision: number, actor: string): Promise<Outcome<{ id: string; revision: number }>> {
    const def = KINDS[kind]
    const id = resolveEntityId(def, rawId)
    const r = await cms.restore(def.type, id, expectedRevision, actor)   // never auto-publishes
    return { data: { id, revision: r.revision }, invalidation: null }
  }

  /** Independent copy (new entity id, new draft). Linked products keep using the ORIGINAL. */
  async function duplicate(kind: ContentKind, rawId: string | undefined, actor: string): Promise<Outcome<{ id: string; revision: number }>> {
    const def = KINDS[kind]
    if (def.singleton || kind === 'support-pages') throw new ContentError('forbidden', 'This content cannot be duplicated.')
    const id = resolveEntityId(def, rawId)
    const src = await cms.get(def.type, id)
    if (!src) throw new ContentError('not_found', 'Not found.')
    const snap: any = JSON.parse(JSON.stringify(src.draft_snapshot ?? src.published_snapshot))
    if ('name' in snap) snap.name = `Copy of ${snap.name}`.slice(0, 100)
    if ('title' in snap && !('name' in snap)) snap.title = `Copy of ${snap.title}`.slice(0, 140)
    if (def.sluggable) {
      const taken = new Set(((await sql`
        SELECT lower(x.s) AS s FROM (
          SELECT slug AS s FROM content_entities WHERE entity_type = ${def.type}
          UNION ALL SELECT snapshot->>'slug' FROM content_versions WHERE entity_type = ${def.type}
        ) x WHERE x.s IS NOT NULL` as any[])).map(r => r.s))
      let cand = `${snap.slug}-copy`.slice(0, 80).replace(/-+$/, ''); let n = 2
      while (taken.has(cand)) cand = `${snap.slug}-copy-${n++}`.slice(0, 80)
      snap.slug = cand
    }
    if (kind === 'size-guides') snap.showOnGuidePage = false    // a copy never silently appears on the public guide
    const newEntityId = newId()
    const checked = parse(kind, newEntityId, snap)
    const r = await cms.saveDraft(def.type, newEntityId, checked as any, 0, actor, `Duplicated from ${id}`)
    await syncAllUsages(kind, newEntityId, checked, 'draft')
    await audit(actor, 'content.duplicate', def.type, newEntityId, { from: id })
    return { data: { id: newEntityId, revision: r.revision }, invalidation: null }
  }

  // ── translations ────────────────────────────────────────────────────────────

  async function translationOverview(kind: ContentKind, rawId?: string) {
    const def = KINDS[kind]
    const id = resolveEntityId(def, rawId)
    const row = await cms.get(def.type, id)
    const working = row ? (row.draft_snapshot ?? row.published_snapshot) : DEFAULTS_BY_KIND[kind]?.(id)
    const source = translatableFields(kind, working)
    const locales = (await getEnabledLocales(sql)).filter(l => l !== SOURCE_LOCALE)
    const rows = await sql`SELECT locale, field, value, status, source_hash, machine_generated, updated_at
                             FROM content_translations WHERE entity_type = ${def.type} AND entity_id = ${id}` as TranslationRow[]
    const byLocale: Record<string, TranslationRow[]> = {}
    for (const r of rows) (byLocale[r.locale] ??= []).push(r)
    const completeness = summarizeCompleteness(source, byLocale as any, [SOURCE_LOCALE, ...locales])
    // Published-state completeness: what shoppers actually get (legal pages: only deliberately published rows count).
    return { id, kind, legal: def.legal, locales, source, rows: rows.map(r => ({ ...r, updated_at: new Date(r.updated_at).toISOString() })), completeness }
  }

  async function assertTranslatable(kind: ContentKind, id: string, locale: string, field: string): Promise<{ value: string }> {
    const def = KINDS[kind]
    if (!isValidLocale(locale) || locale === SOURCE_LOCALE) throw new ContentError('invalid', 'Choose a translation language.')
    const enabled = await getEnabledLocales(sql)
    if (!enabled.includes(locale)) throw new ContentError('invalid', 'That language is not enabled.')
    const row = await cms.get(def.type, id)
    if (!row) throw new ContentError('not_found', 'Not found.')
    const source = translatableFields(kind, row.draft_snapshot ?? row.published_snapshot)
    if (!(field in source)) throw new ContentError('invalid', 'That field cannot be translated.')
    return { value: source[field] }
  }

  async function saveTranslation(kind: ContentKind, rawId: string | undefined, t: {
    locale: string; field: string; value: string; status?: 'draft' | 'needs_review' | 'published'; machineGenerated?: boolean
  }, actor: string): Promise<Outcome<{ status: string }>> {
    const def = KINDS[kind]
    const id = resolveEntityId(def, rawId)
    const src = await assertTranslatable(kind, id, t.locale, t.field)
    const value = String(t.value ?? '')
    if (!value.trim()) throw new ContentError('invalid', 'Enter a translation, or clear the field.')
    if (value.length > 150_000) throw new ContentError('invalid', 'That translation is too long.')
    if (src.value.startsWith('{"v":1')) {                        // rich-text field: the translation must be valid structured text
      let parsed: unknown
      try { parsed = JSON.parse(value) } catch { throw new ContentError('invalid', 'The translated content is not valid.') }
      const v = validateRichText(parsed, { allowBlockRefs: true })
      if (!v.ok) throw new ContentError('invalid', 'The translated content has problems.', v.errors)
    }
    let status = t.status ?? 'draft'
    if (def.legal && status === 'published') {
      throw new ContentError('forbidden', 'Legal translations are published per language with an explicit confirmation.')
    }
    if (t.machineGenerated) status = status === 'published' ? 'draft' : status
    await upsertTranslation(sql, { entityType: def.type, entityId: id, locale: t.locale, field: t.field, value, sourceText: src.value, status, machineGenerated: !!t.machineGenerated, actor })
    await audit(actor, 'content.translation.save', def.type, id, { locale: t.locale, field: t.field, status, machine: !!t.machineGenerated })
    let inv: InvalidationResult | null = null
    if (status === 'published') inv = await invalidateFor(kind, id, actor, 'translation', { slug: await currentSlug(kind, id) })
    return { data: { status }, invalidation: inv }
  }

  async function clearTranslation(kind: ContentKind, rawId: string | undefined, locale: string, field: string, actor: string): Promise<Outcome<{ cleared: boolean }>> {
    const def = KINDS[kind]
    const id = resolveEntityId(def, rawId)
    if (!isValidLocale(locale) || locale === SOURCE_LOCALE) throw new ContentError('invalid', 'Choose a translation language.')
    const rows = await sql`DELETE FROM content_translations WHERE entity_type = ${def.type} AND entity_id = ${id} AND locale = ${locale} AND field = ${field} RETURNING status` as any[]
    if (rows.length) await audit(actor, 'content.translation.clear', def.type, id, { locale, field, was: rows[0].status })
    const inv = rows[0]?.status === 'published' ? await invalidateFor(kind, id, actor, 'translation', { slug: await currentSlug(kind, id) }) : null
    return { data: { cleared: rows.length > 0 }, invalidation: inv }
  }

  /**
   * Deliberately publish a locale: every human-written (non-machine) translation row of that
   * locale becomes visible to shoppers. Legal content requires `acknowledge` — the editor
   * confirms a qualified person reviewed it. Machine-generated rows are never published.
   */
  async function publishLocale(kind: ContentKind, rawId: string | undefined, locale: string, actor: string, o: { acknowledge?: boolean } = {}): Promise<Outcome<{ published: number; skippedMachine: number; staleSkipped: number }>> {
    const def = KINDS[kind]
    const id = resolveEntityId(def, rawId)
    if (!isValidLocale(locale) || locale === SOURCE_LOCALE) throw new ContentError('invalid', 'Choose a translation language.')
    if (def.legal && !o.acknowledge) throw new ContentError('forbidden', 'Confirm the translation was reviewed before publishing legal content.')
    const ov = await translationOverview(kind, id)
    const rows = ov.rows.filter(r => r.locale === locale)
    let published = 0, skippedMachine = 0, staleSkipped = 0
    for (const r of rows) {
      if (r.machine_generated) { skippedMachine++; continue }
      if (!(r.field in ov.source)) continue
      await sql`UPDATE content_translations SET status = 'published', published_at = NOW(), updated_by = ${actor}
                 WHERE entity_type = ${def.type} AND entity_id = ${id} AND locale = ${locale} AND field = ${r.field} AND machine_generated = FALSE`
      published++
    }
    for (const c of ov.completeness) if (c.locale === locale) staleSkipped = c.stale
    await audit(actor, 'content.translation.publish', def.type, id, { locale, published, skippedMachine, legal: def.legal })
    const inv = published ? await invalidateFor(kind, id, actor, 'translation', { slug: await currentSlug(kind, id) }) : null
    return { data: { published, skippedMachine, staleSkipped }, invalidation: inv }
  }

  /** Withdraw a locale from shoppers (rows go back to draft; nothing is deleted). */
  async function unpublishLocale(kind: ContentKind, rawId: string | undefined, locale: string, actor: string): Promise<Outcome<{ unpublished: number }>> {
    const def = KINDS[kind]
    const id = resolveEntityId(def, rawId)
    if (!isValidLocale(locale) || locale === SOURCE_LOCALE) throw new ContentError('invalid', 'Choose a translation language.')
    const rows = await sql`UPDATE content_translations SET status = 'draft', published_at = NULL, updated_by = ${actor}
                             WHERE entity_type = ${def.type} AND entity_id = ${id} AND locale = ${locale} AND status = 'published' RETURNING field` as any[]
    await audit(actor, 'content.translation.unpublish', def.type, id, { locale, count: rows.length })
    const inv = rows.length ? await invalidateFor(kind, id, actor, 'translation', { slug: await currentSlug(kind, id) }) : null
    return { data: { unpublished: rows.length }, invalidation: inv }
  }

  // ── size guide ↔ product ───────────────────────────────────────────────────

  async function listGuideProducts(guideId: string) {
    return await sql`SELECT p.id, p.name, p.slug FROM product_size_guides g JOIN products p ON p.id = g.product_id
                      WHERE g.size_guide_id = ${guideId} ORDER BY p.name` as Array<{ id: string; name: string; slug: string }>
  }

  /** Assign (or clear with null) the size guide a product shows. Products linked to one guide share its updates. */
  async function assignSizeGuide(productId: string, guideId: string | null, actor: string): Promise<Outcome<{ productId: string; guideId: string | null }>> {
    if (!UUID_RE.test(productId)) throw new ContentError('invalid', 'Invalid product.')
    const prod = (await sql`SELECT slug, product_code FROM products WHERE id = ${productId}` as any[])[0]
    if (!prod) throw new ContentError('not_found', 'Product not found.')
    const prev = (await sql`SELECT size_guide_id FROM product_size_guides WHERE product_id = ${productId}` as any[])[0]?.size_guide_id ?? null
    if (guideId) {
      const g = await cms.get('size_guide', guideId)
      if (!g) throw new ContentError('not_found', 'Size guide not found.')
      if (g.status === 'archived') throw new ContentError('forbidden', 'That size guide is archived.')
      await sql`INSERT INTO product_size_guides (product_id, size_guide_id, assigned_by) VALUES (${productId}, ${guideId}, ${actor})
                ON CONFLICT (product_id) DO UPDATE SET size_guide_id = EXCLUDED.size_guide_id, assigned_by = EXCLUDED.assigned_by, updated_at = NOW()`
    } else {
      await sql`DELETE FROM product_size_guides WHERE product_id = ${productId}`
    }
    await audit(actor, 'content.size_guide.assign', 'product', productId, { from: prev, to: guideId })
    const paths = [`/products/${prod.slug}`]; if (CODE_TO_PUBLIC_SLUG[prod.product_code]) paths.push(`/products/${CODE_TO_PUBLIC_SLUG[prod.product_code]}`)
    const inv = await invalidate({ paths, tags: [CMS_TAGS.sizeGuides, CMS_TAGS.product(prod.slug)] }, { reason: `size guide assigned: ${prod.slug}`, actor })
    return { data: { productId, guideId }, invalidation: inv }
  }

  /** Product Editor "Duplicate and edit": independent copy of a guide, optionally assigned to the product. */
  async function duplicateSizeGuideForProduct(guideId: string, productId: string | null, actor: string) {
    const dup = await duplicate('size-guides', guideId, actor)
    if (productId) {
      const a = await assignSizeGuide(productId, dup.data.id, actor)
      return { ...dup, invalidation: a.invalidation }
    }
    return dup
  }

  async function blockUsage(blockId: string) {
    return await sql`SELECT u.owner_type, u.owner_id, u.scope, e.slug FROM content_block_usages u
                       LEFT JOIN content_entities e ON e.entity_type = u.owner_type AND e.entity_id = u.owner_id
                      WHERE u.block_id = ${blockId} ORDER BY u.owner_type, u.owner_id` as any[]
  }

  return {
    cms, list, get, history, getVersion, create, saveDraft, publish, rollback, unpublish, archive, restore, duplicate,
    translationOverview, saveTranslation, clearTranslation, publishLocale, unpublishLocale,
    listGuideProducts, assignSizeGuide, duplicateSizeGuideForProduct, blockUsage, targetFor,
  }
}

export type ContentService = ReturnType<typeof createContentService>
export { isContentKind }
export type { PolicySnapshot }
