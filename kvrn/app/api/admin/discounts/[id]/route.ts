import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { updateDiscount, safeDeleteDiscount, validateDiscountPatchInput } from '@/lib/discounts'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin(req)
  if (error) return error
  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  // Strict PATCH validation — whitelist only mutable admin fields
  const ALLOWED_PATCH = ['name','description','active','maxRedemptions','minimumSubtotalCents',
    'allowedCountryCodes','excludedCountryCodes','startsAt','expiresAt','amountCents','percentageBps']
  const stripped = Object.fromEntries(Object.entries(body).filter(([k]) => ALLOWED_PATCH.includes(k)))
  const v = validateDiscountPatchInput(stripped as any)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  // Safe numeric parsing (avoid NaN/Infinity)
  const safe: any = { ...stripped }
  if (safe.amountCents !== undefined) safe.amountCents = safe.amountCents === null ? null : Number(safe.amountCents)
  if (safe.percentageBps !== undefined) safe.percentageBps = safe.percentageBps === null ? null : Number(safe.percentageBps)
  if (safe.maxRedemptions !== undefined) safe.maxRedemptions = safe.maxRedemptions === null ? null : Number(safe.maxRedemptions)
  if (safe.minimumSubtotalCents !== undefined) safe.minimumSubtotalCents = safe.minimumSubtotalCents === null ? null : Number(safe.minimumSubtotalCents)

  try {
    const { id } = await params
    const updated = await updateDiscount(id, safe)
    if (!updated) return NextResponse.json({ error: 'Not found.' }, { status: 404 })
    return NextResponse.json({ success: true, data: updated })
  } catch {
    return NextResponse.json({ error: 'Update failed.' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const { id } = await params
    const result = await safeDeleteDiscount(id)
    if (!result.deleted) {
      return NextResponse.json({ error: result.reason }, { status: 409 })
    }
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Delete failed.' }, { status: 500 })
  }
}
