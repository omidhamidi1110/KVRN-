// POST /api/admin/refunds/[id]/fee-returned
//
// Record how much of the original Stripe processing fee Stripe returned for a refund.
//
// Until this is recorded the value is UNKNOWN (NULL) — never zero — and every order it
// touches stays INCOMPLETE (REFUND_FEE_RETURN_UNKNOWN), so exact profit is unavailable.
// The fact is WRITE-ONCE: re-sending the same amount is a no-op; a different amount is
// refused (409). The database also refuses a cumulative return larger than the order's
// Stripe fee (REFUND_FEE_EXCEEDS_ORDER_FEE is surfaced instead of being absorbed).
//
// Body: { feeRefundedCents: <integer >= 0> }
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid refund id.' }, { status: 400 })

  let body: any = {}
  try { body = await req.json() } catch { body = {} }
  const fee = body?.feeRefundedCents
  if (typeof fee !== 'number' || !Number.isInteger(fee) || fee < 0 || fee > 2_000_000_000) {
    return NextResponse.json(
      { error: 'feeRefundedCents must be a whole number of cents, zero or more.' }, { status: 400 })
  }

  try {
    const rows = (await sql`
      SELECT record_refund_fee_returned(${id}::uuid, ${fee}::int, ${identity!.email}) AS result
    `) as any[]
    return NextResponse.json({ ok: true, result: rows[0]?.result ?? null })
  } catch (err: any) {
    const msg = String(err?.message ?? '')
    if (msg.includes('NOT_FOUND')) return NextResponse.json({ error: 'Refund not found.' }, { status: 404 })
    if (msg.includes('NOT_SUCCEEDED')) {
      return NextResponse.json({ error: 'Only a succeeded refund has a fee to record.' }, { status: 409 })
    }
    if (msg.includes('FEE_ALREADY_RECORDED')) {
      return NextResponse.json(
        { error: 'A different fee amount is already recorded for this refund and cannot be changed.' }, { status: 409 })
    }
    if (msg.includes('FEE_EXCEEDS_ORDER_FEE')) {
      return NextResponse.json(
        { error: 'Total fee returned would exceed the order’s Stripe fee.' }, { status: 409 })
    }
    console.error('[admin/refunds/fee-returned]', msg.slice(0, 120))
    return NextResponse.json({ error: 'Could not record the refund fee.' }, { status: 500 })
  }
}
