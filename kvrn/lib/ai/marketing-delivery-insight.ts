/** Read-only marketing delivery operations, across all staged campaigns.
 * Fixed aggregates only; no contact records, outbound transport, or budget mutation.
 * Initial transport acknowledgement is not delivery proof or a final provider invoice.
 */
import {sql} from '@/lib/db'

export type MarketingDeliverySummary={
 activePlans:number;cancelledPlans:number;stagedRecipients:number;
 claimedAttempts:number;providerAccepted:number;verifiedNotSubmitted:number;
 unresolvedAttempts:number;initialAcknowledged:number;initialRejected:number;
 initialUncertain:number;missingInitialReceipt:number;
 evidenceReadyRecipients:number;unclaimedRecipients:number;oldestUnresolvedHours:number|null;
 countsConsistent:boolean
}
const checked=(v:unknown,field:string):number=>{
 if(v===null||v===undefined||!/^(0|[1-9]\d*)$/.test(String(v)))throw Error('MARKETING_DELIVERY_INVALID_'+field)
 const n=Number(v)
 if(!Number.isSafeInteger(n)||n<0)throw Error('MARKETING_DELIVERY_INVALID_'+field)
 return n
}
export function interpretMarketingDeliveryRow(row:Record<string,unknown>):MarketingDeliverySummary{
 const activePlans=checked(row.active_plans,'ACTIVE_PLANS')
 const cancelledPlans=checked(row.cancelled_plans,'CANCELLED_PLANS')
 const stagedRecipients=checked(row.staged_recipients,'STAGED_RECIPIENTS')
 const claimedAttempts=checked(row.claimed_attempts,'CLAIMED_ATTEMPTS')
 const providerAccepted=checked(row.provider_accepted,'ACCEPTED')
 const verifiedNotSubmitted=checked(row.verified_not_submitted,'NOT_SUBMITTED')
 const initialAcknowledged=checked(row.initial_acknowledged,'ACKNOWLEDGED')
 const initialRejected=checked(row.initial_rejected,'REJECTED')
 const initialUncertain=checked(row.initial_uncertain,'UNCERTAIN')
 const evidenceReadyRecipients=checked(row.evidence_ready_recipients,'EVIDENCE_READY')
 const oldestUnresolvedHours=row.oldest_unresolved_hours===null?null:checked(row.oldest_unresolved_hours,'OLDEST_UNRESOLVED')
 const unresolvedAttempts=claimedAttempts-providerAccepted-verifiedNotSubmitted
 const missingInitialReceipt=claimedAttempts-initialAcknowledged-initialRejected-initialUncertain
 const unclaimedRecipients=stagedRecipients-claimedAttempts
 // An attempt may exist after a plan was cancelled; counts therefore include
 // every historical staged item, not only active plans.
 const valid=unresolvedAttempts>=0&&missingInitialReceipt>=0&&unclaimedRecipients>=0&&
  evidenceReadyRecipients<=stagedRecipients&&
  ((unresolvedAttempts===0)===(oldestUnresolvedHours===null))
 if(!valid)throw Error('MARKETING_DELIVERY_COUNT_RECONCILIATION_FAILED')
 return {activePlans,cancelledPlans,stagedRecipients,claimedAttempts,providerAccepted,verifiedNotSubmitted,
  unresolvedAttempts,initialAcknowledged,initialRejected,initialUncertain,missingInitialReceipt,
  evidenceReadyRecipients,unclaimedRecipients,oldestUnresolvedHours,countsConsistent:true}
}
export async function getMarketingDeliverySummary():Promise<MarketingDeliverySummary>{
 // Count each one-to-one attempt/outcome/provisional relation independently.
 // Evidence is LATERAL (latest row only) to prevent repeated-review fan-out.
 const rows=await sql`SELECT
  (SELECT COUNT(*)::text FROM marketing_staged_delivery_plans WHERE state='staged') active_plans,
  (SELECT COUNT(*)::text FROM marketing_staged_delivery_plans WHERE state='cancelled') cancelled_plans,
  (SELECT COUNT(*)::text FROM marketing_staged_delivery_items) staged_recipients,
  (SELECT COUNT(*)::text FROM marketing_delivery_attempts) claimed_attempts,
  (SELECT COUNT(*)::text FROM marketing_delivery_attempt_outcomes WHERE outcome='provider_accepted') provider_accepted,
  (SELECT COUNT(*)::text FROM marketing_delivery_attempt_outcomes WHERE outcome='verified_not_submitted') verified_not_submitted,
  (SELECT COUNT(*)::text FROM marketing_provider_provisional_receipts WHERE initial_result='acknowledged') initial_acknowledged,
  (SELECT COUNT(*)::text FROM marketing_provider_provisional_receipts WHERE initial_result='rejected') initial_rejected,
  (SELECT COUNT(*)::text FROM marketing_provider_provisional_receipts WHERE initial_result='uncertain') initial_uncertain,
  (SELECT COUNT(*)::text FROM marketing_staged_delivery_items i
     JOIN marketing_staged_delivery_plans p ON p.id=i.plan_id AND p.state='staged'
     LEFT JOIN marketing_delivery_attempts a ON a.plan_id=i.plan_id AND a.audience_member_id=i.audience_member_id
     JOIN LATERAL (SELECT ev.id FROM marketing_recipient_delivery_evidence ev
       WHERE ev.plan_id=i.plan_id AND ev.audience_member_id=i.audience_member_id
         AND ev.expires_at>NOW() AND ev.verified_at<=NOW()
       ORDER BY ev.verified_at DESC,ev.id DESC LIMIT 1) ev ON true
     WHERE a.id IS NULL AND i.state='staged') evidence_ready_recipients,
  (SELECT GREATEST(0,FLOOR(EXTRACT(EPOCH FROM NOW()-MIN(a.claimed_at))/3600))::bigint::text
     FROM marketing_delivery_attempts a
     LEFT JOIN marketing_delivery_attempt_outcomes o ON o.attempt_id=a.id
     WHERE o.id IS NULL) oldest_unresolved_hours`
 if(rows.length!==1)throw Error('MARKETING_DELIVERY_SCHEMA_UNAVAILABLE')
 return interpretMarketingDeliveryRow(rows[0] as Record<string,unknown>)
}
