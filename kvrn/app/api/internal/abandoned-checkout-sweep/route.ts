// Cron (every 5 min via cloudflare-cron-wrapper): records abandonment, queues + sends the single
// recovery email (flag-gated), links recovered orders, expires old rows.
// Authenticated with CRON_SECRET. Returns counts only — no emails, ids or tokens.
import { type NextRequest, NextResponse } from 'next/server'
import { requireCronSecret } from '@/lib/internal-cron-auth'
import { abandonedService } from '@/lib/abandoned-checkout-runtime'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req)
  if (denied) return denied
  try {
    const result = await abandonedService.sweep()
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (e: any) {
    console.error('[abandoned-sweep] failed:', String(e?.message ?? '').slice(0, 80))
    return NextResponse.json({ error: 'Sweep failed.' }, { status: 500, headers: NO_STORE })
  }
}
