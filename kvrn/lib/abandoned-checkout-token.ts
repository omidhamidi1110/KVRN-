// lib/abandoned-checkout-token.ts — signed, opaque, expiring tokens for recovery links.
//
// A token is bound to ONE abandoned checkout and ONE purpose:
//
//   recover       /checkout/recover?t=<token>             rebuilds the bag
//   unsubscribe   /api/checkout/recover/unsubscribe?t=…   stops recovery emails
//
// FORMAT   v1.<base64url(JSON {p,a,e})>.<base64url(HMAC-SHA256)>
//   p  purpose            a  abandoned-checkout id (a random UUID that exists only for this
//   e  expiry, unix secs     feature: it is NOT an order, session, reservation or customer id)
//
// The signature covers the version tag and the payload, so changing the id, purpose or expiry
// invalidates it. Comparison is constant-time. Nothing secret is inside the token; the server
// secret never leaves the server.
//
// SECRET  ABANDONED_LINK_SECRET (new, optional, >= 32 chars). When it is missing or too short,
// getLinkSecret() returns null and callers FAIL CLOSED: no email is sent and the recovery
// page answers "not available" (HTTP 503 from the API). It is deliberately NOT derived from
// CRON_SECRET / STRIPE_* / ADMIN secrets, so rotating or leaking one never affects the other.

import { createHmac, timingSafeEqual } from 'crypto'

/** First-party cookie set when a visitor resumes from a recovery link (value = the signed recover token). */
export const ABANDONED_RECOVERY_COOKIE = 'kvrn_recover'

export type TokenPurpose = 'recover' | 'unsubscribe'

const PURPOSE_CODE: Record<TokenPurpose, string> = { recover: 'r', unsubscribe: 'u' }
const VERSION = 'v1'
const MAX_TOKEN_LENGTH = 400
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MIN_SECRET_LENGTH = 32

type EnvLike = Record<string, string | undefined>

/** The signing secret, or null when it is absent / too short (callers must fail closed). */
export function getLinkSecret(env: EnvLike = process.env as EnvLike): string | null {
  const s = (env.ABANDONED_LINK_SECRET ?? '').trim()
  return s.length >= MIN_SECRET_LENGTH ? s : null
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

export function signToken(
  secret: string,
  opts: { purpose: TokenPurpose; id: string; expiresAtSec: number },
): string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) throw new Error('Link secret is not configured.')
  if (!UUID_RE.test(opts.id)) throw new Error('Invalid id.')
  if (!Number.isFinite(opts.expiresAtSec)) throw new Error('Invalid expiry.')
  const payload = b64u(JSON.stringify({ p: PURPOSE_CODE[opts.purpose], a: opts.id.toLowerCase(), e: Math.floor(opts.expiresAtSec) }))
  const body = `${VERSION}.${payload}`
  return `${body}.${b64u(mac(secret, body))}`
}

export type VerifyResult =
  | { ok: true; id: string; expiresAtSec: number }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'wrong_purpose' | 'expired' }

/** Never throws. Any structural problem is 'malformed'; a wrong MAC is 'bad_signature'. */
export function verifyToken(
  secret: string,
  token: unknown,
  purpose: TokenPurpose,
  nowSec: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  try {
    if (typeof token !== 'string' || token.length < 10 || token.length > MAX_TOKEN_LENGTH) {
      return { ok: false, reason: 'malformed' }
    }
    if (!secret || secret.length < MIN_SECRET_LENGTH) return { ok: false, reason: 'malformed' }
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' }
    if (!/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) {
      return { ok: false, reason: 'malformed' }
    }
    const given = Buffer.from(parts[2], 'base64url')

    // Reject noncanonical Base64URL encodings.
    // Unused trailing bits must not allow alternate spellings
    // of the exact same cryptographic signature.
    if (given.toString('base64url') !== parts[2]) {
      return { ok: false, reason: 'malformed' }
    }

    const expected = mac(secret, `${parts[0]}.${parts[1]}`)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, reason: 'bad_signature' }
    }
    // The signature is valid, so the payload was produced by us; still parse defensively.
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!payload || typeof payload.a !== 'string' || !UUID_RE.test(payload.a)
        || typeof payload.e !== 'number' || !Number.isFinite(payload.e) || typeof payload.p !== 'string') {
      return { ok: false, reason: 'malformed' }
    }
    if (payload.p !== PURPOSE_CODE[purpose]) return { ok: false, reason: 'wrong_purpose' }
    if (nowSec >= payload.e) return { ok: false, reason: 'expired' }
    return { ok: true, id: payload.a.toLowerCase(), expiresAtSec: payload.e }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}
