import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createAdminOrderService, UUID_RE } from '@/lib/admin-orders'
import { getEmailProvider } from '@/lib/resend-adapter'
import { processPendingTransactionalEmails } from '@/lib/transactional-email'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }

const CARRIER_MAX  = 50
const TRACKING_MAX = 100

export async function GET(req: NextRequest, context: Context) {
  const { error } = await requireAdmin(req)
  if (error) return error

  const { id } = await context.params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid order ID.' }, { status: 400 })
  }

  try {
    const svc   = createAdminOrderService(sql)
    const order = await svc.getOrderDetail(id)
    if (!order) return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
    return NextResponse.json({ success: true, data: order })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch order.' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, context: Context) {
  const { error } = await requireAdmin(req)
  if (error) return error

  const { id } = await context.params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid order ID.' }, { status: 400 })
  }

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const requestedStatus = body?.fulfillmentStatus

  // ── Branch 1: unfulfilled → processing ────────────────────────────────────
  if (requestedStatus === 'processing') {
    const extraKeys = Object.keys(body).filter(k => k !== 'fulfillmentStatus')
    if (extraKeys.length > 0) {
      return NextResponse.json(
        { error: `Unsupported fields for processing transition: ${extraKeys.join(', ')}.` },
        { status: 400 }
      )
    }

    try {
      const svc    = createAdminOrderService(sql)
      const result = await svc.transitionToProcessing(id)
      if (result === 'not_found')       return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
      if (result === 'conflict')        return NextResponse.json({ error: 'Cannot move to processing from current status.' }, { status: 409 })
      const order = await svc.getOrderDetail(id)
      return NextResponse.json({ success: true, data: order })
    } catch {
      return NextResponse.json({ error: 'Failed to update order.' }, { status: 500 })
    }
  }

  // ── Branch 2: processing → shipped ────────────────────────────────────────
  if (requestedStatus === 'shipped') {
    const extraKeys = Object.keys(body).filter(
      k => !['fulfillmentStatus', 'carrier', 'trackingNumber'].includes(k)
    )
    if (extraKeys.length > 0) {
      return NextResponse.json(
        { error: `Unsupported fields: ${extraKeys.join(', ')}.` },
        { status: 400 }
      )
    }

    // Validate carrier
    const carrierRaw = body.carrier
    if (carrierRaw === null || carrierRaw === undefined || typeof carrierRaw !== 'string') {
      return NextResponse.json({ error: 'carrier is required.' }, { status: 400 })
    }
    const carrier = carrierRaw.trim()
    if (!carrier) return NextResponse.json({ error: 'carrier must not be empty.' }, { status: 400 })
    if (carrier.length > CARRIER_MAX) {
      return NextResponse.json({ error: `carrier must be ${CARRIER_MAX} characters or fewer.` }, { status: 400 })
    }

    // Validate trackingNumber
    const trackingRaw = body.trackingNumber
    if (trackingRaw === null || trackingRaw === undefined || typeof trackingRaw !== 'string') {
      return NextResponse.json({ error: 'trackingNumber is required.' }, { status: 400 })
    }
    const trackingNumber = trackingRaw.trim()
    if (!trackingNumber) return NextResponse.json({ error: 'trackingNumber must not be empty.' }, { status: 400 })
    if (trackingNumber.length > TRACKING_MAX) {
      return NextResponse.json({ error: `trackingNumber must be ${TRACKING_MAX} characters or fewer.` }, { status: 400 })
    }

    try {
      const svc    = createAdminOrderService(sql)
      const result = await svc.markOrderShipped(id, carrier, trackingNumber)

      if (result.outcome === 'not_found') {
        return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
      }
      if (result.outcome === 'invalid_transition') {
        return NextResponse.json(
          { error: 'Order cannot be marked shipped from its current status.' },
          { status: 409 }
        )
      }
      // 'shipped' or 'already_shipped' — both are success; attempt email (non-fatal)
      if (result.outcome === 'shipped') {
        try {
          const provider = getEmailProvider()
          await processPendingTransactionalEmails({ sql, provider, limit: 1 })
        } catch (emailErr: any) {
          console.error('[orders/id PATCH] Shipping email failed (non-fatal):', emailErr?.message?.slice(0, 100))
        }
      }

      const order = await svc.getOrderDetail(id)
      return NextResponse.json({ success: true, data: order })
    } catch {
      return NextResponse.json({ error: 'Failed to mark order shipped.' }, { status: 500 })
    }
  }

  // ── Unknown transition ─────────────────────────────────────────────────────
  return NextResponse.json(
    { error: 'Only fulfillmentStatus "processing" or "shipped" (with carrier and trackingNumber) are supported.' },
    { status: 400 }
  )
}
