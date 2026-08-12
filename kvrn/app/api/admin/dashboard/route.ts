import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createAdminOrderService } from '@/lib/admin-orders'
import { getAllVariantsForAdmin } from '@/lib/inventory'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error

  try {
    const ordersService = createAdminOrderService(sql)

    const [
      totalOrders,
      unfulfilledOrders,
      recentOrders,
      variants,
      revenueRows,
    ] = await Promise.all([
      ordersService.countOrders({}),
      ordersService.countOrders({ fulfillmentStatus: 'unfulfilled' }),
      ordersService.listOrders({
        limit: 5,
        offset: 0,
      }),
      getAllVariantsForAdmin(),
      sql`
        SELECT COALESCE(SUM(total_cents), 0) AS revenue_cents
        FROM orders
        WHERE payment_status = 'paid'
          AND paid_at >= date_trunc('month', NOW())
      `,
    ])

    const revenueCents = Number((revenueRows[0] as any)?.revenue_cents ?? 0)

    const activeVariants = (variants as any[]).filter(v => v.active)
    const availableUnits = activeVariants.reduce(
      (sum, v) => sum + Math.max(0, Number(v.available_quantity ?? 0)),
      0
    )

    const soldOutVariants = activeVariants.filter(
      v => Number(v.available_quantity ?? 0) <= 0
    ).length

    return NextResponse.json({
      stats: {
        revenueCents,
        totalOrders,
        unfulfilledOrders,
        availableUnits,
        soldOutVariants,
      },
      recentOrders,
      inventory: variants,
    })
  } catch {
    return NextResponse.json(
      { error: 'Failed to load dashboard.' },
      { status: 500 }
    )
  }
}
