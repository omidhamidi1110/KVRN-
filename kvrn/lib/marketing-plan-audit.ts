/** No-PII live-read readiness assessment for a staged marketing plan.
 * No send, quote, scheduling, provider calls or budget reservations. Every
 * unknown/revocation/race yields a blocker; a snapshot never grants consent.
 */
import {sql} from '@/lib/db'
import {validateAudiencePreviewId} from './marketing-audience-preview'
export type PlanReadinessResult={
 planId:string;channel:'email'|'sms';recipientCount:number;
 locallyVerifiedCount:number;asOf:string;canSend:false;
 checks:Array<{id:string;passed:boolean;note:string}>;
}
export type PlanEvidence={planState:string;channel:string;snapshotVersion:number;campaignVersion:number;
 campaignState:string;stagedMembers:number;approvalState:string|null;approvalVersion:number|null;
 approvalCount:number|null;approvalExpires:string|null;budgetDispatchEnabled:boolean;
 locallyVerifiedCount:number;providerReady:boolean}
const allowedInt=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=50
const one=(id:string,passed:boolean,note:string)=>({id,passed,note})
/** Pure fail-closed signal extraction: NOT a send authorizer. */
export function summarizeMarketingPlanEvidence(planId:string,v:PlanEvidence,utcNow:Date):PlanReadinessResult{
 if(!validateAudiencePreviewId(planId)||!v||(v.channel!=='email'&&v.channel!=='sms')||
  !allowedInt(v.stagedMembers)||!allowedInt(v.locallyVerifiedCount)||
  !Number.isSafeInteger(v.snapshotVersion)||!Number.isSafeInteger(v.campaignVersion)||
  !(utcNow instanceof Date)||!Number.isFinite(utcNow.getTime()))throw Error('PLAN_AUDIT_INTEGRITY')
 const approvalValid=v.approvalState==='approved'&&v.approvalVersion===v.snapshotVersion&&
  v.approvalCount===v.stagedMembers&&typeof v.approvalExpires==='string'&&
  Number.isFinite(Date.parse(v.approvalExpires))&&Date.parse(v.approvalExpires)>utcNow.getTime()
 const checks=[
  one('staging',v.planState==='staged','Plan must remain staged and uncancelled.'),
  one('reviewed_copy',v.campaignState==='reviewed'&&v.campaignVersion===v.snapshotVersion,'Campaign version must match the frozen audience.'),
  one('recipient_cap',v.stagedMembers>=1&&v.stagedMembers<=50,'The initial recipient cap is 50.'),
  one('local_consent',v.stagedMembers>0&&v.locallyVerifiedCount===v.stagedMembers,'Local evidence and fresh suppression must match all references.'),
  one('owner_approval',approvalValid,'An exact current owner approval must cover the same count and version.'),
  one('database_dispatch_policy',v.budgetDispatchEnabled===true,'A serialized, owner-locked database dispatch policy must be enabled.'),
  one('provider_registration',v.providerReady===true,'Provider registration and required opt-out configuration must be confirmed.'),
  // Mandatory capability gaps: do not upgrade these to true based on a UI click.
  one('provider_contact_suppression',false,'Provider-side contact opt-outs need just-in-time reconciliation.'),
  one('recipient_delivery_windows',false,'Independently verified recipient timezone and jurisdiction evidence is not stored with the current plans.'),
  one('recipient_frequency',false,'Per-recipient recent-contact frequency limits are not recorded with the current plans.'),
  one('verified_price_and_atomic_budget',false,'An authoritative recipient-level price quote and campaign-linked atomic budget reservation are not recorded.'),
  one('network_idempotency',false,'A reviewed at-most-once provider-attempt ledger and recovery process is required.'),
 ]
 return {planId,channel:v.channel,recipientCount:v.stagedMembers,
  locallyVerifiedCount:v.locallyVerifiedCount,asOf:utcNow.toISOString(),checks,canSend:false}
}
export async function auditStagedMarketingPlan(planId:string):Promise<PlanReadinessResult>{
 if(!validateAudiencePreviewId(planId))throw Error('INVALID_PLAN_REFERENCE')
 const rows=await sql`SELECT p.state AS plan_state,s.channel,s.campaign_version AS snapshot_version,
  c.version AS campaign_version,c.state AS campaign_state,
  a.state AS approval_state,a.campaign_version AS approval_version,
  a.recipient_count AS approval_count,a.expires_at AS approval_expires,
  policy.dispatch_enabled AS budget_dispatch_enabled,
  (SELECT COUNT(*)::integer FROM marketing_staged_delivery_items i WHERE i.plan_id=p.id) AS staged_members
  FROM marketing_staged_delivery_plans p
  JOIN marketing_audience_snapshots s ON s.id=p.snapshot_id
  JOIN marketing_campaign_drafts c ON c.id=s.campaign_id
  LEFT JOIN marketing_owner_approvals a ON a.plan_id=p.id
  CROSS JOIN marketing_budget_policy policy
  WHERE p.id=${planId}::uuid AND policy.id=1 LIMIT 1`
 if(rows.length!==1)throw Error('PLAN_AUDIT_NOT_FOUND_OR_MISSING_SCHEMA')
 const r=rows[0]
 if(r.channel!=='sms'&&r.channel!=='email')throw Error('PLAN_AUDIT_INVALID_CHANNEL')
 // Count only; no phone numbers, email addresses, ZIP codes or plaintext IDs.
 let eligible
 if(r.channel==='sms'){
  eligible=await sql`SELECT COUNT(*)::integer AS n FROM marketing_staged_delivery_items i
   JOIN marketing_audience_members m ON m.id=i.audience_member_id
   JOIN sms_subscribers s ON s.id=m.sms_subscriber_id
   WHERE i.plan_id=${planId}::uuid AND i.state='staged'
    AND s.status='subscribed' AND s.unsubscribed_at IS NULL
    AND s.consent_source='sms_keyword' AND s.twilio_opt_out_state='opted_in'
    AND EXISTS(SELECT 1 FROM sms_keyword_consent_proofs pr
      WHERE pr.subscriber_id=s.id AND pr.confirmed_at>=s.consented_at)`
 }else{
  eligible=await sql`SELECT COUNT(*)::integer AS n FROM marketing_staged_delivery_items i
   JOIN marketing_audience_members m ON m.id=i.audience_member_id
   JOIN marketing_subscribers s ON s.id=m.email_subscriber_id
   WHERE i.plan_id=${planId}::uuid AND i.state='staged'
    AND s.status='subscribed' AND s.unsubscribed_at IS NULL
    AND EXISTS (SELECT 1 FROM marketing_email_consent_events e
      WHERE e.subscriber_id=s.id AND e.event_type='affirmative_checkbox')
    AND NOT EXISTS (SELECT 1 FROM marketing_email_consent_events e
      WHERE e.subscriber_id=s.id AND e.event_type='unsubscribed')`
 }
 if(eligible.length!==1)throw Error('PLAN_AUDIT_CONSENT_QUERY_INVALID')
 const toInt=(n:unknown)=>Number(n)
 const s=toInt(r.staged_members),verified=toInt(eligible[0].n)
 if(!allowedInt(s)||!allowedInt(verified))throw Error('PLAN_AUDIT_COUNTS_UNTRUSTWORTHY')
 const data:PlanEvidence={
  planState:String(r.plan_state),channel:r.channel,snapshotVersion:toInt(r.snapshot_version),
  campaignVersion:toInt(r.campaign_version),campaignState:String(r.campaign_state),
  stagedMembers:s,approvalState:r.approval_state??null,
  approvalVersion:r.approval_version==null?null:toInt(r.approval_version),
  approvalCount:r.approval_count==null?null:toInt(r.approval_count),
  approvalExpires:r.approval_expires==null?null:new Date(r.approval_expires).toISOString(),
  budgetDispatchEnabled:r.budget_dispatch_enabled===true,
  locallyVerifiedCount:verified,
  providerReady:r.channel==='sms'
    ? process.env.TWILIO_A2P_APPROVED==='true'&&process.env.TWILIO_ADVANCED_OPT_OUT_VERIFIED==='true'
    : process.env.RESEND_MARKETING_BROADCAST_PROVIDER_VERIFIED==='true',
 }
 return summarizeMarketingPlanEvidence(planId,data,new Date())
}
