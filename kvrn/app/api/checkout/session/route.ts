import { type NextRequest, NextResponse } from 'next/server'
import { getStripe } from '@/lib/stripe-client'
import { getSiteOrigin } from '@/lib/site-origin'
import {
  reserveInventory,
  attachStripeSession,
  failReservation,
  releaseExpiredReservations,
} from '@/lib/reservations'

export const dynamic = 'force-dynamic'

function isCheckoutEnabled(): boolean {
  return process.env.ENABLE_STRIPE_TEST_CHECKOUT === 'true'
}

function isValidHttpsUrl(s: unknown): s is string {
  if (typeof s !== 'string' || !s) return false
  try {
    const u = new URL(s)
    return u.protocol === 'https:'
  } catch { return false }
}

export async function POST(req: NextRequest) {
  if (!isCheckoutEnabled()) {
    return NextResponse.json({ error: 'Checkout is not enabled.' }, { status: 503 })
  }

  const origin = getSiteOrigin()
  if (!origin) {
    console.error('CRITICAL: SITE_URL missing or invalid.')
    return NextResponse.json({ error: 'Server configuration error.' }, { status: 500 })
  }

  let stripe: ReturnType<typeof getStripe>
  try { stripe = getStripe() } catch (err: any) {
    console.error('Stripe config error:', err.message)
    return NextResponse.json({ error: 'Payment configuration error.' }, { status: 500 })
  }

  let items: { sku: string; quantity: number }[]
  try {
    const body = await req.json()
    items = body.items
    if (!Array.isArray(items) || items.length === 0) throw new Error()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  // Await cleanup — in Cloudflare Workers fire-and-forget may not complete
  try { await releaseExpiredReservations() }
  catch (e: any) { console.warn('Expired reservation cleanup failed:', e?.message) }

  // Step 1: Atomic inventory reservation
  const reservation = await reserveInventory(items)
  if (!reservation.ok) {
    return NextResponse.json(
      { error: reservation.message, code: reservation.code, sku: reservation.sku },
      { status: reservation.code === 'DB_ERROR' ? 503 : 400 }
    )
  }

  // Step 2: Create Stripe Checkout Session from Neon-authoritative snapshot data
  let session: Awaited<ReturnType<typeof stripe.checkout.sessions.create>>
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode:     'payment',
        currency: 'usd',
        line_items: reservation.items.map(item => ({
          price_data: {
            currency:    'usd',
            unit_amount: item.unitPriceCents,
            product_data: {
              name:     `${item.productName} — ${item.size}`,
              metadata: { sku: item.sku, variant_id: item.variantId },
            },
          },
          quantity: item.quantity,
        })),
        payment_intent_data: { metadata: { reservation_id: reservation.reservationId } },
        metadata:            { reservation_id: reservation.reservationId },
        success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${origin}/checkout`,
        shipping_address_collection: { allowed_countries: ['US'] },
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60, // >= 31 min
      },
      { idempotencyKey: `session-${reservation.reservationId}` }
    )
  } catch (err: any) {
    console.error('Stripe session creation failed:', err.message)
    try {
      const rel = await failReservation(reservation.reservationId, 'stripe_session_creation_failed')
      if (rel !== 'released') {
        console.error(`CRITICAL: reservation ${reservation.reservationId} not released after Stripe failure (result: ${rel})`)
      }
    } catch (relErr: any) {
      console.error(`CRITICAL: stranded reservation ${reservation.reservationId}:`, relErr.message)
    }
    return NextResponse.json({ error: 'Unable to create checkout session. Please try again.' }, { status: 500 })
  }

  // Fix 8: Validate session.url with URL(), require HTTPS
  if (!isValidHttpsUrl(session.url)) {
    console.error(`CRITICAL: Stripe returned null/invalid session.url for ${session.id}`)
    try {
      await stripe.checkout.sessions.expire(session.id)
      const rel = await failReservation(reservation.reservationId, 'null_session_url')
      if (rel !== 'released') {
        console.error(`CRITICAL: could not release reservation ${reservation.reservationId} after null url`)
      }
    } catch (e: any) {
      console.error(`CRITICAL: Could not expire/release after null url:`, e.message)
      // Reservation preserved for webhook/cleanup recovery
    }
    return NextResponse.json({ error: 'Checkout unavailable. Please try again.' }, { status: 500 })
  }

  // Step 3: Attach Stripe session ID — retry once on transient failure
  let attached = false
  for (let i = 0; i < 2; i++) {
    try {
      await attachStripeSession(reservation.reservationId, session.id, session.expires_at)
      attached = true
      break
    } catch (err: any) {
      if (i === 0) {
        console.warn('attachStripeSession attempt 1 failed, retrying:', err.message)
        await new Promise(r => setTimeout(r, 200))
      }
    }
  }

  if (!attached) {
    console.error(`CRITICAL: Failed to attach session ${session.id} to reservation ${reservation.reservationId}`)
    // Expire Stripe session first, then release inventory
    let stripeExpired = false
    try {
      await stripe.checkout.sessions.expire(session.id)
      stripeExpired = true
    } catch (e: any) {
      console.error('CRITICAL: Could not expire Stripe session:', e.message)
    }

    if (stripeExpired) {
      try {
        const rel = await failReservation(reservation.reservationId, 'attach_failed')
        if (rel !== 'released') {
          console.error(`CRITICAL: reservation ${reservation.reservationId} not released (result: ${rel})`)
        }
      } catch (relErr: any) {
        console.error('CRITICAL: Release failed after attach failure:', relErr.message)
      }
    } else {
      // Do NOT release — leave for webhook/cleanup recovery via metadata reservation_id
      console.error(`CRITICAL: reservation ${reservation.reservationId} left open for webhook recovery`)
    }
    return NextResponse.json({ error: 'Checkout session could not be confirmed. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({ url: session.url, sessionId: session.id })
}
