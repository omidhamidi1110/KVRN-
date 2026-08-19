// GET  /api/admin/expenses/transactions — ACTUAL billed expenses
// POST /api/admin/expenses/transactions
//
// This is the ONLY expense table that reduces realised operating profit.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createExpenseService, validateExpenseTransaction } from '@/lib/expenses'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    return NextResponse.json({ transactions: await createExpenseService(sql).listTransactions() })
  } catch (err: any) {
    console.error('[admin/expenses/transactions GET]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load transactions.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const input = {
    expenseDefinitionId: body.expenseDefinitionId || null,
    provider:            typeof body.provider === 'string' ? body.provider : '',
    category:            body.category,
    name:                typeof body.name === 'string' ? body.name : '',
    amountCents:         body.amountCents === null || body.amountCents === undefined
      ? NaN : Number(body.amountCents),
    periodStart: body.periodStart || null,
    periodEnd:   body.periodEnd   || null,
    paidAt:      body.paidAt      || null,
    invoiceId:   body.invoiceId   || null,
    source:      body.source      || 'manual',
    notes:       body.notes       || null,
  }

  const v = validateExpenseTransaction(input as any)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  try {
    const created = await createExpenseService(sql).createTransaction(input as any, identity!.email)
    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${identity!.email}, 'create', 'expense_transaction', ${created.id},
              ${JSON.stringify({ provider: input.provider, amountCents: input.amountCents,
                                 category: input.category, paidAt: input.paidAt })}::jsonb)
    `
    return NextResponse.json({ transaction: created }, { status: 201 })
  } catch (err: any) {
    console.error('[admin/expenses/transactions POST]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not create transaction.' }, { status: 500 })
  }
}
