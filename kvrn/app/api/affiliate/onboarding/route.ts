// GET /api/affiliate/onboarding — setup status (identity / tax / payout method), terms, warnings, paid-ad policy.
import { type NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { requireAffiliate, jsonError } from '@/lib/affiliate-auth-guard'
import { createAffiliatePortalService } from '@/lib/affiliate-portal'
import { portalJson } from '@/lib/affiliate-portal-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { ctx, error } = await requireAffiliate(req)
  if (error) return error
  try {
    const data = await createAffiliatePortalService(sql).onboarding(ctx!.affiliateId)
    if (!data) return jsonError(404, 'No affiliate profile found.')
    return portalJson(data)
  } catch (err: any) {
    console.error('[affiliate/onboarding]', String(err?.message ?? '').slice(0, 120))
    return jsonError(500, 'Could not load your setup.')
  }
}
