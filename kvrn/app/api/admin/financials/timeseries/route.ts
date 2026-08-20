// GET /api/admin/financials/timeseries
//
// Time series behind the Financial Overview chart, plus cost composition for the
// breakdown view. Server-authoritative: every figure comes from the same
// financial calculator the summary cards use, so the two can never disagree.
//
// Query: range | start+end, and optional granularity=day|week|month
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import {
  createFinancialService, resolveRangePreset, parseCustomRange,
  type RangePreset, type DateRange,
} from '@/lib/financials'
import type { Granularity } from '@/lib/chart-math'

export const dynamic = 'force-dynamic'

const PRESETS: RangePreset[] = ['today', '7d', '30d', '90d', 'mtd', 'ytd', '1y', 'all']
const GRANULARITIES: Granularity[] = ['day', 'week', 'month']

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error

  const p = req.nextUrl.searchParams
  let range: DateRange | null
  if (p.get('start') && p.get('end')) {
    range = parseCustomRange(p.get('start'), p.get('end'))
    if (!range) return NextResponse.json({ error: 'Invalid custom range.' }, { status: 400 })
  } else {
    const raw = p.get('range') ?? '30d'
    range = resolveRangePreset(PRESETS.includes(raw as RangePreset) ? (raw as RangePreset) : '30d')
  }

  const rawG = p.get('granularity')
  const granularity = GRANULARITIES.includes(rawG as Granularity)
    ? (rawG as Granularity)
    : undefined   // let the service auto-pick a readable bucket size

  try {
    const service = createFinancialService(sql)
    const [series, composition] = await Promise.all([
      service.getFinancialTimeSeries(range, granularity),
      service.getCostComposition(range),
    ])
    return NextResponse.json({ range, ...series, composition })
  } catch (err: any) {
    console.error('[admin/financials/timeseries]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load financial series.' }, { status: 500 })
  }
}
