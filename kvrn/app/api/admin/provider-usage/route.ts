// GET  /api/admin/provider-usage — latest usage snapshot per provider+metric
// POST /api/admin/provider-usage — record a usage reading
//
// Usage snapshots are ESTIMATES AND PROJECTIONS. estimated_accrued_cents and
// projected_month_end_cents are forecasts, never bills, and are structurally
// excluded from every realised-profit figure.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createExpenseService, validateUsageSnapshot } from '@/lib/expenses'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    return NextResponse.json({
      snapshots: await createExpenseService(sql).listLatestUsageSnapshots(),
    })
  } catch (err: any) {
    console.error('[admin/provider-usage GET]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load usage snapshots.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const optNum = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v))
  const input = {
    provider:               typeof body.provider === 'string' ? body.provider : '',
    metricName:             typeof body.metricName === 'string' ? body.metricName : '',
    metricUnit:             typeof body.metricUnit === 'string' ? body.metricUnit : '',
    usageValue:             optNum(body.usageValue),
    includedAllowance:      optNum(body.includedAllowance),
    estimatedAccruedCents:  optNum(body.estimatedAccruedCents),
    projectedMonthEndCents: optNum(body.projectedMonthEndCents),
    thresholdStatus:        body.thresholdStatus || null,
    billingPeriodStart:     body.billingPeriodStart || null,
    billingPeriodEnd:       body.billingPeriodEnd || null,
    source:                 body.source || 'manual',
    notes:                  body.notes || null,
  }

  const v = validateUsageSnapshot(input as any)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  try {
    const created = await createExpenseService(sql).createUsageSnapshot(input as any, identity!.email)
    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${identity!.email}, 'create', 'provider_usage_snapshot', ${created.id},
              ${JSON.stringify({ provider: input.provider, metricName: input.metricName,
                                 source: input.source })}::jsonb)
    `
    return NextResponse.json({ snapshot: created }, { status: 201 })
  } catch (err: any) {
    console.error('[admin/provider-usage POST]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not record usage snapshot.' }, { status: 500 })
  }
}
