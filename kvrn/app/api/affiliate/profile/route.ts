// GET/PATCH /api/affiliate/profile — display name, website and social links ONLY. Everything else (status, rate,
// code, payout settings, readiness) is Admin-controlled and a request that names such a field is rejected.
import { type NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { requireAffiliate, jsonError } from '@/lib/affiliate-auth-guard'
import { createAffiliatePortalService } from '@/lib/affiliate-portal'
import { updateOwnProfileFields } from '@/lib/affiliate-portal-bridge'
import { validateProfilePatch } from '@/lib/affiliate-portal-validation'
import { portalJson, readSmallJson } from '@/lib/affiliate-portal-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { ctx, error } = await requireAffiliate(req)
  if (error) return error
  try {
    const p = await createAffiliatePortalService(sql).profile(ctx!.affiliateId)
    if (!p) return jsonError(404, 'No affiliate profile found.')
    return portalJson({ profile: p })
  } catch (err: any) {
    console.error('[affiliate/profile GET]', String(err?.message ?? '').slice(0, 120))
    return jsonError(500, 'Could not load your profile.')
  }
}

export async function PATCH(req: NextRequest) {
  const { ctx, error } = await requireAffiliate(req)
  if (error) return error
  const body = await readSmallJson(req, 6 * 1024)
  const v = validateProfilePatch(body)
  if (!v.ok) return jsonError(400, v.error)
  try {
    await updateOwnProfileFields(sql, ctx!.affiliateId, v.value)
    const p = await createAffiliatePortalService(sql).profile(ctx!.affiliateId)
    return portalJson({ ok: true, profile: p })
  } catch (err: any) {
    console.error('[affiliate/profile PATCH]', String(err?.message ?? '').slice(0, 120))
    return jsonError(500, 'Could not save your profile.')
  }
}
