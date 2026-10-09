/** Admin-only campaign content management. This deliberately has NO send method.
 * Reviewed is an editorial content state, NOT permission to contact anyone.
 */
import {sql} from '@/lib/db'
export type CampaignChannel='sms'|'email'
export type CampaignState='draft'|'reviewed'|'archived'
export type CampaignAudience='all-consenting'|'recent-opt-ins'|'existing-customers'
export type DraftInput={channel:CampaignChannel,title:string,subject:string|null,body:string,audience:CampaignAudience}
export type CampaignDraft=DraftInput & {id:string,state:CampaignState,version:number,createdAt:string,updatedAt:string}
export type DraftCheck={ok:true,value:DraftInput}|{ok:false,error:string}
const audienceOptions=['all-consenting','recent-opt-ins','existing-customers']
/** Reject instead of coercing strings or accepting unexpected fields/PII. */
export function validateCampaignDraft(input:unknown):DraftCheck{
  if(!input||typeof input!=='object'||Array.isArray(input))return{ok:false,error:'Invalid campaign input.'}
  const o=input as Record<string,unknown>
  if(Object.keys(o).some(k=>!['channel','title','subject','body','audience'].includes(k)))return{ok:false,error:'Unknown campaign field.'}
  if(o.channel!=='sms'&&o.channel!=='email')return{ok:false,error:'Invalid channel.'}
  if(typeof o.title!=='string'||o.title.trim().length<1||o.title.trim().length>120)return{ok:false,error:'Title must be 1–120 characters.'}
  if(typeof o.body!=='string'||o.body.length>10000)return{ok:false,error:'Invalid message body.'}
  if(typeof o.audience!=='string'||!audienceOptions.includes(o.audience))return{ok:false,error:'Invalid audience.'}
  if(o.subject!==null&&o.subject!==undefined&&typeof o.subject!=='string')return{ok:false,error:'Invalid subject.'}
  const subject=(o.subject as string|null|undefined)?.trim()||null
  if(o.channel==='sms'&&subject)return{ok:false,error:'SMS cannot have an email subject.'}
  if(subject&&subject.length>140)return{ok:false,error:'Subject exceeds 140 characters.'}
  if(o.channel==='email'&&!subject)return{ok:false,error:'Email requires a subject.'}
  return{ok:true,value:{channel:o.channel,title:o.title.trim(),subject,body:o.body,audience:o.audience as CampaignAudience}}
}
const safeDraft=(r:any):CampaignDraft=>({
  id:String(r.id),channel:r.channel,title:r.title,subject:r.subject,body:r.body,audience:r.audience,
  state:r.state,version:Number(r.version),createdAt:String(r.created_at),updatedAt:String(r.updated_at),
})
export async function listCampaignDrafts():Promise<CampaignDraft[]>{
  const rows=await sql`SELECT id,channel,title,subject,body,audience,state,version,created_at,updated_at
    FROM marketing_campaign_drafts ORDER BY created_at DESC LIMIT 100`
  return rows.map(safeDraft)
}
export async function createCampaignDraft(input:DraftInput):Promise<CampaignDraft>{
  const rows=await sql`SELECT marketing_draft_create(${input.channel},${input.title},${input.subject},${input.body},${input.audience}) AS id`
  const id=String(rows[0].id)
  const created=await sql`SELECT * FROM marketing_campaign_drafts WHERE id=${id}::uuid`
  return safeDraft(created[0])
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const validVersion=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0
export async function editCampaignDraft(id:string,version:number,input:DraftInput){
  if(!uuid.test(id)||!validVersion(version))throw Error('INVALID_INPUT')
  const rows=await sql`SELECT channel FROM marketing_campaign_drafts WHERE id=${id}::uuid`
  if(rows.length===0||rows[0].channel!==input.channel)throw Error('CAMPAIGN_DRAFT_CONFLICT')
  await sql`SELECT marketing_draft_edit(${id}::uuid,${version}::int,${input.title},${input.subject},${input.body},${input.audience})`
}
export async function setCampaignDraftState(id:string,version:number,action:'review'|'reopen'|'archive'){
  if(!uuid.test(id)||!validVersion(version))throw Error('INVALID_INPUT')
  await sql`SELECT marketing_draft_state(${id}::uuid,${version}::int,${action})`
}
