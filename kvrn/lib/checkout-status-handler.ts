// lib/checkout-status-handler.ts
// Injectable factory for GET /api/checkout/status.
// Imported by the route and by tests — never duplicated.

import { type NextRequest, NextResponse } from 'next/server'
import { isValidCheckoutSessionId } from './checkout-status'

const NO_STORE = { 'Cache-Control': 'no-store' }

export interface StatusRouteDeps {
  query: (sessionId: string) => Promise<Array<{
    reservation_status: string
    order_number:       string | null
    payment_status:     string | null
  }>>
}

export function createStatusGetHandler(deps: StatusRouteDeps) {
  return async function GET(req: NextRequest): Promise<NextResponse> {
    const sessionId = req.nextUrl.searchParams.get('session_id') ?? ''

    // Missing → 400
    if (!sessionId) {
      return NextResponse.json(
        { error: 'session_id is required.' },
        { status: 400, headers: NO_STORE }
      )
    }

    // Invalid format → 400 (validates full value, never truncates)
    if (!isValidCheckoutSessionId(sessionId)) {
      return NextResponse.json(
        { error: 'Invalid session_id.' },
        { status: 400, headers: NO_STORE }
      )
    }

    let rows: Awaited<ReturnType<StatusRouteDeps['query']>>
    try {
      rows = await deps.query(sessionId)
    } catch {
      // DB failure → generic 500; never expose internal error details
      return NextResponse.json(
        { error: 'Status temporarily unavailable.' },
        { status: 500, headers: NO_STORE }
      )
    }

    // Unknown session → 404
    if (rows.length === 0) {
      return NextResponse.json(
        { status: 'not_found' },
        { status: 404, headers: NO_STORE }
      )
    }

    const row = rows[0]
    // Return only the three public fields — no PII, UUIDs, PaymentIntent IDs, or Stripe calls
    return NextResponse.json({
      reservationStatus: row.reservation_status,
      orderNumber:       row.order_number    ?? null,
      paymentStatus:     row.payment_status  ?? null,
    }, { headers: NO_STORE })
  }
}
