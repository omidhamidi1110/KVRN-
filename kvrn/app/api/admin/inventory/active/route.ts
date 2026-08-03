import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { setVariantActive } from '@/lib/inventory'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { variantId, active } = await req.json()
  await setVariantActive(variantId, active, identity!.email)
  return NextResponse.json({ ok: true })
}
