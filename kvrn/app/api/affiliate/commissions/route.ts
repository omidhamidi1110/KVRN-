// GET /api/affiliate/commissions?limit&offset — the signed-in affiliate's own sales and commission status.
// No customer identity, no order number: each row is identified by a non-reversible sale reference.
import { type NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { requireAffiliate, jsonError } from '@/lib/affiliate-auth-guard'
import { createAffiliatePortalService } from '@/lib/affiliate-portal'
import { portalJson } from '@/lib/affiliate-portal-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { ctx, error } = await requireAffiliate(req)
  if (error) return error
  const num = (k: string) => {
    const raw = req.nextUrl.searchParams.get(k)
    if (raw === null || raw.trim() === '') return undefined          // Number(null) is 0 — an absent parameter must stay absent
    const v = Number(raw); return Number.isFinite(v) ? v : undefined
  }
  try {
    const data = await createAffiliatePortalService(sql).listSales(ctx!.affiliateId, { limit: num('limit'), offset: num('offset') })
    return portalJson(data)
  } catch (err: any) {
    console.error('[affiliate/commissions]', String(err?.message ?? '').slice(0, 120))
    return jsonError(500, 'Could not load your commissions.')
  }
}
