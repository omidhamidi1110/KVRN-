// GET  /api/admin/returns — list returns + refunds awaiting component breakdown
// POST /api/admin/returns — create a return
//
// A return NEVER reduces revenue. It records what physically came back.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createReturnsService, validateCreateReturn } from '@/lib/returns'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const service = createReturnsService(sql)
    const [returns, awaitingBreakdown, awaitingFee] = await Promise.all([
      service.listReturns(),
      service.listRefundsAwaitingBreakdown(),
      service.listRefundsAwaitingFeeReturn(),
    ])
    return NextResponse.json({ returns, awaitingBreakdown, awaitingFee })
  } catch (err: any) {
    console.error('[admin/returns GET]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load returns.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const input = {
    orderId: body.orderId,
    items: Array.isArray(body.items) ? body.items.map((i: any) => ({
      orderItemId: i.orderItemId,
      quantity:    Number(i.quantity),
      disposition: i.disposition ?? 'sellable',
      notes:       i.notes ?? null,
    })) : [],
    returnShippingPaidBy: body.returnShippingPaidBy ?? 'not_applicable',
    reason: body.reason ?? null,
    notes:  body.notes ?? null,
  }

  const v = validateCreateReturn(input as any)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  try {
    const result = await createReturnsService(sql).createReturn(input as any, identity!.email)
    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${identity!.email}, 'create', 'order_return', ${result?.return_id ?? null},
              ${JSON.stringify({ orderId: input.orderId, itemCount: input.items.length,
                                 returnNumber: result?.return_number })}::jsonb)
    `
    return NextResponse.json({ result }, { status: 201 })
  } catch (err: any) {
    const msg = String(err?.message ?? '')
    // Surface the guard reason without leaking internals.
    if (msg.includes('QUANTITY_EXCEEDS_ORDERED')) {
      return NextResponse.json(
        { error: 'Return quantity exceeds the quantity ordered on that line.' },
        { status: 400 })
    }
    console.error('[admin/returns POST]', msg.slice(0, 120))
    return NextResponse.json({ error: 'Could not create return.' }, { status: 500 })
  }
}
