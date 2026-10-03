// GET /api/admin/payment-exceptions?status=open|resolved|all
//
// Payments Stripe took that KVRN could not safely turn into an order (migration 022).
// Open rows need a human: refund the customer in Stripe, then resolve the row.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createPaymentExceptionService, type PaymentExceptionFilter } from '@/lib/payment-exceptions'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error

  const raw = req.nextUrl.searchParams.get('status') ?? 'open'
  if (!['open', 'resolved', 'all'].includes(raw)) {
    return NextResponse.json({ error: 'status must be open, resolved or all.' }, { status: 400 })
  }
  try {
    const rows = await createPaymentExceptionService(sql).list(raw as PaymentExceptionFilter)
    return NextResponse.json({
      success: true,
      data: rows,
      openCount: rows.filter(r => r.status === 'open').length,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err: any) {
    console.error('[admin/payment-exceptions GET]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load payment exceptions.' }, { status: 500 })
  }
}
