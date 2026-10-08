import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { listAiAgentPerformance } from '@/lib/ai/repository'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const days = Math.max(1, Math.min(365, Number(req.nextUrl.searchParams.get('days') ?? 30) || 30))
  try { return NextResponse.json({ performance: await listAiAgentPerformance(days), days }) }
  catch { return NextResponse.json({ error: 'Failed to load AI performance.' }, { status: 500 }) }
}
