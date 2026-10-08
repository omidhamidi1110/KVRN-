import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const [features, runs] = await Promise.all([
      sql`
        SELECT f.id, f.name, f.area, f.criticality, f.enabled, f.production_safe,
               f.last_passed_at, f.last_failed_at,
               COUNT(tc.id) FILTER (WHERE tc.enabled)::int AS test_count
        FROM qa_features f LEFT JOIN qa_test_cases tc ON tc.feature_id=f.id
        GROUP BY f.id ORDER BY
          CASE f.criticality WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
          f.area, f.name
      `,
      sql`
        SELECT id, trigger_type, environment, commit_sha, status, total_count, passed_count,
               failed_count, skipped_count, started_at, completed_at
        FROM qa_test_runs ORDER BY started_at DESC LIMIT 25
      `,
    ])
    return NextResponse.json({ features, runs })
  } catch { return NextResponse.json({ error: 'Failed to load QA status.' }, { status: 500 }) }
}
