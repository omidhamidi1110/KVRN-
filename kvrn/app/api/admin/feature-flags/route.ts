// Read-only: which high-risk feature flags are ON/OFF. Flags are changed ONLY by editing the
// Cloudflare Worker variable (so a kill switch never depends on the database or this UI).
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { listFeatureFlags } from '@/lib/feature-flags'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  return NextResponse.json({ success: true, data: listFeatureFlags() }, { headers: { 'Cache-Control': 'no-store' } })
}
