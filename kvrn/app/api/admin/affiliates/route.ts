// GET  /api/admin/affiliates — affiliates, commissions, period economics
// POST /api/admin/affiliates — create an affiliate, a link, or a status change
//
// No money is ever accepted from the client. Commission amounts, reversals and
// balances are computed in SQL.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import {
  createAffiliatesService, validateCreateAffiliate,
  AFFILIATE_STATUSES, type AffiliateStatus,
} from '@/lib/affiliates'
import { resolveRangePreset, parseCustomRange, type RangePreset } from '@/lib/financials'

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
    return NextResponse.json({ affiliates, commissions, payouts, period, incomplete, range })
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
      const ok = await service.setAffiliateStatus(
        body.affiliateId, body.status as AffiliateStatus,
        body.effectiveAt ?? null, body.reason ?? null, identity!.email)
      if (!ok) return NextResponse.json({ error: 'Affiliate not found.' }, { status: 404 })
      // Audit is written inside set_affiliate_status, atomically.
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
