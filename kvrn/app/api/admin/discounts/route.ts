import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { listDiscounts, createDiscount, validateDiscountInput } from '@/lib/discounts'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const discounts = await listDiscounts()
    return NextResponse.json({ success: true, data: discounts })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch discounts.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  // Strict server-side input validation (never spread raw body)
  const parsed = {
    code:                 body.code,
    name:                 body.name,
    description:          body.description ?? null,
    type:                 body.type,
    // Strict parsing: distinguish undefined/null/0/false explicitly
    amountCents:          body.amountCents != null ? Number(body.amountCents) : null,
    percentageBps:        body.percentageBps != null ? Number(body.percentageBps) : null,
    active:               body.active !== false,
    singleUse:            Boolean(body.singleUse),
    maxRedemptions:       body.maxRedemptions != null ? Number(body.maxRedemptions) : null,
    minimumSubtotalCents: body.minimumSubtotalCents != null ? Number(body.minimumSubtotalCents) : null,
    allowedCountryCodes:  Array.isArray(body.allowedCountryCodes) ? body.allowedCountryCodes.map(String) : null,
    excludedCountryCodes: Array.isArray(body.excludedCountryCodes) ? body.excludedCountryCodes.map(String) : null,
    startsAt:             body.startsAt ? String(body.startsAt) : null,
    expiresAt:            body.expiresAt ? String(body.expiresAt) : null,
  }
  const v = validateDiscountInput(parsed)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  try {
    const discount = await createDiscount({ ...parsed, createdBy: 'admin' })
    return NextResponse.json({ success: true, data: discount })
  } catch (err: any) {
    if (err?.message?.includes('unique')) {
      return NextResponse.json({ error: 'A discount with that code already exists.' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Failed to create discount.' }, { status: 500 })
  }
}
