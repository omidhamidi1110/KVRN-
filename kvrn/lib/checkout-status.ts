// lib/checkout-status.ts — shared public-safe Stripe Checkout Session ID validator
// Accepts both Stripe test-mode and live-mode Checkout Session IDs.
// Import this in both the status route and tests — never copy the regex.

const CHECKOUT_SESSION_RE = /^cs_(?:test|live)_[A-Za-z0-9_]{10,220}$/

/** Returns true for structurally valid Stripe Checkout Session IDs. */
export function isValidCheckoutSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && CHECKOUT_SESSION_RE.test(sessionId)
}
