// GET /api/admin/financials/shipping
// Shipping economics: revenue vs actual carrier cost, subsidy, free-shipping cost.
//
// The two sides come from different tables on purpose:
//   revenue = orders.shipping_cents        (what the customer paid KVRN)
//   cost    = shipments.label_cost_cents   (what KVRN paid the carrier)

import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import {
  createFinancialService, resolveRangePreset, parseCustomRange,
  type RangePreset, type DateRange,
} from '@/lib/financials'

export const dynamic = 'force-dynamic'
const PRESETS: RangePreset[] = ['today', '7d', '30d', 'mtd', 'ytd']

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error

  const p = req.nextUrl.searchParams
  let range: DateRange | null
  if (p.get('start') && p.get('end')) {
    range = parseCustomRange(p.get('start'), p.get('end'))
    if (!range) return NextResponse.json({ error: 'Invalid custom range.' }, { status: 400 })
  } else {
    const raw = p.get('range') ?? '30d'
    range = resolveRangePreset(PRESETS.includes(raw as RangePreset) ? (raw as RangePreset) : '30d')
  }

  try {
    const service = createFinancialService(sql)
    const rows = await service.getOrderEconomicsInRange(range)

    const withCost = rows.filter(r => r.economics.shippingCostCents !== null)

    return NextResponse.json({
      range,
      totals: {
        orders:                   rows.length,
        ordersWithKnownCost:      withCost.length,
        ordersMissingCost:        rows.length - withCost.length,
        shippingRevenueCents:     rows.reduce((s, r) => s + r.economics.shippingRevenueCents, 0),
        shippingDiscountCents:    rows.reduce((s, r) => s + r.economics.shippingDiscountTotalCents, 0),
        shippingCostCents:        withCost.reduce((s, r) => s + (r.economics.shippingCostCents ?? 0), 0),
        shippingMarginCents:      withCost.reduce((s, r) => s + (r.economics.shippingMarginCents ?? 0), 0),
        shippingSubsidyCents:     withCost.reduce((s, r) => s + (r.economics.shippingSubsidyCents ?? 0), 0),
        freeShippingOrders:       rows.filter(r => r.economics.isAutoFreeShipping).length,
        freeShippingCostCents:    rows
          .filter(r => r.economics.isAutoFreeShipping)
          .reduce((s, r) => s + (r.economics.freeShippingCostCents ?? 0), 0),
        ordersUnderwater: withCost.filter(r => (r.economics.shippingMarginCents ?? 0) < 0).length,
        ordersProfitable: withCost.filter(r => (r.economics.shippingMarginCents ?? 0) > 0).length,
      },
      orders: rows.map(r => ({
        orderId:              r.orderId,
        orderNumber:          r.orderNumber,
        paidAt:               r.paidAt,
        shippingRevenueCents: r.economics.shippingRevenueCents,
        shippingCostCents:    r.economics.shippingCostCents,
        shippingMarginCents:  r.economics.shippingMarginCents,
        isAutoFreeShipping:   r.economics.isAutoFreeShipping,
        shippingDiscountTotalCents: r.economics.shippingDiscountTotalCents,
      })),
    })
  } catch (err: any) {
    console.error('[admin/financials/shipping]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load shipping economics.' }, { status: 500 })
  }
}
