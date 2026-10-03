// GET  /api/admin/financials/integrity   summary + findings (filterable)
// POST /api/admin/financials/integrity   run the scan and APPEND the result to history
//
// GET is read-only and always re-derives from the authoritative rows. POST writes
// only to the append-only detection history; it never touches an economic record.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createFinancialIntegrityService, parseFindingFilter } from '@/lib/financial-integrity'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const svc = createFinancialIntegrityService(sql)
    const filter = parseFindingFilter(req.nextUrl.searchParams)
    const [summary, findings] = await Promise.all([
      svc.getSummary(),
      svc.listFindings({ limit: 500, ...filter }),
    ])
    return NextResponse.json({ summary, findings })
  } catch (err: any) {
    console.error('[admin/financials/integrity]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load reconciliation.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  try {
    const svc = createFinancialIntegrityService(sql)
    const run = await svc.recordRun(identity!.email, 'manual')
    return NextResponse.json({ ok: true, run })
  } catch (err: any) {
    console.error('[admin/financials/integrity:run]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not record reconciliation run.' }, { status: 500 })
  }
}
