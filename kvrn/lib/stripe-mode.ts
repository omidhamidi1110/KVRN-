// lib/stripe-mode.ts — Stripe mode + checkout gate. Pure and dependency-free so it can
// be imported anywhere (and mocked around) without pulling in the Stripe SDK.
//
// SERVER-SIDE ONLY. Nothing here reads a NEXT_PUBLIC_ variable, and no secret value is
// ever returned or logged: callers get a mode, a boolean, or an error that names the
// VARIABLE, never its contents.
//
// ── MODEL ────────────────────────────────────────────────────────────────────
//   STRIPE_MODE        'test' (default when unset) | 'live'. Anything else FAILS CLOSED.
//   STRIPE_SECRET_KEY  must match the mode: sk_test_… in test, sk_live_… in live.
//
// A live key is therefore never accepted by accident: a developer machine, preview
// deployment or CI job that happens to hold an sk_live_ key but has not set
// STRIPE_MODE=live is rejected, and so is an sk_test_ key under STRIPE_MODE=live.
// Restricted keys (rk_…) remain unsupported in both modes.
//
// ── CHECKOUT GATE ────────────────────────────────────────────────────────────
//   ENABLE_CHECKOUT                canonical. Must be exactly 'true' to open checkout.
//   ENABLE_STRIPE_TEST_CHECKOUT    legacy, kept for backward compatibility. It can only
//                                  ever open checkout in TEST mode, and only while
//                                  ENABLE_CHECKOUT is not set at all.
//   Default (neither set): CLOSED.

export type StripeMode = 'test' | 'live'

// sk_<mode>_ + at least 24 more chars + only base64url-safe chars
const SK_TEST_RE = /^sk_test_[A-Za-z0-9_]{24,}$/
const SK_LIVE_RE = /^sk_live_[A-Za-z0-9_]{24,}$/

/** True only for a well-formed Stripe TEST secret key. */
export function isValidStripeTestSecretKey(value: unknown): value is string {
  return typeof value === 'string' && SK_TEST_RE.test(value)
}

/** True only for a well-formed Stripe LIVE secret key. */
export function isValidStripeLiveSecretKey(value: unknown): value is string {
  return typeof value === 'string' && SK_LIVE_RE.test(value)
}

/**
 * Resolve the deliberate Stripe mode. Unset/blank means 'test'. Any other value than
 * 'test' or 'live' (case-insensitive, trimmed) throws: a typo must never fall through
 * to either mode.
 */
export function resolveStripeMode(raw: string | undefined = process.env.STRIPE_MODE): StripeMode {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === '' || v === 'test') return 'test'
  if (v === 'live') return 'live'
  throw new Error('STRIPE_MODE must be "test" or "live".')
}

/**
 * Validate a secret key against a mode and return it, or throw a message that names
 * the variables involved but never echoes the key.
 */
export function assertStripeKeyForMode(key: string, mode: StripeMode): string {
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set.')
  if (mode === 'live') {
    if (isValidStripeLiveSecretKey(key)) return key
    throw new Error(
      'STRIPE_MODE=live requires STRIPE_SECRET_KEY to be a valid sk_live_ key. ' +
      'Test and restricted keys are not permitted in live mode.')
  }
  if (isValidStripeTestSecretKey(key)) return key
  if (isValidStripeLiveSecretKey(key)) {
    throw new Error(
      'STRIPE_SECRET_KEY is a live key but STRIPE_MODE is not "live". ' +
      'Set STRIPE_MODE=live to opt in to live payments explicitly.')
  }
  throw new Error(
    'STRIPE_SECRET_KEY must be a valid sk_test_ key (or an sk_live_ key with STRIPE_MODE=live). ' +
    'Restricted keys are not permitted.')
}

/** Whether the checkout endpoint is open. Defaults CLOSED. */
export function isCheckoutEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const canonical = (env.ENABLE_CHECKOUT ?? '').trim()
  if (canonical !== '') return canonical === 'true'
  // Legacy flag: test mode only. It must never be able to open live checkout.
  let mode: StripeMode
  try { mode = resolveStripeMode(env.STRIPE_MODE) } catch { return false }
  return mode === 'test' && (env.ENABLE_STRIPE_TEST_CHECKOUT ?? '') === 'true'
}
