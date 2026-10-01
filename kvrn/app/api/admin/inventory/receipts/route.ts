// GET  /api/admin/inventory/receipts — batch receipt progress + reconciliation
// POST /api/admin/inventory/receipts — receive units against a cost batch
//
// The client sends a batch, a variant and a quantity. It never sends a cost:
// unit costs, the remainder split and the resulting layers are all derived
// server-side by receive_batch_units().
//
// Partial receipts are cumulative, so any partition of a batch capitalises the
// same total. Over-receipt, cross-product and cross-colour receipts are rejected.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const [batches, recon, receipts] = await Promise.all([
      sql`SELECT * FROM batch_receipt_status() ORDER BY product_name, batch_label NULLS LAST`,
      sql`SELECT * FROM purchase_reconciliation() ORDER BY supplier`,
      sql`
        SELECT r.id, r.quantity, r.premium_units_this AS "premiumUnits",
               r.received_at AS "receivedAt", r.created_by AS "createdBy",
               pv.sku, b.batch_label AS "batchLabel"
        FROM inventory_batch_receipts r
        JOIN product_variants pv ON pv.id = r.variant_id
        JOIN product_cost_batches b ON b.id = r.cost_batch_id
        ORDER BY r.received_at DESC LIMIT 200
      `,
    ])
    return NextResponse.json({
      batches: (batches as any[]).map(b => ({
        costBatchId:      b.cost_batch_id,
        productName:      b.product_name,
        batchLabel:       b.batch_label,
        intendedUnits:    b.intended_units === null ? null : Number(b.intended_units),
        receivedUnits:    Number(b.received_units),
        remainingUnits:   Number(b.remaining_units),
        unitCogsCents:    b.unit_cogs_cents === null ? null : Number(b.unit_cogs_cents),
        // Two distinct figures. Intended is the exact full-batch total including
        // remainder cents; received is what has actually been capitalised so far.
        intendedCapitalizedCents: Number(b.intended_capitalized_cents),
        receivedCapitalizedCents: Number(b.received_capitalized_cents),
        fullyReceived:            Boolean(b.fully_received),
        capitalizationReconciled: Boolean(b.capitalization_reconciled),
      })),
      // Cash vs capitalised cost. A variance is a flag for review, not an error:
      // deposits and late freight invoices legitimately land on other dates.
      reconciliation: (recon as any[]).map(r => ({
        purchaseId:         r.purchase_id,
        supplier:           r.supplier,
        reference:          r.reference,
        status:             r.status,
        expectedTotalCents: r.expected_total_cents === null ? null : Number(r.expected_total_cents),
        costBatchCount:     Number(r.cost_batch_count),
        intendedCapitalizedCents: Number(r.intended_capitalized_cents),
        // Variance compares cash against value ACTUALLY RECEIVED, never against
        // the cost of units that have not arrived.
        receivedCapitalizedCents: Number(r.received_capitalized_cents),
        cashPaidCents:            Number(r.cash_paid_cents),
        varianceCents:            Number(r.variance_cents),
        fullyReceived:            Boolean(r.fully_received),
      })),
      receipts: (receipts as any[]).map(r => ({
        ...r,
        quantity: Number(r.quantity),
        premiumUnits: Number(r.premiumUnits),
        receivedAt: new Date(r.receivedAt).toISOString(),
      })),
    })
  } catch (err: any) {
    console.error('[admin/inventory/receipts GET]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load batch receipts.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  if (!body.costBatchId || !UUID_RE.test(body.costBatchId)) {
    return NextResponse.json({ error: 'A valid cost batch is required.' }, { status: 400 })
  }
  if (!body.variantId || !UUID_RE.test(body.variantId)) {
    return NextResponse.json({ error: 'A valid variant is required.' }, { status: 400 })
  }
  const quantity = Number(body.quantity)
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return NextResponse.json({ error: 'Quantity must be a positive whole number.' }, { status: 400 })
  }

  try {
    // No cost is accepted from the client; it is derived from the batch.
    const rows = await sql`SELECT receive_batch_units(
      ${body.costBatchId}::uuid, ${body.variantId}::uuid, ${quantity},
      ${body.idempotencyKey ?? null}, ${identity!.email}
    ) AS result`
    const result = (rows as any[])[0]?.result

    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${identity!.email}, 'create', 'inventory_batch_receipt',
              ${result?.receipt_id ?? null},
              ${JSON.stringify({ costBatchId: body.costBatchId, variantId: body.variantId,
                                 quantity, outcome: result?.outcome })}::jsonb)
    `
    return NextResponse.json({ result }, { status: 201 })
  } catch (err: any) {
    const msg = String(err?.message ?? '')
    // A reused key carrying a materially different request is not a replay.
    // 409 so the caller knows the key is taken, not that the work succeeded.
    if (msg.includes('IDEMPOTENCY_CONFLICT')) {
      return NextResponse.json(
        { error: 'That idempotency key was already used for a different batch, variant or quantity. Nothing was received. Retry with a new key, or resubmit the identical request.' },
        { status: 409 })
    }
    if (msg.includes('OVER_RECEIPT')) {
      return NextResponse.json(
        { error: 'That exceeds the units this batch was created for.' }, { status: 400 })
    }
    if (msg.includes('PRODUCT_MISMATCH')) {
      return NextResponse.json(
        { error: 'That variant belongs to a different product than this cost batch.' }, { status: 400 })
    }
    if (msg.includes('VARIANT_SCOPE_MISMATCH')) {
      return NextResponse.json(
        { error: 'This cost batch targets a specific, different variant.' }, { status: 400 })
    }
    if (msg.includes('COLOUR_SCOPE_MISMATCH')) {
      return NextResponse.json(
        { error: 'This cost batch targets a different colour.' }, { status: 400 })
    }
    if (msg.includes('BATCH_NOT_FOUND'))   return NextResponse.json({ error: 'Cost batch not found.' }, { status: 404 })
    if (msg.includes('VARIANT_NOT_FOUND')) return NextResponse.json({ error: 'Variant not found.' }, { status: 404 })
    console.error('[admin/inventory/receipts POST]', msg.slice(0, 120))
    return NextResponse.json({ error: 'Could not record receipt.' }, { status: 500 })
  }
}
