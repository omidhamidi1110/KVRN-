import { type NextRequest, NextResponse } from 'next/server'
import { verifyWebhookSignature } from '@/lib/stripe-client'
import {
  finalizePaidOrder,
  releaseReservationForEvent,
  markAwaitingPayment,
} from '@/lib/reservations'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET not set.')
    return NextResponse.json({ error: 'Webhook not configured.' }, { status: 500 })
  }

  // Raw body before any JSON parsing — signature covers raw bytes
  const rawBody   = await req.text()
  const sigHeader = req.headers.get('stripe-signature') ?? ''
  if (!sigHeader) return NextResponse.json({ error: 'Missing Stripe-Signature.' }, { status: 400 })

  let event: Awaited<ReturnType<typeof verifyWebhookSignature>>
  try {
    event = await verifyWebhookSignature(rawBody, sigHeader, secret)
  } catch {
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 })
  }

  // No pre-check query — idempotency is handled inside each PL/pgSQL function
  const session = event.data.object as any

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        if (session.payment_status === 'paid') {
          await handlePaid(session, event.id, event.type)
        } else {
          const res = await markAwaitingPayment(session.id, event.id, event.type)
          if (res === 'already_processed') return NextResponse.json({ received: true, idempotent: true })
        }
        break
      }

      case 'checkout.session.async_payment_succeeded':
        await handlePaid(session, event.id, event.type)
        break

      case 'checkout.session.async_payment_failed':
        await releaseReservationForEvent(session.id, event.id, event.type, 'async_payment_failed')
        break

      case 'checkout.session.expired':
        await releaseReservationForEvent(session.id, event.id, event.type, 'session_expired')
        break

      default:
        return NextResponse.json({ received: true, handled: false })
    }
    return NextResponse.json({ received: true, handled: true })

  } catch (err: any) {
    console.error(`Webhook error [${event.type}] ${event.id}:`, err?.message)
    // Return 500 so Stripe retries (event row processed=false stays retryable)
    return NextResponse.json({ error: 'Processing error.' }, { status: 500 })
  }
}

async function handlePaid(session: any, eventId: string, eventType: string) {
  // Prefer new Stripe field; fall back to legacy field
  const shippingDetails =
    session.collected_information?.shipping_details ??
    session.shipping_details ??
    null
  const sa   = shippingDetails?.address
  // Prefer shippingDetails.name; fallback to customer_details.name
  const recipientName = shippingDetails?.name ?? session.customer_details?.name ?? null
  const addr = sa ? {
    line1: sa.line1, line2: sa.line2 ?? null,
    city: sa.city, state: sa.state,
    postal_code: sa.postal_code, country: sa.country,
  } : null

  const reservationIdHint = session.metadata?.reservation_id ?? null

  const result = await finalizePaidOrder({
    stripeSessionId:     session.id,
    reservationIdHint,
    stripePaymentIntent: session.payment_intent ?? '',
    stripeEventId:       eventId,
    eventType,
    currency:            session.currency ?? 'usd',
    amountTotal:         session.amount_total ?? 0,
    customerEmail:       session.customer_details?.email ?? null,
    customerName:        recipientName,
    customerPhone:       session.customer_details?.phone ?? null,
    shippingAddress:     addr,
  })

  // Log non-retryable outcomes (already marked processed in DB)
  if (result.outcome === 'no_reservation') {
    console.warn(`CRITICAL: No reservation for session ${session.id} event ${eventId}`)
  } else if (result.outcome === 'reservation_not_eligible') {
    console.warn(`CRITICAL: Reservation not eligible for session ${session.id} event ${eventId}`)
  }
}
