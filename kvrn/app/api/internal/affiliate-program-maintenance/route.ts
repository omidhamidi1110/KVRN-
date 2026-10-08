// POST /api/internal/affiliate-program-maintenance — CRON_SECRET-protected housekeeping.
// The Cloudflare cron wrapper is a frozen shared file; the integrator wires this into the existing
// affiliate maintenance schedule. Returns only counts.
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { getEmailProvider } from '@/lib/resend-adapter'
import { requireCronSecret } from '@/lib/internal-cron-auth'
import { runAffiliateProgramMaintenance } from '@/lib/affiliate-program-maintenance'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req)
  if (denied) return denied
  try {
    const r = await runAffiliateProgramMaintenance(sql, getEmailProvider)
    return NextResponse.json(r, { headers: NO_STORE })
  } catch (err: any) {
    console.error('[affiliate-program-maintenance]', String(err?.message ?? '').slice(0, 80))
    return NextResponse.json({ error: 'Maintenance failed.' }, { status: 500, headers: NO_STORE })
  }
}
