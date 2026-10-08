// POST /api/admin/orders/[id]/fraud/release { confirm: true, note?: string }
//
// Releases the KVRN fulfillment-review hold. Explicit (confirm:true required), audited (admin_audit_logs +
// order_fraud_events), allowed regardless of the RADAR_FULFILLMENT_HOLDS flag.
// It does NOT touch the payment, the Stripe Review, inventory or any financial record: Stripe is not changed.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createFraudReviewService, FraudReviewError, validateNote } from '@/lib/fraud-review'
import { UUID_RE } from '@/lib/admin-orders'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, context: Context) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const actor = identity?.email
  if (!actor) return NextResponse.json({ error: 'Admin identity unavailable.' }, { status: 401 })
  const { id } = await context.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid order ID.' }, { status: 400 })

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }
  const extra = Object.keys(body ?? {}).filter(k => !['confirm', 'note'].includes(k))
  if (extra.length > 0) return NextResponse.json({ error: `Unsupported fields: ${extra.join(', ')}.` }, { status: 400 })
  if (body?.confirm !== true) {
    return NextResponse.json({ error: 'Confirmation is required to release the hold.' }, { status: 400 })
  }
  const note = validateNote(body?.note)
  if (!note.ok) return NextResponse.json({ error: note.error }, { status: 400 })

  try {
    const svc = createFraudReviewService(sql)
    const outcome = await svc.releaseHold(id, actor, note.note)
    if (outcome === 'not_held') {
      return NextResponse.json({ error: 'This order has no active hold.', code: 'NOT_HELD' }, { status: 409 })
    }
    return NextResponse.json({ success: true, outcome, stripeChanged: false, data: await svc.getView(id) })
  } catch (err: any) {
    if (err instanceof FraudReviewError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error('[admin/orders/id/fraud/release]', String(err?.message ?? '').slice(0, 120))
    return NextResponse.json({ error: 'Failed to release the hold.' }, { status: 500 })
  }
}
