import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { listAiApprovals } from '@/lib/ai/repository'

export const dynamic = 'force-dynamic'
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try { return NextResponse.json({ approvals: await listAiApprovals(250) }) }
  catch { return NextResponse.json({ error: 'Failed to load AI approvals.' }, { status: 500 }) }
}
