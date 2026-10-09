// POST /api/sms/claim/start
// Creates a short-lived pending browser claim token.
// Called before opening Messages, so the token can be embedded in the prefilled SMS body.
// Returns only the raw token — the hash is stored server-side.
// No authentication required — this just reserves a pending slot.
// The token has no value until the Twilio inbound webhook confirms it.
import { type NextRequest, NextResponse } from 'next/server'
import { createSmsSignupClaim } from '@/lib/sms-signup-claims'
import { sql } from '@/lib/db'
import { allowPublicApiRequest } from '@/lib/public-api-rate-limit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    try {
      const allowed = await allowPublicApiRequest(sql, { bucket: 'sms_claim_start', headers: req.headers, limit: 8, windowSeconds: 600 })
      if (!allowed) return NextResponse.json({ error: 'Too many attempts.' }, { status: 429, headers: { 'Retry-After': '600' } })
    } catch {
      return NextResponse.json({ error: 'SMS claim unavailable.' }, { status: 503 })
    }
  }
  try {
    const { rawToken, expiresAt } = await createSmsSignupClaim()
    return NextResponse.json({ token: rawToken, expiresAt })
  } catch (err: any) {
    console.error('[sms/claim/start] Claim unavailable (redacted).')
    return NextResponse.json({ error: 'Could not create claim.' }, { status: 500 })
  }
}
