/** Signed Resend final-delivery evidence for PREVIOUSLY claimed marketing mail.
 * Cannot send, subscribe, retry, or release a budget. Signature verification
 * MUST occur in the parent HTTP route before this internal function is called.
 */
import {sql} from '@/lib/db'
import {digestProviderReference,validProviderReference} from './marketing-provider-receipts'
import {recordVerifiedMarketingAttemptOutcome} from './marketing-verified-outcome'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMAIL=/^[^\s@<>]{1,64}@[^\s@<>]{1,254}$/
export type SignedResendDelivery={providerMessageId:string;recipientEmail:string}
export function extractSignedResendDelivery(event:unknown):SignedResendDelivery|null{
 if(!event||typeof event!=='object'||Array.isArray(event))return null
 const r=event as Record<string,unknown>
 if(r.type!=='email.delivered'||!r.data||typeof r.data!=='object'||Array.isArray(r.data))return null
 const d=r.data as Record<string,unknown>
 if(!validProviderReference('resend',d.email_id)||!Array.isArray(d.to)||d.to.length!==1||
    typeof d.to[0]!=='string')return null
 const email=d.to[0].trim().toLowerCase()
 if(email.length>254||!EMAIL.test(email))return null
 return {providerMessageId:d.email_id,recipientEmail:email}
}
export async function recordSignedResendMarketingDelivery(event:unknown,signatureVerified:true):Promise<'ignored'|'recorded'> {
 if(process.env.MARKETING_SIGNED_RESEND_OUTCOME_ENABLED!=='true'||
    process.env.MARKETING_PROVIDER_OUTCOME_RECONCILIATION_ENABLED!=='true')return 'ignored'
 if(signatureVerified!==true)throw Error('MARKETING_RESEND_SIGNATURE_REQUIRED')
 const delivery=extractSignedResendDelivery(event)
 if(!delivery)return 'ignored'
 const digest=await digestProviderReference('resend',delivery.providerMessageId,
   process.env.MARKETING_PROVIDER_REFERENCE_PEPPER??'')
 // Correlate BOTH provider ID and unique subscriber email to a prior persisted
 // claim. Do not trust signed delivery of a non-KVRN marketing email.
 const rows=await sql`SELECT a.id AS attempt_id FROM marketing_provider_provisional_receipts r
   JOIN marketing_delivery_attempts a ON a.id=r.attempt_id AND a.provider='resend'
   JOIN marketing_audience_members m ON m.id=a.audience_member_id
   JOIN marketing_subscribers s ON s.id=m.email_subscriber_id
   WHERE r.provider='resend' AND r.initial_result='acknowledged'
    AND r.provider_reference_digest=${digest} AND lower(s.email)=${delivery.recipientEmail}
   LIMIT 1`
 if(rows.length===0)return 'ignored'
 if(rows.length!==1||typeof rows[0].attempt_id!=='string'||!UUID.test(rows[0].attempt_id))
   throw Error('MARKETING_RESEND_CLAIM_CORRUPT')
 await recordVerifiedMarketingAttemptOutcome({
   attemptId:rows[0].attempt_id,outcome:'provider_accepted',
   verificationSource:'provider_final_status',providerReferenceSha256:digest,
   providerAuthenticationVerified:true,attemptMessageCorrelationVerified:true,
 })
 return 'recorded'
}
