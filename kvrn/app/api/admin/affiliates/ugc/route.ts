// /api/admin/affiliates/ugc — creator-content (UGC) licenses, separate from affiliate status.
//   GET ?affiliateId=…            → that affiliate's licenses (active flag computed by the database)
//   POST {kind:'grant', …}        → record an explicit license (immutable; evidence reference only)
//   POST {kind:'revoke', …}       → one-way revoke with a reason
// requireAdmin FIRST. Both mutations write admin_audit_logs in the same statement.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createAffiliateUgcService, mapUgcError, validateUgcGrant } from '@/lib/affiliate-compliance-ugc'
import { isUuid } from '@/lib/affiliate-payout-readiness'

export const dynamic = 'force-dynamic'
const bad = (m: string, status = 400) => NextResponse.json({ error: m }, { status })

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const id = req.nextUrl.searchParams.get('affiliateId')
  if (!id || !isUuid(id)) return bad('A valid affiliate is required.')
  try {
    return NextResponse.json({ licenses: await createAffiliateUgcService(sql).list(id) })
  } catch (err: any) {
    console.error('[admin/affiliates/ugc GET]', String(err?.message ?? '').slice(0, 120))
    return bad('Could not load licenses.', 500)
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  let b: any
  try { b = await req.json() } catch { return bad('Invalid request body.') }
  if (!b || typeof b !== 'object' || !isUuid(b.affiliateId)) return bad('A valid affiliate is required.')
  const svc = createAffiliateUgcService(sql)
  try {
    if (b.kind === 'grant') {
      const v = validateUgcGrant(b); if (!v.ok) return bad(v.error)
      return NextResponse.json(await svc.grant(b.affiliateId, v.value, identity!.email), { status: 201 })
    }
    if (b.kind === 'revoke') {
      if (!isUuid(b.licenseId)) return bad('A valid license is required.')
      const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
      if (reason.length < 3) return bad('A reason is required.')
      const ok = await svc.revoke(b.affiliateId, b.licenseId, reason, identity!.email)
      return ok ? NextResponse.json({ ok: true }) : bad('License not found or already revoked.', 404)
    }
    return bad('Unknown action.')
  } catch (err: any) {
    const m = mapUgcError(err)
    if (m) return bad(m.message, m.status)
    console.error('[admin/affiliates/ugc POST]', String(err?.message ?? '').slice(0, 120))
    return bad('Could not complete that action.', 500)
  }
}
