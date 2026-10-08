// app/admin/orders/orders-ui.ts — pure display helpers for the Orders page.
//
// Kept free of React so the status vocabulary and the fraud/risk wording can be unit-tested
// (there is no jsdom in this repo). Status labels come from the shared Admin vocabulary
// (components/admin/ui/AdminUI.tsx STATUS_TONES); no new synonyms are invented.

import type { StatusLabel } from '@/components/admin/ui/AdminUI'
import type { CheckResult, FraudView } from '@/lib/fraud-review'
import type { OrderTagColor } from '@/lib/order-tags'

export interface BadgeSpec { status: StatusLabel; label?: string }

/** Payment status -> shared vocabulary. */
export function paymentBadge(status: string): BadgeSpec {
  switch (status) {
    case 'paid':     return { status: 'Paid' }
    case 'pending':  return { status: 'Pending' }
    case 'failed':   return { status: 'Failed' }
    case 'refunded': return { status: 'Refunded' }
    default:         return { status: 'Unknown' }
  }
}

/** Fulfillment status -> shared vocabulary (shipped/delivered are "Fulfilled"). */
export function fulfillmentBadge(status: string): BadgeSpec {
  switch (status) {
    case 'unfulfilled': return { status: 'Unfulfilled' }
    case 'processing':  return { status: 'Processing' }
    case 'shipped':     return { status: 'Fulfilled', label: 'Shipped' }
    case 'delivered':   return { status: 'Fulfilled', label: 'Delivered' }
    case 'cancelled':   return { status: 'Inactive', label: 'Cancelled' }
    default:            return { status: 'Unknown' }
  }
}

/** The risk state as one badge. Missing data is Unknown — never "Normal", never zero. */
export function riskBadge(v: Pick<FraudView, 'hasRecord' | 'riskLevel'>): BadgeSpec {
  if (!v.hasRecord || v.riskLevel === null) return { status: 'Unknown' }
  switch (v.riskLevel) {
    case 'normal':       return { status: 'Verified', label: 'Normal' }
    case 'elevated':     return { status: 'Review', label: 'Elevated' }
    case 'highest':      return { status: 'Exception', label: 'Highest' }
    case 'not_assessed': return { status: 'Unknown', label: 'Not assessed' }
    default:             return { status: 'Unknown' }
  }
}

export function holdBadge(state: 'none' | 'active' | 'released'): BadgeSpec {
  if (state === 'active') return { status: 'Held' }
  if (state === 'released') return { status: 'Released' }
  return { status: 'Inactive', label: 'No hold' }
}

export function reviewBadge(r: FraudView['stripeReview']): BadgeSpec {
  if (!r) return { status: 'Inactive', label: 'None' }
  return r.state === 'open' ? { status: 'Review', label: 'Open' } : { status: 'Resolved', label: 'Closed' }
}

/** A single list-row indicator for fraud state, or null when there is nothing to show. */
export function listFraudBadge(f: { hold: 'none' | 'active' | 'released'; flagged: boolean; syncError: boolean } | null | undefined): BadgeSpec | null {
  if (!f) return null
  if (f.hold === 'active') return { status: 'Held' }
  if (f.flagged && f.hold === 'none') return { status: 'Review', label: 'Flagged' }
  if (f.syncError) return { status: 'Unknown', label: 'Risk unknown' }
  return null
}

const CHECK_LABELS: Record<CheckResult, string> = {
  pass: 'Pass', fail: 'Fail', unavailable: 'Unavailable', unchecked: 'Not checked',
}
/** null = Stripe supplied nothing = "Unknown" (not "Pass"). */
export const checkLabel = (v: CheckResult | null): string => (v ? CHECK_LABELS[v] : 'Unknown')

export function threeDSLabel(t: FraudView['threeDSecure']): string {
  if (!t) return 'Unknown'
  if (!t.used) return 'Not used'
  return t.result ? `Used — ${t.result.replace(/_/g, ' ')}` : 'Used'
}

export const countryLabel = (c: string | null): string => c ?? 'Unknown'

const EVENT_LABELS: Record<string, string> = {
  review_opened: 'Stripe review opened',
  review_closed: 'Stripe review closed',
  charge_outcome: 'Radar result recorded',
  early_fraud_warning: 'Early fraud warning',
  hold_created: 'Hold created',
  hold_released: 'Hold released',
  hold_not_applied: 'Hold not applied',
  confirmed_fraud: 'Marked as confirmed fraud',
  synced: 'Refreshed from Stripe',
  sync_failed: 'Stripe check failed',
  unmatched_signal: 'Signal received before the order',
}
export const eventLabel = (t: string): string => EVENT_LABELS[t] ?? 'Update'

/** Plain reason a hold was not applied (event detail.why), for the history list. */
export function holdNotAppliedWhy(why: unknown): string {
  if (why === 'holds_disabled') return 'fraud holds are switched off'
  if (typeof why === 'string' && why.startsWith('order_')) return `order is ${why.slice(6)}`
  if (typeof why === 'string' && why.startsWith('payment_')) return `payment is ${why.slice(8)}`
  return 'not applicable'
}

/** Tag chip classes: a small fixed palette, text always shown (no colour-only meaning). */
export const TAG_CHIP_CLASSES: Record<OrderTagColor, string> = {
  neutral: 'border-black/[0.12] bg-[#F5F5F3] text-[#4A4A46]',
  red:     'border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]',
  amber:   'border-[#FDE68A] bg-[#FFFBEB] text-[#92400E]',
  green:   'border-[#BBF7D0] bg-[#F0FDF4] text-[#166534]',
  blue:    'border-[#BFDBFE] bg-[#EFF6FF] text-[#1E40AF]',
  violet:  'border-[#DDD6FE] bg-[#F5F3FF] text-[#5B21B6]',
}
export const tagChipClass = (c: string): string => TAG_CHIP_CLASSES[c as OrderTagColor] ?? TAG_CHIP_CLASSES.neutral

export const CANCEL_WARNING = 'Returns stock at original cost and cancels the order. This cannot be undone.'
