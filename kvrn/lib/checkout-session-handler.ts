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
import { AFFILIATE_SESSION_COOKIE, isValidSessionId } from './affiliate-session'
import { sql } from './db'
import { isValidFunnelSessionId, tryRecordCheckoutStarted } from './funnel-analytics'
import { gaClientId as parseGaClientId, gaSessionId as parseGaSessionId } from './ga-common'
import { COUNTRY_CODES } from './countries'
import { US_SHIPPING_OPTIONS, type ShippingMethod } from './stripe'
// calculateShippingCents intentionally not imported — static cents must never
// become authoritative US payment shipping price
import { getShippoRates, type ShippoRate, type ShippoRates } from './shippo'
import { applyFreeShippingToSingleRate } from './free-shipping'
import { validateDiscount, applyDiscountPriority, normalizeDiscountCode, claimDiscount, releaseDiscountClaim, getOrCreateStripeCouponForTerms } from './discounts'
import { qualifiesForFreeShipping } from './free-shipping'
import { getProductShippingData } from './inventory'
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

/**
 * The visitor's first-party session id, if any.
 *
 * Only the SHAPE is trusted. A forged value matches no affiliate_clicks row, so
 * it can only fail to attribute — it can never mis-attribute to an affiliate the
 * visitor never came through.
 */
function readAffiliateSessionId(req: { cookies?: { get(name: string): { value: string } | undefined } }):
  string | null {
  try {
    const raw = req.cookies?.get(AFFILIATE_SESSION_COOKIE)?.value
    return isValidSessionId(raw) ? raw : null
  } catch { return null }
}

export function createCheckoutPostHandler(deps: CheckoutRouteDeps) {
  return async function POST(req: NextRequest): Promise<NextResponse> {
    // Server-side identity for affiliate attribution. Never body-supplied.
    const affiliateSessionId = readAffiliateSessionId(req)

    /**
     * Persist that identity on the reservation so late attribution can recover
     * it from order data alone. finalize_paid_order already copies
     * reservations.attribution to orders.attribution, so this survives into the
     * order without touching that frozen function.
     *
     * Non-fatal: failing to record it costs a backfill hint, not a checkout.
     */
    /**
     * Durably preserve the referral session BEFORE Stripe Checkout is created.
     *
     * FAIL-CLOSED, BUT ONLY FOR REAL REFERRALS. Two cases must not be conflated:
     *
     *   no referral evidence  -> nothing to preserve. Checkout proceeds
     *                            untouched and no affiliate state is fabricated.
     *   real referral evidence -> the opaque session id is the ONLY link between
     *                            this order and a commission obligation. If the
     *                            authoritative write fails and we continue
     *                            anyway, payment-time attribution later fails and
     *                            the obligation is lost permanently with nothing
     *                            left to recover it from.
     *
     * "Real evidence" means the cookie actually maps to a stored affiliate_clicks
     * row. A stale or forged cookie with no click behind it is not a referral and
     * must never block a customer's checkout.
     *
     * Returns true when checkout may proceed.
     */
    const preserveAffiliateSession = async (reservationId: string): Promise<boolean> => {
      if (!affiliateSessionId) return true

      let hasReferralEvidence = false
      try {
        const rows = await sql`
          SELECT 1 FROM affiliate_clicks
          WHERE session_id = ${affiliateSessionId} LIMIT 1
        `
        hasReferralEvidence = (rows as any[]).length > 0
      } catch (e: any) {
        // Cannot determine whether this is a referral. Treating "unknown" as
        // "no referral" is the failure mode that loses obligations, so this is
        // handled as a real referral and fails closed below.
        console.error('[checkout] referral evidence check failed:', e?.message?.slice(0, 80))
        hasReferralEvidence = true
      }

      try {
        await sql`SELECT persist_checkout_affiliate_session(
          ${reservationId}::uuid, ${affiliateSessionId}
        )`
        return true
      } catch (e: any) {
        console.error('[checkout] affiliate session persist failed:', e?.message?.slice(0, 120))
        // No referral behind the cookie: losing it costs nothing.
        if (!hasReferralEvidence) return true
        // A real referral whose identity we could not durably record.
        return false
      }
    }

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
    // Optional, shape-checked analytics session id (only sent by consenting browsers).
    // Never affects checkout; an invalid value is simply ignored.
    const analyticsSessionId: string | null =
      isValidFunnelSessionId(body.analyticsSessionId) ? body.analyticsSessionId : null
    // GA4 client/session ids (pseudonymous; the browser sends them only while GA is active, i.e.
    // after analytics consent). Only their strict digit.digit shape is trusted; anything else is
    // dropped. They ride in Stripe session metadata so the webhook's server-side GA purchase can
    // attach to this visitor's GA session. Absent => the server sends no GA purchase for the order.
    const gaClientId  = parseGaClientId(body.gaClientId)
    const gaSessionId = gaClientId ? parseGaSessionId(body.gaSessionId) : null
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

    // ── Country (validated first — affects subsequent field rules) ──────────────
    const countryR = requiredStringField(addr.country, FIELD_MAX.country, 'Country')
    if (!countryR.ok) return NextResponse.json({ error: countryR.error }, { status: 400 })
    const country = countryR.value.toUpperCase()
    if (!COUNTRY_CODES.has(country)) {
      return NextResponse.json({ error: 'Unsupported shipping destination.' }, { status: 400 })
    }
    const isUS = country === 'US'

    // ── Name / address lines / city (country-independent) ────────────────────
    const firstNameR = requiredStringField(addr.firstName,  FIELD_MAX.name,    'First name')
    const lastNameR  = requiredStringField(addr.lastName,   FIELD_MAX.name,    'Last name')
    const line1R     = requiredStringField(addr.line1,      FIELD_MAX.address, 'Address')
    const line2R     = optionalStringField(addr.line2,      FIELD_MAX.address, 'Apartment/unit')
    const cityR      = requiredStringField(addr.city,       FIELD_MAX.city,    'City')
    for (const r of [firstNameR, lastNameR, line1R, line2R, cityR]) {
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
    }
    if (!firstNameR.ok||!lastNameR.ok||!line1R.ok||!line2R.ok||!cityR.ok) {
      return NextResponse.json({ error: 'Invalid address.' }, { status: 400 })
    }
    const firstName = firstNameR.value
    const lastName  = lastNameR.value
    const line1     = line1R.value
    const line2     = line2R.value || null
    const city      = cityR.value

    // ── State / province (required for US; optional for international) ─────────
    let state = ''
    if (isUS) {
      const stateR = requiredStringField(addr.state, FIELD_MAX.state, 'State')
      if (!stateR.ok) return NextResponse.json({ error: stateR.error }, { status: 400 })
      state = stateR.value.toUpperCase()
      if (!isValidUSState(state)) {
        return NextResponse.json({ error: 'A valid US state is required.' }, { status: 400 })
      }
    } else {
      const stateR = optionalStringField(addr.state, FIELD_MAX.state, 'State / Province / Region')
      if (!stateR.ok) return NextResponse.json({ error: stateR.error }, { status: 400 })
      state = stateR.value ? stateR.value.toUpperCase() : ''
    }

    // ── Postal code (US ZIP format vs generic international) ─────────────────
    const postalLabel = isUS ? 'ZIP code' : 'Postal code'
    const postalR     = requiredStringField(addr.postalCode ?? addr.zip, FIELD_MAX.zip, postalLabel)
    if (!postalR.ok) return NextResponse.json({ error: postalR.error }, { status: 400 })
    const postalCode = postalR.value
    if (isUS) {
      if (!isValidUSZip(postalCode)) {
        return NextResponse.json({ error: 'A valid US ZIP code is required.' }, { status: 400 })
      }
    } else {
      // International: require safe characters + reasonable length (no country-specific regex)
      if (!/^[A-Za-z0-9][A-Za-z0-9 \-]{1,14}$/.test(postalCode)) {
        return NextResponse.json({ error: 'Enter a valid postal code.' }, { status: 400 })
      }
    }

    // ── Shipping method ───────────────────────────────────────────────────────
    const methodR = requiredStringField(body.shippingMethod, FIELD_MAX.method, 'Shipping method')
    if (!methodR.ok) return NextResponse.json({ error: methodR.error }, { status: 400 })
    const shippingMethod = methodR.value as ShippingMethod
    if (shippingMethod !== 'standard' && shippingMethod !== 'express') {
      return NextResponse.json({ error: 'Invalid shipping method.' }, { status: 400 })
    }

    // ── Get authoritative shipping cost ────────────────────────────────────────
    // Server re-fetches Shippo; never trusts browser-sent price.
    // US: live Shippo REQUIRED — no static fallback (fail closed).
    // Non-US: real Shippo rate REQUIRED — static US rates never used internationally.
    const apiToken = process.env.SHIPPO_API_TOKEN ?? ''
    let shippingCents: number
    let shippingOpt   = US_SHIPPING_OPTIONS[shippingMethod]  // typed base; may be overridden
    let shippoRatesResult: ShippoRates | null = null

    const SHIPPING_UNAVAILABLE_503 = NextResponse.json(
      { error: 'Shipping rates are temporarily unavailable. Please try again in a moment.' },
      { status: 503 }
    )

    if (isUS) {
      // US: live Shippo rate REQUIRED for every path.
      // No static fallback. shippingCents is only assigned from a confirmed live rate.

      // Guard 1: Shippo token must be present
      if (!apiToken) {
        console.error('[checkout/session] SHIPPO_API_TOKEN missing — fail closed')
        return SHIPPING_UNAVAILABLE_503
      }

      try {
        const shippingDb = await getProductShippingData().catch(() => [])
        shippoRatesResult = await getShippoRates(
          { city, state, zip: postalCode, country },
          (items as any[]).map((i: any) => ({ sku: i.sku, quantity: i.quantity })),
          shippingDb,
          apiToken
        )
      } catch (shippoErr: any) {
        console.error('[checkout/session] Shippo threw (fail closed):', shippoErr?.message?.slice(0, 80))
        return SHIPPING_UNAVAILABLE_503
      }

      // Guard 2: Shippo must return a result
      if (!shippoRatesResult) {
        console.error('[checkout/session] Shippo returned null — fail closed')
        return SHIPPING_UNAVAILABLE_503
      }

      // Guard 3: selected method must have a live rate
      const liveRate: ShippoRate | null = shippoRatesResult[shippingMethod] ?? null
      if (!liveRate) {
        console.error('[checkout/session] No live rate for', shippingMethod, '— fail closed')
        return SHIPPING_UNAVAILABLE_503
      }

      // All guards passed — live rate is authoritative
      shippingCents = liveRate.cents
      shippingOpt   = {
        ...US_SHIPPING_OPTIONS[shippingMethod],
        cents:       liveRate.cents,
        stripeLabel: liveRate.stripeLabel,
        minDays:     liveRate.minDays,
        maxDays:     liveRate.maxDays,
      }

    } else {
      // Non-US: Shippo REQUIRED — no static fallback, no US price permitted
      if (!apiToken) {
        return NextResponse.json(
          { error: 'Shipping is currently unavailable to this destination.' },
          { status: 503 }
        )
      }
      try {
        const shippingDb  = await getProductShippingData().catch(() => [])
        shippoRatesResult = await getShippoRates(
          { city, state, zip: postalCode, country },
          (items as any[]).map((i: any) => ({ sku: i.sku, quantity: i.quantity })),
          shippingDb,
          apiToken
        )
      } catch (shippoErr: any) {
        console.error('[checkout/session] Shippo error (international):', shippoErr?.message?.slice(0, 80))
      }

      if (!shippoRatesResult) {
        return NextResponse.json(
          { error: 'Shipping is currently unavailable to this destination.' },
          { status: 503 }
        )
      }

      const intlRate: ShippoRate | null = shippoRatesResult[shippingMethod] ?? null
      if (!intlRate) {
        // Selected method (e.g. express) not available for this destination
        return NextResponse.json(
          { error: 'The selected shipping method is not available to this destination. Please select Standard shipping or try again.' },
          { status: 400 }
        )
      }

      shippingCents = intlRate.cents
      shippingOpt   = {
        ...US_SHIPPING_OPTIONS[shippingMethod],
        cents:       intlRate.cents,
        stripeLabel: intlRate.stripeLabel,
        minDays:     intlRate.minDays,
        maxDays:     intlRate.maxDays,
      }
    }

    const fullName = `${firstName} ${lastName}`.trim()

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

    // ── Free-shipping rule — server-authoritative ─────────────────────────────
    // Subtotal computed from reservation items (never trusted from client).
    // Determines whether the cheapest chosen method should cost $0.
    const subtotalCents = (reservation.items as any[]).reduce(
      (sum: number, item: any) => sum + (item.unitPriceCents * item.quantity), 0
    )
    const otherMethod = shippingMethod === 'standard' ? 'express' : 'standard'
    // Use live rate for the alternate method; if it has no live rate,
    // Infinity ensures the selected (only available) method is always cheapest.
    // Never fall back to static cents for the free-shipping comparison.
    const otherCents  = shippoRatesResult?.[otherMethod]?.cents ?? Infinity

    // FINANCIAL SNAPSHOT: capture the live carrier quote BEFORE the automatic
    // free-shipping benefit is applied. applyFreeShippingToSingleRate overwrites
    // shippingCents with 0 when the order qualifies, which would otherwise destroy
    // all record of what the benefit gave away. Phase B reports the cost of free
    // shipping from this value.
    const quotedShippingCents = shippingCents

    shippingCents = applyFreeShippingToSingleRate(
      shippingCents, otherCents, shippingMethod, country, subtotalCents
    )

    // Amount waived by the AUTOMATIC benefit (distinct from a manual promo code).
    const autoFreeShippingDiscountCents = Math.max(0, quotedShippingCents - shippingCents)

    // Discount code from request body (validated server-side, never trusted from client)
    const rawDiscountCode = typeof body.discountCode === 'string' ? body.discountCode.trim() : null

    // ── Discount validation — server-authoritative ────────────────────────────
    // Discount priority: automatic free shipping may coexist with one merchandise promo.
    // Manual shipping promo codes remain redundant when automatic free shipping applies.
    let appliedDiscount: import('./discounts').AppliedDiscount | null = null
    let discountBlockedReason: string | null = null

    // ── Discount rejections must not strand the inventory reservation ────────
    //
    // Inventory was reserved above, BEFORE the discount is evaluated. Every
    // discount-rejection return below therefore has to fail that reservation, or
    // the stock stays held until the reservation times out on a later checkout.
    //
    // Best-effort and independent, in the same style as the other cleanup in this
    // handler: a cleanup error is logged and never replaces the customer-facing
    // rejection. The claim is released only where one demonstrably exists, so no
    // release is fabricated for a rejection that never took a claim.
    const failReservationForDiscountRejection = async (
      reason: string, opts: { releaseClaim: boolean }
    ) => {
      if (opts.releaseClaim) {
        try { await releaseDiscountClaim(reservation.reservationId) } catch (e: any) {
          console.error('[checkout/session] discount claim release failed after '
            + `${reason}:`, e?.message?.slice(0, 100))
        }
      }
      try { await deps.failReservation(reservation.reservationId, reason) } catch (e: any) {
        console.error('[checkout/session] reservation release failed after '
          + `${reason}:`, e?.message?.slice(0, 100))
      }
    }

    const DISCOUNT_UNAVAILABLE_MSG = 'Could not apply the discount code at this time. Please try again.'
    let _appliedValidation: Awaited<ReturnType<typeof validateDiscount>> | null = null
    if (rawDiscountCode) {
      let validation: Awaited<ReturnType<typeof validateDiscount>>
      try {
        validation = await validateDiscount(rawDiscountCode, { subtotalCents, country })
      } catch (err: any) {
        // Infrastructure failure (not an invalid code): free the stock, report 503.
        console.error('[checkout] discount validation error:', err?.message?.slice(0, 100))
        await failReservationForDiscountRejection('discount_validation_error', { releaseClaim: false })
        return NextResponse.json({ error: DISCOUNT_UNAVAILABLE_MSG }, { status: 503 })
      }
      _appliedValidation = validation
      if (!validation.valid) {
        await failReservationForDiscountRejection('discount_code_invalid', { releaseClaim: false })
        return NextResponse.json({ error: validation.error }, { status: 400 })
      }

      // Priority uses shippingCents BEFORE any discount (for shipping code calculation)
      const priorityResult = applyDiscountPriority({
        discount:      validation.discount,
        subtotalCents,
        country,
        shippingCents, // base shipping cost
      })
      if (priorityResult.blockedReason) {
        await failReservationForDiscountRejection('discount_blocked', { releaseClaim: false })
        return NextResponse.json({ error: priorityResult.blockedReason }, { status: 400 })
      }
      appliedDiscount = priorityResult.applied

      if (appliedDiscount) {
        // For merchandise discounts: get or create Stripe coupon (cached in DB)
        if (appliedDiscount.type !== 'shipping') {
          try {
            // Use shared coupon keyed by terms (not per-code)
            const couponId = await getOrCreateStripeCouponForTerms({
              type: appliedDiscount.type,
              amountCents: _appliedValidation?.valid ? _appliedValidation.discount.amountCents : null,
              percentageBps: _appliedValidation?.valid ? _appliedValidation.discount.percentageBps : null,
            })
            appliedDiscount.stripeCouponId = couponId
          } catch (err: any) {
            console.error('[checkout] Stripe coupon error:', err?.message?.slice(0, 60))
          }
        }

        // Claim discount slot BEFORE Stripe session creation (race prevention for single-use codes)
        // KVRN10 (unlimited) doesn't need exclusive claim, but SMS codes do
        if (validation.discount.singleUse || validation.discount.maxRedemptions !== null) {
          const sessionExpiresAt = new Date(Date.now() + 31 * 60 * 1000 + 60_000)
          let claimResult: Awaited<ReturnType<typeof claimDiscount>>
          try {
            claimResult = await claimDiscount({
              discountId:    appliedDiscount.discountId,
              reservationId: reservation.reservationId,
              expiresAt:     sessionExpiresAt,
            })
          } catch (err: any) {
            // Ambiguous: the claim may or may not have been written before the
            // failure. release_discount_claim is idempotent (no-op without a claim).
            console.error('[checkout] discount claim error:', err?.message?.slice(0, 100))
            await failReservationForDiscountRejection('discount_claim_error', { releaseClaim: true })
            return NextResponse.json({ error: DISCOUNT_UNAVAILABLE_MSG }, { status: 503 })
          }
          if (claimResult === 'conflict') {
            // This reservation already holds a claim (for a different discount):
            // release it, then fail the reservation.
            await failReservationForDiscountRejection('discount_claim_conflict', { releaseClaim: true })
            return NextResponse.json(
              { error: 'Only one discount can be applied per order.' },
              { status: 409 }
            )
          }
          if (claimResult === 'exhausted') {
            // No claim was taken for this reservation, so none is released.
            await failReservationForDiscountRejection('discount_claim_exhausted', { releaseClaim: false })
            return NextResponse.json(
              { error: 'That code has already been used or is held by another active checkout.' },
              { status: 409 }
            )
          }
          // 'claimed', 'idempotent', or 'unlimited' — all proceed
        }

        // ── Fail closed: non-shipping discount requires a Stripe coupon ───────────
        // If coupon resolution failed, the Neon snapshot would diverge from Stripe:
        // Neon expects discount; Stripe charges full price → finalize_paid_order
        // amount invariant would reject the payment after the customer has already paid.
        if (appliedDiscount.type !== 'shipping' && !appliedDiscount.stripeCouponId) {
          console.error('[checkout] Stripe coupon unavailable for merchandise discount; aborting checkout')
          // Release claim (no-op for unlimited codes; real release for limited ones)
          try { await releaseDiscountClaim(reservation.reservationId) } catch {}
          // Release the inventory reservation so items are not locked indefinitely
          try { await deps.failReservation(reservation.reservationId, 'stripe_coupon_unavailable') } catch {}
          return NextResponse.json(
            { error: 'Could not apply the discount code at this time. Please try again.' },
            { status: 503 }
          )
        }
      }
    }

    // Apply shipping discount to shippingCents if applicable
    let adjustedShippingCents = shippingCents
    if (appliedDiscount?.type === 'shipping') {
      adjustedShippingCents = Math.max(0, shippingCents - appliedDiscount.shippingAdjustmentCents)
    }

    // ── Step 2: Save snapshot ─────────────────────────────────────────────────
    const shippingAddress = {
      firstName, lastName, line1, line2: line2 ?? '', city, state, postalCode, country,
    }
    let saved = false
    try {
      // Preserve the referral identity BEFORE any Stripe session exists. A real
      // referral that cannot be durably recorded stops here, so Stripe is never
      // called and no order is created that could never be attributed.
      if (!(await preserveAffiliateSession(reservation.reservationId))) {
        // ── FAIL CLOSED, BUT CLEAN UP ────────────────────────────────────────
        //
        // The reservation and any discount claim were taken BEFORE this point.
        // Returning 503 without releasing them would strand stock and hold a
        // single-use discount until expiry, blocking the customer's own retry.
        //
        // Deterministic order: discount claim first, then the reservation. The
        // claim is keyed to the reservation, so releasing it while the
        // reservation still exists keeps the relationship intact. Each is
        // attempted independently, so one failing cannot prevent the other.
        //
        // Stripe is never called on this path.
        try {
          await releaseDiscountClaim(reservation.reservationId)
        } catch (e: any) {
          // Surfaced, never allowed to mask the original referral failure.
          console.error('[checkout/session] discount claim release failed after referral '
            + 'persistence failure:', e?.message?.slice(0, 100))
        }
        try {
          await deps.failReservation(reservation.reservationId, 'affiliate_session_persist_failed')
        } catch (e: any) {
          console.error('[checkout/session] reservation release failed after referral '
            + 'persistence failure:', e?.message?.slice(0, 100))
        }

        return NextResponse.json(
          { error: 'We could not start checkout. Please try again in a moment.' },
          { status: 503 })
      }

      saved = await deps.saveReservationCheckoutDetails(reservation.reservationId, {
        customerEmail:   email,
        customerName:    fullName,
        customerPhone:   phone,
        shippingAddress,
        shippingMethod,
        // Full shipping snapshot: before, discount, final
        shippingBeforeDiscountCents: shippingCents,
        shippingDiscountCents:       appliedDiscount?.shippingAdjustmentCents ?? 0,
        shippingFinalCents:          adjustedShippingCents,
        // Phase B shipping economics: live quote + automatic benefit waiver
        shippingQuotedCents:            quotedShippingCents,
        shippingAutoFreeDiscountCents:  autoFreeShippingDiscountCents,
        // Attribution: stored for ALL discount types (id/code/type)
        // discountCents: merchandise/order only — stays 0 for shipping codes
        // Shipping value is only in shipping_before/discount/final fields
        discountId:      appliedDiscount?.discountId ?? null,
        discountCode:    appliedDiscount?.code ?? null,
        discountType:    appliedDiscount?.type ?? null,
        discountCents:   appliedDiscount?.type !== 'shipping' ? (appliedDiscount?.amountCents ?? 0) : 0,
      })
    } catch (err: any) {
      console.error('Failed to save checkout details:', err.message)
    }

    if (!saved) {
      console.error(`CRITICAL: snapshot failed for reservation ${reservation.reservationId}`)
      // Release discount claim before failing reservation (Blocker 4)
      try { await releaseDiscountClaim(reservation.reservationId) } catch (e: any) {
        console.error('CRITICAL: claim release failed after snapshot error:', e?.message?.slice(0, 60))
      }
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
          // ── AFFILIATE ATTRIBUTION IDENTITY ───────────────────────────────
          // Read SERVER-SIDE from the first-party cookie, never from the
          // request body: a browser-supplied value must not be able to claim
          // another visitor's referral. An absent or malformed cookie yields
          // null, which simply means no link attribution for this order.
          ...(affiliateSessionId ? { client_reference_id: affiliateSessionId } : {}),
          line_items: [
            ...reservation.items.map((item: any) => ({
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
          ],
          shipping_options: [{
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: adjustedShippingCents, currency: 'usd' },
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
              address: {
              line1,
              line2: line2 ?? undefined,
              city,
              ...(state ? { state } : {}),
              postal_code: postalCode,
              country,    // validated 2-letter ISO code
            },
            },
          },
          // Note: customer-facing discount codes are NOT in Stripe metadata.
          // Authoritative attribution is in Neon reservation/order/redemption tables.
          metadata: {
            reservation_id: reservation.reservationId,
            shipping_method: shippingMethod,
            ...(gaClientId ? { ga_client_id: gaClientId, ...(gaSessionId ? { ga_session_id: gaSessionId } : {}) } : {}),
            ...(appliedDiscount ? {
              kvrn_discount_definition: appliedDiscount.type === 'fixed_amount'
                ? `fixed_usd_${appliedDiscount.amountCents}`
                : appliedDiscount.type === 'percentage'
                ? `pct_${_appliedValidation?.valid ? _appliedValidation.discount.percentageBps : 0}`
                : `shipping_${appliedDiscount.shippingAdjustmentCents}`,
              kvrn_discount_type: appliedDiscount.type,
            } : {}),
          },
          // Stripe coupon for merchandise discounts; shipping discounts applied to shippingCents directly
          ...(appliedDiscount?.type !== 'shipping' && appliedDiscount?.stripeCouponId
            ? { discounts: [{ coupon: appliedDiscount.stripeCouponId }] }
            : {}),
          // allow_promotion_codes: omitted — KVRN is the only discount entry point
          success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url:  `${origin}/checkout`,
          // allow_promotion_codes: false (omitted) — KVRN validates discounts server-side
          expires_at:  Math.floor(Date.now() / 1000) + 31 * 60,
        },
        { idempotencyKey: `session-${reservation.reservationId}` }
      )
    } catch (err: any) {
      console.error('Stripe session creation failed:', err.message)
      // Release discount claim if session creation fails
      if (appliedDiscount && (_appliedValidation?.valid ? _appliedValidation.discount.singleUse || _appliedValidation.discount.maxRedemptions !== null : false)) {
        try { await releaseDiscountClaim(reservation.reservationId) } catch {}
      }
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
      // Release discount claim before expiring (Blocker 5)
      try { await releaseDiscountClaim(reservation.reservationId) } catch {}
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
      // Release discount claim before expiring (Blocker 6)
      try { await releaseDiscountClaim(reservation.reservationId) } catch {}
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

    // ── Funnel analytics: checkout_started ───────────────────────────────────
    // Reached only after the Stripe session exists AND is attached to the reservation, so
    // it can never claim a checkout that failed to start. Best-effort by construction:
    // tryRecordCheckoutStarted never throws, and nothing above depends on it. Recorded only
    // when the visitor's browser supplied an analytics session id (i.e. consented); the id's
    // shape is the only thing trusted, and the cart/subtotal come from the reservation.
    if (analyticsSessionId) {
      await tryRecordCheckoutStarted(sql, {
        sessionId:     analyticsSessionId,
        reservationId: reservation.reservationId,
        subtotalCents,
        items: (reservation.items as any[]).map((i: any) => ({
          variantId: i.variantId, quantity: i.quantity,
        })),
      })
    }

    return NextResponse.json({ url: session.url, sessionId: session.id })
  }
}
