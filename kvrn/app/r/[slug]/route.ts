// GET /r/[slug] — public affiliate referral redirect
//
// The only customer-facing surface 020 adds. It is NOT an affiliate portal: it
// exposes no affiliate identity, no commission data and no account, and it
// reveals nothing about whether a slug exists — an unknown slug simply lands on
// the homepage exactly as a known one with no destination would.
//
// Flow: resolve active link -> establish or reuse the first-party session ->
// ensure the analytics session -> record the click -> redirect to a SAFE path.
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import {
  createAffiliateSessionService, generateSessionId, isValidSessionId,
  safeDestinationPath, sessionCookieOptions, AFFILIATE_SESSION_COOKIE,
  normalizeReferrer,
} from '@/lib/affiliate-session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params
  const home = new URL('/', req.nextUrl.origin)

  // Malformed slugs never reach the database.
  if (!slug || !SLUG_RE.test(slug)) {
    return NextResponse.redirect(home, { status: 302 })
  }

  // Reuse an existing session so repeat visits do not fragment identity. Only
  // the SHAPE of the cookie is trusted; a forged value matches no click and
  // grants nothing.
  const existing = req.cookies.get(AFFILIATE_SESSION_COOKIE)?.value
  const sessionId = isValidSessionId(existing) ? existing : generateSessionId()
  const isNew = sessionId !== existing

  const service = createAffiliateSessionService(sql)
  // Origin only: a raw Referer can carry emails, tokens and order ids in its
  // query or path, and none of that belongs in affiliate tables.
  const referrer = normalizeReferrer(req.headers.get('referer'))

  let destination = '/'
  let captured = false
  try {
    // ONE statement: analytics session and affiliate click together. The click is
    // the only record of which affiliate the visitor came through, and the cookie
    // deliberately encodes nothing, so a lost click is an unrecoverable
    // commission obligation — not a missing analytics row.
    const result = await service.captureReferral(slug, sessionId, referrer)
    if (result) { destination = result.destination; captured = true }
  } catch (err: any) {
    console.error('[/r] referral capture failed:', err?.message?.slice(0, 120))

    // Distinguish a genuine referral we FAILED to capture from a slug that
    // simply is not a referral. Only the former may block the visitor.
    let isLive = false
    try {
      isLive = await service.slugIsLiveReferral(slug)
    } catch {
      // Cannot tell. Treating "unknown" as "not a referral" is exactly the
      // failure mode that loses obligations, so assume it was one.
      isLive = true
    }

    if (isLive) {
      // Explicit retryable failure. A successful redirect with a fresh cookie
      // would be indistinguishable downstream from a forged cookie, and the
      // affiliate identity could never be reconstructed.
      return NextResponse.json(
        { error: 'We could not start that referral. Please try again in a moment.' },
        { status: 503 })
    }
    // Not a live referral: fall through to the safe homepage redirect.
  }

  // Stored paths are still normalised: a tampered or mistyped destination must
  // not become an open redirect.
  const safePath = safeDestinationPath(destination)
  const res = NextResponse.redirect(new URL(safePath, req.nextUrl.origin), { status: 302 })

  // A NEW cookie is only issued once a referral was durably captured. Issuing one
  // after a failed capture would imply the referral was recorded when it was not.
  if (isNew && captured) {
    res.cookies.set(AFFILIATE_SESSION_COOKIE, sessionId, sessionCookieOptions)
  }
  return res
}
