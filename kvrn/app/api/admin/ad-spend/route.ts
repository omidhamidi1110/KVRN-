// GET  /api/admin/ad-spend — list advertising spend
// POST /api/admin/ad-spend — record advertising spend
//
// provider_reported_* fields are the PLATFORM'S OWN attribution claims. They are
// stored for comparison only and are never summed into KVRN revenue or profit.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createExpenseService, validateAdSpendInput } from '@/lib/expenses'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    return NextResponse.json({ adSpend: await createExpenseService(sql).listAdSpend() })
  } catch (err: any) {
    console.error('[admin/ad-spend GET]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load ad spend.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const optInt = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v))
  const input = {
    platform:      body.platform,
    campaignName:  body.campaignName || null,
    campaignId:    body.campaignId || null,
    spendCents:    body.spendCents === null || body.spendCents === undefined
      ? NaN : Number(body.spendCents),
    periodStart:   body.periodStart,
    periodEnd:     body.periodEnd,
    providerReportedRevenueCents: optInt(body.providerReportedRevenueCents),
    providerReportedOrders:       optInt(body.providerReportedOrders),
    // Provenance of the platform's self-reported metrics
    providerSource: body.providerSource || null,
    notes:         body.notes || null,
  }

  const v = validateAdSpendInput(input as any)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  try {
    const created = await createExpenseService(sql).createAdSpend(input as any, identity!.email)
    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${identity!.email}, 'create', 'ad_spend', ${created.id},
              ${JSON.stringify({ platform: input.platform, spendCents: input.spendCents,
                                 periodStart: input.periodStart, periodEnd: input.periodEnd })}::jsonb)
    `
    return NextResponse.json({ adSpend: created }, { status: 201 })
  } catch (err: any) {
    console.error('[admin/ad-spend POST]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not record ad spend.' }, { status: 500 })
  }
}
