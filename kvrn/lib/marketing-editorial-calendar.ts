/** Planned publishing calendar for marketing copy — NEVER a delivery queue.
 * No sender, no cron consumer, no recipients, no AI trigger.
 */
import {sql} from '@/lib/db'
import {validateAudiencePreviewId} from '@/lib/marketing-audience-preview'
export const MARKETING_EDITORIAL_MIN_LEAD_MS=15*60*1000
export const MARKETING_EDITORIAL_MAX_HORIZON_MS=365*24*60*60*1000
export type CalendarItem={id:string;campaignId:string;campaignVersion:number;plannedFor:string;state:'planned'|'cancelled';copyCurrent:boolean;title:string;channel:'sms'|'email'}

export function validateEditorialTime(value:unknown,now=Date.now()):string|null{
  if(typeof value!=='string'||value.length<20||value.length>35|| !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))return null
  const instant=Date.parse(value)
  if(!Number.isFinite(instant)||!Number.isFinite(now)||instant<=now+MARKETING_EDITORIAL_MIN_LEAD_MS||instant>now+MARKETING_EDITORIAL_MAX_HORIZON_MS)return null
  return new Date(instant).toISOString()
}
export const isValidEditorialVersion=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=1

export async function listEditorialPlans():Promise<CalendarItem[]>{
  const rows=await sql`SELECT c.id,c.campaign_id,c.campaign_version,c.planned_for,c.state,d.state AS campaign_state,d.version AS current_version,d.title,d.channel
    FROM marketing_editorial_calendar c JOIN marketing_campaign_drafts d ON d.id=c.campaign_id
    ORDER BY c.planned_for ASC LIMIT 100`
  return rows.map(r=>({id:String(r.id),campaignId:String(r.campaign_id),campaignVersion:Number(r.campaign_version),
    plannedFor:new Date(r.planned_for).toISOString(),state:r.state,copyCurrent:r.campaign_state==='reviewed'&&Number(r.current_version)===Number(r.campaign_version),title:String(r.title),channel:r.channel}))
}
export async function planEditorialCampaign(campaignId:string,version:number,plannedFor:string):Promise<string>{
  if(!validateAudiencePreviewId(campaignId)||!isValidEditorialVersion(version)||!validateEditorialTime(plannedFor))throw Error('INVALID_EDITORIAL_PLAN')
  const rows=await sql`SELECT kvrn_marketing_editorial_plan(${campaignId}::uuid,${version}::integer,${plannedFor}::timestamptz) AS id`
  return String(rows[0].id)
}
export async function cancelEditorialPlan(id:string):Promise<boolean>{
  if(!validateAudiencePreviewId(id))throw Error('INVALID_EDITORIAL_PLAN')
  const rows=await sql`SELECT kvrn_marketing_editorial_cancel(${id}::uuid) AS changed`
  return rows[0]?.changed===true
}
