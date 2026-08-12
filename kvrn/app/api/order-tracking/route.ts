import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isValidEmail } from '@/lib/us-states'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const ORDER_NUMBER_RE = /^KVRN-[A-Z0-9-]{1,32}$/i

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: NO_STORE,
  })
}

export async function POST(req: NextRequest) {
  let body: unknown

  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid request.' }, 400)
  }

  if (!body || typeof body !== 'object') {
    return json({ error: 'Invalid request.' }, 400)
  }

  const raw = body as Record<string, unknown>

  const orderNumber =
    typeof raw.orderNumber === 'string'
      ? raw.orderNumber.trim().replace(/^#/, '').toUpperCase()
      : ''

  const email =
    typeof raw.email === 'string'
      ? raw.email.trim().toLowerCase()
      : ''

  if (!ORDER_NUMBER_RE.test(orderNumber) || !isValidEmail(email)) {
    return json({ error: 'Order not found.' }, 404)
  }

  try {
    const orders = await sql`
      SELECT
        o.id,
        o.order_number        AS "orderNumber",
        o.fulfillment_status  AS "status",
        o.created_at          AS "createdAt",
        s.carrier,
        s.tracking_number     AS "trackingNumber"
      FROM orders o
      LEFT JOIN shipments s ON s.order_id = o.id
      WHERE UPPER(o.order_number) = ${orderNumber}
        AND LOWER(o.customer_email) = ${email}
      LIMIT 1
    `

    if (orders.length === 0) {
      return json({ error: 'Order not found.' }, 404)
    }

    const order = orders[0] as {
      id: string
      orderNumber: string
      status: string
      createdAt: string
      carrier: string | null
      trackingNumber: string | null
    }

    const items = await sql`
      SELECT
        product_name AS name,
        color,
        size
      FROM order_items
      WHERE order_id = ${order.id}
      ORDER BY created_at
    `

    return json({
      success: true,
      data: {
        orderNumber:     order.orderNumber,
        status:          order.status,
        trackingNumber:  order.trackingNumber,
        carrier:         order.carrier,
        createdAt:       order.createdAt,
        lineItems:       items,
      },
    })
  } catch {
    return json({ error: 'Order lookup temporarily unavailable.' }, 500)
  }
}
