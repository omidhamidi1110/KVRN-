// lib/checkout-status.ts — shared public-safe session ID validator
// Only cs_test_ IDs are accepted. Live session IDs are rejected in test mode.
// Import this in both the status route and tests — never copy the regex.

const CS_TEST_RE = /^cs_test_[A-Za-z0-9_]{10,220}$/

/** Returns true only for valid Stripe test-mode Checkout Session IDs. */
export function isValidTestCheckoutSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && CS_TEST_RE.test(sessionId)
}
