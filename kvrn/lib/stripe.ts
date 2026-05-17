// ─────────────────────────────────────────────────────────────────────────────
// STRIPE CLIENT HELPER
//
// SETUP:
//   npm install stripe @stripe/stripe-js @stripe/react-stripe-js
//   Add STRIPE_SECRET_KEY and NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY to .env.local
// ─────────────────────────────────────────────────────────────────────────────

// ─── SERVER-SIDE CLIENT ───────────────────────────────────────────────────────
// Uncomment when stripe package is installed:
//
// import Stripe from 'stripe'
//
// let _stripe: Stripe | null = null
//
// export function getStripe(): Stripe {
//   if (!_stripe) {
//     if (!process.env.STRIPE_SECRET_KEY) {
//       throw new Error('STRIPE_SECRET_KEY is not set.')
//     }
//     _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
//       apiVersion: '2024-06-20',
//       typescript:  true,
//     })
//   }
//   return _stripe
// }

// ─── CLIENT-SIDE LOADER ───────────────────────────────────────────────────────
// Uncomment when @stripe/stripe-js is installed:
//
// import { loadStripe, type Stripe as StripeJS } from '@stripe/stripe-js'
//
// let _stripePromise: Promise<StripeJS | null> | null = null
//
// export function getStripeJs(): Promise<StripeJS | null> {
//   if (!_stripePromise) {
//     const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
//     if (!key) throw new Error('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set.')
//     _stripePromise = loadStripe(key)
//   }
//   return _stripePromise
// }

// ─── PRICE FORMATTING ────────────────────────────────────────────────────────
export function penceToDecimal(pence: number): number {
  return pence / 100
}

export function decimalToPence(amount: number): number {
  return Math.round(amount * 100)
}

// ─── SHIPPING COST CALCULATOR ─────────────────────────────────────────────────
export type ShippingMethod = 'standard' | 'express'

export function calculateShipping(
  countryCode: string,
  method: ShippingMethod = 'standard'
): number {
  if (countryCode === 'GB') {
    return method === 'express' ? 999 : 499
  }
  if (countryCode === 'IE') {
    return method === 'express' ? 1499 : 999
  }
  if (['US', 'CA'].includes(countryCode)) {
    return method === 'express' ? 2999 : 1999
  }
  if (['AU', 'NZ'].includes(countryCode)) {
    return method === 'express' ? 2999 : 2499
  }
  // Europe and rest of world
  const isEU = ['DE','FR','NL','BE','AT','SE','DK','NO','CH','ES','IT','PT'].includes(countryCode)
  if (isEU) {
    return method === 'express' ? 1999 : 1499
  }
  return method === 'express' ? 3499 : 2499
}

// ─── VAT CALCULATOR (UK 20%) ──────────────────────────────────────────────────
export function calculateVAT(grossPence: number): number {
  // VAT is included in UK prices — extract the VAT portion
  return Math.round(grossPence * (1 - 1 / 1.2))
}

// ─── STRIPE RADAR METADATA ───────────────────────────────────────────────────
// Attach this to every PaymentIntent to improve fraud detection
export function buildRadarMetadata(params: {
  ipAddress?:   string
  userAgent?:   string
  sessionId?:   string
  itemCount:    number
  productTypes: string[]
}) {
  return {
    item_count:    String(params.itemCount),
    product_types: params.productTypes.join(','),
    session_id:    params.sessionId ?? '',
    ip_address:    params.ipAddress ?? '',
  }
}

// ─── STUB (remove when stripe is installed) ────────────────────────────────────
export const stripeNotConfigured = !process.env.STRIPE_SECRET_KEY
