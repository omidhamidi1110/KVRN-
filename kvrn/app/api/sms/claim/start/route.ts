// POST /api/sms/claim/start
// Creates a short-lived pending browser claim token.
// Called before opening Messages, so the token can be embedded in the prefilled SMS body.
// Returns only the raw token — the hash is stored server-side.
// No authentication required — this just reserves a pending slot.
// The token has no value until the Twilio inbound webhook confirms it.
import { type NextRequest, NextResponse } from 'next/server'
import { createSmsSignupClaim } from '@/lib/sms-signup-claims'

export const dynamic = 'force-dynamic'

export async function POST(_req: NextRequest) {
  try {
    const { rawToken, expiresAt } = await createSmsSignupClaim()
    return NextResponse.json({ token: rawToken, expiresAt })
  } catch (err: any) {
    console.error('[sms/claim/start] DB error:', err?.message?.slice(0, 80))
    return NextResponse.json({ error: 'Could not create claim.' }, { status: 500 })
  }
}
