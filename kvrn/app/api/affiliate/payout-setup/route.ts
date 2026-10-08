// GET/POST /api/affiliate/payout-setup — how identity, tax and payout details get set up.
// KVRN never collects bank, tax, ID or date-of-birth data through this portal. With the manual provider the answer is
// instructions; with a hosted provider it is a link to the PROVIDER's own onboarding page.
import { type NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { getSiteOrigin } from '@/lib/site-origin'
import { requireAffiliate, jsonError } from '@/lib/affiliate-auth-guard'
import { getPayoutProvider } from '@/lib/affiliate-payout-provider'
import { portalJson } from '@/lib/affiliate-portal-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAffiliate(req)
  if (error) return error
  const p = getPayoutProvider()
  return portalJson({ provider: p.id, hosted: p.id !== 'manual' && p.isConfigured() })
}

export async function POST(req: NextRequest) {
  const { ctx, error } = await requireAffiliate(req)
  if (error) return error
  const provider = getPayoutProvider()
  try {
    const origin = getSiteOrigin() ?? ''
    const link = await provider.createOnboardingLink({
      affiliateId: ctx!.affiliateId,
      returnUrl: `${origin}/affiliate/portal?tab=onboarding`, refreshUrl: `${origin}/affiliate/portal?tab=onboarding`,
    })
    await sql`INSERT INTO affiliate_security_events (affiliate_id, event_type, detail)
              VALUES (${ctx!.affiliateId}::uuid, 'payout_setup_started', ${JSON.stringify({ provider: provider.id })}::jsonb)`.catch(() => {})
    return portalJson({ provider: provider.id, ...link })
  } catch (err: any) {
    if (err?.code === 'PROVIDER_NOT_CONFIGURED') return jsonError(503, 'Payout setup is not available yet. Contact support.')
    console.error('[affiliate/payout-setup]', String(err?.message ?? '').slice(0, 120))
    return jsonError(500, 'Could not start payout setup.')
  }
}
