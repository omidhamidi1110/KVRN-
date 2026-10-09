/** First-party Marketing Suite copy editor; no provider contacts or sending. */
import {sql} from '@/lib/db'
import {TEMPLATE_TOKEN,STATIC_BRAND_TOKENS} from './marketing-copy-template-tokens'
export type CopyChannel='sms'|'email'
export type CopyCategory='launch'|'restock'|'promotion'|'update'|'post_purchase'
export type CopyState='draft'|'ready'|'archived'
export type CopyTemplateInput={channel:CopyChannel;label:string;category:CopyCategory;subject:string|null;body:string}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CHANNELS=new Set(['sms','email'])
const CATEGORIES=new Set(['launch','restock','promotion','update','post_purchase'])
const STATE=new Set(['draft','ready','archived'])
// Only static, brand-owned tokens. A recipient-specific unsubscribe URL must be
// generated at SEND TIME. It must never be embedded in a reusable draft preview.
export function validateCopyTemplate(value:unknown):value is CopyTemplateInput{
 if(!value||typeof value!=='object'||Array.isArray(value))return false
 const p=value as Record<string,unknown>
 if(Object.keys(p).length!==5||Object.keys(p).some(k=>!['channel','label','category','subject','body'].includes(k)))return false
 if(typeof p.channel!=='string'||!CHANNELS.has(p.channel)||typeof p.category!=='string'||!CATEGORIES.has(p.category))return false
 if(typeof p.label!=='string'||p.label.trim().length<1||p.label.length>100)return false
 if(typeof p.body!=='string'||p.body.trim().length<1||p.body.length>10000)return false
 if((p.channel==='sms'&&p.subject!==null)||(p.channel==='email'&&(typeof p.subject!=='string'||p.subject.trim().length<1||p.subject.length>140)))return false
 const content:string[]=[p.label,p.body]
 if(typeof p.subject==='string')content.push(p.subject)
 for(const text of content){
  // Untrusted placeholders can reveal PII if later filled by a sender. Fail closed.
  for(const match of text.matchAll(TEMPLATE_TOKEN))if(!Object.prototype.hasOwnProperty.call(STATIC_BRAND_TOKENS,match[1]))return false
  if(/[{}]/.test(text.replace(TEMPLATE_TOKEN,'')))return false
  if(/[<>]/.test(text)||/javascript\s*:/i.test(text))return false
 }
 return true
}

export type CopyTemplateSummary={id:string;channel:CopyChannel;category:CopyCategory;label:string;subject:string|null;body:string;state:CopyState;version:number;updatedAt:string;canSend:false}
export async function listCopyTemplates():Promise<CopyTemplateSummary[]>{
 const rows=await sql`SELECT id,channel,label,category,subject,body,state,version,updated_at
   FROM marketing_copy_templates ORDER BY updated_at DESC LIMIT 100`
 return rows.map(r=>{
  const candidate={channel:r.channel,label:r.label,category:r.category,subject:r.subject,body:r.body}
  const version=Number(r.version)
  if(!validateCopyTemplate(candidate)||!UUID.test(String(r.id))||!STATE.has(r.state)||!Number.isSafeInteger(version)||version<1)
   throw Error('MARKETING_TEMPLATE_INTEGRITY')
  return {id:String(r.id),...candidate,state:r.state,version,updatedAt:new Date(r.updated_at).toISOString(),canSend:false as const}
 })
}
export async function createCopyTemplate(input:CopyTemplateInput):Promise<string>{
 if(!validateCopyTemplate(input))throw Error('MARKETING_TEMPLATE_INVALID')
 const rows=await sql`SELECT kvrn_marketing_template_create(${input.channel},${input.label},${input.category},${input.subject},${input.body})::text AS id`
 if(rows.length!==1||!UUID.test(String(rows[0].id)))throw Error('MARKETING_TEMPLATE_CREATE_FAILED')
 return String(rows[0].id)
}
export async function editCopyTemplate(id:string,expectedVersion:number,input:CopyTemplateInput):Promise<number>{
 if(!UUID.test(id)||!Number.isSafeInteger(expectedVersion)||expectedVersion<1||!validateCopyTemplate(input))throw Error('MARKETING_TEMPLATE_INVALID')
 // Channel is immutable: do not silently turn an SMS template into an email.
 const channel=await sql`SELECT channel FROM marketing_copy_templates WHERE id=${id}::uuid`
 if(channel.length!==1||channel[0].channel!==input.channel)throw Error('MARKETING_TEMPLATE_CHANNEL_IMMUTABLE')
 const rows=await sql`SELECT kvrn_marketing_template_update(${id}::uuid,${expectedVersion},${input.label},${input.category},${input.subject},${input.body}) AS version`
 const version=Number(rows[0]?.version)
 if(rows.length!==1||!Number.isSafeInteger(version)||version<=expectedVersion)throw Error('MARKETING_TEMPLATE_EDIT_FAILED')
 return version
}
export async function transitionCopyTemplate(id:string,expectedVersion:number,target:CopyState):Promise<number>{
 if(!UUID.test(id)||!Number.isSafeInteger(expectedVersion)||expectedVersion<1||!STATE.has(target))throw Error('MARKETING_TEMPLATE_INVALID')
 const rows=await sql`SELECT kvrn_marketing_template_transition(${id}::uuid,${expectedVersion},${target}) AS version`
 const version=Number(rows[0]?.version)
 if(rows.length!==1||!Number.isSafeInteger(version)||version<=expectedVersion)throw Error('MARKETING_TEMPLATE_TRANSITION_FAILED')
 return version
}
