// /api/admin/affiliates/payout-readiness — identity / tax / payout-method readiness, provider references,
// portal access and payout attempts (failed + retry).
//   GET                        → one row per affiliate with statuses, payable balance and blockers
//   GET ?affiliateId=…         → account refs (masked), readiness history, payouts + attempts, gate result
//   POST {kind, affiliateId, …} → readiness | account | access | sessions | attempt | attempt_complete | gate
// requireAdmin FIRST. No raw bank / tax / ID / DOB data is accepted here or stored anywhere.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import {
  createAffiliatePayoutReadinessService, isUuid, mapReadinessError, READINESS_DOMAINS, READINESS_STATUSES,
  type ReadinessDomain,
} from '@/lib/affiliate-payout-readiness'
import { canPayAffiliate } from '@/lib/affiliate-payout-gate'

export const dynamic = 'force-dynamic'
const bad = (m: string, status = 400) => NextResponse.json({ error: m }, { status })

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const svc = createAffiliatePayoutReadinessService(sql)
  const id = req.nextUrl.searchParams.get('affiliateId')
  try {
    if (id) {
      if (!isUuid(id)) return bad('A valid affiliate is required.')
      const [detail, gate] = await Promise.all([svc.detail(id), canPayAffiliate(sql, id)])
      return NextResponse.json({ detail, gate })
    }
    return NextResponse.json({ affiliates: await svc.list() })
  } catch (err: any) {
    console.error('[admin/affiliates/payout-readiness GET]', String(err?.message ?? '').slice(0, 120))
    return bad('Could not load payout readiness.', 500)
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  let b: any
  try { b = await req.json() } catch { return bad('Invalid request body.') }
  if (!b || typeof b !== 'object') return bad('Invalid request body.')
  const actor = identity!.email
  const svc = createAffiliatePayoutReadinessService(sql)
  const aff = isUuid(b.affiliateId) ? (b.affiliateId as string) : null
  const note = typeof b.note === 'string' ? b.note.slice(0, 300) : null

  try {
    switch (b.kind) {
      case 'gate': {
        if (!aff) return bad('A valid affiliate is required.')
        return NextResponse.json({ gate: await canPayAffiliate(sql, aff) })
      }
      case 'readiness': {
        if (!aff) return bad('A valid affiliate is required.')
        if (!(READINESS_DOMAINS as readonly string[]).includes(b.domain)) return bad('That setting is not valid.')
        if (!READINESS_STATUSES[b.domain as ReadinessDomain].includes(b.status)) return bad('That status is not valid.')
        return NextResponse.json({ result: await svc.setReadiness(aff, b.domain, b.status, note, actor) })
      }
      case 'account': {
        if (!aff) return bad('A valid affiliate is required.')
        const masked = b.masked && typeof b.masked === 'object' && !Array.isArray(b.masked) ? b.masked : {}
        for (const v of Object.values(masked)) if (typeof v !== 'string') return bad('Only short display details can be saved.')
        const ref = typeof b.providerAccountRef === 'string' && b.providerAccountRef.trim() ? b.providerAccountRef.trim() : null
        return NextResponse.json({ result: await svc.setAccount(aff, String(b.provider ?? ''), ref, masked, actor) })
      }
      case 'access': {
        if (!aff) return bad('A valid affiliate is required.')
        return NextResponse.json({ result: await svc.setPortalAccess(aff, String(b.access ?? ''), note, actor) })
      }
      case 'sessions': {
        if (!aff) return bad('A valid affiliate is required.')
        return NextResponse.json({ revoked: await svc.revokeSessions(aff, note ?? 'admin_request', actor) })
      }
      case 'attempt': {
        if (!isUuid(b.payoutId)) return bad('A valid payout is required.')
        const key = typeof b.idempotencyKey === 'string' ? b.idempotencyKey.slice(0, 100) : null
        return NextResponse.json({ result: await svc.recordAttempt(b.payoutId, key, actor) }, { status: 201 })
      }
      case 'attempt_complete': {
        if (!isUuid(b.attemptId)) return bad('A valid attempt is required.')
        if (b.outcome !== 'succeeded' && b.outcome !== 'failed') return bad('Choose an outcome.')
        if (b.paidAt && !/^\d{4}-\d{2}-\d{2}$/.test(b.paidAt)) return bad('Paid date must be YYYY-MM-DD.')
        const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
        return NextResponse.json({ result: await svc.completeAttempt(b.attemptId, {
          outcome: b.outcome, reference: str(b.reference, 120), failureCode: str(b.failureCode, 60),
          failureNote: str(b.failureNote, 300), paidAt: str(b.paidAt, 10), method: str(b.method, 24),
        }, actor) })
      }
      default:
        return bad('Unknown action.')
    }
  } catch (err: any) {
    const mapped = mapReadinessError(err)
    if (mapped) return bad(mapped.message, mapped.status)
    if (String(err?.message ?? '') === 'BAD_PROVIDER') return bad('That provider is not supported.')
    console.error('[admin/affiliates/payout-readiness POST]', String(err?.message ?? '').slice(0, 120))
    return bad('Could not complete that action.', 500)
  }
}
