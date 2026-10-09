// Presentation-only copy for the Admin Shipping totals. No money math lives here: the numbers come
// from /api/admin/financials/shipping unchanged. This only decides how an UNKNOWN carrier cost is
// worded, so "unknown is not zero" is visible to the operator instead of a bare $0.00.

export const orderWord = (n: number) => (n === 1 ? 'order' : 'orders')

export type ShippingTotalsView = {
  orders: number
  ordersWithKnownCost: number
  ordersMissingCost: number
}

/** True when NO order in the period has a recorded carrier cost: cost and margin are unknown, not $0. */
export const noCostKnown = (t: ShippingTotalsView) => t.orders > 0 && t.ordersWithKnownCost === 0

export function costSub(t: ShippingTotalsView): string {
  if (t.orders === 0) return 'No paid orders in this period'
  if (noCostKnown(t)) return 'No carrier cost recorded yet'
  return `Recorded on ${t.ordersWithKnownCost} of ${t.orders} ${orderWord(t.orders)}`
}

export function marginSub(t: ShippingTotalsView): string {
  if (noCostKnown(t)) return 'Needs a recorded carrier cost'
  return `Revenue − cost, on the ${t.ordersWithKnownCost} ${orderWord(t.ordersWithKnownCost)} with a recorded cost`
}

export function missingCostTitle(t: ShippingTotalsView): string {
  const m = t.ordersMissingCost
  return `${m} of ${t.orders} ${orderWord(t.orders)} ${m === 1 ? 'has' : 'have'} no recorded label cost.`
}

export function missingCostBody(t: ShippingTotalsView): string {
  const k = t.ordersWithKnownCost
  return k === 0
    ? 'Carrier cost, margin and subsidy are unknown for this period. They are not $0.'
    : `Margin and subsidy below cover only the ${k} ${orderWord(k)} where the actual carrier cost is known.`
}
