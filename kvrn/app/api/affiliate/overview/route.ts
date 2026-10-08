// GET /api/affiliate/overview?range=30d|90d|ytd|all — the signed-in affiliate's own summary. Nothing else is selectable.
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
    const data = await createAffiliatePortalService(sql).overview(ctx!.affiliateId, req.nextUrl.searchParams.get('range'))
    return portalJson(data)
  } catch (err: any) {
    console.error('[affiliate/overview]', String(err?.message ?? '').slice(0, 120))
    return jsonError(500, 'Could not load your overview.')
  }
}
