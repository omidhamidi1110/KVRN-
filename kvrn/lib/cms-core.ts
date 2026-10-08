// lib/cms-core.ts — thin typed wrapper over the atomic SQL lifecycle in migration 027.
//
// Every operation is ONE SQL function call, so on Neon HTTP it is one transaction: the
// head row, the version rows, the redirect row and the audit row commit together or not
// at all. Callers invalidate caches AFTER the call returns (lib/cache-invalidation.ts).
//
// Stale-edit protection: every mutating call takes the `revision` the editor loaded. If
// someone else saved/published since, the call throws CmsError('stale') — never a silent
// overwrite. The editor UI shows "this was changed by someone else — reload".

export type CmsErrorCode =
  | 'invalid' | 'stale' | 'not_found' | 'no_draft' | 'archived' | 'slug_taken' | 'bad_schedule' | 'unknown'

export class CmsError extends Error {
  constructor(public readonly code: CmsErrorCode, message: string, public readonly detail?: string) {
    super(message)
    this.name = 'CmsError'
  }
  /** HTTP status a route should return. */
  get status(): number {
    switch (this.code) {
      case 'not_found': return 404
      case 'stale': case 'slug_taken': case 'archived': return 409
      case 'unknown': return 500
      default: return 400
    }
  }
}

const CODE_MAP: Array<[string, CmsErrorCode, string]> = [
  ['CMS_STALE_REVISION', 'stale', 'This item was changed by someone else. Reload and try again.'],
  ['CMS_NOT_FOUND', 'not_found', 'Item not found.'],
  ['CMS_NO_DRAFT', 'no_draft', 'There is no draft to publish.'],
  ['CMS_ARCHIVED', 'archived', 'This item is archived. Restore it first.'],
  ['CMS_SLUG_TAKEN', 'slug_taken', 'That URL is already in use.'],
  ['CMS_BAD_SCHEDULE', 'bad_schedule', 'The schedule is not valid.'],
  ['CMS_INVALID', 'invalid', 'The request is not valid.'],
]

/** Map a database error from a cms_* function to a typed CmsError. */
export function toCmsError(e: unknown): CmsError {
  const msg = String((e as any)?.message ?? e ?? '')
  for (const [token, code, human] of CODE_MAP) {
    const i = msg.indexOf(token)
    if (i >= 0) {
      const detail = msg.slice(i).split('\n')[0].slice(0, 200)
      return new CmsError(code, human, detail)
    }
  }
  return new CmsError('unknown', 'Unexpected error.')
}

type Sql = any

async function call<T>(p: Promise<any[]>): Promise<T> {
  try {
    const rows = await p
    return rows[0]?.r as T
  } catch (e) { throw toCmsError(e) }
}

export interface DraftResult { version_no: number; revision: number; created: boolean }
export interface LiveResult { version_no: number; slug: string | null; previous_slug: string | null; redirect_created: boolean; revision: number }

export function createCms(sql: Sql) {
  return {
    /** Create the entity (expectedRevision 0) or autosave its open draft. */
    saveDraft: (type: string, id: string, snapshot: Record<string, unknown>, expectedRevision: number,
                actor: string, note?: string | null) =>
      call<DraftResult>(sql`SELECT cms_save_draft(${type}, ${id}, ${JSON.stringify(snapshot)}::jsonb,
                                                 ${expectedRevision}, ${actor}, ${note ?? null}) AS r`),

    /** Atomically make the draft live. Pass pathPrefix (e.g. '/products') for slug-change redirects. */
    publish: (type: string, id: string, expectedRevision: number, actor: string, pathPrefix?: string | null) =>
      call<LiveResult>(sql`SELECT cms_publish(${type}, ${id}, ${expectedRevision}, ${actor}, ${pathPrefix ?? null}) AS r`),

    /** Roll back by publishing a NEW version that carries an older snapshot. */
    rollback: (type: string, id: string, toVersionNo: number, expectedRevision: number, actor: string,
               pathPrefix?: string | null) =>
      call<LiveResult>(sql`SELECT cms_rollback(${type}, ${id}, ${toVersionNo}, ${expectedRevision}, ${actor},
                                              ${pathPrefix ?? null}) AS r`),

    unpublish: (type: string, id: string, expectedRevision: number, actor: string) =>
      call<{ revision: number }>(sql`SELECT cms_unpublish(${type}, ${id}, ${expectedRevision}, ${actor}) AS r`),

    schedule: (type: string, id: string, publishAt: Date | null, unpublishAt: Date | null,
               expectedRevision: number, actor: string) =>
      call<{ revision: number }>(sql`SELECT cms_set_schedule(${type}, ${id},
                                      ${publishAt ? publishAt.toISOString() : null}::timestamptz,
                                      ${unpublishAt ? unpublishAt.toISOString() : null}::timestamptz,
                                      ${expectedRevision}, ${actor}) AS r`),

    archive: (type: string, id: string, expectedRevision: number, actor: string) =>
      call<{ revision: number }>(sql`SELECT cms_archive(${type}, ${id}, ${expectedRevision}, ${actor}) AS r`),

    restore: (type: string, id: string, expectedRevision: number, actor: string) =>
      call<{ revision: number }>(sql`SELECT cms_restore(${type}, ${id}, ${expectedRevision}, ${actor}) AS r`),

    /** Cron entry point: apply due scheduled publishes/unpublishes. */
    applyDue: () =>
      call<Array<{ entity_type: string; entity_id: string; action: string; ok: boolean; error?: string }>>(
        sql`SELECT cms_apply_due() AS r`),

    /** Head row + draft/published snapshots, for the editor and for preview. */
    async get(type: string, id: string) {
      const rows = await sql`
        SELECT e.*, d.snapshot AS draft_snapshot, p.snapshot AS published_snapshot
          FROM content_entities e
          LEFT JOIN content_versions d ON d.entity_type=e.entity_type AND d.entity_id=e.entity_id AND d.version_no=e.draft_version_no
          LEFT JOIN content_versions p ON p.entity_type=e.entity_type AND p.entity_id=e.entity_id AND p.version_no=e.published_version_no
         WHERE e.entity_type=${type} AND e.entity_id=${id}` as any[]
      return rows[0] ?? null
    },

    async history(type: string, id: string, limit = 50) {
      return await sql`
        SELECT version_no, state, change_note, rolled_back_from, created_by, created_at, published_by, published_at
          FROM content_versions WHERE entity_type=${type} AND entity_id=${id}
         ORDER BY version_no DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}` as any[]
    },

    async getVersion(type: string, id: string, versionNo: number) {
      const rows = await sql`
        SELECT * FROM content_versions WHERE entity_type=${type} AND entity_id=${id} AND version_no=${versionNo}` as any[]
      return rows[0] ?? null
    },

    /** Live snapshot by slug — the storefront read path. Only status='published' is ever returned. */
    async getPublishedBySlug(type: string, slug: string) {
      const rows = await sql`
        SELECT e.entity_id, e.slug, e.published_at, v.snapshot
          FROM content_entities e
          JOIN content_versions v ON v.entity_type=e.entity_type AND v.entity_id=e.entity_id
                                 AND v.version_no=e.published_version_no
         WHERE e.entity_type=${type} AND lower(e.slug)=lower(${slug}) AND e.status='published'` as any[]
      return rows[0] ?? null
    },
  }
}

export type Cms = ReturnType<typeof createCms>
