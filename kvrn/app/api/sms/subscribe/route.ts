// POST /api/sms/subscribe — Public marketing SMS opt-in endpoint.
// Source spoofing protection: only PUBLIC_SMS_SOURCES accepted; internal sources rejected.
// Neon stores consent first. Unique SMS discount code generated and returned on success.
import { type NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(_req: NextRequest) {
  // Web-entered phone number does not prove control of the number. Fail closed.
  // The verified inbound Twilio JOIN → YES confirmation flow is the only enrollment path.
  return NextResponse.json({ success: false,
    error: 'To join KVRN texts, message JOIN to the official KVRN number and reply YES to confirm.' },
    { status: 409, headers: { 'Cache-Control': 'no-store' } })
}
