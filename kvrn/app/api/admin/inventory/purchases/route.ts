// GET  /api/admin/inventory/purchases — purchases + their cash payments
// POST /api/admin/inventory/purchases — create a purchase or record a payment
//
// CASH IS NOT COGS. Payments recorded here are cash movements keyed on paid_at.
// They never enter operating-expense recognition and never become COGS; the
// capitalised cost reaches the P&L only as FIFO layers are consumed.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

const PAYMENT_TYPES = ['deposit','partial','final','supplier','freight',
                       'duties','tariffs','customs_brokerage','other']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const [purchases, payments] = await Promise.all([
      sql`
        SELECT id, supplier, reference, status, total_cents AS "totalCents",
               ordered_at AS "orderedAt", received_at AS "receivedAt",
               notes, created_at AS "createdAt"
        FROM inventory_purchases ORDER BY COALESCE(ordered_at, created_at::date) DESC LIMIT 200
      `,
      sql`
        SELECT id, purchase_id AS "purchaseId", payment_type AS "paymentType",
               amount_cents AS "amountCents", paid_at AS "paidAt",
               method, reference, notes
        FROM inventory_purchase_payments ORDER BY paid_at DESC LIMIT 500
      `,
    ])
    return NextResponse.json({
      purchases: (purchases as any[]).map(p => ({
        ...p,
        totalCents: p.totalCents === null ? null : Number(p.totalCents),
        orderedAt:  p.orderedAt  ? String(p.orderedAt).slice(0, 10)  : null,
        receivedAt: p.receivedAt ? String(p.receivedAt).slice(0, 10) : null,
        createdAt:  new Date(p.createdAt).toISOString(),
      })),
      payments: (payments as any[]).map(p => ({
        ...p, amountCents: Number(p.amountCents),
        paidAt: String(p.paidAt).slice(0, 10),
      })),
    })
  } catch (err: any) {
    console.error('[admin/inventory/purchases GET]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load purchases.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  // ── Record a cash payment against an existing purchase ────────────────────
  if (body.kind === 'payment') {
    if (!body.purchaseId || !UUID_RE.test(body.purchaseId)) {
      return NextResponse.json({ error: 'A valid purchase is required.' }, { status: 400 })
    }
    if (!PAYMENT_TYPES.includes(body.paymentType)) {
      return NextResponse.json({ error: 'A valid payment type is required.' }, { status: 400 })
    }
    const amount = Number(body.amountCents)
    if (!Number.isInteger(amount) || amount < 0) {
      return NextResponse.json(
        { error: 'Amount must be a non-negative whole number of cents.' }, { status: 400 })
    }
    // The cash date is authoritative and is NOT inferred from a receipt date.
    if (!body.paidAt || !DATE_RE.test(body.paidAt)) {
      return NextResponse.json({ error: 'Paid date must be YYYY-MM-DD.' }, { status: 400 })
    }
    try {
      const rows = await sql`
        INSERT INTO inventory_purchase_payments
          (purchase_id, payment_type, amount_cents, paid_at, method, reference, notes, created_by)
        VALUES (${body.purchaseId}::uuid, ${body.paymentType}, ${amount},
                ${body.paidAt}::date, ${body.method ?? null}, ${body.reference ?? null},
                ${body.notes ?? null}, ${identity!.email})
        RETURNING id
      `
      const id = (rows as any[])[0]?.id
      await sql`
        INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
        VALUES (${identity!.email}, 'create', 'inventory_purchase_payment', ${id},
                ${JSON.stringify({ purchaseId: body.purchaseId, amount,
                                   paidAt: body.paidAt, type: body.paymentType })}::jsonb)
      `
      return NextResponse.json({ paymentId: id }, { status: 201 })
    } catch (err: any) {
      console.error('[admin/inventory/payment]', err?.message?.slice(0, 120))
      return NextResponse.json({ error: 'Could not record payment.' }, { status: 500 })
    }
  }

  // ── Create a purchase ─────────────────────────────────────────────────────
  if (!body.supplier || typeof body.supplier !== 'string' || !body.supplier.trim()) {
    return NextResponse.json({ error: 'Supplier is required.' }, { status: 400 })
  }
  for (const [label, v] of [['Ordered date', body.orderedAt], ['Received date', body.receivedAt]]) {
    if (v && !DATE_RE.test(v)) {
      return NextResponse.json({ error: `${label} must be YYYY-MM-DD.` }, { status: 400 })
    }
  }
  const total = body.totalCents === undefined || body.totalCents === null || body.totalCents === ''
    ? null : Number(body.totalCents)
  if (total !== null && (!Number.isInteger(total) || total < 0)) {
    return NextResponse.json(
      { error: 'Total must be a non-negative whole number of cents.' }, { status: 400 })
  }

  try {
    const rows = await sql`
      INSERT INTO inventory_purchases
        (supplier, reference, status, total_cents, ordered_at, received_at, notes, created_by)
      VALUES (${body.supplier.trim()}, ${body.reference ?? null},
              ${body.status ?? 'ordered'}, ${total},
              ${body.orderedAt ?? null}::date, ${body.receivedAt ?? null}::date,
              ${body.notes ?? null}, ${identity!.email})
      RETURNING id
    `
    const id = (rows as any[])[0]?.id
    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${identity!.email}, 'create', 'inventory_purchase', ${id},
              ${JSON.stringify({ supplier: body.supplier, totalCents: total })}::jsonb)
    `
    return NextResponse.json({ purchaseId: id }, { status: 201 })
  } catch (err: any) {
    console.error('[admin/inventory/purchases POST]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not create purchase.' }, { status: 500 })
  }
}
