import { NextRequest, NextResponse } from 'next/server'

// ─── GET /api/orders/[id] ──────────────────────────────────────────────────────
// Next 15: params must be awaited as a Promise
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params

  try {
    // TODO: Connect Neon DB
    // import { db } from '@/lib/db'
    // const [order] = await db.query('SELECT * FROM orders WHERE id = $1', [id])
    // if (!order) return NextResponse.json({ success: false, error: 'Order not found.' }, { status: 404 })
    // return NextResponse.json({ success: true, data: order })

    return NextResponse.json({
      success: true,
      data: {
        id,
        status:        'unfulfilled',
        customerEmail: 'james@example.com',
        customerName:  'James Taylor',
        totalPence:    42000,
        lineItems:     [{ name: 'KVRN Heavyweight Hoodie', color: 'Stone', size: 'L', quantity: 1, price: 23000 }],
        createdAt:     new Date().toISOString(),
        message:       'Connect Neon DB to return real order data.',
      },
    })
  } catch (err) {
    console.error('[orders/id] GET error:', err)
    return NextResponse.json({ success: false, error: 'Failed to fetch order.' }, { status: 500 })
  }
}

// ─── PATCH /api/orders/[id] ────────────────────────────────────────────────────
// Next 15: params must be awaited as a Promise
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params

  try {
    const body = await req.json()
    const allowedFields = ['status', 'tracking_number', 'carrier', 'fulfilled_at', 'shipped_at']

    const updates = Object.fromEntries(
      Object.entries(body).filter(([key]) => allowedFields.includes(key))
    )

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ success: false, error: 'No valid fields to update.' }, { status: 400 })
    }

    // TODO: Connect Neon DB
    // import { db } from '@/lib/db'
    // const setClauses = Object.keys(updates).map((key, i) => `${key} = $${i + 2}`)
    // const query = `UPDATE orders SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`
    // const [updated] = await db.query(query, [id, ...Object.values(updates)])
    //
    // if (updates.status === 'shipped' && updates.tracking_number) {
    //   // Send shipping confirmation email
    // }
    //
    // return NextResponse.json({ success: true, data: updated })

    console.log(`[orders/id] PATCH ${id}:`, updates)
    return NextResponse.json({
      success: true,
      data: { id, ...updates, message: 'Connect Neon DB to persist.' },
    })
  } catch (err) {
    console.error('[orders/id] PATCH error:', err)
    return NextResponse.json({ success: false, error: 'Failed to update order.' }, { status: 500 })
  }
}
