import { type NextRequest, NextResponse } from 'next/server'
import { verifyWebhookSignature } from '@/lib/stripe-client'
import {
  finalizePaidOrder,
  releaseReservationForEvent,
  markAwaitingPayment,
} from '@/lib/reservations'
import { sql } from '@/lib/db'
import { processPendingTransactionalEmails } from '@/lib/transactional-email'
import { releaseDiscountClaim } from '@/lib/discounts'
import { getEmailProvider } from '@/lib/resend-adapter'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    console.error('[WEBHOOK] STRIPE_WEBHOOK_SECRET not set.')
    return NextResponse.json({ error: 'Webhook not configured.' }, { status: 500 })
  }

  const rawBody    = await req.text()
  const sigHeader  = req.headers.get('stripe-signature') ?? ''
  if (!sigHeader) return NextResponse.json({ error: 'Missing Stripe-Signature.' }, { status: 400 })

  let event: Awaited<ReturnType<typeof verifyWebhookSignature>>
  try {
    event = await verifyWebhookSignature(rawBody, sigHeader, secret)
  } catch {
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 })
  }

  const session = event.data.object as any

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        if (session.payment_status === 'paid') {
          await handlePaid(session, event.id, event.type)
        } else {
          const res = await markAwaitingPayment(session.id, event.id, event.type)
          if (res === 'already_processed') {
            return NextResponse.json({ received: true, idempotent: true })
          }
        }
        break
      }

      case 'checkout.session.async_payment_succeeded':
        await handlePaid(session, event.id, event.type)
        break

      case 'checkout.session.async_payment_failed':
        await releaseReservationForEvent(session.id, event.id, event.type, 'async_payment_failed')
        await releaseDiscountClaimForSession(session)
        break

      case 'checkout.session.expired':
        await releaseReservationForEvent(session.id, event.id, event.type, 'session_expired')
        await releaseDiscountClaimForSession(session)
        break

      default:
        return NextResponse.json({ received: true, handled: false })
    }
    return NextResponse.json({ received: true, handled: true })

  } catch (err: any) {
    console.error(`[WEBHOOK] Error [${event.type}] ${event.id}:`, err?.message)
    return NextResponse.json({ error: 'Processing error.' }, { status: 500 })
  }
}

async function handlePaid(session: any, eventId: string, eventType: string) {
  const shippingDetails =
    session.collected_information?.shipping_details ??
    session.shipping_details ??
    null
  const sa           = shippingDetails?.address
  const recipientName = shippingDetails?.name ?? session.customer_details?.name ?? null

  const addr = sa ? {
    line1:       sa.line1,
    line2:       sa.line2  ?? null,
    city:        sa.city,
    state:       sa.state,
    postal_code: sa.postal_code,
    country:     sa.country,
  } : null

  const result = await finalizePaidOrder({
    stripeSessionId:     session.id,
    reservationIdHint:   session.metadata?.reservation_id ?? null,
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

  // Attempt to send outbox email — non-fatal: provider failure must NOT affect order
  if (result.outcome === 'order_created') {
    try {
      const provider = getEmailProvider()
      await processPendingTransactionalEmails({ sql, provider, limit: 1 })
    } catch (emailErr: any) {
      // Log without PII — order remains paid regardless
      console.error('[WEBHOOK] Email send failed (non-fatal):', emailErr?.message?.slice(0, 100))
    }
  }
}

async function releaseDiscountClaimForSession(session: any) {
  // Read reservation_id from session metadata, release any active discount claim
  const reservationId = session.metadata?.reservation_id
  if (!reservationId) return
  try {
    await releaseDiscountClaim(reservationId)
  } catch (err: any) {
    console.error('[WEBHOOK] releaseDiscountClaim error (non-fatal):', err?.message?.slice(0, 60))
  }
}
