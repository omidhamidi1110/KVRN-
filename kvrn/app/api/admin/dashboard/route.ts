import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createAdminOrderService } from '@/lib/admin-orders'
import { getAllVariantsForAdmin } from '@/lib/inventory'
import { createFinancialService, resolveRangePreset } from '@/lib/financials'

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
      mtdOrders,
    ] = await Promise.all([
      ordersService.countOrders({}),
      ordersService.countOrders({ fulfillmentStatus: 'unfulfilled' }),
      ordersService.listOrders({
        limit: 5,
        offset: 0,
      }),
      getAllVariantsForAdmin(),
      // CANONICAL revenue: the same cohort the Financials summary uses (orders paid
      // this UTC month, tax excluded, refunds and lost disputes subtracted). The
      // previous SUM(total_cents) counted shipping, ignored partial refunds and
      // dropped fully refunded orders, so it contradicted the P&L.
      createFinancialService(sql).getOrderEconomicsInRange(resolveRangePreset('mtd')),
    ])

    const revenueCents = mtdOrders.reduce((s, o) => s + o.economics.netRevenueCents, 0)

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
