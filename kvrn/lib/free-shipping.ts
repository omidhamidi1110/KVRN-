// lib/free-shipping.ts — Free-shipping rule for KVRN
// Server-side only — imported by the shipping-rates route (display) and
// checkout-session-handler (authoritative). Never trust client-supplied subtotals
// for the authoritative checkout path; use reservation item prices instead.

export const FREE_SHIPPING_THRESHOLD_CENTS = 15_000  // $150.00 USD

/** Countries where free shipping may apply. Extend when new markets launch. */
const FREE_SHIPPING_COUNTRIES = new Set(['US'])

/**
 * Returns true when BOTH conditions are met:
 *   1. Destination country is in the free-shipping market list (currently US only)
 *   2. Merchandise subtotal is at or above the threshold ($150.00)
 *
 * Non-US destinations never qualify regardless of subtotal.
 * Subtotals below the threshold never qualify regardless of country.
 */
export function qualifiesForFreeShipping(
  country:       string,
  subtotalCents: number
): boolean {
  return (
    FREE_SHIPPING_COUNTRIES.has(country.toUpperCase()) &&
    subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS
  )
}

/**
 * Apply the free-shipping rule to a list of rate objects.
 *
 * When the order qualifies, the single cheapest rate has its `cents` set to 0.
 * All other rates keep their original price.
 * All other fields (label, provider, estimate, stripeLabel, etc.) are preserved.
 * If multiple rates share the minimum price, only the first one (by array order)
 * becomes free.
 *
 * Returns a NEW array — never mutates the input.
 */
export function applyFreeShippingToRates<T extends { cents: number }>(
  rates:         T[],
  country:       string,
  subtotalCents: number
): T[] {
  if (rates.length === 0) return rates
  if (!qualifiesForFreeShipping(country, subtotalCents)) return rates

  const minCents = Math.min(...rates.map(r => r.cents))
  let   applied  = false

  return rates.map(r => {
    if (!applied && r.cents === minCents) {
      applied = true
      return { ...r, cents: 0 }
    }
    return r
  })
}

/**
 * Apply the free-shipping rule to a single shipping cost given the competing
 * rate for comparison. Used in the checkout handler where only one method is
 * being processed at a time.
 *
 * Returns 0 if THIS rate is the cheapest (or tied) AND the order qualifies.
 * Returns the original rate otherwise.
 *
 * @param thisCents    Price of the method the customer selected
 * @param otherCents   Price of the other available method (for comparison)
 * @param country      Destination country code
 * @param subtotalCents Merchandise subtotal (must come from reservation items — server-authoritative)
 */
export function applyFreeShippingToSingleRate(
  thisCents:     number,
  otherCents:    number,
  thisMethod:    'standard' | 'express',
  country:       string,
  subtotalCents: number
): number {
  if (!qualifiesForFreeShipping(country, subtotalCents)) return thisCents
  if (thisCents < otherCents)  return 0   // strictly cheapest → free
  if (thisCents === otherCents && thisMethod === 'standard') return 0  // tied → standard wins
  return thisCents  // more expensive, or tied-but-express
}
