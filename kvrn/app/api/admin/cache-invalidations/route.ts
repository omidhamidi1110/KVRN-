// Admin visibility + retry for post-commit cache invalidations.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { retryPendingInvalidations } from '@/lib/cache-invalidation'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const rows = await sql`
      SELECT id, reason, paths, tags, status, attempts, last_error, requested_by, created_at, completed_at
        FROM cache_invalidations ORDER BY created_at DESC LIMIT 50`
    const open = (await sql`SELECT COUNT(*)::int AS n FROM cache_invalidations WHERE status <> 'done'`)[0]?.n ?? 0
    return NextResponse.json({ success: true, data: rows, meta: { open } }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'Failed to load invalidations.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  try {
    const result = await retryPendingInvalidations(sql, { limit: 50, maxAttempts: 50 })
    await sql`INSERT INTO admin_audit_logs (actor_email, action, resource, payload)
              VALUES (${identity.email}, 'cache.retry', 'cache_invalidations', ${JSON.stringify(result)}::jsonb)`
    return NextResponse.json({ success: true, data: result })
  } catch {
    return NextResponse.json({ error: 'Retry failed.' }, { status: 500 })
  }
}
