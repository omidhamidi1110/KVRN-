// PATCH /api/admin/shipments/[id]/cost — record the ACTUAL carrier label cost.
//
// KVRN does not yet purchase labels through Shippo programmatically, so this is the
// manual reconciliation path. When label purchasing is implemented, the same columns
// are populated automatically with cost_source='shippo_label'.
//
// This value is KVRN'S COST. It is never confused with orders.shipping_cents, which
// is what the customer paid.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SOURCES = ['shippo_label', 'shippo_quote', 'manual']

export async function PATCH(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid shipment id.' }, { status: 400 })

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const cents = Number(body.labelCostCents)
  if (!Number.isInteger(cents) || cents < 0 || cents > 100_000_00) {
    return NextResponse.json(
      { error: 'Label cost must be a non-negative whole number of cents under $100,000.' },
      { status: 400 }
    )
  }
  const source = SOURCES.includes(body.costSource) ? body.costSource : 'manual'

  try {
    const rows = await sql`
      UPDATE shipments
      SET label_cost_cents      = ${cents},
          cost_source           = ${source},
          service_level         = COALESCE(${body.serviceLevel ?? null}, service_level),
          shippo_transaction_id = COALESCE(${body.shippoTransactionId ?? null}, shippo_transaction_id),
          label_purchased_at    = COALESCE(label_purchased_at, NOW())
      WHERE id = ${id}::uuid
      RETURNING id, order_id AS "orderId"
    `
    const updated = (rows as any[])[0]
    if (!updated) return NextResponse.json({ error: 'Shipment not found.' }, { status: 404 })

    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${identity!.email}, 'update', 'shipment_cost', ${id},
              ${JSON.stringify({ labelCostCents: cents, costSource: source })}::jsonb)
    `
    return NextResponse.json({ ok: true, orderId: updated.orderId })
  } catch (err: any) {
    console.error('[admin/shipments/cost]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not record shipment cost.' }, { status: 500 })
  }
}
