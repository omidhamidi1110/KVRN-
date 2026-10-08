// /api/admin/affiliates/compliance — compliance center.
//   GET                    → current program documents + one row per affiliate with open items
//   GET ?affiliateId=…     → one affiliate's saved posts, warnings, reviews, flags, paid-ad policy
//   POST {kind, …}         → review | item_add | item_status | warning_issue | warning_resolve | flag_open |
//                            flag_update | scan | paid_ads | suspend
// requireAdmin FIRST. Every mutation is one SQL statement/function that writes its own admin_audit_logs row.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import {
  createAffiliateComplianceService, FLAG_SIGNALS, validateItemInput, validateWarningInput,
} from '@/lib/affiliate-compliance'
import { isUuid, mapReadinessError } from '@/lib/affiliate-payout-readiness'

export const dynamic = 'force-dynamic'
const bad = (m: string, status = 400) => NextResponse.json({ error: m }, { status })

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const svc = createAffiliateComplianceService(sql)
  const id = req.nextUrl.searchParams.get('affiliateId')
  try {
    if (id) {
      if (!isUuid(id)) return bad('A valid affiliate is required.')
      return NextResponse.json({ detail: await svc.detail(id) })
    }
    // Compliance documents are legal evidence. Never turn a failed read into an
    // apparently empty policy list: that would hide active terms/disclosures.
    const [documents, affiliates] = await Promise.all([svc.currentDocuments(), svc.attention()])
    return NextResponse.json({ documents, affiliates })
  } catch (err: any) {
    console.error('[admin/affiliates/compliance GET]', String(err?.message ?? '').slice(0, 120))
    return bad('Could not load compliance.', 500)
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  let b: any
  try { b = await req.json() } catch { return bad('Invalid request body.') }
  if (!b || typeof b !== 'object') return bad('Invalid request body.')
  const actor = identity!.email
  const svc = createAffiliateComplianceService(sql)
  const needAff = () => (isUuid(b.affiliateId) ? (b.affiliateId as string) : null)

  try {
    switch (b.kind) {
      case 'scan': {
        const days = Number(b.sinceDays ?? 30)
        const r = await svc.scanSelfReferral({ sinceDays: Number.isFinite(days) ? days : 30, actor })
        return NextResponse.json({ result: r })
      }
      case 'review': {
        const a = needAff(); if (!a) return bad('A valid affiliate is required.')
        await svc.recordReview(a, String(b.outcome ?? ''), typeof b.note === 'string' ? b.note : null, actor)
        return NextResponse.json({ ok: true }, { status: 201 })
      }
      case 'item_add': {
        const a = needAff(); if (!a) return bad('A valid affiliate is required.')
        const v = validateItemInput(b); if (!v.ok) return bad(v.error)
        return NextResponse.json({ id: await svc.addItem(a, v.value, actor) }, { status: 201 })
      }
      case 'item_status': {
        const a = needAff(); if (!a || !isUuid(b.itemId)) return bad('A valid post is required.')
        const ok = await svc.setItemStatus(a, b.itemId, String(b.status ?? ''), typeof b.note === 'string' ? b.note : null, actor)
        return ok ? NextResponse.json({ ok: true }) : bad('Post not found.', 404)
      }
      case 'warning_issue': {
        const a = needAff(); if (!a) return bad('A valid affiliate is required.')
        const v = validateWarningInput(b); if (!v.ok) return bad(v.error)
        return NextResponse.json({ id: await svc.issueWarning(a, v.value, actor) }, { status: 201 })
      }
      case 'warning_resolve': {
        const a = needAff(); if (!a || !isUuid(b.warningId)) return bad('A valid warning is required.')
        const ok = await svc.resolveWarning(a, b.warningId, typeof b.note === 'string' ? b.note : null, actor)
        return ok ? NextResponse.json({ ok: true }) : bad('Warning not found or already resolved.', 404)
      }
      case 'flag_open': {
        const a = needAff(); if (!a) return bad('A valid affiliate is required.')
        if (!(FLAG_SIGNALS as readonly string[]).includes(b.signal)) return bad('Choose a signal.')
        if (b.orderId && !isUuid(b.orderId)) return bad('Order not found.')
        const id = await svc.openFlag(a, { signal: b.signal, severity: b.severity, orderId: b.orderId ?? null, note: typeof b.note === 'string' ? b.note : null, freeze: b.freeze === true }, actor)
        return NextResponse.json({ id }, { status: 201 })
      }
      case 'flag_update': {
        const a = needAff(); if (!a || !isUuid(b.flagId)) return bad('A valid flag is required.')
        const r = await svc.updateFlag(a, b.flagId, {
          status: typeof b.status === 'string' ? b.status : undefined,
          note: typeof b.note === 'string' ? b.note : null,
          freeze: typeof b.freeze === 'boolean' ? b.freeze : undefined,
        }, actor)
        return r.ok ? NextResponse.json({ ok: true }) : bad(r.error, 409)
      }
      case 'paid_ads': {
        const a = needAff(); if (!a) return bad('A valid affiliate is required.')
        return NextResponse.json({ result: await svc.setPaidAdsPolicy(a, String(b.policy ?? ''), typeof b.note === 'string' ? b.note : null, actor) })
      }
      case 'suspend': {
        const a = needAff(); if (!a) return bad('A valid affiliate is required.')
        const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
        if (reason.length < 3) return bad('A reason is required.')
        return NextResponse.json({ result: await svc.suspend(a, reason.slice(0, 300), b.revokePortal !== false, actor) })
      }
      default:
        return bad('Unknown action.')
    }
  } catch (err: any) {
    const mapped = mapReadinessError(err)
    if (mapped) return bad(mapped.message, mapped.status)
    const msg = String(err?.message ?? '')
    if (msg.includes('BAD_OUTCOME') || msg.includes('BAD_STATUS') || msg.includes('BAD_SIGNAL')) return bad('That value is not valid.')
    if (msg.includes('violates foreign key')) return bad('Not found.', 404)
    console.error('[admin/affiliates/compliance POST]', msg.slice(0, 120))
    return bad('Could not complete that action.', 500)
  }
}
