// GET  /api/admin/affiliates — affiliates, commissions, period economics
// POST /api/admin/affiliates — create an affiliate, a link, or a status change
//
// No money is ever accepted from the client. Commission amounts, reversals and
// balances are computed in SQL.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { getAffiliatePayoutReminder } from '@/lib/affiliate-payout-reminders'
import {
  createAffiliatesService, validateCreateAffiliate,
  AFFILIATE_STATUSES, type AffiliateStatus,
} from '@/lib/affiliates'
import { resolveRangePreset, parseCustomRange, type RangePreset } from '@/lib/financials'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { createAffiliateProgramAdmin } from '@/lib/affiliate-program-admin'
import { ProgramError, toProgramError } from '@/lib/affiliate-program'
import { flushQueuedEmails } from '@/lib/affiliate-program-http'

export const dynamic = 'force-dynamic'
const PRESETS: RangePreset[] = ['today','7d','30d','90d','mtd','ytd','1y','all']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const p = req.nextUrl.searchParams
  const raw = p.get('range') ?? '30d'
  const range = (p.get('start') && p.get('end'))
    ? parseCustomRange(p.get('start'), p.get('end'))
    : resolveRangePreset(PRESETS.includes(raw as RangePreset) ? (raw as RangePreset) : '30d')
  if (!range) return NextResponse.json({ error: 'Invalid range.' }, { status: 400 })

  try {
    const service = createAffiliatesService(sql)
    const [affiliates, commissions, payouts, period, incomplete] = await Promise.all([
      service.listAffiliates(),
      service.listCommissions(p.get('affiliateId')),
      service.listPayouts(p.get('affiliateId')),
      service.getPeriodEffect(range.start, range.end),
      service.listIncomplete(),
    ])
    // Reminder summary is best-effort: a temporary reporting issue must not
    // prevent the owner from reaching the affiliate ledger and payouts.
    const payoutReminder = await getAffiliatePayoutReminder().catch(() => null)
    return NextResponse.json({ affiliates, commissions, payouts, period, incomplete, range, payoutReminder })
  } catch (err: any) {
    console.error('[admin/affiliates GET]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load affiliates.' }, { status: 500 })
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
    // ── Effective-dated status change ───────────────────────────────────────
    if (body.kind === 'status') {
      if (!UUID_RE.test(body.affiliateId ?? '')) {
        return NextResponse.json({ error: 'A valid affiliate is required.' }, { status: 400 })
      }
      if (!AFFILIATE_STATUSES.includes(body.status)) {
        return NextResponse.json({ error: 'Status is not valid.' }, { status: 400 })
      }
      // The program lifecycle owns the status: the financial status event, the discount code, the
      // referral link and the program profile change together in ONE transaction. Financial history
      // (commissions, attributions, payouts, adjustments) is never touched.
      const target = body.status === 'paused' ? 'suspended' : body.status === 'terminated' ? 'terminated' : 'active'
      try {
        await createAffiliateProgramAdmin(sql).setProgramStatus(body.affiliateId, target, {
          actor: identity!.email, reason: body.reason ?? null,
          effectiveAt: body.effectiveAt ?? null,
          notify: isFeatureEnabled('AFFILIATE_APPLICATIONS'),
        })
        await flushQueuedEmails(sql, { affiliateId: body.affiliateId })
      } catch (e) {
        const pe = e instanceof ProgramError ? e : toProgramError(e)
        if (pe?.code === 'NOT_FOUND') return NextResponse.json({ error: 'Affiliate not found.' }, { status: 404 })
        if (pe) return NextResponse.json({ error: pe.message }, { status: pe.status })
        throw e
      }
      // Audit is written inside the SQL functions, atomically.
      return NextResponse.json({ ok: true })
    }

    // ── New effective-dated financial terms (history stays immutable) ───────
    if (body.kind === 'terms') {
      if (!UUID_RE.test(body.affiliateId ?? '')) {
        return NextResponse.json({ error: 'A valid affiliate is required.' }, { status: 400 })
      }
      const type = body.commissionType
      if (type !== 'percentage' && type !== 'fixed') return NextResponse.json({ error: 'Commission type is not valid.' }, { status: 400 })
      const bps = body.commissionRateBps == null ? null : Number(body.commissionRateBps)
      const fixed = body.commissionFixedCents == null ? null : Number(body.commissionFixedCents)
      const win = Number(body.attributionWindowDays), hold = Number(body.commissionHoldDays)
      if (type === 'percentage' && !(Number.isInteger(bps) && bps! > 0 && bps! <= 10000)) return NextResponse.json({ error: 'Rate must be 1–10000 basis points.' }, { status: 400 })
      if (type === 'fixed' && !(Number.isInteger(fixed) && fixed! >= 0 && fixed! <= 100_000_000)) return NextResponse.json({ error: 'Fixed commission is not valid.' }, { status: 400 })
      if (!Number.isInteger(win) || win < 1 || win > 365) return NextResponse.json({ error: 'Attribution window must be 1–365 days.' }, { status: 400 })
      if (!Number.isInteger(hold) || hold < 0 || hold > 365) return NextResponse.json({ error: 'Hold must be 0–365 days.' }, { status: 400 })
      const policy = body.fixedReversalPolicy ?? 'proportional'
      if (policy !== 'proportional' && policy !== 'all_or_nothing') return NextResponse.json({ error: 'Reversal policy is not valid.' }, { status: 400 })
      await service.updateTerms(body.affiliateId, {
        commissionType: type, commissionRateBps: type === 'percentage' ? bps : null,
        commissionFixedCents: type === 'fixed' ? fixed : null, fixedReversalPolicy: policy,
        attributionWindowDays: win, commissionHoldDays: hold, discountId: body.discountId ?? null,
        effectiveAt: body.effectiveAt ?? null, reason: body.reason ?? null,
      }, identity!.email)
      return NextResponse.json({ ok: true })
    }

    // ── Referral link ───────────────────────────────────────────────────────
    if (body.kind === 'link') {
      if (!UUID_RE.test(body.affiliateId ?? '')) {
        return NextResponse.json({ error: 'A valid affiliate is required.' }, { status: 400 })
      }
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(body.slug ?? '')) {
        return NextResponse.json(
          { error: 'Slug must be 2–41 lowercase letters, numbers or hyphens.' }, { status: 400 })
      }
      const id = await service.createLink(
        body.affiliateId, body.slug, body.destinationPath ?? '/', identity!.email)
      return NextResponse.json({ linkId: id }, { status: 201 })
    }

    // ── Create an affiliate ─────────────────────────────────────────────────
    const input = {
      code: String(body.code ?? '').toUpperCase().trim(),
      name: body.name,
      email: body.email ?? null,
      commissionType: body.commissionType,
      commissionRateBps: body.commissionRateBps === undefined || body.commissionRateBps === null
        ? null : Number(body.commissionRateBps),
      commissionFixedCents: body.commissionFixedCents === undefined || body.commissionFixedCents === null
        ? null : Number(body.commissionFixedCents),
      fixedReversalPolicy: body.fixedReversalPolicy ?? 'proportional',
      attributionWindowDays: body.attributionWindowDays === undefined
        ? 30 : Number(body.attributionWindowDays),
      commissionHoldDays: body.commissionHoldDays === undefined
        ? 30 : Number(body.commissionHoldDays),
      discountId: body.discountId ?? null,
      notes: body.notes ?? null,
    }
    const v = validateCreateAffiliate(input as any)
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

    // create_affiliate() writes the affiliate, its initial status event, its
    // initial TERMS event and the audit row in ONE transaction.
    const id = await service.createAffiliate(input as any, identity!.email)
    return NextResponse.json({ affiliateId: id }, { status: 201 })
  } catch (err: any) {
    const msg = String(err?.message ?? '')
    if (msg.includes('affiliates_code_uq')) {
      return NextResponse.json({ error: 'That affiliate code is already in use.' }, { status: 409 })
    }
    if (msg.includes('affiliate_links_slug_uq')) {
      return NextResponse.json({ error: 'That link slug is already in use.' }, { status: 409 })
    }
    console.error('[admin/affiliates POST]', msg.slice(0, 120))
    return NextResponse.json({ error: 'Could not save.' }, { status: 500 })
  }
}
