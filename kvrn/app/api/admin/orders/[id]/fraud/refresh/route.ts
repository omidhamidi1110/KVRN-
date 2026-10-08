// POST /api/admin/orders/[id]/fraud/refresh
//
// Re-reads the payment's risk / review state from Stripe (a GET only — nothing in Stripe is created,
// approved, closed or changed) and applies it. Safe when Stripe is unavailable: the order keeps its current
// state, the failure is recorded, and the owner is told plainly. Works regardless of the feature flag; a hold
// is only created if RADAR_FULFILLMENT_HOLDS is on.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { getStripe } from '@/lib/stripe-client'
import { createFraudReviewService } from '@/lib/fraud-review'
import { UUID_RE } from '@/lib/admin-orders'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }

const STATUS: Record<string, number> = {
  ORDER_NOT_FOUND: 404, NO_PAYMENT_INTENT: 409, STRIPE_NOT_CONFIGURED: 503, STRIPE_UNAVAILABLE: 502,
  NO_CHARGE_DATA: 409, CHARGE_NOT_SUCCEEDED: 409,
}

export async function POST(req: NextRequest, context: Context) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const actor = identity?.email
  if (!actor) return NextResponse.json({ error: 'Admin identity unavailable.' }, { status: 401 })
  const { id } = await context.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid order ID.' }, { status: 400 })

  try {
    const svc = createFraudReviewService(sql)
    const result = await svc.refreshFromStripe(id, actor, getStripe)
    if (!result.ok) {
      return NextResponse.json({ error: result.message ?? 'Could not refresh from Stripe.', code: result.code },
                               { status: STATUS[result.code ?? ''] ?? 502 })
    }
    return NextResponse.json({ success: true, stripeChanged: false, hold: result.hold, data: await svc.getView(id) })
  } catch (err: any) {
    console.error('[admin/orders/id/fraud/refresh]', String(err?.message ?? '').slice(0, 120))
    return NextResponse.json({ error: 'Failed to refresh from Stripe.' }, { status: 500 })
  }
}
