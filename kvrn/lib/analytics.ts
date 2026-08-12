// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS HELPERS — GA4
//
// Client-side events are sent via the gtag() function loaded in layout.tsx.
// Use these typed helpers instead of calling gtag() directly.
//
// Server-side events (Measurement Protocol) for purchases confirmed
// via webhook — ensures purchase is recorded even if customer closes
// the browser before the confirmation page loads.
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
    dataLayer?: unknown[]
  }
}

// ─── TYPE DEFINITIONS ────────────────────────────────────────────────────────

interface GtagItem {
  item_id:       string
  item_name:     string
  item_variant?: string
  item_category?: string
  price:         number
  quantity:      number
}

// ─── SAFE GTAG WRAPPER ────────────────────────────────────────────────────────
function gtag(command: string, ...args: unknown[]): void {
  if (typeof window === 'undefined' || !window.gtag) return
  window.gtag(command, ...args)
}

// ─── E-COMMERCE EVENTS ───────────────────────────────────────────────────────

export function trackViewItem(params: {
  itemId:   string
  itemName: string
  price:    number // in pence
  category: string
}) {
  gtag('event', 'view_item', {
    currency: 'GBP',
    value:    params.price / 100,
    items: [{
      item_id:       params.itemId,
      item_name:     params.itemName,
      item_category: params.category,
      price:         params.price / 100,
      quantity:      1,
    }],
  })
}

export function trackAddToCart(params: {
  itemId:      string
  itemName:    string
  variant:     string // "Stone / L"
  price:       number // in pence
  quantity:    number
  cartTotal:   number // in pence
}) {
  gtag('event', 'add_to_cart', {
    currency: 'GBP',
    value:    params.price / 100,
    items: [{
      item_id:      params.itemId,
      item_name:    params.itemName,
      item_variant: params.variant,
      price:        params.price / 100,
      quantity:     params.quantity,
    }],
  })
}

export function trackBeginCheckout(params: {
  value:       number // in pence
  items:       GtagItem[]
  couponCode?: string
}) {
  gtag('event', 'begin_checkout', {
    currency:    'GBP',
    value:       params.value / 100,
    coupon:      params.couponCode,
    items:       params.items,
  })
}

export function trackPurchase(params: {
  transactionId: string
  value:         number // in pence (total)
  shipping:      number // in pence
  tax:           number // in pence
  items:         GtagItem[]
}) {
  gtag('event', 'purchase', {
    transaction_id: params.transactionId,
    currency:       'GBP',
    value:          params.value / 100,
    shipping:       params.shipping / 100,
    tax:            params.tax / 100,
    items:          params.items,
  })
}

// ─── KVRN CUSTOM EVENTS ──────────────────────────────────────────────────────

export function trackWaitlistSignup(source: string) {
  gtag('event', 'waitlist_signup', { source })
}

export function trackSizeGuideOpen(productId: string) {
  gtag('event', 'size_guide_open', { product_id: productId })
}

export function trackColorSelected(productId: string, color: string) {
  gtag('event', 'color_selected', { product_id: productId, color })
}

export function trackSetUpsellView(triggerProduct: string) {
  gtag('event', 'set_upsell_view', { trigger_product: triggerProduct })
}

export function trackSetUpsellConvert(triggerProduct: string, newValue: number) {
  gtag('event', 'set_upsell_convert', {
    trigger_product: triggerProduct,
    new_cart_value:  newValue / 100,
  })
}

export function trackNotifyMeClick(productId: string, variant: string) {
  gtag('event', 'notify_me_click', { product_id: productId, variant })
}

export function trackReturnInitiated(orderId: string, reason: string) {
  gtag('event', 'return_initiated', { order_id: orderId, reason })
}

// ─── SERVER-SIDE: MEASUREMENT PROTOCOL ───────────────────────────────────────
// Sends a purchase event server-side via GA4 Measurement Protocol.
// Called from the Stripe webhook handler after payment confirmation.
// This ensures the purchase is recorded even if the customer never
// reaches the confirmation page.

export async function serverTrackPurchase(params: {
  clientId:      string // GA4 client ID from cookie (_ga)
  transactionId: string
  value:         number // in pence
  shipping:      number // in pence
  tax:           number // in pence
  items:         Array<{ id: string; name: string; variant: string; price: number; quantity: number }>
}): Promise<void> {
  const measurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID
  const apiSecret     = process.env.GA4_MEASUREMENT_PROTOCOL_SECRET

  if (!measurementId || !apiSecret) {
    // Silently skip — analytics is optional, never block order processing
    return
  }

  try {
    await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: params.clientId,
          events: [{
            name:   'purchase',
            params: {
              transaction_id: params.transactionId,
              currency:       'GBP',
              value:          params.value / 100,
              shipping:       params.shipping / 100,
              tax:            params.tax / 100,
              items:          params.items.map(i => ({
                item_id:      i.id,
                item_name:    i.name,
                item_variant: i.variant,
                price:        i.price / 100,
                quantity:     i.quantity,
              })),
            },
          }],
        }),
      }
    )
  } catch (err) {
    // Non-fatal — log but don't throw
    console.error('[analytics] Measurement Protocol failed:', err)
  }
}

// ─── SMS POPUP ANALYTICS ──────────────────────────────────────────────────────
// Call these from the SmsPopup component. Never pass phone numbers as properties.

export type SmsAnalyticsEvent =
  | 'sms_offer_view'     // popup becomes visible
  | 'sms_offer_accept'   // user interacts positively (clicks any CTA)
  | 'sms_offer_decline'  // user clicks X or NO THANKS
  | 'sms_manual_submit'  // user submits manual phone field
  | 'sms_signup_success' // server returns 200
  | 'sms_signup_error'   // server returns error or network failure
  | 'sms_deeplink_open'  // user taps mobile SMS:// CTA
  | 'sms_offer_reopen'   // user clicks persistent $10 OFF tab

export function trackSmsEvent(event: SmsAnalyticsEvent): void {
  try {
    if (typeof window !== 'undefined' && window.gtag) {
      window.gtag('event', event, { event_category: 'sms_popup' })
    }
  } catch {
    // Never throw — analytics must never break the UI
  }
}
