// GET /api/admin/financials/infrastructure/timeseries
//
// Provider usage and spend over time. Deliberately SEPARATE from the financial
// series: this answers "how much have I used and how close am I to a charge",
// which is an operational question, not a P&L one.
//
// Usage points come from provider_usage_snapshots (readings, possibly forecasts).
// Spend points come from expense_transactions (real invoices). They are returned
// as distinct series and never summed together.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import {
  resolveRangePreset, parseCustomRange, type RangePreset, type DateRange,
} from '@/lib/financials'
import { autoGranularity, buildBuckets, bucketIndexFor } from '@/lib/chart-math'

export const dynamic = 'force-dynamic'
const PRESETS: RangePreset[] = ['today', '7d', '30d', '90d', 'mtd', 'ytd', '1y', 'all']

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error

  const p = req.nextUrl.searchParams
  let range: DateRange | null
  if (p.get('start') && p.get('end')) {
    range = parseCustomRange(p.get('start'), p.get('end'))
    if (!range) return NextResponse.json({ error: 'Invalid custom range.' }, { status: 400 })
  } else {
    const raw = p.get('range') ?? '90d'
    range = resolveRangePreset(PRESETS.includes(raw as RangePreset) ? (raw as RangePreset) : '90d')
  }

  const provider = p.get('provider')?.trim() || null
  const metric   = p.get('metric')?.trim() || null

  try {
    const granularity = autoGranularity(range.start, range.end)
    const buckets = buildBuckets(range.start, range.end, granularity)

    const [usageRows, spendRows, available] = await Promise.all([
      sql`
        SELECT provider, metric_name AS "metricName", metric_unit AS "metricUnit",
               usage_value AS "usageValue", included_allowance AS "includedAllowance",
               estimated_accrued_cents AS "estimatedAccruedCents",
               captured_at AS "capturedAt"
        FROM provider_usage_snapshots
        WHERE captured_at >= ${range.start} AND captured_at < ${range.end}
          AND (${provider}::text IS NULL OR provider = ${provider})
          AND (${metric}::text   IS NULL OR metric_name = ${metric})
        ORDER BY captured_at ASC
      `,
      sql`
        SELECT provider, amount_cents AS "amountCents", paid_at AS "paidAt"
        FROM expense_transactions
        WHERE paid_at IS NOT NULL
          AND paid_at >= ${range.start}::date AND paid_at < ${range.end}::date
          AND (${provider}::text IS NULL OR provider = ${provider})
        ORDER BY paid_at ASC
      `,
      sql`
        SELECT DISTINCT provider, metric_name AS "metricName", metric_unit AS "metricUnit"
        FROM provider_usage_snapshots ORDER BY provider, metric_name
      `,
    ])

    // Usage: last reading wins inside a bucket. Usage is a level (a meter
    // reading), not a flow, so summing readings within a bucket would be wrong.
    const usage = buckets.map(() => null as number | null)
    const accrued = buckets.map(() => null as number | null)
    for (const r of usageRows as any[]) {
      const i = bucketIndexFor(buckets, new Date(r.capturedAt).toISOString())
      if (i < 0) continue
      if (r.usageValue !== null) usage[i] = Number(r.usageValue)
      if (r.estimatedAccruedCents !== null) accrued[i] = Number(r.estimatedAccruedCents)
    }

    // Spend: a flow, so invoices inside a bucket are summed.
    const spend = buckets.map(() => 0)
    for (const r of spendRows as any[]) {
      const iso = new Date(String(r.paidAt).slice(0, 10) + 'T00:00:00Z').toISOString()
      const i = bucketIndexFor(buckets, iso)
      if (i < 0) continue
      spend[i] += Number(r.amountCents)
    }

    const latest = (usageRows as any[])[(usageRows as any[]).length - 1] ?? null

    return NextResponse.json({
      range, granularity,
      labels: buckets.map(b => b.label),
      series: {
        usageValue:            usage,
        estimatedAccruedCents: accrued,
        spendCents:            spend,
      },
      metricUnit: latest?.metricUnit ?? null,
      includedAllowance: latest?.includedAllowance === null || latest == null
        ? null : Number(latest.includedAllowance),
      availableMetrics: (available as any[]).map(a => ({
        provider: a.provider, metricName: a.metricName, metricUnit: a.metricUnit,
      })),
    })
  } catch (err: any) {
    console.error('[admin/financials/infrastructure/timeseries]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load usage series.' }, { status: 500 })
  }
}
