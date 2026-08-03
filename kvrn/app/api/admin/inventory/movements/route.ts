import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { getRecentMovements } from '@/lib/inventory'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const variantId = req.nextUrl.searchParams.get('variantId') ?? ''
  if (!variantId) return NextResponse.json({ error: 'variantId required.' }, { status: 400 })
  const movements = await getRecentMovements(variantId)
  return NextResponse.json({ movements })
}
