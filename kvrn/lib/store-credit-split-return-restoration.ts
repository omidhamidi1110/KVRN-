/** Restore the actual ORIGINAL store-credit tender on a completed inspected return.
 * Owner reviewed; never initiates Stripe refunds, charges, email, or SMS.
 * SQL 063 locks and verifies the complete order/refund/return/credit history.
 */
import {sql} from '@/lib/db'
import {isCreditIssuanceOwner,validateCreditIssueRequest,type IssueCreditRequest} from './store-credit-return-issuance'

export type RestoreOriginalCreditRequest=IssueCreditRequest

export function validateRestoreOriginalCreditRequest(value:unknown):value is RestoreOriginalCreditRequest{
  return validateCreditIssueRequest(value) &&
    (value as RestoreOriginalCreditRequest).requestedCents <= 2147483647
}

async function sha256(input:string):Promise<string>{
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input))
  return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('')
}

export async function restoreOriginalCreditTenderForReturn(
  request:RestoreOriginalCreditRequest,ownerEmail:string,
):Promise<string>{
  if(process.env.STORE_CREDIT_RETURN_RESTORE_ENABLED!=='true'||process.env.STRIPE_MODE!=='test')
    throw Error('CREDIT_RESTORE_DISABLED')
  if(!isCreditIssuanceOwner(ownerEmail))throw Error('CREDIT_RESTORE_OWNER_REQUIRED')
  if(!validateRestoreOriginalCreditRequest(request))throw Error('CREDIT_RESTORE_INVALID_REQUEST')
  // The API cannot choose which account receives restored value: SQL 063 derives
  // it only from the immutable original captured-credit hold and its order.
  const deliveryHash=await sha256('kvrn:delivery-proof:v1:'+request.deliveryEvidenceRef.trim())
  const actorHash=await sha256('kvrn:credit-reviewer:v1:'+ownerEmail.trim().toLowerCase())
  const rows=await sql`SELECT kvrn_credit_restore_original_tender_on_return(
    ${request.returnId}::uuid,${request.requestedCents}::bigint,
    ${request.deliveredAt}::timestamptz,${deliveryHash},${actorHash},${request.requestKey}
  )::text AS event_id`
  if(rows.length!==1||!/^[1-9][0-9]*$/.test(String(rows[0]?.event_id)))
    throw Error('CREDIT_RESTORE_RESULT_INVALID')
  return String(rows[0].event_id)
}
