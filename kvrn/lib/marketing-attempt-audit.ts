/** Count-only recovery audit for claimed marketing delivery attempts.
 * Never grants a retry, releases money, asserts delivery, or opens recipient data.
 * Even a provider-accepted message may later bounce or be billed differently.
 */
import {sql} from '@/lib/db'
import {validateAudiencePreviewId} from './marketing-audience-preview'

export type DeliveryAttemptTotals={
  staged:number;claimed:number;unclaimed:number;unknown:number;
  providerAccepted:number;verifiedNotSubmitted:number;canRetry:false;
  billingReconciled:false;requiresOwnerReview:boolean;warnings:string[]
}
const safeCount=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=50
export function summarizeDeliveryAttempts(v:{staged:unknown;claimed:unknown;accepted:unknown;rejected:unknown}):DeliveryAttemptTotals{
  const {staged,claimed,accepted,rejected}=v
  if(!safeCount(staged)||!safeCount(claimed)||!safeCount(accepted)||!safeCount(rejected) ||
    claimed>staged || accepted+rejected>claimed)throw Error('MARKETING_ATTEMPT_COUNTS_INTEGRITY')
  const unknown=claimed-accepted-rejected
  return {
    staged,claimed,unclaimed:staged-claimed,unknown,
    providerAccepted:accepted,verifiedNotSubmitted:rejected,
    canRetry:false,billingReconciled:false,requiresOwnerReview:claimed>0,
    warnings:[
      'An unknown attempt may have reached the provider. Never retry automatically.',
      'Provider accepted is not delivered, billed, or finally consent-authorized.',
      'Verified provider rejection does not release any campaign budget automatically.',
      'An unclaimed staged recipient is not authorized to send. Recheck consent, timezone, price and owner approval.',
    ],
  }
}
export async function getDeliveryAttemptAudit(planId:string):Promise<DeliveryAttemptTotals&{planId:string;asOf:string}>{
  if(!validateAudiencePreviewId(planId))throw Error('MARKETING_ATTEMPT_PLAN_INVALID')
  // Fixed query, private IDs only as bound parameters; no subscriber joins or contact columns.
  const rows=await sql`SELECT
      (SELECT COUNT(*)::int FROM marketing_staged_delivery_items i WHERE i.plan_id=p.id) AS staged,
      (SELECT COUNT(*)::int FROM marketing_delivery_attempts a WHERE a.plan_id=p.id) AS claimed,
      (SELECT COUNT(*)::int FROM marketing_delivery_attempt_outcomes o
        JOIN marketing_delivery_attempts a ON a.id=o.attempt_id
        WHERE a.plan_id=p.id AND o.outcome='provider_accepted') AS accepted,
      (SELECT COUNT(*)::int FROM marketing_delivery_attempt_outcomes o
        JOIN marketing_delivery_attempts a ON a.id=o.attempt_id
        WHERE a.plan_id=p.id AND o.outcome='verified_not_submitted') AS rejected
    FROM marketing_staged_delivery_plans p WHERE p.id=${planId}::uuid LIMIT 1`
  if(rows.length!==1)throw Error('MARKETING_ATTEMPT_PLAN_UNAVAILABLE')
  const totals=summarizeDeliveryAttempts(rows[0] as {staged:unknown;claimed:unknown;accepted:unknown;rejected:unknown})
  return {planId,asOf:new Date().toISOString(),...totals}
}
