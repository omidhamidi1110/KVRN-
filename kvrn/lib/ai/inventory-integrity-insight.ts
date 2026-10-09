/** Deterministic, server-side inventory summary for the KVRN private Admin.
 * Reads canonical physical stock/reservations and reconciled FIFO valuation;
 * never mutates inventory, quotes cost from retail, or sends data to an LLM.
 */
import {sql} from '@/lib/db'
export type InventoryIntegritySummary={
 variantCount:number;activeVariantCount:number;availableUnits:number|null;
 unknownCostUnits:number;unreconciledVariants:number;invalidStockRows:number;
 knownLandedCostCents:number|null;completeValuation:boolean
}
function checked(raw:unknown):number{
 const n=Number(raw)
 if(raw===null||raw===undefined||!Number.isSafeInteger(n)||n<0)throw Error('INVENTORY_INSIGHT_UNVERIFIED_NUMBER')
 return n
}
export function interpretInventoryIntegrityRow(r:Record<string,unknown>):InventoryIntegritySummary{
 const variantCount=checked(r.variant_count),activeVariantCount=checked(r.active_variants)
 const unknownCostUnits=checked(r.unknown_cost_units),unreconciledVariants=checked(r.unreconciled_variants)
 const invalidStockRows=checked(r.invalid_stock_rows)
 if(activeVariantCount>variantCount||unreconciledVariants>variantCount||invalidStockRows>variantCount)
  throw Error('INVENTORY_INSIGHT_INVALID_COUNTS')
 const available=checked(r.available_units),known=checked(r.known_cost_cents)
 const integrityGood=unreconciledVariants===0&&invalidStockRows===0
 // Physical availability is indeterminate if any reservation or stock is corrupt.
 // Full asset valuation cannot claim completeness while costs are unknown.
 return {variantCount,activeVariantCount,availableUnits:integrityGood?available:null,
  unknownCostUnits,unreconciledVariants,invalidStockRows,
  knownLandedCostCents:integrityGood?known:null,
  completeValuation:integrityGood&&unknownCostUnits===0}
}
export async function getInventoryIntegritySummary():Promise<InventoryIntegritySummary>{
 const rows=await sql`SELECT COUNT(*)::text AS variant_count,
   COUNT(*) FILTER(WHERE pv.active AND p.active)::text AS active_variants,
   COALESCE(SUM(pv.stock_on_hand-pv.reserved_quantity)
      FILTER(WHERE pv.active AND p.active),0)::numeric::text AS available_units,
   COALESCE(SUM(v.unknown_cost_units),0)::numeric::text AS unknown_cost_units,
   COUNT(*) FILTER(WHERE v.reconciled IS DISTINCT FROM TRUE)::text AS unreconciled_variants,
   COUNT(*) FILTER(WHERE pv.stock_on_hand<0 OR pv.reserved_quantity<0
     OR pv.reserved_quantity>pv.stock_on_hand OR v.stock_on_hand IS DISTINCT FROM pv.stock_on_hand)::text AS invalid_stock_rows,
   COALESCE(SUM(v.value_at_cost_cents),0)::numeric::text AS known_cost_cents
   FROM inventory_valuation() v JOIN product_variants pv ON pv.id=v.variant_id
   JOIN products p ON p.id=pv.product_id`
 if(rows.length!==1)throw Error('INVENTORY_INSIGHT_SCHEMA_UNAVAILABLE')
 return interpretInventoryIntegrityRow(rows[0] as Record<string,unknown>)
}
