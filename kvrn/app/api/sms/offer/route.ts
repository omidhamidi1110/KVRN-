// GET /api/sms/offer — Server-verified SMS signup offer status
// Returns whether the $10 SMS signup reward is currently active/configured.
// Does NOT return any universal code (codes are unique per subscriber).
// Safe to call from client — no secrets or codes exposed.
import { type NextRequest, NextResponse } from 'next/server'
import { isSmsOfferActive } from '@/lib/discounts'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest) {
  try {
    const { active, amountCents } = await isSmsOfferActive()
    if (active) {
      return NextResponse.json({ offerActive: true, amountCents })
    }
    return NextResponse.json({ offerActive: false })
  } catch {
    // Fail safe — report inactive rather than exposing errors
    return NextResponse.json({ offerActive: false })
  }
}
