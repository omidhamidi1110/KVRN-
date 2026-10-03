// POST /api/admin/financials/exchanges/[id]/shipping-cost
// Record the carrier cost of a REPLACEMENT shipment. This is KVRN's expense, not
// anything the customer paid. Write-once in SQL: re-sending the same value is a
// no-op, a different value is refused (history is not rewritten).
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
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid exchange id.' }, { status: 400 })

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  const cents = Number(body?.costCents)
  if (!Number.isInteger(cents) || cents < 0 || cents > 100_000_00) {
    return NextResponse.json(
      { error: 'Cost must be a non-negative whole number of cents under $100,000.' }, { status: 400 })
  }

  try {
    const rows = await sql`
      SELECT record_exchange_replacement_shipping_cost(${id}::uuid, ${cents}::integer, ${identity!.email}) AS r`
    return NextResponse.json({ ok: true, result: (rows as any[])[0]?.r })
  } catch (err: any) {
    const m = String(err?.message ?? '')
    if (m.includes('KVRN_EXCHANGE|NOT_FOUND'))
      return NextResponse.json({ error: 'Exchange not found.' }, { status: 404 })
    if (m.includes('KVRN_EXCHANGE|NOT_SHIPPED'))
      return NextResponse.json({ error: 'The replacement has not shipped yet.' }, { status: 409 })
    if (m.includes('KVRN_EXCHANGE|COST_ALREADY_RECORDED'))
      return NextResponse.json({ error: 'A different cost is already recorded; it cannot be overwritten.' }, { status: 409 })
    console.error('[admin/financials/exchanges/shipping-cost]', m.slice(0, 120))
    return NextResponse.json({ error: 'Could not record replacement shipping cost.' }, { status: 500 })
  }
}
