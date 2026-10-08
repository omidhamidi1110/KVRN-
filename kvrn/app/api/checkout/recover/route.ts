// POST /api/checkout/recover  { t }  — validate a recovery link and hand back the REBUILT bag.
//
// Never trusts the client: the token is verified (HMAC, purpose, expiry), the row must be a
// sent reminder, then every line is re-read from the canonical tables (stock, active, CURRENT
// price) and the discount is re-validated. No stock is reserved here; the unchanged checkout
// creates the fresh reservation. Expired / forged / used-up links answer with a friendly JSON
// status, never a 500. With the feature flag OFF the link is disabled (404).
import { type NextRequest, NextResponse } from 'next/server'
import { abandonedService, resumeService } from '@/lib/abandoned-checkout-runtime'
import { readLimitedJson } from '@/lib/limited-json-request'
import { ABANDONED_RECOVERY_COOKIE } from '@/lib/abandoned-checkout-token'
import { AFFILIATE_SESSION_COOKIE, sessionCookieOptions } from '@/lib/affiliate-session'
import { sql } from '@/lib/db'
import { allowPublicApiRequest, PublicRateLimitConfigError } from '@/lib/public-api-rate-limit'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }
const RECOVER_COOKIE_MAX_AGE = 24 * 60 * 60
const MAX_BODY_BYTES = 2 * 1024

export async function POST(req: NextRequest) {
  const read = await readLimitedJson(req, MAX_BODY_BYTES)
  if (!read.ok) return NextResponse.json({ status:'invalid' }, { status:read.status, headers:NO_STORE })
  const token = read.value && typeof read.value === 'object' && !Array.isArray(read.value)
    ? (read.value as Record<string, unknown>).t : undefined

  const res = await abandonedService.resolveRecovery(token)
  switch (res.status) {
    case 'disabled':       return NextResponse.json({ status: 'disabled' }, { status: 404, headers: NO_STORE })
    case 'unconfigured':   return NextResponse.json({ status: 'unconfigured' }, { status: 503, headers: NO_STORE })
    case 'invalid':        return NextResponse.json({ status: 'invalid' }, { status: 400, headers: NO_STORE })
    case 'expired':        return NextResponse.json({ status: 'expired' }, { status: 410, headers: NO_STORE })
    case 'already_ordered':return NextResponse.json({ status: 'already_ordered' }, { headers: NO_STORE })
  }

  // A valid signed token is required before this point, so invalid internet traffic never reaches
  // the database-backed limiter. Limit the more expensive resume/reprice path in deployed Workers.
  if (process.env.NODE_ENV === 'production') {
    try {
      const allowed = await allowPublicApiRequest(sql, { bucket: 'checkout_recover', headers: req.headers, limit: 120, windowSeconds: 60 })
      if (!allowed) {
        return NextResponse.json({ status: 'rate_limited' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': '60' } })
      }
    } catch (err) {
      if (!(err instanceof PublicRateLimitConfigError)) console.error('[abandoned] recovery rate limit failed')
      return NextResponse.json({ status: 'unavailable' }, { status: 503, headers: NO_STORE })
    }
  }

  const row = res.row
  await abandonedService.recordClick(row)
  const out = await resumeService.resume(row)
  if (!out.ok) {
    return NextResponse.json({ status: 'unavailable', reason: out.code }, { headers: NO_STORE })
  }
  await abandonedService.recordResumed(row, { lines: out.lines.length, priceChanged: out.priceChanged })

  const response = NextResponse.json({
    status: 'ok',
    cart: out.cart,
    lines: out.lines,
    subtotalCents: out.subtotalCents,
    priceChanged: out.priceChanged,
    currency: out.currency,
    discount: out.discount,
    notices: out.notices,
    redirectTo: '/checkout',
  }, { headers: NO_STORE })

  // Lets the unchanged checkout link the NEW session back to this recovery (read server-side,
  // signed, httpOnly). It carries no data of its own.
  response.cookies.set(ABANDONED_RECOVERY_COOKIE, String(token), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: RECOVER_COOKIE_MAX_AGE,
  })
  // Same opaque id the visitor's browser held originally — only when no attribution cookie is
  // present (never overwrite a newer referral) and only with a real click behind it.
  if (out.affiliateSessionId && !req.cookies.get(AFFILIATE_SESSION_COOKIE)?.value) {
    response.cookies.set(AFFILIATE_SESSION_COOKIE, out.affiliateSessionId, sessionCookieOptions)
  }
  return response
}
