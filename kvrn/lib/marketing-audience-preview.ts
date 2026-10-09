/** Read-only, evidence-filtered campaign audience estimate.
 * Counts are never send-eligibility certification: provider suppression, numbers
 * reassignments, current consent, recipient timezone, and price must be verified
 * again immediately before any dispatch. NEVER expose contact identifiers here.
 */
import {sql} from '@/lib/db'
import type {CampaignAudience, CampaignChannel} from '@/lib/marketing-campaign-drafts'

export const AUDIENCE_PREVIEW_LIMIT=50
export type AudiencePreview={campaignId:string;campaignVersion:number;channel:CampaignChannel;audience:CampaignAudience;
  locallyEvidenceMatched:number;overInitialCap:boolean;canDispatch:false;warnings:string[];asOf:string}

export const validateAudiencePreviewId=(v:unknown):v is string=>typeof v==='string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

export const audiencePreviewSupported=(v:CampaignAudience):boolean=>v==='all-consenting'||v==='recent-opt-ins'

export function audiencePreviewWarnings(channel:CampaignChannel,count:number):string[]{
  return [
    'Advisory only: records are not an immutable recipient snapshot or proof of current deliverability.',
    'Fresh consent, all suppression sources, recipient jurisdiction/timezone and provider status must be checked before sending.',
    'Campaign delivery remains disabled; a reviewed draft is not owner approval.',
    ...(channel==='email'?['A web-checkbox assertion does not prove mailbox control or Resend topic eligibility.']:
      ['Only locally confirmed JOIN → YES keyword evidence is counted; migrated consent is not assumed valid.']),
    ...(count>AUDIENCE_PREVIEW_LIMIT?['The preliminary 50-recipient campaign cap would be exceeded.']:[]),
  ]
}

/** Fail closed when evidence schema is missing or audience cannot be evidenced.
 * Never fetch raw email addresses, phone numbers, or other recipient PII.
 */
export async function previewCampaignAudience(campaignId:string):Promise<AudiencePreview>{
  if(!validateAudiencePreviewId(campaignId))throw Error('INVALID_CAMPAIGN_ID')
  const campaignRows=await sql`SELECT id,version,channel,audience,state FROM marketing_campaign_drafts WHERE id=${campaignId}::uuid LIMIT 1`
  if(campaignRows.length!==1)throw Error('CAMPAIGN_NOT_FOUND')
  const c=campaignRows[0]
  if(c.state!=='reviewed')throw Error('CAMPAIGN_NOT_REVIEWED')
  if(c.channel!=='email'&&c.channel!=='sms')throw Error('CAMPAIGN_INVALID_CHANNEL')
  if(!audiencePreviewSupported(c.audience))throw Error('AUDIENCE_REQUIRES_VERIFIED_ORDER_CONSENT_JOIN')
  // All queries are aggregated and intentionally strict. Suppression wins over
  // any previous opt-in, including historic records with missing provenance.
  let rows
  if(c.channel==='email'){
    rows=await sql`
      SELECT COUNT(*)::int AS total FROM marketing_subscribers s
      WHERE s.status='subscribed' AND s.unsubscribed_at IS NULL
        AND EXISTS (SELECT 1 FROM marketing_email_consent_events e
          WHERE e.subscriber_id=s.id AND e.event_type='affirmative_checkbox'
            AND (${c.audience}='all-consenting' OR e.recorded_at>NOW()-INTERVAL '30 days'))
        AND NOT EXISTS (SELECT 1 FROM marketing_email_consent_events e
          WHERE e.subscriber_id=s.id AND e.event_type='unsubscribed')
    `
  }else{
    rows=await sql`
      SELECT COUNT(*)::int AS total FROM sms_subscribers s
      WHERE s.status='subscribed' AND s.consent_source='sms_keyword'
        AND s.twilio_opt_out_state='opted_in' AND s.unsubscribed_at IS NULL
        AND EXISTS (SELECT 1 FROM sms_keyword_consent_proofs p
          WHERE p.subscriber_id=s.id AND p.confirmed_at>=s.consented_at
            AND (${c.audience}='all-consenting' OR p.confirmed_at>NOW()-INTERVAL '30 days'))
    `
  }
  const raw=rows[0]?.total
  const total=Number(raw)
  if(raw===null||raw===undefined||!Number.isSafeInteger(total)||total<0)throw Error('AUDIENCE_COUNT_INVALID')
  return {campaignId,campaignVersion:Number(c.version),channel:c.channel,audience:c.audience,
    locallyEvidenceMatched:total,overInitialCap:total>AUDIENCE_PREVIEW_LIMIT,canDispatch:false,
    warnings:audiencePreviewWarnings(c.channel,total),asOf:new Date().toISOString()}
}
