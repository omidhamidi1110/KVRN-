// This legacy public phone-only endpoint cannot authenticate ownership of a number.
// An unauthenticated caller must never suppress somebody else's subscriber record.
// Verified Twilio inbound STOP, and support-verified consent revocations, remain valid.
import { NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'
export async function POST() {
  return NextResponse.json({ success: false,
    error: 'To stop KVRN marketing texts, reply STOP to a KVRN text or contact support@kvrn.shop.'
  }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
}
