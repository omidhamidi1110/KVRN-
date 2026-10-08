// lib/cache-invalidation.ts — explicit, post-commit, visible storefront cache invalidation.
//
// RULES (from the batch spec)
//   * Call ONLY AFTER the authoritative database change has committed. Every Neon call in
//     KVRN is its own transaction, so "after the await returned" is "after commit".
//   * A failed invalidation is RECORDED (cache_invalidations.status='failed') and returned
//     to the caller so Admin can show it and offer a retry. The site is never silently
//     claimed current.
//   * Precise: paths + tags for exactly what changed. No full-site purge helper exists.
//   * Slug changes / rollback / unpublish must pass BOTH old and new paths (see helpers).
//
// HOW THE STOREFRONT IS ACTUALLY CACHED (honest note)
//   open-next.config.ts runs with incrementalCache/tagCache = 'dummy', so Next's data cache
//   is not shared between Worker isolates and ISR does not persist. CMS-backed public pages
//   are therefore rendered per request (`dynamic = 'force-dynamic'`), which is already
//   current after commit. revalidatePath/revalidateTag are still issued so that enabling a
//   real OpenNext incremental cache later requires no code change, and so the invalidation
//   log is the single place that proves what was invalidated and when.

import type { NeonQueryFunction } from '@neondatabase/serverless'

export type SqlLike = NeonQueryFunction<false, false> | any

export interface InvalidationTarget {
  /** Concrete public paths, e.g. '/products/kvrn-phantom-hoodie'. */
  paths?: string[]
  /** Cache tags, e.g. 'cms:products'. */
  tags?: string[]
}

export interface InvalidationDeps {
  revalidatePath: (path: string, type?: 'page' | 'layout') => void
  revalidateTag: (tag: string) => void
}

export interface InvalidationResult {
  id: string | null
  ok: boolean
  /** Short, safe, human-readable. Never contains stack traces or secrets. */
  error?: string
  paths: string[]
  tags: string[]
}

const MAX_ITEMS = 100
const MAX_PATH = 300
const MAX_TAG = 128
const PATH_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/
const TAG_RE = /^[A-Za-z0-9:_\-./]+$/

/** Normalises + de-duplicates. Rejects anything that is not a plain same-origin path. */
export function normalizePaths(paths: readonly string[] | undefined): string[] {
  const out = new Set<string>()
  for (const raw of paths ?? []) {
    if (typeof raw !== 'string') continue
    const p = raw.trim()
    if (!p || p.length > MAX_PATH) continue
    if (p.startsWith('//') || p.includes('\\') || p.includes('..')) continue
    if (!PATH_RE.test(p)) continue
    // Strip trailing slash (except root) so '/a' and '/a/' are one entry.
    out.add(p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)
    if (out.size >= MAX_ITEMS) break
  }
  return [...out]
}

export function normalizeTags(tags: readonly string[] | undefined): string[] {
  const out = new Set<string>()
  for (const raw of tags ?? []) {
    if (typeof raw !== 'string') continue
    const t = raw.trim()
    if (!t || t.length > MAX_TAG || !TAG_RE.test(t)) continue
    out.add(t)
    if (out.size >= MAX_ITEMS) break
  }
  return [...out]
}

async function defaultDeps(): Promise<InvalidationDeps> {
  const m = await import('next/cache')
  return { revalidatePath: m.revalidatePath as any, revalidateTag: m.revalidateTag as any }
}

function safeMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/\s+/g, ' ').slice(0, 200)
}

function runTargets(
  deps: InvalidationDeps, paths: string[], tags: string[],
): { ok: boolean; error?: string } {
  const errors: string[] = []
  for (const p of paths) {
    try { deps.revalidatePath(p) } catch (e) { errors.push(`path ${p}: ${safeMsg(e)}`) }
  }
  for (const t of tags) {
    try { deps.revalidateTag(t) } catch (e) { errors.push(`tag ${t}: ${safeMsg(e)}`) }
  }
  return errors.length ? { ok: false, error: errors.join('; ').slice(0, 500) } : { ok: true }
}

/**
 * Record + perform an invalidation. Never throws: failure is returned (and recorded).
 * Call after the committed mutation, and surface `ok:false` to the Admin user.
 */
export async function invalidateAfterCommit(
  sql: SqlLike,
  target: InvalidationTarget,
  ctx: { reason: string; actor?: string | null },
  deps?: InvalidationDeps,
): Promise<InvalidationResult> {
  const paths = normalizePaths(target.paths)
  const tags  = normalizeTags(target.tags)
  if (paths.length === 0 && tags.length === 0) {
    return { id: null, ok: true, paths, tags }
  }

  let id: string | null = null
  try {
    const rows = await sql`
      INSERT INTO cache_invalidations (reason, paths, tags, status, attempts, requested_by)
      VALUES (${ctx.reason.slice(0, 200)}, ${paths}, ${tags}, 'pending', 0, ${ctx.actor ?? null})
      RETURNING id
    `
    id = (rows as any[])[0]?.id ?? null
  } catch (e) {
    // Could not even log it: report failure — never claim the site is current.
    return { id: null, ok: false, error: `log write failed: ${safeMsg(e)}`, paths, tags }
  }

  let res: { ok: boolean; error?: string }
  try {
    res = runTargets(deps ?? await defaultDeps(), paths, tags)
  } catch (e) {
    res = { ok: false, error: safeMsg(e) }
  }

  try {
    if (res.ok) {
      await sql`UPDATE cache_invalidations
                   SET status = 'done', attempts = attempts + 1, completed_at = NOW(), last_error = NULL
                 WHERE id = ${id}`
    } else {
      await sql`UPDATE cache_invalidations
                   SET status = 'failed', attempts = attempts + 1, last_error = ${res.error ?? 'unknown'}
                 WHERE id = ${id}`
    }
  } catch { /* the in-memory result below is still returned to the caller */ }

  return { id, ok: res.ok, error: res.error, paths, tags }
}

/** Re-run pending/failed invalidations (Admin "retry" and the cron wrapper). Bounded. */
export async function retryPendingInvalidations(
  sql: SqlLike, opts: { limit?: number; maxAttempts?: number } = {}, deps?: InvalidationDeps,
): Promise<{ attempted: number; done: number; failed: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  const maxAttempts = opts.maxAttempts ?? 10
  const rows = await sql`
    SELECT id, paths, tags FROM cache_invalidations
     WHERE status <> 'done' AND attempts < ${maxAttempts}
     ORDER BY created_at LIMIT ${limit}
  ` as Array<{ id: string; paths: string[]; tags: string[] }>
  let done = 0, failed = 0
  let d: InvalidationDeps | undefined = deps
  for (const r of rows) {
    let res: { ok: boolean; error?: string }
    try {
      d = d ?? await defaultDeps()
      res = runTargets(d, normalizePaths(r.paths), normalizeTags(r.tags))
    } catch (e) { res = { ok: false, error: safeMsg(e) } }
    if (res.ok) {
      done++
      await sql`UPDATE cache_invalidations SET status='done', attempts=attempts+1,
                       completed_at=NOW(), last_error=NULL WHERE id=${r.id}`
    } else {
      failed++
      await sql`UPDATE cache_invalidations SET status='failed', attempts=attempts+1,
                       last_error=${res.error ?? 'unknown'} WHERE id=${r.id}`
    }
  }
  return { attempted: rows.length, done, failed }
}

// ── Target builders: the ONE place that knows which paths a change touches ─────

/** Tags for each content family. Pages that render CMS content should use these. */
export const CMS_TAGS = {
  products:     'cms:products',
  product:      (slug: string) => `cms:product:${slug}`,
  collections:  'cms:collections',
  collection:   (slug: string) => `cms:collection:${slug}`,
  policies:     'cms:policies',
  policy:       (slug: string) => `cms:policy:${slug}`,
  sizeGuides:   'cms:size-guides',
  faq:          'cms:faq',
  pages:        'cms:pages',
  page:         (slug: string) => `cms:page:${slug}`,
  nav:          'cms:nav',
  footer:       'cms:footer',
  announcement: 'cms:announcement',
  seo:          'cms:seo',
  media:        'cms:media',
  sitemap:      'cms:sitemap',
} as const

/** A product change: old AND new slug paths, the shop, the homepage products block and the sitemap. */
export function productInvalidation(slug: string, previousSlug?: string | null): InvalidationTarget {
  const slugs = [slug, previousSlug].filter((s): s is string => !!s)
  return {
    paths: [
      ...slugs.map(s => `/products/${s}`),
      '/shop', '/', '/sitemap.xml',
    ],
    tags: [CMS_TAGS.products, CMS_TAGS.sitemap, ...slugs.map(CMS_TAGS.product)],
  }
}

export function collectionInvalidation(slug: string, previousSlug?: string | null): InvalidationTarget {
  const slugs = [slug, previousSlug].filter((s): s is string => !!s)
  return {
    paths: [...slugs.map(s => `/collections/${s}`), '/shop', '/', '/sitemap.xml'],
    tags: [CMS_TAGS.collections, CMS_TAGS.sitemap, ...slugs.map(CMS_TAGS.collection)],
  }
}

/** Global shell content (navigation / footer / announcement) is rendered by the root layout. */
export function globalShellInvalidation(kind: 'nav' | 'footer' | 'announcement'): InvalidationTarget {
  return { paths: ['/'], tags: [CMS_TAGS[kind]] }
}

export function pathsInvalidation(paths: string[], tags: string[] = []): InvalidationTarget {
  return { paths, tags }
}
