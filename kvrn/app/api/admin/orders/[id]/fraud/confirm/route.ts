// POST /api/admin/orders/[id]/fraud/confirm { confirm: true, note?: string }
//
// Records that the owner has CONFIRMED this payment as fraud (audited) and keeps the order unshippable (it
// creates/keeps the fulfillment hold when holds are enabled). It does NOT refund, cancel, restock or change
// Stripe: the money side stays in the EXISTING flow — refund in Stripe (the webhook records it), then use
// "Cancel unshipped order & restore inventory" on the order, which has its own eligibility checks.
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
    return NextResponse.json({ error: 'Confirmation is required to mark this order as fraud.' }, { status: 400 })
  }
  const note = validateNote(body?.note)
  if (!note.ok) return NextResponse.json({ error: note.error }, { status: 400 })

  try {
    const svc = createFraudReviewService(sql)
    const result = await svc.markConfirmedFraud(id, actor, note.note)
    return NextResponse.json({ success: true, outcome: result.outcome, hold: result.hold, stripeChanged: false, data: await svc.getView(id) })
  } catch (err: any) {
    if (err instanceof FraudReviewError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error('[admin/orders/id/fraud/confirm]', String(err?.message ?? '').slice(0, 120))
    return NextResponse.json({ error: 'Failed to record confirmed fraud.' }, { status: 500 })
  }
}
