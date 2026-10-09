/** Internal-only provider outcome recorder. Caller must independently verify
 * provider authenticity and correlate the exact accepted/rejected message SID to
 * an existing claimed attempt. NOT callable by an Admin/public API or cron.
 * This cannot release budgets, retry, schedule or transmit anything.
 */
import {sql} from '@/lib/db'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX=/^[0-9a-f]{64}$/
export type VerifiedAttemptOutcome={
  attemptId:string;
  outcome:'provider_accepted'|'verified_not_submitted';
  verificationSource:'provider_final_status'|'provider_invoice'|'verified_provider_rejection';
  providerReferenceSha256:string;
  providerAuthenticationVerified:true;
  attemptMessageCorrelationVerified:true;
}
export function validateVerifiedAttemptOutcome(value:unknown):value is VerifiedAttemptOutcome{
  if(!value||typeof value!=='object'||Array.isArray(value))return false
  const v=value as Record<string,unknown>
  if(Object.keys(v).length!==6||!Object.keys(v).every(k=>[
      'attemptId','outcome','verificationSource','providerReferenceSha256',
      'providerAuthenticationVerified','attemptMessageCorrelationVerified'].includes(k)))return false
  if(typeof v.attemptId!=='string'||!UUID.test(v.attemptId)
   ||typeof v.providerReferenceSha256!=='string'||!HEX.test(v.providerReferenceSha256)
   ||v.providerAuthenticationVerified!==true||v.attemptMessageCorrelationVerified!==true)return false
  return (v.outcome==='provider_accepted'&&
     (v.verificationSource==='provider_final_status'||v.verificationSource==='provider_invoice')) ||
   (v.outcome==='verified_not_submitted'&&v.verificationSource==='verified_provider_rejection')
}
export async function recordVerifiedMarketingAttemptOutcome(value:VerifiedAttemptOutcome):Promise<string>{
  if(process.env.MARKETING_PROVIDER_OUTCOME_RECONCILIATION_ENABLED!=='true')throw Error('MARKETING_OUTCOME_RECORDER_DISABLED')
  if(!validateVerifiedAttemptOutcome(value))throw Error('MARKETING_OUTCOME_EVIDENCE_REQUIRED')
  // Only digest of correlated provider reference persisted. No recipient PII.
  const result=await sql`SELECT kvrn_marketing_record_verified_attempt_outcome(
      ${value.attemptId}::uuid,${value.outcome},${value.verificationSource},
      ${value.providerReferenceSha256})::text AS id`
  if(result.length!==1||!UUID.test(String(result[0].id)))throw Error('MARKETING_OUTCOME_RECORDING_FAILED')
  return String(result[0].id)
}
