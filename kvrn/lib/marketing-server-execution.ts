/**
 * Server-private composition of the existing verified-claim, trusted recipient
 * resolver, gated provider adapter and immutable provisional receipt writer.
 * Deliberately NO API route, cron job, queue consumer or AI tool invokes this.
 * Owner activation and isolated provider/DB integration QA required later.
 */
import {sql} from '@/lib/db'
import {executeMarketingAttemptOnce,isValidExecutionInput,
 type AttemptExecutionInput,type AttemptExecutionResult,type TrustedExecutionDependencies} from './marketing-execution-coordinator'
import {resolveClaimedMarketingRecipient,defaultResolverDependencies} from './marketing-claimed-recipient-resolver'
import {verifyMarketingProviderPermission} from './marketing-provider-permission'
import {submitClaimedProviderOnce} from './marketing-claimed-provider-transport'
import {makeOneShotProviderBindings} from './marketing-provider-one-shot-adapters'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** This precheck is read-only and advisory; it is NOT a substitute for the
 * migration 058 serialized DB claim, which checks pricing and consent itself.
 */
async function recheckClaimBeforeReservation(i:AttemptExecutionInput):Promise<boolean>{
 if(!isValidExecutionInput(i))return false
 const rows=await sql`SELECT EXISTS(
   SELECT 1 FROM marketing_staged_delivery_plans p
   JOIN marketing_audience_snapshots s ON s.id=p.snapshot_id
   JOIN marketing_campaign_drafts c ON c.id=s.campaign_id
   JOIN marketing_staged_delivery_items it ON it.plan_id=p.id
   JOIN marketing_audience_members m ON m.id=it.audience_member_id AND m.snapshot_id=s.id
   JOIN marketing_owner_approvals a ON a.id=${i.approvalId}::uuid AND a.plan_id=p.id
   JOIN marketing_budget_reservations b ON b.id=${i.budgetReservationId}::uuid AND b.campaign_id=c.id
   JOIN marketing_recipient_delivery_evidence e ON e.id=${i.evidenceId}::uuid
      AND e.plan_id=p.id AND e.audience_member_id=it.audience_member_id AND e.approval_id=a.id
   JOIN marketing_budget_policy bp ON bp.id=1
   WHERE p.id=${i.planId}::uuid AND m.id=${i.memberId}
     AND it.state='staged' AND p.state='staged' AND a.state='approved'
     AND a.expires_at>NOW() AND c.state='reviewed' AND c.version=s.campaign_version
     AND a.campaign_version=c.version AND a.campaign_id=c.id
     AND e.expires_at>NOW() AND e.approved_message_sha256=${i.messageSha256}
     AND b.state='reserved' AND b.channel=c.channel
     AND bp.dispatch_enabled=true AND c.channel=${i.channel}
 ) AS ok`
 return rows.length===1&&rows[0]?.ok===true
}

function trustedDependencies():TrustedExecutionDependencies{
 return {
  recheck:recheckClaimBeforeReservation,
  async claim(i){
   if(!isValidExecutionInput(i))throw Error('MARKETING_CLAIM_INVALID_INPUT')
   const rows=await sql`SELECT kvrn_marketing_claim_at_most_once(
     ${i.planId}::uuid,${i.memberId},${i.approvalId}::uuid,
     ${i.budgetReservationId}::uuid,${i.evidenceId}::uuid,
     ${i.messageSha256},${i.claimKey})::text AS attempt_id`
   const id=String(rows[0]?.attempt_id??'')
   if(rows.length!==1||!UUID.test(id))throw Error('MARKETING_CLAIM_NOT_PERSISTED')
   return id
  },
  async submitOnce(i,attemptId){
   const oneShot=makeOneShotProviderBindings(attemptId)
   const result=await submitClaimedProviderOnce(attemptId,{
    ...oneShot,
    resolveClaimedEnvelope:claimId=>resolveClaimedMarketingRecipient(
      claimId,defaultResolverDependencies(verifyMarketingProviderPermission)),
    utcNow:()=>new Date(),
   })
   // A provisional API acknowledgement does not meet the separate provider
   // final-status verification contract. All immediate attempts remain unknown.
   return {kind:'outcome_unknown'}
  },
  async recordVerifiedOutcome(){
   // Signed status handlers alone perform final evidence writes. Never infer
   // accepted/not-submitted from any immediate Twilio/Resend HTTP response.
   throw Error('MARKETING_OUTCOME_REQUIRES_SIGNED_PROVIDER_EVIDENCE')
  },
 }
}
/** A future internal ONLY scheduler may call this *after* owner approval,
 * evidence gathering and separate production activation. No automatic retries.
 */
export async function attemptTrustedMarketingDeliveryOnce(
 input:AttemptExecutionInput
):Promise<AttemptExecutionResult>{
 if(!isValidExecutionInput(input))return {state:'blocked',canRetry:false,costSettled:false}
 return executeMarketingAttemptOnce(input,trustedDependencies())
}
