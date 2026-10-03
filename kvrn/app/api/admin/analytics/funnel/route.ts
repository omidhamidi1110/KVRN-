// GET /api/admin/analytics/funnel?range=7d|30d|90d (default 30d)
// Admin-only (Cloudflare Access + requireAdmin). Aggregates only; raw event rows are never returned.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createFunnelService, parseFunnelRange, funnelWindow } from '@/lib/funnel-analytics'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error

  const range = parseFunnelRange(req.nextUrl.searchParams.get('range'))
  if (!range) return NextResponse.json({ error: 'range must be 7d, 30d or 90d.' }, { status: 400 })

  try {
    const report = await createFunnelService(sql).getFunnelReport(funnelWindow(range))
    return NextResponse.json({ range, ...report }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err: any) {
    console.error('[admin/analytics/funnel]', String(err?.message ?? err).slice(0, 120))
    return NextResponse.json({ error: 'Could not load funnel analytics.' }, { status: 500 })
  }
}
