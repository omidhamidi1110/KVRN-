// lib/sms-signup-claims.ts — Browser claim token helpers
// Server-only. Implements the browser↔Twilio↔subscriber linkage
// without exposing phone numbers through an unauthenticated lookup endpoint.
//
// Security properties:
//   - 160-bit cryptographic random token (unforgeable)
//   - Only SHA-256 hash stored in DB (database breach yields no usable tokens)
//   - Only the authenticated Twilio inbound webhook can bind token → subscriber
//   - Browser presents raw token; server hashes and looks up — no phone number needed

import { sql } from './db'

const TOKEN_TTL_MS = 60 * 60 * 1000  // 60 minutes

// ── Token generation ──────────────────────────────────────────────────────────

/** Generate a 160-bit cryptographically random base64url token (27 chars). */
export function generateRawToken(): string {
  const bytes = new Uint8Array(20)  // 160 bits
  crypto.getRandomValues(bytes)
  // Encode as base64url (no padding, URL-safe: replaces +/ with -_)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/** SHA-256 hash of a raw token string, returned as lowercase hex. */
export async function hashToken(rawToken: string): Promise<string> {
  const encoded = new TextEncoder().encode(rawToken)
  const hashBuf  = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Claim lifecycle ───────────────────────────────────────────────────────────

/**
 * Create a pending claim.
 * Returns the raw token (returned once to the browser — never stored).
 * Stores only the SHA-256 hash.
 */
export async function createSmsSignupClaim(): Promise<{ rawToken: string; expiresAt: string }> {
  const rawToken  = generateRawToken()
  const tokenHash = await hashToken(rawToken)
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS)

  await sql`
    INSERT INTO sms_signup_claims (token_hash, status, expires_at)
    VALUES (${tokenHash}, 'pending', ${expiresAt.toISOString()})
  `
  return { rawToken, expiresAt: expiresAt.toISOString() }
}

/**
 * Confirm a claim from an authenticated Twilio inbound webhook.
 * Called ONLY after Twilio signature validation.
 * Associates the claim with the verified subscriber (phone owner = Twilio From field).
 * Silently succeeds if token is malformed, expired, or not found —
 * so that ordinary JOIN without a claim token continues to work.
 */
export async function confirmSmsSignupClaim(opts: {
  rawToken:     string
  subscriberId: string
}): Promise<boolean> {
  if (!opts.rawToken || opts.rawToken.length < 20) return false
  try {
    const tokenHash = await hashToken(opts.rawToken)
    const rows = await sql`
      UPDATE sms_signup_claims
      SET status = 'confirmed', subscriber_id = ${opts.subscriberId}, confirmed_at = NOW()
      WHERE token_hash = ${tokenHash}
        AND status     = 'pending'
        AND expires_at > NOW()
      RETURNING id
    `
    return (rows as any[]).length > 0
  } catch (err: any) {
    // Non-fatal — ordinary JOIN still succeeds even if claim confirmation fails
    console.error('[sms-claim] confirmSmsSignupClaim error:', err?.message?.slice(0, 60))
    return false
  }
}

/**
 * Resolve a claim from the browser checkout.
 * Browser presents only the raw token — no phone number.
 * Atomically transitions CONFIRMED → CONSUMED.
 * Returns the subscriber's unused system-managed SMS discount code.
 */
export type ClaimResolveReason =
  | 'invalid' | 'unconfirmed' | 'expired'
  | 'already_consumed' | 'unsubscribed' | 'no_eligible_offer' | 'temporary_failure'

/**
 * Resolve a browser claim token to an SMS discount code.
 *
 * Uses a SINGLE atomic CTE that only marks the claim CONSUMED when ALL conditions
 * are simultaneously true:
 *   - token matches a confirmed, unexpired, unconsumed claim
 *   - subscriber is currently subscribed (STOP after JOIN → unsubscribed → rejected)
 *   - an eligible SMS welcome discount exists (system_managed, single_use, unredeemed)
 *
 * If any condition fails, the UPDATE does not run and the claim remains
 * CONFIRMED and retryable (transient failures, STOP events, etc.).
 * Only a successful resolve transitions the claim to CONSUMED.
 */
export async function resolveSmsSignupClaim(rawToken: string): Promise<{
  ok: true; discountCode: string
} | {
  ok: false; reason: ClaimResolveReason
}> {
  if (!rawToken || rawToken.length < 20) return { ok: false, reason: 'invalid' }

  const tokenHash = await hashToken(rawToken)

  // Single atomic CTE:
  // 1. Read claim + subscriber + eligible discount in one consistent snapshot
  // 2. UPDATE only runs if all conditions hold (subscribed + eligible discount found)
  // 3. If UPDATE does not run → claim is untouched and retryable
  const rows = await sql`
    WITH
      target AS (
        SELECT
          c.id            AS claim_id,
          c.status        AS claim_status,
          c.expires_at    AS claim_expires,
          c.consumed_at   AS already_consumed,
          ss.status       AS sub_status,
          d.code          AS discount_code
        FROM sms_signup_claims c
        LEFT JOIN sms_subscribers ss ON ss.id = c.subscriber_id
        LEFT JOIN discounts d
          ON  d.subscriber_id    = c.subscriber_id
          AND d.system_managed   = TRUE
          AND d.single_use       = TRUE
          AND d.active           = TRUE
          AND d.redemption_count = 0
          AND (d.expires_at IS NULL OR d.expires_at > NOW())
        WHERE c.token_hash = ${tokenHash}
        ORDER BY d.created_at DESC NULLS LAST
        LIMIT 1
      ),
      consume AS (
        UPDATE sms_signup_claims
        SET status = 'consumed', consumed_at = NOW()
        FROM target
        WHERE sms_signup_claims.id  = target.claim_id
          AND target.claim_status   = 'confirmed'
          AND target.already_consumed IS NULL
          AND target.claim_expires   > NOW()
          AND target.sub_status      = 'subscribed'
          AND target.discount_code   IS NOT NULL
        RETURNING sms_signup_claims.id AS consumed_id
      )
    SELECT
      target.claim_id,
      target.claim_status,
      target.claim_expires,
      target.already_consumed,
      target.sub_status,
      target.discount_code,
      consume.consumed_id
    FROM target
    LEFT JOIN consume ON TRUE
  ` as any[]

  const row = rows[0]

  // No row at all: token hash not found
  if (!row?.claim_id) return { ok: false, reason: 'invalid' }

  // Success: UPDATE ran and discount code was atomically selected
  if (row.consumed_id && row.discount_code) {
    return { ok: true, discountCode: row.discount_code as string }
  }

  // Determine why the UPDATE did not run (claim is still confirmed and retryable
  // for transient/business-logic failures)
  if (row.claim_status !== 'confirmed')   return { ok: false, reason: 'unconfirmed' }
  if (row.already_consumed)              return { ok: false, reason: 'already_consumed' }
  if (new Date(row.claim_expires) <= new Date()) return { ok: false, reason: 'expired' }
  if (row.sub_status !== 'subscribed')   return { ok: false, reason: 'unsubscribed' }
  if (!row.discount_code)                return { ok: false, reason: 'no_eligible_offer' }

  // All conditions appeared true but UPDATE still didn't run
  // (concurrent race — the other request consumed it; or transient DB issue)
  return { ok: false, reason: 'temporary_failure' }
}
