// PATCH /api/admin/payment-exceptions/[id]
//   body: { resolution: 'refunded' | 'fulfilled_manually' | 'dismissed', note: string }
//
// Closes a payment exception. Atomic with its admin_audit_logs row (see
// resolve_payment_exception, migration 022). For 'refunded', issue the refund in the
// Stripe Dashboard first: this endpoint records the resolution, it does not move money.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import {
  createPaymentExceptionService, PAYMENT_EXCEPTION_RESOLUTIONS,
  type PaymentExceptionResolution,
} from '@/lib/payment-exceptions'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOTE_MAX = 1000

type Context = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, context: Context) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  const { id } = await context.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 })

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  const resolution = body?.resolution
  if (!PAYMENT_EXCEPTION_RESOLUTIONS.includes(resolution)) {
    return NextResponse.json(
      { error: `resolution must be one of: ${PAYMENT_EXCEPTION_RESOLUTIONS.join(', ')}.` }, { status: 400 })
  }
  const note = typeof body?.note === 'string' ? body.note.trim() : ''
  if (!note) return NextResponse.json({ error: 'note is required.' }, { status: 400 })
  if (note.length > NOTE_MAX) {
    return NextResponse.json({ error: `note must be ${NOTE_MAX} characters or fewer.` }, { status: 400 })
  }

  try {
    const result = await createPaymentExceptionService(sql)
      .resolve(id, resolution as PaymentExceptionResolution, note, identity!.email)
    if (result.outcome === 'not_found') {
      return NextResponse.json({ error: 'Payment exception not found.' }, { status: 404 })
    }
    if (result.outcome === 'conflict') {
      return NextResponse.json(
        { error: `Already resolved as ${result.resolution}.` }, { status: 409 })
    }
    return NextResponse.json({ success: true, outcome: result.outcome, resolution: result.resolution })
  } catch (err: any) {
    console.error('[admin/payment-exceptions PATCH]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not resolve payment exception.' }, { status: 500 })
  }
}
