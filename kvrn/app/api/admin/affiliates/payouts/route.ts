// POST /api/admin/affiliates/payouts — create a draft payout, or mark one paid
//
// MANUAL MONEY MOVEMENT ONLY. Automatic eligibility does not move money; an
// admin creates the payout and separately records that it was actually paid.
//
// The client sends which commissions to include. It never sends an amount:
// create_affiliate_payout recomputes each payable balance under a row lock, so
// two concurrent admins cannot pay the same money twice.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createAffiliatesService } from '@/lib/affiliates'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { canPayAffiliate } from '@/lib/affiliate-payout-gate'

export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const affiliateId = req.nextUrl.searchParams.get('affiliateId')
  if (!affiliateId || !UUID_RE.test(affiliateId)) {
    return NextResponse.json({ error: 'A valid affiliate is required.' }, { status: 400 })
  }
  try {
    const payable = await createAffiliatesService(sql).payableCommissions(affiliateId)
    return NextResponse.json({
      payable,
      totalPayableCents: payable.reduce((s, p) => s + p.payableCents, 0),
    })
  } catch (err: any) {
    console.error('[admin/affiliates/payouts GET]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load payable commissions.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  const service = createAffiliatesService(sql)

  try {
    // ── Record that money actually moved. This is the cash-flow event. ──────
    if (body.kind === 'mark_paid') {
      if (!UUID_RE.test(body.payoutId ?? '')) {
        return NextResponse.json({ error: 'A valid payout is required.' }, { status: 400 })
      }
      if (body.paidAt && !DATE_RE.test(body.paidAt)) {
        return NextResponse.json({ error: 'Paid date must be YYYY-MM-DD.' }, { status: 400 })
      }
      const result = await service.markPayoutPaid(
        body.payoutId, body.paidAt ?? null, body.method ?? null,
        body.reference ?? null, identity!.email)
    // Audit is written INSIDE the canonical SQL transaction, so a separate
    // post-commit insert here would duplicate the evidence and could fail after
    // money already moved — the exact failure defect #14 removes.
      return NextResponse.json({ result })
    }

    // ── Void a DRAFT payout ─────────────────────────────────────────────────
    // Releases the payable reservation a mistaken draft was holding. The
    // canonical SQL writes its own audit row, so none is added here.
    if (body.kind === 'void') {
      if (!UUID_RE.test(body.payoutId ?? '')) {
        return NextResponse.json({ error: 'A valid payout is required.' }, { status: 400 })
      }
      try {
        const result = await service.voidPayout(
          body.payoutId, body.reason ?? null, identity!.email)
        return NextResponse.json({ result })
      } catch (err: any) {
        const msg = String(err?.message ?? '')
        if (msg.includes('PAID_CANNOT_BE_VOIDED')) {
          return NextResponse.json(
            { error: 'That payout has already been paid and cannot be voided.' },
            { status: 409 })
        }
        if (msg.includes('NOT_FOUND')) {
          return NextResponse.json({ error: 'Payout not found.' }, { status: 404 })
        }
        throw err
      }
    }

    // ── Create a draft payout ───────────────────────────────────────────────
    if (!UUID_RE.test(body.affiliateId ?? '')) {
      return NextResponse.json({ error: 'A valid affiliate is required.' }, { status: 400 })
    }
    const ids: string[] = Array.isArray(body.commissionIds) ? body.commissionIds : []
    if (ids.length === 0 || !ids.every(i => UUID_RE.test(i))) {
      return NextResponse.json({ error: 'Select at least one valid commission.' }, { status: 400 })
    }

    // Payout readiness gate (affiliate-portal workstream). Only evaluated when the affiliate programme features are
    // ON, so flag-OFF behaviour is unchanged. The gate DECIDES; it never computes money — amounts still come only
    // from the SQL below. A blocked payout creates nothing.
    if (isFeatureEnabled('AFFILIATE_PORTAL') || isFeatureEnabled('AFFILIATE_APPLICATIONS')) {
      const gate = await canPayAffiliate(sql, body.affiliateId, { commissionIds: ids })
      if (!gate.allowed) {
        return NextResponse.json(
          { error: 'This payout is blocked until the items below are resolved.', blockers: gate.blockers, warnings: gate.warnings },
          { status: 409 })
      }
    }

    // Amounts are derived server-side; nothing from the body is trusted.
    const result = await service.createPayout(body.affiliateId, ids, identity!.email)
    // Audit is written INSIDE the canonical SQL transaction, so a separate
    // post-commit insert here would duplicate the evidence and could fail after
    // money already moved — the exact failure defect #14 removes.
    return NextResponse.json({ result }, { status: 201 })
  } catch (err: any) {
    const msg = String(err?.message ?? '')
    if (msg.includes('VOID_CANNOT_BE_PAID')) {
      return NextResponse.json({ error: 'A void payout cannot be marked paid.' }, { status: 400 })
    }
    if (msg.includes('ACTOR_REQUIRED')) {
      return NextResponse.json({ error: 'An actor is required.' }, { status: 400 })
    }
    console.error('[admin/affiliates/payouts POST]', msg.slice(0, 120))
    return NextResponse.json({ error: 'Could not process payout.' }, { status: 500 })
  }
}
