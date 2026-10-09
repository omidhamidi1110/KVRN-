/** Internal marketing cost finalization, not sending. Provider proof MUST be
 * validated independently from official provider data before insertion.
 * A network timeout is an UNKNOWN charge, never evidence of no delivery.
 */
import {sql} from '@/lib/db'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function validateCostReconciliationIds(reservationId:string,evidenceId:string):boolean{
 return typeof reservationId==='string'&&typeof evidenceId==='string'&&UUID.test(reservationId)&&UUID.test(evidenceId)
}
export async function finalizeVerifiedMarketingCost(reservationId:string,evidenceId:string):Promise<'settled'|'released'>{
 if(process.env.MARKETING_COST_RECONCILIATION_ENABLED!=='true')throw Error('MARKETING_COST_RECONCILIATION_DISABLED')
 if(!validateCostReconciliationIds(reservationId,evidenceId))throw Error('MARKETING_COST_INVALID_REFERENCE')
 const rows=await sql`SELECT kvrn_marketing_finalize_cost(${reservationId}::uuid,${evidenceId}::uuid) AS state`
 if(rows.length!==1||(rows[0].state!=='settled'&&rows[0].state!=='released'))throw Error('MARKETING_COST_RECONCILIATION_DB_ERROR')
 return rows[0].state
}
