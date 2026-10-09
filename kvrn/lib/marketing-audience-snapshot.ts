/** Private immutable audience snapshot references (NEVER contact PII or send authority).
 * No contact export or provider calls. Requires migration 049 in isolated staging.
 */
import {sql} from '@/lib/db'
import {validateAudiencePreviewId} from '@/lib/marketing-audience-preview'
export const validSnapshotRequestKey=(key:unknown):key is string=>
 typeof key==='string'&&/^[A-Za-z0-9:_-]{12,120}$/.test(key)
export const validSnapshotVersion=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=1&&n<=2147483647
export type MarketingSnapshotSummary={id:string;campaignId:string;campaignVersion:number;channel:'sms'|'email';
 audience:'all-consenting'|'recent-opt-ins';memberCount:number;createdAt:string;sendPermitted:false;warnings:string[]}
export async function createPrivateAudienceSnapshot(campaignId:string,version:number,key:string):Promise<string>{
 if(!validateAudiencePreviewId(campaignId)||!validSnapshotVersion(version)||!validSnapshotRequestKey(key))throw Error('INVALID_SNAPSHOT_INPUT')
 const rows=await sql`SELECT kvrn_marketing_prepare_snapshot(${campaignId}::uuid,${version}::integer,${key}) AS id`
 if(rows.length!==1||!validateAudiencePreviewId(String(rows[0]?.id)))throw Error('SNAPSHOT_CREATE_FAILED')
 return String(rows[0].id)
}
export async function listPrivateAudienceSnapshots():Promise<MarketingSnapshotSummary[]>{
 // No phone, email, IP address, raw contact ID, or marketing tokens leave this service.
 const rows=await sql`SELECT s.id,s.campaign_id,s.campaign_version,s.channel,s.audience,s.created_at,
      (SELECT COUNT(*)::int FROM marketing_audience_members m WHERE m.snapshot_id=s.id) AS member_count
   FROM marketing_audience_snapshots s ORDER BY s.created_at DESC LIMIT 30`
 return rows.map(r=>{
   const memberCount=Number(r.member_count)
   if(!Number.isSafeInteger(memberCount)||memberCount<1||memberCount>50)throw Error('SNAPSHOT_COUNT_CORRUPT')
   return{id:String(r.id),campaignId:String(r.campaign_id),campaignVersion:Number(r.campaign_version),
     channel:r.channel,audience:r.audience,memberCount,createdAt:new Date(r.created_at).toISOString(),
     sendPermitted:false as const,warnings:[
       'A frozen recipient reference is NOT proof of ongoing permission to send.',
       'Revalidate STOP/unsubscribe/provider blocks, current consent, geography, recipient frequency, quiet hours and worst-case budget before delivery.',
       'No broadcast transport is implemented or enabled.',
     ]}
 })
}
