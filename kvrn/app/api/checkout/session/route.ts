// app/api/checkout/session/route.ts
// Thin Next.js route wrapper — business logic lives in lib/checkout-session-handler.ts

import { createCheckoutPostHandler } from '@/lib/checkout-session-handler'
import { getStripe }         from '@/lib/stripe-client'
import { getSiteOrigin }     from '@/lib/site-origin'
import { isCheckoutEnabled } from '@/lib/stripe-mode'
import {
  reserveInventory,
  saveReservationCheckoutDetails,
  failReservation,
  attachStripeSession,
  releaseExpiredReservations,
} from '@/lib/reservations'
import { abandonedService } from '@/lib/abandoned-checkout-runtime'
import { createBundleCheckout } from '@/lib/bundle-checkout'
import { sql } from '@/lib/db'
import { NextResponse, type NextRequest } from 'next/server'
import { allowPublicApiRequest } from '@/lib/public-api-rate-limit'
import { readLimitedJson } from '@/lib/limited-json-request'

// Bundle ("Complete the Set") checkout. Only used when the request carries `bundle`; gated by the
// CMS_PRODUCT_ROUTING flag inside. Ordinary carts never reach it.
const bundles = createBundleCheckout(sql)

export const dynamic = 'force-dynamic'

const checkoutPost = createCheckoutPostHandler({
  isCheckoutEnabled,
  getSiteOrigin,
  getStripe,
  // A set reserves through reserve_inventory_v2 (net prices validated in the database); everything else is unchanged.
  reserveInventory: (items, prep) => (prep ? bundles.reserve(prep, items) : reserveInventory(items)),
  saveReservationCheckoutDetails,
  failReservation,
  attachStripeSession,
  releaseExpiredReservations,
  recordCheckoutStarted: input => abandonedService.tryRecordCheckout(input),
  bundles: {
    prepare: (raw, plain, code) => bundles.prepare(raw, plain, code),
  },
})


// Real Stripe Checkout creates a temporary stock reservation. A public caller
// must not be able to generate unlimited unpaid reservations/Shippo calls.
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    try {
      const allowed = await allowPublicApiRequest(sql, {
        bucket: 'checkout_session', headers: req.headers, limit: 20, windowSeconds: 600,
      })
      if (!allowed) return NextResponse.json({ error: 'Too many checkout attempts. Please try again shortly.' }, {
        status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '600' },
      })
    } catch {
      // An unavailable limiter must not allow unlimited unpaid reservations.
      return NextResponse.json({ error: 'Checkout is temporarily unavailable.' }, { status: 503 })
    }
  }
  // Read a clone with a hard streaming cap; the real request body remains for
  // the existing canonical checkout handler. Untrusted clients can omit Content-Length.
  const read = await readLimitedJson(req.clone(), 32 * 1024)
  if (!read.ok) return NextResponse.json({ error: read.reason === 'too_large' ? 'Request too large.' : 'Invalid request.' }, { status: read.status })
  return checkoutPost(req)
}
