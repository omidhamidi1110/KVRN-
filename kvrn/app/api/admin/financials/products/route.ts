// GET /api/admin/financials/products — per-product profitability for a window.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import {
  createFinancialService, resolveRangePreset, parseCustomRange,
  type RangePreset, type DateRange,
} from '@/lib/financials'

export const dynamic = 'force-dynamic'
const PRESETS: RangePreset[] = ['today', '7d', '30d', 'mtd', 'ytd']

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error

  const p = req.nextUrl.searchParams
  let range: DateRange | null
  if (p.get('start') && p.get('end')) {
    range = parseCustomRange(p.get('start'), p.get('end'))
    if (!range) return NextResponse.json({ error: 'Invalid custom range.' }, { status: 400 })
  } else {
    const raw = p.get('range') ?? '30d'
    range = resolveRangePreset(PRESETS.includes(raw as RangePreset) ? (raw as RangePreset) : '30d')
  }

  try {
    const products = await createFinancialService(sql).getProductProfitability(range)
    return NextResponse.json({ range, products })
  } catch (err: any) {
    console.error('[admin/financials/products]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load product profitability.' }, { status: 500 })
  }
}
