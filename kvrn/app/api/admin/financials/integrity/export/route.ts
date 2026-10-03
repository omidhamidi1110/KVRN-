// GET /api/admin/financials/integrity/export — machine-readable reconciliation CSV.
//
// One row per current finding (an entity with no finding is RECONCILED and has no
// row). Same filters as the page. last_check_at is the instant this export was
// scanned, so the file states how fresh it is.
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import {
  createFinancialIntegrityService, parseFindingFilter, findingsToCsv,
} from '@/lib/financial-integrity'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const svc = createFinancialIntegrityService(sql)
    const scannedAt = new Date().toISOString()
    const findings = await svc.listFindings({ limit: 5000, ...parseFindingFilter(req.nextUrl.searchParams) })
    return new Response(findingsToCsv(findings, scannedAt), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="kvrn-reconciliation-${scannedAt.slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err: any) {
    console.error('[admin/financials/integrity/export]', err?.message?.slice(0, 120))
    return new Response(JSON.stringify({ error: 'Could not export reconciliation.' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
