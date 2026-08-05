// lib/stripe.ts — centralized shipping definitions for V50 US-only checkout
// Server independently recalculates shipping; browser may display these for UX only.

export type ShippingMethod = 'standard' | 'express'

export interface ShippingOption {
  method:        ShippingMethod
  label:         string
  description:   string
  estimate:      string
  cents:         number
  stripeLabel:   string
  minDays:       number
  maxDays:       number
}

/** US flat shipping rates — Shippo/EasyPost can replace these in V51. */
export const US_SHIPPING_OPTIONS: Record<ShippingMethod, ShippingOption> = {
  standard: {
    method:      'standard',
    label:       'Standard Shipping',
    description: 'Standard',
    estimate:    '5–8 business days',
    cents:       1999,
    stripeLabel: 'Standard Shipping (5–8 business days)',
    minDays:     5,
    maxDays:     8,
  },
  express: {
    method:      'express',
    label:       'Express Shipping',
    description: 'Express',
    estimate:    '2–4 business days',
    cents:       2999,
    stripeLabel: 'Express Shipping (2–4 business days)',
    minDays:     2,
    maxDays:     4,
  },
}

/**
 * Server-authoritative shipping cost.
 * Never accept shipping_cents from the browser.
 */
export function calculateShippingCents(method: ShippingMethod): number {
  return US_SHIPPING_OPTIONS[method].cents
}

/** Legacy alias for checkout page display */
export function calculateShipping(_country: string, method: ShippingMethod = 'standard'): number {
  return calculateShippingCents(method)
}
