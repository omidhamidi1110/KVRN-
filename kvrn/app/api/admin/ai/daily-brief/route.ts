import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { collectDailyBriefSnapshot, formatDailyBrief } from '@/lib/ai/chief'

export const dynamic = 'force-dynamic'
/** Preview only — deliberately does NOT send an extra Pushover. */
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const snapshot = await collectDailyBriefSnapshot()
    return NextResponse.json({ snapshot, summary: formatDailyBrief(snapshot) })
  } catch { return NextResponse.json({ error: 'Failed to preview daily brief.' }, { status: 500 }) }
}
