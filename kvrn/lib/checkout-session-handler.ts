// lib/checkout-session-handler.ts
// Injectable factory for the /api/checkout/session POST handler.
// Import createCheckoutPostHandler in tests; the route re-exports POST.

import { type NextRequest, NextResponse } from 'next/server'
import {
  requiredStringField,
  optionalStringField,
  FIELD_MAX,
} from './checkout-validation'
import { isValidUSState, isValidUSZip, isValidEmail } from './us-states'
import { calculateShippingCents, US_SHIPPING_OPTIONS, type ShippingMethod } from './stripe'
import type {
  ReservationService,
  LineItemInput,
  CheckoutDetails,
} from './reservations'

export interface CheckoutRouteDeps {
  isCheckoutEnabled:              () => boolean
  getSiteOrigin:                  () => string | null
  getStripe:                      () => any   // Stripe instance — avoids Stripe type import in tests
  reserveInventory:               (items: LineItemInput[]) => ReturnType<ReservationService['reserveInventory']>
  saveReservationCheckoutDetails: (id: string, d: CheckoutDetails) => Promise<boolean>
  failReservation:                (id: string, reason: string) => Promise<'released'|'already_released'|'not_found'>
  attachStripeSession:            (id: string, sessionId: string, expiresAt: number) => Promise<void>
  releaseExpiredReservations:     () => Promise<number>
}

function isValidHttpsUrl(s: unknown): s is string {
  if (typeof s !== 'string' || !s) return false
  try { return new URL(s).protocol === 'https:' } catch { return false }
}

export function createCheckoutPostHandler(deps: CheckoutRouteDeps) {
  return async function POST(req: NextRequest): Promise<NextResponse> {
    if (!deps.isCheckoutEnabled()) {
      return NextResponse.json({ error: 'Checkout is not enabled.' }, { status: 503 })
    }

    const origin = deps.getSiteOrigin()
    if (!origin) {
      console.error('CRITICAL: SITE_URL missing or invalid.')
      return NextResponse.json({ error: 'Server configuration error.' }, { status: 500 })
    }

    let stripe: any
    try { stripe = deps.getStripe() } catch (err: any) {
      console.error('Stripe config error:', err.message)
      return NextResponse.json({ error: 'Payment configuration error.' }, { status: 500 })
    }

    let body: any
    try { body = await req.json() } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
    }

    const items: LineItemInput[] = body.items
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'Cart is empty.' }, { status: 400 })
    }

    // ── Contact ──────────────────────────────────────────────────────────────
    const emailR = requiredStringField(body.email, FIELD_MAX.email, 'Email')
    if (!emailR.ok) return NextResponse.json({ error: emailR.error }, { status: 400 })
    if (!isValidEmail(emailR.value)) {
      return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400 })
    }
    const email = emailR.value

    const phoneR = optionalStringField(body.phone, FIELD_MAX.phone, 'Phone')
    if (!phoneR.ok) return NextResponse.json({ error: phoneR.error }, { status: 400 })
    const phone = phoneR.value || null

    // ── Shipping address ─────────────────────────────────────────────────────
    const addr = body.shippingAddress ?? {}

    const firstNameR = requiredStringField(addr.firstName,               FIELD_MAX.name,    'First name')
    const lastNameR  = requiredStringField(addr.lastName,                FIELD_MAX.name,    'Last name')
    const line1R     = requiredStringField(addr.line1,                   FIELD_MAX.address, 'Address')
    const line2R     = optionalStringField(addr.line2,                   FIELD_MAX.address, 'Apartment/unit')
    const cityR      = requiredStringField(addr.city,                    FIELD_MAX.city,    'City')
    const stateR     = requiredStringField(addr.state,                   FIELD_MAX.state,   'State')
    const postalR    = requiredStringField(addr.postalCode ?? addr.zip,  FIELD_MAX.zip,     'ZIP code')
    const countryR   = requiredStringField(addr.country,                 FIELD_MAX.country, 'Country')

    const addrResults = [firstNameR, lastNameR, line1R, line2R, cityR, stateR, postalR, countryR]
    for (const r of addrResults) {
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
    }

    // TypeScript narrows (all ok=true here)
    if (!firstNameR.ok||!lastNameR.ok||!line1R.ok||!line2R.ok||
        !cityR.ok||!stateR.ok||!postalR.ok||!countryR.ok) {
      return NextResponse.json({ error: 'Invalid address.' }, { status: 400 })
    }

    const firstName  = firstNameR.value
    const lastName   = lastNameR.value
    const line1      = line1R.value
    const line2      = line2R.value || null
    const city       = cityR.value
    const state      = stateR.value.toUpperCase()
    const postalCode = postalR.value
    const country    = countryR.value.toUpperCase()   // Fix 4: no silent fallback

    const fieldErrors: string[] = []
    if (!isValidUSState(state))    fieldErrors.push('A valid US state is required.')
    if (!isValidUSZip(postalCode)) fieldErrors.push('A valid US ZIP code is required.')
    if (country !== 'US')          fieldErrors.push('Only US shipping is supported at this time.')
    if (fieldErrors.length) return NextResponse.json({ error: fieldErrors[0] }, { status: 400 })

    // ── Shipping method ───────────────────────────────────────────────────────
    const methodR = requiredStringField(body.shippingMethod, FIELD_MAX.method, 'Shipping method')
    if (!methodR.ok) return NextResponse.json({ error: methodR.error }, { status: 400 })
    const shippingMethod = methodR.value as ShippingMethod
    if (shippingMethod !== 'standard' && shippingMethod !== 'express') {
      return NextResponse.json({ error: 'Invalid shipping method.' }, { status: 400 })
    }

    const shippingCents = calculateShippingCents(shippingMethod)
    const shippingOpt   = US_SHIPPING_OPTIONS[shippingMethod]
    const fullName      = `${firstName} ${lastName}`.trim()

    // ── Release expired reservations ──────────────────────────────────────────
    try { await deps.releaseExpiredReservations() }
    catch (e: any) { console.warn('Expired cleanup failed:', e?.message) }

    // ── Step 1: Reserve inventory ─────────────────────────────────────────────
    const reservation = await deps.reserveInventory(items)
    if (!reservation.ok) {
      return NextResponse.json(
        { error: reservation.message, code: reservation.code, sku: reservation.sku },
        { status: reservation.code === 'DB_ERROR' ? 503 : 400 }
      )
    }

    // ── Step 2: Save snapshot ─────────────────────────────────────────────────
    const shippingAddress = {
      firstName, lastName, line1, line2: line2 ?? '', city, state, postalCode, country,
    }
    let saved = false
    try {
      saved = await deps.saveReservationCheckoutDetails(reservation.reservationId, {
        customerEmail:   email,
        customerName:    fullName,
        customerPhone:   phone,
        shippingAddress,
        shippingMethod,
        shippingCents,
      })
    } catch (err: any) {
      console.error('Failed to save checkout details:', err.message)
    }

    if (!saved) {
      console.error(`CRITICAL: snapshot failed for reservation ${reservation.reservationId}`)
      try {
        const rel = await deps.failReservation(reservation.reservationId, 'save_checkout_details_failed')
        if (rel !== 'released') {
          console.error(`CRITICAL: reservation ${reservation.reservationId} not released (${rel})`)
        }
      } catch (relErr: any) {
        console.error('CRITICAL: stranded reservation after snapshot failure:', relErr.message)
      }
      return NextResponse.json(
        { error: 'Checkout could not be initialised. Please try again.' },
        { status: 409 }
      )
    }

    // ── Step 3: Create Stripe Session ─────────────────────────────────────────
    let session: any
    try {
      session = await stripe.checkout.sessions.create(
        {
          mode:           'payment',
          currency:       'usd',
          customer_email: email,
          line_items: reservation.items.map((item: any) => ({
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
          shipping_options: [{
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: shippingCents, currency: 'usd' },
              display_name: shippingOpt.stripeLabel,
              delivery_estimate: {
                minimum: { unit: 'business_day', value: shippingOpt.minDays },
                maximum: { unit: 'business_day', value: shippingOpt.maxDays },
              },
            },
          }],
          payment_intent_data: {
            receipt_email: email,
            metadata:      { reservation_id: reservation.reservationId },
            shipping: {
              name:    fullName,
              phone:   phone ?? undefined,
              address: { line1, line2: line2 ?? undefined, city, state, postal_code: postalCode, country: 'US' },
            },
          },
          metadata:    { reservation_id: reservation.reservationId, shipping_method: shippingMethod },
          success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url:  `${origin}/checkout`,
          expires_at:  Math.floor(Date.now() / 1000) + 31 * 60,
        },
        { idempotencyKey: `session-${reservation.reservationId}` }
      )
    } catch (err: any) {
      console.error('Stripe session creation failed:', err.message)
      try {
        const rel = await deps.failReservation(reservation.reservationId, 'stripe_session_creation_failed')
        if (rel !== 'released') {
          console.error(`CRITICAL: reservation ${reservation.reservationId} not released (${rel})`)
        }
      } catch (relErr: any) {
        console.error(`CRITICAL: stranded reservation ${reservation.reservationId}:`, relErr.message)
      }
      return NextResponse.json({ error: 'Unable to create checkout session. Please try again.' }, { status: 500 })
    }

    if (!isValidHttpsUrl(session.url)) {
      console.error(`CRITICAL: Stripe returned null session.url for ${session.id}`)
      try {
        await stripe.checkout.sessions.expire(session.id)
        const rel = await deps.failReservation(reservation.reservationId, 'null_session_url')
        if (rel !== 'released') {
          console.error(`CRITICAL: could not release reservation ${reservation.reservationId} after null url`)
        }
      } catch (e: any) {
        console.error('CRITICAL: Could not expire/release after null url:', e.message)
      }
      return NextResponse.json({ error: 'Checkout unavailable. Please try again.' }, { status: 500 })
    }

    // ── Step 4: Attach session ID ─────────────────────────────────────────────
    let attached = false
    for (let i = 0; i < 2; i++) {
      try {
        await deps.attachStripeSession(reservation.reservationId, session.id, session.expires_at)
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
      console.error(`CRITICAL: Failed to attach ${session.id} to reservation ${reservation.reservationId}`)
      let stripeExpired = false
      try { await stripe.checkout.sessions.expire(session.id); stripeExpired = true }
      catch (e: any) { console.error('CRITICAL: Could not expire Stripe session:', e.message) }
      if (stripeExpired) {
        try {
          const rel = await deps.failReservation(reservation.reservationId, 'attach_failed')
          if (rel !== 'released') {
            console.error(`CRITICAL: reservation ${reservation.reservationId} not released (${rel})`)
          }
        } catch (relErr: any) {
          console.error('CRITICAL: Release failed after attach failure:', relErr.message)
        }
      }
      return NextResponse.json(
        { error: 'Checkout session could not be confirmed. Please try again.' },
        { status: 500 }
      )
    }

    return NextResponse.json({ url: session.url, sessionId: session.id })
  }
}
