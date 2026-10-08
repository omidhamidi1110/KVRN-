// Cron: applies due scheduled publish/unpublish and retries failed cache invalidations.
// Returns only counts. Authenticated with CRON_SECRET (see lib/internal-cron-auth.ts).
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { createCms } from '@/lib/cms-core'
import { requireCronSecret } from '@/lib/internal-cron-auth'
import { invalidateAfterCommit, retryPendingInvalidations, productInvalidation, collectionInvalidation, CMS_TAGS } from '@/lib/cache-invalidation'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req)
  if (denied) return denied

  let applied = 0, failed = 0
  try {
    const results = await createCms(sql).applyDue()
    for (const r of results) {
      if (!r.ok) { failed++; continue }
      applied++
      // Precise invalidation per entity type; the slug is looked up after commit.
      const rows = await sql`SELECT slug FROM content_entities WHERE entity_type=${r.entity_type} AND entity_id=${r.entity_id}` as any[]
      const slug: string | undefined = rows[0]?.slug ?? undefined
      const target =
        r.entity_type === 'product' && slug ? productInvalidation(slug) :
        r.entity_type === 'collection' && slug ? collectionInvalidation(slug) :
        { paths: slug ? [`/${slug}`] : ['/'], tags: [CMS_TAGS.pages, CMS_TAGS.policies, CMS_TAGS.sitemap] }
      await invalidateAfterCommit(sql, target, { reason: `scheduled ${r.action} ${r.entity_type}`, actor: 'system@kvrn.internal' })
    }
  } catch {
    return NextResponse.json({ error: 'Scheduler failed.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
  const retry = await retryPendingInvalidations(sql).catch(() => ({ attempted: 0, done: 0, failed: 0 }))
  return NextResponse.json({ applied, failed, invalidationRetry: retry }, { headers: { 'Cache-Control': 'no-store' } })
}
