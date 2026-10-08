// GET /api/admin/affiliates/payout-readiness/statement?payoutId=…[&format=csv] — Admin view of a payout statement
// (adds the order number for reconciliation). requireAdmin FIRST.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { buildStatement, statementToCsv } from '@/lib/affiliate-payout-statements'
import { isUuid } from '@/lib/affiliate-payout-readiness'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const id = req.nextUrl.searchParams.get('payoutId')
  if (!id || !isUuid(id)) return NextResponse.json({ error: 'A valid payout is required.' }, { status: 400 })
  try {
    const st = await buildStatement(sql, id, 'admin')
    if (!st) return NextResponse.json({ error: 'Payout not found.' }, { status: 404 })
    if (req.nextUrl.searchParams.get('format') === 'csv') {
      return new NextResponse(statementToCsv(st), {
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="payout-${st.payoutNumber ?? st.payoutRef}.csv"`, 'Cache-Control': 'no-store' },
      })
    }
    return NextResponse.json({ statement: st })
  } catch (err: any) {
    console.error('[admin/affiliates/payout-readiness/statement]', String(err?.message ?? '').slice(0, 120))
    return NextResponse.json({ error: 'Could not build the statement.' }, { status: 500 })
  }
}
