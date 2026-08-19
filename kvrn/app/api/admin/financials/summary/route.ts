// GET /api/admin/financials/summary
// Period P&L using the shared calculator. Admin-only via Cloudflare Access.
//
// Query params:
//   range = today | 7d | 30d | mtd | ytd   (default 30d)
//   start, end = YYYY-MM-DD                (custom range; overrides `range`)
//
// All periods are half-open [start, end) in UTC. Revenue is recognised on paid_at.

import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import {
  createFinancialService,
  resolveRangePreset,
  parseCustomRange,
  type RangePreset,
  type DateRange,
} from '@/lib/financials'
import { createExpenseService } from '@/lib/expenses'

export const dynamic = 'force-dynamic'

const PRESETS: RangePreset[] = ['today', '7d', '30d', 'mtd', 'ytd']

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error

  const params = req.nextUrl.searchParams
  const startRaw = params.get('start')
  const endRaw   = params.get('end')
  const rangeRaw = params.get('range') ?? '30d'

  let range: DateRange | null = null
  if (startRaw && endRaw) {
    range = parseCustomRange(startRaw, endRaw)
    if (!range) {
      return NextResponse.json(
        { error: 'Invalid custom range. Use YYYY-MM-DD, end after start, max 2 years.' },
        { status: 400 }
      )
    }
  } else {
    const preset = PRESETS.includes(rangeRaw as RangePreset) ? (rangeRaw as RangePreset) : '30d'
    range = resolveRangePreset(preset)
  }

  try {
    const financials = createFinancialService(sql)
    const expenses   = createExpenseService(sql)

    const [report, adByPlatform] = await Promise.all([
      financials.getPeriodReport(range),
      expenses.getAdSpendByPlatform(range.start.slice(0, 10), range.end.slice(0, 10)),
    ])

    return NextResponse.json({
      range,
      period: report.period,
      adSpendByPlatform: adByPlatform,
      // Only a compact list; the orders page owns the full listing.
      recentOrders: report.orders.slice(0, 25).map(o => ({
        orderId:       o.orderId,
        orderNumber:   o.orderNumber,
        paidAt:        o.paidAt,
        paymentStatus: o.paymentStatus,
        netRevenueCents:         o.economics.netRevenueCents,
        contributionProfitCents: o.economics.contributionProfitCents,
        contributionMarginPct:   o.economics.contributionMarginPct,
        reconciliation:          o.economics.reconciliation,
      })),
    })
  } catch (err: any) {
    console.error('[admin/financials/summary]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load financial summary.' }, { status: 500 })
  }
}
