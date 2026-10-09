/** Aggregate payment exception integrity for private, authenticated Admin insights.
 * Intentionally never selects identifiers, payment method, contact information or addresses.
 */
import {sql} from '@/lib/db'

export type PaymentExceptionSummary={
 openCount:number;resolvedCount:number;openUsdCents:number|null;
 openNonUsdCount:number;oldestOpenDays:number|null;
 missingReservationCount:number;insufficientStockCount:number;ineligibleReservationCount:number;
 unknownReasonCount:number;dataVerified:boolean
}
function exactNonnegative(raw:unknown,name:string):number{
 if(raw===null||raw===undefined||!/^\d+$/.test(String(raw)))throw Error('PAYMENT_EXCEPTION_INVALID_'+name)
 const n=Number(raw)
 if(!Number.isSafeInteger(n)||n<0)throw Error('PAYMENT_EXCEPTION_INVALID_'+name)
 return n
}
export function interpretPaymentExceptionSummary(row:Record<string,unknown>):PaymentExceptionSummary{
 const openCount=exactNonnegative(row.open_count,'OPEN_COUNT')
 const resolvedCount=exactNonnegative(row.resolved_count,'RESOLVED_COUNT')
 const openNonUsdCount=exactNonnegative(row.open_non_usd_count,'NON_USD_COUNT')
 const missingReservationCount=exactNonnegative(row.missing_reservation_count,'NO_RESERVATION_COUNT')
 const insufficientStockCount=exactNonnegative(row.insufficient_stock_count,'INSUFFICIENT_COUNT')
 const ineligibleReservationCount=exactNonnegative(row.ineligible_reservation_count,'INELIGIBLE_COUNT')
 const unknownReasonCount=exactNonnegative(row.unknown_reason_count,'UNKNOWN_REASON_COUNT')
 if(openNonUsdCount>openCount||missingReservationCount+insufficientStockCount+ineligibleReservationCount+unknownReasonCount!==openCount)
  throw Error('PAYMENT_EXCEPTION_INCONSISTENT_COUNTS')
 const openUsdCents=row.open_usd_cents===null?null:exactNonnegative(row.open_usd_cents,'USD_AMOUNT')
 if(openCount===0&&openUsdCents!==0)throw Error('PAYMENT_EXCEPTION_NO_OPEN_WITH_AMOUNT')
 const oldestOpenDays=row.oldest_open_days===null?null:exactNonnegative(row.oldest_open_days,'OLDEST_DAYS')
 if((openCount===0)!==(oldestOpenDays===null))throw Error('PAYMENT_EXCEPTION_AGE_MISMATCH')
 return {openCount,resolvedCount,openUsdCents,openNonUsdCount,oldestOpenDays,
  missingReservationCount,insufficientStockCount,ineligibleReservationCount,unknownReasonCount,
  dataVerified:openNonUsdCount===0&&unknownReasonCount===0&&openUsdCents!==null}
}
export async function getPaymentExceptionSummary():Promise<PaymentExceptionSummary>{
 const rows=await sql`SELECT
 COUNT(*) FILTER(WHERE status='open')::text AS open_count,
 COUNT(*) FILTER(WHERE status='resolved')::text AS resolved_count,
 COUNT(*) FILTER(WHERE status='open' AND lower(currency)<>'usd')::text AS open_non_usd_count,
 COUNT(*) FILTER(WHERE status='open' AND reason='no_reservation')::text AS missing_reservation_count,
 COUNT(*) FILTER(WHERE status='open' AND reason='insufficient_stock')::text AS insufficient_stock_count,
 COUNT(*) FILTER(WHERE status='open' AND reason='reservation_not_eligible')::text AS ineligible_reservation_count,
 COUNT(*) FILTER(WHERE status='open' AND reason NOT IN ('no_reservation','insufficient_stock','reservation_not_eligible'))::text AS unknown_reason_count,
 COALESCE(SUM(amount_cents::bigint) FILTER(WHERE status='open' AND lower(currency)='usd'),0)::text AS open_usd_cents,
 CASE WHEN COUNT(*) FILTER(WHERE status='open')=0 THEN NULL ELSE
 GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW()-MIN(created_at) FILTER(WHERE status='open')))/86400))::bigint::text END AS oldest_open_days
 FROM payment_exceptions`
 if(rows.length!==1)throw Error('PAYMENT_EXCEPTION_SCHEMA_UNAVAILABLE')
 return interpretPaymentExceptionSummary(rows[0] as Record<string,unknown>)
}
