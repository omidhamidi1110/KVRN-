/** Correlate an already Twilio-signature-validated status callback to a prior
 * acknowledged single-recipient marketing claim. Never interpret a failure or
 * timeout as proof the message was never submitted. No network or send calls.
 * The route MUST run Twilio's signature verification BEFORE calling this.
 */
import {sql} from '@/lib/db'
import {digestProviderReference,validProviderReference} from './marketing-provider-receipts'
import {recordVerifiedMarketingAttemptOutcome} from './marketing-verified-outcome'
import {normalizePhoneE164} from './phone'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function isFinalTwilioMarketingAcceptance(status:unknown):boolean{
 // 'queued'/'accepted'/'sending' do not prove receipt by carrier.
 // 'undelivered'/'failed' may have been transmitted, so cannot release claims.
 return status==='delivered'
}
/** Caller guarantees that the exact callback URL/body/signature were validated. */
export async function recordSignedTwilioMarketingAcceptance(
 rawSid:string,status:string,rawRecipient:string,signatureVerified:true
):Promise<'ignored'|'recorded'> {
 if(process.env.MARKETING_SIGNED_TWILIO_OUTCOME_ENABLED!=='true' ||
    process.env.MARKETING_PROVIDER_OUTCOME_RECONCILIATION_ENABLED!=='true')return 'ignored'
 if(signatureVerified!==true)throw Error('MARKETING_TWILIO_SIGNATURE_REQUIRED')
 if(!isFinalTwilioMarketingAcceptance(status)||!validProviderReference('twilio',rawSid))return 'ignored'
 const recipient=normalizePhoneE164(rawRecipient)
 if(!recipient)throw Error('MARKETING_TWILIO_RECIPIENT_INVALID')
 const pepper=process.env.MARKETING_PROVIDER_REFERENCE_PEPPER??''
 const digest=await digestProviderReference('twilio',rawSid,pepper)
 // The recipient equality is enforced in SQL. Customer numbers never enter logs,
 // message-digest identifiers never appear in Admin responses.
 const rows=await sql`SELECT a.id AS attempt_id FROM marketing_provider_provisional_receipts r
   JOIN marketing_delivery_attempts a ON a.id=r.attempt_id AND a.provider='twilio'
   JOIN marketing_audience_members m ON m.id=a.audience_member_id
   JOIN sms_subscribers s ON s.id=m.sms_subscriber_id
   WHERE r.provider='twilio' AND r.initial_result='acknowledged'
    AND r.provider_reference_digest=${digest} AND s.phone_e164=${recipient}
   LIMIT 1`
 if(rows.length===0)return 'ignored' // May be race; unresolved attempt remains blocked.
 if(rows.length!==1||typeof rows[0].attempt_id!=='string'||!UUID.test(rows[0].attempt_id))
  throw Error('MARKETING_TWILIO_CLAIM_CORRUPT')
 await recordVerifiedMarketingAttemptOutcome({
   attemptId:rows[0].attempt_id,outcome:'provider_accepted',
   verificationSource:'provider_final_status',providerReferenceSha256:digest,
   providerAuthenticationVerified:true,attemptMessageCorrelationVerified:true,
 })
 return 'recorded'
}
