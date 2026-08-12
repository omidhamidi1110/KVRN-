// POST /api/sms/unsubscribe — Public SMS opt-out. Idempotent. Does not affect email.
import { type NextRequest, NextResponse } from 'next/server'
import { normalizePhoneE164 } from '@/lib/phone'
import { unsubscribeSmsPhone } from '@/lib/sms-subscribers'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ success: false, error: 'Invalid request.' }, { status: 400 })
  }

  const rawPhone = body.phone
  if (!rawPhone || typeof rawPhone !== 'string') {
    return NextResponse.json({ success: false, error: 'Phone number is required.' }, { status: 400 })
  }

  const phoneE164 = normalizePhoneE164(rawPhone)
  if (!phoneE164) {
    return NextResponse.json({ success: false, error: 'Invalid phone number.' }, { status: 400 })
  }

  try {
    await unsubscribeSmsPhone(phoneE164)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[sms/unsubscribe] DB error:', err?.message?.slice(0, 80))
    return NextResponse.json({ success: false, error: 'Server error.' }, { status: 500 })
  }
}
