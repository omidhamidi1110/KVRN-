import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { getSmsStats } from '@/lib/sms-subscribers'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const data = await getSmsStats()
    return NextResponse.json({ success: true, data })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch SMS subscribers.' }, { status: 500 })
  }
}
