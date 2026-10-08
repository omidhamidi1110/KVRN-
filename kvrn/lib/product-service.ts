// lib/product-service.ts — Admin operations for the Product Editor (server only).
//
// Every state change is ONE SQL function call (Neon HTTP = one transaction), so a product can
// never be half-published: the go-live trigger in migration 028 validates the blockers and applies
// price/variants atomically with cms_publish. After a commit this service invalidates the exact
// storefront paths/tags and returns the result as `cacheInvalidation` so Admin can show a failure
// instead of claiming the site is current.
//
// Commerce truth stays in products/product_variants; this service never writes stock.
import { createCms, CmsError, toCmsError } from './cms-core'
import { invalidateAfterCommit, productInvalidation, collectionInvalidation, type InvalidationResult } from './cache-invalidation'
import { syncMediaUsages } from './media-usage'
import { toMediaAssetDTO, type MediaAssetDTO } from './media-storage'
import { loadProductDefaults, type ProductDefaults } from './product-defaults'
import {
  emptySnapshot, parseSnapshotInput, slugify, snapshotAssetIds, snapshotMediaRefs, snapshotForDuplicate, isUuid,
  type ProductSnapshot, type VariantDef,
} from './product-model'
import { buildVariantSku } from './product-variants'
import { bundleIssuesFor } from './bundle-admin'

type Sql = any

export interface Issue { code: string; field: string; message: string }
export interface Blockers { blockers: Issue[]; warnings: Issue[] }

/** Publish/schedule refused because the product is incomplete. Carries the exact list. */
export class ProductBlockedError extends Error {
  readonly status = 422
  constructor(public readonly blockers: Issue[], public readonly warnings: Issue[] = []) {
    super('This product is not ready to publish.')
    this.name = 'ProductBlockedError'
  }
}
/** Malformed editor input (not a publish blocker): the draft is not saved. */
export class ProductInputError extends Error {
  readonly status = 400
  constructor(public readonly errors: string[]) { super('Some fields are not valid.'); this.name = 'ProductInputError' }
}

const INVALID_MAP: Record<string, string> = {
  PRODUCT_CODE: 'The product code must be 2–12 capital letters or digits.',
  PRODUCT_CODE_TAKEN: 'That product code is already used.',
  NAME: 'Enter a product name (up to 120 characters).',
  SLUG: 'The URL can use lowercase letters, numbers and hyphens only.',
  TYPE: 'The product type can use lowercase letters, numbers and hyphens only.',
  SNAPSHOT: 'The product data is not valid.',
}

/** Map any database error from a catalog/cms function to a typed error. */
export function toProductError(e: unknown): Error {
  if (e instanceof ProductBlockedError || e instanceof ProductInputError || e instanceof CmsError) return e
  const msg = String((e as any)?.message ?? e ?? '')
  const i = msg.indexOf('CATALOG_BLOCKED|')
  if (i >= 0) {
    const raw = msg.slice(i + 'CATALOG_BLOCKED|'.length).split('\n')[0]
    try {
      const list = JSON.parse(raw)
      if (Array.isArray(list)) return new ProductBlockedError(list as Issue[])
    } catch { /* fall through */ }
    return new ProductBlockedError([{ code: 'BLOCKED', field: '', message: 'This product is not ready to publish.' }])
  }
  const bi = msg.indexOf('BUNDLE_BLOCKED|')
  if (bi >= 0) {
    // Raised by the bundle go-live trigger (migration 029): the whole publish was rolled back.
    const raw = msg.slice(bi + 'BUNDLE_BLOCKED|'.length).split('\n')[0]
    try {
      const list = JSON.parse(raw)
      if (Array.isArray(list)) return new ProductBlockedError(list as Issue[])
    } catch { /* fall through */ }
    return new ProductBlockedError([{ code: 'BUNDLE_BLOCKED', field: 'bundle', message: 'The set is not ready to publish.' }])
  }
  const j = msg.indexOf('CATALOG_INVALID|')
  if (j >= 0) {
    const key = msg.slice(j + 'CATALOG_INVALID|'.length).split(/[\s\n]/)[0]
    return new CmsError('invalid', INVALID_MAP[key] ?? 'The request is not valid.', `CATALOG_INVALID|${key}`)
  }
  return toCmsError(e)
}

/** HTTP status + body for any service error (routes use this). */
export function errorResponse(e: unknown): { status: number; body: Record<string, unknown> } {
  const err = toProductError(e)
  if (err instanceof ProductBlockedError) return { status: 422, body: { error: err.message, code: 'blocked', blockers: err.blockers, warnings: err.warnings } }
  if (err instanceof ProductInputError) return { status: 400, body: { error: err.message, code: 'input', errors: err.errors } }
  if (err instanceof CmsError) return { status: err.status, body: { error: err.message, code: err.code } }
  return { status: 500, body: { error: 'Unexpected error.', code: 'unknown' } }
}

export type DisplayStatus = 'draft' | 'scheduled' | 'live' | 'sold_out' | 'archived'

export interface CanonicalCommerce {
  priceCents: number; active: boolean; productCode: string | null; originCountry: string | null; hsCode: string | null
  shipping: { weightLb: number | null; lengthIn: number | null; widthIn: number | null; heightIn: number | null }
  variants: Array<VariantDef & { stockOnHand: number; reserved: number }>
}

/** Rebuild the snapshot's commerce intent from the canonical tables (used when no draft is open). */
export function commerceFromCanonical(c: CanonicalCommerce): ProductSnapshot['commerce'] {
  return {
    priceCents: c.priceCents > 0 ? c.priceCents : null,
    shipping: { ...c.shipping },
    originCountry: c.originCountry, hsCode: c.hsCode,
    variants: c.variants.map(v => ({ id: v.id, sku: v.sku, colorCode: v.colorCode, size: v.size, sizeSort: v.sizeSort, active: v.active })),
  }
}

export interface ListFilters { q?: string; status?: DisplayStatus | 'all'; sort?: 'updated' | 'name' | 'price' | 'status'; limit?: number; offset?: number }

export interface ListItem {
  id: string; productCode: string | null; name: string; slug: string; type: string | null
  displayStatus: DisplayStatus; entityStatus: string; revision: number
  priceCents: number | null; thumb: string | null
  publishAt: string | null; unpublishAt: string | null; overdue: boolean
  hasUnpublishedChanges: boolean; blockerCount: number | null; warningCount: number | null
  availableUnits: number | null; activeVariants: number; updatedAt: string; publishedAt: string | null
}

export interface ServiceDeps {
  invalidate?: (sql: Sql, target: ReturnType<typeof productInvalidation>, ctx: { reason: string; actor?: string | null }) => Promise<InvalidationResult>
}

export interface Mutation<T = Record<string, unknown>> { result: T; cacheInvalidation: InvalidationResult | null }

export function createProductService(sql: Sql, deps: ServiceDeps = {}) {
  const cms = createCms(sql)
  const invalidate = deps.invalidate ?? ((s, t, c) => invalidateAfterCommit(s, t, c))

  async function wrap<T>(p: Promise<T>): Promise<T> { try { return await p } catch (e) { throw toProductError(e) } }

  async function entity(id: string) {
    if (!isUuid(id)) throw new CmsError('not_found', 'Product not found.')
    const e = await cms.get('product', id.toLowerCase())
    if (!e) throw new CmsError('not_found', 'Product not found.')
    // An unpublished / archived product has neither an open draft nor a live version: fall back to
    // its most recent version so the editor can still open, validate and re-publish it.
    if (!e.draft_snapshot && !e.published_snapshot) {
      const rows = await sql`
        SELECT snapshot FROM content_versions
         WHERE entity_type = 'product' AND entity_id = ${id.toLowerCase()}
         ORDER BY version_no DESC LIMIT 1` as any[]
      e.last_snapshot = rows[0]?.snapshot ?? null
    }
    return e as any
  }

  async function collectionSlugs(productId: string): Promise<string[]> {
    const rows = await sql`
      SELECT c.slug FROM collection_products cp JOIN collections c ON c.id = cp.collection_id
       WHERE cp.product_id = ${productId}::uuid` as any[]
    return rows.map(r => r.slug)
  }

  /** Invalidate the product's pages (old + new slug) and every collection that lists it. */
  async function invalidateProduct(productId: string, slug: string | null, previousSlug: string | null, reason: string, actor: string): Promise<InvalidationResult | null> {
    if (!slug && !previousSlug) return null
    const base = productInvalidation((slug ?? previousSlug)!, slug ? previousSlug : null)
    const cols = await collectionSlugs(productId).catch(() => [] as string[])
    const paths = [...(base.paths ?? []), ...cols.map(c => `/collections/${c}`)]
    const tags = [...(base.tags ?? []), ...cols.map(c => `cms:collection:${c}`)]
    return invalidate(sql, { paths, tags }, { reason, actor })
  }

  async function blockersFor(productId: string, snapshot: unknown, mode: 'publish' | 'rollback' = 'publish'): Promise<Blockers> {
    const rows = await sql`SELECT catalog_product_blockers(${productId}::uuid, ${JSON.stringify(snapshot)}::jsonb, ${mode}) AS r` as any[]
    const r = rows[0]?.r ?? {}
    // The bundle ("Complete the Set") checks run alongside the catalog ones, so the editor, publish and
    // schedule all show the same list. (Rollback keeps the canonical price, as the projection does.)
    const bundle = await bundleIssuesFor(sql, productId, snapshot, mode === 'publish')
    return { blockers: [...(r.blockers ?? []), ...bundle], warnings: r.warnings ?? [] }
  }

  async function loadCanonical(productId: string): Promise<CanonicalCommerce | null> {
    const rows = await sql`
      SELECT price_cents, active, product_code, country_of_origin, hs_code,
             shipping_weight_lb, package_length_in, package_width_in, package_height_in
        FROM products WHERE id = ${productId}::uuid` as any[]
    const p = rows[0]
    if (!p) return null
    const vs = await sql`
      SELECT id, sku, color_code, size, size_sort, active, stock_on_hand, reserved_quantity
        FROM product_variants WHERE product_id = ${productId}::uuid ORDER BY size_sort, sku` as any[]
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v))
    return {
      priceCents: Number(p.price_cents), active: !!p.active, productCode: p.product_code ?? null,
      originCountry: p.country_of_origin ?? null, hsCode: p.hs_code ?? null,
      shipping: { weightLb: n(p.shipping_weight_lb), lengthIn: n(p.package_length_in), widthIn: n(p.package_width_in), heightIn: n(p.package_height_in) },
      variants: vs.map(v => ({
        id: v.id, sku: v.sku, colorCode: v.color_code ?? '', size: v.size, sizeSort: v.size_sort ?? 0, active: !!v.active,
        stockOnHand: Number(v.stock_on_hand), reserved: Number(v.reserved_quantity),
      })),
    }
  }

  async function assetMap(ids: string[]): Promise<Record<string, MediaAssetDTO>> {
    if (!ids.length) return {}
    const rows = await sql`SELECT * FROM media_assets WHERE id = ANY(${ids}::uuid[])` as any[]
    const out: Record<string, MediaAssetDTO> = {}
    for (const r of rows) { const d = toMediaAssetDTO(r); out[d.id.toLowerCase()] = d }
    return out
  }

  /** Throttled audit row for autosave: one per actor+product per 10 minutes. */
  async function auditDraftSave(productId: string, actor: string, versionNo: number, revision: number) {
    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      SELECT ${actor}, 'product.draft_save', 'product', ${productId}, jsonb_build_object('version_no', ${versionNo}::int, 'revision', ${revision}::int)
       WHERE NOT EXISTS (
         SELECT 1 FROM admin_audit_logs a
          WHERE a.action = 'product.draft_save' AND a.resource_id = ${productId} AND a.actor_email = ${actor}
            AND a.created_at > NOW() - INTERVAL '10 minutes')`
  }

  return {
    cms, blockersFor, loadCanonical,

    // ── list ────────────────────────────────────────────────────────────────────
    async list(f: ListFilters = {}): Promise<{ items: ListItem[]; total: number }> {
      const q = (f.q ?? '').trim().slice(0, 100)
      const like = q ? `%${q.replace(/[%_\\]/g, m => '\\' + m)}%` : null
      const limit = Math.min(Math.max(f.limit ?? 100, 1), 200)
      const offset = Math.max(f.offset ?? 0, 0)
      const rows = await sql`
        SELECT p.id, p.product_code, p.product_type, p.price_cents, p.active,
               e.status, e.slug, e.revision, e.publish_at, e.unpublish_at, e.published_at, e.updated_at,
               e.draft_version_no, e.published_version_no,
               COALESCE(d.snapshot, pv.snapshot, lv.snapshot) AS snap,
               (d.snapshot IS NOT NULL) AS has_draft,
               CASE WHEN d.snapshot IS NOT NULL AND e.status <> 'archived' THEN catalog_product_blockers(p.id, d.snapshot, 'publish') END AS bl,
               (SELECT COUNT(*) FROM product_variants x WHERE x.product_id = p.id AND x.active)::int AS active_variants,
               (SELECT COALESCE(SUM(GREATEST(0, x.stock_on_hand - x.reserved_quantity)), 0) FROM product_variants x WHERE x.product_id = p.id AND x.active)::int AS avail
          FROM content_entities e
          JOIN products p ON p.id::text = e.entity_id
          LEFT JOIN content_versions d  ON d.entity_type = e.entity_type AND d.entity_id = e.entity_id AND d.version_no = e.draft_version_no
          LEFT JOIN content_versions pv ON pv.entity_type = e.entity_type AND pv.entity_id = e.entity_id AND pv.version_no = e.published_version_no
          LEFT JOIN LATERAL (SELECT x.snapshot FROM content_versions x
                              WHERE x.entity_type = e.entity_type AND x.entity_id = e.entity_id
                              ORDER BY x.version_no DESC LIMIT 1) lv ON d.snapshot IS NULL AND pv.snapshot IS NULL
         WHERE e.entity_type = 'product'
           AND (${like}::text IS NULL OR COALESCE(d.snapshot->>'name', pv.snapshot->>'name', lv.snapshot->>'name', '') ILIKE ${like}::text
                OR e.slug ILIKE ${like}::text OR p.product_code ILIKE ${like}::text)
         ORDER BY e.updated_at DESC
         LIMIT 500` as any[]

      const refs = rows.map(r => r.snap?.media?.hero?.ref ?? r.snap?.media?.gallery?.[0]?.ref).filter((x: any) => x?.kind === 'media').map((x: any) => x.assetId)
      const assets = await assetMap([...new Set(refs as string[])])
      const now = Date.now()
      let items: ListItem[] = rows.map(r => {
        const published = r.status === 'published'
        const soldOut = published && r.active_variants > 0 && r.avail === 0
        const display: DisplayStatus = r.status === 'archived' ? 'archived' : r.status === 'scheduled' ? 'scheduled'
          : published ? (soldOut ? 'sold_out' : 'live') : 'draft'
        const ref = r.snap?.media?.hero?.ref ?? r.snap?.media?.gallery?.[0]?.ref
        const thumb = ref?.kind === 'static' ? ref.src : ref?.kind === 'media' ? (assets[String(ref.assetId).toLowerCase()]?.url ?? null) : null
        return {
          id: r.id, productCode: r.product_code ?? null, name: r.snap?.name ?? '(untitled)', slug: r.snap?.slug || r.slug || '',
          type: r.product_type ?? r.snap?.productType ?? null, displayStatus: display, entityStatus: r.status, revision: r.revision,
          priceCents: r.price_cents > 0 ? Number(r.price_cents) : null, thumb,
          publishAt: r.publish_at ? new Date(r.publish_at).toISOString() : null,
          unpublishAt: r.unpublish_at ? new Date(r.unpublish_at).toISOString() : null,
          overdue: r.status === 'scheduled' && !!r.publish_at && new Date(r.publish_at).getTime() <= now,
          hasUnpublishedChanges: published && !!r.has_draft,
          blockerCount: r.bl ? (r.bl.blockers ?? []).length : null, warningCount: r.bl ? (r.bl.warnings ?? []).length : null,
          availableUnits: published || r.active_variants ? Number(r.avail) : null, activeVariants: r.active_variants,
          updatedAt: new Date(r.updated_at).toISOString(), publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
        }
      })
      if (f.status && f.status !== 'all') items = items.filter(i => i.displayStatus === f.status)
      const sort = f.sort ?? 'updated'
      if (sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name))
      else if (sort === 'price') items.sort((a, b) => (a.priceCents ?? -1) - (b.priceCents ?? -1))
      else if (sort === 'status') items.sort((a, b) => a.displayStatus.localeCompare(b.displayStatus) || a.name.localeCompare(b.name))
      return { items: items.slice(offset, offset + limit), total: items.length }
    },

    // ── editor state ───────────────────────────────────────────────────────────
    async getEditorState(id: string) {
      const e = await entity(id)
      const pid = e.entity_id as string
      const canonical = await loadCanonical(pid)
      if (!canonical) throw new CmsError('not_found', 'Product not found.')
      const hasDraft = !!e.draft_snapshot
      const base: ProductSnapshot | null = e.draft_snapshot ?? e.published_snapshot ?? e.last_snapshot ?? null
      if (!base) throw new CmsError('not_found', 'Product not found.')
      // With no open draft the working copy is the live version, with commerce read from the
      // canonical tables (a rollback restores content only, so the snapshot's commerce may lag).
      const working: ProductSnapshot = hasDraft ? base : { ...base, commerce: commerceFromCanonical(canonical) }
      const [bl, history, assets, collections, defaults] = await Promise.all([
        e.status === 'archived' ? Promise.resolve({ blockers: [], warnings: [] } as Blockers) : blockersFor(pid, working, 'publish'),
        cms.history('product', pid, 50),
        assetMap(snapshotAssetIds(working)),
        sql`SELECT c.id, c.slug, c.name FROM collection_products cp JOIN collections c ON c.id = cp.collection_id WHERE cp.product_id = ${pid}::uuid ORDER BY c.name` as Promise<any[]>,
        loadProductDefaults(sql),
      ])
      return {
        id: pid, productCode: canonical.productCode, status: e.status as string, revision: e.revision as number,
        slug: e.slug as string | null, publishAt: e.publish_at ?? null, unpublishAt: e.unpublish_at ?? null,
        publishedAt: e.published_at ?? null, draftVersionNo: e.draft_version_no ?? null, publishedVersionNo: e.published_version_no ?? null,
        hasDraft, snapshot: working, published: (e.published_snapshot ?? null) as ProductSnapshot | null,
        canonical, blockers: bl.blockers, warnings: bl.warnings, history, assets, collections,
        defaults: defaults.value as ProductDefaults,
      }
    },

    // ── create ─────────────────────────────────────────────────────────────────
    async create(a: { code: string; name: string; type: string; slug?: string; actor: string }): Promise<{ id: string; revision: number }> {
      const name = (a.name ?? '').trim()
      const slug = (a.slug ?? '').trim() || slugify(name)
      const type = (a.type ?? '').trim().toLowerCase()
      const snap = emptySnapshot({ name, slug, productType: type })
      const rows = await wrap(sql`
        SELECT catalog_create_product(${a.actor}, ${a.code}, ${name}, ${slug}, ${type || null}, ${JSON.stringify(snap)}::jsonb) AS r` as Promise<any[]>)
      const r = rows[0]?.r
      return { id: r.product_id, revision: r.revision }
    },

    // ── save draft ─────────────────────────────────────────────────────────────
    async saveDraft(id: string, raw: unknown, expectedRevision: number, actor: string, note?: string | null) {
      const parsed = parseSnapshotInput(raw)
      if (!parsed.ok) throw new ProductInputError(parsed.errors)
      const e = await entity(id)
      const snap = parsed.snapshot
      const res = await wrap(cms.saveDraft('product', e.entity_id, snap as any, expectedRevision, actor, note ?? null))
      let mediaUsageSynced = true
      try {
        await syncMediaUsages(sql, { ownerType: 'product', ownerId: e.entity_id, scope: 'draft', refs: snapshotMediaRefs(snap) })
        await auditDraftSave(e.entity_id, actor, res.version_no, res.revision)
      } catch { mediaUsageSynced = false }
      const bl = await blockersFor(e.entity_id, snap, 'publish').catch(() => ({ blockers: [], warnings: [] } as Blockers))
      return { ...res, blockers: bl.blockers, warnings: bl.warnings, mediaUsageSynced }
    },

    async validate(id: string): Promise<Blockers & { source: 'draft' | 'live' }> {
      const e = await entity(id)
      const snap = e.draft_snapshot ?? e.published_snapshot ?? e.last_snapshot
      const bl = await blockersFor(e.entity_id, snap, 'publish')
      return { ...bl, source: e.draft_snapshot ? 'draft' : 'live' }
    },

    // ── lifecycle ──────────────────────────────────────────────────────────────
    async publish(id: string, expectedRevision: number, actor: string): Promise<Mutation> {
      const e = await entity(id)
      const r: any = (await wrap(sql`SELECT publish_catalog_product(${e.entity_id}::uuid, ${expectedRevision}, ${actor}) AS r` as Promise<any[]>))[0]?.r
      const inv = await invalidateProduct(e.entity_id, r.slug ?? null, r.previous_slug ?? null, 'product publish', actor)
      return { result: r, cacheInvalidation: inv }
    },

    async schedule(id: string, publishAt: Date | null, unpublishAt: Date | null, expectedRevision: number, actor: string): Promise<Mutation> {
      const e = await entity(id)
      if (publishAt) {
        // Same blockers as an immediate publish: a scheduled go-live must already be valid.
        const bl = await blockersFor(e.entity_id, e.draft_snapshot ?? e.published_snapshot ?? e.last_snapshot, 'publish')
        if (bl.blockers.length) throw new ProductBlockedError(bl.blockers, bl.warnings)
      }
      const result = await wrap(cms.schedule('product', e.entity_id, publishAt, unpublishAt, expectedRevision, actor))
      // Scheduling alone changes nothing public; an unpublish_at on a live product is applied by the scheduler.
      return { result, cacheInvalidation: null }
    },

    async unpublish(id: string, expectedRevision: number, actor: string): Promise<Mutation> {
      const e = await entity(id)
      const result = await wrap(cms.unpublish('product', e.entity_id, expectedRevision, actor))
      return { result, cacheInvalidation: await invalidateProduct(e.entity_id, e.slug, null, 'product unpublish', actor) }
    },

    async archive(id: string, expectedRevision: number, actor: string): Promise<Mutation> {
      const e = await entity(id)
      const result = await wrap(cms.archive('product', e.entity_id, expectedRevision, actor))
      return { result, cacheInvalidation: await invalidateProduct(e.entity_id, e.slug, null, 'product archive', actor) }
    },

    async restore(id: string, expectedRevision: number, actor: string): Promise<Mutation> {
      const e = await entity(id)
      const result = await wrap(cms.restore('product', e.entity_id, expectedRevision, actor))
      return { result, cacheInvalidation: null }
    },

    async rollback(id: string, toVersionNo: number, expectedRevision: number, actor: string): Promise<Mutation> {
      const e = await entity(id)
      if (!Number.isInteger(toVersionNo) || toVersionNo < 1) throw new CmsError('invalid', 'Choose a version to restore.')
      const r: any = await wrap(cms.rollback('product', e.entity_id, toVersionNo, expectedRevision, actor, '/products'))
      return { result: r, cacheInvalidation: await invalidateProduct(e.entity_id, r.slug ?? null, r.previous_slug ?? null, 'product rollback', actor) }
    },

    // ── duplicate ──────────────────────────────────────────────────────────────
    /** New product identity + new slug + new SKUs; never copies stock, costs, reservations, orders or pairing. */
    async duplicate(id: string, actor: string): Promise<{ id: string; revision: number; code: string; slug: string }> {
      const e = await entity(id)
      const src: ProductSnapshot = e.draft_snapshot ?? e.published_snapshot ?? e.last_snapshot
      const canonical = await loadCanonical(e.entity_id)
      const srcCode = (canonical?.productCode ?? 'PRD').toUpperCase()

      const baseSlug = (src.slug || slugify(src.name) || 'product').slice(0, 70)
      let slug = `${baseSlug}-copy`
      for (let n = 2; n < 50; n++) {
        const taken = await sql`SELECT 1 FROM content_entities WHERE entity_type='product' AND lower(slug) = ${slug} UNION ALL
                                SELECT 1 FROM content_redirects WHERE from_path = ${'/products/' + slug}` as any[]
        if (!taken.length) break
        slug = `${baseSlug}-copy-${n}`
      }
      let code = ''
      const stem = srcCode.replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'PRD'
      for (let n = 2; n < 100; n++) {
        const cand = `${stem}${n}`.slice(0, 12)
        const taken = await sql`SELECT 1 FROM products WHERE lower(product_code) = ${cand.toLowerCase()}` as any[]
        if (!taken.length) { code = cand; break }
      }
      if (!code) throw new CmsError('invalid', 'Could not find a free product code. Create the product manually.')

      const copy = snapshotForDuplicate(src, { name: `${src.name} (Copy)`.slice(0, 120), slug })
      copy.commerce.variants = copy.commerce.variants.map(v => ({ ...v, sku: buildVariantSku(code, v.colorCode, v.size) }))
      const created = await wrap(sql`
        SELECT catalog_create_product(${actor}, ${code}, ${copy.name}, ${slug}, ${copy.productType || null}, ${JSON.stringify(copy)}::jsonb) AS r` as Promise<any[]>)
      const r = created[0].r
      try {
        await syncMediaUsages(sql, { ownerType: 'product', ownerId: r.product_id, scope: 'draft', refs: snapshotMediaRefs(copy) })
        await sql`INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
                  VALUES (${actor}, 'product.duplicate', 'product', ${r.product_id}, ${JSON.stringify({ source: e.entity_id })}::jsonb)`
      } catch { /* the product exists; usage sync is repaired on the next draft save */ }
      return { id: r.product_id, revision: r.revision, code, slug }
    },

    // ── collections (direct, unversioned) ──────────────────────────────────────
    async setCollections(id: string, collectionIds: string[], actor: string): Promise<Mutation<{ collections: string[] }>> {
      const e = await entity(id)
      const ids = [...new Set(collectionIds.filter(isUuid).map(x => x.toLowerCase()))]
      if (ids.length > 50) throw new CmsError('invalid', 'Too many collections.')
      const valid = ids.length ? (await sql`SELECT id::text FROM collections WHERE id = ANY(${ids}::uuid[]) AND archived_at IS NULL` as any[]).map(r => r.id) : []
      if (valid.length !== ids.length) throw new CmsError('invalid', 'One of the collections no longer exists.')
      const before = await collectionSlugs(e.entity_id)
      await sql`
        WITH del AS (DELETE FROM collection_products WHERE product_id = ${e.entity_id}::uuid AND NOT (collection_id = ANY(${ids}::uuid[])) RETURNING 1),
             ins AS (INSERT INTO collection_products (collection_id, product_id, position)
                     SELECT c, ${e.entity_id}::uuid, COALESCE((SELECT MAX(position) + 1 FROM collection_products WHERE collection_id = c), 0)
                       FROM UNNEST(${ids}::uuid[]) AS c
                     ON CONFLICT DO NOTHING RETURNING 1)
        INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
        VALUES (${actor}, 'product.collections', 'product', ${e.entity_id}, jsonb_build_object('collection_ids', ${JSON.stringify(ids)}::jsonb))`
      const after = await collectionSlugs(e.entity_id)
      const changed = [...new Set([...before, ...after])]
      let inv: InvalidationResult | null = null
      if (changed.length) {
        const targets = changed.map(s => collectionInvalidation(s))
        inv = await invalidate(sql, { paths: [...new Set(targets.flatMap(t => t.paths ?? []))], tags: [...new Set(targets.flatMap(t => t.tags ?? []))] }, { reason: 'product collections', actor })
      }
      return { result: { collections: after }, cacheInvalidation: inv }
    },

    // ── bulk ───────────────────────────────────────────────────────────────────
    /**
     * Safe bulk actions with a per-product result. Publish/unpublish need the strong confirmation
     * phrase (typed by the admin) and each product is validated individually; one failure never
     * stops or rolls back the others. No bulk price/inventory/cost writes exist.
     */
    async bulk(a: {
      action: 'archive' | 'restore' | 'publish' | 'unpublish' | 'add_collection' | 'remove_collection'
      items: Array<{ id: string; revision: number }>; actor: string; confirm?: string | null; collectionId?: string | null
    }) {
      const confirmNeeded = a.action === 'publish' ? 'PUBLISH' : a.action === 'unpublish' ? 'UNPUBLISH' : null
      if (confirmNeeded && (a.confirm ?? '').trim().toUpperCase() !== confirmNeeded) {
        throw new CmsError('invalid', `Type ${confirmNeeded} to confirm.`)
      }
      if (!a.items.length) throw new CmsError('invalid', 'Select at least one product.')
      if (a.items.length > 50) throw new CmsError('invalid', 'Select 50 products or fewer.')
      if ((a.action === 'add_collection' || a.action === 'remove_collection') && !isUuid(a.collectionId)) {
        throw new CmsError('invalid', 'Choose a collection.')
      }
      const results: Array<{ id: string; ok: boolean; error?: string; blockers?: Issue[]; cacheInvalidation?: InvalidationResult | null }> = []
      for (const it of a.items) {
        try {
          let m: Mutation | null = null
          if (a.action === 'archive') m = await this.archive(it.id, it.revision, a.actor)
          else if (a.action === 'restore') m = await this.restore(it.id, it.revision, a.actor)
          else if (a.action === 'publish') m = await this.publish(it.id, it.revision, a.actor)
          else if (a.action === 'unpublish') m = await this.unpublish(it.id, it.revision, a.actor)
          else {
            const e = await entity(it.id)
            const cur = (await sql`SELECT collection_id::text FROM collection_products WHERE product_id = ${e.entity_id}::uuid` as any[]).map(r => r.collection_id)
            const next = a.action === 'add_collection' ? [...new Set([...cur, a.collectionId!.toLowerCase()])] : cur.filter((c: string) => c !== a.collectionId!.toLowerCase())
            m = await this.setCollections(it.id, next, a.actor)
          }
          results.push({ id: it.id, ok: true, cacheInvalidation: m?.cacheInvalidation ?? null })
        } catch (e) {
          const err = toProductError(e)
          results.push({
            id: it.id, ok: false, error: err.message,
            ...(err instanceof ProductBlockedError ? { blockers: err.blockers } : {}),
          })
        }
      }
      const ok = results.filter(r => r.ok).length
      if (ok > 0) {
        await sql`INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
                  VALUES (${a.actor}, 'product.bulk', 'product', ${a.action},
                          ${JSON.stringify({ action: a.action, requested: a.items.length, succeeded: ok, failed: results.length - ok })}::jsonb)`.catch((err: any) => {
                    // Each successful product mutation has its own durable audit.
                    // The optional bulk summary must not erase success, but a lost
                    // summary must be observable rather than silently dropped.
                    console.error('[products/bulk] aggregate audit write failed:', err?.message?.slice(0, 120))
                  })
      }
      return { action: a.action, requested: results.length, succeeded: ok, failed: results.length - ok, results }
    },

    async history(id: string) {
      const e = await entity(id)
      return cms.history('product', e.entity_id, 100)
    },

    /** Pairing candidates, collections, and product types in use (editor pickers). */
    async options(excludeId?: string) {
      const [collections, pairs, types] = await Promise.all([
        sql`SELECT id, slug, name, is_active FROM collections WHERE archived_at IS NULL ORDER BY sort_order, name` as Promise<any[]>,
        sql`SELECT p.id, p.product_code, p.product_type, COALESCE(v.snapshot->>'name', p.name) AS name, e.status
              FROM content_entities e JOIN products p ON p.id::text = e.entity_id
              LEFT JOIN content_versions v ON v.entity_type = e.entity_type AND v.entity_id = e.entity_id
                    AND v.version_no = COALESCE(e.published_version_no, e.draft_version_no)
             WHERE e.entity_type = 'product' AND e.status <> 'archived'
               AND (${excludeId ?? null}::text IS NULL OR e.entity_id <> ${excludeId ?? null}::text)
             ORDER BY name` as Promise<any[]>,
        sql`SELECT DISTINCT product_type FROM products WHERE product_type IS NOT NULL ORDER BY 1` as Promise<any[]>,
      ])
      return { collections, pairs, types: types.map(t => t.product_type) }
    },
  }
}

export type ProductService = ReturnType<typeof createProductService>
