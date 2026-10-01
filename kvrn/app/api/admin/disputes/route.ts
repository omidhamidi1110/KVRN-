// GET /api/admin/disputes — dispute list with authoritative fee/cash totals
//
// Fees and cash come from dispute_balance_transactions (Stripe verbatim), never
// inferred from status.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createDisputesService } from '@/lib/disputes'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const disputes = await createDisputesService(sql).listDisputes()
    const totals = {
      count:          disputes.length,
      openCount:      disputes.filter(d => d.status === 'open' || d.status === 'under_review').length,
      lostCount:      disputes.filter(d => d.status === 'lost').length,
      wonCount:       disputes.filter(d => d.status === 'won').length,
      // Terminal, favourable, and never revenue-reducing — reported apart from
      // an ordinary contested win.
      preventedCount: disputes.filter(d => d.status === 'prevented').length,
      disputedCents:  disputes.reduce((s, d) => s + d.amountCents, 0),
      // Only lost disputes reduce revenue, and only net of refunds already issued.
      revenueImpactCents: disputes.reduce((s, d) => s + d.netRevenueImpactCents, 0),
      feesCents:      disputes.reduce((s, d) => s + d.disputeFeesCents, 0),
    }
    return NextResponse.json({ disputes, totals })
  } catch (err: any) {
    console.error('[admin/disputes GET]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load disputes.' }, { status: 500 })
  }
}
