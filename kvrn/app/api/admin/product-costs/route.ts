// GET  /api/admin/product-costs — cost batches + current coverage per SKU
// POST /api/admin/product-costs — create a cost batch
//
// Creating a batch NEVER changes historical order profitability: finalize_paid_order
// snapshots the resolved cost onto order_items at the moment of sale.

import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createProductCostService, validateCostBatchInput } from '@/lib/product-costs'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const service = createProductCostService(sql)
    const [batches, coverage, products] = await Promise.all([
      service.listCostBatches(),
      service.getCurrentCostCoverage(),
      sql`SELECT id, name, slug FROM products WHERE active = TRUE ORDER BY name`,
    ])
    return NextResponse.json({ batches, coverage, products })
  } catch (err: any) {
    console.error('[admin/product-costs GET]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load product costs.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const num = (v: any) => (v === null || v === undefined || v === '' ? 0 : Number(v))
  const input = {
    productId:          body.productId,
    variantId:          body.variantId || null,
    colorName:          body.colorName || null,
    batchLabel:         body.batchLabel || null,
    manufacturingCents: num(body.manufacturingCents),
    freightCents:       num(body.freightCents),
    dutiesCents:        num(body.dutiesCents),
    tariffsCents:       num(body.tariffsCents),
    importTaxCents:     num(body.importTaxCents),
    packagingCents:     num(body.packagingCents),
    otherLandedCents:   num(body.otherLandedCents),
    effectiveFrom:      body.effectiveFrom,
    note:               body.note || null,
  }

  const v = validateCostBatchInput(input)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  try {
    const created = await createProductCostService(sql).createCostBatch(input, identity!.email)
    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${identity!.email}, 'create', 'product_cost_batch', ${created.id},
              ${JSON.stringify({ productId: input.productId, unitCogsCents: created.unitCogsCents,
                                 effectiveFrom: input.effectiveFrom })}::jsonb)
    `
    return NextResponse.json({ batch: created }, { status: 201 })
  } catch (err: any) {
    console.error('[admin/product-costs POST]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not create cost batch.' }, { status: 500 })
  }
}
