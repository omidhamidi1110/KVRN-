// POST /api/admin/refunds/[id]/resolve-components
//
// Establish the authoritative merchandise/shipping/tax split for a refund.
//
// Stripe reports only a refund TOTAL. Until the split is resolved, NULL means
// "not known" — it is never treated as zero and never as a permissive cap.
// Component-level return allocation stays blocked until this succeeds.
//
// Body: {} to derive deterministically (full refunds only), or
//       { merchandiseCents, shippingCents, taxCents } which must sum EXACTLY
//       to the refund total.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createReturnsService, validateDecomposition } from '@/lib/returns'

export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid refund id.' }, { status: 400 })
  }

  let body: any = {}
  try { body = await req.json() } catch { body = {} }

  const hasAny = body.merchandiseCents !== undefined
              || body.shippingCents !== undefined
              || body.taxCents !== undefined

  let components: { merchandiseCents: number; shippingCents: number; taxCents: number } | null = null

  if (hasAny) {
    const [refund] = (await sql`
      SELECT amount_cents FROM order_refunds WHERE id = ${id}::uuid
    `) as any[]
    if (!refund) return NextResponse.json({ error: 'Refund not found.' }, { status: 404 })

    const candidate = {
      merchandiseCents: body.merchandiseCents === undefined || body.merchandiseCents === null
        ? undefined : Number(body.merchandiseCents),
      shippingCents: body.shippingCents === undefined || body.shippingCents === null
        ? undefined : Number(body.shippingCents),
      taxCents: body.taxCents === undefined || body.taxCents === null
        ? undefined : Number(body.taxCents),
    }
    const v = validateDecomposition(candidate as any, Number(refund.amount_cents))
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
    components = candidate as any
  }

  try {
    const result = await createReturnsService(sql)
      .resolveRefundComponents(id, components, identity!.email)

    // ── Resume affiliate accounting immediately ─────────────────────────────
    // The affiliate reversal was blocked while the breakdown was unknown. Stripe
    // has no reason to redeliver a refund that already succeeded, so waiting for
    // another webhook would leave the commission wrong indefinitely. This is
    // idempotent through the (commission_id, source_refund_id) unique index, and
    // it recomputes the derived incomplete flag so the commission stays blocked
    // if any other source is still unresolved.
    //
    // Non-fatal: the decomposition itself has already committed and is correct.
    // A failure here leaves the commission incomplete, which is the safe state,
    // and the same call can simply be retried.
    let affiliateResult: unknown = null
    try {
      const rows = await sql`SELECT resume_affiliate_after_refund_resolution(
        ${id}::uuid, ${identity!.email}
      ) AS result`
      affiliateResult = (rows as any[])[0]?.result ?? null
    } catch (err: any) {
      console.error('[admin/refunds/resolve-components] affiliate resume failed:',
        err?.message?.slice(0, 100))
    }

    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${identity!.email}, 'resolve_components', 'order_refund', ${id},
              ${JSON.stringify(result ?? {})}::jsonb)
    `
    return NextResponse.json({ result, affiliate: affiliateResult })
  } catch (err: any) {
    const msg = String(err?.message ?? '')
    if (msg.includes('NOT_FULL_REFUND')) {
      return NextResponse.json(
        { error: 'This is a partial refund, so the split cannot be derived automatically. Enter the components explicitly.' },
        { status: 400 })
    }
    if (msg.includes('DECOMPOSITION_MISMATCH')) {
      return NextResponse.json(
        { error: 'Components must total exactly the refund amount.' }, { status: 400 })
    }
    if (msg.includes('INCOMPLETE_DECOMPOSITION')) {
      return NextResponse.json(
        { error: 'All three components are required — none may be left blank.' }, { status: 400 })
    }
    console.error('[admin/refunds/resolve-components]', msg.slice(0, 120))
    return NextResponse.json({ error: 'Could not resolve components.' }, { status: 500 })
  }
}
