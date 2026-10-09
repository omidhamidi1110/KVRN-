/** Consent-only administrative statistics: no email addresses or phone numbers. */
import {sql} from '@/lib/db'
export type MarketingOverview={email:{subscribed:number,unsubscribed:number,pendingSync:number,affirmativeCheckboxRecords:number|null},sms:{subscribed:number,unsubscribed:number,confirmedKeyword:number|null},provider:{a2pApproved:boolean,smsSendingEnabled:boolean,emailConfigured:boolean,contactSyncEnabled:boolean,optInSyncEnabled:boolean},limits:{smsMonthlyUsd:number,smsDailyUsd:number,emailMonthlyUsd:number}}
const count=(v:any)=>Math.max(0,Number(v)||0)
export async function getMarketingOverview():Promise<MarketingOverview>{
  const [emails,sms]=await Promise.all([
    sql`SELECT COUNT(*) FILTER (WHERE status='subscribed')::int AS active,
       COUNT(*) FILTER (WHERE status='unsubscribed')::int AS unsubscribed,
       COUNT(*) FILTER (WHERE sync_status='pending' OR sync_status='failed')::int AS needs_sync
       FROM marketing_subscribers`,
    sql`SELECT COUNT(*) FILTER (WHERE status='subscribed')::int AS active,
       COUNT(*) FILTER (WHERE status='unsubscribed')::int AS unsubscribed
       FROM sms_subscribers`,
  ])
  const a=emails[0],b=sms[0]
  // Legacy subscribers and CSV imports cannot be silently labeled consent-
  // verified. A missing migration 044 means UNKNOWN, not zero or approved.
  let emailCheckboxCount:number|null=null
  try{
    const attestations=await sql`SELECT COUNT(*)::int AS total FROM marketing_subscribers s
      WHERE s.status='subscribed' AND s.unsubscribed_at IS NULL
        AND EXISTS (SELECT 1 FROM marketing_email_consent_events e
          WHERE e.subscriber_id=s.id AND e.event_type='affirmative_checkbox')
        AND NOT EXISTS (SELECT 1 FROM marketing_email_consent_events e
          WHERE e.subscriber_id=s.id AND e.event_type='unsubscribed')`
    emailCheckboxCount=count(attestations[0]?.total)
  }catch{emailCheckboxCount=null}
  // Never equate legacy opted_in flags with two-message confirmed evidence.
  // A missing/not-yet-migrated proof table means UNKNOWN, not zero subscribers.
  let verifiedCount:number|null=null
  try{
    const proofs=await sql`SELECT COUNT(*)::int AS verified FROM sms_subscribers s
      WHERE s.status='subscribed' AND s.consent_source='sms_keyword'
        AND s.twilio_opt_out_state='opted_in' AND s.unsubscribed_at IS NULL
        AND EXISTS (SELECT 1 FROM sms_keyword_consent_proofs p
          WHERE p.subscriber_id=s.id AND p.confirmed_at>=s.consented_at)`
    verifiedCount=count(proofs[0]?.verified)
  }catch{verifiedCount=null}
  return {
    email:{subscribed:count(a?.active),unsubscribed:count(a?.unsubscribed),pendingSync:count(a?.needs_sync),affirmativeCheckboxRecords:emailCheckboxCount},
    sms:{subscribed:count(b?.active),unsubscribed:count(b?.unsubscribed),confirmedKeyword:verifiedCount},
    provider:{a2pApproved:process.env.TWILIO_A2P_APPROVED==='true',
      smsSendingEnabled:false, // campaign transport has not been implemented
      emailConfigured:Boolean(process.env.RESEND_MARKETING_API_KEY&&process.env.RESEND_MARKETING_TOPIC_ID),
      contactSyncEnabled:process.env.RESEND_MARKETING_CONTACT_SYNC_ENABLED==='true',
      optInSyncEnabled:process.env.RESEND_MARKETING_CONTACT_SYNC_ENABLED==='true' && process.env.RESEND_MARKETING_OPT_IN_SYNC_ENABLED==='true'},
    limits:{smsMonthlyUsd:15,smsDailyUsd:3,emailMonthlyUsd:10},
  }
}
