// GET  /api/admin/inventory/write-offs
// POST /api/admin/inventory/write-offs
//
// The client supplies a variant, a quantity and a reason — never a cost. Cost is
// derived server-side by the canonical FIFO function, so a client-computed value
// can never become authoritative.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

const REASONS = ['damaged','defective','lost','sample','giveaway',
                 'influencer','photography','promotional','other']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const rows = await sql`
      SELECT w.id, w.quantity, w.reason, w.notes,
             w.total_cost_cents      AS "totalCostCents",
             w.known_cost_quantity   AS "knownCostQuantity",
             w.unknown_cost_quantity AS "unknownCostQuantity",
             w.created_at AS "createdAt", w.created_by AS "createdBy",
             pv.sku, p.name AS "productName"
      FROM inventory_write_offs w
      JOIN product_variants pv ON pv.id = w.variant_id
      JOIN products p ON p.id = pv.product_id
      ORDER BY w.created_at DESC LIMIT 200
    `
    const items = (rows as any[]).map(r => ({
      ...r,
      quantity: Number(r.quantity),
      totalCostCents: r.totalCostCents === null ? null : Number(r.totalCostCents),
      knownCostQuantity: Number(r.knownCostQuantity),
      unknownCostQuantity: Number(r.unknownCostQuantity),
      createdAt: new Date(r.createdAt).toISOString(),
      // Promotional use is a marketing cost, not a loss.
      isPromotional: ['sample','giveaway','influencer','photography','promotional']
        .includes(r.reason),
    }))
    return NextResponse.json({ writeOffs: items })
  } catch (err: any) {
    console.error('[admin/inventory/write-offs GET]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load write-offs.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  if (!body.variantId || !UUID_RE.test(body.variantId)) {
    return NextResponse.json({ error: 'A valid variant is required.' }, { status: 400 })
  }
  const quantity = Number(body.quantity)
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return NextResponse.json({ error: 'Quantity must be a positive whole number.' }, { status: 400 })
  }
  if (!REASONS.includes(body.reason)) {
    return NextResponse.json({ error: 'A valid reason is required.' }, { status: 400 })
  }

  try {
    // Cost is computed by the canonical FIFO function, never accepted from the client.
    const rows = await sql`SELECT record_inventory_write_off(
      ${body.variantId}::uuid, ${quantity}, ${body.reason},
      ${body.notes ?? null}, ${identity!.email}
    ) AS result`
    const result = (rows as any[])[0]?.result

    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${identity!.email}, 'create', 'inventory_write_off',
              ${result?.write_off_id ?? null},
              ${JSON.stringify({ variantId: body.variantId, quantity,
                                 reason: body.reason, fifo: result?.fifo })}::jsonb)
    `
    return NextResponse.json({ result }, { status: 201 })
  } catch (err: any) {
    const msg = String(err?.message ?? '')
    if (msg.includes('BELOW_RESERVED')) {
      return NextResponse.json(
        { error: 'Cannot write off below reserved quantity.' }, { status: 400 })
    }
    if (msg.includes('VARIANT_NOT_FOUND')) {
      return NextResponse.json({ error: 'Variant not found.' }, { status: 404 })
    }
    console.error('[admin/inventory/write-offs POST]', msg.slice(0, 120))
    return NextResponse.json({ error: 'Could not record write-off.' }, { status: 500 })
  }
}
