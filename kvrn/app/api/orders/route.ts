import { NextRequest, NextResponse } from 'next/server'

// ─── GET /api/orders ───────────────────────────────────────────────────────────
// Returns all orders for the admin dashboard.
// Protected by middleware — only accessible with admin cookie.
export async function GET(req: NextRequest) {
  const url    = new URL(req.url)
  const status = url.searchParams.get('status')   // filter by status
  const limit  = parseInt(url.searchParams.get('limit') ?? '50')
  const offset = parseInt(url.searchParams.get('offset') ?? '0')

  try {
    // TODO: Connect Neon DB
    // import { db } from '@/lib/db'
    //
    // let query = `
    //   SELECT
    //     o.id, o.stripe_payment_intent, o.customer_email, o.customer_name,
    //     o.shipping_address, o.line_items, o.shipping_method,
    //     o.subtotal_pence, o.shipping_cost_pence, o.tax_pence, o.total_pence,
    //     o.status, o.tracking_number, o.carrier,
    //     o.created_at, o.fulfilled_at, o.shipped_at, o.delivered_at
    //   FROM orders o
    // `
    // const params: unknown[] = []
    //
    // if (status) {
    //   query += ` WHERE o.status = $${params.length + 1}`
    //   params.push(status)
    // }
    //
    // query += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    // params.push(limit, offset)
    //
    // const orders = await db.query(query, params)
    // return NextResponse.json({ success: true, data: orders })

    // ─── MVP: Return mock orders ───────────────────────────────────────────
    const mockOrders = [
      {
        id:              'ord_001',
        customerEmail:   'james@example.com',
        customerName:    'James Taylor',
        totalPence:      42000,
        status:          'unfulfilled',
        lineItems:       [{ name: 'KVRN Heavyweight Hoodie', color: 'Stone', size: 'L', quantity: 1, price: 23000 }],
        shippingAddress: { firstName: 'James', lastName: 'Taylor', address1: '14 Station Road', city: 'London', postcode: 'E1 6PF', country: 'GB' },
        createdAt:       new Date().toISOString(),
      },
    ]

    return NextResponse.json({
      success: true,
      data:    mockOrders,
      meta:    { total: mockOrders.length, limit, offset },
    })
  } catch (err) {
    console.error('[orders] GET error:', err)
    return NextResponse.json({ success: false, error: 'Failed to fetch orders.' }, { status: 500 })
  }
}
