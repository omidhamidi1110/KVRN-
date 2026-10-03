// DELETE /api/admin/expenses/transactions/[id]
//
// A booked expense is a MONEY FACT, so "delete" means VOID: the row, its amount and its
// history are retained (the database refuses a physical DELETE), the actor, reason and
// time are recorded, and reports stop counting it exactly once. Idempotent: repeating the
// request returns the original void and never rewrites who/why/when.
//
// The reason may be sent as JSON { "reason": "..." }; the Admin UI always sends one. When
// a legacy caller sends none, a fixed default is recorded so the void is still attributable.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createExpenseService } from '@/lib/expenses'

export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_REASON = 'Voided from the Admin (no reason given)'

export async function DELETE(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 })

  let reason = DEFAULT_REASON
  try {
    const body = await req.json()
    if (typeof body?.reason === 'string' && body.reason.trim()) reason = body.reason.trim().slice(0, 500)
  } catch { /* no body: default reason */ }

  try {
    const result = await createExpenseService(sql).voidTransaction(id, identity!.email, reason)
    if (!result) return NextResponse.json({ error: 'Transaction not found.' }, { status: 404 })
    return NextResponse.json({ ok: true, outcome: result.outcome })
  } catch (err: any) {
    console.error('[admin/expenses/transactions VOID]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not void transaction.' }, { status: 500 })
  }
}
