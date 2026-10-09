/** Create real, ephemeral recipient-level delivery evidence for approved EMAIL
 * plans. This prepares an existing marketing attempt coordinator; NO SEND here.
 * No browser-supplied email, provider id, cost or consent flag is accepted.
 * External consent and price checking is executed only when OWNER enables this.
 */
import {sql} from '@/lib/db'
import {isConfiguredMarketingOwner} from './marketing-owner-approval'
import {verifyMarketingProviderPermission} from './marketing-provider-permission'
import {signMarketingUnsubscribe} from './marketing-unsubscribe'
import {hashFinalApprovedCopy} from './marketing-claimed-provider-transport'

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMAIL=/^[^\s@<>]{1,64}@[^\s@<>]{1,254}$/
const CONTACT=/^[A-Za-z0-9_-]{6,128}$/
const EVIDENCE=/^[A-Za-z0-9:_./ -]{12,140}$/
export type ReviewRecipientInput={planId:string;memberId:number;approvalId:string;
 recipientTimezone:string;jurisdictionEvidenceRef:string;confirmLegalReview:true}
export function validRecipientEvidenceReview(input:unknown):input is ReviewRecipientInput{
 if(!input||typeof input!=='object'||Array.isArray(input))return false
 const v=input as Record<string,unknown>
 if(Object.keys(v).length!==6||Object.keys(v).some(k=>!['planId','memberId','approvalId','recipientTimezone','jurisdictionEvidenceRef','confirmLegalReview'].includes(k)))return false
 if(typeof v.planId!=='string'||!UUID.test(v.planId)||typeof v.approvalId!=='string'||!UUID.test(v.approvalId)||
 !Number.isSafeInteger(v.memberId)||Number(v.memberId)<=0||v.confirmLegalReview!==true||
 typeof v.recipientTimezone!=='string'||v.recipientTimezone.length<4||v.recipientTimezone.length>80||
 typeof v.jurisdictionEvidenceRef!=='string'||!EVIDENCE.test(v.jurisdictionEvidenceRef))return false
 try{new Intl.DateTimeFormat('en',{timeZone:v.recipientTimezone}).format(new Date())}
 catch{return false}
 return true
}
const escape=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
 .replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/\n/g,'<br>')
export function composeVerifiedEmailHtml(body:string,unsubscribeUrl:string):string{
 return `<div>${escape(body)}</div><p><a href="${unsubscribeUrl}">Unsubscribe from KVRN marketing emails</a></p>`
}
async function digest(s:string):Promise<string>{
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))
 return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('')
}
export type EvidenceResult={evidenceId:string;messageSha256:string;expiresInSeconds:240;canSend:false}

export async function recordReviewedEmailRecipientEvidence(input:ReviewRecipientInput,ownerEmail:string):Promise<EvidenceResult>{
 if(process.env.MARKETING_EMAIL_RECIPIENT_EVIDENCE_ENABLED!=='true')throw Error('MARKETING_RECIPIENT_EVIDENCE_DISABLED')
 if(!isConfiguredMarketingOwner(ownerEmail,process.env.MARKETING_OWNER_APPROVAL_EMAIL??''))throw Error('MARKETING_OWNER_REQUIRED')
 if(!validRecipientEvidenceReview(input))throw Error('MARKETING_EVIDENCE_INVALID_REVIEW')
 const micro=process.env.MARKETING_EMAIL_VERIFIED_WORST_MICROS??''
 const priceSource=process.env.MARKETING_EMAIL_VERIFIED_PRICE_SOURCE??''
 if(process.env.MARKETING_EMAIL_PRICE_OWNER_VERIFIED!=='true'||
    !/^[1-9][0-9]{0,6}$/.test(micro)||Number(micro)>2000000||
    !EVIDENCE.test(priceSource))throw Error('MARKETING_EMAIL_PRICE_UNVERIFIED')
 const now=new Date()
 const localHour=Number(new Intl.DateTimeFormat('en-US',{timeZone:input.recipientTimezone,hour:'numeric',hourCycle:'h23'}).format(now))
 if(!Number.isSafeInteger(localHour)||localHour<9||localHour>=20)throw Error('MARKETING_RECIPIENT_QUIET_HOURS')
 // Current, private, authoritatively joined person/campaign/approval/consent.
 // The recipient's identifying details NEVER leave this server-side function.
 const rows=await sql`SELECT em.id::text AS subscriber_id,em.email,em.resend_contact_id,
  c.channel,c.state AS campaign_state,c.version AS campaign_version,c.subject,c.body,
  snap.campaign_version AS snapshot_version,p.state AS plan_state,
  app.state AS approval_state,app.expires_at AS approval_expires,
  app.campaign_id AS approval_campaign_id,app.campaign_version AS approval_version,
  (SELECT COUNT(*)::int FROM marketing_delivery_attempts att
    JOIN marketing_audience_members m2 ON m2.id=att.audience_member_id
    LEFT JOIN marketing_delivery_attempt_outcomes outcome ON outcome.attempt_id=att.id
    WHERE m2.email_subscriber_id=em.id AND
      (outcome.id IS NULL OR (outcome.outcome='provider_accepted'
        AND att.claimed_at>NOW()-INTERVAL '72 hours'))) AS recent_attempts,
  EXISTS(SELECT 1 FROM marketing_email_consent_events cons WHERE cons.subscriber_id=em.id
       AND cons.event_type='affirmative_checkbox') AS affirmative_consent,
  EXISTS(SELECT 1 FROM marketing_email_consent_events revoked WHERE revoked.subscriber_id=em.id
       AND revoked.event_type='unsubscribed') AS consent_revoked,
  em.status AS contact_status,em.unsubscribed_at
 FROM marketing_staged_delivery_plans p
 JOIN marketing_audience_snapshots snap ON snap.id=p.snapshot_id
 JOIN marketing_campaign_drafts c ON c.id=snap.campaign_id
 JOIN marketing_owner_approvals app ON app.id=${input.approvalId}::uuid
  AND app.plan_id=p.id AND app.campaign_id=c.id
 JOIN marketing_staged_delivery_items it ON it.plan_id=p.id AND it.state='staged'
 JOIN marketing_audience_members m ON m.id=it.audience_member_id AND m.snapshot_id=snap.id
 JOIN marketing_subscribers em ON em.id=m.email_subscriber_id
 WHERE p.id=${input.planId}::uuid AND m.id=${input.memberId}::bigint LIMIT 1`
 if(rows.length!==1)throw Error('MARKETING_EVIDENCE_RECIPIENT_MISSING')
 const r=rows[0]
 const email=String(r.email??'').trim().toLowerCase()
 const subscriberId=String(r.subscriber_id??'')
 const providerContactId=String(r.resend_contact_id??'')
 const subject=String(r.subject??'')
 if(r.channel!=='email'||r.campaign_state!=='reviewed'||r.plan_state!=='staged'||
   r.approval_state!=='approved'||!Number.isSafeInteger(Number(r.campaign_version))||
   Number(r.campaign_version)!==Number(r.snapshot_version)||Number(r.approval_version)!==Number(r.campaign_version)||
   !(new Date(r.approval_expires as string)>now)||r.contact_status!=='subscribed'||r.unsubscribed_at!=null||
   r.affirmative_consent!==true||r.consent_revoked===true||Number(r.recent_attempts)!==0||
   !UUID.test(subscriberId)||!EMAIL.test(email)||!CONTACT.test(providerContactId)||
   !subject||subject.length>140||typeof r.body!=='string'||!r.body.trim())
   throw Error('MARKETING_EVIDENCE_INTEGRITY_OR_CONSENT')
 // Recheck the exact Resend contact's identity, unsubscribed state and active
 // KVRN topic. Unknown or unavailable provider APIs fail closed.
 if(!await verifyMarketingProviderPermission('email',email,providerContactId))
   throw Error('MARKETING_EVIDENCE_PROVIDER_UNVERIFIED')
 const token=await signMarketingUnsubscribe(subscriberId)
 const unsubscribeUrl=`https://kvrn.shop/email-preferences?token=${token}`
 const finalBody=composeVerifiedEmailHtml(r.body,unsubscribeUrl)
 const messageHash=await hashFinalApprovedCopy(finalBody,'email',subject)
 const ownerHash=await digest('kvrn:marketing-owner:v1:'+ownerEmail.trim().toLowerCase())
 const providerProof=await digest(`KVRN:RESEND-PERMISSION:v1:${providerContactId}:${email}:${now.toISOString()}`)
 const jurisdictionProof=await digest(`KVRN:OWNER-LEGAL-REVIEW:v1:${input.jurisdictionEvidenceRef}:${input.recipientTimezone}:${ownerHash}`)
 const frequencyProof=await digest(`KVRN:FREQUENCY:v1:${subscriberId}:zero:${now.toISOString()}`)
 const priceProof=await digest(`KVRN:OWNER-VERIFIED-PRICE:v1:${priceSource}:${micro}:${ownerHash}`)
 const saved=await sql`SELECT kvrn_marketing_record_email_recipient_evidence(
  ${input.planId}::uuid,${input.memberId}::bigint,${input.approvalId}::uuid,${ownerHash},
  ${providerProof},${jurisdictionProof},${frequencyProof},${priceProof},${messageHash},
  ${input.recipientTimezone},${Number(micro)}::bigint
 )::text AS evidence_id`
 const id=String(saved[0]?.evidence_id??'')
 if(saved.length!==1||!UUID.test(id))throw Error('MARKETING_EVIDENCE_DB_NOT_COMMITTED')
 return {evidenceId:id,messageSha256:messageHash,expiresInSeconds:240,canSend:false}
}

/** No-contact-ID Admin workflow: members, expiring evidence, and safe one-shot
 * claim inputs for an existing approved staged plan. This is a READ only;
 * returned references never authorize a send by themselves.
 */
export type ReviewedRecipientRow={
 memberId:number;approvalId:string|null;budgetReservationId:string|null;
 evidenceId:string|null;messageSha256:string|null;
 evidenceExpiresAt:string|null;hasCurrentEvidence:boolean;previousAttempt:boolean;
 eligibleLocally:boolean;claimKey:string;readyForOwnerReview:boolean;canSend:false
}
export async function listReviewedEmailAudience(planId:string,ownerEmail:string):Promise<ReviewedRecipientRow[]>{
 if(!UUID.test(planId)||!isConfiguredMarketingOwner(ownerEmail,process.env.MARKETING_OWNER_APPROVAL_EMAIL??''))
   throw Error('MARKETING_REVIEW_OWNER_OR_PLAN_INVALID')
 const ownerHash=await digest('kvrn:marketing-owner:v1:'+ownerEmail.trim().toLowerCase())
 const rows=await sql`SELECT it.audience_member_id::text AS member_id,
   a.id::text AS approval_id,a.state AS approval_state,a.expires_at AS approval_expires,
   b.id::text AS budget_id,b.state AS budget_state,
   ev.id::text AS evidence_id,ev.approved_message_sha256 AS approved_message,
   ev.expires_at AS evidence_expires,
   EXISTS(SELECT 1 FROM marketing_delivery_attempts attempt
     WHERE attempt.plan_id=p.id AND attempt.audience_member_id=it.audience_member_id) AS attempted,
   (em.status='subscribed' AND em.unsubscribed_at IS NULL AND
    EXISTS(SELECT 1 FROM marketing_email_consent_events ce
      WHERE ce.subscriber_id=em.id AND ce.event_type='affirmative_checkbox') AND
    NOT EXISTS(SELECT 1 FROM marketing_email_consent_events ce
      WHERE ce.subscriber_id=em.id AND ce.event_type='unsubscribed')) AS local_consent,
   c.state AS campaign_state,p.state AS plan_state,c.version AS current_version,
   snap.campaign_version AS frozen_version,
   bp.dispatch_enabled AS dispatch_enabled
 FROM marketing_staged_delivery_plans p
 JOIN marketing_audience_snapshots snap ON snap.id=p.snapshot_id AND snap.channel='email'
 JOIN marketing_campaign_drafts c ON c.id=snap.campaign_id
 JOIN marketing_staged_delivery_items it ON it.plan_id=p.id
 JOIN marketing_audience_members m ON m.id=it.audience_member_id AND m.snapshot_id=snap.id
 JOIN marketing_subscribers em ON em.id=m.email_subscriber_id
 LEFT JOIN marketing_owner_approvals a ON a.plan_id=p.id
   AND a.campaign_id=c.id AND a.owner_identity_sha256=${ownerHash}
 LEFT JOIN LATERAL (
   SELECT bud.id,bud.state FROM marketing_budget_reservations bud
   WHERE bud.campaign_id=c.id AND bud.channel='email' AND bud.state='reserved'
     AND bud.budget_utc_day=(NOW() AT TIME ZONE 'UTC')::date
     AND bud.budget_utc_month=date_trunc('month',NOW() AT TIME ZONE 'UTC')::date
   ORDER BY bud.created_at DESC LIMIT 1
 ) b ON true
 LEFT JOIN LATERAL (
   SELECT e.id,e.approved_message_sha256,e.expires_at
   FROM marketing_recipient_delivery_evidence e
   WHERE e.plan_id=p.id AND e.audience_member_id=it.audience_member_id
     AND e.approval_id=a.id ORDER BY e.verified_at DESC,e.id DESC LIMIT 1
 ) ev ON true
 CROSS JOIN marketing_budget_policy bp
 WHERE p.id=${planId}::uuid AND it.state='staged' AND bp.id=1
 ORDER BY it.audience_member_id ASC LIMIT 51`
 if(rows.length>50)throw Error('MARKETING_REVIEW_AUDIENCE_CAP_EXCEEDED')
 const now=new Date()
 return rows.map(r=>{
  const memberId=Number(r.member_id)
  if(!Number.isSafeInteger(memberId)||memberId<=0)throw Error('MARKETING_REVIEW_MEMBER_INTEGRITY')
  const approvalId=r.approval_id==null?null:String(r.approval_id)
  const budgetReservationId=r.budget_id==null?null:String(r.budget_id)
  const evidenceId=r.evidence_id==null?null:String(r.evidence_id)
  const messageSha256=r.approved_message==null?null:String(r.approved_message)
  const evidenceExpiresAt=r.evidence_expires==null?null:new Date(r.evidence_expires as string).toISOString()
  if([approvalId,budgetReservationId,evidenceId].some(id=>id!==null&&!UUID.test(id!)) ||
    (messageSha256!==null&&!/^[a-f0-9]{64}$/.test(messageSha256)))throw Error('MARKETING_REVIEW_EVIDENCE_INTEGRITY')
  const previousAttempt=r.attempted===true
  const eligibleLocally=r.local_consent===true
  const approved=approvalId!==null&&r.approval_state==='approved'&&
    new Date(r.approval_expires as string)>now
  const sameCopy=r.campaign_state==='reviewed'&&r.plan_state==='staged'&&
    Number(r.current_version)===Number(r.frozen_version)
  const hasCurrentEvidence=!!evidenceExpiresAt&&new Date(evidenceExpiresAt)>now&&
    !!evidenceId&&!!messageSha256
  const readyForOwnerReview=approved&&sameCopy&&eligibleLocally&&!previousAttempt&&
    budgetReservationId!==null&&r.budget_state==='reserved'&&r.dispatch_enabled===true
  return {memberId,approvalId,budgetReservationId,evidenceId,messageSha256,
   evidenceExpiresAt,hasCurrentEvidence,previousAttempt,eligibleLocally,
   claimKey:`email:${planId}:${memberId}`,readyForOwnerReview,canSend:false as const}
 })
}
