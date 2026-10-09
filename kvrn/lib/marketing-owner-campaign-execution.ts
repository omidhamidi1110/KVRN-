/** Manual owner-reviewed single-request EMAIL campaign dispatch.
 * No scheduler, queues, retries or contact data in the request/response.
 * A fingerprint binds the owner to the exact currently verified audience.
 * All actual sends require individual serialized at-most-once DB claims.
 */
import {listReviewedEmailAudience} from './marketing-email-recipient-evidence'
import {attemptTrustedMarketingDeliveryOnce} from './marketing-server-execution'
import {isConfiguredMarketingOwner} from './marketing-owner-approval'
import {ownerApprovedExecutionAllowed} from './marketing-owner-execution-gate'

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST=/^[0-9a-f]{64}$/
const CONFIRM='I AUTHORIZE THE EXACT REVIEWED EMAIL CAMPAIGN'
export type ApprovedCampaignExecution={planId:string;audienceSha256:string;confirm:typeof CONFIRM}
export type CampaignPreview={planId:string;memberCount:number;ready:boolean;audienceSha256:string|null;
 expiresSoonestAt:string|null;canSend:false}
export type CampaignExecutionResult={planId:string;requested:number;claimedUnknown:number;blocked:number;
 acceptedVerified:number;notSubmittedVerified:number;canRetry:false;costSettled:false;
 attemptedRecipients:{memberId:number;state:'blocked'|'claimed_unknown'|'provider_accepted'|'verified_not_submitted';attemptId:string|null}[]}
export function validApprovedCampaignExecution(raw:unknown):raw is ApprovedCampaignExecution{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false
 const v=raw as Record<string,unknown>
 return Object.keys(v).length===3&&Object.keys(v).every(k=>['planId','audienceSha256','confirm'].includes(k))&&
  typeof v.planId==='string'&&UUID.test(v.planId)&&typeof v.audienceSha256==='string'&&DIGEST.test(v.audienceSha256)&&
  v.confirm===CONFIRM
}
async function sha256(payload:string){
 const raw=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload))
 return Array.from(new Uint8Array(raw),b=>b.toString(16).padStart(2,'0')).join('')
}
async function collectPlan(planId:string,ownerEmail:string){
 if(!UUID.test(planId)||!isConfiguredMarketingOwner(ownerEmail,process.env.MARKETING_OWNER_APPROVAL_EMAIL??''))
  throw Error('MARKETING_CAMPAIGN_OWNER_OR_PLAN_INVALID')
 const raw=await listReviewedEmailAudience(planId,ownerEmail)
 if(raw.length<1||raw.length>50||new Set(raw.map(r=>r.memberId)).size!==raw.length)
  throw Error('MARKETING_CAMPAIGN_AUDIENCE_INVALID')
 const members=[...raw].sort((a,b)=>a.memberId-b.memberId)
 const ready=members.every(r=>r.readyForOwnerReview&&r.hasCurrentEvidence&&!r.previousAttempt&&
  r.approvalId!==null&&r.budgetReservationId!==null&&r.evidenceId!==null&&
  r.messageSha256!==null&&DIGEST.test(r.messageSha256)&&r.eligibleLocally===true&&
  r.evidenceExpiresAt!==null&&new Date(r.evidenceExpiresAt).getTime()>Date.now()+20_000)
 const soonest=ready?new Date(Math.min(...members.map(r=>new Date(r.evidenceExpiresAt!).getTime()))).toISOString():null
 const fingerprint=ready?await sha256('KVRN-OWNER-APPROVED-EMAIL-CAMPAIGN:v1:'+planId+':'+members.map(r=>
  `${r.memberId}:${r.approvalId}:${r.budgetReservationId}:${r.evidenceId}:${r.messageSha256}`).join('|')):null
 return {members,ready,soonest,fingerprint}
}
export async function previewApprovedEmailCampaign(planId:string,ownerEmail:string):Promise<CampaignPreview>{
 const {members,ready,soonest,fingerprint}=await collectPlan(planId,ownerEmail)
 return {planId,memberCount:members.length,ready,audienceSha256:fingerprint,expiresSoonestAt:soonest,canSend:false}
}
/** An explicit, authenticated, one-time owner action. Multiple calls may race
 * but DB claims allow at most ONE provider attempt per member. Never retry.
 */
export async function executeOwnerApprovedEmailCampaign(input:ApprovedCampaignExecution,ownerEmail:string):Promise<CampaignExecutionResult>{
 if(!ownerApprovedExecutionAllowed(process.env)||process.env.MARKETING_OWNER_CAMPAIGN_EXECUTION_ENABLED!=='true')
  throw Error('MARKETING_CAMPAIGN_EXECUTION_DISABLED')
 if(!validApprovedCampaignExecution(input))throw Error('MARKETING_CAMPAIGN_REQUEST_INVALID')
 const {members,ready,fingerprint}=await collectPlan(input.planId,ownerEmail)
 if(!ready||fingerprint!==input.audienceSha256)throw Error('MARKETING_CAMPAIGN_REVIEW_STALE')
 const result:CampaignExecutionResult['attemptedRecipients']=new Array(members.length)
 let next=0
 async function worker(){
  while(next<members.length){
   const index=next++
   const r=members[index]
   let outcome:{state:'blocked'|'claimed_unknown'|'provider_accepted'|'verified_not_submitted';attemptId?:string}={state:'blocked'}
   try{outcome=await attemptTrustedMarketingDeliveryOnce({
    planId:input.planId,memberId:r.memberId,approvalId:r.approvalId!,budgetReservationId:r.budgetReservationId!,
    evidenceId:r.evidenceId!,messageSha256:r.messageSha256!,claimKey:r.claimKey,channel:'email'
   })}catch{
    // An exception may occur *after* the durable claim, so it must never be
    // presented as a safe-to-retry blocked attempt.
    outcome={state:'claimed_unknown'}
   }
   result[index]={memberId:r.memberId,state:outcome.state,attemptId:outcome.attemptId??null}
  }
 }
 // This is one manually initiated action; never a queue or a repeating worker.
 await Promise.all(Array.from({length:Math.min(3,members.length)},()=>worker()))
 const count=(state:string)=>result.filter(r=>r.state===state).length
 return {planId:input.planId,requested:result.length,claimedUnknown:count('claimed_unknown'),
  blocked:count('blocked'),acceptedVerified:count('provider_accepted'),
  notSubmittedVerified:count('verified_not_submitted'),canRetry:false,costSettled:false,
  attemptedRecipients:result}
}
