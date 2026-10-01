// POST /api/admin/affiliates/backfill
//
// Deterministic late attribution for an order whose payment-time attribution
// failed. Attribution is non-fatal at payment so a transient error cannot fail a
// customer's order — this is how the resulting obligation is recovered.
//
// The admin supplies ONLY the order. The visitor's opaque session identity is
// recovered server-side from persisted order data (orders.attribution.kvrn_sid,
// written at checkout and copied forward by finalize_paid_order), so no admin
// ever knows or types a session id and no browser value is trusted.
//
// The canonical SQL function writes its own audit row in the same transaction;
// this route deliberately adds none.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createAffiliatesService } from '@/lib/affiliates'
import { isValidSessionId } from '@/lib/affiliate-session'
import { getStripe } from '@/lib/stripe-client'

export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  if (!body.orderId || !UUID_RE.test(body.orderId)) {
    return NextResponse.json({ error: 'A valid order is required.' }, { status: 400 })
  }
  // A browser-supplied session id must never influence attribution.
  if (body.sessionId !== undefined) {
    return NextResponse.json(
      { error: 'Session identity is recovered server-side and cannot be supplied.' },
      { status: 400 })
  }

  try {
    const service = createAffiliatesService(sql)

    // ── SESSION RECOVERY, SERVER-SIDE ONLY ──────────────────────────────────
    // 1. authoritative local snapshot; 2. Stripe client_reference_id if absent.
    // A Stripe outage must NOT be reported as "no affiliate": that turns an
    // unknown into a false negative and silently drops a real obligation.
    let recovered: string | null = null
    const state = await service.needsStripeSessionRecovery(body.orderId)
    if (!state) return NextResponse.json({ error: 'Order not found.' }, { status: 404 })

    if (!state.hasLocal && state.checkoutSessionId) {
      try {
        const stripe = getStripe()
        const cs = await stripe.checkout.sessions.retrieve(state.checkoutSessionId)
        const ref = cs?.client_reference_id ?? null
        if (ref && !isValidSessionId(ref)) {
          // Malformed: fail closed rather than guess. Audited exactly once —
          // this attempt reaches no canonical SQL function (there is nothing
          // to attribute), so without an explicit insert here it would leave
          // no trace at all, unlike every other backfill outcome.
          await sql`
            INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
            VALUES (${identity!.email}, 'backfill_attempt', 'orders', ${body.orderId},
                    ${JSON.stringify({ outcome: 'malformed_recovered_session',
                                       localSidPresent: state.localSidPresent })}::jsonb)
          `
          return NextResponse.json({
            result: { outcome: 'malformed_recovered_session' },
            message: 'The stored checkout reference is not a valid session id. No link attribution was created.',
          }, { status: 422 })
        }
        if (ref) {
          // A valid-looking Stripe reference must still map to real local click
          // evidence. Without that there is nothing to attribute to, and
          // inventing a link would be worse than reporting the gap.
          const hits = await sql`
            SELECT 1 FROM affiliate_clicks WHERE session_id = ${ref} LIMIT 1
          `
          if ((hits as any[]).length === 0) {
            await sql`
              INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
              VALUES (${identity!.email}, 'backfill_attempt', 'orders', ${body.orderId},
                      ${JSON.stringify({ outcome: 'no_link_evidence',
                                         localSidPresent: state.localSidPresent })}::jsonb)
            `
            return NextResponse.json({
              result: { outcome: 'no_link_evidence' },
              message: 'The recovered referral session has no matching click. No link attribution was created.',
            }, { status: 422 })
          }
        }
        recovered = ref
      } catch (err: any) {
        // RETRYABLE, explicitly distinguished from a known absence.
        console.error('[backfill] Stripe retrieval failed:', err?.message?.slice(0, 100))
        await sql`
          INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
          VALUES (${identity!.email}, 'backfill_attempt', 'orders', ${body.orderId},
                  ${JSON.stringify({ outcome: 'retryable_session_recovery_failed',
                             localSidPresent: state.localSidPresent,
                             localSidWellFormed: state.localSidWellFormed })}::jsonb)
        `
        return NextResponse.json({
          result: { outcome: 'retryable_session_recovery_failed' },
          message: 'Could not reach Stripe to recover the referral session. Nothing was changed — retry shortly.',
        }, { status: 503 })
      }
    }

    const result = await service
      .backfillAttribution(body.orderId, identity!.email, recovered)

    // ── EXHAUSTIVE OUTCOME HANDLING ─────────────────────────────────────────
    //
    // Every outcome the SQL can return is named here. A fall-through default
    // that reports success is dangerous: ambiguous_historical_ownership creates
    // NO attribution and NO commission, yet previously returned
    // "Attribution backfilled and reconciled."
    const outcome = result?.outcome

    if (outcome === 'already_attributed') {
      return NextResponse.json({ result, message: 'This order was already attributed.' })
    }
    if (outcome === 'no_attribution') {
      return NextResponse.json({ result,
        message: 'No affiliate qualifies for this order. No commission was created.' })
    }
    if (outcome === 'ambiguous_historical_ownership') {
      // Two affiliates owned the discount at this order's finalization instant.
      // Choosing one would be a decision nobody authorised.
      return NextResponse.json({ result,
        message: 'Historical ownership of this discount is ambiguous at the order date, '
               + 'so NO attribution or commission was created. Resolve the overlapping '
               + 'affiliate terms history, then retry.' }, { status: 409 })
    }
    if (outcome === 'backfilled') {
      if (result?.incomplete) {
        return NextResponse.json({ result,
          message: 'Attribution created, but an unresolved refund or dispute means the '
                 + 'commission is incomplete and not payable.' })
      }
      return NextResponse.json({ result, message: 'Attribution backfilled and reconciled.' })
    }

    // Unrecognised outcome: report it plainly rather than assuming success.
    console.error('[admin/affiliates/backfill] unhandled outcome:', outcome)
    return NextResponse.json({ result,
      message: `Backfill returned an unrecognised outcome (${outcome ?? 'unknown'}). `
             + 'No success is implied; please review.' }, { status: 422 })
  } catch (err: any) {
    const msg = String(err?.message ?? '')
    if (msg.includes('ORDER_NOT_FOUND')) {
      return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
    }
    console.error('[admin/affiliates/backfill]', msg.slice(0, 120))
    return NextResponse.json({ error: 'Could not backfill attribution.' }, { status: 500 })
  }
}
