/** Internal HOLD preparation. This is NOT a checkout payment or a customer API.
 * Requires migration 051 (staging first), independently verified account identity,
 * canonical checkout tender calculation and later payment-webhook integration.
 * Default-off: calls are disabled in both production and ordinary development.
 */
import {sql} from '@/lib/db'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REQUEST=/^[A-Za-z0-9:_-]{12,120}$/
const safeCents=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0
export type PrepareHoldRequest={
  accountId:string; reservationId:string; holdKey:string; requestKey:string; amountCents:number
  /** Evidence was independently verified by trusted backend, not asserted by browser. */
  verifiedAccountOwnership:boolean; canonicalNetTenderVerified:boolean
}
export function validateCheckoutCreditHold(input:PrepareHoldRequest):string[] {
  const failures:string[]=[]
  if(!UUID.test(input.accountId)||!UUID.test(input.reservationId)||!REQUEST.test(input.holdKey)||!REQUEST.test(input.requestKey)) failures.push('invalid_internal_references')
  if(!safeCents(input.amountCents))failures.push('invalid_amount')
  if(input.verifiedAccountOwnership!==true)failures.push('unverified_account_ownership')
  if(input.canonicalNetTenderVerified!==true)failures.push('unverified_checkout_amount')
  return failures
}
export async function prepareCheckoutCreditHold(input:PrepareHoldRequest):Promise<string>{
  // Staging feature switch alone cannot override owner/client verification flags.
  if(process.env.STORE_CREDIT_CHECKOUT_HOLD_ENABLED!=='true') throw Error('CREDIT_HOLDS_DISABLED')
  const failures=validateCheckoutCreditHold(input)
  if(failures.length)throw Error(`CREDIT_HOLD_BLOCKED:${failures.join(',')}`)
  // IMPORTANT: no customer API invokes this function; the future integration
  // must perform verified-email session and payment calculation checks itself.
  const r=await sql`SELECT kvrn_credit_create_checkout_hold(
    ${input.accountId}::uuid,${input.reservationId}::uuid,
    ${input.holdKey},${input.requestKey},${input.amountCents}
  )::text AS event_id`
  if(r.length!==1 || !/^[1-9][0-9]*$/.test(String(r[0]?.event_id)))throw Error('CREDIT_HOLD_DB_INTEGRITY')
  return String(r[0].event_id)
}
