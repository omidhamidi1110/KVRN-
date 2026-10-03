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

export const dynamic = 'force-dynamic'

export const POST = createCheckoutPostHandler({
  isCheckoutEnabled,
  getSiteOrigin,
  getStripe,
  reserveInventory,
  saveReservationCheckoutDetails,
  failReservation,
  attachStripeSession,
  releaseExpiredReservations,
})
