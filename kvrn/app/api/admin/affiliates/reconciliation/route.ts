// POST /api/admin/affiliates/reconciliation
//
// Admin decomposition of a PARTIAL dispute.
//
// 018 records a dispute's revenue impact as a GROSS figure (Stripe's disputed
// amount includes shipping and tax, offset by gross refund totals). Affiliate
// commission is merchandise-only, so a partial dispute has no deterministic
// merchandise share and is left Incomplete rather than guessed.
//
// This is where an operator supplies the verified split. Validation happens twice
// — here for a clear message, and again in SQL, which is authoritative.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createAffiliatesService, validateDisputeDecomposition } from '@/lib/affiliates'

export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  // Keyed by DISPUTE, not by an 018 financial-adjustment row. A lost partial
  // dispute can exist with no such row at all when 018's revenue delta was zero,
  // and requiring one made those disputes impossible to reconcile.
  if (!UUID_RE.test(body.disputeId ?? '')) {
    return NextResponse.json({ error: 'A valid dispute is required.' }, { status: 400 })
  }

  const [dispute] = (await sql`
    SELECT amount_cents FROM order_disputes WHERE id = ${body.disputeId}::uuid
  `) as any[]
  if (!dispute) return NextResponse.json({ error: 'Dispute not found.' }, { status: 404 })
  const adj = { disputed_amount_cents: dispute.amount_cents }

  const components = {
    merchandiseCents: body.merchandiseCents === undefined || body.merchandiseCents === null
      ? undefined : Number(body.merchandiseCents),
    shippingCents: body.shippingCents === undefined || body.shippingCents === null
      ? undefined : Number(body.shippingCents),
    taxCents: body.taxCents === undefined || body.taxCents === null
      ? undefined : Number(body.taxCents),
  }
  const v = validateDisputeDecomposition(components, Number(adj.disputed_amount_cents))
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  try {
    const result = await createAffiliatesService(sql).resolveDisputeMerchandise(
      body.disputeId, components as any, identity!.email, body.notes ?? null)
    // Audit is written INSIDE the canonical SQL transaction, so a separate
    // post-commit insert here would duplicate the evidence and could fail after
    // money already moved — the exact failure defect #14 removes.
    return NextResponse.json({ result })
  } catch (err: any) {
    const msg = String(err?.message ?? '')
    if (msg.includes('COMPONENTS_DO_NOT_TOTAL')) {
      return NextResponse.json(
        { error: 'Components must total exactly the disputed amount.' }, { status: 400 })
    }
    if (msg.includes('MERCHANDISE_EXCEEDS_ORDER')) {
      return NextResponse.json(
        { error: 'Merchandise exceeds the net merchandise on that order.' }, { status: 400 })
    }
    if (msg.includes('NEGATIVE_COMPONENT')) {
      return NextResponse.json({ error: 'Components cannot be negative.' }, { status: 400 })
    }
    console.error('[admin/affiliates/reconciliation]', msg.slice(0, 120))
    return NextResponse.json({ error: 'Could not resolve.' }, { status: 500 })
  }
}
