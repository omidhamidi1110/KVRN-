// POST /api/sms/claim/resolve
// Browser presents its raw claim token; server resolves it to an SMS discount code
// if (and only if) the Twilio inbound webhook has already confirmed the claim.
//
// Security properties:
//   - No phone number accepted or used (prevents phone-number lookup attacks)
//   - Token is 160-bit random — unguessable
//   - Claim must be CONFIRMED by Twilio before resolve succeeds
//   - Single-use: CONSUMED after successful resolve (prevents replay)
//   - Subscriber must be currently subscribed
//   - Discount must be unused and active
//   - This is offer DISCOVERY only — checkout still validates via V58.4 system
import { type NextRequest, NextResponse } from 'next/server'
import { resolveSmsSignupClaim } from '@/lib/sms-signup-claims'
import { readLimitedJson } from '@/lib/limited-json-request'
import { allowPublicApiRequest } from '@/lib/public-api-rate-limit'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    try {
      const allowed = await allowPublicApiRequest(sql, { bucket: 'sms_claim_resolve', headers: req.headers, limit: 20, windowSeconds: 600 })
      if (!allowed) return NextResponse.json({ success: false, reason: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '600' } })
    } catch { return NextResponse.json({ success: false, reason: 'unavailable' }, { status: 503 }) }
  }
  const read = await readLimitedJson(req, 1024)
  if (!read.ok || !read.value || typeof read.value !== 'object' || Array.isArray(read.value)) {
    return NextResponse.json({ success: false, reason: 'invalid' }, { status: read.ok ? 400 : read.status })
  }
  const body = read.value as Record<string, unknown>
  const rawToken = typeof body.token === 'string' ? body.token.trim() : null
  if (!rawToken || rawToken.length > 256) {
    return NextResponse.json({ success: false, reason: 'invalid' }, { status: 400 })
  }

  try {
    const result = await resolveSmsSignupClaim(rawToken)
    if (result.ok) {
      return NextResponse.json({ success: true, discountCode: result.discountCode })
    }
    return NextResponse.json({ success: false, reason: result.reason })
  } catch (err: any) {
    console.error('[sms/claim/resolve] error:', err?.message?.slice(0, 80))
    return NextResponse.json({ success: false, reason: 'server_error' }, { status: 500 })
  }
}
