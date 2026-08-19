// GET /api/admin/financials/orders/[id] — full economics for one order.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createFinancialService } from '@/lib/financials'
import { listRefundsForOrder } from '@/lib/refunds'

export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAdmin(req)
  if (error) return error

  const { id } = await params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid order id.' }, { status: 400 })
  }

  try {
    const row = await createFinancialService(sql).getOrderEconomics(id)
    if (!row) return NextResponse.json({ error: 'Order not found.' }, { status: 404 })

    const [items, shipments, refunds] = await Promise.all([
      sql`
        SELECT sku, product_name AS "productName", size, color, quantity,
               unit_price_cents AS "unitPriceCents", line_total_cents AS "lineTotalCents",
               unit_cogs_cents  AS "unitCogsCents",  line_cogs_cents  AS "lineCogsCents"
        FROM order_items WHERE order_id = ${id}::uuid ORDER BY sku
      `,
      sql`
        SELECT carrier, tracking_number AS "trackingNumber", service_level AS "serviceLevel",
               label_cost_cents AS "labelCostCents", cost_source AS "costSource",
               shipped_at AS "shippedAt"
        FROM shipments WHERE order_id = ${id}::uuid
      `,
      listRefundsForOrder(sql, id),
    ])

    return NextResponse.json({
      order:     row,
      items:     (items as any[]).map(i => ({
        ...i,
        unitPriceCents: Number(i.unitPriceCents),
        lineTotalCents: Number(i.lineTotalCents),
        unitCogsCents:  i.unitCogsCents === null ? null : Number(i.unitCogsCents),
        lineCogsCents:  i.lineCogsCents === null ? null : Number(i.lineCogsCents),
      })),
      shipments: (shipments as any[]).map(s => ({
        ...s,
        labelCostCents: s.labelCostCents === null ? null : Number(s.labelCostCents),
      })),
      refunds,
    })
  } catch (err: any) {
    console.error('[admin/financials/orders/:id]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load order economics.' }, { status: 500 })
  }
}
