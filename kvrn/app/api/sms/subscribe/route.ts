// POST /api/sms/subscribe — Public marketing SMS opt-in endpoint.
// Source spoofing protection: only PUBLIC_SMS_SOURCES accepted; internal sources rejected.
// Neon stores consent first. Unique SMS discount code generated and returned on success.
import { type NextRequest, NextResponse } from 'next/server'
import { normalizePhoneE164 } from '@/lib/phone'
import { upsertSmsSubscriber, PUBLIC_SMS_SOURCES } from '@/lib/sms-subscribers'
import { upsertSmsDiscountCode, isSmsOfferActive } from '@/lib/discounts'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // Basic content-type check
  const ct = req.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    return NextResponse.json({ success: false, error: 'Invalid request.' }, { status: 400 })
  }

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ success: false, error: 'Invalid request.' }, { status: 400 })
  }

  const rawPhone = body.phone
  if (!rawPhone || typeof rawPhone !== 'string' || rawPhone.length > 30) {
    return NextResponse.json({ success: false, error: 'Phone number is required.' }, { status: 400 })
  }

  const phoneE164 = normalizePhoneE164(rawPhone)
  if (!phoneE164) {
    return NextResponse.json(
      { success: false, error: 'Enter a valid US or Canadian phone number.' },
      { status: 400 }
    )
  }

  // Source allowlist — PUBLIC only. Internal sources (manual_admin, sms_keyword) are REJECTED.
  const rawSource = body.source
  if (rawSource !== undefined && !PUBLIC_SMS_SOURCES.has(rawSource)) {
    // Reject explicitly invalid/internal sources rather than silently mapping them
    return NextResponse.json(
      { success: false, error: 'Invalid request.' },
      { status: 400 }
    )
  }
  const source = PUBLIC_SMS_SOURCES.has(rawSource) ? rawSource : 'homepage'

  let subscriberId: string
  try {
    const result = await upsertSmsSubscriber({ phoneE164, consentSource: source })
    subscriberId  = result.id
  } catch (err: any) {
    console.error('[sms/subscribe] DB error:', err?.message?.slice(0, 80))
    return NextResponse.json(
      { success: false, error: 'Could not save subscription. Please try again.' },
      { status: 500 }
    )
  }

  // Generate/retrieve unique $10 discount code (if offer is active)
  let discountCode: string | null = null
  try {
    const offer = await isSmsOfferActive()
    if (offer.active) {
      discountCode = await upsertSmsDiscountCode({ subscriberId, phoneE164 })
    }
  } catch (err: any) {
    // Non-fatal — signup already stored
    console.error('[sms/subscribe] discount code error (non-fatal):', err?.message?.slice(0, 80))
  }

  return NextResponse.json({
    success: true,
    ...(discountCode ? { discountCode } : {}),
  })
}
