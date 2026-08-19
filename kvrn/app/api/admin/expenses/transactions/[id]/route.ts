// DELETE /api/admin/expenses/transactions/[id]
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
    const ok = await createExpenseService(sql).deleteTransaction(id)
    if (!ok) return NextResponse.json({ error: 'Transaction not found.' }, { status: 404 })
    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${identity!.email}, 'delete', 'expense_transaction', ${id}, '{}'::jsonb)
    `
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('[admin/expenses/transactions DELETE]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not delete transaction.' }, { status: 500 })
  }
}
