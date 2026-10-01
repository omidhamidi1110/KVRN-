// GET  /api/admin/affiliates/recoveries — commissions with an overpayment
// POST /api/admin/affiliates/recoveries — record owed, or collect cash
//
// FOUR DISTINCT CONCEPTS, deliberately never merged:
//   commission economics  the append-only adjustment ledger
//   payouts paid          cash out to the affiliate
//   recovery owed         a workflow marker recording the decision to pursue
//   recovery collected    cash actually received back
//
// The outstanding amount is DERIVED (cash paid minus ledger earnings, less cash
// already collected), so it cannot drift from the ledger. Collecting cash writes
// adjustment_cents = 0: the refund or dispute that created the overpayment
// already moved the economics, and charging it again would count one event twice.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createAffiliatesService } from '@/lib/affiliates'

export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    return NextResponse.json({ recoveries: await createAffiliatesService(sql).listRecoveries() })
  } catch (err: any) {
    console.error('[admin/affiliates/recoveries GET]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load recoveries.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  if (!UUID_RE.test(body.commissionId ?? '')) {
    return NextResponse.json({ error: 'A valid commission is required.' }, { status: 400 })
  }
  const amount = Number(body.amountCents)
  if (!Number.isInteger(amount) || amount <= 0) {
    return NextResponse.json(
      { error: 'Amount must be a positive whole number of cents.' }, { status: 400 })
  }
  if (body.effectiveAt && !DATE_RE.test(body.effectiveAt)) {
    return NextResponse.json({ error: 'Date must be YYYY-MM-DD.' }, { status: 400 })
  }
  // The CLIENT generates one key per attempt and reuses it on retry, so a lost
  // response cannot become a second cash row. Amount is not a key: two genuine
  // partial recoveries of the same value are legitimate.
  const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : ''
  if (!key || key.length > 200) {
    return NextResponse.json(
      { error: 'An idempotency key is required for recovery operations.' }, { status: 400 })
  }

  const service = createAffiliatesService(sql)
  try {
    if (body.action === 'record') {
      // A marker that recovery is OWED. Not cash.
      const result = await service.recordRecoveryOwed(
        body.commissionId, amount, body.effectiveAt ?? null,
        body.notes ?? null, identity!.email, key)
      return NextResponse.json({ result }, { status: 201 })
    }
    if (body.action === 'collect') {
      // Cash actually received. Bounded by the derived outstanding amount in SQL.
      const result = await service.collectRecovery(
        body.commissionId, amount, body.effectiveAt ?? null,
        body.method ?? null, body.reference ?? null, identity!.email, key,
        body.notes ?? null)
      return NextResponse.json({ result })
    }
    return NextResponse.json(
      { error: "Action must be 'record' or 'collect'." }, { status: 400 })
  } catch (err: any) {
    const msg = String(err?.message ?? '')
    if (msg.includes('IDEMPOTENCY_CONFLICT')) {
      // Same key, different payload: nothing was mutated.
      return NextResponse.json(
        { error: 'That idempotency key was already used for a different request. Nothing was recorded.' },
        { status: 409 })
    }
    if (msg.includes('IDEMPOTENCY_KEY_REQUIRED')) {
      return NextResponse.json(
        { error: 'An idempotency key is required.' }, { status: 400 })
    }
    if (msg.includes('EXCEEDS_OUTSTANDING')) {
      return NextResponse.json(
        { error: 'That exceeds the outstanding recovery for this commission.' },
        { status: 409 })
    }
    if (msg.includes('INVALID_AMOUNT') || msg.includes('INVALID_RECOVERY_AMOUNT')) {
      return NextResponse.json({ error: 'Amount is not valid.' }, { status: 400 })
    }
    if (msg.includes('COMMISSION_NOT_FOUND')) {
      return NextResponse.json({ error: 'Commission not found.' }, { status: 404 })
    }
    console.error('[admin/affiliates/recoveries POST]', msg.slice(0, 120))
    return NextResponse.json({ error: 'Could not process recovery.' }, { status: 500 })
  }
}
