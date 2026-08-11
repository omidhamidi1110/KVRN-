import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import {
  createAdminOrderService,
  VALID_PAYMENT_STATUSES,
  VALID_FULFILLMENT_STATUSES,
} from '@/lib/admin-orders'

export const dynamic = 'force-dynamic'

const MAX_LIMIT     = 100
const DEFAULT_LIMIT = 50

export async function GET(req: NextRequest) {
  // Auth before any DB access
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  const p = req.nextUrl.searchParams

  // Validate limit
  const limitRaw = p.get('limit')
  const limit    = limitRaw === null ? DEFAULT_LIMIT : parseInt(limitRaw, 10)
  if (!Number.isInteger(limit) || limit < 1 || isNaN(limit)) {
    return NextResponse.json({ error: 'Invalid limit.' }, { status: 400 })
  }
  const clampedLimit = Math.min(limit, MAX_LIMIT)

  // Validate offset
  const offsetRaw = p.get('offset')
  const offset    = offsetRaw === null ? 0 : parseInt(offsetRaw, 10)
  if (!Number.isInteger(offset) || offset < 0 || isNaN(offset)) {
    return NextResponse.json({ error: 'Invalid offset.' }, { status: 400 })
  }

  // Validate statuses
  const paymentStatus     = p.get('paymentStatus')     ?? undefined
  const fulfillmentStatus = p.get('fulfillmentStatus') ?? undefined
  if (paymentStatus && !(VALID_PAYMENT_STATUSES as readonly string[]).includes(paymentStatus)) {
    return NextResponse.json({ error: `Invalid paymentStatus.` }, { status: 400 })
  }
  if (fulfillmentStatus && !(VALID_FULFILLMENT_STATUSES as readonly string[]).includes(fulfillmentStatus)) {
    return NextResponse.json({ error: `Invalid fulfillmentStatus.` }, { status: 400 })
  }

  const search = p.get('search')?.trim().slice(0, 200) || undefined

  try {
    const svc    = createAdminOrderService(sql)
    const params = { paymentStatus, fulfillmentStatus, search, limit: clampedLimit, offset }
    const [data, total] = await Promise.all([
      svc.listOrders(params),
      svc.countOrders({ paymentStatus, fulfillmentStatus, search }),
    ])

    return NextResponse.json({
      success: true,
      data,
      meta: { total, limit: clampedLimit, offset },
    })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch orders.' }, { status: 500 })
  }
}
