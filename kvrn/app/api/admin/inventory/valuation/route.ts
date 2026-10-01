// GET /api/admin/inventory/valuation
//
// Value is DERIVED from authoritative layer quantities and costs. There is no
// second, manually maintained valuation that could drift.
//
// Unknown-cost units are reported SEPARATELY and never folded into the value.
// When any exist, the response is flagged partial so the UI cannot present a
// known-cost subtotal as a complete valuation.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const [rows, recon] = await Promise.all([
      sql`SELECT * FROM inventory_valuation() ORDER BY product_name, sku`,
      sql`SELECT * FROM reconcile_inventory_layers()`,
    ])

    const variants = (rows as any[]).map(r => ({
      variantId:          r.variant_id,
      sku:                r.sku,
      productName:        r.product_name,
      stockOnHand:        Number(r.stock_on_hand),
      layerUnitsRemaining: Number(r.layer_units_remaining),
      knownCostUnits:     Number(r.known_cost_units),
      unknownCostUnits:   Number(r.unknown_cost_units),
      valueAtCostCents:   Number(r.value_at_cost_cents),
      reconciled:         Boolean(r.reconciled),
    }))

    const unknownUnits = variants.reduce((s, v) => s + v.unknownCostUnits, 0)
    const totals = {
      knownValueCents: variants.reduce((s, v) => s + v.valueAtCostCents, 0),
      knownCostUnits:  variants.reduce((s, v) => s + v.knownCostUnits, 0),
      unknownCostUnits: unknownUnits,
      totalUnits:      variants.reduce((s, v) => s + v.stockOnHand, 0),
      // The known subtotal is NOT a complete valuation while any unit is unknown.
      isPartialValuation: unknownUnits > 0,
      reconciliationFailures: (recon as any[]).length,
    }

    return NextResponse.json({
      variants, totals,
      reconciliation: (recon as any[]).map(r => ({
        variantId: r.variant_id, sku: r.sku,
        stockOnHand: Number(r.stock_on_hand),
        layerUnits:  Number(r.layer_units),
        difference:  Number(r.difference),
      })),
    })
  } catch (err: any) {
    console.error('[admin/inventory/valuation]', err?.message?.slice(0, 120))
    return NextResponse.json({ error: 'Could not load inventory valuation.' }, { status: 500 })
  }
}
