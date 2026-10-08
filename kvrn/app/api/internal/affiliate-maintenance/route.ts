// Cron: affiliate maintenance (cleanup, notification sweeps + delivery, self-referral heuristic, commission
// promotion, optional automated payout submission). Counts only. Authenticated with CRON_SECRET.
// AFFILIATE_PORTAL OFF → returns { enabled:false } and touches nothing.
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { requireCronSecret } from '@/lib/internal-cron-auth'
import { runAffiliateMaintenance } from '@/lib/affiliate-maintenance'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req)
  if (denied) return denied
  try {
    const result = await runAffiliateMaintenance(sql, {
      portalEnabled: () => isFeatureEnabled('AFFILIATE_PORTAL'),
      autoPayoutsEnabled: () => isFeatureEnabled('AFFILIATE_AUTO_PAYOUTS'),
    })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'Maintenance failed.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
