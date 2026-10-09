/** Two-message, verified-inbound SMS keyword opt-in (JOIN then YES).
 * Every message must first pass Twilio webhook signature verification.
 * No outbound provider API calls occur here. No raw tokens appear in logs.
 */
import {sql} from '@/lib/db'
import {hashToken} from '@/lib/sms-signup-claims'
export const KEYWORD_CONFIRMATION_TTL_MINUTES=30
export const KEYWORD_STARTS=new Set(['JOIN','START','UNSTOP'])
export const KEYWORD_CONFIRMS=new Set(['YES'])
export const KEYWORD_STOPS=new Set(['STOP','STOPALL','UNSUBSCRIBE','UNSUB','CANCEL','END','QUIT','REVOKE','REMOVE','OPTOUT','OPT-OUT','OPT OUT'])
/** Normalizes opt-out phrases before JOIN/YES routing. Inbound sender identity
 * and consent evidence still require Twilio signature verification first. */
export function parseSmsKeyword(raw:string):string{
  const body=raw.trim().toUpperCase()
  if(/^OPT(?:\s+|-)OUT(?:\s|$)/.test(body))return 'OPT OUT'
  return body.split(/\s+/,1)[0]??''
}
export function canAcceptSmsKeywordOptin(env:Record<string,string|undefined>):boolean{
  return env.TWILIO_A2P_APPROVED==='true' && env.TWILIO_SIGNUP_ENABLED==='true' && env.TWILIO_KEYWORD_DOUBLE_OPTIN_ENABLED==='true'
}
export async function startKeywordConfirmation(phone:string,claimToken:string|null):Promise<void>{
  const tokenHash=claimToken?await hashToken(claimToken):null
  await sql`INSERT INTO sms_keyword_pending(phone_e164,claim_token_hash,requested_at,expires_at)
    VALUES(${phone},${tokenHash},NOW(),NOW()+INTERVAL '30 minutes') ON CONFLICT(phone_e164)
    DO UPDATE SET claim_token_hash=EXCLUDED.claim_token_hash,
       requested_at=NOW(),expires_at=NOW()+INTERVAL '30 minutes'`
}
/** STOP always invalidates even unconfirmed intent. */
export async function clearPendingKeyword(phone:string):Promise<void>{
  await sql`DELETE FROM sms_keyword_pending WHERE phone_e164=${phone}`
}
/** One statement/transaction: consume unexpired pending record, enroll, and confirm
 * browser claim. A STOP newer than JOIN cannot be undone by a racing YES.
 * A failed claim update does not generate consent or a discount on its own.
 */
export async function confirmKeywordSms(phone:string,messageSid:string):Promise<string|null>{
  // Missing provider message identifiers cannot yield auditable KVRN consent.
  if(!/^(SM|MM)[A-Za-z0-9]{32}$/.test(messageSid))throw Error('MISSING_VERIFIED_MESSAGE_ID')
  const rows=await sql`
    WITH claimed AS (
      DELETE FROM sms_keyword_pending
      WHERE phone_e164=${phone} AND expires_at>NOW()
      RETURNING requested_at,claim_token_hash
    ), enrolled AS (
      INSERT INTO sms_subscribers(phone_e164,status,consent_source,consented_at,twilio_opt_out_state,unsubscribed_at)
      SELECT ${phone},'subscribed','sms_keyword',NOW(),'opted_in',NULL FROM claimed
      ON CONFLICT(phone_e164) DO UPDATE SET
       status='subscribed',consent_source='sms_keyword',consented_at=NOW(),
       twilio_opt_out_state='opted_in',unsubscribed_at=NULL,updated_at=NOW()
      WHERE sms_subscribers.unsubscribed_at IS NULL
         OR sms_subscribers.unsubscribed_at <= (SELECT requested_at FROM claimed)
      RETURNING id
    ), evidence AS (
      INSERT INTO sms_keyword_consent_proofs(subscriber_id,confirmation_message_sid,join_requested_at)
      SELECT enrolled.id,${messageSid},claimed.requested_at FROM enrolled CROSS JOIN claimed
      RETURNING subscriber_id
    ), linked AS (
      UPDATE sms_signup_claims sc
      SET status='confirmed',subscriber_id=(SELECT id FROM enrolled),confirmed_at=NOW()
      WHERE sc.token_hash=(SELECT claim_token_hash FROM claimed)
        AND sc.status='pending' AND sc.expires_at>NOW() AND EXISTS(SELECT 1 FROM enrolled)
      RETURNING sc.id
    ) SELECT subscriber_id::text AS id FROM evidence
  `
  return rows[0] ? String(rows[0].id) : null
}
