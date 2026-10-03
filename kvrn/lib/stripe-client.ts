// lib/stripe-client.ts — Cloudflare Workers compatible; Stripe test OR live mode, chosen
// deliberately via STRIPE_MODE (see lib/stripe-mode.ts). Fails closed on any mismatch.
import Stripe from 'stripe'
import {
  assertStripeKeyForMode,
  resolveStripeMode,
  isValidStripeTestSecretKey,
  isValidStripeLiveSecretKey,
} from './stripe-mode'

export { isValidStripeTestSecretKey, isValidStripeLiveSecretKey, resolveStripeMode }
export type { StripeMode } from './stripe-mode'

/** Returns a Cloudflare-compatible Stripe instance for the configured mode.
 *  STRIPE_MODE unset/"test" requires an sk_test_ key; STRIPE_MODE=live requires sk_live_. */
export function getStripe(): Stripe {
  const key = assertStripeKeyForMode(process.env.STRIPE_SECRET_KEY ?? '', resolveStripeMode())
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
