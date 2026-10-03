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
import { canonicalOrderContribution } from '@/lib/financial-presentation'

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

    const [report, adByPlatform, cashMovement] = await Promise.all([
      financials.getPeriodReport(range),
      expenses.getAdSpendByPlatform(range.start.slice(0, 10), range.end.slice(0, 10)),
      financials.getRecordedCashMovement(range),
    ])

    return NextResponse.json({
      range,
      period: report.period,
      // Reconciliation state RELEVANT to this period. Exact profit is only ever exact when
      // integrity.state === 'RECONCILED'; the UI must show Unknown / Invalid otherwise.
      integrity: {
        state: report.integrity.state,
        exceptionCount: report.integrity.exceptionCount,
        incompleteCount: report.integrity.incompleteCount,
        orderCohortCount: report.integrity.orderCohortCount,
        byCode: report.integrity.byCode,
        scope: report.integrity.scope,
        checkedAt: report.integrity.checkedAt,
      },
      // Recorded cash movement is NOT profit and is returned as its own object so no
      // consumer can add it to a profit figure by accident.
      cashMovement,
      adSpendByPlatform: adByPlatform,
      // Only a compact list; the orders page owns the full listing.
      recentOrders: report.orders.slice(0, 25).map(o => {
        // The scan's per-order state wins over the calculator: an EXCEPTION order can have every
        // input numeric and still be invalid. Same rule as /api/admin/financials/orders/[id].
        const integrityState = o.integrityState ?? 'RECONCILED'
        const canonical = canonicalOrderContribution({
          integrityState,
          contributionProfitCents: o.economics.contributionProfitCents,
          contributionMarginPct:   o.economics.contributionMarginPct,
        })
        return {
          orderId:       o.orderId,
          orderNumber:   o.orderNumber,
          paidAt:        o.paidAt,
          paymentStatus: o.paymentStatus,
          netRevenueCents:         o.economics.netRevenueCents,
          // AUTHORITATIVE: null = Unknown (INCOMPLETE / unknown input) or Invalid (EXCEPTION). Never $0.
          contributionProfitCents: canonical.contributionProfitCents,
          contributionMarginPct:   canonical.contributionMarginPct,
          // RAW calculator figure: known-so-far diagnostics, NOT authoritative.
          knownSoFarContributionProfitCents: o.economics.contributionProfitCents,
          reconciliation:          o.economics.reconciliation,
          // RECONCILED / INCOMPLETE / EXCEPTION for this order (its refunds, disputes, COGS, ...)
          integrityState,
        }
      }),
    })
  } catch (err: any) {
    console.error('[admin/financials/summary]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load financial summary.' }, { status: 500 })
  }
}
