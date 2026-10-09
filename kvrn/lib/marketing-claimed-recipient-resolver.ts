/**
 * Private DB-backed resolver for a previously atomically CLAIMED marketing
 * delivery attempt. No HTTP route and NO direct provider send. The live sender
 * requires a separate authenticated provider-status recheck injected here.
 * Never pass contact fields or supplied consent facts from browser/admin JSON.
 */
import {sql} from '@/lib/db'
import {composeMarketingSms} from './marketing-message-composer'
import {signMarketingUnsubscribe} from './marketing-unsubscribe'
import {hashFinalApprovedCopy,type ClaimedTransportEnvelope} from './marketing-claimed-provider-transport'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX=/^[a-f0-9]{64}$/
const E164=/^\+[1-9]\d{7,14}$/
const EMAIL=/^[^\s@<>]{1,64}@[^\s@<>]{1,254}$/
const RESEND_CONTACT_ID=/^[A-Za-z0-9_-]{6,128}$/
const safeHtml=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
 .replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/\n/g,'<br>')

/** Must independently check current authoritative provider-level opt-out or
 * suppression for this exact contact; errors/unknown MUST return false.
 * The implementation should never log phone/email nor disclose it to Admin.
 */
export type TrustedProviderPermissionCheck=(channel:'sms'|'email',recipient:string,contactId:string|null)=>Promise<boolean>
export type ResolverDependencies={
 providerPermission:TrustedProviderPermissionCheck
 signUnsubscribe:(subscriberId:string)=>Promise<string>
 utcNow:()=>Date
}
export const defaultResolverDependencies=(providerPermission:TrustedProviderPermissionCheck):ResolverDependencies=>({
 providerPermission,signUnsubscribe:signMarketingUnsubscribe,utcNow:()=>new Date(),
})

/** Browser-independent source; returned data stays on the Worker server only. */
export async function resolveClaimedMarketingRecipient(
 attemptId:string,deps:ResolverDependencies
):Promise<ClaimedTransportEnvelope>{
 if(process.env.MARKETING_CLAIM_RESOLVER_ENABLED!=='true')throw Error('MARKETING_RESOLVER_DISABLED')
 if(!UUID.test(attemptId)||!deps||typeof deps.providerPermission!=='function'||
    typeof deps.utcNow!=='function'||typeof deps.signUnsubscribe!=='function')throw Error('MARKETING_RESOLVER_INVALID_INPUT')
 const now=deps.utcNow()
 if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw Error('MARKETING_RESOLVER_INVALID_CLOCK')
 // DB claim/evidence contain ONLY internal IDs and verified approval references.
 // All contact details are fetched directly from canonical private tables.
 const rows=await sql`SELECT a.id,a.plan_id AS claim_plan_id,a.provider,a.message_sha256,
    ev.approved_message_sha256,ev.reviewer_sha256,ev.expires_at AS evidence_expires_at,
    ev.recipient_timezone,ev.jurisdiction_proof_sha256,ev.provider_suppression_proof_sha256,
    ev.frequency_proof_sha256,ev.provider_price_proof_sha256,
    ev.per_recipient_worst_micros::text AS recipient_price,
    c.channel,c.state AS campaign_state,c.version AS campaign_version,
    c.subject,c.body,snap.campaign_version AS snapshot_version,
    p.state AS plan_state,snap.campaign_id AS snapshot_campaign_id,
    approval.state AS approval_state,approval.expires_at AS approval_expires_at,
    approval.plan_id AS approval_plan_id,approval.campaign_id AS approval_campaign_id,
    approval.campaign_version AS approval_campaign_version,approval.owner_identity_sha256,
    approval.maximum_cost_micros::text AS approved_maximum,
    b.state AS reservation_state,b.campaign_id AS budget_campaign_id,
    b.channel AS budget_channel,b.budget_utc_day,b.budget_utc_month,b.reserved_micros::text AS budget_reserved,
    s.phone_e164,s.id AS sms_contact_id,
    e.email,e.id AS email_contact_id,e.resend_contact_id,
    CASE WHEN c.channel='sms' THEN (
      s.status='subscribed' AND s.unsubscribed_at IS NULL AND
      s.consent_source='sms_keyword' AND s.twilio_opt_out_state='opted_in' AND
      EXISTS(SELECT 1 FROM sms_keyword_consent_proofs k
        WHERE k.subscriber_id=s.id AND k.confirmed_at>=s.consented_at)
    ) ELSE (
      e.status='subscribed' AND e.unsubscribed_at IS NULL AND
      EXISTS(SELECT 1 FROM marketing_email_consent_events ce
        WHERE ce.subscriber_id=e.id AND ce.event_type='affirmative_checkbox') AND
      NOT EXISTS(SELECT 1 FROM marketing_email_consent_events rev
        WHERE rev.subscriber_id=e.id AND rev.event_type='unsubscribed')
    ) END AS local_consent
  FROM marketing_delivery_attempts a
  JOIN marketing_recipient_delivery_evidence ev ON ev.id=a.evidence_id AND ev.approval_id=a.approval_id
    AND ev.plan_id=a.plan_id AND ev.audience_member_id=a.audience_member_id
  JOIN marketing_staged_delivery_plans p ON p.id=a.plan_id
  JOIN marketing_audience_snapshots snap ON snap.id=p.snapshot_id
  JOIN marketing_campaign_drafts c ON c.id=snap.campaign_id
  JOIN marketing_owner_approvals approval ON approval.id=a.approval_id
  JOIN marketing_budget_reservations b ON b.id=a.budget_reservation_id
  JOIN marketing_audience_members m ON m.id=a.audience_member_id AND m.snapshot_id=snap.id
  LEFT JOIN sms_subscribers s ON s.id=m.sms_subscriber_id
  LEFT JOIN marketing_subscribers e ON e.id=m.email_subscriber_id
  WHERE a.id=${attemptId}::uuid AND a.state='unknown' LIMIT 1`
 if(rows.length!==1)throw Error('MARKETING_CLAIM_NOT_FOUND_OR_INTEGRITY')
 const r=rows[0],iso=(v:unknown)=>{
  const d=new Date(v as string)
  return Number.isFinite(d.getTime())?d:null
 }
 const exp=iso(r.evidence_expires_at),ownerExp=iso(r.approval_expires_at)
 const dateUtc=(v:unknown)=>{const d=iso(v);return d?d.toISOString().slice(0,10):null}
 const utcDay=now.toISOString().slice(0,10),utcMonth=`${utcDay.slice(0,7)}-01`
 const positive=(v:unknown)=>/^[1-9]\d{0,15}$/.test(String(v))&&Number.isSafeInteger(Number(v))
 if(String(r.id)!==attemptId||r.plan_state!=='staged'||r.approval_state!=='approved'||
   r.reservation_state!=='reserved'||r.campaign_state!=='reviewed'||
   String(r.approval_plan_id)!==String(r.claim_plan_id)||
   String(r.approval_campaign_id)!==String(r.snapshot_campaign_id)||
   Number(r.approval_campaign_version)!==Number(r.campaign_version)||
   r.reviewer_sha256!==r.owner_identity_sha256||
   String(r.budget_campaign_id)!==String(r.snapshot_campaign_id)||r.budget_channel!==r.channel||
   dateUtc(r.budget_utc_day)!==utcDay||dateUtc(r.budget_utc_month)!==utcMonth||
   !Number.isSafeInteger(Number(r.campaign_version))||Number(r.campaign_version)!==Number(r.snapshot_version)||
   !exp||exp<=now||!ownerExp||ownerExp<=now||r.local_consent!==true||
   !positive(r.recipient_price)||!positive(r.approved_maximum)||!positive(r.budget_reserved)||
   Number(r.recipient_price)>Number(r.approved_maximum)||Number(r.recipient_price)>Number(r.budget_reserved)||
   !HEX.test(String(r.message_sha256))||r.message_sha256!==r.approved_message_sha256||
   ![r.jurisdiction_proof_sha256,r.provider_suppression_proof_sha256,r.frequency_proof_sha256,r.provider_price_proof_sha256]
     .every(x=>typeof x==='string'&&HEX.test(x)))throw Error('MARKETING_CLAIM_STALE_OR_UNVERIFIED')
 const channel=r.channel
 if(channel!=='sms'&&channel!=='email')throw Error('MARKETING_INVALID_CHANNEL')
 if(r.provider!==(channel==='sms'?'twilio':'resend'))throw Error('MARKETING_PROVIDER_CHANNEL_MISMATCH')
 let recipient:string,finalBody:string,subject:string|undefined,unsubscribeUrl:string|undefined,emailSubscriberId:string|undefined
 if(channel==='sms'){
   recipient=String(r.phone_e164??'')
   if(!E164.test(recipient)||r.email_contact_id!=null||typeof r.body!=='string')throw Error('MARKETING_SMS_CONTACT_INVALID')
   const composed=composeMarketingSms(r.body)
   if(!composed.validOneSegment)throw Error('MARKETING_SMS_FINAL_COPY_UNAPPROVED')
   finalBody=composed.body
 }else{
   recipient=String(r.email??'').trim().toLowerCase()
   emailSubscriberId=String(r.email_contact_id??'')
   subject=String(r.subject??'')
   if(!EMAIL.test(recipient)||!UUID.test(emailSubscriberId)||r.sms_contact_id!=null||
      !RESEND_CONTACT_ID.test(String(r.resend_contact_id??''))||
      !subject||subject.length>140||typeof r.body!=='string'||!r.body.trim())throw Error('MARKETING_EMAIL_CONTACT_INVALID')
   const token=await deps.signUnsubscribe(emailSubscriberId)
   if(!/^v1\.[a-z0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(token))throw Error('MARKETING_UNSUBSCRIBE_TOKEN_INVALID')
   unsubscribeUrl=`https://kvrn.shop/email-preferences?token=${token}`
   finalBody=`<div>${safeHtml(r.body)}</div><p><a href="${unsubscribeUrl}">Unsubscribe from KVRN marketing emails</a></p>`
 }
 const digest=await hashFinalApprovedCopy(finalBody,channel,subject)
 if(digest!==r.message_sha256)throw Error('MARKETING_FINAL_COPY_HASH_CHANGED')
 // Provider check happens only after DB and immutable content checks, and as
 // close as possible to the network call. Unknown/error means block forever.
 let allowed=false
 try{allowed=await deps.providerPermission(channel,recipient,channel==='email'?String(r.resend_contact_id??''):String(r.sms_contact_id??''))===true}catch{}
 if(!allowed)throw Error('MARKETING_PROVIDER_SUPPRESSION_OR_CONSENT_UNKNOWN')
 return {
  attemptId,provider:r.provider,channel,recipient,finalBody,approvedMessageSha256:digest,
  recipientWindow:{timezone:r.recipient_timezone,timezoneVerified:true,jurisdictionRuleVerified:true},
  emailSubscriberId,subject,unsubscribeUrl,
  suppressionFresh:true,consentFresh:true,ownerApprovalFresh:true,budgetReservationFresh:true,
 }
}
