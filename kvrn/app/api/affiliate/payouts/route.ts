// GET /api/affiliate/payouts — the signed-in affiliate's own payouts (processing / paid / failed / cancelled).
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
    return portalJson({ payouts: await createAffiliatePortalService(sql).listPayouts(ctx!.affiliateId) })
  } catch (err: any) {
    console.error('[affiliate/payouts]', String(err?.message ?? '').slice(0, 120))
    return jsonError(500, 'Could not load your payouts.')
  }
}
