// POST /api/affiliate/onboarding/accept {docTypes:[...]} — accept the CURRENT version of program documents.
// Append-only record (never overwrites an earlier acceptance). Read-only (suspended / terminated) accounts cannot accept.
import { type NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { clientIp, keyedHash } from '@/lib/affiliate-auth'
import { requireAffiliate, jsonError } from '@/lib/affiliate-auth-guard'
import { PORTAL_VISIBLE_DOCS, recordPortalAcceptance } from '@/lib/affiliate-portal-bridge'
import { portalJson, readSmallJson } from '@/lib/affiliate-portal-http'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { ctx, error } = await requireAffiliate(req)
  if (error) return error
  const body = await readSmallJson(req, 1024)
  const types = Array.isArray(body?.docTypes) ? body!.docTypes : null
  if (!types || types.length === 0 || types.length > 8 || types.some((t: unknown) => typeof t !== 'string' || !(PORTAL_VISIBLE_DOCS as readonly string[]).includes(t))) {
    return jsonError(400, 'Choose the documents to accept.')
  }
  try {
    const ua = req.headers.get('user-agent')
    const r = await recordPortalAcceptance(sql, ctx!.affiliateId, types, {
      ipHash: keyedHash('ip', clientIp(req.headers)), uaHash: ua ? keyedHash('ua', ua.slice(0, 300)) : null,
    })
    return portalJson({ ok: true, recorded: r.recorded, requiresReacceptance: r.requiresReacceptance })
  } catch (err: any) {
    console.error('[affiliate/accept]', String(err?.message ?? '').slice(0, 120))
    return jsonError(500, 'Could not record your acceptance.')
  }
}
