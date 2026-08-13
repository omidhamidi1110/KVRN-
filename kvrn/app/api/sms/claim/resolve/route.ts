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

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ success: false, reason: 'invalid' }, { status: 400 })
  }

  const rawToken = typeof body.token === 'string' ? body.token.trim() : null
  if (!rawToken) {
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
