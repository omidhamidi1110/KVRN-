// GET /api/admin/orders/[id]/fraud — the Fraud / Risk panel data for one order.
//
// Read-only. Risk comes from what Stripe/Radar actually reported; absent data is returned as null and the
// Admin shows "Unknown" (never zero, never "safe"). No card number, IP address, e-mail or street address is
// ever in this payload.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createFraudReviewService } from '@/lib/fraud-review'
import { UUID_RE } from '@/lib/admin-orders'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, context: Context) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const { id } = await context.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid order ID.' }, { status: 400 })
  try {
    const view = await createFraudReviewService(sql).getView(id)
    if (!view) return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
    return NextResponse.json({ success: true, data: view })
  } catch (err: any) {
    console.error('[admin/orders/id/fraud GET]', String(err?.message ?? '').slice(0, 120))
    return NextResponse.json({ error: 'Failed to load fraud review.' }, { status: 500 })
  }
}
