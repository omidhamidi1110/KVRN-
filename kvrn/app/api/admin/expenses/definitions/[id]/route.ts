// PATCH  /api/admin/expenses/definitions/[id]   body: { active: boolean }
// DELETE /api/admin/expenses/definitions/[id]
//
// PATCH only flips the EXPECTED obligation active/inactive (the "ended" state of a
// recurring definition). It never creates, edits or voids an expense_transaction.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createExpenseService } from '@/lib/expenses'

export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function DELETE(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 })
  try {
    const ok = await createExpenseService(sql).deleteDefinition(id)
    if (!ok) return NextResponse.json({ error: 'Definition not found.' }, { status: 404 })
    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${identity!.email}, 'delete', 'expense_definition', ${id}, '{}'::jsonb)
    `
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('[admin/expenses/definitions DELETE]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not delete definition.' }, { status: 500 })
  }
}

export async function PATCH(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 })

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  if (typeof body?.active !== 'boolean') {
    return NextResponse.json({ error: 'active must be true or false.' }, { status: 400 })
  }

  try {
    const row = await createExpenseService(sql).setDefinitionActive(id, body.active)
    if (!row) return NextResponse.json({ error: 'Definition not found.' }, { status: 404 })
    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${identity!.email}, 'update', 'expense_definition', ${id},
              ${JSON.stringify({ active: body.active })}::jsonb)
    `
    return NextResponse.json({ ok: true, active: row.active })
  } catch (err: any) {
    console.error('[admin/expenses/definitions PATCH]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not update definition.' }, { status: 500 })
  }
}
