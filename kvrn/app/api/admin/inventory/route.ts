import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { getAllVariantsForAdmin, adjustStock } from '@/lib/inventory'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const variants = await getAllVariantsForAdmin()
  return NextResponse.json({ variants })
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  const body = await req.json()
  const { variantId, type, quantity, reason, note } = body

  if (!variantId || !type || reason === undefined) {
    return NextResponse.json({ error: 'Missing fields.' }, { status: 400 })
  }
  if (!['SET', 'ADD', 'REMOVE'].includes(type)) {
    return NextResponse.json({ error: 'Invalid type.' }, { status: 400 })
  }

  const result = await adjustStock({ variantId, type, quantity, reason, note, actorEmail: identity!.email })
  if (!result.success) {
    return NextResponse.json({ error: (result as any).error }, { status: 400 })
  }
  return NextResponse.json({ ok: true, variant: (result as any).variant })
}
