// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS HELPERS — GA4 (typed, consent-gated)
//
// Thin typed wrappers over lib/ga-client.ts. EVERY call is gated there on the existing analytics
// consent (cookie preferences), Do Not Track and Global Privacy Control; before consent GA is not
// even loaded and these are silent no-ops. Do not call window.gtag directly anywhere else.
//
// Purchase is intentionally NOT here: it is canonical and server-side (lib/ga4-server.ts, sent from
// the Stripe webhook), so the browser can never create a duplicate GA purchase.
//
// Money: KVRN money is integer cents; GA's currency-unit conversion happens only in lib/ga-common.ts.
// Never pass PII (names, emails, phone numbers, addresses) to any of these.
// ─────────────────────────────────────────────────────────────────────────────

import { gaEventWhenReady as gaEvent } from './ga-client'

export { gaViewItem, gaAddToCart, gaBeginCheckout, gaPageView, getGaIdentifiers } from './ga-client'

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
    dataLayer?: unknown[]
  }
}

// ─── KVRN CUSTOM EVENTS (scalar, non-PII params only) ────────────────────────

export function trackWaitlistSignup(source: string) {
  gaEvent('waitlist_signup', { source })
}

export function trackSizeGuideOpen(productId: string) {
  gaEvent('size_guide_open', { product_id: productId })
}

export function trackColorSelected(productId: string, color: string) {
  gaEvent('color_selected', { product_id: productId, color })
}

export function trackSetUpsellView(triggerProduct: string) {
  gaEvent('set_upsell_view', { trigger_product: triggerProduct })
}

export function trackSetUpsellConvert(triggerProduct: string, newValueCents: number) {
  if (!Number.isSafeInteger(newValueCents) || newValueCents < 0) return
  gaEvent('set_upsell_convert', { trigger_product: triggerProduct, new_cart_value: Number((newValueCents / 100).toFixed(2)) })
}

export function trackNotifyMeClick(productId: string, variant: string) {
  gaEvent('notify_me_click', { product_id: productId, variant })
}

export function trackReturnInitiated(orderId: string, reason: string) {
  gaEvent('return_initiated', { order_id: orderId, reason })
}

// ─── SMS POPUP ANALYTICS ──────────────────────────────────────────────────────
// The canonical event names. components/sms/SmsPopup.tsx and lib/sms-signup.ts call trackSmsEvent
// with these literals ONLY (no cast): an undeclared name is a compile error. Never pass phone
// numbers, discount codes or any other value as properties — the only param is event_category.
//
// Where each is emitted:
//   sms_offer_view     popup becomes visible (5 s timer)
//   sms_offer_decline  X / backdrop / Escape / NO THANKS (not the close of the "You're in" screen)
//   sms_offer_reopen   persistent $10 OFF / JOIN THE LIST tab
//   sms_deeplink_open  mobile sms: CTA tapped
//   sms_manual_submit  manual phone form submitted (validation passed, request starting)
//   sms_signup_success server answered success
//   sms_signup_error   server error / success:false / network failure
//   sms_offer_accept   RESERVED — declared but intentionally NOT emitted: the popup has no positive
//                      action distinct from sms_deeplink_open / sms_manual_submit + success, and none is
//                      fabricated. Emit it only if such a CTA is ever added.

export type SmsAnalyticsEvent =
  | 'sms_offer_view'
  | 'sms_offer_accept'
  | 'sms_offer_decline'
  | 'sms_manual_submit'
  | 'sms_signup_success'
  | 'sms_signup_error'
  | 'sms_deeplink_open'
  | 'sms_offer_reopen'

export function trackSmsEvent(event: SmsAnalyticsEvent): void {
  gaEvent(event, { event_category: 'sms_popup' })
}
