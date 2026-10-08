import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { listAiActions } from '@/lib/ai/repository'

export const dynamic = 'force-dynamic'
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const limit = Math.max(1, Math.min(500, Number(req.nextUrl.searchParams.get('limit') ?? 100) || 100))
  try { return NextResponse.json({ actions: await listAiActions(limit) }) }
  catch { return NextResponse.json({ error: 'Failed to load AI activity.' }, { status: 500 }) }
}
