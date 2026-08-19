// GET  /api/admin/expenses/definitions — EXPECTED recurring obligations
// POST /api/admin/expenses/definitions
//
// A definition is what KVRN expects to owe. It is NOT a billed expense and never
// reduces realised profit on its own — only an expense_transaction does that.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createExpenseService, validateExpenseDefinition } from '@/lib/expenses'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    return NextResponse.json({ definitions: await createExpenseService(sql).listDefinitions() })
  } catch (err: any) {
    console.error('[admin/expenses/definitions GET]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load definitions.' }, { status: 500 })
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
    provider:            typeof body.provider === 'string' ? body.provider : '',
    category:            body.category,
    name:                typeof body.name === 'string' ? body.name : '',
    cadence:             body.cadence,
    expectedAmountCents: body.expectedAmountCents === null || body.expectedAmountCents === undefined
      || body.expectedAmountCents === '' ? null : Number(body.expectedAmountCents),
    renewalDate:         body.renewalDate || null,
    active:              body.active !== false,
    notes:               body.notes || null,
  }

  const v = validateExpenseDefinition(input as any)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  try {
    const created = await createExpenseService(sql).createDefinition(input as any, identity!.email)
    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${identity!.email}, 'create', 'expense_definition', ${created.id},
              ${JSON.stringify({ provider: input.provider, cadence: input.cadence,
                                 expectedAmountCents: input.expectedAmountCents })}::jsonb)
    `
    return NextResponse.json({ definition: created }, { status: 201 })
  } catch (err: any) {
    console.error('[admin/expenses/definitions POST]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not create definition.' }, { status: 500 })
  }
}
