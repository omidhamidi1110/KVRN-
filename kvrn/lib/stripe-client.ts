// lib/stripe-client.ts — Cloudflare Workers compatible, test-mode enforced
import Stripe from 'stripe'

// sk_test_ + at least 24 more chars + only base64url-safe chars
const SK_TEST_RE = /^sk_test_[A-Za-z0-9_]{24,}$/

/** Returns true only for valid Stripe test secret keys. */
export function isValidStripeTestSecretKey(value: unknown): value is string {
  return typeof value === 'string' && SK_TEST_RE.test(value)
}

/** Returns a Cloudflare-compatible Stripe instance.
 *  Requires STRIPE_SECRET_KEY to match sk_test_ with realistic length. */
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY ?? ''
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set.')
  if (!isValidStripeTestSecretKey(key)) {
    throw new Error(
      'STRIPE_SECRET_KEY must start with sk_test_ and be a valid Stripe test key. Live and restricted keys are not permitted.'
    )
  }
  return new Stripe(key, {
    apiVersion: '2024-06-20',
    httpClient: Stripe.createFetchHttpClient(),
  })
}

/** Validate STRIPE_WEBHOOK_SECRET format (must start with whsec_). */
export function isValidWebhookSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('whsec_') && value.length > 10
}

/** Cloudflare Workers-safe webhook verification (SubtleCrypto, no Node crypto). */
export async function verifyWebhookSignature(
  rawBody: string, signature: string, secret: string
): Promise<Stripe.Event> {
  if (!isValidWebhookSecret(secret)) {
    throw new Error('STRIPE_WEBHOOK_SECRET is missing or malformed.')
  }
  const stripe = getStripe()
  return stripe.webhooks.constructEventAsync(
    rawBody, signature, secret, undefined,
    Stripe.createSubtleCryptoProvider()
  )
}

export type { Stripe }
