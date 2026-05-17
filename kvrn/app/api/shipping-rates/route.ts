import { NextRequest, NextResponse } from 'next/server'
import { calculateShipping } from '@/lib/stripe'

// ─── POST /api/shipping-rates ──────────────────────────────────────────────────
// Returns available shipping options and costs for a given country.
// Called from checkout when country changes.
export async function POST(req: NextRequest) {
  try {
    const { country = 'GB' } = await req.json()

    const rates = [
      {
        id:       'standard',
        label:    country === 'GB' ? 'Standard — 3–5 business days' : 'Standard — 7–14 business days',
        costPence: calculateShipping(country, 'standard'),
        default:  true,
      },
      {
        id:       'express',
        label:    country === 'GB' ? 'Express — 1–2 business days' : 'Express — 3–7 business days',
        costPence: calculateShipping(country, 'express'),
        default:  false,
      },
    ]

    return NextResponse.json({ success: true, data: { country, rates } })
  } catch (err) {
    console.error('[shipping-rates] Error:', err)
    return NextResponse.json({ success: false, error: 'Failed to get shipping rates.' }, { status: 500 })
  }
}
