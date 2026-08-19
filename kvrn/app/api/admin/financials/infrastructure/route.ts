// GET /api/admin/financials/infrastructure
//
// Provider-by-provider cost view keeping THREE STATES SEPARATE:
//   actualPaidCents        — cash-out fact, from expense_transactions
//   estimatedAccruedCents  — forecast, from the latest usage snapshot
//   projectedMonthEndCents — forecast, from the latest usage snapshot
//
// These are never merged into a single "expense" number.
//
// ACTUAL PAID here is cash out in the window. It differs by design from the P&L's
// RECOGNIZED operating expense, which apportions a transaction over its service
// period. A provider may show $40 paid while the month recognises ~$3.33.
//
// All obligations and all usage metrics for a provider are returned — a provider
// with two subscriptions or two billable metrics has both represented.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createExpenseService } from '@/lib/expenses'
import { resolveRangePreset, parseCustomRange, type RangePreset, type DateRange } from '@/lib/financials'

export const dynamic = 'force-dynamic'
const PRESETS: RangePreset[] = ['today', '7d', '30d', 'mtd', 'ytd']

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error

  const p = req.nextUrl.searchParams
  let range: DateRange | null
  if (p.get('start') && p.get('end')) {
    range = parseCustomRange(p.get('start'), p.get('end'))
    if (!range) return NextResponse.json({ error: 'Invalid custom range.' }, { status: 400 })
  } else {
    const raw = p.get('range') ?? 'mtd'
    range = resolveRangePreset(PRESETS.includes(raw as RangePreset) ? (raw as RangePreset) : 'mtd')
  }

  const startDate = range.start.slice(0, 10)
  const endDate   = new Date(Date.parse(range.end) - 1).toISOString().slice(0, 10)

  try {
    const providers = await createExpenseService(sql).getInfrastructureCosts(startDate, endDate)

    // Totals are reported per state and never summed across states.
    //
    // actualPaidCents is CASH OUT inside the window. It intentionally differs from
    // the P&L's recognized operating expense, which apportions a transaction across
    // its service period (a $40 annual renewal = $40 paid here, ~$3.33 recognized
    // into a month). Both are correct measures of different things.
    const totals = {
      actualPaidCents: providers.reduce(
        (s, p2) => s + (p2.actualPaidCents ?? 0), 0),
      estimatedAccruedCents: providers.reduce(
        (s, p2) => s + (p2.estimatedAccruedCents ?? 0), 0),
      projectedMonthEndCents: providers.reduce(
        (s, p2) => s + (p2.projectedMonthEndCents ?? 0), 0),
      expectedMonthlyEquivalentCents: providers.reduce(
        (s, p2) => s + (p2.expectedMonthlyEquivalentCents ?? 0), 0),
      providersWithoutActuals: providers.filter(p2 => p2.actualPaidCents === null).length,
      providerCount: providers.length,
      definitionCount:  providers.reduce((s, p2) => s + p2.definitions.length, 0),
      usageMetricCount: providers.reduce((s, p2) => s + p2.usageMetrics.length, 0),
    }

    return NextResponse.json({ range, providers, totals })
  } catch (err: any) {
    console.error('[admin/financials/infrastructure]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load infrastructure costs.' }, { status: 500 })
  }
}
