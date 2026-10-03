// GET /api/admin/financials/tax-export?year=YYYY — tax-year bookkeeping summary CSV.
//
// Admin-only (requireAdmin runs first). Read-only: writes nothing. Every figure is taken
// from createFinancialService(sql).getPeriodReport(), the same source of truth as the
// admin financial summary; lib/tax-export.ts only lays it out. See that file for the
// accounting rules (unknown stays blank, sales tax separate, recurring definitions
// never counted as expense).
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createFinancialService } from '@/lib/financials'
import {
  parseTaxYear, taxYearRange, buildTaxExportRows, taxRowsToCsv, taxExportFilename,
  countFixedDefinitionsWithoutPaidBill,
} from '@/lib/tax-export'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error

  const parsed = parseTaxYear(req.nextUrl.searchParams.get('year'))
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { year } = parsed

  try {
    const svc = createFinancialService(sql)
    const range = taxYearRange(year)
    const [report, writeOffs, cash, fixedWithoutBill] = await Promise.all([
      svc.getPeriodReport(range),
      svc.getWriteOffCostInRange(range),
      svc.getRecordedCashMovement(range),
      countFixedDefinitionsWithoutPaidBill(sql, year),
    ])

    const generatedAt = new Date().toISOString()
    const csv = taxRowsToCsv(buildTaxExportRows({
      year, generatedAt,
      period: report.period,
      orders: report.orders,
      integrity: report.integrity,
      writeOffUnknown: writeOffs.unknown,
      cashRefundsPaidCents: cash.refundsPaidCents,
      cashExpensePaymentsCents: cash.expensePaymentsCents,
      fixedDefinitionsWithoutPaidBill: fixedWithoutBill,
    }))

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${taxExportFilename(year)}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err: any) {
    // Message only, truncated: no rows, no order data, no customer details are logged.
    console.error('[admin/financials/tax-export]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not generate the tax export.' }, { status: 500 })
  }
}
