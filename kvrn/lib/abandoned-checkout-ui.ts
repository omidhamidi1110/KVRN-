// lib/abandoned-checkout-ui.ts — pure helpers shared by the Admin page and the public recovery
// page. No React, no browser globals (storage is injected), so they are unit-testable.

// ── Public recovery page ─────────────────────────────────────────────────────

export type RecoverFailure = 'disabled' | 'unconfigured' | 'invalid' | 'expired' | 'already_ordered' | 'unavailable' | 'error'

export const RECOVER_STATUS_COPY: Record<RecoverFailure, { title: string; body: string }> = {
  disabled:        { title: 'This link isn’t active.', body: 'Bag recovery isn’t available right now. You can start again from the shop.' },
  unconfigured:    { title: 'Temporarily unavailable.', body: 'Please try again in a little while, or start again from the shop.' },
  invalid:         { title: 'This link isn’t valid.', body: 'It may be incomplete or out of date. You can start again from the shop.' },
  expired:         { title: 'This link has expired.', body: 'Your saved bag is no longer held. You can start again from the shop.' },
  already_ordered: { title: 'You’ve already ordered.', body: 'We have your order, so this saved bag is no longer needed.' },
  unavailable:     { title: 'These items are no longer available.', body: 'Everything in your saved bag has sold out or been withdrawn. You can browse what’s available.' },
  error:           { title: 'We couldn’t restore your bag.', body: 'Please try again in a moment, or start again from the shop.' },
}

export const CART_STORAGE_KEY = 'kvrn_cart'

/**
 * Replace the storefront bag (localStorage 'kvrn_cart', the key CartContext hydrates from) with
 * the server-rebuilt bag. Returns false when storage is unavailable; the caller then tells the
 * visitor instead of navigating to an empty checkout.
 */
export function persistRecoveredCart(storage: { setItem(k: string, v: string): void } | null | undefined, cart: unknown[]): boolean {
  try {
    if (!storage || !Array.isArray(cart) || cart.length === 0) return false
    storage.setItem(CART_STORAGE_KEY, JSON.stringify(cart))
    return true
  } catch { return false }
}

/** Number of items in the bag currently stored on this device (0 when unknown). */
export function currentBagCount(storage: { getItem(k: string): string | null } | null | undefined): number {
  try {
    const raw = storage?.getItem(CART_STORAGE_KEY)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.length : 0
  } catch { return 0 }
}

// ── Admin ────────────────────────────────────────────────────────────────────

/** Subset of the Admin StatusBadge vocabulary used on this page (kept structurally compatible). */
export type BadgeStatus = 'Active' | 'Open' | 'Queued' | 'Sent' | 'Recovered' | 'Paid' | 'Inactive' | 'Failed' | 'Pending'

export function stateBadge(state: string): { status: BadgeStatus; label: string } {
  switch (state) {
    case 'active':          return { status: 'Active', label: 'In progress' }
    case 'abandoned':       return { status: 'Open', label: 'Abandoned' }
    case 'recovery_queued': return { status: 'Queued', label: 'Queued' }
    case 'recovery_sent':   return { status: 'Sent', label: 'Sent' }
    case 'recovered':       return { status: 'Recovered', label: 'Recovered' }
    case 'completed':       return { status: 'Paid', label: 'Completed' }
    case 'expired':         return { status: 'Inactive', label: 'Expired' }
    case 'ineligible':      return { status: 'Inactive', label: 'Not eligible' }
    case 'send_failed':     return { status: 'Failed', label: 'Send failed' }
    default:                return { status: 'Pending', label: 'Unknown' }
  }
}

const INELIGIBLE: Record<string, string> = {
  no_email: 'No email on the checkout.',
  empty_cart: 'The bag was empty.',
  payment_exception: 'A payment needs manual review.',
  payment_failed: 'The payment was declined.',
  resumed_from_recovery: 'Already resumed from a reminder.',
  customer_purchased: 'The customer ordered since.',
  no_consent: 'No marketing opt-in.',
  suppressed: 'Unsubscribed.',
  recent_recovery_email: 'Reminded recently about another bag.',
}
export function ineligibleLabel(reason: string | null | undefined): string {
  return reason ? (INELIGIBLE[reason] ?? 'Not eligible.') : ''
}

export function summarizeCart(cart: unknown, maxLines = 2): string {
  if (!Array.isArray(cart) || cart.length === 0) return 'Empty bag'
  const parts = cart.slice(0, maxLines).map((l: any) => {
    const variant = [l?.color, l?.size].filter(Boolean).join(' / ')
    return `${String(l?.productName ?? 'Item')}${variant ? ` · ${variant}` : ''} ×${Number(l?.quantity) || 1}`
  })
  const rest = cart.length - parts.length
  return rest > 0 ? `${parts.join(', ')} +${rest} more` : parts.join(', ')
}

/** Money for the summary. USD only is formatted; any other currency is shown with its code. */
export function formatMoney(cents: number, currency: string): string {
  const v = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency.toLowerCase() === 'usd' ? `$${v}` : `${v} ${currency.toUpperCase()}`
}

/**
 * Recovered revenue for the summary tiles. Never shows Unknown as $0:
 *   recovered orders with no stored total  -> "Unknown" (even when other orders have totals)
 *   no recovered orders                    -> "—"
 *   one or more currencies                 -> each total with its currency (never summed across)
 */
export function revenueDisplay(s: { recovered: number; revenueUnknownCount: number; revenue: Array<{ currency: string; cents: number }> }): string {
  if (s.revenueUnknownCount > 0) return 'Unknown'
  if (s.recovered === 0 || s.revenue.length === 0) return '—'
  return s.revenue.map(r => formatMoney(r.cents, r.currency)).join(' · ')
}

/** Manual retry is offered only for a failed send that has not used its one retry. */
export function canRetry(row: { state: string; manual_retries: number }, flagEnabled: boolean): boolean {
  return flagEnabled && row.state === 'send_failed' && Number(row.manual_retries) < 1
}
