// app/api/checkout/status/route.ts
// Read-only. Works even when ENABLE_STRIPE_TEST_CHECKOUT=false.
// No PII, no Stripe calls, no internal UUIDs in response.

import { createStatusGetHandler } from '@/lib/checkout-status-handler'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

export const GET = createStatusGetHandler({
  query: async (sessionId) => {
    const rows = await sql`
      SELECT
        r.status       AS reservation_status,
        o.order_number,
        o.payment_status
      FROM reservations r
      LEFT JOIN orders o ON o.reservation_id = r.id
      WHERE r.stripe_checkout_session_id = ${sessionId}
      LIMIT 1
    `
    return rows as Array<{
      reservation_status: string
      order_number:       string | null
      payment_status:     string | null
    }>
  },
})
