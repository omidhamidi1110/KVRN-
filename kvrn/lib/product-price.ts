// lib/product-price.ts — the one place storefront product prices are formatted.
//
// Prices are CANONICAL integer cents from products.price_cents. There is deliberately no
// separate "display price": every surface (PDP, sticky bar, Complete the Set, shop cards,
// JSON-LD) formats the same cents value, so a page can never show one price while checkout
// charges another. Whole-dollar prices print without decimals ($80), others with ($79.50),
// matching the existing storefront style.
export function formatProductPrice(cents: number | null | undefined): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0) return 'Price not set'
  const dollars = cents / 100
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
}

/** Sum of canonical component prices (compat Complete-the-Set total; no discount rule exists). */
export function sumPriceCents(...parts: Array<number | null | undefined>): number | null {
  let t = 0
  for (const p of parts) {
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return null
    t += p
  }
  return t
}
