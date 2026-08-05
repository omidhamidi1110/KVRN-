// lib/format-money.ts — checkout display formatter
// Renders cents as dollars, showing cents only when non-zero.
//   8000 → "$80"
//   1999 → "$19.99"
//   2999 → "$29.99"
//   9999 → "$99.99"
// Do not use for server values or Stripe totals — display only.

export function formatCheckoutPrice(cents: number): string {
  const dollars = cents / 100
  const whole   = Math.floor(dollars)
  const frac    = Math.round((dollars - whole) * 100)
  if (frac === 0) return `$${whole}`
  return `$${whole}.${String(frac).padStart(2, '0')}`
}
